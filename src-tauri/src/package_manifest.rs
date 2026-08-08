//! Package manifest: the mandatory `manifest.json` that every package
//! (framework or specialisation) ZIP must declare at its root, plus the
//! installed-state record the app keeps under `<data_dir>/framework.json`.
//!
//! A [`Manifest`] is what the framework author ships inside the ZIP. It
//! declares identity (`id`/`name`/`description`/`version`), compatibility
//! (`min_app_version`), and the merge rules the importer honours:
//!
//! - `owned_files` — globs (package-root relative) of files this package
//!   claims. On an update (same `id` already installed) any owned file that
//!   is **absent** from the new ZIP is pruned, so renamed/removed files
//!   don't linger.
//! - `preserve` — globs of files that must never be overwritten if they
//!   already exist on disk. Protects user-authored content
//!   (`USER.md`, `journal/**`, …) during updates.
//! - `remove` — explicit one-off removal globs, always applied.
//!
//! Globs are expressed relative to the **package root** (the ZIP root after
//! [`crate::package_import::resolve_package_root`]). A `prompts/` prefix
//! routes a glob to the prompt store; anything else routes to the content
//! root (the agent sandbox root for frameworks, `special/` for
//! specialisations). So `prompts/*.md` and `rules/*.md` are both valid,
//! natural globs.
//!
//! [`InstalledFramework`] is the on-disk record the app writes after a
//! framework import. Its presence is what [`crate::framework_installed`]
//! gates on (it replaced the old `prompts/main_agent.md` sentinel).

use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};

// ============================================================================
// Manifest (shipped inside the ZIP)
// ============================================================================

/// The mandatory package manifest, parsed from `manifest.json` at the ZIP root.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    /// Stable identifier that never changes between versions. Drives
    /// update-vs-fresh-install detection.
    pub id: String,
    pub name: String,
    pub description: String,
    /// Semver-ish version string (e.g. `"2.1.0"`).
    pub version: String,
    /// Optional: refuse to install if the running app is older.
    #[serde(default)]
    pub min_app_version: Option<String>,

    /// Package-root-relative globs of files this package owns. On an update,
    /// owned files absent from the new ZIP are pruned.
    #[serde(default)]
    pub owned_files: Vec<String>,
    /// Package-root-relative globs of files to never overwrite if present.
    #[serde(default)]
    pub preserve: Vec<String>,
    /// Package-root-relative globs of files to remove before merging. Always
    /// applied (not just on updates).
    #[serde(default)]
    pub remove: Vec<String>,
}

impl Manifest {
    /// Read and parse `manifest.json` from `pkg_root`. Returns a clear error
    /// if the file is missing (the manifest is mandatory) or unparseable.
    pub fn from_pkg_root(pkg_root: &Path) -> Result<Self, String> {
        let path = pkg_root.join("manifest.json");
        if !path.exists() {
            return Err(format!(
                "Package is missing a required manifest.json at its root. \
                 Every package (framework or specialisation) must declare one."
            ));
        }
        let text = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read manifest.json: {}", e))?;
        let manifest: Manifest = serde_json::from_str(&text)
            .map_err(|e| format!("Failed to parse manifest.json: {}", e))?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// Validate required, non-empty identity fields.
    fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("manifest.json: 'id' must not be empty.".into());
        }
        if self.version.trim().is_empty() {
            return Err("manifest.json: 'version' must not be empty.".into());
        }
        Ok(())
    }

    /// True if `app_version` is strictly older than `min_app_version`.
    /// Returns `false` when `min_app_version` is unset or unparseable, so a
    /// malformed constraint never blocks an install.
    pub fn rejects_app_version(&self, app_version: &str) -> bool {
        let min = match &self.min_app_version {
            Some(m) if !m.trim().is_empty() => m,
            _ => return false,
        };
        version_cmp(app_version, min) == std::cmp::Ordering::Less
    }
}

// ============================================================================
// Installed framework record (on-disk, <data_dir>/framework.json)
// ============================================================================

/// On-disk record of the currently installed framework. Written after a
/// successful framework import; its presence is what `framework_installed`
/// gates on. Only frameworks write this — specialisations are additive and
/// not tracked here (yet).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledFramework {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    /// RFC-3339 timestamp of when this version was installed.
    pub installed_at: String,
}

const INSTALLED_FILE: &str = "framework.json";

