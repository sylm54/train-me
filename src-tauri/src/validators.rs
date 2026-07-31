//! Feature-file validator.
//!
//! The agent manages several kinds of user-facing feature files under
//! `agent_data/`:
//!
//!   - `routines/*.md`         (frontmatter `schedule` cron + markdown body)
//!   - `rule/*.md`             (free-form markdown)
//!   - `conditioning/*.json`   (TTS metadata sidecar)
//!   - `journal/format.json`   (journal field definitions)
//!   - `voice/config.json`     (voice-training tracker config)
//!
//! Most of these are parsed leniently at runtime: a bad cron silently
//! never schedules, an unknown tracker id is dropped, a dangling in-app
//! link goes nowhere — with no error surfaced to the user or the agent.
//!
//! `validate_data_files` walks every known feature file, parses it the
//! same way the app does, and returns a structured report of what's wrong
//! and how to fix it, so the agent can self-correct after creating or
//! editing files. It is read-only: it never writes.
//!
//! The parsing rules below deliberately mirror the frontend parsers
//! (see `JournalView`, `ConditioningView`, `RoutinesView`, `RulesView`,
//! `voice/config.ts`, `voice/registry.ts`, `links.ts`) so the validator's
//! verdict matches what actually happens at runtime.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::AppState;

// ============================================================================
// Report types
// ============================================================================

/// One logical problem with a file.
#[derive(Serialize, Clone, Debug)]
pub struct Problem {
    /// `"warning"` or `"error"`. Errors mean the file won't work as the
    /// feature expects; warnings are things that parse but likely aren't
    /// intended.
    pub severity: String,
    /// Human-readable explanation of what's wrong.
    pub message: String,
    /// Concrete suggested fix, when one can be machine-derived
    /// (e.g. a corrected cron string or a path to create).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

/// Validation result for a single file.
#[derive(Serialize, Clone, Debug)]
pub struct FileReport {
    /// Path relative to `agent_data/`, forward-slashed.
    pub path: String,
    /// `"ok"`, `"warning"`, or `"error"`. Roll-up of `problems`.
    pub status: String,
    pub problems: Vec<Problem>,
}

/// Top-level report returned by `validate_data_files`.
#[derive(Serialize, Clone, Debug)]
pub struct ValidateReport {
    pub files: Vec<FileReport>,
    pub checked: usize,
    pub errors: usize,
    pub warnings: usize,
}

impl FileReport {
    fn new(path: impl Into<String>) -> Self {
        FileReport {
            path: path.into(),
            status: "ok".to_string(),
            problems: Vec::new(),
        }
    }

