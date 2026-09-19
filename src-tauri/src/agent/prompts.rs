//! Prompt loader (port of `src/lib/prompts.ts`).
//!
//! System prompts live in `<app_data>/prompts/` and support three
//! directives, ported verbatim so a prompt file renders identically under
//! the Rust loop:
//!
//!   {{embed 'path/to/file.md'}}   Inline `prompts/<path>`; nestable, with
//!                                 circular embeds silently skipped (the
//!                                 visited set is shared across the whole
//!                                 render — a file embedded twice renders
//!                                 once, matching the JS quirk).
//!   {{include './USER.md'}}       Inline a file from the agent's writable
//!                                 `agent_data/`, snapshotted per session
//!                                 so agent rewrites mid-session don't leak
//!                                 into the prompt; >1000 words truncated;
//!                                 missing files inline `File does not
//!                                 exist`.
//!   {{docs}}                      Reference-docs surface for
//!                                 `agent_data/docs/`: tree index (path +
//!                                 `description` frontmatter) plus full
//!                                 bodies of `inline: true` docs.
//!
//! The include snapshot cache is process-global and reset by the runner at
//! each run start — the Rust analogue of `resetIncludeSnapshots()` at
//! session start.
//!
//! File access goes through the same `bash::resolve_under` containment the
//! `read_prompt` / `read_data_file` Tauri commands use, so the runner
//! cannot read anything the agent's own tools couldn't.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use parking_lot::Mutex;

use once_cell::sync::Lazy;

use crate::bash::resolve_under;

/// Sandbox directory the docs surface indexes.
const DOCS_DIR: &str = "docs";

/// Word cap for `{{include}}` snapshots; longer files are truncated.
const INCLUDE_WORD_LIMIT: usize = 1000;

/// Literal inlined when an `{{include}}` target is missing.
const INCLUDE_MISSING: &str = "File does not exist";

/// Large-file threshold shared with the `read_file` tool port (see
/// `tools.rs` — same constant as `tools.ts`).
pub(crate) const LARGE_FILE_LINE_THRESHOLD: usize = 200;

