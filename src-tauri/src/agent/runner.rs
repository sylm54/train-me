//! The agent runner: single-flight turn gate, abort, the multi-turn
//! model-call → tool-execution loop, chunk streaming, and transcript
//! persistence.
//!
//! Semantics replicated from the JS loop (AI SDK `streamText` with
//! `stopWhen: isLoopFinished()` — which is `() => false`, i.e. the loop runs
//! until the model answers WITHOUT tool calls): per model call, stream text
//! deltas, collect tool calls, execute them, append results as tool-result
//! messages, and repeat. Each model call is a "step" in the UI stream; one
//! run is one assistant UIMessage containing step-delimited parts — exactly
//! what `useChat` builds from the chunk stream.
//!
//! Concurrency: at most ONE turn runs app-wide. `agent_run` invocations
//! queue FIFO on the gate — each queued run waits for its ticket, then runs
//! with the messages array it was given (the transport re-sends full
//! history, matching the JS transport). Background seeds
//! ([`AgentRuntime::enqueue_seed`]) queue the same way with no Channel.
//!
//! Abort: a [`CancelHandle`] (watch channel) is checked between stream
//! chunks; dropping the loop drops rig's stream (its underlying HTTP
//! response) — tokio cancellation without ceremony. Aborting the current
//! turn does NOT clear the queue.
//!
//! Persistence contract: the incoming message array is saved up-front
//! (`chats::save_messages`), and after EVERY step the transcript is
//! rewritten with the assistant message accumulated so far — a crash mid-run
//! leaves a coherent transcript ending in a complete-or-partial assistant
//! message, the same durability the debounced UI save used to provide.
//! (Stage 3b's transport should stop saving the transcript itself; until
//! then both sides write identical content.)
//!
//! Events: `usage` events (normalized, with `contextChars` + `chatId`) go
//! out via `app.emit("agent-event", …)` per step — same payloads as
//! `agent-events.ts`. Coarse activity is mirrored on the same channel as
//! `{type:"agent-activity", chatId, phase, detail?, ts}` so any view can
//! render background-run progress without a Channel.

use rig_core as rig;
use std::collections::VecDeque;
use std::sync::Arc;

use futures::StreamExt;
use parking_lot::Mutex;
use rig::completion::message::{AssistantContent, Message, ToolCall, ToolResultContent, UserContent};
use rig::completion::CompletionRequest;
use rig::streaming::StreamedAssistantContent;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use super::chunks::RunStream;
use super::compaction;
use super::convert;
use super::prompts;
use super::providers;
use super::questions;
use super::tools::ToolCtx;
use super::RunInfo;
use crate::settings::AgentSettings;

/// Hard cap on model-call steps per run. The JS loop had NO cap
/// (`isLoopFinished()` never fires); 40 is the staged plan's safety net
/// against a runaway tool loop. Hitting it ends the run with
/// `finishReason: "other"` and a warning log rather than looping forever.
pub(crate) const MAX_STEPS: u32 = 40;

/// Tauri event name all agent bus events go out on (usage, activity, and
/// subagent lifecycle — the payloads carry a `type` discriminator matching
/// `agent-events.ts`).
pub const AGENT_EVENT: &str = "agent-event";

// ============================================================================
// Cancellation
// ============================================================================

/// Abort handle for the in-flight turn. A watch channel (not `Notify`) so
/// `wait()` cannot race a cancel that fires between an is-cancelled check
/// and the await registration.
#[derive(Clone)]
pub struct CancelHandle {
    rx: tokio::sync::watch::Receiver<bool>,
    tx: tokio::sync::watch::Sender<bool>,
}

impl Default for CancelHandle {
    fn default() -> Self {
        Self::new()
    }
}

impl CancelHandle {
    pub fn new() -> Self {
        let (tx, rx) = tokio::sync::watch::channel(false);
        Self { tx, rx }
    }

    pub fn cancel(&self) {
        let _ = self.tx.send(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.rx.borrow()
    }

    /// Resolves once cancelled (immediately if already cancelled).
    pub async fn wait(&self) {
        let mut rx = self.rx.clone();
        loop {
            if *rx.borrow_and_update() {
                return;
            }
            if rx.changed().await.is_err() {
                return; // sender dropped — treat as cancelled
            }
        }
    }
}

// ============================================================================
// FIFO turn gate
// ============================================================================

#[derive(Default)]
struct GateState {
    running: bool,
    waiters: VecDeque<tokio::sync::oneshot::Sender<()>>,
}

struct Gate(Mutex<GateState>);

impl Gate {
    fn new() -> Self {
        Self(Mutex::new(GateState::default()))
    }

