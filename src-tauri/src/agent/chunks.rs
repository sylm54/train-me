//! AI-SDK v6 UIMessage stream chunk sequencing (pure logic, no I/O).
//!
//! Stage 3b will feed the [`crate::agent::agent_run`] Channel straight into
//! `useChat`, so the payloads must be exactly the part shapes the SDK's
//! stream processor accepts. Those are `z.strictObject`s (verified against
//! `ai@6.0.197`'s `uiMessageChunkSchema`, node_modules/ai/dist/index.mjs) —
//! any extra field fails validation, so every part here carries ONLY the
//! fields its schema allows:
//!
//!   text-start            { type, id }
//!   text-delta            { type, id, delta }
//!   text-end              { type, id }
//!   tool-input-available  { type, toolCallId, toolName, input }
//!   tool-output-available { type, toolCallId, output }
//!   start-step / finish-step / start { messageId } / finish { finishReason }
//!   error { errorText }   abort {}
//!
//! The sequencer is a small state machine that mints ids and enforces the
//! processor's documented invariants (text-delta requires an open
//! text-start; tool-output requires a prior tool-input-available with the
//! same id; nothing after `finish`). `validate_sequence` re-checks a whole
//! recorded run — that's what the unit tests pin.
//!
//! Rig tool calls are coarse-mapped (per the staged plan): the full
//! arguments are emitted as one `tool-input-available` when the call
//! completes (the SDK creates the `tool-<name>` part directly in the
//! `input-available` state — no `tool-input-start` needed), and the
//! execution result follows as `tool-output-available`.

use serde_json::{json, Value};
use std::collections::HashMap;

/// A run's chunk sequencer: one assistant UIMessage per run, one
/// `start-step`/`finish-step` pair per model-call step inside it.
pub struct RunStream {
    /// The assistant message this run streams into. Sent on `start` so
    /// `useChat` keys the message deterministically (the runner persists the
    /// transcript under the same id — the UI message and the disk row agree).
    message_id: String,
    /// Monotonic counter for text part ids (`t0`, `t1`, …).
    next_text: usize,
    /// Currently open text part id, if any (text-start sent, no text-end).
    open_text: Option<String>,
    /// Tool calls whose input was announced but whose output hasn't been.
    /// Maps toolCallId → toolName.
    pending_outputs: HashMap<String, String>,
    started: bool,
    step_open: bool,
    finished: bool,
}

impl RunStream {
    pub fn new(message_id: impl Into<String>) -> Self {
        Self {
            message_id: message_id.into(),
            next_text: 0,
            open_text: None,
            pending_outputs: HashMap::new(),
            started: false,
            step_open: false,
            finished: false,
        }
    }

    pub fn message_id(&self) -> &str {
        &self.message_id
    }

    /// `{"type":"start","messageId":…}` — opens the assistant message.
    /// Called once per run, before anything else.
    pub fn start(&mut self) -> Value {
        assert!(!self.started, "start emitted twice");
        assert!(!self.finished, "start after finish");
        self.started = true;
        json!({ "type": "start", "messageId": self.message_id })
    }

    /// `{"type":"start-step"}` — begins one model-call step. Any open text
    /// part from a previous step is closed first (should not happen — the
    /// runner closes text before ending a step — but the state machine
    /// keeps the stream well-formed regardless).
    pub fn start_step(&mut self) -> Vec<Value> {
        assert!(self.started, "start_step before start");
        assert!(!self.finished, "step after finish");
        let mut out = Vec::new();
        if let Some(end) = self.close_text() {
            out.push(end);
        }
        self.step_open = true;
        out.push(json!({ "type": "start-step" }));
        out
    }

    /// Stream one text delta. Opens a text part lazily on the first delta
    /// of a run of text. Empty deltas are dropped (the SDK would accept
    /// them, but there is nothing to render).
    pub fn text_delta(&mut self, delta: &str) -> Vec<Value> {
        assert!(self.started, "text before start");
        assert!(!self.finished, "text after finish");
        if delta.is_empty() {
            return Vec::new();
        }
        let mut out = Vec::new();
        let id = match &self.open_text {
            Some(id) => id.clone(),
            None => {
                let id = format!("t{}", self.next_text);
                self.next_text += 1;
                self.open_text = Some(id.clone());
                out.push(json!({ "type": "text-start", "id": id }));
                id
            }
        };
        out.push(json!({ "type": "text-delta", "id": id, "delta": delta }));
        out
    }

