//! Native agent runtime (Stage 3a of the staged refactor).
//!
//! WHY: the agent loop has lived in the webview (`src/lib/agent.ts` and
//! friends) because that's where the AI SDK was easiest to drive. But chats
//! and settings already moved into Rust (Stages 1–2), and the remaining
//! roadmap (background wakes, cron-triggered runs) needs a loop that runs
//! with **no webview at all** — a Tauri command that nobody awaited still
//! keeps its tokio task alive, but the *browser* loop dies with the window.
//! This module ports the whole loop natively on the `rig` crate so it can
//! run headlessly, while keeping the JS loop untouched until Stage 3b flips
//! the frontend transport over.
//!
//! The port is deliberately faithful — the model has been trained on the
//! exact tool descriptions, result shapes, and prompt text the JS loop
//! sends, so every string that reaches the LLM (tool descriptions, input
//! schemas, system prompt composition, tool result JSON shapes) is copied
//! verbatim from the TS sources. Event shapes reaching the UI are the same
//! `agent-events.ts` payloads; the chunk stream over the command's
//! [`tauri::ipc::Channel`] is AI-SDK-v6 `UIMessage` stream parts so Stage
//! 3b can feed `useChat` with a thin mapping only.
//!
//! Layout (each submodule ports one TS module):
//!
//!   - [`providers`]  ← `src/lib/agent.ts`   provider/model config, reasoning effort
//!   - [`tools`]      ← `src/lib/tools.ts`   tool defs + dispatch onto backend fns
//!   - [`questions`]  ← `src/lib/ask-question.ts`  blocking user questions
//!   - [`compaction`] ← `src/lib/compaction.ts`    summarize-and-drop compaction
//!   - [`prompts`]    ← `src/lib/prompts.ts` system prompt loading + directives
//!   - [`convert`]    ← `contextUsage.ts` + `agent-events.ts` message conversion,
//!                    context char counting, usage normalization
//!   - [`chunks`]     ← AI-SDK UIMessage stream part sequencing (pure logic)
//!   - [`subagents`]  ← `src/lib/subagents.ts`  `spawn_agent` depth-1 copies
//!   - [`runner`]     ← the transport: single-flight turn gate, abort, the
//!                    model-call → tool-execution loop, persistence
//!
//! Concurrency model: at most ONE turn runs app-wide (a FIFO gate in
//! [`runner`]) — the JS loop had the same property for free (one `useChat`
//! per view, sends blocked while streaming), and background wakes queue
//! behind the user's turn instead of interleaving token streams. Runs
//! without a `Channel` (background seeds) emit everything through Tauri
//! events; interactive runs stream chunks over their Channel *and* mirror
//! coarse activity through events so any view can render progress.
//!
//! Abort semantics: [`runner::CancelHandle`] is a watch channel; the model
//! stream is dropped between chunks and blocking tools (only
//! `ask_question`) unwind with `{ok:false, reason:"aborted"}` — the same
//! result the JS `poseQuestion` produces from its AbortSignal. Aborting the
//! current turn does NOT clear the queue; queued runs proceed.

pub mod chunks;
pub mod compaction;
pub mod convert;
pub mod prompts;
pub mod providers;
pub mod questions;
pub mod runner;
pub mod subagents;
pub mod tools;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};

use futures::FutureExt;

use crate::chats;
use runner::AgentRuntime;

// ============================================================================
// Runtime-up flag
// ============================================================================

/// Whether the Tauri runtime (AppHandle, managed state, event emission)
/// exists in this process. Stage 5b's headless boot runs the same binary
/// without the webview and needs to detect which world it's in before
/// touching anything Tauri-shaped. Trivial today (always true inside
/// `run()`); load-bearing later.
static RUNTIME_UP: AtomicBool = AtomicBool::new(false);

/// Set from Tauri's `setup` hook once the AppHandle-backed runtime is bound.
pub fn set_runtime_up(up: bool) {
    RUNTIME_UP.store(up, Ordering::SeqCst);
}

/// Whether the Tauri runtime exists (see [`RUNTIME_UP`]).
pub fn runtime_up() -> bool {
    RUNTIME_UP.load(Ordering::SeqCst)
}

// ============================================================================
// Process-wide runtime
// ============================================================================

static RUNTIME: OnceLock<Arc<AgentRuntime>> = OnceLock::new();

