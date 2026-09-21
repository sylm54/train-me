//! Agent tool definitions + dispatch (port of `src/lib/tools.ts` and the
//! `spawn_agent` tool from `src/lib/subagents.ts`).
//!
//! The JS tools wrap Tauri commands (`exec_bash`, `read_data_file`, …); this
//! port calls the SAME backend bodies directly (the free `*_under` helpers
//! in `bash.rs`, the sandbox via managed state, `validators::validate_report`)
//! so there is one implementation of each behavior on both call paths.
//!
//! FIDELITY CONTRACT: descriptions, input schemas, and result shapes are
//! copied verbatim from the TS sources. The LLM has been trained (prompted)
//! against those exact strings and shapes — changing a wording or a result
//! field changes model behavior, so treat the constants below as data, not
//! prose. Two known JS quirks are preserved deliberately:
//!   - `list_files` renders directory entries as `  - [DIR]` (no path!) and
//!     `  - [FILE]<path>` (no space),
//!   - `write_file.bytes` counts characters (the JS `content.length`),
//!     while `edit_file.bytes` counts UTF-8 bytes (the Rust command's
//!     `.len()`), exactly as today.
//!
//! Tool execution is async, tokio-friendly, and safe to run concurrently
//! (the bash sandbox serializes internally; file ops are independent).

use rig_core as rig;
use serde_json::{json, Value};

use crate::agent::questions;
use crate::agent::runner::CancelHandle;
use crate::bash;
use crate::settings::AgentSettings;

/// Thresholds for large file handling (exported from tools.ts).
pub(crate) const LARGE_FILE_LINE_THRESHOLD: usize = 200;
pub(crate) const LARGE_FILE_BYTE_THRESHOLD: usize = 50000;
pub(crate) const READ_HEAD_LINES: usize = 50;

// ============================================================================
// Tool context
// ============================================================================

/// Everything a tool execution may need: the runtime environment (the live
/// app handle when this process has one — `None` in Stage 5b's headless
/// cold-start runs, where event emission, the question UI and the
/// foreground-service pin are unavailable and the tools that need them
/// degrade, see each arm), the app state snapshot (managed state in live
/// runs, a locally built equivalent in headless runs — dirs + bash sandbox),
/// the run's settings snapshot, the chat the run belongs to, and the run's
/// cancel handle (only `ask_question` listens to it).
pub struct ToolCtx<'a> {
    pub app: Option<&'a tauri::AppHandle>,
    pub state: &'a crate::AppState,
    pub settings: &'a AgentSettings,
    pub chat_id: &'a str,
    pub cancel: &'a CancelHandle,
}

// ============================================================================
// Text-shaping helpers (shared with prompts.rs, same as tools.ts)
// ============================================================================

/// Extract markdown headings with line numbers for display.
pub(crate) fn get_markdown_headings_summary(content: &str) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut headings: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let line = line.trim();
        if line.is_empty() || !line.starts_with('#') {
            continue;
        }
        headings.push(format!("  L{}: {}", i + 1, line));
    }
    if headings.is_empty() {
        return "[No Markdown headings found.]".to_string();
    }
    format!("\n[Headings:]\n{}\n[End of headings.]", headings.join("\n"))
}

/// For files read via the `read_file` tool that are large (by line count):
/// the beginning of the file, total line count, and (for .md) a headings
/// summary — the exact wording of tools.ts's read_file large-file branch.
pub(crate) fn large_file_head(content: &str, path: &str, total_lines: usize) -> String {
    large_file_head_with_note(
        content,
        path,
        total_lines,
        "\n[Use start_line and end_line to read specific portions.]",
    )
}

/// Same shape but with the `{{include}}` wording from prompts.ts (which
/// points at the tool by name — the two callers differ, port each exactly).
pub(crate) fn large_file_head_include(content: &str, path: &str, total_lines: usize) -> String {
    large_file_head_with_note(
        content,
        path,
        total_lines,
        "\n[Use the read_file tool with start_line and end_line to read specific portions of this file.]",
    )
}