    /// Close the open text part (`text-end`), if one is open. Idempotent.
    pub fn end_text(&mut self) -> Vec<Value> {
        match self.close_text() {
            Some(v) => vec![v],
            None => Vec::new(),
        }
    }

    fn close_text(&mut self) -> Option<Value> {
        let id = self.open_text.take()?;
        Some(json!({ "type": "text-end", "id": id }))
    }

    /// Announce a complete tool call with its full arguments. Closes any
    /// open text part first (text preceding a tool call belongs to the same
    /// step, and the SDK requires text parts not to dangle across part
    /// kinds inside a step — closing is always well-formed).
    pub fn tool_input(&mut self, call_id: &str, tool_name: &str, input: Value) -> Vec<Value> {
        assert!(self.started, "tool_input before start");
        assert!(!self.finished, "tool_input after finish");
        assert!(
            !self.pending_outputs.contains_key(call_id),
            "tool_input twice for call {call_id}"
        );
        self.pending_outputs
            .insert(call_id.to_string(), tool_name.to_string());
        let mut out = Vec::new();
        if let Some(end) = self.close_text() {
            out.push(end);
        }
        out.push(json!({
            "type": "tool-input-available",
            "toolCallId": call_id,
            "toolName": tool_name,
            "input": input,
        }));
        out
    }

    /// Deliver one tool execution result. Must follow the matching
    /// `tool_input` for the same id.
    pub fn tool_output(&mut self, call_id: &str, output: Value) -> Vec<Value> {
        assert!(
            self.pending_outputs.contains_key(call_id),
            "tool_output without tool_input for call {call_id}"
        );
        self.pending_outputs.remove(call_id);
        vec![json!({
            "type": "tool-output-available",
            "toolCallId": call_id,
            "output": output,
        })]
    }

    /// Deliver one tool execution FAILURE (the JS tools reject under the
    /// same conditions and the SDK surfaces `output-error`). Must follow the
    /// matching `tool_input` for the same id. The part keeps its input (set
    /// by `tool_input`); only `errorText` is added.
    pub fn tool_output_error(&mut self, call_id: &str, error_text: &str) -> Vec<Value> {
        assert!(
            self.pending_outputs.contains_key(call_id),
            "tool_output_error without tool_input for call {call_id}"
        );
        self.pending_outputs.remove(call_id);
        vec![json!({
            "type": "tool-output-error",
            "toolCallId": call_id,
            "errorText": error_text,
        })]
    }

    /// Close the current step. Flushes any open text part. Idempotent-ish:
    /// a second call without an intervening `start_step` emits nothing.
    pub fn finish_step(&mut self) -> Vec<Value> {
        assert!(self.step_open, "finish_step without start_step");
        let mut out = Vec::new();
        if let Some(end) = self.close_text() {
            out.push(end);
        }
        self.step_open = false;
        out.push(json!({ "type": "finish-step" }));
        out
    }

    /// `{"type":"finish","finishReason":…}` — terminates the run's stream.
    /// Anything after this would be dropped by the SDK's processor, so the
    /// sequencer refuses further emission via assertions.
    pub fn finish(&mut self, reason: &str) -> Vec<Value> {
        assert!(self.started, "finish before start");
        assert!(!self.finished, "finish emitted twice");
        assert!(self.pending_outputs.is_empty(), "finish with pending tool outputs");
        self.finished = true;
        let mut out = Vec::new();
        if self.step_open {
            out.extend(self.finish_step());
        }
        out.push(json!({ "type": "finish", "finishReason": reason }));
        out
    }

    /// `{"type":"error","errorText":…}` — surfaces a hard failure. The SDK
    /// routes this to `useChat`'s `onError`. Does not close the stream by
    /// itself (the runner emits `finish`/`abort` or simply closes the
    /// Channel afterwards; the JS transport's error path behaves the same).
    pub fn error(&mut self, error_text: &str) -> Value {
        json!({ "type": "error", "errorText": error_text })
    }