/// Bind the process-wide agent runtime. Called once from `run()` setup,
/// before any command can fire. Also registers the schedule engine's
/// `agent`-action wake hook (schedule must not statically reference this
/// module — see `crate::schedule::AGENT_WAKE`).
pub fn init(app: &tauri::App) {
    let rt = Arc::new(AgentRuntime::new(app.handle().clone()));
    let _ = RUNTIME.set(rt);
    crate::schedule::register_agent_wake(wake_from_action);
    set_runtime_up(true);
}

/// The `agent` action's wake, called from the schedule executor via the
/// registered hook. Enqueue-and-detach: the reconcile path runs inside a
/// blocking section and must never wait on a model turn; the FIFO gate
/// serializes the queued turn behind whatever is in flight. Failures log —
/// they must never fail the reconcile.
fn wake_from_action(message: &str) {
    let Some(rt) = RUNTIME.get() else {
        log::warn!("[agent] action wake skipped: runtime not initialised");
        return;
    };
    let rt = Arc::clone(rt);
    let message = message.to_string();
    tauri::async_runtime::spawn(async move {
        rt.enqueue_seed(crate::schedule::AGENT_ACTION_ORIGIN, message)
            .await;
    });
}

/// The bound runtime, or an error for callers that raced ahead of `init`
/// (cannot happen in the app — setup runs first).
pub fn runtime() -> Result<&'static Arc<AgentRuntime>, String> {
    RUNTIME.get().ok_or_else(|| "agent runtime not initialised".to_string())
}

// ============================================================================
// Shared id minting
// ============================================================================

/// Generate a 21-char URL-safe id from the same alphabet as the frontend's
/// `nanoid()` (and `chats.rs`'s chat ids), so Rust-minted message/question
/// ids are indistinguishable from JS-minted ones. `nanoid` default length is
/// 21; we keep that for message ids.
pub(crate) fn new_id() -> String {
    new_id_of(21)
}

/// Same alphabet, caller-chosen length (short ids for stream part keys).
pub(crate) fn new_id_of(len: usize) -> String {
    use rand::Rng;
    const ALPHABET: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

/// Current time as ms-since-epoch (the frontend's `Date.now()` shape).
pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ============================================================================
// Command-facing types
// ============================================================================

/// Outcome of one [`agent_run`] invocation. `aborted` distinguishes a
/// cancelled turn (partial assistant text persisted, best-effort) from a
/// clean finish; `error` carries the first hard failure (no API key,
/// provider/stream errors, persistence errors) — the chunk stream carries
/// the same information as an `error` part for the UI.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RunInfo {
    /// The run completed its loop (model stopped calling tools) without a
    /// hard error. False on abort or error.
    pub ok: bool,
    /// True when the run was cancelled via [`agent_abort`].
    pub aborted: bool,
    /// Model-call steps executed (LLM calls, not tool executions).
    pub steps: u32,
    /// First hard error, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ============================================================================
// Tauri commands (registered in lib.rs)
// ============================================================================
//
// These are thin pass-throughs onto the runtime, mirroring how `chats.rs`
// wraps its free functions. Everything long-running is async and off the
// main thread.

/// Run one agent turn for `chat_id` over the given full message history
/// (the transport re-sends everything each call, matching the JS transport's
/// contract). Streams AI-SDK-shaped chunk parts over `on_chunk` until the
/// run finishes; the Channel closing is the run's end signal.
///
/// If another turn is in flight, this waits FIFO for its turn first. The
/// wait is part of the command future, so ordering matches call order.
#[tauri::command]
pub async fn agent_run(
    chat_id: String,
    messages: Vec<serde_json::Value>,
    on_chunk: tauri::ipc::Channel<serde_json::Value>,
) -> Result<RunInfo, String> {
    let rt = runtime()?;
    // A panic anywhere in the run kills the command task; the invoke's
    // promise would then never settle and the UI would spin forever with
    // no error part (how the TLS-platform-verifier panic presented on
    // Android). Catch it and surface it as a run error — the transport
    // renders RunInfo.error even when no error chunk was delivered.
    let info = std::panic::AssertUnwindSafe(rt.run_interactive(chat_id, messages, on_chunk))
        .catch_unwind()
        .await
        .unwrap_or_else(|p| RunInfo {
            ok: false,
            aborted: false,
            steps: 0,
            error: Some(format!("agent run panicked: {}", panic_msg(&p))),
        });
    Ok(info)
}

/// Best-effort panic payload message (any `Send` payload type).
fn panic_msg(p: &Box<dyn std::any::Any + Send>) -> String {
    match p.downcast_ref::<&'static str>() {
        Some(s) => (*s).to_string(),
        None => match p.downcast_ref::<String>() {
            Some(s) => s.clone(),
            None => "unknown panic".to_string(),
        },
    }
}

