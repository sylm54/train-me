//! Feature-file validator.
//!
//! The agent manages several kinds of user-facing feature files under
//! `agent_data/`:
//!
//!   - `routines/*.md` (v1: `schedule` cron frontmatter; v2 when the
//!     frontmatter has `format: 2` — parsed by `format.rs`, see FORMAT.md)
//!   - `conditioning/*.json` (TTS metadata sidecar)
//!   - `journal/format.json` (journal field definitions)
//!   - `voice/config.json` (voice-training tracker config)
//!   - `habits/*.md`, `tasks/*.md`, `store/*.json` (v2-only containers,
//!     parsed by `format.rs`)
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
/// Two conversions happen:
///
/// 1. The `cron` 0.16 crate requires 6 or 7 fields
///    (`sec min hour dom month dow [year]`), but the documented + example
///    form in this app is classic 5-field (`min hour dom month dow`). To
///    keep 5-field cron both *valid* (per the user's chosen contract) and
///    *functional* (so notifications actually fire), we prepend a `0`
///    seconds field to any 5-field expression.
///
/// 2. The crate numbers days of week 1–7 with **Sunday = 1**, while
///    classic cron (and FORMAT.md, and the frontend humanizer in
///    `cron.ts`) uses **0–7 with Sunday = 0 and 7**. A numeric DOW field
///    is rewritten from the classic to the crate convention — e.g. `7`
///    (classic Sunday) becomes `1`, `1-5` (Mon–Fri) becomes `2-6` — so an
///    expression like `0 20 * * 7` fires on Sunday as documented instead
///    of the crate's Saturday. Named days (`sun`, `fri`, …) already mean
///    the same thing in both conventions and pass through untouched.
///
/// `@`-shorthands are passed through unchanged.
pub fn normalize_cron(expr: &str) -> String {
    let trimmed = expr.trim();
    if trimmed.starts_with('@') {
        return trimmed.to_string();
    }
    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    let (prepend_seconds, dow_idx) = match fields.len() {
        5 => (true, 4),
        6 => (false, 5),
        7 => (false, 5),
        _ => return trimmed.to_string(),
    };
    let mapped_dow = map_dow_classic_to_crate(fields[dow_idx]);
    let mut out: Vec<String> = Vec::with_capacity(fields.len() + usize::from(prepend_seconds));
    if prepend_seconds {
        out.push("0".to_string());
    }
    for (i, f) in fields.iter().enumerate() {
        out.push(if i == dow_idx {
            mapped_dow.clone()
        } else {
            (*f).to_string()
        });
    }
    out.join(" ")
}

