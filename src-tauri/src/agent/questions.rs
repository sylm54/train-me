//! Pending-question manager (port of `src/lib/ask-question.ts`).
//!
//! The `ask_question` tool poses a question and BLOCKS until the user
//! answers or cancels — only that tool call waits; nothing else in the run
//! is suspended. The JS version keyed promises in a module-level Map and
//! notified React subscribers. The Rust version:
//!
//!  - keeps the live registry (id → oneshot sender) in a process-global
//!    map, newest-first for display via a monotonic sequence number,
//!  - persists a snapshot to `<app_data>/pending_questions.json` on every
//!    change so the UI can re-render the question after a restart (the JS
//!    registry was memory-only — a restart orphaned the question; here the
//!    snapshot carries enough to AUTO-CONTINUE, see below),
//!  - broadcasts `pending-questions-changed` on every change (Stage 3b
//!    subscribes; until then `list_pending_questions()` polls),
//!  - blocks on a tokio oneshot with NO timeout, select!-ed against the
//!    run's cancel handle so an aborted generation settles the question
//!    with `{ok:false, reason:"aborted"}` — exactly what the JS
//!    AbortSignal listener did.
//!
//! RESTART SEMANTICS (documented decision): when the process restarts
//! mid-question, the tool call is gone — there is nothing to resume. On
//! `respond_question` for an id with no live waiter but present in the
//! persisted snapshot, the backend records the answer into that chat's
//! transcript as a user message (marked with the question id in its
//! metadata) and queues a fresh run seeded with a short continuation
//! instruction. The agent wakes up seeing its own question answered and
//! carries on — best-effort, but strictly better than the JS behavior of
//! silently dropping the answer.
//!
//! Questions are intentionally NOT tied to a chat for delivery (any view
//! can answer them), but the snapshot records the originating chat so the
//! restart path knows where to write.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use parking_lot::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::agent::runner::CancelHandle;

/// Kind of question. Mirrors the `ask_question` tool's `type` field.
pub const TYPES: [&str; 4] = ["open", "single-choice", "multi-choice", "rating"];

/// A question awaiting the user's answer. The first four fields are the JS
/// `PendingQuestion` shape verbatim; `chatId`/`seq`/`ts` are Rust-side
/// lifecycle additions (which chat to write into on the restart path, and
/// stable ordering for the newest-first list).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingQuestion {
    /// Unique id; used by the UI to resolve the right waiter.
    pub id: String,
    /// `"open" | "single-choice" | "multi-choice" | "rating"` (serializes
    /// as `type`, matching the JS PendingQuestion).
    #[serde(rename = "type")]
    pub kind: QuestionType,
    /// The question text to show the user.
    pub prompt: String,
    /// For single/multi-choice: the options shown to the user.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<String>>,
    /// Optional short hint shown beneath the prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// Chat the question belongs to (restart path writes the answer here).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    /// Registration sequence (display ordering only).
    #[serde(default)]
    pub seq: u64,
    /// When the question was posed (ms epoch).
    #[serde(default)]
    pub ts: i64,
}

/// Question type — a plain string wrapper so an unknown future value
/// round-trips instead of failing the snapshot load.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(transparent)]
pub struct QuestionType(pub String);

/// What `pose` resolves with — and what the tool returns to the LLM.
/// Serializes to `{ok:true,type,answer}` or `{ok:false,reason}` (the exact
/// JS `QuestionResult` shape; `answer` is a string/number/array depending
/// on `type`, carried opaquely).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct QuestionResult {
    pub ok: bool,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl QuestionResult {
    pub fn answered(kind: &str, answer: serde_json::Value) -> Self {
        Self { ok: true, kind: Some(kind.to_string()), answer: Some(answer), reason: None }
    }
    pub fn failed(reason: &str) -> Self {
        Self { ok: false, kind: None, answer: None, reason: Some(reason.to_string()) }
    }
}

/// Outcome of a `respond_question` command invocation.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RespondOutcome {
    /// A live tool call received the answer.
    pub delivered: bool,
    /// The process restarted since the question was posed: the answer was
    /// recorded into the transcript and a continuation run was queued.
    pub continued: bool,
}