    fn push(&mut self, p: Problem) {
        if p.severity == "error" {
            self.status = "error".to_string();
        } else if self.status != "error" {
            self.status = "warning".to_string();
        }
        self.problems.push(p);
    }
}

fn err(message: impl Into<String>) -> Problem {
    Problem {
        severity: "error".to_string(),
        message: message.into(),
        fix: None,
    }
}
fn warn(message: impl Into<String>) -> Problem {
    Problem {
        severity: "warning".to_string(),
        message: message.into(),
        fix: None,
    }
}

// ============================================================================
// Cron normalization (shared with next_cron_times via lib.rs)
// ============================================================================

/// Normalize a cron expression to the form the `cron` crate accepts.
///
/// The `cron` 0.16 crate requires 6 or 7 fields
/// (`sec min hour dom month dow [year]`), but the documented + example
/// form in this app is classic 5-field (`min hour dom month dow`). To keep
/// 5-field cron both *valid* (per the user's chosen contract) and
/// *functional* (so notifications actually fire), we prepend a `0` seconds
/// field to any 5-field expression. `@`-shorthands and 6/7-field
/// expressions are passed through unchanged.
pub fn normalize_cron(expr: &str) -> String {
    let trimmed = expr.trim();
    if trimmed.starts_with('@') {
        return trimmed.to_string();
    }
    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    match fields.len() {
        5 => format!("0 {}", trimmed),
        _ => trimmed.to_string(),
    }
}

/// Validate a cron expression after normalization. Returns a `Problem`
/// describing the field-count/range error, or `Ok(())` if it parses.
fn validate_cron(raw: &str) -> Result<(), String> {
    use cron::Schedule as CronSchedule;
    use std::str::FromStr;

    let normalized = normalize_cron(raw);
    let normalized_fields = normalized.split_whitespace().count();

    match CronSchedule::from_str(&normalized) {
        Ok(_) => Ok(()),
        Err(_) => {
            // The crate's error is opaque, so produce a human-facing hint.
            let raw_fields = raw.trim().split_whitespace().count();
            let hint = match raw_fields {
                0 => "schedule is empty".to_string(),
                1..=4 => format!(
                    "schedule has {raw_fields} field{}; cron needs 5 (min hour dom month dow) \
                     or 6 (sec min hour dom month dow)",
                    if raw_fields == 1 { "" } else { "s" }
                ),
                5 => "schedule has 5 fields but still failed to parse; \
                     check ranges (min 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-6/1-7)"
                    .to_string(),
                _ => format!(
                    "schedule has {raw_fields} fields; check ranges \
                     (sec 0-59, min 0-59, hour 0-23, dom 1-31, month 1-12, dow 1-7)"
                ),
            };
            let _ = normalized_fields; // kept for future debugging
            Err(hint)
        }
    }
}

// ============================================================================
// Frontmatter parsing (mirrors RoutinesView.parseFrontmatter)
// ============================================================================

/// Extract the YAML-ish frontmatter block and body. Mirrors the frontend
/// regex `^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$`.
///
/// Returns `(frontmatter, body)`. If no frontmatter block is present,
/// `frontmatter` is empty and `body` is the whole content.
fn split_frontmatter(content: &str) -> (String, String) {
    // Must start at byte 0: a leading line that is `---` (+ optional
    // trailing whitespace), then a newline.
    if !content.starts_with("---") {
        return (String::new(), content.to_string());
    }
    // First line is the opening `---`.
    let after_open = match content.find('\n') {
        Some(i) => &content[i + 1..],
        None => return (String::new(), content.to_string()),
    };
    // The opening line must be only `---` + trailing whitespace.
    let first_line = &content[..content.find('\n').unwrap_or(content.len())];
    if first_line.trim() != "---" {
        return (String::new(), content.to_string());
    }

    // Find the closing `---` line.
    let mut cursor = 0;
    let mut close: Option<usize> = None;
    for line in after_open.split_inclusive('\n') {
        if line.trim_end() == "---" {
            close = Some(cursor);
            break;
        }
        cursor += line.len();
    }
    let Some(close_off) = close else {
        // Unclosed frontmatter: treat as no frontmatter (frontend does too).
        return (String::new(), content.to_string());
    };

    let fm = after_open[..close_off].to_string();
    // Body = everything after the closing `---` line (including its newline).
    let body_start_in_after = close_off + {
        // length of the closing line including its trailing newline
        let rest = &after_open[close_off..];
        rest.find('\n').map(|i| i + 1).unwrap_or(rest.len())
    };
    let body = after_open[body_start_in_after..].to_string();
    (fm, body)
}

/// Read `schedule:` out of frontmatter the way the frontend does:
/// first line starting with `schedule:`, value = rest of line, trimmed.
fn frontmatter_schedule(fm: &str) -> Option<String> {
    for line in fm.lines() {
        if let Some(rest) = line.strip_prefix("schedule:") {
            let v = rest.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

// ============================================================================
// Markdown link extraction + in-app resolution (mirrors links.ts)
// ============================================================================

/// A markdown link `[text](target)`.
struct MdLink {
    target: String,
}

/// Extract all markdown links from a body. Skips images `![…](…)`.
fn extract_md_links(body: &str) -> Vec<MdLink> {
    let mut links = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            // Skip images: '!' immediately before '['.
            let is_image = i > 0 && bytes[i - 1] == b'!';
            // Find matching ']'.
            if let Some(close_bracket) = find_unescaped(bytes, i + 1, b']') {
                // Next non-space char must be '('.
                let mut j = close_bracket + 1;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b'(' {
                    if let Some(close_paren) = find_unescaped(bytes, j + 1, b')') {
                        let target = &body[j + 1..close_paren];
                        // Strip an optional title, e.g. `(path "title")`.
                        let target_clean = target
                            .split_whitespace()
                            .next()
                            .unwrap_or("")
                            .trim();
                        if !is_image && !target_clean.is_empty() {
                            links.push(MdLink {
                                target: target_clean.to_string(),
                            });
                        }
                        i = close_paren + 1;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    links
}

/// Find the next unescaped occurrence of `needle` starting at `from`.
fn find_unescaped(bytes: &[u8], from: usize, needle: u8) -> Option<usize> {
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Returns `Some(relative_path)` if `href` is an in-app link to a file we
/// should existence-check, or `None` if it's external / has no file target
/// (e.g. bare `chastity`, `inventory/…`). Port of `resolveAppPath` from
/// `links.ts`, restricted to file-bearing targets.
fn in_app_link_target(href: &str) -> Option<String> {
    let mut h = href.trim();
    if h.starts_with("./") {
        h = &h[2..];
    }
    // External scheme or protocol-relative.
    let scheme_re = regex::Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:").unwrap();
    if scheme_re.is_match(h) || h.starts_with("//") {
        return None;
    }
    // Strip #fragment.
    if let Some(hash) = h.find('#') {
        h = &h[..hash];
    }
    let h = h.trim();
    if h.is_empty() {
        return None;
    }

    let segs: Vec<&str> = h.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    if segs.is_empty() {
        return None;
    }

    // Bare feature names route to a view but have no file target.
    match h {
        "chastity" | "inventory" | "inventory/items" | "conditioning" | "rules"
        | "rule" | "routines" | "journal" | "voice" => return None,
        _ => {}
    }

    let head = segs[0].to_ascii_lowercase();
    // Map a recognized first segment to the on-disk directory. `rule` is the
    // real dir (singular); `rules/` is accepted as an alias.
    let dir = match head.as_str() {
        "conditioning" => "conditioning",
        "rule" | "rules" => "rule",
        "routines" | "routine" => "routines",
        "journal" => "journal",
        "voice" => "voice",
        // inventory items live in SQLite, not a file → nothing to check.
        "inventory" => return None,
        _ => return None,
    };

    // Need a second segment (the target file) to existence-check.
    if segs.len() < 2 {
        return None;
    }
    Some(format!("{}/{}", dir, segs[1..].join("/")))
}

// ============================================================================
// Per-file-type validators
// ============================================================================

/// `routines/*.md`
fn validate_routine(rel_path: &str, content: &str, agent_dir: &Path) -> FileReport {
    let mut report = FileReport::new(rel_path);

    if !rel_path.to_ascii_lowercase().ends_with(".md") {
        report.push(err("routine files must use the .md extension"));
        return report;
    }

    let (fm, body) = split_frontmatter(content);

    match frontmatter_schedule(&fm) {
        None => report.push(warn(
            "no `schedule:` field in frontmatter — this routine will render but never \
             schedule a notification",
        )),
        Some(schedule) => {
            if let Some(msg) = validate_cron(&schedule).err() {
                report.push(Problem {
                    severity: "error".to_string(),
                    message: format!("invalid cron schedule `{schedule}`: {msg}"),
                    fix: Some(format!(
                        "use 5-field (e.g. `30 2 * * *` = daily at 02:30) or 6-field \
                         (e.g. `0 30 2 * * *`); set `schedule:` in the frontmatter"
                    )),
                });
            }
        }
    }

    check_md_links(&body, agent_dir, &mut report);
    report
}

/// `rule/*.md`
fn validate_rule(rel_path: &str, content: &str, agent_dir: &Path) -> FileReport {
    let mut report = FileReport::new(rel_path);
    if !rel_path.to_ascii_lowercase().ends_with(".md") {
        report.push(err("rule files must use the .md extension"));
        return report;
    }
    // Rules have no required frontmatter; links are still checked.
    check_md_links(content, agent_dir, &mut report);
    report
}

/// `conditioning/*.json`. Returns the JSON metadata report first, followed by
/// one `FileReport` per `.xml` reachable from `script_path` (syntax, semantic,
/// and `<include>` import validity). When the metadata is broken we return
/// just the JSON report — there's no reliable `script_path` to chase.
fn validate_conditioning(rel_path: &str, content: &str, agent_dir: &Path) -> Vec<FileReport> {
    let mut report = FileReport::new(rel_path);
    let parsed: serde_json::Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(e) => {
            report.push(err(format!("invalid JSON: {e}")));
            return vec![report];
        }
    };
    let obj = match parsed.as_object() {
        Some(o) => o,
        None => {
            report.push(err("conditioning metadata must be a JSON object"));
            return vec![report];
        }
    };

    let nonempty_string = |key: &str| -> Option<&str> {
        obj.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty())
    };

    for key in ["title", "description", "script_path"] {
        match nonempty_string(key) {
            None => report.push(err(format!(
                "missing required field `{key}` (must be a non-empty string)"
            ))),
            Some(_) => {}
        }
    }
    match obj.get("tags") {
        None => report.push(err("missing required field `tags`")),
        Some(t) => {
            let arr = t.as_array().ok_or_else(|| {
                report.push(err("`tags` must be an array of strings"));
            });
            if let Ok(arr) = arr {
                if !arr.iter().all(|v| v.is_string()) {
                    report.push(err("`tags` must be an array of strings"));
                }
            }
        }
    }

    // If the metadata is structurally broken (no usable script_path), stop
    // here — `validate_script_tree` would just echo the same missing-script
    // error. Only descend when there's a non-empty script_path.
    let script_path = match nonempty_string("script_path") {
        Some(s) => s,
        None => return vec![report],
    };

    // Validate the referenced XML tree (root + all transitively-included
    // files). `validate_script_tree` itself reports a missing/escaping
    // script_path as an error, so drop the old warning-only existence check.
    let mut reports = vec![report];
    reports.extend(validate_script_tree(script_path, agent_dir));
    reports
}

// ============================================================================
// Conditioning script validation (XML syntax + import validity)
// ============================================================================
//
// `validate_conditioning` above only checks the JSON metadata. The real
// payload is the `.xml` referenced by `script_path`, which composes further
// files via `<include src="...">`. These helpers parse every `.xml` reachable
// from a conditioning entry, run `tag_parser`'s syntax + semantic checks on
// each, and chase `<include>`s transitively to catch:
//
//   - dangling includes  (target doesn't exist / escapes agent_dir)
//   - circular includes  (a file (transitively) includes an ancestor on the
//     current path — distinct from "already fully visited = share, fine")
//   - unparseable included files
//
// The include-resolution rule mirrors the renderer
// (`audio_renderer::AudioRenderer::emit_include`): relative to the including
// script's directory first, then relative to `agent_dir`. Keeping the rule
// identical means the linter's verdict matches what actually renders.

/// Lexically collapse `.`/`..` without requiring the path to exist, then
/// verify the result stays under `root`. Mirrors `bash::resolve_under` but
/// accepts an already-joined absolute path (include srcs are resolved relative
/// to the *including* script's dir, not `agent_dir` directly).
fn normalize_under(root: &Path, joined: &Path) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    for c in joined.components() {
        match c {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    if !normalized.starts_with(root) {
        return Err("path escapes the agent directory".to_string());
    }
    Ok(normalized)
}

/// Resolve a `<include src>` to an absolute path the same way the renderer
/// does: relative to the including script's directory first, then relative to
/// `agent_dir`. Returns `Err` with a message if neither exists or the resolved
/// path escapes `agent_dir` — the caller turns that into a diagnostic.
fn resolve_include(
    src: &str,
    script_dir: &Path,
    agent_dir: &Path,
) -> Result<PathBuf, String> {
    let rel = script_dir.join(src);
    if rel.exists() {
        if let Ok(n) = normalize_under(agent_dir, &rel) {
            return Ok(n);
        }
    }
    let abs = agent_dir.join(src);
    if abs.exists() {
        if let Ok(n) = normalize_under(agent_dir, &abs) {
            return Ok(n);
        }
    }
    Err(format!("include not found: {}", src))
}

/// Convert an absolute path under `agent_dir` back to a forward-slashed,
/// `agent_dir`-relative path for a `FileReport`. Falls back to the absolute
/// display if it isn't under `agent_dir` (shouldn't happen post-`resolve_include`).
fn rel_under(agent_dir: &Path, abs: &Path) -> String {
    abs.strip_prefix(agent_dir)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| abs.to_string_lossy().replace('\\', "/"))
}

/// Validate the full script tree reachable from `script_path` (the
/// `script_path` value from a conditioning JSON, relative to `agent_dir`).
///
/// Returns one `FileReport` per distinct `.xml` file (the root plus every
/// transitively-included file). The root's absence or unparseability is
/// reported on the root's own `FileReport`; dangling/circular/unparseable
/// includes are reported on the file that *contains* the offending
/// `<include>` (so the agent knows which file to fix).
fn validate_script_tree(script_path: &str, agent_dir: &Path) -> Vec<FileReport> {
    use std::collections::{HashMap, HashSet};

    let mut reports: HashMap<PathBuf, FileReport> = HashMap::new();
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let mut on_stack: HashSet<PathBuf> = HashSet::new();

    // Resolve the root script under agent_dir (same containment check as the
    // other data-file commands).
    let root = match crate::bash::resolve_under(agent_dir, script_path) {
        Ok(p) => p,
        Err(msg) => {
            // Path escapes agent_dir or is otherwise invalid — report on the
            // script_path display string since there's no real file.
            let mut r = FileReport::new(script_path);
            r.push(err(format!("`script_path` {msg}")));
            return vec![r];
        }
    };
    if !root.exists() {
        let mut r = FileReport::new(script_path);
        r.push(err(format!(
            "`script_path` points to `{script_path}`, which does not exist"
        )));
        return vec![r];
    }

    walk_script(&root, agent_dir, &mut reports, &mut visited, &mut on_stack);

    // Emit reports in a stable order: by agent_dir-relative path.
    let mut ordered: Vec<FileReport> = reports.into_values().collect();
    ordered.sort_by(|a, b| a.path.cmp(&b.path));
    ordered
}

/// Recursive DFS over the include graph rooted at `abs`.
///
/// State:
/// - `reports` — one entry per visited file (keyed by absolute path).
/// - `visited` — files ever entered (dedup + share).
/// - `on_stack` — files on the current DFS path (true cycle detection).
fn walk_script(
    abs: &Path,
    agent_dir: &Path,
    reports: &mut std::collections::HashMap<PathBuf, FileReport>,
    visited: &mut std::collections::HashSet<PathBuf>,
    on_stack: &mut std::collections::HashSet<PathBuf>,
) {
    // Already fully visited elsewhere in the tree — share, don't re-walk.
    if !visited.insert(abs.to_path_buf()) {
        return;
    }
    on_stack.insert(abs.to_path_buf());

    let rel = rel_under(agent_dir, abs);

    let content = match std::fs::read_to_string(abs) {
        Ok(c) => c,
        Err(e) => {
            let mut r = FileReport::new(&rel);
            r.push(err(format!("could not read file: {e}")));
            reports.insert(abs.to_path_buf(), r);
            on_stack.remove(abs);
            return;
        }
    };

    let nodes = match crate::tag_parser::parse(&content) {
        Ok(n) => n,
        Err(e) => {
            // Unparseable file: record the parse error and don't descend
            // (we can't trust the AST to find nested includes).
            let mut r = FileReport::new(&rel);
            r.push(err(format!("invalid TTS markup: {e}")));
            reports.insert(abs.to_path_buf(), r);
            on_stack.remove(abs);
            return;
        }
    };

    // Syntax + semantic lint for this file.
    let mut report = FileReport::new(&rel);
    if let Err(e) = crate::tag_parser::validate(&nodes) {
        report.push(err(format!("invalid TTS markup: {e}")));
    }

    // Resolve every <include> declared in this file, attach diagnostics here,
    // and recurse into the resolvable, non-cyclic targets.
    let script_dir = abs
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf();
    let declared = collect_include_srcs(&nodes);

    for src in declared {
        match resolve_include(&src, &script_dir, agent_dir) {
            Err(msg) => report.push(err(msg)), // dangling / escapes agent_dir
            Ok(target) => {
                if on_stack.contains(&target) {
                    // Back-edge to an ancestor on the current path → real cycle.
                    report.push(err(format!(
                        "circular include: `{src}` (→ `{}`)",
                        rel_under(agent_dir, &target)
                    )));
                } else {
                    // Recurse; the child's own report (if any) is inserted by
                    // the recursive call. If the child fails to parse, that's
                    // reported on the child — no extra error needed here.
                    walk_script(&target, agent_dir, reports, visited, on_stack);
                }
            }
        }
    }

    reports.insert(abs.to_path_buf(), report);
    on_stack.remove(abs);
}

/// Gather every `<include src="...">` string declared in `nodes`, recursing
/// into all container / parts nodes. Returns them in document order. Does not
/// resolve or validate them — the caller does, attaching diagnostics to its
/// own report.
fn collect_include_srcs(nodes: &[crate::tag_parser::Node]) -> Vec<String> {
    use crate::tag_parser::Node;
    let mut out = Vec::new();
    fn rec(nodes: &[Node], out: &mut Vec<String>) {
        for node in nodes {
            match node {
                Node::Include { src } => out.push(src.clone()),
                Node::Voice { children, .. }
                | Node::Speed { children, .. }
                | Node::Volume { children, .. }
                | Node::Effect { children, .. }
                | Node::Background { children, .. }
                | Node::Until { children, .. }
                | Node::Loop { children, .. }
                | Node::Section { children, .. } => rec(children, out),
                Node::Overlay { parts, .. }
                | Node::Random { parts }
                | Node::Scramble { parts }
                | Node::Choice { options: parts, .. } => {
                    for part in parts {
                        rec(&part.children, out);
                    }
                }
                Node::Text(_) | Node::Pause { .. } | Node::Sound { .. } | Node::Tone { .. } => {}
            }
        }
    }
    rec(nodes, &mut out);
    out
}

/// `journal/format.json`
fn validate_journal_format(rel_path: &str, content: &str) -> FileReport {
    let mut report = FileReport::new(rel_path);
    let parsed: serde_json::Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(e) => {
            report.push(err(format!("invalid JSON: {e}")));
            return report;
        }
    };
    let arr = match parsed.as_array() {
        Some(a) => a,
        None => {
            report.push(err("format.json must be an array of fields"));
            return report;
        }
    };
    if arr.is_empty() {
        report.push(warn("format.json is empty — the journal will show no prompts"));
    }
    for (i, entry) in arr.iter().enumerate() {
        let obj = match entry.as_object() {
            Some(o) => o,
            None => {
                report.push(err(format!("field #{i}: must be an object")));
                continue;
            }
        };
        let typ = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if !matches!(typ, "freeform" | "scale" | "choice") {
            report.push(Problem {
                severity: "error".to_string(),
                message: format!(
                    "field #{i}: `type` must be one of freeform, scale, choice (got `{typ}`)"
                ),
                fix: Some("set `type` to `freeform`, `scale`, or `choice`".to_string()),
            });
        }
        match obj.get("prompt").and_then(|v| v.as_str()) {
            None => report.push(err(format!("field #{i}: missing string `prompt`"))),
            Some(p) if p.is_empty() => {
                report.push(err(format!("field #{i}: `prompt` is empty")))
            }
            Some(_) => {}
        }
        if typ == "choice" {
            match obj.get("options") {
                None => report.push(err(format!(
                    "field #{i}: `type` is `choice` but `options` is missing"
                ))),
                Some(o) => {
                    let arr = match o.as_array() {
                        Some(a) => a,
                        None => {
                            report.push(err(format!(
                                "field #{i}: `options` must be an array of strings"
                            )));
                            continue;
                        }
                    };
                    if arr.is_empty() {
                        report.push(err(format!(
                            "field #{i}: `options` must have at least one entry"
                        )));
                    } else if !arr.iter().all(|v| v.is_string()) {
                        report.push(err(format!(
                            "field #{i}: `options` must be an array of strings"
                        )));
                    }
                }
            }
        }
    }
    report
}

/// Valid voice-training tracker ids (mirrors `voice/registry.ts`).
const VOICE_TRACKERS: &[&str] = &[
    "pitch",
    "resonance",
    "intonation",
    "weight",
    "loudness",
    "genderspace",
];

/// `voice/config.json`
fn validate_voice_config(rel_path: &str, content: &str, agent_dir: &Path) -> FileReport {
    let mut report = FileReport::new(rel_path);
    let parsed: serde_json::Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(e) => {
            report.push(err(format!("invalid JSON: {e}")));
            return report;
        }
    };
    let obj = match parsed.as_object() {
        Some(o) => o,
        None => {
            report.push(err("voice config must be a JSON object"));
            return report;
        }
    };

    if let Some(title) = obj.get("title") {
        if !title.is_string() {
            report.push(err("`title` must be a string"));
        }
    }

    // Validate a tracker spec object: known id, warn on unknown config keys.
    let validate_spec = |spec: &serde_json::Map<String, serde_json::Value>,
                         where_: &str,
                         report: &mut FileReport| {
        let id = match spec.get("id").and_then(|v| v.as_str()) {
            None => {
                report.push(err(format!("{where_}: tracker spec is missing a string `id`")));
                return;
            }
            Some(s) => s.to_string(),
        };
        if !VOICE_TRACKERS.contains(&id.as_str()) {
            report.push(Problem {
                severity: "error".to_string(),
                message: format!(
                    "{where_}: unknown tracker id `{id}` — the app silently drops it"
                ),
                fix: Some(format!(
                    "use one of: {}",
                    VOICE_TRACKERS.join(", ")
                )),
            });
            return;
        }
        // Known per-tracker config keys (from voice/trackers/*.tsx).
        let known: &[&str] = match id.as_str() {
            "pitch" => &["minHz", "maxHz", "targetHz", "displayMinHz", "displayMaxHz"],
            "resonance" => &["targetCentroid", "displayMinHz", "displayMaxHz"],
            "intonation" => &["displayMinHz", "displayMaxHz"],
            "weight" => &["targetDb"],
            "loudness" => &[],
            "genderspace" => &["displayMinHz", "displayMaxHz"],
            _ => &[],
        };
        if let Some(cfg) = spec.get("config").and_then(|v| v.as_object()) {
            for key in cfg.keys() {
                if key == "displayText" {
                    continue;
                }
                if !known.contains(&key.as_str()) {
                    report.push(warn(format!(
                        "{where_}: tracker `{id}` has unknown config key `{key}` (ignored)"
                    )));
                }
            }
        }
    };

    if let Some(dt) = obj.get("defaultTrackers") {
        match dt.as_array() {
            None => report.push(err("`defaultTrackers` must be an array")),
            Some(arr) => {
                for (i, spec) in arr.iter().enumerate() {
                    match spec.as_object() {
                        Some(o) => validate_spec(o, &format!("defaultTrackers[{i}]"), &mut report),
                        None => report.push(err(format!(
                            "defaultTrackers[{i}]: must be an object with an `id`"
                        ))),
                    }
                }
            }
        }
    }

    if let Some(lessons) = obj.get("lessons") {
        match lessons.as_object() {
            None => report.push(err("`lessons` must be an object (map of lesson id → config)")),
            Some(map) => {
                for (lesson_id, lesson) in map {
                    let lobj = match lesson.as_object() {
                        Some(o) => o,
                        None => {
                            report.push(err(format!(
                                "lessons.`{lesson_id}`: must be an object"
                            )));
                            continue;
                        }
                    };
                    if let Some(title) = lobj.get("title") {
                        if !title.is_string() {
                            report.push(err(format!(
                                "lessons.`{lesson_id}`: `title` must be a string"
                            )));
                        }
                    }
                    if let Some(trackers) = lobj.get("trackers") {
                        match trackers.as_array() {
                            None => report.push(err(format!(
                                "lessons.`{lesson_id}`: `trackers` must be an array"
                            ))),
                            Some(arr) => {
                                for (i, spec) in arr.iter().enumerate() {
                                    match spec.as_object() {
                                        Some(o) => validate_spec(
                                            o,
                                            &format!("lessons.`{lesson_id}`.trackers[{i}]"),
                                            &mut report,
                                        ),
                                        None => report.push(err(format!(
                                            "lessons.`{lesson_id}`.trackers[{i}]: must be an object with an `id`"
                                        ))),
                                    }
                                }
                            }
                        }
                    }
                    // Each lesson key should correspond to a voice/<key>.md file.
                    let lesson_md = format!("voice/{lesson_id}.md");
                    if let Ok(p) = crate::bash::resolve_under(agent_dir, &lesson_md) {
                        if !p.exists() {
                            report.push(Problem {
                                severity: "warning".to_string(),
                                message: format!(
                                    "lesson `{lesson_id}` is configured but `voice/{lesson_id}.md` does not exist"
                                ),
                                fix: Some(format!(
                                    "create `voice/{lesson_id}.md` with the lesson instructions"
                                )),
                            });
                        }
                    }
                }
            }
        }
    }

    report
}

// ============================================================================
// Shared: cross-file link existence check
// ============================================================================

fn check_md_links(body: &str, agent_dir: &Path, report: &mut FileReport) {
    for link in extract_md_links(body) {
        let Some(target_rel) = in_app_link_target(&link.target) else {
            continue;
        };
        let resolved = match crate::bash::resolve_under(agent_dir, &target_rel) {
            Ok(p) => p,
            // Invalid path (escapes sandbox etc.) → report as a bad link.
            Err(e) => {
                report.push(Problem {
                    severity: "error".to_string(),
                    message: format!("link `{}` points outside the data area ({e})", link.target),
                    fix: Some(format!("use a relative path like `{target_rel}`")),
                });
                continue;
            }
        };
        if !resolved.exists() {
            report.push(Problem {
                severity: "error".to_string(),
                message: format!(
                    "link `{}` references `{}`, which does not exist",
                    link.target, target_rel
                ),
                fix: Some(format!("create `{target_rel}` or fix the link target")),
            });
        }
    }
}

// ============================================================================
// Directory walking
// ============================================================================

/// List non-recursive file entries (name + full path) under `dir_rel`.
/// Returns an empty vec if the directory doesn't exist (mirrors
/// `list_data_files`).
fn list_dir_files(dir_rel: &str, agent_dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(dir) = crate::bash::resolve_under(agent_dir, dir_rel) else {
        return Vec::new();
    };
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = format!("{dir_rel}/{name}");
        out.push((rel, entry.path()));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

// ============================================================================
// The Tauri command
// ============================================================================

/// Normalize a relative path to forward slashes with no leading `.`/`/`, for
/// prefix-matching against a scope.
fn norm_rel(p: &str) -> String {
    let p = p.trim_start_matches(['.', '/']);
    p.replace('\\', "/")
}

/// True if `rel_path` (an `agent_data/`-relative path) is at or under `scope`.
/// `scope` itself is normalized the same way. A bare feature dir like
/// `"conditioning"` matches `conditioning/foo.json`; an exact file like
/// `"conditioning/foo.json"` matches only itself; `"hypnos"` matches every
/// `.xml` under `hypnos/` at any depth. Empty scope matches everything.
fn in_scope(rel_path: &str, scope: &str) -> bool {
    let rel = norm_rel(rel_path);
    let scope = norm_rel(scope);
    if scope.is_empty() {
        return true;
    }
    if rel == scope {
        return true;
    }
    // Directory-prefix match: rel must start with "scope/".
    rel.starts_with(&format!("{scope}/"))
}

/// Recursively list `(rel, full)` pairs for every regular file under `dir_rel`
/// (relative to `agent_dir`). Returns empty if the dir doesn't exist. Used to
/// walk `hypnos/` at arbitrary depth for standalone/unreferenced XML.
fn list_dir_files_recursive(dir_rel: &str, agent_dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(dir) = crate::bash::resolve_under(agent_dir, dir_rel) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut stack = vec![(dir_rel.to_string(), dir.clone())];
    while let Some((rel, d)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let child_rel = format!("{rel}/{name}");
            if meta.is_dir() {
                stack.push((child_rel, entry.path()));
            } else if meta.is_file() {
                out.push((child_rel, entry.path()));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Validate every known feature file under `agent_data/` and return a
/// structured report. Read-only.
///
/// When `path` is `Some(scope)`, only files at or under `scope` (relative to
/// `agent_data/`, forward slashes) are validated. Scoping a conditioning entry
/// (e.g. `"conditioning/foo.json"`) still pulls in its full XML include tree,
/// because import validity is checked "up to the .json root"; scoping a bare
/// `.xml` (e.g. `"hypnos/foo.xml"`) lints that script standalone. When `path`
/// is `None`, every known feature file is validated as before.
#[tauri::command]
pub fn validate_data_files(
    path: Option<String>,
    state: State<'_, AppState>,
) -> ValidateReport {
    let agent_dir = state.agent_dir.clone();
    let mut files: Vec<FileReport> = Vec::new();
    let mut errors = 0usize;
    let mut warnings = 0usize;

    // One-shot helpers to finalize counts as we collect.
    fn push_one(
        files: &mut Vec<FileReport>,
        errors: &mut usize,
        warnings: &mut usize,
        r: FileReport,
    ) {
        if r.status == "error" {
            *errors += 1;
        } else if r.status == "warning" {
            *warnings += 1;
        }
        files.push(r);
    }
    let collect = |files: &mut Vec<FileReport>, errors: &mut usize, warnings: &mut usize,
                   r: FileReport| push_one(files, errors, warnings, r);

    // Resolve + validate the scope itself: a malformed/escaping scope yields a
    // single error report and nothing else. An absent scope dir yields an empty
    // report (matches `list_dir_files`). Bare-existence of the scope as a path
    // is *not* required (e.g. `path="routines"` when that dir exists is fine,
    // but `path="conditioning/missing.json"` just lints nothing under it).
    let scope: Option<String> = match &path {
        Some(p) if !p.trim().is_empty() => {
            match crate::bash::resolve_under(&agent_dir, p) {
                Ok(_) => Some(norm_rel(p)),
                Err(msg) => {
                    let mut r = FileReport::new(norm_rel(p));
                    r.push(err(msg));
                    collect(&mut files, &mut errors, &mut warnings, r);
                    return ValidateReport {
                        checked: files.len(),
                        errors,
                        warnings,
                        files,
                    };
                }
            }
        }
        _ => None,
    };
    let in_scope_of = |rel: &str| match &scope {
        Some(s) => in_scope(rel, s),
        None => true,
    };

    // routines/*.md
    for (rel, full) in list_dir_files("routines", &agent_dir) {
        if !rel.to_ascii_lowercase().ends_with(".md") || !in_scope_of(&rel) {
            continue;
        }
        let content = std::fs::read_to_string(&full).unwrap_or_default();
        let r = validate_routine(&rel, &content, &agent_dir);
        collect(&mut files, &mut errors, &mut warnings, r);
    }

    // rule/*.md  (on-disk dir is singular)
    for (rel, full) in list_dir_files("rule", &agent_dir) {
        if !rel.to_ascii_lowercase().ends_with(".md") || !in_scope_of(&rel) {
            continue;
        }
        let content = std::fs::read_to_string(&full).unwrap_or_default();
        let r = validate_rule(&rel, &content, &agent_dir);
        collect(&mut files, &mut errors, &mut warnings, r);
    }

    // conditioning/*.json (+ referenced XML trees). We track every .xml the
    // in-scope conditioning entries reach, so the unreferenced-XML pass below
    // can tell standalone scripts apart from reachable ones.
    let mut reachable_xml: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (rel, full) in list_dir_files("conditioning", &agent_dir) {
        if !rel.to_ascii_lowercase().ends_with(".json") || !in_scope_of(&rel) {
            continue;
        }
        let content = std::fs::read_to_string(&full).unwrap_or_default();
        for r in validate_conditioning(&rel, &content, &agent_dir) {
            // Record any XML file this entry reached (status ok/warning/error
            // all mean it exists on disk and is part of a tree).
            if r.path.to_ascii_lowercase().ends_with(".xml") {
                reachable_xml.insert(r.path.clone());
            }
            collect(&mut files, &mut errors, &mut warnings, r);
        }
    }

    // journal/format.json
    if in_scope_of("journal/format.json") {
        let journal_format = crate::bash::resolve_under(&agent_dir, "journal/format.json")
            .ok()
            .filter(|p| p.exists());
        if let Some(full) = journal_format {
            let content = std::fs::read_to_string(&full).unwrap_or_default();
            let r = validate_journal_format("journal/format.json", &content);
            collect(&mut files, &mut errors, &mut warnings, r);
        }
    }

    // voice/config.json
    if in_scope_of("voice/config.json") {
        let voice_config = crate::bash::resolve_under(&agent_dir, "voice/config.json")
            .ok()
            .filter(|p| p.exists());
        if let Some(full) = voice_config {
            let content = std::fs::read_to_string(&full).unwrap_or_default();
            let r = validate_voice_config("voice/config.json", &content, &agent_dir);
            collect(&mut files, &mut errors, &mut warnings, r);
        }
    }

    // Standalone / unreferenced scripts: every .xml under hypnos/ that no
    // in-scope conditioning entry reached. These are linted (parse + semantic
    // + their own includes) and warned — not errored — for being unreferenced.
    // Skipped entirely when the scope doesn't cover hypnos/.
    if in_scope_of("hypnos") || scope.as_deref() == Some("hypnos") {
        for (rel, full) in list_dir_files_recursive("hypnos", &agent_dir) {
            if !rel.to_ascii_lowercase().ends_with(".xml") || !in_scope_of(&rel) {
                continue;
            }
            // If this file was reached by a conditioning tree above, it's
            // already linted; don't double-report. Compare on rel path.
            if reachable_xml.contains(&rel) {
                continue;
            }
            // Lint the standalone script: its own parse + semantics + the
            // includes IT declares (import validity within the file).
            let mut r = FileReport::new(&rel);
            let content = std::fs::read_to_string(&full).unwrap_or_default();
            let nodes = match crate::tag_parser::parse(&content) {
                Ok(n) => n,
                Err(e) => {
                    r.push(err(format!("invalid TTS markup: {e}")));
                    collect(&mut files, &mut errors, &mut warnings, r);
                    continue;
                }
            };
            if let Err(e) = crate::tag_parser::validate(&nodes) {
                r.push(err(format!("invalid TTS markup: {e}")));
            }
            // Also chase this standalone script's own includes so a dangling
            // <include> in an unreferenced file still gets caught.
            let script_dir = full
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .to_path_buf();
            for src in collect_include_srcs(&nodes) {
                if let Err(msg) = resolve_include(&src, &script_dir, &agent_dir) {
                    r.push(err(msg));
                }
            }
            // Unreferenced is a warning, not an error (per design decision).
            r.push(warn(
                "script is not referenced by any conditioning JSON entry".to_string(),
            ));
            collect(&mut files, &mut errors, &mut warnings, r);
        }
    }

    ValidateReport {
        checked: files.len(),
        errors,
        warnings,
        files,
    }
}

// ============================================================================
// Unit tests (pure helpers; no Tauri state)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_cron_5_field_gets_seconds() {
        assert_eq!(normalize_cron("30 2 * * *"), "0 30 2 * * *");
        assert_eq!(normalize_cron("  30 2 * * *  "), "0 30 2 * * *");
    }

    #[test]
    fn normalize_cron_passthrough_6_or_shorthand() {
        assert_eq!(normalize_cron("0 30 2 * * *"), "0 30 2 * * *");
        assert_eq!(normalize_cron("@daily"), "@daily");
        // 7-field (with year) unchanged
        assert_eq!(normalize_cron("0 0 0 1 1 * 2025"), "0 0 0 1 1 * 2025");
    }

    #[test]
    fn validate_cron_accepts_5_and_6_field() {
        assert!(validate_cron("30 2 * * *").is_ok());
        assert!(validate_cron("0 30 2 * * *").is_ok());
        assert!(validate_cron("@daily").is_ok());
    }

    #[test]
    fn validate_cron_rejects_bad_field_count_and_ranges() {
        assert!(validate_cron("30 2 *").is_err()); // 3 fields
        assert!(validate_cron("* * 25 * * *").is_err()); // hour 25 out of range
        assert!(validate_cron("* * * * 13").is_err()); // month 13 out of range
    }

    #[test]
    fn frontmatter_splits_schedule_and_body() {
        let content = "---\nschedule: 30 2 * * *\n---\n\nHello body.\n";
        let (fm, body) = split_frontmatter(content);
        assert_eq!(frontmatter_schedule(&fm).as_deref(), Some("30 2 * * *"));
        assert!(body.trim().starts_with("Hello body."));
    }

    #[test]
    fn frontmatter_missing_when_not_at_start() {
        let content = "\n---\nschedule: 30 2 * * *\n---\nbody\n";
        let (fm, _body) = split_frontmatter(content);
        assert!(frontmatter_schedule(&fm).is_none());
    }

    #[test]
    fn extract_links_basic_and_image_skipped() {
        let body = "see [a](conditioning/foo.json) and ![img](x.png) and [b](rule/bar.md)";
        let links: Vec<String> = extract_md_links(body)
            .into_iter()
            .map(|l| l.target)
            .collect();
        assert_eq!(links, vec!["conditioning/foo.json", "rule/bar.md"]);
    }

    #[test]
    fn in_app_link_resolves_rules_alias_and_skips_external() {
        assert_eq!(
            in_app_link_target("rules/dress.md").as_deref(),
            Some("rule/dress.md")
        );
        assert_eq!(
            in_app_link_target("./conditioning/a.json").as_deref(),
            Some("conditioning/a.json")
        );
        assert_eq!(in_app_link_target("https://x.com"), None);
        assert_eq!(in_app_link_target("chastity"), None);
        assert_eq!(in_app_link_target("inventory/items#42"), None);
    }

    // ── Conditioning script tree validation ──────────────────────────────

    /// Helper: build a temp agent_dir, write files under it, return the dir.
    fn agent_dir_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        for (rel, content) in files {
            let p = tmp.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, content).unwrap();
        }
        tmp
    }

    fn problems_for(report: &FileReport) -> Vec<String> {
        report.problems.iter().map(|p| p.message.clone()).collect()
    }

    #[test]
    fn script_tree_valid_simple_xml_has_no_errors() {
        let dir = agent_dir_with(&[(
            "hypnos/root.xml",
            "<voice speaker='female'>Hello there.</voice>",
        )]);
        let reports = validate_script_tree("hypnos/root.xml", dir.path());
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].path, "hypnos/root.xml");
        assert_eq!(reports[0].status, "ok", "{:?}", reports[0].problems);
    }

    #[test]
    fn script_tree_reports_xml_parse_error_on_root() {
        let dir = agent_dir_with(&[("hypnos/root.xml", "<voice>oops no close")]);
        let reports = validate_script_tree("hypnos/root.xml", dir.path());
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].status, "error");
        assert!(problems_for(&reports[0])[0].contains("invalid TTS markup"));
    }

