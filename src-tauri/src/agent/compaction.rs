//! Summarizing auto-compact (port of `src/lib/compaction.ts`).
//!
//! Design (unchanged from the JS): **separate what the model sees from what
//! the user sees.** When the context grows too large, the older prefix is
//! summarized by the model into a short running summary; the transport
//! drops that prefix from what it sends and injects the summary into the
//! system prompt instead. The full transcript stays visible/on disk —
//! nothing is ever deleted.
//!
//! STORAGE DECISION (differs from the JS by necessity): the JS persisted
//! per-chat state to webview localStorage under
//! `train-me.chat.compaction.<chatId>`. The Rust side has no localStorage,
//! so state lives in a sidecar per chat at
//! `<app_data>/chats/<id>.compaction.json`:
//!
//! ```json
//! {"summary": "…", "lastSummarizedId": "<message id>", "lastCompactedAt": 1760000000000}
//! ```
//!
//! Same keys as the JS `CompactionState`. Sidecars live next to the
//! transcripts they compact; `chats::delete_permanently` doesn't know about
//! them (best-effort cleanup: the runner removes a chat's sidecar when it
//! still exists and the transcript is gone — an orphaned sidecar for a
//! missing transcript is inert because `lastSummarizedId` never matches).
//! The frontend's old localStorage states are abandoned, matching Stage 2's
//! "no migration" decision for chats themselves.
//!
//! The summary call is one NON-streaming model call on the main agent's
//! model that deliberately emits no usage events (it must not inflate the
//! context meter or re-trigger compaction).

use rig_core as rig;
use std::path::{Path, PathBuf};

use rig::completion::CompletionRequest;
use serde::{Deserialize, Serialize};

use crate::agent::providers;
use crate::settings::AgentSettings;

// ============================================================================
// State
// ============================================================================

/// Persisted compaction state for one chat. `None` (no file) means the chat
/// has never been compacted and the full history is live.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompactionState {
    /// The running summary substituted for the summarized prefix.
    pub summary: String,
    /// The `id` of the last message folded into `summary`. The transport
    /// drops every message up to and including this one before sending.
    pub last_summarized_id: String,
    /// When the most recent compaction ran (ms epoch), for the UI notice.
    #[serde(default)]
    pub last_compacted_at: i64,
}

/// Sidecar path for one chat.
fn compaction_path(data_dir: &Path, chat_id: &str) -> PathBuf {
    data_dir.join("chats").join(format!("{chat_id}.compaction.json"))
}

/// Validate the chat id enough to use it as a filename (mirrors
/// `chats::validate_chat_id` — the sidecar sits in the same directory).
fn validate_chat_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("chat id must not be empty".into());
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(format!("invalid chat id '{id}'"));
    }
    Ok(())
}

/// Load one chat's compaction state, or None if it has never been compacted
/// (or the file is corrupt — the JS loader is equally tolerant).
pub fn get_compaction(data_dir: &Path, chat_id: &str) -> Option<CompactionState> {
    if validate_chat_id(chat_id).is_err() {
        return None;
    }
    let raw = std::fs::read_to_string(compaction_path(data_dir, chat_id)).ok()?;
    let state: CompactionState = serde_json::from_str(&raw).ok()?;
    if state.summary.is_empty() || state.last_summarized_id.is_empty() {
        return None;
    }
    Some(state)
}

/// Persist one chat's compaction state (atomic temp+rename, matching
/// `settings.rs`/`chats.rs` — a crash must not lose the summary pointer).
pub fn set_compaction(
    data_dir: &Path,
    chat_id: &str,
    state: &CompactionState,
) -> Result<(), String> {
    validate_chat_id(chat_id)?;
    let path = compaction_path(data_dir, chat_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    match std::fs::rename(&tmp, &path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e.to_string())
        }
    }
}