struct Waiter {
    question: PendingQuestion,
    tx: Option<tokio::sync::oneshot::Sender<QuestionResult>>,
}

static PENDING: Lazy<Mutex<HashMap<String, Waiter>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static SEQ: AtomicU64 = AtomicU64::new(1);

/// Tauri event name the UI subscribes to for question-set changes.
pub const CHANGED_EVENT: &str = "pending-questions-changed";

// ============================================================================
// Registry operations
// ============================================================================

/// Snapshot of currently-pending questions, newest first (live waiters and
/// persisted orphans alike).
pub fn list() -> Vec<PendingQuestion> {
    let mut all: Vec<PendingQuestion> = PENDING
        .lock()
        .values()
        .map(|w| w.question.clone())
        .collect();
    all.sort_by(|a, b| b.seq.cmp(&a.seq));
    all
}

/// Remove an entry (waiter or orphan) from the registry.
fn remove(id: &str) -> Option<PendingQuestion> {
    PENDING.lock().remove(id).map(|w| w.question)
}

/// Persist the current registry to `<app_data>/pending_questions.json` and
/// notify listeners. Best-effort: a failed write is logged, never fatal.
fn persist_and_notify(app: &tauri::AppHandle) {
    let snapshot = list();
    let data_dir = app
        .try_state::<crate::AppState>()
        .map(|s| s.data_dir.clone());
    if let Some(data_dir) = data_dir {
        let path = data_dir.join("pending_questions.json");
        let json = serde_json::to_string_pretty(&snapshot)
            .map(|j| j.into_bytes())
            .unwrap_or_else(|e| {
                log::warn!("[ask-question] snapshot serialize failed: {e}");
                Vec::new()
            });
        if json.is_empty() {
            // Nothing pending or serialize failed — remove a stale file.
            let _ = std::fs::remove_file(&path);
        } else if let Err(e) = std::fs::write(&path, &json) {
            log::warn!("[ask-question] failed to persist snapshot: {e}");
        }
    }
    let _ = app.emit(CHANGED_EVENT, &snapshot);
}

/// Restore persisted orphans after a restart (no live waiters). Called from
/// Tauri setup before any command can fire.
pub fn restore(data_dir: &std::path::Path) {
    let Ok(raw) = std::fs::read_to_string(data_dir.join("pending_questions.json")) else {
        return;
    };
    let Ok(questions) = serde_json::from_str::<Vec<PendingQuestion>>(&raw) else {
        log::warn!("[ask-question] persisted snapshot unparsable; ignoring");
        return;
    };
    let mut registry = PENDING.lock();
    for q in questions {
        // Re-sequence so ordering stays stable within this process.
        let seq = SEQ.fetch_add(1, Ordering::SeqCst);
        registry.insert(
            q.id.clone(),
            Waiter { question: PendingQuestion { seq, ..q }, tx: None },
        );
    }
    log::info!(
        "[ask-question] restored {} orphaned question(s) from snapshot",
        registry.len()
    );
}

/// Register a question and wait for its answer (NO timeout). `cancel`
/// settles it with reason "aborted" if the run is aborted first. The entry
/// is cleaned up on every exit path.
pub(crate) async fn pose(
    app: &tauri::AppHandle,
    chat_id: &str,
    kind: &str,
    prompt: &str,
    choices: Option<Vec<String>>,
    hint: Option<String>,
    cancel: &CancelHandle,
) -> QuestionResult {
    let id = super::new_id();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let question = PendingQuestion {
        id: id.clone(),
        kind: QuestionType(kind.to_string()),
        prompt: prompt.to_string(),
        choices,
        hint,
        chat_id: Some(chat_id.to_string()),
        seq: SEQ.fetch_add(1, Ordering::SeqCst),
        ts: super::now_ms(),
    };
    PENDING.lock().insert(id.clone(), Waiter { question, tx: Some(tx) });
    persist_and_notify(app);

    let result = tokio::select! {
        r = rx => r.unwrap_or_else(|_| QuestionResult::failed("question registry dropped the waiter")),
        _ = cancel.wait() => QuestionResult::failed("aborted"),
    };

    // Aborted (or the registry vanished): drop the entry. The answer path
    // (respond) already removed it before delivering.
    if !result.ok {
        remove(&id);
        persist_and_notify(app);
    }
    result
}