    /// Wait for the turn ticket (FIFO). Returns immediately when free.
    async fn acquire(&self) {
        let rx = {
            let mut g = self.0.lock();
            if !g.running {
                g.running = true;
                return;
            }
            let (tx, rx) = tokio::sync::oneshot::channel();
            g.waiters.push_back(tx);
            rx
        };
        let _ = rx.await;
    }

    /// Release the ticket, handing it straight to the next waiter (the gate
    /// stays "running" across the handoff — no gap for a third run to jump
    /// the queue).
    fn release(&self) {
        let mut g = self.0.lock();
        match g.waiters.pop_front() {
            Some(next) => {
                let _ = next.send(());
            }
            None => g.running = false,
        }
    }
}

// ============================================================================
// One model-call step (shared with subagents.rs)
// ============================================================================

/// Events forwarded from a step's stream as they arrive.
pub(crate) enum StepEvent<'a> {
    /// A text delta.
    Text(&'a str),
    /// A completed tool call (full arguments available).
    ToolCall(&'a ToolCall),
}

/// One model-call step's outcome (after the stream drains).
pub(crate) struct StepOutcome {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Option<rig::completion::Usage>,
    pub cost: Option<f64>,
    pub finish_reason: Option<String>,
    pub choice: Vec<AssistantContent>,
}

/// Stream ONE model call, forwarding text deltas and completed tool calls to
/// `on_event` as they arrive. Reasoning content is never forwarded (the JS
/// `stripReasoningFromStream` drops it from the UI stream and logs to
/// console; here it's logged at debug). Returns `Ok(None)` when cancelled —
/// the stream is dropped mid-flight, which tears down the underlying HTTP
/// response.
pub(crate) async fn stream_step(
    handle: &providers::ModelHandle,
    request: CompletionRequest,
    cancel: &CancelHandle,
    on_event: &mut (dyn FnMut(StepEvent<'_>) + Send),
) -> Result<Option<StepOutcome>, rig::completion::CompletionError> {
    let mut stream = handle.stream(request).await?;
    let mut out = StepOutcome {
        text: String::new(),
        tool_calls: Vec::new(),
        usage: None,
        cost: None,
        finish_reason: None,
        choice: Vec::new(),
    };
    let mut reasoning_seen = String::new();
    loop {
        let item = tokio::select! {
            biased;
            _ = cancel.wait() => return Ok(None),
            item = stream.next() => match item {
                Some(Ok(item)) => item,
                Some(Err(e)) => return Err(e),
                None => break,
            }
        };
        match item {
            StreamedAssistantContent::Text(t) => {
                on_event(StepEvent::Text(&t.text));
                out.text.push_str(&t.text);
            }
            StreamedAssistantContent::ToolCall { tool_call, .. } => {
                on_event(StepEvent::ToolCall(&tool_call));
                out.tool_calls.push(tool_call);
            }
            StreamedAssistantContent::ToolCallDelta { .. } => {
                // Coarse tool mapping: the completed call carries everything.
            }
            StreamedAssistantContent::ReasoningDelta { reasoning, .. } => {
                reasoning_seen.push_str(&reasoning);
            }
            StreamedAssistantContent::Reasoning { reasoning, .. } => {
                reasoning_seen.push_str(&reasoning.display_text());
            }
            StreamedAssistantContent::Final(f) => {
                out.usage = Some(f.usage);
                out.cost = f
                    .raw
                    .get("usage")
                    .and_then(|u| u.get("cost"))
                    .and_then(|c| c.as_f64());
                out.finish_reason = Some(match &f.finish_reason {
                    Some(rig::completion::FinishReason::Stop) => "stop".to_string(),
                    Some(rig::completion::FinishReason::Length) => "length".to_string(),
                    Some(rig::completion::FinishReason::ToolCalls) => "tool-calls".to_string(),
                    Some(rig::completion::FinishReason::ContentFilter) => {
                        "content-filter".to_string()
                    }
                    Some(rig::completion::FinishReason::Other(_)) | None => "other".to_string(),
                });
            }
            StreamedAssistantContent::Unknown(_) => {}
        }
    }
    if !reasoning_seen.is_empty() {
        // stripReasoningFromStream logged reasoning to the browser console at
        // reasoning-end; mirror that at debug (truncated).
        let preview: String = reasoning_seen.chars().take(200).collect();
        log::debug!(
            "[main] reasoning ({} chars): {preview}…",
            reasoning_seen.chars().count()
        );
    }
    // The aggregated choice is the replayable assistant message content.
    out.choice = stream.choice.clone();
    Ok(Some(out))
}

// ============================================================================
// Runtime
// ============================================================================

/// The agent runtime: managed state holding the app handle, the turn gate,
/// and the in-flight run's cancel handle. Lives behind an `Arc` in
/// [`super::runtime`] so background seeds can clone a handle into detached
/// tasks.
pub struct AgentRuntime {
    app: tauri::AppHandle,
    gate: Gate,
    current_cancel: Mutex<Option<CancelHandle>>,
}

impl AgentRuntime {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            gate: Gate::new(),
            current_cancel: Mutex::new(None),
        }
    }

    /// The app data dir (compaction sidecars, pending-question snapshot,
    /// settings.json all live under it).
    pub fn data_dir(&self) -> std::path::PathBuf {
        self.app.state::<crate::AppState>().data_dir.clone()
    }

    fn emit_event(&self, event: &Value) {
        let _ = self.app.emit(AGENT_EVENT, event);
    }

    fn send_chunk(channel: Option<&tauri::ipc::Channel<Value>>, chunk: Value) {
        if let Some(ch) = channel {
            let _ = ch.send(chunk);
        }
    }

    /// Emit a coarse activity event (the Channel mirror for background runs).
    fn activity(&self, chat_id: &str, phase: &str, detail: Option<&str>) {
        self.emit_event(&json!({
            "type": "agent-activity",
            "chatId": chat_id,
            "phase": phase,
            "detail": detail,
            "ts": super::now_ms(),
        }));
    }

    // ── public entry points ────────────────────────────────────────────

    /// Interactive run: queue for the turn ticket, then run with a Channel.
    pub async fn run_interactive(
        &self,
        chat_id: String,
        messages: Vec<Value>,
        channel: tauri::ipc::Channel<Value>,
    ) -> RunInfo {
        self.gate.acquire().await;
        let cancel = CancelHandle::new();
        *self.current_cancel.lock() = Some(cancel.clone());
        let info = self.run_turn(&chat_id, Some(messages), Some(&channel), &cancel).await;
        *self.current_cancel.lock() = None;
        self.gate.release();
        info
    }

    /// Background wake (cron / agent-action / debug): resolve the working
    /// chat, persist the seed as an invocation note, queue a run with no
    /// Channel (events only). Returns immediately — the run happens on a
    /// detached task, queued behind whatever turn is in flight.
    pub async fn enqueue_seed(self: &Arc<Self>, origin: &str, message: String) {
        let chat_id = match super::resolve_wake_chat(origin) {
            Ok(meta) => meta.id,
            Err(e) => {
                log::warn!("[agent] wake ({origin}): could not resolve working chat: {e}");
                return;
            }
        };
        // Persisted invocation note: a user-role message tagged with the
        // origin in its metadata (UIMessage.metadata is free-form and
        // ignored by model conversion — display layers can branch on it).
        let seed = json!({
            "id": super::new_id(),
            "role": "user",
            "parts": [{ "type": "text", "text": message }],
            "metadata": { "origin": origin },
        });
        if let Err(e) = crate::chats::append_message(&chat_id, &seed) {
            log::warn!("[agent] wake ({origin}): appending seed failed: {e}");
        }
        let _ = crate::chats::touch(&chat_id, None);
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            this.run_background(chat_id).await;
        });
    }