/// Read the installed-framework record from `<data_dir>/framework.json`.
/// Returns `None` if the file is missing or unparseable (treated as
/// "no framework installed").
pub fn read_installed_framework(data_dir: &Path) -> Option<InstalledFramework> {
    let path = data_dir.join(INSTALLED_FILE);
    let text = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Write the installed-framework record to `<data_dir>/framework.json`.
pub fn write_installed_framework(data_dir: &Path, record: &InstalledFramework) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("Failed to create data dir: {}", e))?;
    let path = data_dir.join(INSTALLED_FILE);
    let text =
        serde_json::to_string_pretty(record).map_err(|e| format!("Failed to encode record: {}", e))?;
    fs::write(&path, text).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

/// Remove the installed-framework record, if any. Used by app-data reset so
/// the app correctly returns to the "no framework" onboarding state.
pub fn clear_installed_framework(data_dir: &Path) {
    let _ = fs::remove_file(data_dir.join(INSTALLED_FILE));
}

/// Build an [`InstalledFramework`] from a freshly imported manifest.
pub fn installed_from_manifest(mf: &Manifest) -> InstalledFramework {
    InstalledFramework {
        id: mf.id.clone(),
        name: mf.name.clone(),
        description: mf.description.clone(),
        version: mf.version.clone(),
        installed_at: chrono::Utc::now().to_rfc3339(),
    }
}

// ============================================================================
// Glob matching
// ============================================================================

/// A set of compiled glob patterns. Patterns are matched against
/// forward-slash, package-root-relative paths (e.g. `prompts/a.md`,
/// `rules/sub/b.md`).
///
/// Supported glob syntax:
/// - `**` — matches any sequence of characters including `/` (so `journal/**`
///   matches everything under `journal/`).
/// - `*`  — matches any run of characters except `/` (stays within one path
///   segment).
/// - `?`  — matches a single non-`/` character.
/// - other regex metacharacters are escaped and matched literally.
pub struct GlobSet {
    patterns: Vec<Regex>,
}

impl GlobSet {
    /// Compile a list of globs. Empty / unparseable entries are silently
    /// skipped (a bad glob shouldn't abort an entire import).
    pub fn new(globs: &[String]) -> Self {
        let patterns = globs
            .iter()
            .filter_map(|g| {
                let trimmed = g.trim();
                if trimmed.is_empty() {
                    return None;
                }
                match Regex::new(&glob_to_regex(trimmed)) {
                    Ok(re) => Some(re),
                    Err(_) => None,
                }
            })
            .collect();
        GlobSet { patterns }
    }

    /// True if any compiled pattern matches `rel_path`.
    pub fn matches(&self, rel_path: &str) -> bool {
        self.patterns.iter().any(|re| re.is_match(rel_path))
    }

    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }
}

/// Convert a glob expression into an anchored regex string. See
/// [`GlobSet`] for the supported syntax.
fn glob_to_regex(glob: &str) -> String {
    let mut out = String::with_capacity(glob.len() + 2);
    out.push('^');
    let chars: Vec<char> = glob.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    // `**` matches across path separators. Swallow a trailing
                    // slash so `a/**/b` also matches `a/b`.
                    out.push_str(".*");
                    i += 2;
                    if i < chars.len() && chars[i] == '/' {
                        i += 1;
                    }
                } else {
                    out.push_str("[^/]*");
                    i += 1;
                }
            }
            '?' => {
                out.push_str("[^/]");
                i += 1;
            }
            // Escape regex metacharacters so they match literally.
            '.' | '(' | ')' | '+' | '|' | '^' | '$' | '\\' | '{' | '}' | '[' | ']' => {
                out.push('\\');
                out.push(c);
                i += 1;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out.push('$');
    out
}

// ============================================================================
// Path helpers
// ============================================================================

/// Normalise an OS path to a forward-slash relative string. `base` must be a
/// prefix of `path` (both absolute). Returns the relative path with `/`
/// separators, suitable for glob matching against package-root-relative
/// globs.
fn rel_forward(base: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(base).ok()?;
    let mut s = String::new();
    let mut first = true;
    for comp in rel.components() {
        if !first {
            s.push('/');
        }
        first = false;
        s.push_str(&comp.as_os_str().to_string_lossy());
    }
    Some(s)
}

/// The two roots a package's content merges into. Globs are matched against
/// paths relative to this pair, with a `prompts/` prefix selecting
/// `prompts_root`.
pub struct MergeRoots<'a> {
    pub prompts_root: &'a Path,
    pub content_root: &'a Path,
}

