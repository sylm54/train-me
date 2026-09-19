//! UIMessage ⇄ rig message conversion, context char counting, and usage
//! normalization.
//!
//! Ports three JS pieces that the runner needs verbatim:
//!
//!  1. `convertToModelMessages` (ai@6.0.197, `convert-to-model-messages.ts`)
//!     — turns the transport's UIMessage array into model messages. The v6
//!     UIMessage shape keeps tool calls AND their results inside assistant
//!     messages as `tool-<name>` parts; the conversion splits each
//!     `step-start`-delimited block into one assistant message (text +
//!     tool-call content) followed by one tool-result message. rig models
//!     the latter as a User message carrying `UserContent::ToolResult`
//!     items, which the provider adapters serialize to the wire's tool
//!     role — the same place the JS path puts them.
//!
//!  2. `contextCharsOf` (`src/lib/contextUsage.ts`) — the visible char size
//!     of what the model is sent (system prompt + per-message text parts +
//!     JSON-serialized tool inputs/outputs). Attached to usage events so
//!     the UI can calibrate its char→token estimate between real reports.
//!     Char counts use scalar-char counts, the closest Rust analogue to JS
//!     string `.length` (identical for BMP text; astral chars count as 1
//!     instead of 2 — a rounding-scale divergence for a heuristic).
//!
//!  3. `normalizeUsage` (`src/lib/agent-events.ts`) — shapes one finished
//!     step's token usage into the UI's `Usage` object. rig hands us
//!     normalized token counts (`crate::completion::Usage`) plus — via the
//!     stream's terminal record — the provider's raw usage, which is where
//!     OpenRouter's exact per-call charge lives (`raw.usage.cost`), matching
//!     the JS `raw.cost`/`providerMetadata.openrouter.usage.cost` lookup.

use rig_core as rig;
use rig::completion::message::{AssistantContent, Message, ToolResultContent, UserContent};
use serde_json::{json, Value};

// ============================================================================
// UIMessage builders (persistence shapes)
// ============================================================================

/// A `{type:"step-start"}` part (marks a step boundary inside an assistant
/// message; the UI renders it as a divider and `convertToModelMessages`
/// splits blocks on it).
pub(crate) fn step_start_part() -> Value {
    json!({ "type": "step-start" })
}

/// A finished text part. `state:"done"` is what the SDK's `text-end` sets.
pub(crate) fn text_part(text: &str) -> Value {
    json!({ "type": "text", "text": text, "state": "done" })
}

/// A finished tool part (`tool-<name>` type — the static-tool shape
/// `useChat` renders and `convertToModelMessages` splits back into
/// tool-call + tool-result model messages).
pub(crate) fn tool_part(tool_name: &str, call_id: &str, input: &Value, output: &Value) -> Value {
    json!({
        "type": format!("tool-{tool_name}"),
        "toolCallId": call_id,
        "state": "output-available",
        "input": input,
        "output": output,
    })
}

/// A tool part whose execution FAILED (state `output-error`, the input kept
/// from `tool-input-available` plus the error text — what `useChat` holds
/// after a `tool-output-error` chunk).
pub(crate) fn tool_part_error(tool_name: &str, call_id: &str, input: &Value, error_text: &str) -> Value {
    json!({
        "type": format!("tool-{tool_name}"),
        "toolCallId": call_id,
        "state": "output-error",
        "input": input,
        "errorText": error_text,
    })
}

/// A user UIMessage with a single text part (the transport's outgoing
/// messages and background seeds are all this shape).
pub(crate) fn user_message(text: &str) -> Value {
    json!({
        "id": super::new_id(),
        "role": "user",
        "parts": [{ "type": "text", "text": text }],
    })
}

/// An assistant UIMessage from finished parts (ids minted Rust-side with
/// the same nanoid shape the frontend uses).
pub(crate) fn assistant_message(message_id: &str, parts: Vec<Value>) -> Value {
    json!({
        "id": message_id,
        "role": "assistant",
        "parts": parts,
    })
}

// ============================================================================
// convertToModelMessages port
// ============================================================================

/// Extract the tool name from a `tool-<name>` part type.
fn tool_part_name(part: &Value) -> Option<&str> {
    part["type"]
        .as_str()
        .and_then(|t| t.strip_prefix("tool-"))
}