    /// The queued background run itself (no Channel — events only).
    async fn run_background(self: Arc<Self>, chat_id: String) {
        self.gate.acquire().await;
        let cancel = CancelHandle::new();
        *self.current_cancel.lock() = Some(cancel.clone());
        let info = self.run_turn(&chat_id, None, None, &cancel).await;
        *self.current_cancel.lock() = None;
        self.gate.release();
        log::info!(
            "[agent] background run for {chat_id} finished: ok={} steps={}",
            info.ok,
            info.steps
        );
    }

    /// Cancel the in-flight turn (no-op when idle). Queued runs proceed.
    pub fn abort(&self) {
        if let Some(cancel) = self.current_cancel.lock().as_ref() {
            cancel.cancel();
        }
    }

    /// Deliver a question answer. Live waiter → delivered. Restart orphan →
    /// the answer is recorded into the originating chat's transcript and a
    /// continuation run is queued (best-effort auto-continue).
    pub async fn respond_question(
        self: &Arc<Self>,
        id: &str,
        result: questions::QuestionResult,
    ) -> questions::RespondOutcome {
        if questions::respond(id, result.clone(), &self.app) {
            return questions::RespondOutcome { delivered: true, continued: false };
        }
        // No live waiter: a restart orphaned this question.
        let Some(q) = questions::take_orphan(id) else {
            return questions::RespondOutcome { delivered: false, continued: false };
        };
        let Some(chat_id) = q.chat_id.clone() else {
            return questions::RespondOutcome { delivered: false, continued: false };
        };
        let answer_text = if result.ok {
            match &result.answer {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => n.to_string(),
                Some(Value::Array(items)) => items
                    .iter()
                    .filter_map(|v| v.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
                Some(other) => other.to_string(),
                None => String::new(),
            }
        } else {
            format!(
                "(The question was cancelled: {})",
                result.reason.as_deref().unwrap_or("no reason given")
            )
        };
        let mut note = convert::user_message(&format!(
            "[You asked the user: \"{}\"]\nTheir answer: {answer_text}\n\nPlease continue from where you left off.",
            q.prompt
        ));
        note["metadata"] = json!({ "questionId": id });
        if let Err(e) = crate::chats::append_message(&chat_id, &note) {
            log::warn!("[agent] question answer could not be recorded: {e}");
            return questions::RespondOutcome { delivered: false, continued: false };
        }
        let _ = crate::chats::touch(&chat_id, None);
        self.enqueue_seed(
            "agent-action",
            "(The user answered your earlier question out-of-band; their answer is the message above. Continue the task.)".to_string(),
        )
        .await;
        questions::RespondOutcome { delivered: false, continued: true }
    }

    // ── the run loop ───────────────────────────────────────────────────

    /// One full agent turn. `messages: None` loads the transcript from disk
    /// (background seeds run off the persisted transcript).
    async fn run_turn(
        &self,
        chat_id: &str,
        messages: Option<Vec<Value>>,
        channel: Option<&tauri::ipc::Channel<Value>>,
        cancel: &CancelHandle,
    ) -> RunInfo {
        let data_dir = self.data_dir();
        let state = self.app.state::<crate::AppState>();
        let agent_dir = state.agent_dir.clone();

        // Fresh settings + system prompt per run (the JS transport's getters
        // re-read configuration on every send).
        let settings = AgentSettings::load(&data_dir.join("settings.json"));
        let handle = match providers::build(&settings, "main") {
            Ok(h) => h,
            Err(e) => return self.fail_run(chat_id, channel, &e),
        };

        // Fresh include-snapshot window per run (resetIncludeSnapshots).
        prompts::reset_include_snapshots();
        let base_prompt = prompts::load_prompt(&data_dir, &agent_dir, "main_agent.md");

        // Compaction: drop the summarized prefix, fold the summary into the
        // system prompt. The model never sees the summarized prefix.
        let compaction_state = compaction::get_compaction(&data_dir, chat_id);
        let all_messages =
            messages.unwrap_or_else(|| crate::chats::load_messages(chat_id).unwrap_or_default());
        let live = compaction::live_messages_for_model(&all_messages, compaction_state.as_ref());
        let system_prompt =
            compaction::system_prompt_with_summary(&base_prompt, compaction_state.as_ref());
        let context_chars = convert::context_chars_of(&live, &system_prompt);

        // Persist the incoming transcript up-front + bump chat activity.
        if let Err(e) = crate::chats::save_messages(chat_id, &all_messages) {
            return self.fail_run(chat_id, channel, &format!("persist transcript: {e}"));
        }
        let _ = crate::chats::touch(chat_id, None);

        let mut rig_msgs = convert::ui_to_rig_messages(&live);
        // Shared between the event sink (needs text/tool state to emit
        // well-formed chunk sequences) and the loop (needs start/finish).
        // Arc+parking_lot (not Rc/RefCell) because the run future must be
        // Send: interactive runs are awaited inside tauri commands and
        // background runs are spawned onto the multithreaded runtime.
        // One id shared by the `start` chunk and the persisted assistant
        // message, so Stage 3b's UI message IS the transcript row.
        let message_id = super::new_id();
        let stream = Arc::new(Mutex::new(RunStream::new(&message_id)));
        Self::send_chunk(channel, stream.lock().start());
        self.activity(chat_id, "start", Some(&handle.model));

        // Parts of THIS run's assistant message, accumulated across steps
        // (one UIMessage per run, step-delimited — the useChat shape).
        let mut run_parts: Vec<Value> = Vec::new();

        let mut info = RunInfo { ok: false, aborted: false, steps: 0, error: None };

        while info.steps < MAX_STEPS {
            if cancel.is_cancelled() {
                info.aborted = true;
                break;
            }
            for chunk in stream.lock().start_step() {
                Self::send_chunk(channel, chunk);
            }

            let mut step_text = String::new();
            let mut step_calls: Vec<ToolCall> = Vec::new();
            let request = CompletionRequest {
                model: Some(handle.model.clone()),
                preamble: Some(system_prompt.clone()),
                chat_history: rig_msgs.clone(),
                documents: Vec::new(),
                tools: super::tools::main_tool_defs(),
                temperature: None,
                max_tokens: None,
                tool_choice: None,
                additional_params: handle.reasoning_params.clone(),
                output_schema: None,
                record_telemetry_content: false,
            };
            let sink_stream = stream.clone();
            let mut on_event = |ev: StepEvent<'_>| {
                let mut s = sink_stream.lock();
                match ev {
                    StepEvent::Text(delta) => {
                        step_text.push_str(delta);
                        for chunk in s.text_delta(delta) {
                            Self::send_chunk(channel, chunk);
                        }
                    }
                    StepEvent::ToolCall(call) => {
                        step_calls.push(call.clone());
                        for chunk in s.tool_input(
                            call.id.as_str(),
                            &call.function.name,
                            call.function.arguments.clone(),
                        ) {
                            Self::send_chunk(channel, chunk);
                        }
                    }
                }
            };
            let outcome = match stream_step(&handle, request, cancel, &mut on_event).await {
                Ok(Some(o)) => o,
                Ok(None) => {
                    // Cancelled mid-stream: persist partial text, best-effort,
                    // then signal abort on the UI stream.
                    info.steps += 1;
                    info.aborted = true;
                    if !step_text.trim().is_empty() {
                        run_parts.push(convert::text_part(&step_text));
                        let msg = convert::assistant_message(&message_id, run_parts);
                        let _ = crate::chats::save_messages(
                            chat_id,
                            &[all_messages.clone(), vec![msg]].concat(),
                        );
                    }
                    Self::send_chunk(channel, stream.lock().abort());
                    self.activity(chat_id, "aborted", None);
                    return info;
                }
                Err(e) => {
                    // Hard stream failure: surface the error part, persist
                    // whatever accumulated, stop.
                    let msg = format!("model stream failed: {e}");
                    info.steps += 1;
                    if !step_text.trim().is_empty() {
                        run_parts.push(convert::text_part(&step_text));
                        let msg_json = convert::assistant_message(&message_id, run_parts);
                        let _ = crate::chats::save_messages(
                            chat_id,
                            &[all_messages.clone(), vec![msg_json]].concat(),
                        );
                    }
                    Self::send_chunk(channel, stream.lock().error(&msg));
                    self.activity(chat_id, "error", Some(&msg));
                    info.error = Some(msg);
                    return info;
                }
            };
            info.steps += 1;

            // Per-step usage report (the model-call boundary — a step's
            // prompt tokens ARE the current context size; deliberately NOT
            // summed across steps, matching reportUsage in agent.ts).
            if let Some(usage) = &outcome.usage {
                self.emit_event(&json!({
                    "type": "usage",
                    "role": "main",
                    "usage": convert::normalize_usage(usage, outcome.cost),
                    "ts": super::now_ms(),
                    "contextChars": context_chars,
                    "chatId": chat_id,
                }));
            }

            // This step's parts: the step boundary the UI stream produced
            // (the start-step chunk) is persisted as a step-start part —
            // one UIMessage, step-delimited, exactly what useChat would
            // hold. Text first, then tool parts (stream order).
            let mut step_parts: Vec<Value> = Vec::new();
            step_parts.push(convert::step_start_part());
            if !step_text.is_empty() {
                step_parts.push(convert::text_part(&step_text));
            }

            if outcome.tool_calls.is_empty() {
                // Final step: the model answered without tool calls — the
                // loop ends (the JS `isLoopFinished` semantics).
                for chunk in stream.lock().finish_step() {
                    Self::send_chunk(channel, chunk);
                }
                for chunk in stream
                    .lock()
                    .finish(outcome.finish_reason.as_deref().unwrap_or("stop"))
                {
                    Self::send_chunk(channel, chunk);
                }
                run_parts.extend(step_parts);
                let run_msg = convert::assistant_message(&message_id, run_parts);
                let _ = crate::chats::save_messages(
                    chat_id,
                    &[all_messages.clone(), vec![run_msg]].concat(),
                );
                info.ok = true;
                break;
            }

            // Tool step: execute each call (the UI already saw
            // tool-input-available from the sink), emit outputs, collect
            // parts + tool-result messages.
            let ctx = ToolCtx {
                app: &self.app,
                settings: &settings,
                chat_id,
                cancel,
            };
            let mut result_msgs: Vec<Message> = Vec::new();
            let mut tool_names: Vec<&str> = Vec::new();
            for call in &outcome.tool_calls {
                let call_id = call.id.as_str().to_string();
                let name = call.function.name.as_str();
                tool_names.push(name);
                match super::tools::execute(&ctx, name, &call.function.arguments).await {
                    Ok(output) => {
                        for chunk in stream.lock().tool_output(&call_id, output.clone()) {
                            Self::send_chunk(channel, chunk);
                        }
                        step_parts.push(convert::tool_part(
                            name,
                            &call_id,
                            &call.function.arguments,
                            &output,
                        ));
                        let content = match &output {
                            Value::String(s) => ToolResultContent::text(s.clone()),
                            other => ToolResultContent::Json { value: other.clone() },
                        };
                        result_msgs.push(Message::User {
                            content: vec![UserContent::tool_result(
                                call_id,
                                name.to_string(),
                                vec![content],
                            )],
                        });
                    }
                    Err(err) => {
                        for chunk in stream.lock().tool_output_error(&call_id, &err) {
                            Self::send_chunk(channel, chunk);
                        }
                        step_parts.push(convert::tool_part_error(
                            name,
                            &call_id,
                            &call.function.arguments,
                            &err,
                        ));
                        result_msgs.push(Message::User {
                            content: vec![UserContent::tool_result(
                                call_id,
                                name.to_string(),
                                vec![ToolResultContent::text(err)],
                            )],
                        });
                    }
                }
            }

            // Step end: close the step, persist the transcript durably
            // (assistant message with everything accumulated so far), and
            // extend the model history for the next call.
            for chunk in stream.lock().finish_step() {
                Self::send_chunk(channel, chunk);
            }
            run_parts.extend(step_parts);
            let run_msg = convert::assistant_message(&message_id, run_parts.clone());
            let _ = crate::chats::save_messages(
                chat_id,
                &[all_messages.clone(), vec![run_msg]].concat(),
            );
            rig_msgs.push(Message::Assistant { id: None, content: outcome.choice });
            rig_msgs.extend(result_msgs);
            self.activity(chat_id, "step", Some(&tool_names.join(", ")));
        }

        if !info.ok && !info.aborted && info.error.is_none() {
            // Hit the step cap: close cleanly rather than looping forever.
            log::warn!("[agent] run for {chat_id} hit the {MAX_STEPS}-step cap");
            for chunk in stream.lock().finish("other") {
                Self::send_chunk(channel, chunk);
            }
        }

        let _ = crate::chats::touch(chat_id, None);
        self.activity(chat_id, "end", None);
        info
    }

    /// A run that failed before any model call (no key, persistence error):
    /// surface an error part and stop.
    fn fail_run(
        &self,
        chat_id: &str,
        channel: Option<&tauri::ipc::Channel<Value>>,
        error: &str,
    ) -> RunInfo {
        Self::send_chunk(channel, json!({ "type": "error", "errorText": error }));
        self.activity(chat_id, "error", Some(error));
        RunInfo { ok: false, aborted: false, steps: 0, error: Some(error.to_string()) }
    }
}
