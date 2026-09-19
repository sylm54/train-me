//! Subagent orchestration (port of `src/lib/subagents.ts`): self-spawn —
//! the agent delegating to a fresh copy of itself.
//!
//! The copy runs the SAME rendered system prompt as the main agent
//! (re-loaded from disk on every spawn, so prompt edits apply immediately)
//! with an empty message history: the task brief is the only user message.
//! That clean slate is the point — long authoring jobs run with the docs
//! index at the front of context instead of buried under chat history. Only
//! the copy's final text is returned to the parent as the tool result.
//!
//! Depth cap is structural: the copy's toolset has no `spawn_agent` (and no
//! `ask_question` — a background copy asking the user would block forever),
//! so recursion cannot go deeper than 1.
//!
//! Faithful behaviors preserved:
//!  - `finalText` resets at every tool call, so the parent sees only the
//!    text emitted AFTER the last tool round — the final, polished answer.
//!    Inter-step "thinking out loud" is discarded.
//!  - Reasoning is never accumulated into the returned text.
//!  - The spawned `streamText` call in JS takes NO abort signal — aborting
//!    the main generation does not kill running copies. The Rust loop passes
//!    a never-cancelled handle for the same behavior.
//!
//! UI progress flows through `subagent-*` events on the
//! [`super::runner::AGENT_EVENT`] channel: start / step / tool / end, keyed
//! by a unique `runId` (`spawn-<nanoid>` — several copies may run in
//! PARALLEL when the model issues multiple `spawn_agent` calls in one step;
//! the Rust loop executes calls sequentially, but the event shapes stay
//! parallel-ready exactly like the JS ones).

use rig_core as rig;
use std::sync::Arc;

use rig::completion::message::{Message, ToolResultContent, UserContent};
use rig::completion::CompletionRequest;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use super::prompts;
use super::providers;
use super::runner::{stream_step, CancelHandle, StepEvent, MAX_STEPS, AGENT_EVENT};
use super::tools::{self, ToolCtx};
use crate::settings::AgentSettings;

// ============================================================================
// UI progress events (agent-events.ts shapes)
// ============================================================================

/// High-level label for a running subagent (`START_LABEL`).
const START_LABEL: &str = "Working on a task";

/// Friendly verb per tool (`STEP_LABEL`).
fn step_label(tool_name: &str) -> &str {
    match tool_name {
        "bash" => "Running command",
        "read_file" => "Reading file",
        "write_file" => "Writing file",
        "edit_file" => "Editing file",
        "list_files" => "Listing files",
        "validate_files" => "Validating files",
        "spawn_agent" => "Delegating",
        other => other,
    }
}

/// Max length for a friendly tool detail (path / command) surfaced to the UI.
const DETAIL_MAX: usize = 60;

/// Derive a short, friendly detail string from a tool's parsed input — a
/// file path, or (for bash) the collapsed command. `toolDetail` port.
fn tool_detail(tool_name: &str, input: &Value) -> Option<String> {
    if let Some(path) = input["path"].as_str() {
        if !path.is_empty() {
            return Some(path.to_string());
        }
    }
    if tool_name == "bash" {
        if let Some(command) = input["command"].as_str() {
            let c: String = command.split_whitespace().collect::<Vec<_>>().join(" ");
            let c = c.trim().to_string();
            return Some(match c.chars().count() > DETAIL_MAX {
                true => format!("{}…", c.chars().take(DETAIL_MAX).collect::<String>()),
                false => c,
            });
        }
    }
    None
}

fn emit(app: &tauri::AppHandle, event: Value) {
    let _ = app.emit(AGENT_EVENT, event);
}

fn emit_start(app: &tauri::AppHandle, run_id: &str, label: Option<&str>, task: Option<&str>) {
    emit(
        app,
        json!({
            "type": "subagent-start",
            "agent": "spawn",
            "runId": run_id,
            "depth": 1,
            "label": label.map(|l| format!("Working on: {l}")).unwrap_or_else(|| START_LABEL.to_string()),
            "task": task,
            "ts": super::now_ms(),
        }),
    );
}

fn emit_step(app: &tauri::AppHandle, run_id: &str, tool_name: &str, detail: Option<String>) {
    emit(
        app,
        json!({
            "type": "subagent-step",
            "agent": "spawn",
            "runId": run_id,
            "depth": 1,
            "label": step_label(tool_name),
            "detail": detail,
            "ts": super::now_ms(),
        }),
    );
}

fn emit_tool(app: &tauri::AppHandle, run_id: &str, tool_name: &str, detail: Option<String>, ok: bool) {
    emit(
        app,
        json!({
            "type": "subagent-tool",
            "agent": "spawn",
            "runId": run_id,
            "depth": 1,
            "toolName": tool_name,
            "label": step_label(tool_name),
            "detail": detail,
            "ok": ok,
            "ts": super::now_ms(),
        }),
    );
}