fn large_file_head_with_note(content: &str, path: &str, total_lines: usize, note: &str) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let head = lines[..READ_HEAD_LINES.min(lines.len())].join("\n");
    let mut msg = format!(
        "\n\n[File is large: {total_lines} lines. Showing first {READ_HEAD_LINES} lines.]"
    );
    msg.push_str(note);
    if path.ends_with(".md") {
        msg.push_str(&get_markdown_headings_summary(content));
    }
    head + &msg
}

// ============================================================================
// Tool descriptions (verbatim from tools.ts / subagents.ts)
// ============================================================================

const BASH_DESC: &str = "Execute a bash command. Files created or modified are persisted to disk. Output is captured (stdout, stderr, exit code). ";
const READ_FILE_DESC: &str = "Read a file. Path is relative to the agent's data directory, or sandbox-absolute (leading slash, as `ls`/bash print it). Both resolve to the same on-disk root the other tools and bash use. For large files the first portion and a summary are returned; use start_line and end_line (1-based, inclusive) to read specific portions.";
const WRITE_FILE_DESC: &str = "Write a text file. Parent directories are created automatically.";
const LIST_FILES_DESC: &str = "List entries in a directory";
const EDIT_FILE_DESC: &str = "Edit an existing file by search-and-replace. Provide `old_string` exactly as it appears in the file (include surrounding context to make it unique) and `new_string` to replace it with. By default `old_string` must match exactly once; set `replace_all` to true to substitute every occurrence.";
const VALIDATE_FILES_DESC: &str = "Validate feature files for parse errors, schema problems, and dangling references. Checks routines/*.md (pages, feature blocks, actions), habits/*.md, tasks/*.md, and store/*.json, plus every XML script they reference (audio features and script actions: tag syntax, semantic tag checks, and <include> import validity — dangling and circular includes are errors), and any in-app markdown links they contain. Returns a per-file report; each problem says what is wrong and, when possible, how to fix it. XML scripts under hypnos/ that no feature file references are reported as a warning (still linted). Optional `path` narrows the scope to files at or under that path (relative to agent_data/, forward slashes) — e.g. 'routines', 'routines/foo.md', or 'hypnos'. Scoping a container still pulls in its full XML include tree. Omit `path` to validate everything. Call after creating/editing files, or when something isn't working, and fix any reported errors before considering the task done.";
const ASK_QUESTION_DESC: &str = "Ask the user a question and wait for their answer. Use this whenever you need information, a decision, a preference, or feedback before proceeding — prefer it over guessing when the user's intent, preference, or consent is unclear. The call blocks until the user answers or cancels. Four types: 'open' (a free-text answer), 'single-choice' (pick exactly one option from `choices`), 'multi-choice' (pick one or more options from `choices`), and 'rating' (a whole number 1–10, where 1 is low and 10 is high). Prefer 'single-choice' when one option must win; use 'multi-choice' only when selecting several is meaningful.";
const SPAWN_AGENT_DESC: &str = "Spawn a fresh copy of yourself with a clean context to complete a self-contained task. The copy runs your same system prompt and tools (except this one) with the task as its only input; only its final text comes back to you — it cannot see this conversation, and the user does not see its work. Use this for substantial, separable authoring jobs (e.g. writing or reworking audio scripts, building a set of feature files) where a clean slate with the reference docs at the front of context produces better work than tacking it onto this chat. For small fixes, do them directly. Provide a fully self-contained brief — include the goal, relevant paths and context, and any constraints; assume the copy reads no part of this chat.";

// ============================================================================
// Tool definitions (rig ToolDefinition = name + description + JSON schema;
// the schemas mirror the zod inputSchemas field-for-field)
// ============================================================================

/// One tool's definition, factored so main/spawned toolsets share entries.
struct ToolSpec {
    name: &'static str,
    description: &'static str,
    parameters: Value,
}

impl ToolSpec {
    fn to_definition(&self) -> rig::completion::ToolDefinition {
        rig::completion::ToolDefinition {
            name: self.name.to_string(),
            description: self.description.to_string(),
            parameters: self.parameters.clone(),
        }
    }
}

fn bash_spec() -> ToolSpec {
    ToolSpec {
        name: "bash",
        description: BASH_DESC,
        parameters: json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The bash script to execute. May be multi-line (e.g. pipelines, for-loops, function definitions)."
                }
            },
            "required": ["command"],
            "additionalProperties": false
        }),
    }
}