    /// `{"type":"abort"}` — signals user-initiated cancellation.
    pub fn abort(&mut self) -> Value {
        json!({ "type": "abort" })
    }
}

/// Re-validate a recorded chunk sequence against the processor's
/// invariants. Used by tests over sequencer output; kept public so Stage 3b
/// can diagnose a malformed stream from a log dump.
pub fn validate_sequence(parts: &[Value]) -> Result<(), String> {
    let mut open_text: Option<String> = None;
    let mut seen_text_ids: std::collections::HashSet<String> = Default::default();
    let mut tool_input_ids: std::collections::HashSet<String> = Default::default();
    let mut tool_output_ids: std::collections::HashSet<String> = Default::default();
    let mut started = false;
    let mut step_open = false;
    let mut finished = false;

    for part in parts {
        let kind = part["type"].as_str().unwrap_or_default();
        if finished {
            return Err(format!("part after finish: {kind}"));
        }
        match kind {
            "start" => {
                if started {
                    return Err("duplicate start".into());
                }
                started = true;
            }
            "start-step" => {
                if !started {
                    return Err("start-step before start".into());
                }
                if step_open {
                    return Err("start-step inside open step".into());
                }
                step_open = true;
            }
            "finish-step" => {
                if !step_open {
                    return Err("finish-step without open step".into());
                }
                if open_text.is_some() {
                    return Err("text part left open across finish-step".into());
                }
                step_open = false;
            }
            "finish" => {
                if !started {
                    return Err("finish before start".into());
                }
                if step_open {
                    return Err("finish with open step".into());
                }
                finished = true;
            }
            "text-start" => {
                let id = part["id"].as_str().unwrap_or_default().to_string();
                if open_text.is_some() {
                    return Err("text-start inside open text part".into());
                }
                if !seen_text_ids.insert(id.clone()) {
                    return Err(format!("duplicate text id {id}"));
                }
                open_text = Some(id);
            }
            "text-delta" => {
                let id = part["id"].as_str().unwrap_or_default().to_string();
                if open_text.as_deref() != Some(id.as_str()) {
                    return Err(format!("text-delta for non-open text part {id}"));
                }
                if part["delta"].as_str().is_none() {
                    return Err("text-delta missing delta".into());
                }
            }
            "text-end" => {
                let id = part["id"].as_str().unwrap_or_default().to_string();
                if open_text.as_deref() != Some(id.as_str()) {
                    return Err(format!("text-end for non-open text part {id}"));
                }
                open_text = None;
            }
            "tool-input-available" => {
                let id = part["toolCallId"].as_str().unwrap_or_default().to_string();
                if !tool_input_ids.insert(id.clone()) {
                    return Err(format!("duplicate tool input for call {id}"));
                }
                if part["toolName"].as_str().is_none() {
                    return Err("tool-input-available missing toolName".into());
                }
                if part.get("input").is_none() {
                    return Err("tool-input-available missing input".into());
                }
            }
            "tool-output-available" => {
                let id = part["toolCallId"].as_str().unwrap_or_default().to_string();
                if !tool_input_ids.contains(&id) {
                    return Err(format!("tool-output for unknown call {id}"));
                }
                if !tool_output_ids.insert(id.clone()) {
                    return Err(format!("duplicate tool output for call {id}"));
                }
                if part.get("output").is_none() {
                    return Err("tool-output-available missing output".into());
                }
            }
            "tool-output-error" => {
                let id = part["toolCallId"].as_str().unwrap_or_default().to_string();
                if !tool_input_ids.contains(&id) {
                    return Err(format!("tool-output-error for unknown call {id}"));
                }
                if !tool_output_ids.insert(id.clone()) {
                    return Err(format!("duplicate tool output for call {id}"));
                }
                if part["errorText"].as_str().is_none() {
                    return Err("tool-output-error missing errorText".into());
                }
            }
            "error" => {
                if part["errorText"].as_str().is_none() {
                    return Err("error missing errorText".into());
                }
            }
            "abort" => {}
            other => return Err(format!("unknown part type {other}")),
        }
    }
    if open_text.is_some() {
        return Err("stream ended with open text part".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A complete happy-path run: two steps (text+tool, then final text).
    #[test]
    fn full_run_sequence_is_well_formed() {
        let mut s = RunStream::new("asst-1");
        let mut out = vec![s.start()];
        out.extend(s.start_step());
        out.extend(s.text_delta("Let me "));
        out.extend(s.text_delta("check."));
        out.extend(s.tool_input("call_1", "bash", json!({"command": "ls"})));
        out.extend(s.tool_output("call_1", json!({"stdout": "a", "stderr": "", "exit_code": 0})));
        out.extend(s.finish_step());
        out.extend(s.start_step());
        out.extend(s.text_delta("Done."));
        out.extend(s.finish_step());
        out.extend(s.finish("stop"));
        validate_sequence(&out).unwrap();

        // One text part spans the two deltas of step 1; step 2 opens a NEW
        // part after the first closed.
        let starts = out.iter().filter(|p| p["type"] == "text-start").count();
        assert_eq!(starts, 2);
        assert_eq!(out.iter().filter(|p| p["type"] == "text-end").count(), 2);
    }

    #[test]
    fn text_part_reopens_between_steps_and_tools() {
        let mut s = RunStream::new("m");
        let _ = s.start();
        let a = s.start_step();
        assert_eq!(a[0], json!({"type": "start-step"}));
        let a = s.text_delta("one");
        let b = s.tool_input("c1", "read_file", json!({"path": "x"}));
        // The delta opened the part (start + delta) and the tool input
        // closed it before the input part.
        assert_eq!(a[0]["type"], "text-start");
        assert_eq!(a[1]["type"], "text-delta");
        assert_eq!(b[0]["type"], "text-end");
    }

    #[test]
    fn empty_deltas_are_dropped() {
        let mut s = RunStream::new("m");
        let _ = s.start();
        assert!(s.text_delta("").is_empty());
        assert!(s.end_text().is_empty());
    }

    #[test]
    fn finish_reason_and_shapes_are_exact() {
        let mut s = RunStream::new("msg-9");
        let mut out = vec![s.start()];
        assert_eq!(out[0], json!({"type": "start", "messageId": "msg-9"}));
        out.extend(s.start_step());
        assert_eq!(out[1], json!({"type": "start-step"}));
        out.extend(s.text_delta("x"));
        assert_eq!(out[2], json!({"type": "text-start", "id": "t0"}));
        assert_eq!(
            out[3],
            json!({"type": "text-delta", "id": "t0", "delta": "x"})
        );
        out.extend(s.finish_step());
        out.extend(s.finish("stop"));
        assert_eq!(
            out.last().unwrap(),
            &json!({"type": "finish", "finishReason": "stop"})
        );
        validate_sequence(&out).unwrap();
    }

    #[test]
    fn validator_catches_broken_sequences() {
        // Output before input.
        let bad = vec![
            json!({"type": "start", "messageId": "m"}),
            json!({"type": "tool-output-available", "toolCallId": "c", "output": 1}),
        ];
        assert!(validate_sequence(&bad).is_err());

        // Delta without start.
        let bad = vec![
            json!({"type": "start", "messageId": "m"}),
            json!({"type": "text-delta", "id": "t0", "delta": "x"}),
        ];
        assert!(validate_sequence(&bad).is_err());

        // Part after finish.
        let bad = vec![
            json!({"type": "start", "messageId": "m"}),
            json!({"type": "finish", "finishReason": "stop"}),
            json!({"type": "start-step"}),
        ];
        assert!(validate_sequence(&bad).is_err());

        // Duplicate tool output (hand-built — the sequencer itself refuses
        // to emit one, which is exactly the invariant under test).
        let out = vec![
            json!({"type": "start", "messageId": "m"}),
            json!({"type": "tool-input-available", "toolCallId": "c", "toolName": "bash", "input": {}}),
            json!({"type": "tool-output-available", "toolCallId": "c", "output": 1}),
            json!({"type": "tool-output-available", "toolCallId": "c", "output": 2}),
        ];
        assert!(validate_sequence(&out).is_err());
    }

    #[test]
    fn abort_and_error_parts_are_minimal() {
        let mut s = RunStream::new("m");
        assert_eq!(s.abort(), json!({"type": "abort"}));
        assert_eq!(
            s.error("boom"),
            json!({"type": "error", "errorText": "boom"})
        );
    }
}
