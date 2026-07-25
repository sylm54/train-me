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

/// `conditioning/*.json`
fn validate_conditioning(rel_path: &str, content: &str, agent_dir: &Path) -> FileReport {
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
            report.push(err("conditioning metadata must be a JSON object"));
            return report;
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

    // Warn if the referenced script file doesn't exist.
    if let Some(script) = nonempty_string("script_path") {
        if let Ok(p) = crate::bash::resolve_under(agent_dir, script) {
            if !p.exists() {
                report.push(Problem {
                    severity: "warning".to_string(),
                    message: format!(
                        "`script_path` points to `{script}`, which does not exist"
                    ),
                    fix: Some(format!(
                        "create `{script}` (or have the Hypno Planner subagent author it)"
                    )),
                });
            }
        }
    }

    report
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

/// Validate every known feature file under `agent_data/` and return a
/// structured report. Read-only.
#[tauri::command]
pub fn validate_data_files(state: State<'_, AppState>) -> ValidateReport {
    let agent_dir = state.agent_dir.clone();
    let mut files: Vec<FileReport> = Vec::new();
    let mut errors = 0usize;
    let mut warnings = 0usize;

    // One-shot helper to finalize counts as we collect.
    macro_rules! collect {
        ($report:expr) => {{
            let r = $report;
            if r.status == "error" {
                errors += 1;
            } else if r.status == "warning" {
                warnings += 1;
            }
            files.push(r);
        }};
    }

    // routines/*.md
    for (rel, full) in list_dir_files("routines", &agent_dir) {
        if !rel.to_ascii_lowercase().ends_with(".md") {
            continue;
        }
        let content = std::fs::read_to_string(&full).unwrap_or_default();
        collect!(validate_routine(&rel, &content, &agent_dir));
    }

    // rule/*.md  (on-disk dir is singular)
    for (rel, full) in list_dir_files("rule", &agent_dir) {
        if !rel.to_ascii_lowercase().ends_with(".md") {
            continue;
        }
        let content = std::fs::read_to_string(&full).unwrap_or_default();
        collect!(validate_rule(&rel, &content, &agent_dir));
    }

    // conditioning/*.json
    for (rel, full) in list_dir_files("conditioning", &agent_dir) {
        if !rel.to_ascii_lowercase().ends_with(".json") {
            continue;
        }
        let content = std::fs::read_to_string(&full).unwrap_or_default();
        collect!(validate_conditioning(&rel, &content, &agent_dir));
    }

    // journal/format.json
    let journal_format = crate::bash::resolve_under(&agent_dir, "journal/format.json")
        .ok()
        .filter(|p| p.exists());
    if let Some(full) = journal_format {
        let content = std::fs::read_to_string(&full).unwrap_or_default();
        collect!(validate_journal_format("journal/format.json", &content));
    }

    // voice/config.json
    let voice_config = crate::bash::resolve_under(&agent_dir, "voice/config.json")
        .ok()
        .filter(|p| p.exists());
    if let Some(full) = voice_config {
        let content = std::fs::read_to_string(&full).unwrap_or_default();
        collect!(validate_voice_config("voice/config.json", &content, &agent_dir));
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
}