impl<'a> MergeRoots<'a> {
    /// Enumerate every regular file under both roots, yielding
    /// `(abs_path, package_root_relative_path)` pairs. The relative path gets
    /// a `prompts/` prefix for files under the prompt store so globs like
    /// `prompts/*.md` match them.
    fn enumerate(&self) -> Vec<(PathBuf, String)> {
        let mut out = Vec::new();
        walk(self.prompts_root, self.prompts_root, Some("prompts/"), &mut out);
        walk(self.content_root, self.content_root, None, &mut out);
        out
    }
}

/// Recursive directory walk collecting `(abs_path, rel)` pairs. `prefix` is
/// prepended to the relative path (used to tag prompt-store files with
/// `prompts/`).
fn walk(root: &Path, dir: &Path, prefix: Option<&str>, out: &mut Vec<(PathBuf, String)>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.file_type() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            walk(root, &path, prefix, out);
        } else if meta.is_file() {
            if let Some(rel) = rel_forward(root, &path) {
                let tagged = match prefix {
                    Some(p) => format!("{p}{rel}"),
                    None => rel,
                };
                out.push((path, tagged));
            }
        }
        // Symlinks ignored across the trust boundary.
    }
}

// ============================================================================
// Prune / remove operations
// ============================================================================

/// Outcome of a pre-merge cleanup pass.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Cleanup {
    /// Files deleted by explicit `remove` globs.
    pub removed: usize,
    /// Files deleted by `owned_files` pruning (owned + absent from new ZIP).
    pub pruned: usize,
}

/// Apply `remove` globs and (when this is an update) `owned_files` pruning
/// against the on-disk roots. `new_zip_rels` is the set of package-root-
/// relative paths present in the incoming ZIP — owned files missing from it
/// are pruned. Returns counts for reporting.
pub fn cleanup_before_merge(
    roots: &MergeRoots,
    manifest: &Manifest,
    is_update: bool,
    new_zip_rels: &std::collections::HashSet<String>,
) -> Cleanup {
    let remove_set = GlobSet::new(&manifest.remove);
    let owned_set = GlobSet::new(&manifest.owned_files);

    let mut removed = 0usize;
    let mut pruned = 0usize;

    for (abs, rel) in roots.enumerate() {
        // Explicit removals always apply.
        if !remove_set.is_empty() && remove_set.matches(&rel) {
            if fs::remove_file(&abs).is_ok() {
                removed += 1;
            }
            continue;
        }
        // Owned-file pruning only on a same-id update: delete owned files
        // that are absent from the incoming ZIP.
        if is_update && !owned_set.is_empty() && owned_set.matches(&rel) && !new_zip_rels.contains(&rel)
        {
            if fs::remove_file(&abs).is_ok() {
                pruned += 1;
            }
        }
    }

    Cleanup { removed, pruned }
}

// ============================================================================
// Version comparison
// ============================================================================