// `{{embed ...}}` (2-3 braces) / `{{include '...'}}` / `{{docs}}` — same
// shapes as the JS regexes.
static EMBED_RE: Lazy<regex::Regex> = Lazy::new(|| {
    regex::Regex::new(r#"\{{2,3}embed\s+['"]([^'"]+)['"]\s*\}{2,3}"#).expect("embed regex")
});
static INCLUDE_RE: Lazy<regex::Regex> = Lazy::new(|| {
    regex::Regex::new(r#"\{\{\s*include\s+['"]([^'"]+)['"]\s*\}\}"#).expect("include regex")
});
static DOCS_RE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r#"\{\{\s*docs\s*\}\}"#).expect("docs regex"));

// ============================================================================
// Include snapshot cache (session-scoped)
// ============================================================================

static INCLUDE_SNAPSHOT: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Clear the `{{include}}` snapshot cache. The runner calls this at each run
/// start (the JS side resets it at session start / prompt refresh).
pub(crate) fn reset_include_snapshots() {
    INCLUDE_SNAPSHOT.lock().clear();
}

/// Normalize an include path (`./USER.md`, `/USER.md`, `USER.md`) for cache
/// keying.
fn normalize_include_path(raw: &str) -> String {
    let s = raw.strip_prefix("./").unwrap_or(raw);
    let s = s.trim_start_matches('/');
    s.trim().to_string()
}

/// Cap content at [`INCLUDE_WORD_LIMIT`] words, appending a note when
/// truncated.
fn cap_include_words(content: &str) -> String {
    let words: Vec<&str> = content.split_whitespace().collect();
    if words.len() <= INCLUDE_WORD_LIMIT {
        return content.to_string();
    }
    format!(
        "{}\n\n[... file truncated at {INCLUDE_WORD_LIMIT} words ...]",
        words[..INCLUDE_WORD_LIMIT].join(" ")
    )
}

/// Resolve an `{{include}}` against the agent's writable directory, taking a
/// session-scoped snapshot (see module docs for the truncation/missing
/// semantics).
fn render_include(agent_dir: &Path, raw_path: &str) -> String {
    let key = normalize_include_path(raw_path);
    if let Some(cached) = INCLUDE_SNAPSHOT.lock().get(&key) {
        return cached.clone();
    }

    let value = match resolve_under(agent_dir, &key)
        .map_err(|e| e.to_string())
        .and_then(|p| std::fs::read_to_string(&p).map_err(|e| format!("read {key}: {e}")))
    {
        Ok(content) => {
            let total_lines = content.split('\n').count();
            if total_lines > LARGE_FILE_LINE_THRESHOLD {
                crate::agent::tools::large_file_head_include(&content, &key, total_lines)
            } else {
                cap_include_words(&content)
            }
        }
        Err(e) => {
            log::warn!("[prompts] Include \"{key}\" failed, treating as missing: {e}");
            INCLUDE_MISSING.to_string()
        }
    };
    INCLUDE_SNAPSHOT.lock().insert(key, value.clone());
    value
}

// ============================================================================
// Main entry
// ============================================================================

/// Load a prompt file from `<app_data>/prompts/<rel_path>` and process
/// directives. Returns an empty string on error (matching the JS loader —
/// an unusable prompt degrades to "no system prompt", never a hard failure).
pub(crate) fn load_prompt(data_dir: &Path, agent_dir: &Path, rel_path: &str) -> String {
    let mut visited = HashSet::new();
    process_prompt(data_dir, agent_dir, rel_path, &mut visited)
}

fn process_prompt(
    data_dir: &Path,
    agent_dir: &Path,
    rel_path: &str,
    visited: &mut HashSet<String>,
) -> String {
    if !visited.insert(rel_path.to_string()) {
        // Circular embed: silent skip (JS parity).
        return String::new();
    }

    let prompts_root = data_dir.join("prompts");
    let raw = match resolve_under(&prompts_root, rel_path)
        .map_err(|e| e.to_string())
        .and_then(|p| std::fs::read_to_string(&p).map_err(|e| format!("read {rel_path}: {e}")))
    {
        Ok(raw) => raw,
        Err(e) => {
            log::warn!("[prompts] Failed to load \"{rel_path}\": {e}");
            return String::new();
        }
    };

    // Embeds first (recursive; failures render empty with a warning).
    let out = replace_all(&raw, &EMBED_RE, |caps| {
        let sub_path = caps[1].trim();
        let result = process_prompt(data_dir, agent_dir, sub_path, visited);
        if result.is_empty() {
            log::warn!("[prompts] Failed to embed \"{sub_path}\" (missing, circular, or empty)");
        }
        result
    });

    // Includes from the agent's writable dir, snapshotted and inlined
    // verbatim (no further directive expansion).
    let out = replace_all(&out, &INCLUDE_RE, |caps| {
        render_include(agent_dir, caps[1].trim())
    });

    // The docs directive.
    replace_all(&out, &DOCS_RE, |_caps| render_docs(agent_dir))
}

/// Replace all matches of `re` in `input` (the sync analogue of the JS
/// `replaceAsync` — our replacers are all synchronous file/regex work).
fn replace_all(
    input: &str,
    re: &regex::Regex,
    mut f: impl FnMut(&regex::Captures) -> String,
) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last = 0;
    for caps in re.captures_iter(input) {
        let whole = caps.get(0).expect("match has whole");
        out.push_str(&input[last..whole.start()]);
        out.push_str(&f(&caps));
        last = whole.end();
    }
    out.push_str(&input[last..]);
    out
}

// ============================================================================
// {{docs}} — reference docs index + inlined docs
// ============================================================================

/// One parsed markdown file under the docs dir.
struct DocFile {
    /// Path relative to `docs/`, POSIX separators, sorted order.
    rel: String,
    /// `description` frontmatter value ("" when absent).
    description: String,
    /// `inline: true` frontmatter flag.
    inline: bool,
    /// File body (everything after the frontmatter block).
    body: String,
}

/// Render the `{{docs}}` surface: a tree-structured index of every markdown
/// file under the agent's `docs/` dir (path + description), followed by the
/// full body of every doc marked `inline: true`. The index is the discovery
/// surface — the agent reads a doc with `read_file` when its topic comes up.
/// An absent docs dir renders empty (fresh sandbox, framework ships none).
fn render_docs(agent_dir: &Path) -> String {
    let docs_root = agent_dir.join(DOCS_DIR);
    if !docs_root.is_dir() {
        return String::new();
    }
    let mut paths: Vec<String> = Vec::new();
    collect_markdown_files(&docs_root, DOCS_DIR, &mut paths);
    paths.sort();

    let mut files: Vec<DocFile> = Vec::new();
    for p in &paths {
        let content = resolve_under(agent_dir, p)
            .ok()
            .and_then(|full| std::fs::read_to_string(&full).ok())
            .unwrap_or_default();
        let (frontmatter, body) = parse_frontmatter(&content);
        let rel = p.strip_prefix(format!("{DOCS_DIR}/").as_str()).unwrap_or(p);
        files.push(DocFile {
            rel: normalize_include_path(rel),
            description: description_text(frontmatter.get("description")),
            inline: frontmatter.get("inline").is_some_and(|v| v == "true"),
            body,
        });
    }
    if files.is_empty() {
        return String::new();
    }

    let mut sections: Vec<String> = vec![
        "## Reference Docs".into(),
        String::new(),
        "The `docs/` folder in the sandbox holds reference documentation. Read a file with `read_file` when its topic comes up:".into(),
        String::new(),
    ];
    for line in render_index_tree(&files) {
        sections.push(line);
    }
    let inline_docs: Vec<&DocFile> = files.iter().filter(|f| f.inline).collect();
    if !inline_docs.is_empty() {
        sections.push(String::new());
        sections.push("The following docs are inlined in full below.".into());
        sections.push(String::new());
        for doc in inline_docs {
            sections.push(format!("### docs/{}", doc.rel));
            sections.push(String::new());
            sections.push(doc.body.trim().to_string());
            sections.push(String::new());
        }
    }
    sections.join("\n").trim_end().to_string()
}

/// Frontmatter `description` as a single-line string ("" when absent) —
/// the rendering half of the JS `descriptionText` (values were flattened to
/// strings by the frontmatter parser: arrays newline-joined, objects
/// JSON-stringified); here they're collapsed to one line for the index.
fn description_text(v: Option<&String>) -> String {
    v.map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
}

/// One tree node in the docs index (a file leaf or a directory).
#[derive(Default)]
struct Item {
    name: String,
    /// Index into `files` when this item IS a file; None for a dir.
    file: Option<usize>,
    children: Vec<usize>,
}

/// Render the index as a nested bullet tree (directories bold, files with an
/// em-dash description). Entries sort alphabetically at each level, files
/// and directories interleaved (JS `localeCompare` ≈ byte order for the
/// ASCII filenames docs paths are).
fn render_index_tree(files: &[DocFile]) -> Vec<String> {
    // Build the tree: items[0] is the synthetic root.
    let mut items: Vec<Item> = vec![Item::default()];
    for (file_idx, f) in files.iter().enumerate() {
        let mut cursor = 0usize;
        let segs: Vec<&str> = f.rel.split('/').collect();
        for (i, seg) in segs.iter().enumerate() {
            let last = i == segs.len() - 1;
            let existing = items[cursor]
                .children
                .iter()
                .copied()
                .find(|&c| items[c].name == *seg);
            cursor = match existing {
                Some(c) => c,
                None => {
                    items.push(Item {
                        name: (*seg).to_string(),
                        file: if last { Some(file_idx) } else { None },
                        children: Vec::new(),
                    });
                    let idx = items.len() - 1;
                    items[cursor].children.push(idx);
                    idx
                }
            };
        }
    }

    let mut lines: Vec<String> = Vec::new();
    walk(&items, 0, 0, files, &mut lines);
    lines
}

fn walk(items: &[Item], cursor: usize, depth: usize, files: &[DocFile], lines: &mut Vec<String>) {
    let mut order = items[cursor].children.clone();
    order.sort_by(|&a, &b| items[a].name.cmp(&items[b].name));
    let indent = "  ".repeat(depth);
    for idx in order {
        let item = &items[idx];
        match item.file {
            Some(f) => {
                let name = files[f].rel.rsplit('/').next().unwrap_or(&files[f].rel);
                if files[f].description.is_empty() {
                    lines.push(format!("{indent}- `{name}`"));
                } else {
                    lines.push(format!("{indent}- `{name}` — {}", files[f].description));
                }
            }
            None => {
                lines.push(format!("{indent}- **`{}/`**", item.name));
                walk(items, idx, depth + 1, files, lines);
            }
        }
    }
}

/// Recursively collect `*.md` paths under the docs dir (POSIX separators,
/// `docs/`-prefixed like the JS `e.path` values). `rel_prefix` carries the
/// path relative to `agent_dir/` ("docs" at the top level).
fn collect_markdown_files(dir: &Path, rel_prefix: &str, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entry_names: Vec<(String, bool)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.metadata().map(|m| m.is_dir()).unwrap_or(false);
        entry_names.push((name, is_dir));
    }
    // Walk order only matters for stability — the caller sorts the paths.
    entry_names.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.cmp(&b.0),
    });
    for (name, is_dir) in entry_names {
        let child_rel = format!("{rel_prefix}/{name}");
        let child_path = dir.join(&name);
        if is_dir {
            collect_markdown_files(&child_path, &child_rel, out);
        } else if name.ends_with(".md") {
            out.push(child_rel);
        }
    }
}