fn emit_end(app: &tauri::AppHandle, run_id: &str) {
    emit(
        app,
        json!({
            "type": "subagent-end",
            "agent": "spawn",
            "runId": run_id,
            "depth": 1,
            "ts": super::now_ms(),
        }),
    );
}

/// Report normalized token usage for a subagent step (role `"spawn"` — no
/// `contextChars`/`chatId`; those are main-only fields).
fn report_usage(app: &tauri::AppHandle, usage: &rig::completion::Usage, cost: Option<f64>) {
    emit(
        app,
        json!({
            "type": "usage",
            "role": "spawn",
            "usage": super::convert::normalize_usage(usage, cost),
            "ts": super::now_ms(),
        }),
    );
}

// ============================================================================
// Subagent context injection
// ============================================================================

/// Prefix prepended to the copy's system prompt (below its file prompt) —
/// verbatim from `withSubagentContext`. Framework prompts are written for
/// the agent generally; without this a spawned copy has been observed
/// trying to hand its own task back through a spawn tool, or addressing the
/// user as if in chat.
fn with_subagent_context(agent: &str, depth: u32, system_prompt: &str) -> String {
    format!(
        "[Subagent context — injected by the app, not part of your file prompt]\n\
         You ARE a fresh copy of the main agent (the \"{agent}\" subagent, depth {depth}), \
         spawned by the main agent via a tool call. The user does not see your messages — \
         only your final text is returned to the caller as that tool's result.\n\
         You have no tool to spawn further copies: whatever task you were given is yours \
         to complete directly.\n\n\
         {system_prompt}"
    )
}

// ============================================================================
// Spawn
// ============================================================================

/// Spawn a fresh copy of the main agent with a high-level task from its
/// parent. Loads and renders `prompts/main_agent.md` on every invocation so
/// the user can edit it and see changes immediately. Returns the copy's
/// final text (the text after its last tool call) — what the parent sees as
/// the tool result.
pub(crate) async fn spawn_agent(
    app: &tauri::AppHandle,
    settings: &AgentSettings,
    label: Option<&str>,
    task: &str,
) -> Result<String, String> {
    let depth = 1;
    let (data_dir, agent_dir) = {
        let state = app.state::<crate::AppState>();
        (state.data_dir.clone(), state.agent_dir.clone())
    };

    let system_prompt = prompts::load_prompt(&data_dir, &agent_dir, "main_agent.md");
    if system_prompt.is_empty() {
        return Err(
            "prompts/main_agent.md is empty or missing. Add a system prompt for the agent \
             before spawning a copy."
                .to_string(),
        );
    }

    // The JS subagent throws its own (shorter) message when the key is
    // missing — reproduce it exactly before delegating to the builder.
    let provider_name = settings
        .agents
        .get("main")
        .map(|c| c.provider.clone())
        .unwrap_or_default();
    let key_present = settings
        .api_keys
        .get(&provider_name)
        .and_then(|k| k.as_deref())
        .map(|k| !k.is_empty())
        .unwrap_or(false);
    if !key_present {
        return Err(format!(
            "No API key configured for the \"{provider_name}\" provider."
        ));
    }
    let handle = providers::build(settings, "main")?;

    // Unique id for THIS run — the UI keys each delegation frame on it (the
    // model may spawn several copies in parallel).
    let run_id = format!("spawn-{}", super::new_id());

    log::info!(
        "[spawn] ▶ starting ({provider_name}/{}): {:?}",
        handle.model,
        label.unwrap_or(task)
    );
    emit_start(app, &run_id, label, label);

    // Abort does not reach running copies (JS parity): a never-cancelled
    // handle keeps the copy's loop oblivious to the parent's cancel token.
    let never = CancelHandle::new();

    let result = run_copy(
        app,
        settings,
        &handle,
        &never,
        &system_prompt,
        task,
        &run_id,
        depth,
    )
    .await;

    // The `finally` block: pop the activity whatever happened.
    emit_end(app, &run_id);
    result
}