/// Compare two dot-separated numeric version strings (e.g. `"2.1.0"`).
/// Missing or non-numeric components are treated as `0`. This is intentionally
/// lenient — it's only used for `min_app_version` gating, not migrations.
pub fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let pa: Vec<u64> = a.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect();
    let pb: Vec<u64> = b.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect();
    let n = pa.len().max(pb.len());
    for i in 0..n {
        let va = pa.get(i).copied().unwrap_or(0);
        let vb = pb.get(i).copied().unwrap_or(0);
        match va.cmp(&vb) {
            std::cmp::Ordering::Equal => continue,
            ord => return ord,
        }
    }
    std::cmp::Ordering::Equal
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use tempfile::tempdir;

    #[test]
    fn test_glob_to_regex_basics() {
        assert!(Regex::new(&glob_to_regex("USER.md")).unwrap().is_match("USER.md"));
        assert!(!Regex::new(&glob_to_regex("USER.md")).unwrap().is_match("rules/USER.md"));

        // `*` stays within a segment.
        let re = Regex::new(&glob_to_regex("prompts/*.md")).unwrap();
        assert!(re.is_match("prompts/a.md"));
        assert!(re.is_match("prompts/main_agent.md"));
        assert!(!re.is_match("prompts/sub/a.md"));
        assert!(!re.is_match("rules/a.md"));

        // `**` crosses separators.
        let re = Regex::new(&glob_to_regex("journal/**")).unwrap();
        assert!(re.is_match("journal/x.md"));
        assert!(re.is_match("journal/2024/01/x.md"));

        // `**` swallows a trailing slash so `a/**/b` matches `a/b`.
        let re = Regex::new(&glob_to_regex("a/**/b")).unwrap();
        assert!(re.is_match("a/b"));
        assert!(re.is_match("a/x/b"));
        assert!(re.is_match("a/x/y/b"));

        // `?` is a single non-separator char.
        let re = Regex::new(&glob_to_regex("?.md")).unwrap();
        assert!(re.is_match("a.md"));
        assert!(!re.is_match("ab.md"));

        // Literal dots in extension aren't wildcard.
        let re = Regex::new(&glob_to_regex("*.md")).unwrap();
        assert!(re.is_match("a.md"));
        assert!(!re.is_match("a.txt"));
    }

    #[test]
    fn test_glob_set_matches() {
        let gs = GlobSet::new(&[
            "prompts/*.md".to_string(),
            "journal/**".to_string(),
            "USER.md".to_string(),
            "".to_string(), // ignored
        ]);
        assert!(gs.matches("prompts/main_agent.md"));
        assert!(gs.matches("journal/2024/x.md"));
        assert!(gs.matches("USER.md"));
        assert!(!gs.matches("rules/foo.md"));
        assert!(!gs.matches("prompts/sub/a.md"));
    }

    #[test]
    fn test_manifest_parse_and_validate() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("manifest.json"),
            r#"{
                "id": "core",
                "name": "Core",
                "description": "d",
                "version": "1.0.0",
                "owned_files": ["prompts/*.md"],
                "preserve": ["USER.md"],
                "remove": []
            }"#,
        )
        .unwrap();
        let mf = Manifest::from_pkg_root(dir.path()).unwrap();
        assert_eq!(mf.id, "core");
        assert_eq!(mf.version, "1.0.0");
        assert!(!mf.rejects_app_version("0.8.2"));

        // Missing manifest → clear error.
        let dir2 = tempdir().unwrap();
        let err = Manifest::from_pkg_root(dir2.path()).unwrap_err();
        assert!(err.contains("manifest.json"));
    }

    #[test]
    fn test_manifest_rejects_empty_id() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("manifest.json"),
            r#"{ "id": "", "name": "n", "description": "d", "version": "1.0.0" }"#,
        )
        .unwrap();
        let err = Manifest::from_pkg_root(dir.path()).unwrap_err();
        assert!(err.contains("'id'"));
    }

    #[test]
    fn test_min_app_version_gate() {
        let mut mf = Manifest {
            id: "x".into(),
            name: "n".into(),
            description: "d".into(),
            version: "1.0.0".into(),
            min_app_version: None,
            owned_files: vec![],
            preserve: vec![],
            remove: vec![],
        };
        // No constraint → never rejects.
        assert!(!mf.rejects_app_version("0.1.0"));

        mf.min_app_version = Some("1.0.0".into());
        assert!(mf.rejects_app_version("0.9.9"));
        assert!(!mf.rejects_app_version("1.0.0"));
        assert!(!mf.rejects_app_version("2.0.0"));
    }

    #[test]
    fn test_version_cmp_numeric() {
        use std::cmp::Ordering;
        assert_eq!(version_cmp("1.0.0", "1.0.0"), Ordering::Equal);
        assert_eq!(version_cmp("2.0.0", "1.9.9"), Ordering::Greater);
        assert_eq!(version_cmp("1.0.0", "1.0.1"), Ordering::Less);
        // Different component counts.
        assert_eq!(version_cmp("1.0", "1.0.0"), Ordering::Equal);
        assert_eq!(version_cmp("1.0.1", "1.0"), Ordering::Greater);
        // Non-numeric → treated as 0, never panics.
        assert_eq!(version_cmp("x", "0.0.0"), Ordering::Equal);
    }

    #[test]
    fn test_installed_framework_roundtrip() {
        let dir = tempdir().unwrap();
        assert!(read_installed_framework(dir.path()).is_none());

        let rec = InstalledFramework {
            id: "core".into(),
            name: "Core".into(),
            description: "d".into(),
            version: "1.2.3".into(),
            installed_at: "2026-08-07T12:00:00+00:00".into(),
        };
        write_installed_framework(dir.path(), &rec).unwrap();
        let back = read_installed_framework(dir.path()).expect("should read back");
        assert_eq!(back.id, "core");
        assert_eq!(back.version, "1.2.3");

        clear_installed_framework(dir.path());
        assert!(read_installed_framework(dir.path()).is_none());
    }

    #[test]
    fn test_cleanup_remove_and_prune() {
        // Layout on disk:
        //   prompts_root/  -> a.md, b.md
        //   content_root/  -> rules/r1.md, rules/legacy.md, USER.md, journal/j.md
        let prompts = tempdir().unwrap();
        let content = tempdir().unwrap();
        fs::write(prompts.path().join("a.md"), "a").unwrap();
        fs::write(prompts.path().join("b.md"), "b").unwrap();
        fs::create_dir_all(content.path().join("rules")).unwrap();
        fs::write(content.path().join("rules/r1.md"), "r1").unwrap();
        fs::write(content.path().join("rules/legacy.md"), "legacy").unwrap();
        fs::write(content.path().join("USER.md"), "user").unwrap();
        fs::create_dir_all(content.path().join("journal")).unwrap();
        fs::write(content.path().join("journal/j.md"), "j").unwrap();

        let roots = MergeRoots {
            prompts_root: prompts.path(),
            content_root: content.path(),
        };

        let mf = Manifest {
            id: "core".into(),
            name: "Core".into(),
            description: "d".into(),
            version: "2.0.0".into(),
            min_app_version: None,
            // Owns rules/* and prompts/*.md; the new ZIP still ships rules/r1.md
            // and prompts/a.md but NOT rules/legacy.md nor prompts/b.md.
            owned_files: vec!["rules/*.md".into(), "prompts/*.md".into()],
            preserve: vec!["USER.md".into()],
            remove: vec!["rules/legacy.md".into()],
        };

        let mut new_zip = HashSet::new();
        new_zip.insert("rules/r1.md".to_string());
        new_zip.insert("prompts/a.md".to_string());
        new_zip.insert("manifest.json".to_string());

        let cleanup = cleanup_before_merge(&roots, &mf, true, &new_zip);
        // remove: rules/legacy.md (1). prune: rules/legacy.md is owned+absent
        // but already removed above (continue), prompts/b.md owned+absent (1).
        assert_eq!(cleanup.removed, 1);
        assert_eq!(cleanup.pruned, 1);

        // legacy removed explicitly; b.md pruned (owned, absent); r1 kept; USER untouched.
        assert!(!content.path().join("rules/legacy.md").exists());
        assert!(!prompts.path().join("b.md").exists());
        assert!(content.path().join("rules/r1.md").exists());
        assert!(prompts.path().join("a.md").exists());
        assert!(content.path().join("USER.md").exists());
    }

    #[test]
    fn test_cleanup_no_prune_when_not_update() {
        let prompts = tempdir().unwrap();
        let content = tempdir().unwrap();
        fs::write(prompts.path().join("old.md"), "x").unwrap();

        let roots = MergeRoots {
            prompts_root: prompts.path(),
            content_root: content.path(),
        };
        let mf = Manifest {
            id: "core".into(),
            name: "n".into(),
            description: "d".into(),
            version: "1.0.0".into(),
            min_app_version: None,
            owned_files: vec!["prompts/*.md".into()],
            preserve: vec![],
            remove: vec![],
        };
        let new_zip = HashSet::new(); // empty incoming set
        let cleanup = cleanup_before_merge(&roots, &mf, false, &new_zip);
        // Fresh install (is_update=false) → no pruning, no removals.
        assert_eq!(cleanup.removed, 0);
        assert_eq!(cleanup.pruned, 0);
        assert!(prompts.path().join("old.md").exists());
    }

    #[test]
    fn test_enumerate_tags_prompts_prefix() {
        let prompts = tempdir().unwrap();
        let content = tempdir().unwrap();
        fs::write(prompts.path().join("main.md"), "x").unwrap();
        fs::create_dir_all(content.path().join("rules")).unwrap();
        fs::write(content.path().join("rules/r1.md"), "r").unwrap();

        let roots = MergeRoots {
            prompts_root: prompts.path(),
            content_root: content.path(),
        };
        let mut rels: Vec<String> = roots.enumerate().into_iter().map(|(_, r)| r).collect();
        rels.sort();
        assert_eq!(rels, vec!["prompts/main.md".to_string(), "rules/r1.md".to_string()]);
    }
}