fn read_file_spec() -> ToolSpec {
    ToolSpec {
        name: "read_file",
        description: READ_FILE_DESC,
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path." },
                "start_line": { "type": "integer", "minimum": 1, "description": "Start line (1-based)." },
                "end_line": { "type": "integer", "minimum": 1, "description": "End line (1-based, inclusive)." }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
    }
}

fn write_file_spec() -> ToolSpec {
    ToolSpec {
        name: "write_file",
        description: WRITE_FILE_DESC,
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path." },
                "content": { "type": "string", "description": "The text content to write." }
            },
            "required": ["path", "content"],
            "additionalProperties": false
        }),
    }
}

fn list_files_spec() -> ToolSpec {
    ToolSpec {
        name: "list_files",
        description: LIST_FILES_DESC,
        parameters: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "default": ".",
                    "description": "Directory path, relative to the data directory or sandbox-absolute (leading slash). Use '.' for the root."
                }
            },
            "required": [],
            "additionalProperties": false
        }),
    }
}

fn edit_file_spec() -> ToolSpec {
    ToolSpec {
        name: "edit_file",
        description: EDIT_FILE_DESC,
        parameters: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File path, relative to the data directory or sandbox-absolute (leading slash, as bash prints it)."
                },
                "old_string": {
                    "type": "string",
                    "description": "The exact text to find. Must be unique in the file unless replace_all is true."
                },
                "new_string": { "type": "string", "description": "The text to replace it with." },
                "replace_all": {
                    "type": "boolean",
                    "default": false,
                    "description": "If true, replace every occurrence of old_string."
                }
            },
            "required": ["path", "old_string", "new_string"],
            "additionalProperties": false
        }),
    }
}

fn validate_files_spec() -> ToolSpec {
    ToolSpec {
        name: "validate_files",
        description: VALIDATE_FILES_DESC,
        parameters: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Optional scope: only validate files at or under this path (relative to agent_data/, forward slashes). e.g. 'routines', 'routines/foo.md', 'hypnos'. Omit to validate all feature files."
                }
            },
            "required": [],
            "additionalProperties": false
        }),
    }
}

fn ask_question_spec() -> ToolSpec {
    ToolSpec {
        name: "ask_question",
        description: ASK_QUESTION_DESC,
        parameters: json!({
            "type": "object",
            "properties": {
                "type": {
                    "type": "string",
                    "enum": ["open", "single-choice", "multi-choice", "rating"],
                    "description": "Question type: 'open' (free text), 'single-choice' (pick exactly one of `choices`), 'multi-choice' (pick one or more of `choices`), or 'rating' (a whole number 1–10)."
                },
                "question": {
                    "type": "string",
                    "description": "The question to ask the user. Phrase it so they can answer directly."
                },
                "choices": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Required for 'single-choice' and 'multi-choice': two or more options the user picks from. Omit for 'open' and 'rating'."
                },
                "hint": {
                    "type": "string",
                    "description": "Optional short hint shown to the user (e.g. an example answer or extra context)."
                }
            },
            "required": ["type", "question"],
            "additionalProperties": false
        }),
    }
}

fn spawn_agent_spec() -> ToolSpec {
    ToolSpec {
        name: "spawn_agent",
        description: SPAWN_AGENT_DESC,
        parameters: json!({
            "type": "object",
            "properties": {
                "label": {
                    "type": "string",
                    "description": "Short name for what this copy is working on (a few words, e.g. 'evening audio script' or 'habit feature files'). Shown to the user on the progress feed while the copy runs."
                },
                "task": {
                    "type": "string",
                    "description": "A self-contained brief for the copy. Include what to create or change, the files/docs to draw on, desired tone/format, and any other context the copy would need. Do not assume the copy sees this chat — include all relevant detail."
                }
            },
            "required": ["label", "task"],
            "additionalProperties": false
        }),
    }
}