/// Convert the UIMessage array the transport receives into rig messages.
///
/// Faithful subset of the SDK's converter for the part kinds this app
/// produces (text + tool parts; file/reasoning/data parts never reach the
/// transcript because the UI strips reasoning and has no attachments):
///
///  - `user`  → text parts become `UserContent::text`.
///  - `assistant` → parts are grouped into blocks split on `step-start`;
///    each block becomes one assistant message (text + tool-call), and any
///    tool parts with a settled output/error become one following user
///    message of `ToolResult` content. String outputs map to text content
///    (the SDK's `createToolModelOutput` text branch), objects to JSON
///    content.
pub(crate) fn ui_to_rig_messages(messages: &[Value]) -> Vec<Message> {
    let mut out = Vec::new();
    for m in messages {
        let role = m["role"].as_str().unwrap_or_default();
        let parts = m["parts"].as_array().cloned().unwrap_or_default();
        match role {
            "system" => {
                let text: String = parts
                    .iter()
                    .filter(|p| p["type"] == "text")
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("");
                out.push(Message::system(text));
            }
            "user" => {
                let content: Vec<UserContent> = parts
                    .iter()
                    .filter(|p| p["type"] == "text")
                    .filter_map(|p| p["text"].as_str())
                    .map(UserContent::text)
                    .collect();
                out.push(Message::User { content });
            }
            "assistant" => {
                // Split parts into step blocks on `step-start`, then process
                // each block exactly like the SDK's processBlock.
                let mut block: Vec<Value> = Vec::new();
                let flush = |block: &mut Vec<Value>, out: &mut Vec<Message>| {
                    if block.is_empty() {
                        return;
                    }
                    let mut content: Vec<AssistantContent> = Vec::new();
                    let mut results: Vec<UserContent> = Vec::new();
                    for part in block.iter() {
                        match part["type"].as_str().unwrap_or_default() {
                            "text" => {
                                let text = part["text"].as_str().unwrap_or_default();
                                content.push(AssistantContent::text(text));
                            }
                            t if t.starts_with("tool-") => {
                                let state = part["state"].as_str().unwrap_or_default();
                                if state == "input-streaming" {
                                    continue; // no call id/input to replay
                                }
                                let Some(tool_name) = tool_part_name(part) else {
                                    continue;
                                };
                                let call_id = part["toolCallId"].as_str().unwrap_or_default();
                                let input = part["input"].clone();
                                content.push(AssistantContent::tool_call(
                                    call_id,
                                    tool_name,
                                    input,
                                ));
                                match state {
                                    "output-available" => {
                                        let output = &part["output"];
                                        let result = match output.as_str() {
                                            Some(s) => ToolResultContent::text(s),
                                            None => ToolResultContent::Json {
                                                value: output.clone(),
                                            },
                                        };
                                        results.push(UserContent::tool_result(
                                            call_id,
                                            tool_name,
                                            vec![result],
                                        ));
                                    }
                                    "output-error" => {
                                        let error = part["errorText"]
                                            .as_str()
                                            .unwrap_or("tool execution failed");
                                        results.push(UserContent::tool_result(
                                            call_id,
                                            tool_name,
                                            vec![ToolResultContent::text(error)],
                                        ));
                                    }
                                    _ => {} // input-available: call replays with no result (SDK parity)
                                }
                            }
                            // step-start / reasoning / data parts don't enter blocks.
                            _ => {}
                        }
                    }
                    out.push(Message::Assistant { id: None, content });
                    if !results.is_empty() {
                        out.push(Message::User { content: results });
                    }
                    block.clear();
                };
                for part in parts {
                    if part["type"] == "step-start" {
                        flush(&mut block, &mut out);
                    } else {
                        block.push(part);
                    }
                }
                flush(&mut block, &mut out);
            }
            _ => {
                // The SDK throws on unsupported roles; the transport's
                // messages only ever carry user/assistant (the UI owns the
                // transcript), so skipping instead of failing keeps one
                // odd persisted row from wedging the whole chat.
                log::warn!("convert: skipping unsupported role '{role}'");
            }
        }
    }
    out
}