/// Clear compaction state (e.g. when a chat is deleted). Idempotent.
pub fn clear_compaction(data_dir: &Path, chat_id: &str) {
    if validate_chat_id(chat_id).is_ok() {
        let _ = std::fs::remove_file(compaction_path(data_dir, chat_id));
    }
}

// ============================================================================
// Boundary selection
// ============================================================================

/// True when the message's role is conversational (user/assistant).
fn is_conversational(m: &serde_json::Value) -> bool {
    matches!(m["role"].as_str(), Some("user") | Some("assistant"))
}

/// True when any part of the message is a tool part (type starts with
/// "tool-").
fn has_tool_parts(m: &serde_json::Value) -> bool {
    m["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .any(|p| p["type"].as_str().map(|t| t.starts_with("tool-")).unwrap_or(false))
        })
        .unwrap_or(false)
}

/// Find the index in `messages` at which to split for compaction: everything
/// at index < `boundary` becomes the summarized prefix; everything from
/// `boundary` onward stays live.
///
/// The most recent `keep_turns` conversational (user/assistant) messages are
/// always kept live. The boundary then walks back a little further if needed
/// so the kept tail doesn't begin mid-exchange: if the message just before
/// the boundary is an assistant message carrying tool parts (whose results
/// may live in the dropped prefix), the boundary pulls left to a `user` turn
/// so no tool call is severed from its result.
///
/// Returns 0 when there is nothing to summarize.
pub fn find_compaction_boundary(messages: &[serde_json::Value], keep_turns: u32) -> usize {
    if keep_turns == 0 || messages.is_empty() {
        return 0;
    }
    // Find where the kept recent window starts.
    let mut boundary = messages.len();
    let mut count = 0u32;
    for i in (0..messages.len()).rev() {
        if is_conversational(&messages[i]) {
            boundary = i;
            count += 1;
            if count >= keep_turns {
                break;
            }
        }
    }
    if boundary == 0 || count == 0 {
        return 0;
    }
    // Ensure the kept tail starts on a clean exchange boundary.
    while boundary > 1 {
        let prev = &messages[boundary - 1];
        if prev["role"].as_str() == Some("user") {
            break;
        }
        if !has_tool_parts(prev) {
            break;
        }
        boundary -= 1;
    }
    if boundary == 0 { 0 } else { boundary }
}

/// Friendly one-liner for a tool part, for inclusion in the summary input
/// (port of `summarizeToolPartForSummary` — exact phrasing preserved; the
/// summarizer model has been prompted against these shapes).
fn summarize_tool_part_for_summary(part: &serde_json::Value) -> String {
    let part_type = part["type"].as_str().unwrap_or_default();
    let name = if let Some(stripped) = part_type.strip_prefix("tool-") {
        stripped.to_string()
    } else {
        part["toolName"].as_str().unwrap_or("tool").to_string()
    };
    let input = &part["input"];
    let path = input["path"].as_str();
    match name.as_str() {
        "edit_file" => format!("edited {}", path.unwrap_or("a file")),
        "write_file" => format!("wrote {}", path.unwrap_or("a file")),
        "read_file" => format!("read {}", path.unwrap_or("a file")),
        "list_files" => format!("listed {}", path.unwrap_or(".")),
        "bash" => {
            let cmd = input["command"]
                .as_str()
                .map(|c| c.split_whitespace().collect::<Vec<_>>().join(" "));
            match cmd {
                Some(c) => format!("ran `{}`", &c[..c.len().min(80)]),
                None => "ran a command".to_string(),
            }
        }
        "spawn_agent" => "delegated a task to a fresh copy".to_string(),
        other => other.to_string(),
    }
}