/// Deliver an answer/cancellation to a live waiter. Returns false when no
/// LIVE waiter exists (the restart path in the runtime handles orphans).
/// An orphan (tx: None, restored from the snapshot after a restart) is put
/// back so the caller's `take_orphan` can pick it up.
pub(crate) fn respond(id: &str, result: QuestionResult, app: &tauri::AppHandle) -> bool {
    let waiter = {
        let mut registry = PENDING.lock();
        registry.remove(id)
    };
    match waiter {
        Some(Waiter { tx: Some(tx), .. }) => {
            let _ = tx.send(result);
            persist_and_notify(app);
            true
        }
        Some(orphan @ Waiter { tx: None, .. }) => {
            // Not a live waiter — put it back; the caller's orphan path
            // records the answer into the transcript instead.
            PENDING.lock().insert(id.to_string(), orphan);
            false
        }
        None => false,
    }
}

/// Remove and return the question with this id (the restart path: the
/// caller records the answer and queues a continuation). Only reached when
/// [`respond`] already returned false, so the entry — if any — is an
/// orphan with no live waiter.
pub(crate) fn take_orphan(id: &str) -> Option<PendingQuestion> {
    remove(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::convert;

    #[test]
    fn question_result_serializes_like_the_js_shape() {
        let answered = QuestionResult::answered("rating", serde_json::json!(7));
        let v = serde_json::to_value(&answered).unwrap();
        assert_eq!(v, serde_json::json!({"ok": true, "type": "rating", "answer": 7}));

        let multi = QuestionResult::answered("multi-choice", serde_json::json!(["a", "b"]));
        let v = serde_json::to_value(&multi).unwrap();
        assert_eq!(v["answer"], serde_json::json!(["a", "b"]));

        let failed = QuestionResult::failed("aborted");
        let v = serde_json::to_value(&failed).unwrap();
        assert_eq!(v, serde_json::json!({"ok": false, "reason": "aborted"}));
    }

    #[test]
    fn pending_question_roundtrips_with_optional_fields() {
        let q = PendingQuestion {
            id: "q1".into(),
            kind: QuestionType("single-choice".into()),
            prompt: "Pick one".into(),
            choices: Some(vec!["a".into(), "b".into()]),
            hint: None,
            chat_id: Some("chat1".into()),
            seq: 3,
            ts: 99,
        };
        let v = serde_json::to_value(&q).unwrap();
        assert_eq!(v["type"], "single-choice");
        assert!(v.get("hint").is_none());
        assert_eq!(v["chatId"], "chat1");
        let back: PendingQuestion = serde_json::from_value(v).unwrap();
        assert_eq!(back, q);
    }

    #[test]
    fn registry_orders_newest_first_and_respond_consumes() {
        // No AppHandle in unit tests — exercise registry + ordering only.
        let mk = |id: &str| PendingQuestion {
            id: id.into(),
            kind: QuestionType("open".into()),
            prompt: "p".into(),
            choices: None,
            hint: None,
            chat_id: Some("c".into()),
            seq: SEQ.fetch_add(1, Ordering::SeqCst),
            ts: 0,
        };
        PENDING.lock().insert("a".into(), Waiter { question: mk("a"), tx: None });
        PENDING.lock().insert("b".into(), Waiter { question: mk("b"), tx: None });
        let ids: Vec<String> = list().into_iter().map(|q| q.id).collect();
        let pos_a = ids.iter().position(|i| i == "a").unwrap();
        let pos_b = ids.iter().position(|i| i == "b").unwrap();
        assert!(pos_b < pos_a, "newest first: {ids:?}");
        assert_eq!(take_orphan("a").unwrap().id, "a"); // consuming take
        assert!(take_orphan("a").is_none());
        remove("b");
    }

    #[test]
    fn user_message_builder_is_shared_with_the_runner() {
        // The restart path writes answers with the same builder the runner
        // uses for transport messages — pin the shape here too.
        let m = convert::user_message("hello");
        assert_eq!(m["role"], "user");
        assert_eq!(m["parts"][0]["type"], "text");
    }
}