    #[test]
    fn script_tree_flags_unknown_sound_type_semantically() {
        let dir = agent_dir_with(&[(
            "hypnos/root.xml",
            "<voice><sound type='not_a_real_sound'/></voice>",
        )]);
        let reports = validate_script_tree("hypnos/root.xml", dir.path());
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].status, "error");
        assert!(problems_for(&reports[0])[0].contains("invalid TTS markup"));
    }

    #[test]
    fn script_tree_dangling_include_is_an_error_on_owner() {
        // root includes a file that does not exist.
        let dir = agent_dir_with(&[(
            "hypnos/root.xml",
            "<voice><include src='hypnos/missing.xml'/></voice>",
        )]);
        let reports = validate_script_tree("hypnos/root.xml", dir.path());
        // Only the root is reported (the missing file isn't linted).
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].path, "hypnos/root.xml");
        assert_eq!(reports[0].status, "error");
        assert!(
            problems_for(&reports[0])
                .iter()
                .any(|m| m.contains("include not found")),
            "{:?}",
            reports[0].problems
        );
    }

    #[test]
    fn script_tree_resolves_include_relative_to_script_dir() {
        // root.xml lives in hypnos/sub/ and includes sibling "leaf.xml" by
        // bare filename — resolvable relative to the script's own dir.
        let dir = agent_dir_with(&[
            (
                "hypnos/sub/root.xml",
                "<voice><include src='leaf.xml'/></voice>",
            ),
            ("hypnos/sub/leaf.xml", "<voice>nested</voice>"),
        ]);
        let reports = validate_script_tree("hypnos/sub/root.xml", dir.path());
        assert_eq!(reports.len(), 2, "{:?}", reports);
        // Both files clean.
        assert!(reports.iter().all(|r| r.status == "ok"), "{:?}", reports);
        let paths: Vec<_> = reports.iter().map(|r| r.path.as_str()).collect();
        assert!(paths.contains(&"hypnos/sub/root.xml"));
        assert!(paths.contains(&"hypnos/sub/leaf.xml"));
    }

    #[test]
    fn script_tree_circular_include_is_an_error() {
        // a.xml includes b.xml, b.xml includes a.xml → cycle.
        let dir = agent_dir_with(&[
            (
                "hypnos/a.xml",
                "<voice><include src='hypnos/b.xml'/></voice>",
            ),
            (
                "hypnos/b.xml",
                "<voice><include src='hypnos/a.xml'/></voice>",
            ),
        ]);
        let reports = validate_script_tree("hypnos/a.xml", dir.path());
        // At least one file reports a circular-include error.
        let any_cycle = reports.iter().any(|r| {
            r.problems
                .iter()
                .any(|p| p.message.contains("circular include"))
        });
        assert!(any_cycle, "no circular-include error reported: {:?}", reports);
    }

    #[test]
    fn script_tree_diamond_includes_lint_each_file_once() {
        // root → {left, right}; both → shared. `shared` must be linted once.
        let dir = agent_dir_with(&[
            (
                "hypnos/root.xml",
                "<voice><include src='hypnos/left.xml'/><include src='hypnos/right.xml'/></voice>",
            ),
            (
                "hypnos/left.xml",
                "<voice><include src='hypnos/shared.xml'/></voice>",
            ),
            (
                "hypnos/right.xml",
                "<voice><include src='hypnos/shared.xml'/></voice>",
            ),
            ("hypnos/shared.xml", "<voice>base</voice>"),
        ]);
        let reports = validate_script_tree("hypnos/root.xml", dir.path());
        // 4 distinct files, no duplicates, all clean.
        assert_eq!(reports.len(), 4, "{:?}", reports);
        let mut paths: Vec<_> = reports.iter().map(|r| r.path.clone()).collect();
        paths.sort();
        paths.dedup();
        assert_eq!(paths.len(), 4);
        assert!(reports.iter().all(|r| r.status == "ok"), "{:?}", reports);
    }

    // ── Path scoping helper ──────────────────────────────────────────────

    #[test]
    fn in_scope_prefix_and_exact_matches() {
        assert!(in_scope("conditioning/a.json", "conditioning"));
        assert!(in_scope("conditioning/a.json", "conditioning/a.json"));
        assert!(!in_scope("conditioning/a.json", "conditioning/b.json"));
        assert!(in_scope("hypnos/sub/x.xml", "hypnos"));
        assert!(!in_scope("routines/a.md", "conditioning"));
        // Leading dot/slash on either side is normalized away.
        assert!(in_scope("./conditioning/a.json", "./conditioning"));
        // Empty scope matches everything.
        assert!(in_scope("anything", ""));
    }
}