/// The main agent's toolset: the base tools plus `spawn_agent` (JS
/// `MAIN_AGENT_TOOLS` + `buildSpawnAgentTool`).
pub(crate) fn main_tool_defs() -> Vec<rig::completion::ToolDefinition> {
    [
        bash_spec(),
        read_file_spec(),
        write_file_spec(),
        edit_file_spec(),
        list_files_spec(),
        validate_files_spec(),
        ask_question_spec(),
        spawn_agent_spec(),
    ]
    .iter()
    .map(ToolSpec::to_definition)
    .collect()
}

/// The spawned copy's toolset: file/inspection tools minus `ask_question`
/// (a background copy asking would block forever) and minus `spawn_agent`
/// (structural recursion cap) — `buildSpawnedTools`.
pub(crate) fn spawned_tool_defs() -> Vec<rig::completion::ToolDefinition> {
    [
        bash_spec(),
        read_file_spec(),
        write_file_spec(),
        edit_file_spec(),
        list_files_spec(),
        validate_files_spec(),
    ]
    .iter()
    .map(ToolSpec::to_definition)
    .collect()
}

// ============================================================================
// Dispatch
// ============================================================================

/// Execute one tool call. `Ok` serializes into the tool part's `output`
/// (`tool-output-available`); `Err` becomes a tool error (the JS tools
/// reject on the same conditions — command rejections — and the SDK turns
/// those into `output-error` parts).
pub(crate) fn execute<'a>(
    ctx: &'a ToolCtx<'a>,
    name: &'a str,
    args: &'a Value,
) -> futures::future::BoxFuture<'a, Result<Value, String>> {
    // Boxing note: `spawn_agent` recurses into this dispatcher (a copy runs
    // its tools through the same `execute`), so the future must be boxed or
    // the compiler sees infinite monomorphic recursion.
    Box::pin(execute_inner(ctx, name, args))
}

async fn execute_inner(ctx: &ToolCtx<'_>, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "bash" => bash(ctx, args).await,
        "read_file" => read_file(ctx, args),
        "write_file" => write_file(ctx, args),
        "edit_file" => edit_file(ctx, args),
        "list_files" => list_files(ctx, args),
        "validate_files" => validate_files(ctx, args).await,
        "ask_question" => ask_question(ctx, args).await,
        "spawn_agent" => spawn_agent(ctx, args).await,
        other => Err(format!("unknown tool: {other}")),
    }
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args[key].as_str()
}

fn arg_u64(args: &Value, key: &str) -> Option<u64> {
    args[key].as_u64()
}