/// The copy's model loop (the `runSubagent` port).
#[allow(clippy::too_many_arguments)]
async fn run_copy(
    app: &tauri::AppHandle,
    settings: &AgentSettings,
    handle: &providers::ModelHandle,
    cancel: &CancelHandle,
    system_prompt: &str,
    task: &str,
    run_id: &str,
    depth: u32,
) -> Result<String, String> {
    let sys = with_subagent_context("spawn", depth, system_prompt);
    let mut messages = vec![Message::user(task)];

    // `final_text` keeps only the text emitted after the last tool call;
    // `pending_text` buffers the current run of text for logging.
    let state = Arc::new(Mutex::new((String::new(), String::new())));
    let mut recorded_calls: Vec<rig::completion::message::ToolCall> = Vec::new();

    for _step in 0..MAX_STEPS {
        if cancel.is_cancelled() {
            break;
        }
        let request = CompletionRequest {
            model: Some(handle.model.clone()),
            preamble: Some(sys.clone()),
            chat_history: messages.clone(),
            documents: Vec::new(),
            tools: tools::spawned_tool_defs(),
            temperature: None,
            max_tokens: None,
            tool_choice: None,
            additional_params: handle.reasoning_params.clone(),
            output_schema: None,
            record_telemetry_content: false,
        };
        let sink = state.clone();
        let calls = &mut recorded_calls;
        let mut on_event = |ev: StepEvent<'_>| {
            let mut s = sink.lock();
            match ev {
                StepEvent::Text(delta) => {
                    s.1.push_str(delta);
                    s.0.push_str(delta);
                }
                StepEvent::ToolCall(call) => {
                    // Flush + log any pending text, then DISCARD the
                    // accumulated text — it was inter-step thinking, not the
                    // final answer.
                    if !s.1.trim().is_empty() {
                        log::debug!("[spawn] 💬 text: {}…", &s.1.chars().take(120).collect::<String>());
                        s.1.clear();
                    }
                    s.0.clear();
                    emit_step(app, run_id, &call.function.name, None);
                    calls.push(call.clone());
                }
            }
        };
        let outcome = stream_step(handle, request, cancel, &mut on_event)
            .await
            .map_err(|e| format!("subagent stream failed: {e}"))?;
        let Some(outcome) = outcome else {
            // Cancelled mid-copy (cannot happen with the never-cancel handle
            // today; kept for symmetry).
            break;
        };

        // Per-step usage report (role "spawn").
        if let Some(usage) = &outcome.usage {
            report_usage(app, usage, outcome.cost);
        }

        if outcome.tool_calls.is_empty() {
            break; // the copy is done
        }

        // Append the assistant turn, execute the calls, append results.
        messages.push(Message::Assistant { id: None, content: outcome.choice });
        let ctx = ToolCtx {
            app,
            settings,
            chat_id: "",
            cancel,
        };
        for call in &outcome.tool_calls {
            let call_id = call.id.as_str();
            let name = call.function.name.as_str();
            let detail = tool_detail(name, &call.function.arguments);
            let executed = tools::execute(&ctx, name, &call.function.arguments).await;
            match &executed {
                Ok(output) => {
                    log::debug!(
                        "[spawn] ↳ {name} result: {}",
                        &serde_json::to_string(output).unwrap_or_default().chars().take(240).collect::<String>()
                    );
                    emit_tool(app, run_id, name, detail, true);
                    let content = match output {
                        Value::String(s) => ToolResultContent::text(s.clone()),
                        other => ToolResultContent::Json { value: other.clone() },
                    };
                    messages.push(Message::User {
                        content: vec![UserContent::tool_result(
                            call_id,
                            name.to_string(),
                            vec![content],
                        )],
                    });
                }
                Err(err) => {
                    log::warn!("[spawn] ✗ {name} error: {err}");
                    emit_tool(app, run_id, name, detail, false);
                    messages.push(Message::User {
                        content: vec![UserContent::tool_result(
                            call_id,
                            name.to_string(),
                            vec![ToolResultContent::text(err.clone())],
                        )],
                    });
                }
            }
        }
    }

    let (final_text, pending_text) = state.lock().clone();
    let _ = pending_text;
    Ok(final_text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_labels_match_js_map() {
        assert_eq!(step_label("bash"), "Running command");
        assert_eq!(step_label("read_file"), "Reading file");
        assert_eq!(step_label("write_file"), "Writing file");
        assert_eq!(step_label("edit_file"), "Editing file");
        assert_eq!(step_label("list_files"), "Listing files");
        assert_eq!(step_label("validate_files"), "Validating files");
        assert_eq!(step_label("spawn_agent"), "Delegating");
        assert_eq!(step_label("mystery"), "mystery");
    }

    #[test]
    fn tool_detail_prefers_path_and_collapses_bash_commands() {
        assert_eq!(
            tool_detail("read_file", &json!({"path": "routines/morning.md"})),
            Some("routines/morning.md".to_string())
        );
        let long = "a b ".repeat(30);
        let d = tool_detail("bash", &json!({"command": long})).unwrap();
        assert!(d.ends_with("…"));
        assert!(d.chars().count() <= DETAIL_MAX + 1);
        assert_eq!(tool_detail("write_file", &json!({})), None);
    }

    #[test]
    fn subagent_context_prefix_is_verbatim() {
        let out = with_subagent_context("spawn", 1, "BASE");
        assert!(out.starts_with("[Subagent context — injected by the app, not part of your file prompt]"));
        assert!(out.contains("the \"spawn\" subagent, depth 1"));
        assert!(out.contains("You have no tool to spawn further copies"));
        assert!(out.ends_with("BASE"));
    }
}