/// Cancel the in-flight turn, if any. Queued runs are NOT cleared — they
/// proceed when the current turn unwinds (matching the spec: abort kills
/// the current turn only).
#[tauri::command]
pub async fn agent_abort() -> Result<(), String> {
    let rt = runtime()?;
    rt.abort();
    Ok(())
}

/// Debug/background wake: seed the working chat with `message` (persisted as
/// an invocation note tagged with `origin` in its metadata) and queue a run
/// with no Channel — all events go out via Tauri emit only. Stage 5b's cron
/// and agent-action wakes reuse this exact path.
#[tauri::command]
pub async fn agent_wake_now(message: String) -> Result<(), String> {
    let rt = runtime()?;
    rt.enqueue_seed("debug", message).await;
    Ok(())
}

/// Resolve a pending question. When a live tool call is waiting, the value
/// is delivered to it directly. When the process restarted since the
/// question was posed (no live waiter but the persisted snapshot knows the
/// id), the answer is recorded into the chat transcript as a user message
/// and a fresh run is queued seeded with a short continuation instruction
/// (best-effort auto-continue).
#[tauri::command]
pub async fn respond_question(
    id: String,
    result: questions::QuestionResult,
) -> Result<questions::RespondOutcome, String> {
    let rt = runtime()?;
    Ok(rt.respond_question(&id, result).await)
}

/// Snapshot of currently-pending questions (newest first), for the UI's
/// initial render (the live stream is the `pending-questions-changed`
/// event).
#[tauri::command]
pub fn list_pending_questions() -> Result<Vec<questions::PendingQuestion>, String> {
    Ok(questions::list())
}

/// Run one compaction pass for a chat — the UI-driven entry point that
/// mirrors `runCompaction` in `compaction.ts` (ChatView owns the threshold
/// latch and the blocking modal; the backend owns boundary selection, the
/// summarizer call, and persistence). Returns the new state, or the prior
/// state unchanged when there was nothing new to compact, or `None` when
/// there is no compaction state at all.
#[tauri::command]
pub async fn agent_compact(
    chat_id: String,
    messages: Vec<serde_json::Value>,
    keep_turns: u32,
) -> Result<Option<compaction::CompactionState>, String> {
    compaction::run_compaction_command(&chat_id, &messages, keep_turns).await
}

/// Read one chat's persisted compaction state (null when never compacted).
#[tauri::command]
pub fn agent_compaction_state(
    chat_id: String,
) -> Result<Option<compaction::CompactionState>, String> {
    let rt = runtime()?;
    Ok(compaction::get_compaction(&rt.data_dir(), &chat_id))
}

// ============================================================================
// Background wake resolution
// ============================================================================

/// Resolve the working chat for a background seed: the active pointer when
/// it names a live chat, otherwise the newest active chat, otherwise a FRESH
/// chat created with `origin` (so `"cron"` chats are distinguishable in the
/// index — see `chats.rs` `origin`). `chats::ensure_active` would create
/// with the default `"user"` origin, so the creation branch is done here.
pub(crate) fn resolve_wake_chat(origin: &str) -> Result<chats::ChatMeta, String> {
    if let Some(meta) = chats::active_chat()? {
        if meta.archived_at.is_none() {
            return Ok(meta);
        }
    }
    if let Some(meta) = chats::list()?
        .into_iter()
        .filter(|c| c.archived_at.is_none())
        .max_by_key(|c| c.updated_at)
    {
        chats::set_active_chat(Some(&meta.id))?;
        return Ok(meta);
    }
    let meta = chats::create_with_id(&new_id(), "New chat", Some(origin))?;
    chats::set_active_chat(Some(&meta.id))?;
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_match_nanoid_alphabet_and_shape() {
        for _ in 0..50 {
            let id = new_id();
            assert_eq!(id.len(), 21);
            assert!(id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
        }
        assert_eq!(new_id_of(5).len(), 5);
    }

    #[test]
    fn run_info_serializes_compactly() {
        let info = RunInfo { ok: true, aborted: false, steps: 3, error: None };
        let json = serde_json::to_value(&info).unwrap();
        assert!(json.get("error").is_none());
        assert_eq!(json["steps"], 3);
        let info = RunInfo { ok: false, aborted: true, steps: 1, error: Some("x".into()) };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["error"], "x");
    }
}