// ============================================================================
// Frontmatter
// ============================================================================

/// Simple frontmatter parser: leading `---\n...\n---\n` block with key:
/// value lines (arrays via ` - item`), quotes stripped. Port of
/// `parseFrontmatter` including its tolerance (unterminated blocks and
/// invalid lines fall through to body / skip).
pub(crate) fn parse_frontmatter(content: &str) -> (HashMap<String, String>, String) {
    let content = content.replace("\r\n", "\n");
    if !content.starts_with("---\n") {
        return (HashMap::new(), content);
    }
    let Some(end) = content[4..].find("\n---\n").map(|i| i + 4) else {
        log::warn!("[prompts] Frontmatter block not terminated with \"---\".");
        return (HashMap::new(), content);
    };

    let yaml = &content[4..end];
    let body = content[end + 5..].to_string();
    let mut frontmatter: HashMap<String, String> = HashMap::new();

    let array_item_re = regex::Regex::new(r"^\s+-\s+").expect("array item regex");
    let key_re = regex::Regex::new(r"^[A-Za-z0-9_-]+$").expect("key regex");

    let mut current_key = String::new();
    for line in yaml.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        // Array item: append to the current key with "\n" separation (the
        // docs renderer only reads scalar descriptions; arrays survive as
        // newline-joined values so nothing is lost).
        if array_item_re.is_match(line) && !current_key.is_empty() {
            let v = line.trim_start_matches(|c: char| c.is_whitespace() || c == '-');
            frontmatter
                .entry(current_key.clone())
                .and_modify(|existing| existing.push('\n'))
                .or_default()
                .push_str(v.trim());
            continue;
        }
        // key: value
        let Some((key, value)) = line.split_once(':') else {
            log::warn!("[prompts] Skipping invalid line in frontmatter: \"{line}\"");
            continue;
        };
        let key = key.trim();
        if !key_re.is_match(key) {
            log::warn!("[prompts] Skipping invalid line in frontmatter: \"{line}\"");
            continue;
        }
        current_key = key.to_string();
        let value = value.trim();
        if value.is_empty() {
            frontmatter.insert(current_key.clone(), String::new());
        } else {
            let stripped = value
                .strip_prefix('\'')
                .and_then(|v| v.strip_suffix('\''))
                .or_else(|| value.strip_prefix('"').and_then(|v| v.strip_suffix('"')))
                .unwrap_or(value);
            frontmatter.insert(current_key.clone(), stripped.to_string());
        }
    }

    (frontmatter, body)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests share one process-global include cache; this mutex serializes
    /// every test that resets/reads it so they can't wipe each other's
    /// snapshots mid-run.
    static CACHE_LOCK: Mutex<()> = Mutex::new(());

    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn prompt_fixture_renders_all_directives() {
        let _guard = CACHE_LOCK.lock();
        let tmp = tempfile::tempdir().unwrap();
        let prompts = tmp.path().join("prompts");
        let agent = tmp.path().join("agent_data");
        write(
            &prompts.join("main_agent.md"),
            "# MAIN\n{{embed 'sub/child.md'}}\n{{include './USER.md'}}\n{{docs}}\n",
        );
        write(&prompts.join("sub/child.md"), "CHILD({{embed 'sub/child.md'}})");
        write(&agent.join("USER.md"), "the user is patient");
        write(
            &agent.join("docs/guide.md"),
            "---\ndescription: A guide\n---\nGuide body\n",
        );
        write(
            &agent.join("docs/map.md"),
            "---\ninline: true\ndescription: Map\n---\nMap body\n",
        );
        write(&agent.join("docs/internal/nested.md"), "internal body\n");

        reset_include_snapshots();
        let out = load_prompt(tmp.path(), &agent, "main_agent.md");
        // Embed rendered (circular self-embed skipped silently).
        assert!(out.contains("CHILD()"), "out: {out}");
        // Include resolved from agent_data.
        assert!(out.contains("the user is patient"), "out: {out}");
        // Docs index (nested + flat) + inline body.
        assert!(out.contains("## Reference Docs"), "out: {out}");
        assert!(out.contains("- `guide.md` — A guide"), "out: {out}");
        assert!(out.contains("- **`internal/`**"), "out: {out}");
        assert!(out.contains("- `nested.md`"), "out: {out}");
        assert!(out.contains("### docs/map.md"), "out: {out}");
        assert!(out.contains("Map body"), "out: {out}");
        // Non-inline bodies are NOT inlined (index is the discovery surface).
        assert!(!out.contains("Guide body"), "out: {out}");
    }

    #[test]
    fn include_snapshot_is_stable_across_rewrites_until_reset() {
        let _guard = CACHE_LOCK.lock();
        let tmp = tempfile::tempdir().unwrap();
        let prompts = tmp.path().join("prompts");
        let agent = tmp.path().join("agent_data");
        std::fs::create_dir_all(&prompts).unwrap();
        std::fs::create_dir_all(&agent).unwrap();
        write(&prompts.join("p.md"), "{{include './N.md'}}");
        write(&agent.join("N.md"), "v1");
        reset_include_snapshots();
        let first = load_prompt(tmp.path(), &agent, "p.md");
        assert_eq!(first, "v1");
        // Agent rewrites the file mid-session…
        write(&agent.join("N.md"), "v2 rewritten");
        let second = load_prompt(tmp.path(), &agent, "p.md");
        assert_eq!(second, "v1", "snapshot must not leak agent rewrites");
        // …until a fresh session resets the cache.
        reset_include_snapshots();
        let third = load_prompt(tmp.path(), &agent, "p.md");
        assert_eq!(third, "v2 rewritten");
    }

    #[test]
    fn include_missing_and_word_cap() {
        let _guard = CACHE_LOCK.lock();
        let tmp = tempfile::tempdir().unwrap();
        let prompts = tmp.path().join("prompts");
        let agent = tmp.path().join("agent_data");
        std::fs::create_dir_all(&prompts).unwrap();
        std::fs::create_dir_all(&agent).unwrap();
        write(&prompts.join("p.md"), "[{{include './GONE.md'}}]");
        let many_words = std::iter::repeat("word")
            .take(1200)
            .collect::<Vec<_>>()
            .join(" ");
        write(&agent.join("big.md"), &many_words);
        write(&prompts.join("big.md"), "{{include './big.md'}}");
        reset_include_snapshots();
        let out = load_prompt(tmp.path(), &agent, "p.md");
        assert_eq!(out, "[File does not exist]");
        let out = load_prompt(tmp.path(), &agent, "big.md");
        assert!(out.contains("[... file truncated at 1000 words ...]"));
        assert_eq!(
            out.lines().next().unwrap().split_whitespace().count(),
            1000
        );
    }

    #[test]
    fn missing_prompt_degrades_to_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let prompts = tmp.path().join("prompts");
        let agent = tmp.path().join("agent_data");
        std::fs::create_dir_all(&prompts).unwrap();
        std::fs::create_dir_all(&agent).unwrap();
        assert_eq!(load_prompt(tmp.path(), &agent, "GONE.md"), "");
    }

    #[test]
    fn frontmatter_parses_like_the_js_parser() {
        let (fm, body) = parse_frontmatter(
            "---\r\ndescription: Hello world\r\ninline: true\r\nlist:\r\n  - a\r\n  - b\r\n---\r\nBODY",
        );
        assert_eq!(fm.get("description").map(String::as_str), Some("Hello world"));
        assert_eq!(fm.get("inline").map(String::as_str), Some("true"));
        assert_eq!(fm.get("list").map(String::as_str), Some("\na\nb"));
        assert_eq!(body, "BODY");

        // Quoted values are stripped.
        let (fm, _) = parse_frontmatter("---\ntitle: 'quoted'\n---\nX");
        assert_eq!(fm.get("title").map(String::as_str), Some("quoted"));

        // No frontmatter / unterminated block → body untouched.
        let (fm, body) = parse_frontmatter("plain");
        assert!(fm.is_empty());
        assert_eq!(body, "plain");
        let (fm, body) = parse_frontmatter("---\nno end");
        assert!(fm.is_empty());
        assert_eq!(body, "---\nno end");
    }
}