// ============================================================================
// contextCharsOf port (src/lib/contextUsage.ts)
// ============================================================================

/// Length of a JSON-ish value without throwing (serde cannot fail on Values,
/// so this is just the serialized length — JS's stringify falls back on
/// cycles, which cannot occur in parsed JSON).
fn json_chars(value: &Value) -> usize {
    serde_json::to_string(value).map(|s| s.chars().count()).unwrap_or(0)
}

/// Visible char size of one message: text parts + tool inputs/outputs.
pub(crate) fn message_chars(message: &Value) -> usize {
    let mut n = 0;
    for p in message["parts"].as_array().unwrap_or(&Vec::new()) {
        match p["type"].as_str().unwrap_or_default() {
            "text" => n += p["text"].as_str().unwrap_or_default().chars().count(),
            t if t.starts_with("tool-") => {
                if !p["input"].is_null() {
                    n += json_chars(&p["input"]);
                }
                if !p["output"].is_null() {
                    n += json_chars(&p["output"]);
                }
            }
            _ => {}
        }
    }
    n
}

/// Char size of what the model is sent: `system_prompt` (already containing
/// the compaction summary when one exists) plus the visible content of
/// `messages` (already filtered through compaction by the caller).
pub(crate) fn context_chars_of(messages: &[Value], system_prompt: &str) -> usize {
    let mut n = system_prompt.chars().count();
    for m in messages {
        n += message_chars(m);
    }
    n
}

// ============================================================================
// normalizeUsage port (src/lib/agent-events.ts)
// ============================================================================

