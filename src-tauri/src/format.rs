//! Feature-format v2 parser.
//!
//! The single canonical parser for the v2 feature grammar specified in
//! `FORMAT.md`: routines (`routines/*.md` with `format: 2`), habits
//! (`habits/*.md`), task templates (`tasks/*.md`), and store entries
//! (`store/*.json`).
//!
//! Design constraints:
//!
//!   - **One parser, many consumers.** The validator (`validators.rs`),
//!     the scheduler, and (later) the session runner all consume the
//!     typed structures produced here. Nothing else should re-parse
//!     these files — the v1 lesson was three bespoke frontend parsers
//!     drifted from their validator mirrors.
//!   - **Pure.** No filesystem access: existence checks for referenced
//!     XML scripts / task templates live in the validator, which has the
//!     agent dir. Everything here works on strings, which also keeps the
//!     unit tests trivial.
//!   - **Lenient parse, strict diagnostics.** A file with errors still
//!     yields a best-effort value plus a `Vec<Diag>`; the caller decides
//!     what to do. Diagnostics carry 1-based line numbers so the agent
//!     can jump straight to the offending line.
//!   - **LLM-friendly grammar.** The primary author is the agent, so the
//!     front-matter accepts what models reliably produce — plain
//!     scalars, dotted keys (`success.delta: 15`), and inline JSON — and
//!     rejects what they malform with actionable messages.
//!
//! Front-matter is NOT full YAML: no block nesting, no anchors, no
//! multi-line strings. That is deliberate; `FORMAT.md` §2.1 is the
//! contract.

use serde::ser::SerializeMap as _;
use serde::{Deserialize, Serialize};

// ============================================================================
// Diagnostics
// ============================================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

/// One problem found while parsing. Mirrors `validators::Problem` plus a
/// 1-based line number into the source file when known.
#[derive(Clone, Debug)]
pub struct Diag {
    pub severity: Severity,
    pub message: String,
    pub fix: Option<String>,
    pub line: Option<usize>,
}

fn error_at(line: Option<usize>, message: impl Into<String>) -> Diag {
    Diag {
        severity: Severity::Error,
        message: message.into(),
        fix: None,
        line,
    }
}

fn warn_at(line: Option<usize>, message: impl Into<String>) -> Diag {
    Diag {
        severity: Severity::Warning,
        message: message.into(),
        fix: None,
        line,
    }
}

// ============================================================================
// Value tree + front-matter parsing
// ============================================================================

/// A parsed front-matter / feature-config value. Order-preserving so
/// diagnostics can reference keys in source order.
#[derive(Clone, Debug, PartialEq)]
pub enum FValue {
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    List(Vec<FValue>),
    Map(FMap),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FMap {
    entries: Vec<(String, FValue)>,
}

impl FMap {
    pub fn get(&self, key: &str) -> Option<&FValue> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn get_mut(&mut self, key: &str) -> Option<&mut FValue> {
        self.entries
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }
    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
    /// Take `key` out of the map (used for cross-cutting keys like `when`
    /// that are handled before per-type validation).
    pub fn remove(&mut self, key: &str) -> Option<FValue> {
        let pos = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(pos).1)
    }
    /// Insert without a duplicate check (caller must have checked).
    fn insert(&mut self, key: &str, value: FValue) {
        self.entries.push((key.to_string(), value));
    }
    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.entries.iter().map(|(k, _)| k)
    }
}

impl Serialize for FMap {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        FValue::Map(FMap {
            entries: self.entries.clone(),
        })
        .serialize(serializer)
    }
}

impl Serialize for FValue {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            FValue::Str(s) => serializer.serialize_str(s),
            FValue::Int(i) => serializer.serialize_i64(*i),
            FValue::Float(f) => serializer.serialize_f64(*f),
            FValue::Bool(b) => serializer.serialize_bool(*b),
            FValue::List(items) => items.serialize(serializer),
            FValue::Map(map) => {
                let mut m = serializer.serialize_map(Some(map.entries.len()))?;
                for (k, v) in &map.entries {
                    m.serialize_entry(k, v)?;
                }
                m.end()
            }
        }
    }
}

/// Extract the front-matter block, if the file starts with one.
/// Returns `(frontmatter text, body)`. A front-matter that never closes
/// is treated as absent (mirrors the v1 parser's behavior).
pub fn split_frontmatter(content: &str) -> (Option<String>, String) {
    let first_line = content.lines().next().unwrap_or("");
    if first_line.trim() != "---" {
        return (None, content.to_string());
    }
    let after_open = &content[content.find('\n').map(|i| i + 1).unwrap_or(content.len())..];
    let mut cursor = 0usize;
    for line in after_open.split_inclusive('\n') {
        if line.trim_end() == "---" {
            let fm = after_open[..cursor].to_string();
            let rest = &after_open[cursor..];
            let body = rest[rest.find('\n').map(|i| i + 1).unwrap_or(rest.len())..].to_string();
            return (Some(fm), body);
        }
        cursor += line.len();
    }
    (None, content.to_string())
}

/// Is `key` a valid bare or dotted key? `a`, `minHz`, `success.type`.
fn valid_key(key: &str) -> bool {
    let seg_ok = |s: &str| {
        let mut chars = s.chars();
        matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    };
    !key.is_empty() && key.split('.').all(seg_ok)
}

/// Parse one `key: value` line into `(dotted key, raw value string)`.
fn parse_kv_line(line: &str) -> Result<(String, String), String> {
    let Some((key, value)) = line.split_once(':') else {
        return Err("expected `key: value`".to_string());
    };
    let key = key.trim();
    if !valid_key(key) {
        return Err(format!(
            "invalid key `{key}` — use lowercase words, optionally dotted (e.g. `limit.daily`)"
        ));
    }
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("`{key}` has an empty value"));
    }
    Ok((key.to_string(), value.to_string()))
}

/// Parse a scalar (non-JSON) value: bool → int → float → (quoted) string.
fn parse_scalar(raw: &str) -> FValue {
    let t = raw.trim();
    if t == "true" {
        return FValue::Bool(true);
    }
    if t == "false" {
        return FValue::Bool(false);
    }
    if let Ok(i) = t.parse::<i64>() {
        return FValue::Int(i);
    }
    if let Ok(f) = t.parse::<f64>() {
        if f.is_finite() {
            return FValue::Float(f);
        }
    }
    let stripped = t
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| t.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')));
    FValue::Str(stripped.unwrap_or(t).to_string())
}