/// Rewrite one DOW field from classic numbering (0 = Sunday, 7 = Sunday)
/// to the `cron` crate's (1 = Sunday … 7 = Saturday).
///
/// The field is expanded to its set of classic day numbers (handling
/// `*`, comma lists, ranges, and steps), each day is mapped between the
/// conventions, and the result is re-serialized (`*` when all seven days
/// match, else an explicit list — a wrapped classic range like `5-7`
/// (Fri–Sun) has no contiguous crate equivalent). Fields containing
/// day names, or anything unparseable, are returned unchanged so the
/// crate's own validation reports the error.
fn map_dow_classic_to_crate(field: &str) -> String {
    if field == "*" {
        return "*".to_string();
    }

    // Parse the field into (range, step) parts and expand to classic days.
    let mut classic_days: Vec<u8> = Vec::new();
    for part in field.split(',') {
        let (range_part, step) = match part.split_once('/') {
            Some((r, s)) => match s.parse::<u8>() {
                Ok(n) if n >= 1 => (r, n),
                _ => return field.to_string(),
            },
            None => (part, 1u8),
        };
        let (lo, hi) = if range_part == "*" {
            (0u8, 6u8)
        } else if let Some((a, b)) = range_part.split_once('-') {
            match (a.parse::<u8>(), b.parse::<u8>()) {
                (Ok(a), Ok(b)) => (a, b),
                _ => return field.to_string(),
            }
        } else {
            match range_part.parse::<u8>() {
                // A bare number with a step (`5/2`) means "from 5 to the
                // end" in classic cron; the DOW end is 7 (= Sunday too).
                Ok(v) => (v, if step > 1 { 7 } else { v }),
                _ => return field.to_string(),
            }
        };
        if lo > hi || hi > 7 {
            return field.to_string();
        }
        let mut d = lo;
        while d <= hi {
            classic_days.push(d);
            d += step;
        }
    }

    // Classic day 0 and 7 are both Sunday; the crate's Sunday is 1.
    let mut crate_days: Vec<u8> = classic_days
        .iter()
        .map(|&d| if d % 7 == 0 { 1 } else { d + 1 })
        .collect();
    crate_days.sort_unstable();
    crate_days.dedup();
    if crate_days.len() == 7 {
        return "*".to_string();
    }
    // Re-serialize, collapsing contiguous runs back into ranges (`2-6`
    // rather than `2,3,4,5,6`); wrapped day sets (e.g. Fri–Sun → 1,6,7)
    // stay as lists.
    let mut parts: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < crate_days.len() {
        let start = i;
        while i + 1 < crate_days.len() && crate_days[i + 1] == crate_days[i] + 1 {
            i += 1;
        }
        if start == i {
            parts.push(crate_days[i].to_string());
        } else {
            parts.push(format!("{}-{}", crate_days[start], crate_days[i]));
        }
        i += 1;
    }
    parts.join(",")
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
                        let target_clean = target.split_whitespace().next().unwrap_or("").trim();
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
/// (e.g. bare `inventory/…`). Port of `resolveAppPath` from
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
        "inventory" | "inventory/items" | "routines" | "today" => return None,
        _ => {}
    }

    let head = segs[0].to_ascii_lowercase();
    // Map a recognized first segment to the on-disk directory.
    let dir = match head.as_str() {
        "routines" | "routine" => "routines",
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
//   - dangling includes  (target doesn't exist / escapes agent_dir / a glob
//     that matches nothing)
//   - circular includes  (a file (transitively) includes an ancestor on the
//     current path — distinct from "already fully visited = share, fine")
//   - unparseable included files
//
// The include-resolution rule mirrors the renderer
// (`audio_renderer::resolve_include_targets`): relative to the including
// script's directory first, then relative to `agent_dir`; a glob (wildcards
// in the file-name component) expands to every matching file. Keeping the
// rule identical means the linter's verdict matches what actually renders.

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

/// Resolve an `<include src>` (plain or glob) the same way the renderer
/// does: relative to the including script's directory first, then relative
/// to `agent_dir`, with every target contained under `agent_dir`. A glob
/// (wildcards confined to the file name) expands to its sorted match list.
/// Returns `Err` with a message when nothing resolves — the caller turns
/// that into a diagnostic.
fn resolve_include_targets(
    src: &str,
    script_dir: &Path,
    agent_dir: &Path,
) -> Result<Vec<PathBuf>, String> {
    if !crate::tag_parser::include_src_is_glob(src) {
        return resolve_include(src, script_dir, agent_dir).map(|p| vec![p]);
    }

    let (dir_part, file_pattern) = match crate::tag_parser::split_glob_src(src) {
        Some((d, f)) => (d.to_string(), f.to_string()),
        None => (String::new(), src.to_string()),
    };
    if dir_part.contains('*') || dir_part.contains('?') {
        return Err(format!(
            "wildcards in include `{src}` are only allowed in the file name"
        ));
    }

    for base in [script_dir, agent_dir] {
        let joined = base.join(&dir_part);
        if !joined.is_dir() {
            continue;
        }
        let Ok(dir) = normalize_under(agent_dir, &joined) else {
            continue;
        };
        let mut matches: Vec<PathBuf> = std::fs::read_dir(&dir)
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.path())
                    .filter(|p| {
                        p.is_file()
                            && p.file_name()
                                .and_then(|n| n.to_str())
                                .map(|n| {
                                    crate::tag_parser::wildcard_match(&file_pattern, n)
                                })
                                .unwrap_or(false)
                    })
                    .collect()
            })
            .unwrap_or_default();
        if matches.is_empty() {
            continue; // fall through to the next base before erroring
        }
        matches.sort();
        return Ok(matches);
    }
    Err(format!("include matched no files: {src}"))
}