/// Normalize one finished step's usage (rig's normalized token counts plus
/// the OpenRouter per-call charge extracted from the terminal record's raw
/// usage) into the UI's `Usage` JSON:
///
/// ```json
/// {"promptTokens":n,"completionTokens":n,"totalTokens":n,
///  "cachedTokens":n?,"cost":n?}
/// ```
///
/// `cachedTokens`/`cost` are omitted when not reported (never 0-filled) so
/// the UI's cache-rate denominator and spend gate stay honest.
pub(crate) fn normalize_usage(usage: &rig::completion::Usage, cost: Option<f64>) -> Value {
    let prompt = usage.input_tokens;
    let completion = usage.output_tokens;
    let total = if usage.total_tokens > 0 {
        usage.total_tokens
    } else {
        prompt + completion
    };
    let mut out = json!({
        "promptTokens": prompt,
        "completionTokens": completion,
        "totalTokens": total,
    });
    let obj = out.as_object_mut().expect("usage json is an object");
    if usage.cached_input_tokens > 0 {
        obj.insert("cachedTokens".into(), json!(usage.cached_input_tokens));
    }
    if let Some(cost) = cost.filter(|c| *c > 0.0) {
        obj.insert("cost".into(), json!(cost));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn user_message_roundtrip_into_rig() {
        let ui = vec![user_message("hello"), user_message("world")];
        let msgs = ui_to_rig_messages(&ui);
        assert_eq!(msgs.len(), 2);
        assert!(matches!(&msgs[0], Message::User { content } if content.len() == 1));
    }

    #[test]
    fn assistant_tool_blocks_split_like_convert_to_model_messages() {
        let ui = vec![json!({
            "id": "a1",
            "role": "assistant",
            "parts": [
                {"type": "step-start"},
                {"type": "text", "text": "thinking", "state": "done"},
                {"type": "tool-bash", "toolCallId": "c1", "state": "output-available",
                 "input": {"command": "ls"}, "output": {"stdout": "x", "stderr": "", "exit_code": 0}},
                {"type": "step-start"},
                {"type": "text", "text": "final", "state": "done"}
            ]
        })];
        let msgs = ui_to_rig_messages(&ui);
        // Step 1 → assistant(text+call) + user(tool result); step 2 → assistant(text).
        assert_eq!(msgs.len(), 3);
        match &msgs[0] {
            Message::Assistant { content, .. } => {
                assert_eq!(content.len(), 2);
                assert!(matches!(&content[0], AssistantContent::Text(_)));
                assert!(matches!(&content[1], AssistantContent::ToolCall(c)
                    if c.function.name == "bash" && c.function.arguments["command"] == "ls"));
            }
            other => panic!("expected assistant, got {other:?}"),
        }
        match &msgs[1] {
            Message::User { content } => match &content[0] {
                UserContent::ToolResult(r) => {
                    assert_eq!(r.name, "bash");
                    // Object output → JSON content.
                    assert!(matches!(&r.content[0], ToolResultContent::Json { value }
                        if value["stdout"] == "x"));
                }
                other => panic!("expected tool result, got {other:?}"),
            },
            other => panic!("expected user, got {other:?}"),
        }
        match &msgs[2] {
            Message::Assistant { content, .. } => {
                assert!(matches!(&content[0], AssistantContent::Text(t) if t.text == "final"));
            }
            other => panic!("expected assistant, got {other:?}"),
        }
    }

    #[test]
    fn string_tool_output_maps_to_text_content() {
        let ui = vec![json!({
            "id": "a1", "role": "assistant",
            "parts": [
                {"type": "tool-read_file", "toolCallId": "c1", "state": "output-available",
                 "input": {"path": "x.md"}, "output": "file body"}
            ]
        })];
        let msgs = ui_to_rig_messages(&ui);
        assert_eq!(msgs.len(), 2);
        match &msgs[1] {
            Message::User { content } => match &content[0] {
                UserContent::ToolResult(r) => {
                    assert!(matches!(&r.content[0], ToolResultContent::Text(t) if t.text == "file body"));
                }
                other => panic!("expected tool result, got {other:?}"),
            },
            other => panic!("expected user, got {other:?}"),
        }
    }

    #[test]
    fn error_tool_output_maps_to_error_text() {
        let ui = vec![json!({
            "id": "a1", "role": "assistant",
            "parts": [
                {"type": "tool-edit_file", "toolCallId": "c1", "state": "output-error",
                 "input": {"path": "x"}, "errorText": "old_string not found"}
            ]
        })];
        let msgs = ui_to_rig_messages(&ui);
        match &msgs[1] {
            Message::User { content } => match &content[0] {
                UserContent::ToolResult(r) => {
                    assert!(matches!(&r.content[0], ToolResultContent::Text(t)
                        if t.text == "old_string not found"));
                }
                other => panic!("expected tool result, got {other:?}"),
            },
            other => panic!("expected user, got {other:?}"),
        }
    }

    #[test]
    fn context_chars_counts_text_and_tool_json() {
        let msgs = vec![
            user_message("hello"), // 5
            json!({
                "id": "a", "role": "assistant",
                "parts": [
                    {"type": "text", "text": "abc", "state": "done"}, // 3
                    {"type": "tool-bash", "toolCallId": "c", "state": "output-available",
                     "input": {"command": "ls"}, "output": {"exit_code": 0}}
                ]
            }),
        ];
        // json!({"command":"ls"}) serializes to `{"command":"ls"}` = 16 chars;
        // json!({"exit_code":0}) = 15 chars.
        let n = context_chars_of(&msgs, "SYS");
        assert_eq!(n, 3 + 5 + 3 + 16 + 15);
    }

    #[test]
    fn normalize_usage_shape_and_gating() {
        let u = rig::completion::Usage {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            cached_input_tokens: 64,
            ..rig::completion::Usage::new()
        };
        let v = normalize_usage(&u, Some(0.0012));
        assert_eq!(v["promptTokens"], 100);
        assert_eq!(v["completionTokens"], 20);
        assert_eq!(v["totalTokens"], 120);
        assert_eq!(v["cachedTokens"], 64);
        assert_eq!(v["cost"], 0.0012);

        // No cache / no cost → fields omitted, total falls back to the sum.
        let u = rig::completion::Usage {
            input_tokens: 10,
            output_tokens: 5,
            ..rig::completion::Usage::new()
        };
        let v = normalize_usage(&u, None);
        assert!(v.get("cachedTokens").is_none());
        assert!(v.get("cost").is_none());
        assert_eq!(v["totalTokens"], 15);

        // Zero cost is not reported (matches `num()` rejecting falsy-ish).
        let v = normalize_usage(&u, Some(0.0));
        assert!(v.get("cost").is_none());
    }
}