async fn bash(ctx: &ToolCtx<'_>, args: &Value) -> Result<Value, String> {
    let command = arg_str(args, "command").ok_or("bash: missing `command`")?;
    let result = ctx.state.bash.exec(command).await?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

fn read_file(ctx: &ToolCtx<'_>, args: &Value) -> Result<Value, String> {
    let path = arg_str(args, "path").ok_or("read_file: missing `path`")?;
    let start_line = arg_u64(args, "start_line");
    let end_line = arg_u64(args, "end_line");
    let result = bash::read_file_under(&ctx.state.agent_dir, path)?;
    let lines: Vec<&str> = result.split('\n').collect();
    let total_lines = lines.len();

    // If a specific range is requested, return just those lines. The JS
    // guards are truthiness checks (`start_line ? … : 0`), so a 0 behaves
    // like an absent value.
    if start_line.is_some() || end_line.is_some() {
        let start = start_line
            .filter(|s| *s >= 1)
            .map(|s| (s - 1) as usize)
            .unwrap_or(0);
        let end = end_line
            .filter(|e| *e >= 1)
            .map(|e| (e as usize).min(total_lines))
            .unwrap_or(total_lines);
        let start = start.min(total_lines);
        let end = end.clamp(start, total_lines);
        let selected = lines[start..end].join("\n");
        return Ok(Value::String(selected));
    }

    // If the file is small enough, return it in full.
    if total_lines <= LARGE_FILE_LINE_THRESHOLD {
        return Ok(Value::String(result));
    }

    // Large file: return head + summary (+ headings for .md).
    Ok(Value::String(large_file_head(&result, path, total_lines)))
}

fn write_file(ctx: &ToolCtx<'_>, args: &Value) -> Result<Value, String> {
    let path = arg_str(args, "path").ok_or("write_file: missing `path`")?;
    let content = arg_str(args, "content").ok_or("write_file: missing `content`")?;
    bash::write_file_under(&ctx.state.agent_dir, path, content)?;
    let lines = content.split('\n').count();
    let mut result = json!({ "ok": true, "path": path, "bytes": content.chars().count() });
    if lines > LARGE_FILE_LINE_THRESHOLD {
        result["warning"] = json!(format!(
            "Warning: File has {lines} lines (>{LARGE_FILE_LINE_THRESHOLD}). Large files consume context and may not be read back in full."
        ));
    }
    Ok(result)
}

fn edit_file(ctx: &ToolCtx<'_>, args: &Value) -> Result<Value, String> {
    let path = arg_str(args, "path").ok_or("edit_file: missing `path`")?;
    let old_string = arg_str(args, "old_string").ok_or("edit_file: missing `old_string`")?;
    let new_string = arg_str(args, "new_string").ok_or("edit_file: missing `new_string`")?;
    let replace_all = args["replace_all"].as_bool();
    let result = bash::edit_file_under(&ctx.state.agent_dir, path, old_string, new_string, replace_all)?;
    let mut enhanced = serde_json::to_value(&result).map_err(|e| e.to_string())?;
    if result.bytes > LARGE_FILE_BYTE_THRESHOLD {
        let estimated_lines = (result.bytes as f64 / 80.0).round() as i64;
        enhanced["warning"] = json!(format!(
            "Warning: File is ~{} bytes (~{estimated_lines} lines). Large files consume context and may not be read back in full.",
            result.bytes
        ));
    }
    Ok(enhanced)
}

fn list_files(ctx: &ToolCtx<'_>, args: &Value) -> Result<Value, String> {
    let path = arg_str(args, "path").unwrap_or(".");
    let entries = bash::list_entries_under(&ctx.state.agent_dir, path)?;
    if entries.is_empty() {
        return Ok(Value::String(format!("No files in directory \"{path}\".")));
    }
    // Preserve the JS rendering exactly: `[DIR]` entries carry no path;
    // `[FILE]` entries are `[FILE]` + path with no separating space.
    let rendered: Vec<String> = entries
        .iter()
        .map(|e| {
            if e.is_dir {
                "  - [DIR]".to_string()
            } else {
                format!("  - [FILE]{}", e.path)
            }
        })
        .collect();
    Ok(Value::String(format!(
        "Directory \"{path}\" contains:\n{}",
        rendered.join("\n")
    )))
}

async fn validate_files(ctx: &ToolCtx<'_>, args: &Value) -> Result<Value, String> {
    let path = args["path"].as_str().map(str::to_string);
    // The tool passes the state snapshot directly (managed state in live
    // runs, the locally built headless equivalent otherwise) — the report is
    // byte-identical to the command's either way.
    let report = crate::validators::validate_report(path, ctx.state).await;
    serde_json::to_value(report).map_err(|e| e.to_string())
}

async fn ask_question(ctx: &ToolCtx<'_>, args: &Value) -> Result<Value, String> {
    let kind = arg_str(args, "type").ok_or("ask_question: missing `type`")?;
    let question = arg_str(args, "question").ok_or("ask_question: missing `question`")?;
    let choices: Option<Vec<String>> = args["choices"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect());
    let hint = arg_str(args, "hint").map(str::to_string);

    // A choice question is meaningless without options. Don't bother the
    // user — bounce it straight back to the model so it can retry correctly.
    if (kind == "single-choice" || kind == "multi-choice")
        && choices.as_ref().map(|c| c.len()).unwrap_or(0) < 2
    {
        return Ok(json!({
            "ok": false,
            "reason": "A 'single-choice'/'multi-choice' question needs at least two options in `choices`. Retry with `choices` provided, or use type 'open'."
        }));
    }

    // Headless runs (Stage 5b cold-start wakes) have no UI to answer: block
    // would hang the whole wake turn, so degrade to an immediate bounce-back
    // telling the model to continue on its own.
    let Some(app) = ctx.app else {
        return Ok(json!({
            "ok": false,
            "reason": "The app UI is not running right now (scheduled background wake), so the user cannot answer. Do not wait: continue with your best judgement, or state the question in plain text in your final response so the user sees it when they return."
        }));
    };

    // Block until answered. Flip the service notification to "Waiting for
    // your answer" for the wait and back to "Working…" after — a run can ask
    // several questions per turn, so the transition goes both ways.
    crate::agent_service::update_phase("waiting-for-answer", None);
    let result = questions::pose(app, ctx.chat_id, kind, question, choices, hint, ctx.cancel).await;
    crate::agent_service::update_phase("running", None);
    serde_json::to_value(result).map_err(|e| e.to_string())
}

async fn spawn_agent(ctx: &ToolCtx<'_>, args: &Value) -> Result<Value, String> {
    let label = arg_str(args, "label").ok_or("spawn_agent: missing `label`")?;
    let task = arg_str(args, "task").ok_or("spawn_agent: missing `task`")?;
    match crate::agent::subagents::spawn_agent(ctx.app, ctx.state, ctx.settings, Some(label), task)
        .await
    {
        Ok(output) => Ok(json!({ "ok": true, "output": output })),
        Err(msg) => Ok(json!({ "ok": false, "error": msg })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_summary_matches_js() {
        let md = "# Title\n\nintro\n## Section\nnot-heading\n### Deep\n";
        let out = get_markdown_headings_summary(md);
        assert!(out.contains("  L1: # Title"), "{out}");
        assert!(out.contains("  L4: ## Section"), "{out}");
        assert!(out.contains("  L6: ### Deep"), "{out}");
        assert!(out.starts_with("\n[Headings:]"));
        assert!(out.ends_with("[End of headings.]"));
        assert_eq!(get_markdown_headings_summary("no headings"), "[No Markdown headings found.]");
    }

    #[test]
    fn large_file_head_matches_tools_ts_wording() {
        let content: String = (0..300).map(|i| format!("line {i}\n")).collect();
        let out = large_file_head(&content, "notes.txt", 300);
        assert!(out.starts_with("line 0\n"));
        assert!(out.contains("\n\n[File is large: 300 lines. Showing first 50 lines.]"));
        assert!(out.contains("\n[Use start_line and end_line to read specific portions.]"));
        // .md files get the headings summary appended (a heading-less file
        // still gets the "[No Markdown headings found.]" marker, JS parity).
        let out = large_file_head(&content, "doc.md", 300);
        assert!(out.contains("[No Markdown headings found.]"));
    }

    #[test]
    fn main_and_spawned_toolsets_match_js() {
        let main = main_tool_defs();
        let names: Vec<&str> = main.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "bash", "read_file", "write_file", "edit_file", "list_files",
                "validate_files", "ask_question", "spawn_agent"
            ]
        );
        let spawned = spawned_tool_defs();
        let spawned_names: Vec<&str> = spawned.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(
            spawned_names,
            vec!["bash", "read_file", "write_file", "edit_file", "list_files", "validate_files"]
        );
        // No tool may mention spawn in the spawned set (structural depth cap).
        assert!(!spawned_names.contains(&"spawn_agent"));
    }

    #[test]
    fn descriptions_carry_key_phrases() {
        // Spot-check the fidelity-critical phrasings survive intact.
        assert!(BASH_DESC.ends_with("(stdout, stderr, exit code). "));
        assert!(READ_FILE_DESC.contains("sandbox-absolute"));
        assert!(VALIDATE_FILES_DESC.contains("dangling and circular includes are errors"));
        assert!(ASK_QUESTION_DESC.contains("1–10"));
        assert!(SPAWN_AGENT_DESC.contains("assume the copy reads no part of this chat"));
    }

    #[test]
    fn schemas_have_required_arrays_and_descriptions() {
        for def in main_tool_defs() {
            assert!(def.parameters["properties"].is_object(), "{}", def.name);
            assert!(def.parameters["required"].is_array(), "{}", def.name);
            assert!(!def.description.is_empty());
        }
        let read = main_tool_defs().into_iter().find(|t| t.name == "read_file").unwrap();
        assert_eq!(read.parameters["required"], json!(["path"]));
        assert!(read.parameters["properties"]["start_line"]["description"].is_string());
    }
}