/// Convert an inline-JSON value (from `{ ... }` / `[ ... ]` front-matter
/// values, or a whole `store/*.json` file) into an `FValue`.
pub fn json_to_fvalue(v: serde_json::Value) -> FValue {
    match v {
        serde_json::Value::Null => FValue::Str(String::new()),
        serde_json::Value::Bool(b) => FValue::Bool(b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                FValue::Int(i)
            } else {
                FValue::Float(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => FValue::Str(s),
        serde_json::Value::Array(items) => {
            FValue::List(items.into_iter().map(json_to_fvalue).collect())
        }
        serde_json::Value::Object(obj) => {
            let mut map = FMap::default();
            for (k, val) in obj {
                map.insert(&k, json_to_fvalue(val));
            }
            FValue::Map(map)
        }
    }
}

/// Parse a block of `key: value` lines (front-matter or feature-block
/// config) into a map. `first_line` is the 1-based file line of the
/// first line in `text`, so diagnostics point at real lines.
///
/// Lines that fail to parse produce an error diag; the rest of the block
/// still parses (best-effort).
pub fn parse_kv_block(text: &str, first_line: usize) -> (FMap, Vec<Diag>) {
    let mut map = FMap::default();
    let mut diags = Vec::new();

    for (i, raw) in text.lines().enumerate() {
        let line_no = first_line + i;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value_raw) = match parse_kv_line(line) {
            Ok(kv) => kv,
            Err(msg) => {
                diags.push(error_at(Some(line_no), msg));
                continue;
            }
        };
        let value = if value_raw.starts_with('{') || value_raw.starts_with('[') {
            match serde_json::from_str::<serde_json::Value>(&value_raw) {
                Ok(json) => json_to_fvalue(json),
                Err(e) => {
                    diags.push(error_at(
                        Some(line_no),
                        format!("`{key}`: invalid JSON value: {e}"),
                    ));
                    continue;
                }
            }
        } else {
            parse_scalar(&value_raw)
        };
        if let Err(msg) = insert_dotted(&mut map, &key, value) {
            diags.push(error_at(Some(line_no), msg));
        }
    }
    (map, diags)
}

/// Insert `key` (possibly dotted) into `map`, creating intermediate maps.
/// Errors on duplicates and on scalar/map conflicts along the path.
fn insert_dotted(map: &mut FMap, key: &str, value: FValue) -> Result<(), String> {
    let segs: Vec<&str> = key.split('.').collect();
    let (last, parents) = segs.split_last().expect("valid_key guarantees non-empty");
    let mut cur = map;
    for seg in parents {
        if !cur.has(seg) {
            cur.insert(seg, FValue::Map(FMap::default()));
        }
        match cur.get_mut(seg) {
            Some(FValue::Map(m)) => cur = m,
            Some(_) => {
                return Err(format!(
                    "`{key}` conflicts: `{seg}` is already a plain value"
                ))
            }
            None => unreachable!("inserted above"),
        }
    }
    if cur.has(last) {
        return Err(format!("`{key}` is set more than once"));
    }
    cur.insert(last, value);
    Ok(())
}

// ============================================================================
// Typed field extraction helpers
// ============================================================================

fn get_str(map: &FMap, key: &str, ctx: &str, diags: &mut Vec<Diag>) -> Option<String> {
    match map.get(key) {
        Some(FValue::Str(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(FValue::Str(_)) => {
            diags.push(error_at(None, format!("{ctx}: `{key}` must not be empty")));
            None
        }
        Some(_) => {
            diags.push(error_at(None, format!("{ctx}: `{key}` must be a string")));
            None
        }
        None => None,
    }
}

fn get_int(map: &FMap, key: &str, ctx: &str, diags: &mut Vec<Diag>) -> Option<i64> {
    match map.get(key) {
        Some(FValue::Int(i)) => Some(*i),
        Some(_) => {
            diags.push(error_at(None, format!("{ctx}: `{key}` must be an integer")));
            None
        }
        None => None,
    }
}

fn get_num(map: &FMap, key: &str, ctx: &str, diags: &mut Vec<Diag>) -> Option<f64> {
    match map.get(key) {
        Some(FValue::Int(i)) => Some(*i as f64),
        Some(FValue::Float(f)) => Some(*f),
        Some(_) => {
            diags.push(error_at(None, format!("{ctx}: `{key}` must be a number")));
            None
        }
        None => None,
    }
}

fn get_bool(map: &FMap, key: &str, ctx: &str, diags: &mut Vec<Diag>) -> Option<bool> {
    match map.get(key) {
        Some(FValue::Bool(b)) => Some(*b),
        Some(_) => {
            diags.push(error_at(
                None,
                format!("{ctx}: `{key}` must be true or false"),
            ));
            None
        }
        None => None,
    }
}

/// Durations are strings with a unit (`30s`, `15m`, `4h`, `2d`).
pub fn parse_duration(raw: &str) -> Result<u64, String> {
    let t = raw.trim();
    let Some(digits) = t.strip_suffix(['s', 'm', 'h', 'd']) else {
        return Err("duration must be an integer plus a unit (s, m, h, d), e.g. `15m`".to_string());
    };
    let n: u64 = digits.parse().map_err(|_| {
        "duration must be an integer plus a unit (s, m, h, d), e.g. `15m`".to_string()
    })?;
    let mult = match t.chars().last() {
        Some('s') => 1,
        Some('m') => 60,
        Some('h') => 3600,
        Some('d') => 86400,
        _ => unreachable!("strip_suffix guarantees a unit"),
    };
    n.checked_mul(mult)
        .ok_or_else(|| "duration is out of range".to_string())
}

fn get_duration(map: &FMap, key: &str, ctx: &str, diags: &mut Vec<Diag>) -> Option<u64> {
    let raw = get_str(map, key, ctx, diags)?;
    match parse_duration(&raw) {
        Ok(secs) => Some(secs),
        Err(msg) => {
            diags.push(error_at(None, format!("{ctx}: `{key}`: {msg}")));
            None
        }
    }
}

/// Required-field variants: absence is an error (the plain `get_*`
/// helpers stay silent when a key is missing, for optional fields).
fn req_str(map: &FMap, key: &str, ctx: &str, diags: &mut Vec<Diag>) -> Option<String> {
    if !map.has(key) {
        diags.push(error_at(None, format!("{ctx}: `{key}` is required")));
        return None;
    }
    get_str(map, key, ctx, diags)
}

fn req_int(map: &FMap, key: &str, ctx: &str, diags: &mut Vec<Diag>) -> Option<i64> {
    if !map.has(key) {
        diags.push(error_at(None, format!("{ctx}: `{key}` is required")));
        return None;
    }
    get_int(map, key, ctx, diags)
}

fn req_num(map: &FMap, key: &str, ctx: &str, diags: &mut Vec<Diag>) -> Option<f64> {
    if !map.has(key) {
        diags.push(error_at(None, format!("{ctx}: `{key}` is required")));
        return None;
    }
    get_num(map, key, ctx, diags)
}

fn req_duration(map: &FMap, key: &str, ctx: &str, diags: &mut Vec<Diag>) -> Option<u64> {
    if !map.has(key) {
        diags.push(error_at(None, format!("{ctx}: `{key}` is required")));
        return None;
    }
    get_duration(map, key, ctx, diags)
}

/// Validate a cron expression (5-field is normalized to 6). Returns the
/// error message on failure.
pub fn check_cron(expr: &str) -> Option<String> {
    use std::str::FromStr;
    let normalized = crate::validators::normalize_cron(expr);
    match cron::Schedule::from_str(&normalized) {
        Ok(_) => None,
        Err(_) => Some(format!(
            "invalid cron `{expr}` — use 5-field (min hour dom month dow, e.g. `0 8 * * *`), \
             6-field, or an @shorthand"
        )),
    }
}

fn get_cron(map: &FMap, key: &str, ctx: &str, diags: &mut Vec<Diag>) -> Option<String> {
    let raw = get_str(map, key, ctx, diags)?;
    if let Some(msg) = check_cron(&raw) {
        diags.push(error_at(None, format!("{ctx}: {msg}")));
        return None;
    }
    Some(raw)
}

/// Warn about keys in `map` that aren't in `known` (forward compatibility).
fn warn_unknown_keys(map: &FMap, known: &[&str], ctx: &str, diags: &mut Vec<Diag>) {
    for key in map.keys() {
        if !known.contains(&key.as_str()) {
            diags.push(warn_at(
                None,
                format!("{ctx}: unknown key `{key}` (ignored)"),
            ));
        }
    }
}

// ============================================================================
// Body → pages → elements
// ============================================================================

#[derive(Clone, Debug, Serialize)]
pub struct FeatureBlock {
    pub ftype: String,
    pub config: FMap,
    pub body: String,
    /// Optional run-time condition (`when:` config key). When it evaluates
    /// false, the whole feature is skipped (not rendered, not gated).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    /// Line of the opening ```feature fence.
    pub line: usize,
}

#[derive(Clone, Debug, Serialize)]
pub enum Element {
    Checklist {
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        when: Option<String>,
        line: usize,
    },
    AudioLink {
        src: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        when: Option<String>,
        line: usize,
    },
    Feature(FeatureBlock),
}

/// One conditional segment of a page's markdown. Chunks with a `when`
/// condition render only when the condition holds against the run
/// context; a page without conditionals is a single unconditional chunk.
#[derive(Clone, Debug, Serialize)]
pub struct RawChunk {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct Page {
    pub elements: Vec<Element>,
    /// The page's markdown text with feature fences and checklist lines
    /// stripped — those render as dedicated components, not markdown.
    #[serde(default)]
    pub raw: String,
    /// The same markdown split at `{{#if}}` boundaries so the runner can
    /// filter chunks by their condition. A page without conditionals has
    /// exactly one chunk whose `when` is absent.
    #[serde(default)]
    pub raw_chunks: Vec<RawChunk>,
    /// Page-level condition: an `@when <expr>` line as the page's first
    /// content line. A false condition skips the entire page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
}

/// One open `{{#if}}` block while scanning a page: the branch predicate
/// text and whether we are past the `{{#else}}` marker.
struct CondFrame {
    pred: String,
    in_else: bool,
    else_seen: bool,
    line: usize,
}

/// Error message for the common inline-form mistake. Markers must each be
/// on their own line; the engine gates whole lines/elements, so a one-line
/// `{{#if x}} ... {{/if}}` cannot be supported.
const INLINE_IF_MSG: &str = "`{{#if}}` / `{{/if}}` must be on their own lines — \
    inline forms like `{{#if x}}- [ ] item{{/if}}` are not supported. \
    Put the markers on separate lines.";

/// The effective condition for a line: the conjunction of every open
/// frame's branch predicate (else-branches contribute `not(pred)`).
/// `None` when no `{{#if}}` is open (unconditional text).
fn effective_condition(stack: &[CondFrame]) -> Option<String> {
    if stack.is_empty() {
        return None;
    }
    let parts: Vec<String> = stack
        .iter()
        .map(|f| {
            if f.in_else {
                format!("not({})", f.pred)
            } else {
                f.pred.clone()
            }
        })
        .collect();
    Some(parts.join(" and "))
}

/// Split a body into pages on `---` lines and extract the gated elements
/// (checklist items, `.xml` audio links, feature blocks) from each page.
/// `first_line` is the 1-based file line of the first body line.
///
/// Conditional syntax (evaluated at run time against the run context):
///   - `@when <expr>` as a page's first content line — whole-page gate.
///   - `{{#if <expr>}}` / `{{#else}}` / `{{/if}}` on their own lines —
///     gate the markdown text and checklist items between the markers.
///     Nesting composes by conjunction; markers are stripped from `raw`.
pub fn parse_pages(body: &str, first_line: usize) -> (Vec<Page>, Vec<Diag>) {
    let mut diags = Vec::new();
    let lines: Vec<&str> = body.lines().collect();

    // Pre-pass: locate and fully parse every ```feature block, so the
    // main loop can emit each as one element and skip its interior
    // (config lines must not be mistaken for page separators etc.).
    let mut features: Vec<(usize, usize, Option<FeatureBlock>)> = Vec::new(); // (open, end, block)
    for (span, span_diags) in scan_feature_spans(&lines) {
        diags.extend(span_diags);
        let (block, block_diags) = parse_feature_span(&lines, &span, first_line);
        diags.extend(block_diags);
        features.push((span.open, span.end, block));
    }

    let mut pages: Vec<Page> = vec![Page::default()];
    let mut current: Vec<Element> = Vec::new();
    let mut raw_lines: Vec<String> = Vec::new();
    let mut raw_chunks: Vec<RawChunk> = Vec::new();
    let mut page_has_text = false;
    let mut in_plain_code = false;
    let mut skip_until = 0usize; // feature interior: skip lines < skip_until
    let mut cond_stack: Vec<CondFrame> = Vec::new();

    // Push a raw markdown line into the chunk list under the line's
    // effective condition (merging consecutive lines with the same one).
    let push_raw = |raw_chunks: &mut Vec<RawChunk>, raw_lines: &mut Vec<String>, line: &str, when: Option<String>| {
        raw_lines.push(line.to_string());
        if let Some(last) = raw_chunks.last_mut() {
            if last.when == when {
                last.text.push('\n');
                last.text.push_str(line);
                return;
            }
        }
        raw_chunks.push(RawChunk {
            text: line.to_string(),
            when,
        });
    };

    for (i, raw) in lines.iter().enumerate() {
        if i < skip_until {
            continue;
        }
        let line_no = first_line + i;
        let line = raw.trim_start();

        // Plain (non-feature) fenced code block: skip contents entirely.
        if in_plain_code {
            if line.starts_with("```") {
                in_plain_code = false;
            } else if !raw.trim().is_empty() {
                page_has_text = true;
            }
            let when = effective_condition(&cond_stack);
            push_raw(&mut raw_chunks, &mut raw_lines, raw, when);
            continue;
        }

        if let Some(info) = line.strip_prefix("```") {
            page_has_text = true;
            if info.trim() == "feature" {
                if let Some(pos) = features.iter().position(|(open, _, _)| *open == i) {
                    let (_, end, mut block) = features.remove(pos);
                    if let Some(b) = block.as_mut() {
                        // A feature inside `{{#if}}` inherits the enclosing
                        // condition, ANDed with its own `when:` config key.
                        if let Some(enclosing) = effective_condition(&cond_stack) {
                            b.when = Some(match b.when.take() {
                                Some(w) => format!("({w}) and ({enclosing})"),
                                None => enclosing,
                            });
                        }
                    }
                    if let Some(b) = block {
                        current.push(Element::Feature(b));
                    }
                    skip_until = end;
                }
            } else {
                in_plain_code = true;
            }
            continue;
        }

        // Conditional markers — recognized only as whole (trimmed) lines.
        let trimmed = line.trim();
        if trimmed.starts_with("{{#if ") {
            // A marker must be the entire line: inline forms like
            // `{{#if x}} - [ ] item{{/if}}` on one line are not supported
            // (the engine gates whole lines/elements). Catch the common
            // mistakes with actionable messages instead of a confusing
            // condition-parse error + spurious "never closed".
            let after = &trimmed["{{#if ".len()..];
            if after.contains("{{") {
                // Another `{{...}}` on the line — a closer (or stray
                // marker) glued after the opener's `}}`.
                if after.contains("{{/if") {
                    diags.push(error_at(Some(line_no), INLINE_IF_MSG));
                } else {
                    diags.push(error_at(Some(line_no), "`{{#if}}` must be on its own line"));
                }
            } else if after.ends_with("}}") {
                let pred = after[..after.len() - 2].trim();
                if pred.is_empty() {
                    diags.push(error_at(
                        Some(line_no),
                        "`{{#if}}` needs a condition: `{{#if <expr>}}`",
                    ));
                } else if let Err(e) = crate::cond::parse(pred) {
                    diags.push(error_at(Some(line_no), format!("`{{{{#if}}}}` condition: {e}")));
                }
                cond_stack.push(CondFrame {
                    pred: pred.to_string(),
                    in_else: false,
                    else_seen: false,
                    line: line_no,
                });
            } else {
                // Prose trailing the opener's `}}` on the same line.
                diags.push(error_at(Some(line_no), "`{{#if}}` must be on its own line"));
            }
            continue;
        }
        if trimmed == "{{#else}}" {
            match cond_stack.last_mut() {
                Some(f) if !f.else_seen => {
                    f.in_else = true;
                    f.else_seen = true;
                }
                Some(f) if f.else_seen => diags.push(error_at(
                    Some(line_no),
                    format!("`{{{{#else}}}}` twice for the same `{{{{#if}}}}` (opened line {})", f.line),
                )),
                _ => diags.push(error_at(
                    Some(line_no),
                    "`{{#else}}` without an open `{{#if}}`",
                )),
            }
            continue;
        }
        if trimmed == "{{/if}}" {
            match cond_stack.pop() {
                Some(_) => {}
                None => diags.push(error_at(
                    Some(line_no),
                    "`{{/if}}` without a matching `{{#if}}`",
                )),
            }
            continue;
        }
        if trimmed.starts_with("{{/if") {
            diags.push(error_at(Some(line_no), "`{{/if}}` must be on its own line"));
            continue;
        }
        if trimmed.starts_with("{{#else") {
            diags.push(error_at(Some(line_no), "`{{#else}}` must be on its own line"));
            continue;
        }
        // A marker anywhere else in the line (mid-prose, glued to text) is
        // not supported — markers gate whole lines/elements.
        if trimmed.contains("{{#if") || trimmed.contains("{{#else") || trimmed.contains("{{/if") {
            let which = if trimmed.contains("{{#if") {
                "`{{#if}}`"
            } else if trimmed.contains("{{#else") {
                "`{{#else}}`"
            } else {
                "`{{/if}}`"
            };
            diags.push(error_at(Some(line_no), format!("{which} must be on its own line")));
            continue;
        }

        // Page separator. A separator that would start an empty page
        // (no text, no elements) is ignored rather than creating it.
        if line.trim_end() == "---" {
            let cur = pages.last_mut().expect("always one page");
            cur.elements = std::mem::take(&mut current);
            cur.raw = std::mem::take(&mut raw_lines).join("\n");
            cur.raw_chunks = std::mem::take(&mut raw_chunks);
            if !cur.elements.is_empty() || page_has_text {
                pages.push(Page::default());
            }
            page_has_text = false;
            continue;
        }

        if line.trim().is_empty() {
            let when = effective_condition(&cond_stack);
            push_raw(&mut raw_chunks, &mut raw_lines, raw, when);
            continue;
        }

        // `@when <expr>` as a page's first content line gates the page.
        if !page_has_text && trimmed.starts_with("@when ") {
            let expr = trimmed["@when ".len()..].trim();
            if let Err(e) = crate::cond::parse(expr) {
                diags.push(error_at(Some(line_no), format!("`@when` condition: {e}")));
            }
            if pages.last_mut().expect("always one page").when.is_some() {
                diags.push(error_at(
                    Some(line_no),
                    "`@when` twice on one page (it must be the first content line)",
                ));
            }
            pages.last_mut().expect("always one page").when = Some(expr.to_string());
            page_has_text = true;
            continue;
        }
        page_has_text = true;
        let when = effective_condition(&cond_stack);

        // Checklist item: `- [ ] label` / `* [x] label` / `+ [ ] label`.
        // Excluded from `raw` — rendered as an interactive toggle.
        if let Some(label) = checklist_label(line) {
            current.push(Element::Checklist {
                label: label.to_string(),
                when: when.clone(),
                line: line_no,
            });
            continue;
        }

        // Markdown links to .xml scripts.
        for src in audio_links_in_line(line) {
            current.push(Element::AudioLink {
                src,
                when: when.clone(),
                line: line_no,
            });
        }
        push_raw(&mut raw_chunks, &mut raw_lines, raw, when);
    }

    for f in &cond_stack {
        diags.push(error_at(
            Some(f.line),
            "`{{#if}}` is never closed (missing `{{/if}}`)",
        ));
    }

    let last_empty = {
        let last = pages.last_mut().expect("always one page");
        last.elements = current;
        last.raw = raw_lines.join("\n");
        last.raw_chunks = raw_chunks;
        last.elements.is_empty()
    };
    // Drop a trailing page that is entirely empty (body ended with `---`).
    if pages.len() > 1 && last_empty && !page_has_text {
        pages.pop();
    }
    (pages, diags)
}

/// Label text of a markdown checkbox line, or None.
fn checklist_label(line: &str) -> Option<&str> {
    let t = line.trim_start();
    let t = t
        .strip_prefix(['-', '*', '+'])
        .map(str::trim_start)
        .unwrap_or(t);
    let lower = t.to_ascii_lowercase();
    let after = lower
        .strip_prefix("[ ] ")
        .or_else(|| lower.strip_prefix("[x] "))
        .map(|_| &t[4.min(t.len())..])?;
    let label = after.trim();
    if label.is_empty() {
        None
    } else {
        Some(label)
    }
}

/// Extract markdown link targets ending in `.xml` from one line
/// (in-app links only; `http(s)://…` skipped). Images are ignored.
fn audio_links_in_line(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' && (i == 0 || bytes[i - 1] != b'!') {
            if let Some(cb) = line[i + 1..].find(']').map(|j| i + 1 + j) {
                if bytes.get(cb + 1) == Some(&b'(') {
                    if let Some(cp) = line[cb + 2..].find(')').map(|j| cb + 2 + j) {
                        let target = line[cb + 2..cp].trim();
                        let target = target.split('#').next().unwrap_or(target).trim();
                        if target.to_ascii_lowercase().ends_with(".xml")
                            && !target.contains("://")
                            && !target.is_empty()
                        {
                            out.push(target.to_string());
                        }
                        i = cp;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    out
}

/// A ```feature fenced block located in a body: byte-independent,
/// described by the index of its opening line within `body.lines()`.
struct FeatureSpan {
    /// Index (0-based) of the ```feature line.
    open: usize,
    /// Index of the line after the closing fence.
    end: usize,
}

/// Pre-pass: find all ```feature spans in the body, so the line loop in
/// `parse_pages` can skip over them wholesale.
fn scan_feature_spans(lines: &[&str]) -> Vec<(FeatureSpan, Vec<Diag>)> {
    let mut spans = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim_start();
        let is_feature_fence = line
            .strip_prefix("```")
            .map(|info| info.trim() == "feature")
            .unwrap_or(false);
        if is_feature_fence {
            let mut j = i + 1;
            let mut separator = None;
            while j < lines.len() {
                let l = lines[j].trim_start();
                if l.starts_with("```") {
                    break;
                }
                if separator.is_none() && l.trim_end() == "---" {
                    separator = Some(j);
                }
                j += 1;
            }
            if j >= lines.len() {
                spans.push((
                    FeatureSpan {
                        open: i,
                        end: lines.len(),
                    },
                    vec![error_at(
                        Some(i + 1),
                        "feature block is never closed (missing closing ```)",
                    )],
                ));
                break;
            }
            let mut diags = Vec::new();
            if separator.is_none() {
                diags.push(error_at(
                    Some(i + 1),
                    "feature block needs a `---` line separating config from body",
                ));
            }
            spans.push((
                FeatureSpan {
                    open: i,
                    end: j + 1,
                },
                diags,
            ));
            i = j + 1;
        } else {
            i += 1;
        }
    }
    spans
}

/// Parse the feature block starting at `lines[span.open]` (the ```feature
/// line). Returns the block (if it parsed far enough to have a type) and
/// diagnostics.
fn parse_feature_span(
    lines: &[&str],
    span: &FeatureSpan,
    first_line: usize,
) -> (Option<FeatureBlock>, Vec<Diag>) {
    let mut diags = Vec::new();
    // Config = lines after the fence until the `---` separator (or the
    // closing fence if the separator is missing — already diagnosed).
    let mut sep = span.end - 1; // closing fence index
    for (idx, l) in lines
        .iter()
        .enumerate()
        .take(span.end - 1)
        .skip(span.open + 1)
    {
        if l.trim() == "---" {
            sep = idx;
            break;
        }
    }
    let config_text = lines[span.open + 1..sep].join("\n");
    let body = if sep < span.end - 1 {
        lines[sep + 1..span.end - 1].join("\n")
    } else {
        String::new()
    };
    let (config, mut kv_diags) = parse_kv_block(&config_text, first_line + span.open + 1);
    diags.append(&mut kv_diags);

    let line = first_line + span.open;
    let ftype = match config.get("type") {
        Some(FValue::Str(s)) if !s.trim().is_empty() => s.trim().to_string(),
        Some(_) => {
            diags.push(error_at(Some(line), "feature `type` must be a string"));
            return (None, diags);
        }
        None => {
            diags.push(error_at(
                Some(line),
                "feature block is missing a `type` (first config line)",
            ));
            return (None, diags);
        }
    };
    // `when` is cross-cutting: take it out of the config so per-type
    // unknown-key warnings don't fire, and syntax-check the expression.
    let mut config = config;
    let when = match config.remove("when") {
        None => None,
        Some(FValue::Str(s)) if !s.trim().is_empty() => {
            if let Err(e) = crate::cond::parse(&s) {
                diags.push(error_at(Some(line), format!("feature `when`: {e}")));
            }
            Some(s.trim().to_string())
        }
        Some(FValue::Str(_)) => {
            diags.push(error_at(Some(line), "feature `when` must not be empty"));
            None
        }
        Some(_) => {
            diags.push(error_at(Some(line), "feature `when` must be a condition string"));
            None
        }
    };
    let block = FeatureBlock {
        ftype,
        config,
        body,
        when,
        line,
    };
    diags.extend(validate_feature(&block));
    (Some(block), diags)
}

/// Valid voice analyzers (the six existing trackers).
pub const VOICE_ANALYZERS: &[&str] = &[
    "pitch",
    "resonance",
    "intonation",
    "weight",
    "loudness",
    "genderspace",
];

const FEATURE_TYPES: &[&str] = &[
    "voice", "wait", "chastity", "input", "choice", "slider", "audio",
];

/// Validate a feature's `field` answer key (required on `input`, optional
/// on `choice`/`slider`): an identifier the answer is stored under, which
/// makes it addressable in `when:` conditions and `{{ }}` interpolation.
/// Reserved engine variable names cannot be shadowed.
fn check_answer_field(c: &FMap, ctx: &str, line: usize, required: bool, diags: &mut Vec<Diag>) {
    let valid = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    };
    match c.get("field") {
        Some(FValue::Str(s)) if valid(s) => {
            if crate::cond::RESERVED_VARS.contains(&s.as_str()) {
                diags.push(error_at(
                    Some(line),
                    format!("{ctx}: `field: {s}` collides with a reserved run variable"),
                ));
            }
        }
        Some(FValue::Str(_)) => diags.push(error_at(
            Some(line),
            format!("{ctx}: `field` must be an identifier (letters, digits, `-`, `_`)"),
        )),
        Some(_) => diags.push(error_at(
            Some(line),
            format!("{ctx}: `field` must be an identifier (letters, digits, `-`, `_`)"),
        )),
        None => {
            if required {
                diags.push(error_at(
                    Some(line),
                    format!("{ctx}: `field` is required (identifier for the stored answer)"),
                ));
            }
        }
    }
}

/// Per-type semantic validation of a feature block's config.
fn validate_feature(b: &FeatureBlock) -> Vec<Diag> {
    let ctx = format!("feature `{}` (line {})", b.ftype, b.line);
    let mut diags = Vec::new();
    let c = &b.config;

    if !FEATURE_TYPES.contains(&b.ftype.as_str()) {
        diags.push(error_at(
            Some(b.line),
            format!(
                "unknown feature type `{}` — known types: {}",
                b.ftype,
                FEATURE_TYPES.join(", ")
            ),
        ));
        return diags;
    }

    // `required` is common to the interactive types.
    if c.has("required") {
        get_bool(c, "required", &ctx, &mut diags);
    }

    match b.ftype.as_str() {
        "voice" => {
            let known = &[
                "type",
                "analyzers",
                "minHz",
                "maxHz",
                "targetHz",
                "targetCentroid",
                "targetDb",
                "requiredScore",
                "holdRatio",
                "duration",
                "required",
                "displayMinHz",
                "displayMaxHz",
            ];
            warn_unknown_keys(c, known, &ctx, &mut diags);
            match c.get("analyzers") {
                None => {}
                Some(FValue::Str(s)) => {
                    for a in s.split(',') {
                        let a = a.trim();
                        if !VOICE_ANALYZERS.contains(&a) {
                            diags.push(error_at(
                                Some(b.line),
                                format!(
                                    "{ctx}: unknown analyzer `{a}` — use: {}",
                                    VOICE_ANALYZERS.join(", ")
                                ),
                            ));
                        }
                    }
                }
                Some(FValue::List(items)) => {
                    for item in items {
                        match item {
                            FValue::Str(a) if VOICE_ANALYZERS.contains(&a.as_str()) => {}
                            other => diags.push(error_at(
                                Some(b.line),
                                format!(
                                    "{ctx}: `analyzers` entries must be strings from: {} (got {other:?})",
                                    VOICE_ANALYZERS.join(", ")
                                ),
                            )),
                        }
                    }
                }
                Some(_) => diags.push(error_at(
                    Some(b.line),
                    format!("{ctx}: `analyzers` must be a comma-separated string or array"),
                )),
            }
            let min = get_num(c, "minHz", &ctx, &mut diags);
            let max = get_num(c, "maxHz", &ctx, &mut diags);
            if let (Some(min), Some(max)) = (min, max) {
                if min >= max {
                    diags.push(error_at(
                        Some(b.line),
                        format!("{ctx}: `minHz` ({min}) must be below `maxHz` ({max})"),
                    ));
                }
            }
            if let Some(target) = get_num(c, "targetHz", &ctx, &mut diags) {
                if let (Some(min), Some(max)) = (min, max) {
                    if target < min || target > max {
                        diags.push(warn_at(
                            Some(b.line),
                            format!(
                                "{ctx}: `targetHz` ({target}) lies outside the [{min}, {max}] band"
                            ),
                        ));
                    }
                }
            }
            for (key, lo, hi) in [("requiredScore", 0.0, 1.0), ("holdRatio", 0.0, 1.0)] {
                if let Some(v) = get_num(c, key, &ctx, &mut diags) {
                    if !(lo..=hi).contains(&v) {
                        diags.push(error_at(
                            Some(b.line),
                            format!("{ctx}: `{key}` must be between {lo} and {hi}"),
                        ));
                    }
                }
            }
            req_duration(c, "duration", &ctx, &mut diags);
        }
        "wait" => {
            warn_unknown_keys(c, &["type", "duration", "required"], &ctx, &mut diags);
            req_duration(c, "duration", &ctx, &mut diags);
        }
        "chastity" => {
            warn_unknown_keys(c, &["type", "state", "required"], &ctx, &mut diags);
            match c.get("state").and_then(|v| match v {
                FValue::Str(s) => Some(s.as_str()),
                _ => None,
            }) {
                Some("locked") | Some("unlocked") => {}
                None => diags.push(error_at(
                    Some(b.line),
                    format!("{ctx}: `state` is required (`locked` or `unlocked`)"),
                )),
                Some(_) => diags.push(error_at(
                    Some(b.line),
                    format!("{ctx}: `state` must be `locked` or `unlocked`"),
                )),
            }
        }
        "input" => {
            warn_unknown_keys(c, &["type", "field", "required"], &ctx, &mut diags);
            check_answer_field(c, &ctx, b.line, true, &mut diags);
        }
        "choice" => {
            warn_unknown_keys(c, &["type", "options", "field", "required"], &ctx, &mut diags);
            check_answer_field(c, &ctx, b.line, false, &mut diags);
            let options = match c.get("options") {
                Some(FValue::Str(s)) => s
                    .split('|')
                    .map(str::trim)
                    .filter(|o| !o.is_empty())
                    .count(),
                Some(FValue::List(items)) => items.len(),
                Some(_) => 0,
                None => {
                    diags.push(error_at(
                        Some(b.line),
                        format!("{ctx}: `options` is required (`A|B|C` string or array)"),
                    ));
                    0
                }
            };
            if c.has("options") && options < 2 {
                diags.push(error_at(
                    Some(b.line),
                    format!("{ctx}: `options` needs at least 2 entries"),
                ));
            }
        }
        "slider" => {
            warn_unknown_keys(
                c,
                &["type", "min", "max", "label", "field", "required"],
                &ctx,
                &mut diags,
            );
            check_answer_field(c, &ctx, b.line, false, &mut diags);
            let min = req_num(c, "min", &ctx, &mut diags);
            let max = req_num(c, "max", &ctx, &mut diags);
            if let (Some(min), Some(max)) = (min, max) {
                if max <= min {
                    diags.push(error_at(
                        Some(b.line),
                        format!("{ctx}: `max` ({max}) must be greater than `min` ({min})"),
                    ));
                }
            }
            req_str(c, "label", &ctx, &mut diags);
        }
        "audio" => {
            warn_unknown_keys(c, &["type", "src"], &ctx, &mut diags);
            if let Some(src) = req_str(c, "src", &ctx, &mut diags) {
                if !src.to_ascii_lowercase().ends_with(".xml") {
                    diags.push(error_at(
                        Some(b.line),
                        format!("{ctx}: `src` must point to a `.xml` TTS script"),
                    ));
                }
            }
        }
        _ => unreachable!("handled above"),
    }
    diags
}

// ============================================================================
// Actions
// ============================================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Habits,
    Routines,
    Tasks,
    All,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WeightedOutcome {
    pub weight: u64,
    pub action: Action,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Action {
    Points { delta: i64 },
    Task { template: String },
    Script { src: String },
    Notification { text: String },
    Exemption { duration_secs: u64, scope: Scope },
    Roulette { outcomes: Vec<WeightedOutcome> },
}

const MAX_ROULETTE_DEPTH: usize = 3;

/// Parse `success` / `failure` / store `action`: a single action object
/// or an array of them.
fn get_actions(map: &FMap, key: &str, diags: &mut Vec<Diag>) -> Vec<Action> {
    let ctx = format!("`{key}`");
    match map.get(key) {
        None => Vec::new(),
        Some(v) => parse_actions(v, &ctx, 0, diags),
    }
}

fn parse_actions(v: &FValue, ctx: &str, depth: usize, diags: &mut Vec<Diag>) -> Vec<Action> {
    match v {
        FValue::Map(_) => match parse_action(v, ctx, depth, diags) {
            Some(a) => vec![a],
            None => Vec::new(),
        },
        FValue::List(items) => items
            .iter()
            .filter_map(|item| parse_action(item, ctx, depth, diags))
            .collect(),
        _ => {
            diags.push(error_at(
                None,
                format!("{ctx} must be an action object or an array of them"),
            ));
            Vec::new()
        }
    }
}

fn parse_action(v: &FValue, ctx: &str, depth: usize, diags: &mut Vec<Diag>) -> Option<Action> {
    let FValue::Map(map) = v else {
        diags.push(error_at(
            None,
            format!("{ctx} must be an action object with a `type`"),
        ));
        return None;
    };
    let typ = match map.get("type") {
        Some(FValue::Str(s)) => s.clone(),
        _ => {
            diags.push(error_at(
                None,
                format!("{ctx} is missing a string `type` (points, task, script, notification, exemption, roulette)"),
            ));
            return None;
        }
    };
    let sub_ctx = format!("{ctx} ({typ})");
    match typ.as_str() {
        "points" => {
            let delta = req_int(map, "delta", &sub_ctx, diags)?;
            warn_unknown_keys(map, &["type", "delta"], &sub_ctx, diags);
            Some(Action::Points { delta })
        }
        "task" => {
            let template = req_str(map, "template", &sub_ctx, diags)?;
            if template.contains("..") {
                diags.push(error_at(
                    None,
                    format!("{sub_ctx}: `template` must be a task name or `tasks/<name>.md` path"),
                ));
                return None;
            }
            warn_unknown_keys(map, &["type", "template"], &sub_ctx, diags);
            Some(Action::Task { template })
        }
        "script" => {
            let src = req_str(map, "src", &sub_ctx, diags)?;
            if !src.to_ascii_lowercase().ends_with(".xml") {
                diags.push(error_at(
                    None,
                    format!("{sub_ctx}: `src` must point to a `.xml` TTS script"),
                ));
                return None;
            }
            warn_unknown_keys(map, &["type", "src"], &sub_ctx, diags);
            Some(Action::Script { src })
        }
        "notification" => {
            let text = req_str(map, "text", &sub_ctx, diags)?;
            warn_unknown_keys(map, &["type", "text"], &sub_ctx, diags);
            Some(Action::Notification { text })
        }
        "exemption" => {
            let duration_secs = req_duration(map, "duration", &sub_ctx, diags)?;
            let scope = match map.get("scope") {
                Some(FValue::Str(s)) => match s.as_str() {
                    "habits" => Scope::Habits,
                    "routines" => Scope::Routines,
                    "tasks" => Scope::Tasks,
                    "all" => Scope::All,
                    other => {
                        diags.push(error_at(
                            None,
                            format!(
                                "{sub_ctx}: `scope` must be habits, routines, tasks, or all (got `{other}`)"
                            ),
                        ));
                        return None;
                    }
                },
                _ => {
                    diags.push(error_at(
                        None,
                        format!("{sub_ctx}: `scope` is required (habits, routines, tasks, all)"),
                    ));
                    return None;
                }
            };
            warn_unknown_keys(map, &["type", "duration", "scope"], &sub_ctx, diags);
            Some(Action::Exemption {
                duration_secs,
                scope,
            })
        }
        "roulette" => {
            if depth >= MAX_ROULETTE_DEPTH {
                diags.push(error_at(
                    None,
                    format!(
                        "{sub_ctx}: roulette may not nest deeper than {MAX_ROULETTE_DEPTH} levels"
                    ),
                ));
                return None;
            }
            let Some(FValue::List(items)) = map.get("outcomes") else {
                diags.push(error_at(
                    None,
                    format!("{sub_ctx}: `outcomes` must be an array of {{ weight, action }}"),
                ));
                return None;
            };
            if items.len() < 2 {
                diags.push(error_at(
                    None,
                    format!("{sub_ctx}: roulette needs at least 2 outcomes"),
                ));
                return None;
            }
            let mut outcomes = Vec::new();
            for (i, item) in items.iter().enumerate() {
                let item_ctx = format!("{sub_ctx} outcomes[{i}]");
                let FValue::Map(om) = item else {
                    diags.push(error_at(
                        None,
                        format!("{item_ctx} must be an object with `weight` and `action`"),
                    ));
                    continue;
                };
                let weight = match om.get("weight") {
                    Some(FValue::Int(w)) if *w >= 0 => *w as u64,
                    None => 1, // weight is optional, default 1
                    Some(_) => {
                        diags.push(error_at(
                            None,
                            format!("{item_ctx}: `weight` must be a non-negative integer"),
                        ));
                        continue;
                    }
                };
                let action = match om.get("action") {
                    Some(a) => match parse_action(a, &item_ctx, depth + 1, diags) {
                        Some(a) => a,
                        None => continue,
                    },
                    None => {
                        diags.push(error_at(None, format!("{item_ctx}: `action` is required")));
                        continue;
                    }
                };
                outcomes.push(WeightedOutcome { weight, action });
            }
            if outcomes.iter().map(|o| o.weight).sum::<u64>() == 0 {
                diags.push(error_at(
                    None,
                    format!("{sub_ctx}: total weight is 0 — at least one outcome needs weight > 0"),
                ));
                return None;
            }
            warn_unknown_keys(map, &["type", "outcomes"], &sub_ctx, diags);
            Some(Action::Roulette { outcomes })
        }
        other => {
            diags.push(error_at(
                None,
                format!(
                    "{ctx}: unknown action type `{other}` — use points, task, script, \
                     notification, exemption, or roulette"
                ),
            ));
            None
        }
    }
}

/// References embedded in a list of actions, for the validator's
/// existence checks.
#[derive(Default)]
pub struct ActionRefs {
    pub scripts: Vec<String>,
    pub templates: Vec<String>,
}

pub fn collect_action_refs(actions: &[Action], out: &mut ActionRefs) {
    for a in actions {
        match a {
            Action::Script { src } => out.scripts.push(src.clone()),
            Action::Task { template } => out.templates.push(template.clone()),
            Action::Roulette { outcomes } => {
                for o in outcomes {
                    collect_action_refs(std::slice::from_ref(&o.action), out);
                }
            }
            _ => {}
        }
    }
}

/// True if any action in the list awards a positive point delta.
fn awards_positive_points(actions: &[Action]) -> bool {
    actions.iter().any(|a| match a {
        Action::Points { delta } => *delta > 0,
        Action::Roulette { outcomes } => outcomes
            .iter()
            .any(|o| matches!(&o.action, Action::Points { delta } if *delta > 0)),
        _ => false,
    })
}

// ============================================================================
// Containers
// ============================================================================

#[derive(Clone, Debug, Serialize)]
pub struct Limit {
    pub daily: Option<u64>,
    pub total: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Routine {
    pub title: String,
    pub schedule: Option<String>,
    pub timeframe_secs: Option<u64>,
    pub cooldown_secs: Option<u64>,
    pub limit: Option<Limit>,
    pub success: Vec<Action>,
    pub failure: Vec<Action>,
    pub pages: Vec<Page>,
}

/// Line number (1-based) of the first body line, given the front-matter.
fn body_first_line(fm: &Option<String>) -> usize {
    match fm {
        Some(fm) => fm.lines().count() + 3, // opening ---, fm lines, closing ---
        None => 1,
    }
}

/// Parse a `routines/*.md` file. v2 requires `format: 2` (the marker is
/// what routes the file away from the v1 schedule-only parser).
pub fn parse_routine(content: &str) -> (Option<Routine>, Vec<Diag>) {
    let mut diags = Vec::new();
    let (fm, body) = split_frontmatter(content);
    let Some(fm) = fm else {
        diags.push(error_at(
            None,
            "routine has no front-matter — start the file with a `---` block",
        ));
        return (None, diags);
    };
    let (map, kv_diags) = parse_kv_block(&fm, 2);
    diags.extend(kv_diags);

    // `format: 2` is mandatory — without it the file is not a valid
    // routine and callers skip it entirely.
    match map.get("format") {
        Some(FValue::Int(2)) => {}
        Some(FValue::Str(s)) if s == "2" => {}
        _ => {
            diags.push(error_at(None, "routines require `format: 2` in the front-matter"));
            return (None, diags);
        }
    }

    let title = req_str(&map, "title", "routine", &mut diags).unwrap_or_default();
    let schedule = get_cron(&map, "schedule", "routine", &mut diags);
    let timeframe_secs = get_duration(&map, "timeframe", "routine", &mut diags);
    let cooldown_secs = get_duration(&map, "cooldown", "routine", &mut diags);
    let success = get_actions(&map, "success", &mut diags);
    let failure = get_actions(&map, "failure", &mut diags);

    let limit = parse_limit(&map, &mut diags);
    warn_unknown_keys(
        &map,
        &[
            "format",
            "title",
            "schedule",
            "timeframe",
            "success",
            "failure",
            "cooldown",
            "limit",
        ],
        "routine",
        &mut diags,
    );

    // Anti-farming: on-demand + positive points + no explicit limit.
    if schedule.is_none()
        && awards_positive_points(&success)
        && limit
            .as_ref()
            .is_none_or(|l| l.daily.is_none() && l.total.is_none())
    {
        diags.push(warn_at(
            None,
            "on-demand routine awards positive points but sets no `limit` — the default \
             `limit: { daily: 1 }` applies; set `limit` explicitly to silence this",
        ));
    }

    let (pages, page_diags) = parse_pages(&body, body_first_line(&Some(fm.clone())));
    diags.extend(page_diags);
    if pages.iter().all(|p| p.elements.is_empty()) && body.trim().is_empty() {
        diags.push(warn_at(None, "routine body is empty"));
    }

    (
        Some(Routine {
            title,
            schedule,
            timeframe_secs,
            cooldown_secs,
            limit,
            success,
            failure,
            pages,
        }),
        diags,
    )
}

fn parse_limit(map: &FMap, diags: &mut Vec<Diag>) -> Option<Limit> {
    match map.get("limit") {
        None => None,
        Some(FValue::Map(l)) => {
            let daily = get_int(l, "daily", "`limit`", diags);
            let total = get_int(l, "total", "`limit`", diags);
            for (k, v) in [("daily", daily), ("total", total)] {
                if let Some(v) = v {
                    if v < 1 {
                        diags.push(error_at(None, format!("`limit.{k}` must be ≥ 1 (got {v})")));
                    }
                }
            }
            if daily.is_none() && total.is_none() {
                diags.push(error_at(
                    None,
                    "`limit` needs `daily` and/or `total` (both missing)",
                ));
            }
            Some(Limit {
                daily: daily.map(|v| v as u64),
                total: total.map(|v| v as u64),
            })
        }
        Some(_) => {
            diags.push(error_at(
                None,
                "`limit` must be a map like { \"daily\": 1, \"total\": 3 }",
            ));
            None
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HabitType {
    Max,
    Min,
}

#[derive(Clone, Debug, Serialize)]
pub struct Habit {
    pub title: String,
    pub htype: HabitType,
    pub count: u64,
    pub success: Vec<Action>,
    pub failure: Vec<Action>,
    /// Markdown body below the front-matter (shown in the habit inspector).
    pub body: String,
}

/// Parse a `habits/*.md` file. Habits are always v2; a `format:` key is
/// accepted but optional (must be 2 if present).
pub fn parse_habit(content: &str) -> (Option<Habit>, Vec<Diag>) {
    let mut diags = Vec::new();
    let (fm, body) = split_frontmatter(content);
    let Some(fm) = fm else {
        diags.push(error_at(
            None,
            "habit has no front-matter — start the file with a `---` block",
        ));
        return (None, diags);
    };
    let (map, kv_diags) = parse_kv_block(&fm, 2);
    diags.extend(kv_diags);

    match map.get("format") {
        None => {}
        Some(FValue::Int(2)) => {}
        _ => diags.push(error_at(None, "`format` must be 2")),
    }

    let title = req_str(&map, "title", "habit", &mut diags).unwrap_or_default();
    let htype = match map.get("type") {
        Some(FValue::Str(s)) if s == "max" => HabitType::Max,
        Some(FValue::Str(s)) if s == "min" => HabitType::Min,
        _ => {
            diags.push(error_at(
                None,
                "habit `type` is required and must be `max` (stay under the count) or \
                 `min` (reach the count)",
            ));
            HabitType::Max
        }
    };
    let count = match get_int(&map, "count", "habit", &mut diags) {
        Some(c) if c >= 0 => c as u64,
        Some(c) => {
            diags.push(error_at(
                None,
                format!("habit `count` must be ≥ 0 (got {c})"),
            ));
            0
        }
        None => 1,
    };
    let success = get_actions(&map, "success", &mut diags);
    let failure = get_actions(&map, "failure", &mut diags);
    warn_unknown_keys(
        &map,
        &["format", "title", "type", "count", "success", "failure"],
        "habit",
        &mut diags,
    );

    (
        Some(Habit {
            title,
            htype,
            count,
            success,
            failure,
            body: body.trim().to_string(),
        }),
        diags,
    )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TimeoutRule {
    pub after_secs: u64,
    pub actions: Vec<Action>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TaskTemplate {
    pub title: String,
    pub description: Option<String>,
    pub timeframe_secs: Option<u64>,
    pub timeouts: Vec<TimeoutRule>,
    pub max_timeout_secs: Option<u64>,
    pub success: Vec<Action>,
    pub failure: Vec<Action>,
    pub pages: Vec<Page>,
}

/// Parse a `tasks/*.md` file (task templates are always v2).
pub fn parse_task(content: &str) -> (Option<TaskTemplate>, Vec<Diag>) {
    let mut diags = Vec::new();
    let (fm, body) = split_frontmatter(content);
    let Some(fm) = fm else {
        diags.push(error_at(
            None,
            "task template has no front-matter — start the file with a `---` block",
        ));
        return (None, diags);
    };
    let (map, kv_diags) = parse_kv_block(&fm, 2);
    diags.extend(kv_diags);

    match map.get("format") {
        None => {}
        Some(FValue::Int(2)) => {}
        _ => diags.push(error_at(None, "`format` must be 2")),
    }

    let title = req_str(&map, "title", "task", &mut diags).unwrap_or_default();
    let description = get_str(&map, "description", "task", &mut diags);
    let timeframe_secs = get_duration(&map, "timeframe", "task", &mut diags);
    let max_timeout_secs = get_duration(&map, "max_timeout", "task", &mut diags);
    let success = get_actions(&map, "success", &mut diags);
    let failure = get_actions(&map, "failure", &mut diags);

    // timeouts: ordered list of { after, action } — flow JSON form.
    let mut timeouts = Vec::new();
    match map.get("timeouts") {
        None => {}
        Some(FValue::List(items)) => {
            for (i, item) in items.iter().enumerate() {
                let ctx = format!("`timeouts`[{i}]");
                let FValue::Map(t) = item else {
                    diags.push(error_at(
                        None,
                        format!("{ctx} must be an object with `after` and `action`"),
                    ));
                    continue;
                };
                let after_secs = get_duration(t, "after", &ctx, &mut diags);
                let actions = get_actions(t, "action", &mut diags);
                if let (Some(after_secs), true) = (after_secs, !actions.is_empty()) {
                    timeouts.push(TimeoutRule {
                        after_secs,
                        actions,
                    });
                }
            }
        }
        Some(_) => diags.push(error_at(
            None,
            "`timeouts` must be an array of { \"after\": <duration>, \"action\": {...} }",
        )),
    }
    if timeouts
        .windows(2)
        .any(|w| w[0].after_secs > w[1].after_secs)
    {
        diags.push(warn_at(
            None,
            "`timeouts` entries are not in ascending `after` order — they are evaluated \
             largest-elapsed-first, so order them small to large",
        ));
    }

    warn_unknown_keys(
        &map,
        &[
            "format",
            "title",
            "description",
            "timeframe",
            "timeouts",
            "max_timeout",
            "success",
            "failure",
        ],
        "task",
        &mut diags,
    );

    let (pages, page_diags) = parse_pages(&body, body_first_line(&Some(fm.clone())));
    diags.extend(page_diags);

    (
        Some(TaskTemplate {
            title,
            description,
            timeframe_secs,
            timeouts,
            max_timeout_secs,
            success,
            failure,
            pages,
        }),
        diags,
    )
}

#[derive(Clone, Debug, Serialize)]
pub struct StoreEntry {
    pub title: Option<String>,
    pub description: Option<String>,
    pub price: i64,
    pub stock: Option<i64>,
    pub restock: Option<String>,
    pub actions: Vec<Action>,
}

/// Parse a `store/*.json` file.
pub fn parse_store_entry(content: &str) -> (Option<StoreEntry>, Vec<Diag>) {
    let mut diags = Vec::new();
    let json = match serde_json::from_str::<serde_json::Value>(content) {
        Ok(v) => v,
        Err(e) => {
            diags.push(error_at(None, format!("invalid JSON: {e}")));
            return (None, diags);
        }
    };
    let FValue::Map(map) = json_to_fvalue(json) else {
        diags.push(error_at(None, "store entry must be a JSON object"));
        return (None, diags);
    };

    let title = get_str(&map, "title", "store entry", &mut diags);
    if title.is_none() {
        diags.push(warn_at(
            None,
            "store entry has no `title` — the economy view will show the filename",
        ));
    }
    let description = get_str(&map, "description", "store entry", &mut diags);
    let price = match get_int(&map, "price", "store entry", &mut diags) {
        Some(p) if p >= 0 => p,
        Some(p) => {
            diags.push(error_at(None, format!("`price` must be ≥ 0 (got {p})")));
            0
        }
        None => {
            diags.push(error_at(None, "`price` is required (integer ≥ 0)"));
            0
        }
    };
    let stock = match get_int(&map, "stock", "store entry", &mut diags) {
        Some(s) if s >= 0 => Some(s),
        Some(s) => {
            diags.push(error_at(None, format!("`stock` must be ≥ 0 (got {s})")));
            None
        }
        None => None,
    };
    let restock = get_cron(&map, "restock", "store entry", &mut diags);
    let actions = get_actions(&map, "action", &mut diags);
    if !map.has("action") {
        diags.push(error_at(None, "`action` is required (object or array)"));
    }
    warn_unknown_keys(
        &map,
        &[
            "title",
            "description",
            "price",
            "stock",
            "restock",
            "action",
        ],
        "store entry",
        &mut diags,
    );

    (
        Some(StoreEntry {
            title,
            description,
            price,
            stock,
            restock,
            actions,
        }),
        diags,
    )
}

// ============================================================================
// Reference extraction for the validator
// ============================================================================

/// Every condition expression in a page list, every answer `field` id
/// declared by `input`/`choice`/`slider` features, and every `{{ var }}`
/// interpolation identifier in markdown text and checklist labels. The
/// validator checks the conditions' and interpolations' identifiers
/// against the reserved run variables and these fields.
pub fn collect_condition_refs(pages: &[Page]) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut conds = Vec::new();
    let mut fields = Vec::new();
    let mut interp = Vec::new();
    let mut push_cond = |c: &Option<String>| {
        if let Some(c) = c {
            conds.push(c.clone());
        }
    };
    for page in pages {
        push_cond(&page.when);
        for chunk in &page.raw_chunks {
            push_cond(&chunk.when);
            interp.extend(crate::cond::interpolation_idents(&chunk.text));
        }
        for el in &page.elements {
            match el {
                Element::Checklist { label, when, .. } => {
                    push_cond(when);
                    interp.extend(crate::cond::interpolation_idents(label));
                }
                Element::AudioLink { when, .. } => push_cond(when),
                Element::Feature(f) => {
                    push_cond(&f.when);
                    if matches!(f.ftype.as_str(), "input" | "choice" | "slider") {
                        if let Some(FValue::Str(field)) = f.config.get("field") {
                            fields.push(field.clone());
                        }
                    }
                }
            }
        }
    }
    (conds, fields, interp)
}

/// All `.xml` scripts referenced by `audio` features across pages.
pub fn audio_feature_srcs(pages: &[Page]) -> Vec<String> {    let mut out = Vec::new();
    for page in pages {
        for el in &page.elements {
            if let Element::AudioLink { src, .. } = el {
                out.push(src.clone());
            }
            if let Element::Feature(f) = el {
                if f.ftype == "audio" {
                    if let Some(FValue::Str(src)) = f.config.get("src") {
                        out.push(src.clone());
                    }
                }
            }
        }
    }
    out
}

/// Resolve a `task` action's `template` to a path under the sandbox:
/// bare names map to `tasks/<name>.md`; explicit paths are used as-is.
pub fn template_to_path(template: &str) -> String {
    if template.ends_with(".md") {
        template.to_string()
    } else {
        format!("tasks/{template}.md")
    }
}

// ============================================================================
// Unit tests (pure; no filesystem)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn errs(diags: &[Diag]) -> Vec<String> {
        diags
            .iter()
            .filter(|d| d.severity == Severity::Error)
            .map(|d| d.message.clone())
            .collect()
    }
    fn warns(diags: &[Diag]) -> Vec<String> {
        diags
            .iter()
            .filter(|d| d.severity == Severity::Warning)
            .map(|d| d.message.clone())
            .collect()
    }

    // ── durations ──────────────────────────────────────────────────────

    #[test]
    fn durations_parse_with_units() {
        assert_eq!(parse_duration("30s").unwrap(), 30);
        assert_eq!(parse_duration("15m").unwrap(), 900);
        assert_eq!(parse_duration("4h").unwrap(), 14400);
        assert_eq!(parse_duration("2d").unwrap(), 172800);
        assert!(parse_duration("15").is_err());
        assert!(parse_duration("1.5h").is_err());
        assert!(parse_duration("m").is_err());
    }

    // ── front-matter kv ────────────────────────────────────────────────

    #[test]
    fn kv_scalars_bool_int_float_str() {
        let (map, d) = parse_kv_block("a: true\nb: 15\nc: 2.5\nd: hello world\n", 1);
        assert!(d.is_empty());
        assert_eq!(map.get("a"), Some(&FValue::Bool(true)));
        assert_eq!(map.get("b"), Some(&FValue::Int(15)));
        assert_eq!(map.get("c"), Some(&FValue::Float(2.5)));
        assert_eq!(map.get("d"), Some(&FValue::Str("hello world".into())));
    }

    #[test]
    fn kv_dotted_and_flow_json_agree() {
        let (dotted, d1) = parse_kv_block("success.type: points\nsuccess.delta: 15\n", 1);
        let (flow, d2) = parse_kv_block("success: { \"type\": \"points\", \"delta\": 15 }\n", 1);
        assert!(d1.is_empty() && d2.is_empty());
        // serde_json maps sort their keys (no preserve_order feature),
        // so compare per-key instead of structurally.
        fn as_map(v: Option<&FValue>) -> &FMap {
            match v {
                Some(FValue::Map(m)) => m,
                _ => panic!("expected a map"),
            }
        }
        for m in [as_map(dotted.get("success")), as_map(flow.get("success"))] {
            assert_eq!(m.get("type"), Some(&FValue::Str("points".into())));
            assert_eq!(m.get("delta"), Some(&FValue::Int(15)));
        }
    }

    #[test]
    fn kv_duplicate_key_is_error() {
        let (_, d) = parse_kv_block("title: a\ntitle: b\n", 1);
        assert!(errs(&d).iter().any(|m| m.contains("set more than once")));
    }

    #[test]
    fn kv_comments_and_bad_keys() {
        let (_, d) = parse_kv_block("# comment\n\n1bad: x\nno_colon_line\n", 1);
        assert_eq!(errs(&d).len(), 2);
    }

    #[test]
    fn kv_dotted_conflict_with_scalar() {
        let (_, d) = parse_kv_block("success: 5\nsuccess.delta: 15\n", 1);
        assert!(errs(&d).iter().any(|m| m.contains("conflicts")));
    }

    // ── pages & elements ───────────────────────────────────────────────

    #[test]
    fn pages_split_and_checklists() {
        let body = "intro\n- [ ] first task\n* [x] done thing\n\n---\n\npage two\n";
        let (pages, d) = parse_pages(body, 1);
        assert!(d.is_empty());
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].elements.len(), 2);
        assert!(matches!(
            &pages[0].elements[0],
            Element::Checklist { label, .. } if label == "first task"
        ));
    }

    #[test]
    fn audio_links_extracted_only_for_xml() {
        let body = "[a](hypnos/x.xml) [b](rules/y.md) [c](https://z.xml) ![i](img.xml)\n";
        let (pages, _) = parse_pages(body, 1);
        let links: Vec<&Element> = pages[0].elements.iter().collect();
        assert_eq!(links.len(), 1);
        assert!(matches!(links[0], Element::AudioLink { src, .. } if src == "hypnos/x.xml"));
    }

    #[test]
    fn feature_block_extracts_type_config_body() {
        let body = "```feature\ntype: wait\nduration: 15m\n---\nHold still.\n```\n";
        let (pages, d) = parse_pages(body, 1);
        assert!(errs(&d).is_empty(), "{d:?}");
        assert_eq!(pages.len(), 1);
        match &pages[0].elements[0] {
            Element::Feature(f) => {
                assert_eq!(f.ftype, "wait");
                assert_eq!(f.config.get("duration"), Some(&FValue::Str("15m".into())));
                assert_eq!(f.body.trim(), "Hold still.");
            }
            other => panic!("expected feature, got {other:?}"),
        }
    }

    #[test]
    fn feature_block_missing_separator_and_type() {
        let body = "```feature\nduration: 15m\n```\n";
        let (_, d) = parse_pages(body, 1);
        let messages = errs(&d);
        assert!(messages.iter().any(|m| m.contains("`---` line separating")));
        assert!(messages.iter().any(|m| m.contains("missing a `type`")));

        let body2 = "```feature\ntype: nope\n---\nx\n```\n";
        let (_, d2) = parse_pages(body2, 1);
        assert!(errs(&d2).iter().any(|m| m.contains("unknown feature type")));
    }

    #[test]
    fn unclosed_feature_block_is_error() {
        let body = "```feature\ntype: wait\nduration: 1m\n---\nnever closed\n";
        let (_, d) = parse_pages(body, 1);
        assert!(errs(&d).iter().any(|m| m.contains("never closed")));
    }

    #[test]
    fn plain_code_fences_are_not_parsed() {
        let body = "```rust\nlet x = \"- [ ] not a checklist\";\n```\n- [ ] real\n";
        let (pages, _) = parse_pages(body, 1);
        assert_eq!(pages[0].elements.len(), 1);
    }

    // ── feature validation ─────────────────────────────────────────────

    fn feature(ftype: &str, config: &str) -> Vec<Diag> {
        let body = format!("```feature\ntype: {ftype}\n{config}\n---\nbody\n```\n");
        let (_, d) = parse_pages(&body, 1);
        d
    }

    #[test]
    fn voice_validation_ranges() {
        assert!(errs(&feature(
            "voice",
            "analyzers: pitch,resonance\nminHz: 180\nmaxHz: 280\ntargetHz: 220\nduration: 30s"
        ))
        .is_empty());
        assert!(
            errs(&feature("voice", "minHz: 300\nmaxHz: 200\nduration: 30s"))
                .iter()
                .any(|m| m.contains("must be below"))
        );
        assert!(errs(&feature("voice", "duration: 30s\nrequiredScore: 1.5"))
            .iter()
            .any(|m| m.contains("`requiredScore` must be between")));
        assert!(
            errs(&feature("voice", "analyzers: pitch,bogus\nduration: 30s"))
                .iter()
                .any(|m| m.contains("unknown analyzer"))
        );
        assert!(errs(&feature("voice", "minHz: 100\nmaxHz: 200"))
            .iter()
            .any(|m| m.contains("`duration`")));
    }

    #[test]
    fn choice_slider_chastity_input_audio_validation() {
        assert!(errs(&feature("choice", "options: Yes|No")).is_empty());
        assert!(errs(&feature("choice", "options: only"))
            .iter()
            .any(|m| m.contains("at least 2")));
        assert!(errs(&feature("slider", "min: 1\nmax: 1\nlabel: x"))
            .iter()
            .any(|m| m.contains("greater")));
        assert!(errs(&feature("chastity", "state: sideways"))
            .iter()
            .any(|m| m.contains("locked")));
        assert!(errs(&feature("input", "field: has space"))
            .iter()
            .any(|m| contains_dbg(m)));
        fn contains_dbg(m: &str) -> bool {
            m.contains("`field` must be an identifier")
        }
        assert!(errs(&feature("audio", "src: hypnos/x.wav"))
            .iter()
            .any(|m| m.contains(".xml")));
    }

    #[test]
    fn unknown_feature_keys_warn() {
        let w = warns(&feature("wait", "duration: 1m\nbogus: 1"));
        assert!(w.iter().any(|m| m.contains("unknown key `bogus`")));
    }

    // ── actions ────────────────────────────────────────────────────────

    fn actions_from(fm: &str) -> Vec<Diag> {
        let (map, mut d) = parse_kv_block(fm, 1);
        let a = get_actions(&map, "success", &mut d);
        let _ = a;
        d
    }

    #[test]
    fn action_types_parse() {
        assert!(errs(&actions_from(
            "success: { \"type\": \"points\", \"delta\": 15 }"
        ))
        .is_empty());
        assert!(errs(&actions_from(
            "success: [{ \"type\": \"notification\", \"text\": \"hi\" }, { \"type\": \"task\", \"template\": \"x\" }]"
        ))
        .is_empty());
        assert!(errs(&actions_from(
            "success.type: exemption\nsuccess.duration: 24h\nsuccess.scope: habits"
        ))
        .is_empty());
        assert!(errs(&actions_from("success: { \"type\": \"bogus\" }"))
            .iter()
            .any(|m| m.contains("unknown action type")));
        assert!(errs(&actions_from("success: { \"type\": \"points\" }"))
            .iter()
            .any(|m| m.contains("`delta`")));
    }

    #[test]
    fn roulette_rules() {
        let ok = "success: { \"type\": \"roulette\", \"outcomes\": [\
                  { \"weight\": 2, \"action\": { \"type\": \"points\", \"delta\": 5 } }, \
                  { \"weight\": 1, \"action\": { \"type\": \"points\", \"delta\": -5 } }] }";
        assert!(errs(&actions_from(ok)).is_empty());

        let one = "success: { \"type\": \"roulette\", \"outcomes\": [\
                   { \"weight\": 1, \"action\": { \"type\": \"points\", \"delta\": 5 } }] }";
        assert!(errs(&actions_from(one))
            .iter()
            .any(|m| m.contains("at least 2")));

        let zero = "success: { \"type\": \"roulette\", \"outcomes\": [\
                    { \"weight\": 0, \"action\": { \"type\": \"points\", \"delta\": 5 } }, \
                    { \"weight\": 0, \"action\": { \"type\": \"points\", \"delta\": -5 } }] }";
        assert!(errs(&actions_from(zero))
            .iter()
            .any(|m| m.contains("total weight is 0")));
    }

    // ── containers ─────────────────────────────────────────────────────

    #[test]
    fn routine_happy_path_scheduled() {
        let content = "---\nformat: 2\ntitle: Drill\nschedule: 0 8 * * *\ntimeframe: 45m\n\
                       success: { \"type\": \"points\", \"delta\": 15 }\n---\n\nintro\n";
        let (r, d) = parse_routine(content);
        assert!(errs(&d).is_empty(), "{d:?}");
        let r = r.expect("parsed");
        assert_eq!(r.title, "Drill");
        assert_eq!(r.schedule.as_deref(), Some("0 8 * * *"));
        assert_eq!(r.timeframe_secs, Some(2700));
        assert_eq!(r.success, vec![Action::Points { delta: 15 }]);
        assert_eq!(r.pages.len(), 1);
    }

    #[test]
    fn routine_requires_format_marker() {
        let content = "---\ntitle: x\nschedule: 0 8 * * *\n---\nbody\n";
        let (r, d) = parse_routine(content);
        assert!(r.is_none(), "invalid routine yields no value");
        assert!(errs(&d).iter().any(|m| m.contains("format: 2")));
    }

    #[test]
    fn routine_on_demand_farm_warning() {
        let base = "---\nformat: 2\ntitle: x\nsuccess: { \"type\": \"points\", \"delta\": 5 }\n---\nbody\n";
        let (_, d) = parse_routine(base);
        assert!(warns(&d).iter().any(|m| m.contains("default")));

        let limited = "---\nformat: 2\ntitle: x\nsuccess: { \"type\": \"points\", \"delta\": 5 }\n\
                       limit: { \"daily\": 3 }\n---\nbody\n";
        let (_, d2) = parse_routine(limited);
        assert!(!warns(&d2).iter().any(|m| m.contains("default")));

        let scheduled = "---\nformat: 2\ntitle: x\nschedule: 0 8 * * *\n\
                         success: { \"type\": \"points\", \"delta\": 5 }\n---\nbody\n";
        let (_, d3) = parse_routine(scheduled);
        assert!(!warns(&d3).iter().any(|m| m.contains("default")));
    }

    #[test]
    fn habit_defaults_and_errors() {
        let good = "---\ntitle: No X\ntype: max\ncount: 0\n---\ndescription\n";
        let (h, d) = parse_habit(good);
        assert!(errs(&d).is_empty(), "{d:?}");
        let h = h.expect("parsed");
        assert_eq!(h.count, 0);

        let (h2, d2) = parse_habit("---\ntitle: Y\ntype: min\n---\n");
        assert!(errs(&d2).is_empty());
        assert_eq!(h2.expect("parsed").count, 1, "count defaults to 1");

        let (_, d3) = parse_habit("---\ntitle: Z\ntype: sideways\n---\n");
        assert!(errs(&d3).iter().any(|m| m.contains("`max`")));
    }

    #[test]
    fn task_timeouts_order_warning() {
        let good = "---\ntitle: T\ntimeouts: [{ \"after\": \"30m\", \"action\": { \"type\": \"points\", \"delta\": -5 } }, \
                    { \"after\": \"1h\", \"action\": { \"type\": \"notification\", \"text\": \"x\" } }]\n---\nbody\n";
        let (_, d) = parse_task(good);
        assert!(!warns(&d).iter().any(|m| m.contains("ascending")), "{d:?}");

        let swapped = "---\ntitle: T\ntimeouts: [{ \"after\": \"1h\", \"action\": { \"type\": \"points\", \"delta\": -5 } }, \
                       { \"after\": \"30m\", \"action\": { \"type\": \"points\", \"delta\": -5 } }]\n---\nbody\n";
        let (_, d2) = parse_task(swapped);
        assert!(warns(&d2).iter().any(|m| m.contains("ascending")));
    }

    #[test]
    fn store_entry_happy_and_missing_price() {
        let good = "{ \"title\": \"Pass\", \"price\": 25, \"stock\": 3, \"restock\": \"0 0 * * 1\", \
                     \"action\": { \"type\": \"exemption\", \"duration\": \"24h\", \"scope\": \"habits\" } }";
        let (s, d) = parse_store_entry(good);
        assert!(errs(&d).is_empty(), "{d:?}");
        assert_eq!(s.expect("parsed").price, 25);

        let (_, d2) = parse_store_entry(
            "{ \"title\": \"x\", \"action\": { \"type\": \"notification\", \"text\": \"y\" } }",
        );
        assert!(errs(&d2).iter().any(|m| m.contains("`price` is required")));
    }

    #[test]
    fn inline_conditional_markers_error_clearly() {
        // `{{#if}}` / `{{/if}}` on one line was previously misread as a
        // valid opener (the line starts with `{{#if ` and ends with `}}`),
        // producing a confusing condition-parse error *and* a spurious
        // "never closed". Now it's one actionable error, no stack junk.
        let one_line = "---\nformat: 2\ntitle: T\n---\n{{#if weekday == \"monday\"}}- [ ] item{{/if}}\n";
        let (_, d) = parse_routine(one_line);
        assert!(
            errs(&d).iter().any(|m| m.contains("must be on their own lines")),
            "{d:?}"
        );
        // No leftover open frame → no "never closed" error.
        assert!(
            !errs(&d).iter().any(|m| m.contains("never closed")),
            "{d:?}"
        );

        // A marker in the middle of prose is also rejected explicitly.
        let mid = "---\nformat: 2\ntitle: T\n---\nToday {{#if weekday == \"monday\"}}is monday{{/if}}.\n";
        let (_, d2) = parse_routine(mid);
        assert!(
            errs(&d2).iter().any(|m| m.contains("must be on its own line")),
            "{d:?}"
        );
        let mid_errs = errs(&d2);
        assert_eq!(mid_errs.len(), 1, "{mid_errs:?}");

        // Proper block syntax still parses clean.
        let block = "---\nformat: 2\ntitle: T\n---\n{{#if weekday == \"monday\"}}\n- [ ] item\n{{/if}}\n";
        let (_, d3) = parse_routine(block);
        assert!(errs(&d3).is_empty(), "{d3:?}");
        assert!(warns(&d3).is_empty(), "{d3:?}");
    }

    #[test]
    fn mid_line_closers_error_clearly() {
        let closer = "---\nformat: 2\ntitle: T\n---\n- [ ] item {{/if}}\n";
        let (_, d) = parse_routine(closer);
        assert!(
            errs(&d).iter().any(|m| m.contains("`{{/if}}` must be on its own line")),
            "{d:?}"
        );
        let else_mid = "---\nformat: 2\ntitle: T\n---\n{{#else}} oops\n";
        let (_, d2) = parse_routine(else_mid);
        assert!(
            errs(&d2).iter().any(|m| m.contains("`{{#else}}` must be on its own line")),
            "{d2:?}"
        );
    }

    // ── shipped examples stay valid (dogfood) ──────────────────────────

    #[test]
    fn bundled_examples_parse_clean() {
        let routine = include_str!("../../examples/routine-v2.md");
        let (r, d) = parse_routine(routine);
        assert!(errs(&d).is_empty(), "routine-v2.md: {d:?}");
        assert!(warns(&d).is_empty(), "routine-v2.md: {d:?}");
        let r = r.expect("parses");
        assert_eq!(r.pages.len(), 3, "intro page + settle page + conditional bonus page");

        // Conditional syntax lands in the parsed structures: page 1 has a
        // `{{#if}}` checklist with a condition, page 3 a page-level `@when`,
        // and the wait features carry `when:` conditions.
        assert!(r.pages[0].elements.iter().any(|el| matches!(
            el,
            Element::Checklist { when: Some(_), .. }
        )));
        assert!(r.pages[2].when.is_some());
        assert!(r.pages[1].elements.iter().any(|el| matches!(
            el,
            Element::Feature(f) if f.when.is_some()
        )));

        let habit = include_str!("../../examples/habit.md");
        let (_, hd) = parse_habit(habit);
        assert!(errs(&hd).is_empty(), "habit.md: {hd:?}");
        assert!(warns(&hd).is_empty(), "habit.md: {hd:?}");

        let task = include_str!("../../examples/task.md");
        let (_, td) = parse_task(task);
        assert!(errs(&td).is_empty(), "task.md: {td:?}");
        assert!(warns(&td).is_empty(), "task.md: {td:?}");

        let store = include_str!("../../examples/store.json");
        let (_, sd) = parse_store_entry(store);
        assert!(errs(&sd).is_empty(), "store.json: {sd:?}");
        assert!(warns(&sd).is_empty(), "store.json: {sd:?}");
    }
}