/// Resolve a plain `<include src>` to an absolute path the same way the
/// renderer does: relative to the including script's directory first, then
/// relative to `agent_dir`. Returns `Err` with a message if neither exists or
/// the resolved path escapes `agent_dir` — the caller turns that into a
/// diagnostic.
fn resolve_include(src: &str, script_dir: &Path, agent_dir: &Path) -> Result<PathBuf, String> {
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

    // Resolve every <include> declared in this file (globs expand to their
    // match list), attach diagnostics here, and recurse into the resolvable,
    // non-cyclic targets.
    let script_dir = abs
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf();
    let declared = collect_include_srcs(&nodes);

    for src in declared {
        match resolve_include_targets(&src, &script_dir, agent_dir) {
            Err(msg) => report.push(err(msg)), // dangling / escapes / no matches
            Ok(targets) => {
                let is_glob = crate::tag_parser::include_src_is_glob(&src);
                for target in targets {
                    if on_stack.contains(&target) {
                        if is_glob {
                            // Globs silently never include the declaring
                            // script or any of its ancestors — the renderer
                            // filters the same way, so no cycle is possible.
                            continue;
                        }
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
                | Node::Section { children, .. }
                | Node::Beatmeter { children, .. }
                | Node::Visual { children, .. } => rec(children, out),
                Node::If {
                    then_branch, r#else, ..
                } => {
                    rec(then_branch, out);
                    if let Some(else_nodes) = r#else {
                        rec(else_nodes, out);
                    }
                }
                Node::Overlay { parts, .. }
                | Node::Random { parts }
                | Node::Scramble { parts }
                | Node::Choice { options: parts, .. }
                | Node::React { parts, .. } => {
                    for part in parts {
                        rec(&part.children, out);
                    }
                }
                Node::Text(_)
                | Node::Pause { .. }
                | Node::Sound { .. }
                | Node::Tone { .. }
                | Node::Rating { .. } => {}
            }
        }
    }
    rec(nodes, &mut out);
    out
}

// ============================================================================
// v2 feature-format validators (routines with `format: 2`, habits, tasks,
// store entries — grammar parsed by `format.rs`, see FORMAT.md)
// ============================================================================

/// Convert a parser diagnostic into a report problem, prefixing the line
/// number when the parser knows it.
fn diag_problem(d: crate::format::Diag) -> Problem {
    Problem {
        severity: match d.severity {
            crate::format::Severity::Error => "error".to_string(),
            crate::format::Severity::Warning => "warning".to_string(),
        },
        message: match d.line {
            Some(line) => format!("line {line}: {}", d.message),
            None => d.message,
        },
        fix: d.fix,
    }
}

/// Filesystem checks shared by every v2 container: referenced XML scripts
/// (from `audio` features and `script` actions) must exist and their
/// include trees must lint clean; `task` actions must reference an
/// existing template. Existence problems land on `report`; each linted
/// script tree comes back as its own `FileReport` (matching the
/// conditioning precedent, so the caller can mark them reachable).
fn check_v2_refs(
    scripts: &[String],
    templates: &[String],
    agent_dir: &Path,
    report: &mut FileReport,
) -> Vec<FileReport> {
    let mut extra = Vec::new();
    let mut scripts = scripts.to_vec();
    scripts.sort();
    scripts.dedup();
    for src in &scripts {
        match crate::bash::resolve_under(agent_dir, src) {
            Err(msg) => report.push(err(format!("script reference `{src}` {msg}"))),
            Ok(p) if p.exists() => extra.extend(validate_script_tree(src, agent_dir)),
            Ok(_) => report.push(Problem {
                severity: "error".to_string(),
                message: format!("referenced script `{src}` does not exist"),
                fix: Some(format!("create `{src}` or fix the reference")),
            }),
        }
    }
    let mut templates = templates.to_vec();
    templates.sort();
    templates.dedup();
    for template in &templates {
        let rel = crate::format::template_to_path(template);
        match crate::bash::resolve_under(agent_dir, &rel) {
            Ok(p) if p.exists() => {}
            _ => report.push(Problem {
                severity: "error".to_string(),
                message: format!(
                    "`task` action references template `{template}`, but `{rel}` does not exist"
                ),
                fix: Some(format!("create `{rel}` or fix the template name")),
            }),
        }
    }
    extra
}

/// Gather script + template refs from a container's actions and run the
/// shared filesystem checks. Helper for the four validators below.
fn check_action_refs(
    success: &[crate::format::Action],
    failure: &[crate::format::Action],
    agent_dir: &Path,
    report: &mut FileReport,
) -> Vec<FileReport> {
    let mut refs = crate::format::ActionRefs::default();
    crate::format::collect_action_refs(success, &mut refs);
    crate::format::collect_action_refs(failure, &mut refs);
    check_v2_refs(&refs.scripts, &refs.templates, agent_dir, report)
}

/// `routines/*.md` with `format: 2`. Returns the routine's own report plus
/// one `FileReport` per XML script tree reachable from its `audio`
/// features and `script` actions.
fn validate_routine_v2(rel_path: &str, content: &str, agent_dir: &Path) -> Vec<FileReport> {
    let mut report = FileReport::new(rel_path);
    if !rel_path.to_ascii_lowercase().ends_with(".md") {
        report.push(err("routine files must use the .md extension"));
        return vec![report];
    }

    let (routine, diags) = crate::format::parse_routine(content);
    for d in diags {
        report.push(diag_problem(d));
    }

    let (_, body) = crate::format::split_frontmatter(content);
    check_md_links(&body, agent_dir, &mut report);

    let mut extra = Vec::new();
    if let Some(r) = &routine {
        extra.extend(check_action_refs(
            &r.success,
            &r.failure,
            agent_dir,
            &mut report,
        ));
        let scripts = crate::format::audio_feature_srcs(&r.pages);
        extra.extend(check_v2_refs(&scripts, &[], agent_dir, &mut report));
        check_condition_idents(&r.pages, &r.title, &mut report);
    }

    let mut reports = vec![report];
    reports.extend(extra);
    reports
}

/// Cross-check every condition expression (`@when`, `{{#if}}`, feature
/// `when:`) and `{{ var }}` interpolation in a file against the reserved
/// run variables and the file's own answer `field` ids. Unknown names are
/// silent `false`/empty at run time — exactly the mistakes worth catching
/// at lint time.
fn check_condition_idents(pages: &[crate::format::Page], title: &str, report: &mut FileReport) {
    let (conds, fields, interp) = crate::format::collect_condition_refs(pages);
    let field_list = fields.join(", ");
    for cond in &conds {
        let Ok(parsed) = crate::cond::parse(cond) else {
            continue; // syntax already reported by the parser
        };
        for ident in &parsed.identifiers {
            if crate::cond::RESERVED_VARS.contains(&ident.as_str()) {
                continue;
            }
            if fields.iter().any(|f| f == ident) {
                continue;
            }
            report.push(err(format!(
                "`{title}`: condition `{cond}` references unknown variable `{ident}` — \
                 use a run variable ({}) or a `field` from an input/choice/slider \
                 feature in this file{}",
                crate::cond::RESERVED_VARS.join(", "),
                if field_list.is_empty() {
                    String::new()
                } else {
                    format!(" (declared here: {field_list})")
                }
            )));
        }
    }
    for ident in &interp {
        if crate::cond::RESERVED_VARS.contains(&ident.as_str()) {
            continue;
        }
        if fields.iter().any(|f| f == ident) {
            continue;
        }
        report.push(warn(format!(
            "`{title}`: `{{{{{ident}}}}}` is not a known run variable or answer field — \
             it renders empty (run variables: {})",
            crate::cond::RESERVED_VARS.join(", ")
        )));
    }
}

/// `habits/*.md` (always v2).
fn validate_habit(rel_path: &str, content: &str, agent_dir: &Path) -> Vec<FileReport> {
    let mut report = FileReport::new(rel_path);
    if !rel_path.to_ascii_lowercase().ends_with(".md") {
        report.push(err("habit files must use the .md extension"));
        return vec![report];
    }

    let (habit, diags) = crate::format::parse_habit(content);
    for d in diags {
        report.push(diag_problem(d));
    }

    let (_, body) = crate::format::split_frontmatter(content);
    check_md_links(&body, agent_dir, &mut report);

    let mut extra = Vec::new();
    if let Some(h) = &habit {
        extra.extend(check_action_refs(
            &h.success,
            &h.failure,
            agent_dir,
            &mut report,
        ));
    }

    let mut reports = vec![report];
    reports.extend(extra);
    reports
}

/// `tasks/*.md` (always v2). Same page-model checks as routines.
fn validate_task(rel_path: &str, content: &str, agent_dir: &Path) -> Vec<FileReport> {
    let mut report = FileReport::new(rel_path);
    if !rel_path.to_ascii_lowercase().ends_with(".md") {
        report.push(err("task files must use the .md extension"));
        return vec![report];
    }

    let (task, diags) = crate::format::parse_task(content);
    for d in diags {
        report.push(diag_problem(d));
    }

    let (_, body) = crate::format::split_frontmatter(content);
    check_md_links(&body, agent_dir, &mut report);

    let mut extra = Vec::new();
    if let Some(t) = &task {
        extra.extend(check_action_refs(
            &t.success,
            &t.failure,
            agent_dir,
            &mut report,
        ));
        let scripts = crate::format::audio_feature_srcs(&t.pages);
        extra.extend(check_v2_refs(&scripts, &[], agent_dir, &mut report));
        check_condition_idents(&t.pages, &t.title, &mut report);
    }

    let mut reports = vec![report];
    reports.extend(extra);
    reports
}

/// `store/*.json` (always v2).
fn validate_store_entry(rel_path: &str, content: &str, agent_dir: &Path) -> Vec<FileReport> {
    let mut report = FileReport::new(rel_path);
    if !rel_path.to_ascii_lowercase().ends_with(".json") {
        report.push(err("store entries must use the .json extension"));
        return vec![report];
    }

    let (entry, diags) = crate::format::parse_store_entry(content);
    for d in diags {
        report.push(diag_problem(d));
    }

    let mut extra = Vec::new();
    if let Some(e) = &entry {
        extra.extend(check_action_refs(&e.actions, &[], agent_dir, &mut report));
    }

    let mut reports = vec![report];
    reports.extend(extra);
    reports
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
pub fn validate_data_files(path: Option<String>, state: State<'_, AppState>) -> ValidateReport {
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
    let collect = |files: &mut Vec<FileReport>,
                   errors: &mut usize,
                   warnings: &mut usize,
                   r: FileReport| push_one(files, errors, warnings, r);

    // Resolve + validate the scope itself: a malformed/escaping scope yields a
    // single error report and nothing else. An absent scope dir yields an empty
    // report (matches `list_dir_files`). Bare-existence of the scope as a path
    // is *not* required (e.g. `path="routines"` when that dir exists is fine,
    // but `path="conditioning/missing.json"` just lints nothing under it).
    let scope: Option<String> = match &path {
        Some(p) if !p.trim().is_empty() => match crate::bash::resolve_under(&agent_dir, p) {
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
        },
        _ => None,
    };
    let in_scope_of = |rel: &str| match &scope {
        Some(s) => in_scope(rel, s),
        None => true,
    };

    // XML scripts reached by any in-scope entry (conditioning JSONs and
    // v2 audio features / script actions) — the unreferenced-XML pass
    // below uses this to tell standalone scripts apart from reachable ones.
    let mut reachable_xml: std::collections::HashSet<String> = std::collections::HashSet::new();

    // routines/*.md (parsed + validated by format.rs)
    for (rel, full) in list_dir_files("routines", &agent_dir) {
        if !rel.to_ascii_lowercase().ends_with(".md") || !in_scope_of(&rel) {
            continue;
        }
        let content = std::fs::read_to_string(&full).unwrap_or_default();
        for r in validate_routine_v2(&rel, &content, &agent_dir) {
            if r.path.to_ascii_lowercase().ends_with(".xml") {
                reachable_xml.insert(r.path.clone());
            }
            collect(&mut files, &mut errors, &mut warnings, r);
        }
    }

    // habits/*.md (v2)
    for (rel, full) in list_dir_files("habits", &agent_dir) {
        if !rel.to_ascii_lowercase().ends_with(".md") || !in_scope_of(&rel) {
            continue;
        }
        let content = std::fs::read_to_string(&full).unwrap_or_default();
        for r in validate_habit(&rel, &content, &agent_dir) {
            if r.path.to_ascii_lowercase().ends_with(".xml") {
                reachable_xml.insert(r.path.clone());
            }
            collect(&mut files, &mut errors, &mut warnings, r);
        }
    }

    // tasks/*.md (v2)
    for (rel, full) in list_dir_files("tasks", &agent_dir) {
        if !rel.to_ascii_lowercase().ends_with(".md") || !in_scope_of(&rel) {
            continue;
        }
        let content = std::fs::read_to_string(&full).unwrap_or_default();
        for r in validate_task(&rel, &content, &agent_dir) {
            if r.path.to_ascii_lowercase().ends_with(".xml") {
                reachable_xml.insert(r.path.clone());
            }
            collect(&mut files, &mut errors, &mut warnings, r);
        }
    }

    // store/*.json (v2)
    for (rel, full) in list_dir_files("store", &agent_dir) {
        if !rel.to_ascii_lowercase().ends_with(".json") || !in_scope_of(&rel) {
            continue;
        }
        let content = std::fs::read_to_string(&full).unwrap_or_default();
        for r in validate_store_entry(&rel, &content, &agent_dir) {
            if r.path.to_ascii_lowercase().ends_with(".xml") {
                reachable_xml.insert(r.path.clone());
            }
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
                if let Err(msg) = resolve_include_targets(&src, &script_dir, &agent_dir) {
                    r.push(err(msg));
                }
            }
            // Unreferenced is a warning, not an error (per design decision).
            r.push(warn(
                "script is not referenced by any feature file (audio feature or script action) or explicit <include>".to_string(),
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
    fn normalize_cron_maps_classic_dow() {
        // Classic 0 and 7 are both Sunday; the crate's Sunday is 1.
        assert_eq!(normalize_cron("0 20 * * 7"), "0 0 20 * * 1");
        assert_eq!(normalize_cron("0 20 * * 0"), "0 0 20 * * 1");
        // Classic 1-5 = Mon–Fri → crate 2-6.
        assert_eq!(normalize_cron("30 2 * * 2-4"), "0 30 2 * * 3-5");
        assert_eq!(normalize_cron("0 8 * * 1-5"), "0 0 8 * * 2-6");
        // Scattered list, mapped and re-sorted.
        assert_eq!(normalize_cron("0 8 * * 6,0"), "0 0 8 * * 1,7");
        // Full week collapses to *.
        assert_eq!(normalize_cron("0 8 * * 0-6"), "0 0 8 * * *");
        // Wrapped range Fri–Sun (no contiguous crate range; Sat–Sun collapses).
        assert_eq!(normalize_cron("0 8 * * 5-7"), "0 0 8 * * 1,6-7");
        // Step over the week: */2 = Sun,Tue,Thu,Sat.
        assert_eq!(normalize_cron("0 8 * * */2"), "0 0 8 * * 1,3,5,7");
        // 6-field expression: DOW mapped in place.
        assert_eq!(normalize_cron("0 0 20 * * 7"), "0 0 20 * * 1");
        // Named days pass through untouched (same meaning in both).
        assert_eq!(normalize_cron("0 8 * * mon-fri"), "0 0 8 * * mon-fri");
    }

    #[test]
    fn normalize_cron_dow_map_matches_crate_semantics() {
        // The mapped expression must parse AND fire on the expected
        // weekday: classic `0 20 * * 7` means Sunday 20:00.
        use std::str::FromStr;
        let schedule = cron::Schedule::from_str(&normalize_cron("0 20 * * 7")).unwrap();
        let fire = schedule
            .after(&chrono::DateTime::parse_from_rfc3339("2026-08-21T00:00:00Z").unwrap())
            .next()
            .unwrap();
        // 2026-08-21 is a Friday → next Sunday 20:00 UTC is the 23rd.
        assert_eq!(fire.to_rfc3339(), "2026-08-23T20:00:00+00:00");
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
    fn in_app_link_resolves_and_skips_external() {
        assert_eq!(
            in_app_link_target("routines/dress.md").as_deref(),
            Some("routines/dress.md")
        );
        assert_eq!(in_app_link_target("rules/dress.md"), None);
        assert_eq!(in_app_link_target("https://x.com"), None);
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
    fn script_tree_glob_include_walks_every_match() {
        // A glob include expands to every matching file; each is linted as
        // part of the tree.
        let dir = agent_dir_with(&[
            (
                "hypnos/root.xml",
                "<voice><include src='hypnos/parts/*.xml'/></voice>",
            ),
            ("hypnos/parts/a.xml", "<voice>a</voice>"),
            ("hypnos/parts/b.xml", "<voice>b</voice>"),
            ("hypnos/parts/notes.txt", "not a script"),
        ]);
        let reports = validate_script_tree("hypnos/root.xml", dir.path());
        let paths: Vec<_> = reports.iter().map(|r| r.path.as_str()).collect();
        assert!(paths.contains(&"hypnos/root.xml"));
        assert!(paths.contains(&"hypnos/parts/a.xml"));
        assert!(paths.contains(&"hypnos/parts/b.xml"));
        assert!(!paths.contains(&"hypnos/parts/notes.txt"));
        assert!(reports.iter().all(|r| r.status == "ok"), "{:?}", reports);
    }

    #[test]
    fn script_tree_glob_include_with_no_matches_is_an_error() {
        let dir = agent_dir_with(&[
            (
                "hypnos/root.xml",
                "<voice><include src='hypnos/nothing/*.xml'/></voice>",
            ),
        ]);
        let reports = validate_script_tree("hypnos/root.xml", dir.path());
        assert!(
            problems_for(&reports[0])
                .iter()
                .any(|m| m.contains("matched no files")),
            "{:?}",
            reports[0].problems
        );
    }

    #[test]
    fn script_tree_glob_include_never_cycles_on_itself() {
        // The glob in a.xml matches a.xml itself (and b.xml) — the
        // self-match is silently dropped (the renderer filters the same
        // way), the sibling is linted, and the tree is clean.
        let dir = agent_dir_with(&[
            (
                "hypnos/a.xml",
                "<voice><include src='hypnos/*.xml'/></voice>",
            ),
            ("hypnos/b.xml", "<voice>b</voice>"),
        ]);
        let reports = validate_script_tree("hypnos/a.xml", dir.path());
        assert!(
            reports.iter().all(|r| r.status == "ok"),
            "{:?}",
            reports
        );
        let paths: Vec<_> = reports.iter().map(|r| r.path.as_str()).collect();
        assert!(paths.contains(&"hypnos/b.xml"));
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
        assert!(
            any_cycle,
            "no circular-include error reported: {:?}",
            reports
        );
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

    // ── v2 feature format (format.rs grammar) ───────────────────────────

    #[test]
    fn v2_routine_routes_to_format_parser() {
        let dir = agent_dir_with(&[(
            "routines/drill.md",
            "---\nformat: 2\ntitle: Drill\nschedule: 0 8 * * *\n---\n\nintro\n",
        )]);
        let content = std::fs::read_to_string(dir.path().join("routines/drill.md")).unwrap();
        let reports = validate_routine_v2("routines/drill.md", &content, dir.path());
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].status, "ok", "{:?}", reports[0].problems);
    }

    #[test]
    fn routine_without_marker_reports_error() {
        let dir = agent_dir_with(&[]);
        let reports = validate_routine_v2(
            "routines/x.md",
            "---
schedule: 0 8 * * *
---
```feature
type: wait
duration: 1m
---
x
```
",
            dir.path(),
        );
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].status, "error");
        assert!(problems_for(&reports[0]).iter().any(|m| m.contains("format: 2")));
    }

    #[test]
    fn v2_habit_dangling_task_template_is_error() {
        let dir = agent_dir_with(&[(
            "habits/nox.md",
            "---\ntitle: No X\ntype: max\ncount: 0\nfailure: { \"type\": \"task\", \"template\": \"missing-one\" }\n---\ndesc\n",
        )]);
        let content = std::fs::read_to_string(dir.path().join("habits/nox.md")).unwrap();
        let reports = validate_habit("habits/nox.md", &content, dir.path());
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].status, "error");
        assert!(problems_for(&reports[0])
            .iter()
            .any(|m| m.contains("tasks/missing-one.md")));
    }

    #[test]
    fn v2_routine_audio_feature_lints_script_tree() {
        let dir = agent_dir_with(&[
            (
                "routines/listen.md",
                "---\nformat: 2\ntitle: Listen\n---\n```feature\ntype: audio\nsrc: hypnos/a.xml\n---\nlisten\n```\n",
            ),
            ("hypnos/a.xml", "<voice speaker='female'>hi</voice>"),
        ]);
        let content = std::fs::read_to_string(dir.path().join("routines/listen.md")).unwrap();
        let reports = validate_routine_v2("routines/listen.md", &content, dir.path());
        // The routine's own report + one for the referenced script.
        assert_eq!(reports.len(), 2, "{:?}", reports);
        assert!(reports.iter().all(|r| r.status == "ok"), "{:?}", reports);
    }

    #[test]
    fn v2_store_entry_notification_action_is_clean() {
        let dir = tempfile::tempdir().expect("tempdir");
        let reports = validate_store_entry(
            "store/pass.json",
            "{ \"title\": \"P\", \"price\": 5, \"action\": { \"type\": \"notification\", \"text\": \"hi\" } }",
            dir.path(),
        );
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].status, "ok", "{:?}", reports[0].problems);
    }
}