/// Extract a plain-text rendering of a message for the summarizer: user
/// text, assistant text, and a compact marker for tool activity (port of
/// `messageToSummaryText`).
fn message_to_summary_text(message: &serde_json::Value) -> String {
    let role = match message["role"].as_str() {
        Some("user") => "User",
        _ => "Assistant",
    };
    let mut parts: Vec<String> = Vec::new();
    if let Some(arr) = message["parts"].as_array() {
        for p in arr {
            match p["type"].as_str().unwrap_or_default() {
                "text" => {
                    let text = p["text"].as_str().unwrap_or_default().trim().to_string();
                    if !text.is_empty() {
                        parts.push(text);
                    }
                }
                t if t.starts_with("tool-") => {
                    let label = summarize_tool_part_for_summary(p);
                    if !label.is_empty() {
                        parts.push(format!("[tool: {label}]"));
                    }
                }
                _ => {}
            }
        }
    }
    if parts.is_empty() {
        return String::new();
    }
    format!("{role}: {}", parts.join(" "))
}

// ============================================================================
// Summarizer call
// ============================================================================

/// System prompt for the summarizer — verbatim from compaction.ts. Distinct
/// from the main agent prompt: it only compresses, it doesn't act.
const SUMMARIZER_SYSTEM: &str = r#"You are a conversation summarizer for an AI assistant app. You compress prior conversation so the assistant can continue seamlessly with far less context.

Given a transcript to compress — and optionally the PREVIOUS summary of even-older turns — produce a tight, information-dense continuation summary in markdown.

Preserve, in priority order:
1. The user's current goal/task and what the assistant is doing right now.
2. Concrete decisions, agreements, and constraints established (including denials / things the user does NOT want).
3. Files created/edited and their purpose; commands run and outcomes; tool activity that matters.
4. Any open questions, pending actions, or unresolved errors.
5. Stable user preferences and context that will affect future turns.

Drop small talk, redundant back-and-forth, and anything already implied by the items above. Prefer bullet points and short prose. Do NOT invent details not present in the input. Reference file paths and identifiers verbatim. Keep it under ~400 words unless the conversation genuinely needs more.

Start directly with the summary — no preamble, no "Here is a summary"."#;

/// Build the summarizer's user prompt: any existing summary plus the
/// rendered transcript to compress.
fn summarizer_prompt(existing_summary: Option<&str>, old_messages: &[serde_json::Value]) -> String {
    let mut lines: Vec<String> = Vec::new();
    match existing_summary.map(str::trim).filter(|s| !s.is_empty()) {
        Some(prev) => {
            lines.push("PREVIOUS SUMMARY (of even-older turns):".to_string());
            lines.push(prev.to_string());
            lines.push(String::new());
            lines.push("TRANSCRIPT TO COMPRESS (newer turns follow):".to_string());
        }
        None => {
            lines.push("TRANSCRIPT TO COMPRESS:".to_string());
        }
    }
    for m in old_messages {
        let text = message_to_summary_text(m);
        if !text.is_empty() {
            lines.push(text);
        }
    }
    lines.join("\n")
}

/// Summarize the older `old_messages`, folding in any existing summary of
/// even-older turns. Uses the configured main agent model (non-streaming,
/// max 1200 output tokens ≈ the ~400-word ceiling). Returns the new summary,
/// or the existing one unchanged if the call fails or produces nothing —
/// compaction must never break the chat.
async fn summarize_conversation(
    settings: &AgentSettings,
    existing_summary: Option<&str>,
    old_messages: &[serde_json::Value],
) -> String {
    let fallback = existing_summary.unwrap_or_default().to_string();
    let user_content = summarizer_prompt(existing_summary, old_messages);
    if user_content.trim().is_empty() || old_messages.is_empty() {
        return fallback;
    }

    let handle = match providers::build(settings, "main") {
        Ok(h) => h,
        Err(e) => {
            log::warn!("[compaction] no model for summarizer: {e}");
            return fallback;
        }
    };

    let request = CompletionRequest {
        model: Some(handle.model.clone()),
        preamble: Some(SUMMARIZER_SYSTEM.to_string()),
        chat_history: vec![rig::completion::Message::user(user_content)],
        documents: Vec::new(),
        tools: Vec::new(),
        temperature: None,
        // Cap the summary length (~1200 tokens ≈ ~400 words).
        max_tokens: Some(1200),
        tool_choice: None,
        additional_params: handle.reasoning_params.clone(),
        output_schema: None,
        record_telemetry_content: false,
    };

    match handle.completion(request).await {
        Ok(resp) => {
            // Concatenate the choice's text content (the JS `result.text`).
            let text: String = resp
                .choice
                .iter()
                .filter_map(|c| match c {
                    rig::completion::AssistantContent::Text(t) => Some(t.text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");
            let text = text.trim().to_string();
            if text.is_empty() {
                fallback
            } else {
                text
            }
        }
        Err(e) => {
            log::warn!("[compaction] summarize call failed: {e}");
            fallback
        }
    }
}

// ============================================================================
// Orchestration
// ============================================================================

/// Run one compaction pass for a chat: pick a safe boundary, summarize the
/// newly-summarizable prefix (folding in any existing summary of older
/// turns), persist and return the new state. Does NOT mutate `messages` —
/// the caller keeps the full array for display.
///
/// On a second+ compaction, only turns AFTER the prior `lastSummarizedId`
/// are fed to the summarizer, so nothing is summarized twice. Returns the
/// prior state unchanged when there's nothing new to compact, or `None`
/// when there is no compaction state at all.
pub async fn run_compaction(
    data_dir: &Path,
    settings: &AgentSettings,
    chat_id: &str,
    messages: &[serde_json::Value],
    keep_turns: u32,
) -> Result<Option<CompactionState>, String> {
    let boundary = find_compaction_boundary(messages, keep_turns);
    if boundary == 0 {
        return Ok(get_compaction(data_dir, chat_id));
    }

    let prior = get_compaction(data_dir, chat_id);

    // Where the prior summary ends; -1 = no prior summary (everything up to
    // `boundary` is new). At/after the new boundary → nothing new.
    let prior_idx = prior
        .as_ref()
        .map(|p| {
            messages
                .iter()
                .position(|m| m["id"].as_str() == Some(p.last_summarized_id.as_str()))
                .map(|i| i as i64)
                .unwrap_or(-1)
        })
        .unwrap_or(-1);
    let new_start = (prior_idx + 1) as usize;
    if new_start >= boundary {
        return Ok(prior);
    }

    let new_messages = &messages[new_start..boundary];
    let summary = summarize_conversation(
        settings,
        prior.as_ref().map(|p| p.summary.as_str()),
        new_messages,
    )
    .await;

    // If the summarizer returned nothing usable, keep whatever we had.
    if summary.is_empty() {
        return Ok(prior);
    }

    let Some(last) = messages.get(boundary - 1) else {
        return Ok(prior);
    };
    let Some(last_id) = last["id"].as_str() else {
        return Ok(prior);
    };

    let state = CompactionState {
        summary,
        last_summarized_id: last_id.to_string(),
        last_compacted_at: crate::agent::now_ms(),
    };
    set_compaction(data_dir, chat_id, &state)?;
    Ok(Some(state))
}

// ============================================================================
// What the model sees
// ============================================================================

/// Return the subset of `messages` the model should see, given compaction
/// state: drop every message up to and including `last_summarized_id`. No
/// state, or an id that isn't found → the input unchanged (JS parity).
pub fn live_messages_for_model(
    messages: &[serde_json::Value],
    compaction: Option<&CompactionState>,
) -> Vec<serde_json::Value> {
    let Some(state) = compaction else {
        return messages.to_vec();
    };
    match messages
        .iter()
        .position(|m| m["id"].as_str() == Some(state.last_summarized_id.as_str()))
    {
        Some(idx) => messages[idx + 1..].to_vec(),
        None => messages.to_vec(),
    }
}

/// Build the effective system prompt: the base prompt plus, when a summary
/// exists, a clearly-delimited "conversation so far" block (exact wording —
/// the model has seen this framing in every compacted session so far).
pub fn system_prompt_with_summary(
    base_prompt: &str,
    compaction: Option<&CompactionState>,
) -> String {
    let Some(state) = compaction else {
        return base_prompt.to_string();
    };
    if state.summary.trim().is_empty() {
        return base_prompt.to_string();
    }
    format!(
        "{}\n\n{}\n{}\n\n{}",
        base_prompt.trim_end(),
        "## Conversation so far (summary of earlier turns)",
        "The following summarizes earlier turns that have been compacted out of the live context. Treat it as accurate history and continue from here:",
        state.summary.trim()
    )
}

// ============================================================================
// Command entry (context glue only — everything above is context-free)
// ============================================================================

/// The `agent_compact` command body: resolves the data dir + settings from
/// the app and delegates to [`run_compaction`].
pub(crate) async fn run_compaction_command(
    chat_id: &str,
    messages: &[serde_json::Value],
    keep_turns: u32,
) -> Result<Option<CompactionState>, String> {
    let rt = super::runtime()?;
    let data_dir = rt.data_dir();
    let settings = crate::settings::AgentSettings::load(&data_dir.join("settings.json"));
    run_compaction(&data_dir, &settings, chat_id, messages, keep_turns).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::convert;
    use serde_json::json;

    /// UIMessage fixtures: user text / assistant text / assistant tool call.
    fn user(id: &str, text: &str) -> serde_json::Value {
        json!({"id": id, "role": "user", "parts": [{"type": "text", "text": text}]})
    }
    fn assistant(id: &str, text: &str) -> serde_json::Value {
        json!({"id": id, "role": "assistant", "parts": [{"type": "text", "text": text}]})
    }
    fn tool_msg(id: &str) -> serde_json::Value {
        json!({
            "id": id, "role": "assistant",
            "parts": [
                {"type": "tool-bash", "toolCallId": "c1", "state": "output-available",
                 "input": {"command": "ls  -la"}, "output": {"stdout": "x"}}
            ]
        })
    }

    #[test]
    fn boundary_keeps_recent_turns_and_avoids_severing_tools() {
        let msgs = vec![
            user("u1", "hi"),          // 0
            assistant("a1", "hello"),  // 1
            tool_msg("a2"),            // 2 (assistant w/ tool part)
            user("u2", "more"),        // 3
            assistant("a3", "done"),   // 4
        ];
        // keep 2 conversational messages: boundary lands on index 3, then the
        // walk-back loop pulls it to 2 because the message just before the
        // boundary (index 2) is an assistant message carrying a tool part
        // whose result must not be severed from its call.
        assert_eq!(find_compaction_boundary(&msgs, 2), 2);
        // keep 6 → window reaches the start → nothing to summarize.
        assert_eq!(find_compaction_boundary(&msgs, 6), 0);
        // keep 3 → the window itself starts at the tool message (index 2);
        // the walk-back stops immediately (prev = a1 has no tool parts).
        assert_eq!(find_compaction_boundary(&msgs, 3), 2);
    }

    #[test]
    fn boundary_zero_cases() {
        assert_eq!(find_compaction_boundary(&[], 6), 0);
        assert_eq!(find_compaction_boundary(&[user("u1", "x")], 0), 0);
        // Only tool-carrying assistant messages still count (conversational).
        assert_eq!(find_compaction_boundary(&[tool_msg("a1")], 1), 0);
    }

    #[test]
    fn live_messages_drop_through_last_summarized() {
        let msgs = vec![user("u1", "a"), assistant("a1", "b"), user("u2", "c")];
        let state = CompactionState {
            summary: "s".into(),
            last_summarized_id: "a1".into(),
            last_compacted_at: 0,
        };
        let live = live_messages_for_model(&msgs, Some(&state));
        assert_eq!(live.len(), 1);
        assert_eq!(live[0]["id"], "u2");
        // Unknown id / no state → unchanged.
        let state = CompactionState { last_summarized_id: "zz".into(), summary: "s".into(), last_compacted_at: 0 };
        assert_eq!(live_messages_for_model(&msgs, Some(&state)).len(), 3);
        assert_eq!(live_messages_for_model(&msgs, None).len(), 3);
    }

    #[test]
    fn system_prompt_summary_block_matches_js_wording() {
        let base = "BASE\n";
        assert_eq!(system_prompt_with_summary(base, None), "BASE\n");
        let state = CompactionState {
            summary: "the gist".into(),
            last_summarized_id: "a1".into(),
            last_compacted_at: 0,
        };
        let out = system_prompt_with_summary(base, Some(&state));
        assert!(out.starts_with("BASE"));
        assert!(out.contains("## Conversation so far (summary of earlier turns)"));
        assert!(out.contains("Treat it as accurate history and continue from here:"));
        assert!(out.ends_with("the gist"));
    }

    #[test]
    fn summary_text_renders_tool_markers() {
        let m = tool_msg("a2");
        let text = message_to_summary_text(&m);
        assert_eq!(text, "Assistant: [tool: ran `ls -la`]");
        // Path-bearing tools and fallbacks.
        let p = json!({
            "id": "x", "role": "assistant",
            "parts": [
                {"type": "tool-write_file", "input": {"path": "routines/morning.md"}},
                {"type": "text", "text": " wrote it"},
                {"type": "tool-unknown_tool"}
            ]
        });
        let text = message_to_summary_text(&p);
        assert!(text.contains("[tool: wrote routines/morning.md]"), "{text}");
        assert!(text.contains("[tool: unknown_tool]"), "{text}");
        assert!(text.contains("wrote it"), "{text}");
        assert!(text.starts_with("Assistant: "));
    }

    #[test]
    fn summarizer_prompt_folds_previous_summary() {
        let msgs = vec![user("u1", "goal: tea")];
        let without = summarizer_prompt(None, &msgs);
        assert!(without.starts_with("TRANSCRIPT TO COMPRESS:"));
        assert!(without.contains("User: goal: tea"));
        let with = summarizer_prompt(Some("old stuff"), &msgs);
        assert!(with.contains("PREVIOUS SUMMARY (of even-older turns):"));
        assert!(with.contains("old stuff"));
        assert!(with.contains("TRANSCRIPT TO COMPRESS (newer turns follow):"));
    }

    #[test]
    fn compaction_state_sidecar_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path();
        assert!(get_compaction(data, "chat1").is_none());
        let state = CompactionState {
            summary: "s".into(),
            last_summarized_id: "m1".into(),
            last_compacted_at: 1234,
        };
        set_compaction(data, "chat1", &state).unwrap();
        let loaded = get_compaction(data, "chat1").unwrap();
        assert_eq!(loaded, state);
        // On-disk keys are camelCase (same JSON the JS wrote to localStorage).
        let raw = std::fs::read_to_string(data.join("chats/chat1.compaction.json")).unwrap();
        assert!(raw.contains("\"lastSummarizedId\""));
        assert!(raw.contains("\"lastCompactedAt\""));
        clear_compaction(data, "chat1");
        assert!(get_compaction(data, "chat1").is_none());
        // Invalid ids are rejected, never used as filenames.
        assert!(set_compaction(data, "../evil", &state).is_err());
        assert!(get_compaction(data, "../evil").is_none());
    }

    #[test]
    fn context_chars_agrees_with_convert_module() {
        // Sanity: the compaction path computes context size via convert,
        // which owns the counting math (tested there). Just pin the import.
        let msgs = vec![user("u1", "abc")];
        assert_eq!(convert::context_chars_of(&msgs, "SYS"), 6);
    }
}
