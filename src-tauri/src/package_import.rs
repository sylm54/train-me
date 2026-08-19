//! Framework import: extract a framework ZIP into the app's data
//! directories, honouring a mandatory [`package_manifest::Manifest`] and an
//! optional [`package_manifest::Config`].
//!
//! A framework ZIP has the layout:
//!
//! ```text
//! manifest.json          (required) identity + version + merge globs
//! config.json            (optional) install-time option groups → parts
//! base/
//!   prompts/             → <data_dir>/prompts/        (prompt store)
//!   agent_files/         → <data_dir>/agent_data/     (sandbox root)
//! <partA>/
//!   prompts/             → … (only when the part is selected)
//!   agent_files/         → …
//! <partB>/ …
//! ```
//!
//! `base/` is always installed. Each option group in `config.json` maps a
//! user choice to a part folder; the selected parts are installed alongside
//! base. Globs in the manifest (`owned_files` / `preserve` / `remove`) are
//! matched against destination-relative paths, exactly as before.
//!
//! ## Pipeline
//!
//! Install is split into two phases so the UI can show the config options
//! before committing:
//!
//! 1. **Stage** ([`stage_zip_input`]): extract the ZIP to a temp dir, parse
//!    the manifest + config. No writes to the live data folders.
//! 2. **Install** ([`install_framework`]): given the staged root + the user's
//!    choices, run cleanup (`remove` + `owned_files` pruning on update),
//!    merge `base/` + the selected parts into prompts/ + agent_data/
//!    (honouring `preserve`), and write the installed-framework record.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Cursor, Read, Seek};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Emitter, State};

use crate::package_manifest::{
    self, cleanup_before_merge, installed_from_manifest, write_installed_framework, Cleanup,
    Config, GlobSet, Manifest, MergeRoots,
};
use crate::AppState;

/// Result returned by the install command.
#[derive(Serialize, Clone, Debug)]
pub struct ImportResult {
    /// Always `"framework"` (kept for API compatibility with the old shape).
    pub kind: String,
    /// Manifest identity of the installed framework.
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    /// Number of files copied to `prompts/`.
    pub prompts_files: usize,
    /// Number of files copied into the agent area.
    pub agent_files: usize,
    /// Number of existing files left untouched because a `preserve` glob
    /// matched them (user content protected from overwrite).
    pub preserved: usize,
    /// Files deleted by explicit `remove` globs.
    pub removed: usize,
    /// Files deleted by `owned_files` pruning (owned + absent from new ZIP).
    pub pruned: usize,
    /// Whether this install was an update (same framework id already
    /// installed) or a fresh install.
    pub updated: bool,
    /// Optional human-readable note.
    pub note: Option<String>,
}

/// The framework identity + config surfaced to the UI after staging (so the
/// options screen can render before any install happens).
#[derive(Serialize, Clone, Debug)]
pub struct StagedFramework {
    pub manifest: Manifest,
    pub config: Config,
    /// Update-channel URL this was staged from ("" for a local-ZIP stage).
    pub source_url: String,
}

// ---------------------------------------------------------------------------
// Staging (extract + parse, no writes to live dirs)
// ---------------------------------------------------------------------------

// The staging pipeline lives in [`stage_to_persistent`] further down (it
// needs the persistent `staging_dir` + `source_url`). Install is below.

// ---------------------------------------------------------------------------
// Install (merge base + selected parts into live dirs)
// ---------------------------------------------------------------------------

/// Install a framework from an already-extracted root. Runs cleanup
/// (`remove` + `owned_files` pruning on update), merges `base/` + the
/// selected parts into the prompt store + agent sandbox (honouring
/// `preserve`), and returns the import result.
///
/// `source_url` is saved into the installed record so update checks work
/// later. `choices` is the user's config.json selection set, also saved.
///
/// `staged_root` = the extracted framework root containing `manifest.json`,
/// `base/`, and any part folders. `data_dir` = `<app_data>`,
/// `agent_root` = `<app_data>/agent_data`, `prompts_root` = `<app_data>/prompts`.
pub(crate) fn install_framework(
    staged_root: &Path,
    source_url: &str,
    choices: &JsonValue,
    manifest: &Manifest,
    config: &Config,
    data_dir: &Path,
    agent_root: &Path,
    prompts_root: &Path,
) -> Result<ImportResult, String> {
    let bt0 = Instant::now();

    let content_root = agent_root.to_path_buf();

    // Resolve which parts to install from the config + choices.
    let selected_parts = config.selected_parts(choices);
    // base/ is always installed; selected parts after it (order matters only
    // for last-wins on conflicts, which base-then-parts gives us).
    let mut part_names: Vec<String> = vec!["base".to_string()];
    part_names.extend(selected_parts.into_iter().filter(|p| {
        // Guard against a choice accidentally naming "base" and against
        // part folders that don't exist.
        p != "base" && staged_root.join(p).is_dir()
    }));

    let mut note: Option<String> = None;
    let base_dir = staged_root.join("base");
    if !base_dir.is_dir() {
        return Err(
            "Framework ZIP is missing a 'base/' folder. The new layout requires \
             base/prompts/ and/or base/agent_files/."
                .into(),
        );
    }

    // Detect update vs fresh install. An update is one with the same
    // manifest id already present.
    let installed = package_manifest::read_installed_framework(data_dir);
    let is_update = installed
        .as_ref()
        .map(|i| i.id == manifest.id)
        .unwrap_or(false);

    // Pre-merge cleanup: apply `remove` globs always, and `owned_files`
    // pruning on a same-id update. The set of incoming rels is built from
    // base + the selected parts (what this install will lay down).
    let new_zip_rels = enumerate_install_rels(staged_root, &part_names);
    let roots = MergeRoots {
        prompts_root,
        content_root: &content_root,
    };
    let Cleanup { removed, pruned } =
        cleanup_before_merge(&roots, manifest, is_update, &new_zip_rels);
    log::info!(
        "[install] cleanup: removed={}, pruned={}",
        removed,
        pruned
    );

    // Merge with `preserve` honoured. Preserve globs are destination-root
    // relative, matched against the same forward-slash rels.
    let preserve = GlobSet::new(&manifest.preserve);
    let mut preserved = 0usize;
    let mut prompts_files = 0usize;
    let mut agent_files = 0usize;

    for part in &part_names {
        let part_dir = staged_root.join(part);
        let prompts_src = part_dir.join("prompts");
        let agent_src = part_dir.join("agent_files");
        if prompts_src.is_dir() {
            let (n, p) = merge_dir(&prompts_src, prompts_root, "prompts/", &preserve)
                .map_err(|e| format!("Failed to copy prompts ({}): {}", part, e))?;
            prompts_files += n;
            preserved += p;
        } else if part == "base" {
            note = Some("No 'base/prompts/' folder found in framework.".to_string());
        }
        if agent_src.is_dir() {
            let (n, p) = merge_dir(&agent_src, &content_root, "", &preserve)
                .map_err(|e| format!("Failed to copy agent_files ({}): {}", part, e))?;
            agent_files += n;
            preserved += p;
        }
    }

    log::info!(
        "[install] merge ({} parts): prompts={}, agent={}, preserved={}",
        part_names.len(),
        prompts_files,
        agent_files,
        preserved
    );
    log::info!("[install] took {:.2}s", bt0.elapsed().as_secs_f64());

    // Record the installed framework (with source url + choices for later
    // update checks and re-installs).
    // Root-level onboarding.json: install (or, on update without one,
    // remove) the framework's deterministic first-run questions.
    let staged_onboarding = staged_root.join("onboarding.json");
    if staged_onboarding.is_file() {
        std::fs::copy(&staged_onboarding, data_dir.join("onboarding.json"))
            .map_err(|e| format!("Failed to copy onboarding.json: {e}"))?;
    } else if is_update {
        let _ = std::fs::remove_file(data_dir.join("onboarding.json"));
    }

    let record = installed_from_manifest(manifest, source_url, choices);
    write_installed_framework(data_dir, &record)?;

    Ok(ImportResult {
        kind: "framework".to_string(),
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        description: manifest.description.clone(),
        version: manifest.version.clone(),
        prompts_files,
        agent_files,
        preserved,
        removed,
        pruned,
        updated: is_update,
        note,
    })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Open the picked ZIP for reading, returning a seekable reader.
///
/// A `content://` URI (returned by the Android file picker) is fully read
/// into memory via the Android-aware FS plugin and wrapped in a `Cursor`.
/// Any other value is treated as a regular filesystem path.
pub(crate) async fn open_zip(app: &AppHandle, zip_path: &str) -> Result<ZipInput, String> {
    if zip_path.starts_with("content://") {
        use tauri_plugin_android_fs::{AndroidFsExt, FileUri};
        let uri = FileUri::from_uri(zip_path);
        let api = app.android_fs_async();

        let file = api
            .open_file_readable(&uri)
            .await
            .map_err(|e| format!("Failed to open Android content URI '{}': {}", zip_path, e))?;

        let bytes = tauri::async_runtime::spawn_blocking(move || {
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut std::io::BufReader::new(file), &mut buf)?;
            Ok::<Vec<u8>, std::io::Error>(buf)
        })
        .await
        .map_err(|e| format!("Read task panicked: {}", e))?
        .map_err(|e| format!("Failed to read content URI '{}': {}", zip_path, e))?;

        Ok(ZipInput::Memory(Cursor::new(bytes)))
    } else {
        let path = PathBuf::from(zip_path);
        if !path.exists() {
            return Err(format!("ZIP file not found: {}", zip_path));
        }
        let file =
            fs::File::open(&path).map_err(|e| format!("Failed to open '{}': {}", zip_path, e))?;
        Ok(ZipInput::File(file))
    }
}

/// Seekable reader that abstracts over a real file (desktop) or an
/// in-memory buffer (Android content:// URI).
pub(crate) enum ZipInput {
    File(fs::File),
    Memory(Cursor<Vec<u8>>),
}

impl Read for ZipInput {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            ZipInput::File(f) => f.read(buf),
            ZipInput::Memory(c) => c.read(buf),
        }
    }
}

impl Seek for ZipInput {
    fn seek(&mut self, pos: io::SeekFrom) -> io::Result<u64> {
        match self {
            ZipInput::File(f) => f.seek(pos),
            ZipInput::Memory(c) => c.seek(pos),
        }
    }
}

/// Extract every entry from a seekable ZIP reader into `dest`, preserving
/// directory structure. Empty directory entries (`/`-suffixed names) are
/// honoured.
fn extract_zip(reader: impl Read + Seek, dest: &Path) -> io::Result<()> {
    fs::create_dir_all(dest)?;
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
        let entry_name = entry.name().to_string();

        // Skip absolute paths and parent-dir escapes for safety.
        if entry_name.starts_with('/') || entry_name.split('/').any(|c| c == "..") {
            continue;
        }

        let out_path = dest.join(&entry_name);

        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&out_path)?;
        io::copy(&mut entry, &mut out)?;
    }
    Ok(())
}

/// If `dir` contains exactly one subdirectory and no files, return that
/// subdirectory. Otherwise return `dir` itself. This lets users zip either
/// `framework/...` or the bare contents.
pub(crate) fn resolve_package_root(dir: &Path) -> PathBuf {
    let mut entries = match fs::read_dir(dir) {
        Ok(it) => it.flatten(),
        Err(_) => return dir.to_path_buf(),
    };

    let first = match entries.next() {
        Some(e) => e,
        None => return dir.to_path_buf(),
    };
    if entries.next().is_some() {
        return dir.to_path_buf();
    }

    let path = first.path();
    if path.is_dir() {
        path
    } else {
        dir.to_path_buf()
    }
}

/// Recursively merge `src` into `dest`, overwriting files that already
/// exist **unless** they match a `preserve` glob. `rel_prefix` is the
/// destination-relative prefix of the current directory (e.g. `"prompts/"`
/// for prompt-store files, `""` for sandbox-root files); a file's full rel
/// for glob matching is `rel_prefix + file_name`. Returns
/// `(files_copied, files_preserved)`.
fn merge_dir(
    src: &Path,
    dest: &Path,
    rel_prefix: &str,
    preserve: &GlobSet,
) -> io::Result<(usize, usize)> {
    if !src.is_dir() {
        return Ok((0, 0));
    }
    fs::create_dir_all(dest)?;
    let mut copied = 0usize;
    let mut preserved = 0usize;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = entry.file_type()?;
        if meta.is_dir() {
            let child_prefix = format!("{rel_prefix}{name}/");
            let (c, p) = merge_dir(&from, &to, &child_prefix, preserve)?;
            copied += c;
            preserved += p;
        } else if meta.is_file() {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)?;
            }
            let rel = format!("{rel_prefix}{name}");
            if to.exists() && !preserve.is_empty() && preserve.matches(&rel) {
                preserved += 1;
                continue;
            }
            fs::copy(&from, &to)?;
            copied += 1;
        }
        // Symlinks are ignored — we don't follow them across the trust
        // boundary represented by an imported archive.
    }
    Ok((copied, preserved))
}

/// Enumerate every file under `base/` + the given parts as a set of
/// destination-relative forward-slash paths (tagged with `prompts/` for
/// prompt-store files, bare for sandbox files). Used to decide which owned
/// files are absent from the incoming install during the pruning pass.
fn enumerate_install_rels(staged_root: &Path, parts: &[String]) -> HashSet<String> {
    let mut set = HashSet::new();
    for part in parts {
        let part_dir = staged_root.join(part);
        let prompts_src = part_dir.join("prompts");
        let agent_src = part_dir.join("agent_files");
        if prompts_src.is_dir() {
            collect_rels(&prompts_src, &prompts_src, "prompts/", &mut set);
        }
        if agent_src.is_dir() {
            collect_rels(&agent_src, &agent_src, "", &mut set);
        }
    }
    set
}

/// Recursive helper for [`enumerate_install_rels`]. `prefix` is prepended to
/// each rel ("prompts/" for prompt-store files, "" for sandbox files).
fn collect_rels(base: &Path, dir: &Path, prefix: &str, out: &mut HashSet<String>) {
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
        let name = entry.file_name().to_string_lossy().to_string();
        if meta.is_dir() {
            let child_prefix = format!("{prefix}{name}/");
            collect_rels(base, &path, &child_prefix, out);
        } else if meta.is_file() {
            let rel = format!("{prefix}{name}");
            out.insert(rel);
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Tauri command: stage a framework from a picked ZIP file. Extracts + parses
/// the manifest + config but performs no writes to the live data dirs.
/// Returns the parsed framework so the UI can render the config options, or
/// `null` if the user cancelled the file dialog.
#[tauri::command]
pub async fn stage_framework_from_file(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<StagedFramework>, String> {
    use tauri_plugin_dialog::DialogExt;

    // Blocking file picker. On Android this returns a content:// URI which
    // `open_zip` knows how to stream into memory.
    let zip_path = app
        .dialog()
        .file()
        .add_filter("ZIP archive", &["zip"])
        .blocking_pick_file();
    let zip_path = match zip_path {
        Some(p) => p,
        None => return Ok(None), // user cancelled
    };
    let zip_path_str = file_path_to_string(&zip_path);

    let staging_dir = state.staging_dir.clone();
    let tmp_base = state.data_dir.join(".tmp");

    // Read the ZIP via the platform-aware opener, then stage it.
    let zip_input = open_zip(&app, &zip_path_str).await?;

    tauri::async_runtime::spawn_blocking(move || {
        stage_to_persistent(zip_input, &tmp_base, &staging_dir, "")
    })
    .await
    .map_err(|e| format!("Stage task failed: {}", e))?
    .map(Some)
}

/// Tauri command: stage a framework from an update-channel index URL.
/// Fetches the index, downloads + verifies the ZIP (streaming progress to
/// `framework-download-progress`), extracts + parses it into the staging
/// dir. No writes to the live data dirs.
#[tauri::command]
pub async fn stage_framework_from_url(
    url: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<StagedFramework, String> {
    let staging_dir = state.staging_dir.clone();
    let tmp_base = state.data_dir.join(".tmp");

    tauri::async_runtime::spawn_blocking(move || -> Result<StagedFramework, String> {
        // 1. Fetch + parse the index.
        let index = crate::framework_updater::fetch_index(&url)?;

        // 2. Download + verify the ZIP, streaming progress to the UI.
        let progress_app = app.clone();
        let bytes = crate::framework_updater::download_bytes(&index, &tmp_base, |d, t| {
            let _ = progress_app.emit(
                "framework-download-progress",
                serde_json::json!({ "downloaded": d, "total": t }),
            );
        })?;

        // 3. Extract + parse into the persistent staging dir.
        stage_to_persistent(
            Cursor::new(bytes),
            &tmp_base,
            &staging_dir,
            &url, // source_url for the eventual install record
        )
    })
    .await
    .map_err(|e| format!("Stage task failed: {}", e))?
}

/// Tauri command: re-read the currently staged framework (manifest + config),
/// or `null` if nothing is staged. Lets the UI re-enter the options step.
#[tauri::command]
pub fn get_staged_framework(state: State<'_, AppState>) -> Option<StagedFramework> {
    let meta = read_staged_meta(&state.staging_dir).ok()?;
    Some(StagedFramework {
        manifest: meta.manifest,
        config: meta.config,
        source_url: meta.source_url,
    })
}

/// Tauri command: install the currently staged framework with the given
/// choices. Runs the cleanup + merge pipeline and writes the installed
/// record. Clears staging on success.
#[tauri::command]
pub async fn install_staged_framework(
    app: AppHandle,
    choices: JsonValue,
    state: State<'_, AppState>,
) -> Result<ImportResult, String> {
    let staging_dir = state.staging_dir.clone();
    let data_dir = state.data_dir.clone();
    let agent_root = state.agent_dir.clone();
    let prompts_root = state.data_dir.join("prompts");

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<ImportResult, String> {
        let meta = read_staged_meta(&staging_dir)?;
        let result = install_framework(
            &meta.root,
            &meta.source_url,
            &choices,
            &meta.manifest,
            &meta.config,
            &data_dir,
            &agent_root,
            &prompts_root,
        );
        if result.is_ok() {
            let _ = fs::remove_dir_all(&staging_dir);
            fs::create_dir_all(&staging_dir).ok();
        }
        result
    })
    .await
    .map_err(|e| format!("Install task failed: {}", e))??;
    // The prompt store and `{{include}}` targets (e.g. USER.md) were just
    // rewritten — the frontend rebuilds its cached system prompt so the
    // agent doesn't keep running the previous framework's prompts.
    let _ = app.emit(crate::PROMPT_INPUTS_CHANGED, ());
    Ok(result)
}

/// Tauri command: discard anything currently staged.
#[tauri::command]
pub async fn discard_staged_framework(state: State<'_, AppState>) -> Result<(), String> {
    let staging_dir = state.staging_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = fs::remove_dir_all(&staging_dir);
        fs::create_dir_all(&staging_dir).ok();
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Discard task failed: {}", e))?
}

// ---------------------------------------------------------------------------
// Persistent staging helpers
// ---------------------------------------------------------------------------

/// Parsed framework read back from the staging dir.
struct StagedMeta {
    root: PathBuf,
    manifest: Manifest,
    config: Config,
    source_url: String,
}

/// Extract `zip_input` into a fresh `staging_dir`, resolve the framework
/// root, parse manifest + config, and persist `source_url` alongside so a
/// later install (possibly in a new app session) still knows where the
/// framework came from. Returns the staged framework descriptor.
fn stage_to_persistent<R: Read + Seek + Send + 'static>(
    zip_input: R,
    tmp_base: &Path,
    staging_dir: &Path,
    source_url: &str,
) -> Result<StagedFramework, String> {
    // Extract into a temp dir first (validated), then copy into staging.
    fs::create_dir_all(tmp_base).ok();
    let temp = tempfile::tempdir_in(tmp_base)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    extract_zip(zip_input, temp.path()).map_err(|e| format!("Failed to extract ZIP: {}", e))?;
    let pkg_root = resolve_package_root(temp.path());

    let manifest = Manifest::from_pkg_root(&pkg_root)?;
    let app_version = env!("CARGO_PKG_VERSION");
    if manifest.rejects_app_version(app_version) {
        return Err(format!(
            "This framework requires app version {} or newer (you are running {}). \
             Please update the app before importing.",
            manifest.min_app_version.as_deref().unwrap_or("?"),
            app_version
        ));
    }
    let config = Config::from_pkg_root(&pkg_root)?;
    crate::onboarding::from_pkg_root(&pkg_root)?; // validates when present

    // Reset the persistent staging dir and copy the framework into it.
    let _ = fs::remove_dir_all(staging_dir);
    copy_dir(&pkg_root, staging_dir)
        .map_err(|e| format!("Failed to stage framework: {}", e))?;

    // Persist the source url so install (possibly later) still knows it.
    let _ = fs::write(staging_dir.join(".source_url"), source_url);

    Ok(StagedFramework {
        manifest,
        config,
        source_url: source_url.to_string(),
    })
}

/// Read the staged framework back from disk (used by `get_staged_framework`
/// and `install_staged_framework`).
fn read_staged_meta(staging_dir: &Path) -> Result<StagedMeta, String> {
    if !staging_dir.is_dir() {
        return Err("No framework is staged.".into());
    }
    let manifest = Manifest::from_pkg_root(staging_dir)?;
    let config = Config::from_pkg_root(staging_dir)?;
    let source_url = fs::read_to_string(staging_dir.join(".source_url"))
        .unwrap_or_default();
    Ok(StagedMeta {
        root: staging_dir.to_path_buf(),
        manifest,
        config,
        source_url,
    })
}

/// Recursively copy a directory tree from `src` to `dest` (overwriting).
fn copy_dir(src: &Path, dest: &Path) -> io::Result<()> {
    if !dest.exists() {
        fs::create_dir_all(dest)?;
    }
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let meta = entry.file_type()?;
        if meta.is_dir() {
            copy_dir(&from, &to)?;
        } else if meta.is_file() {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Normalise a tauri dialog FilePath into a string the opener understands.
fn file_path_to_string(p: &tauri_plugin_dialog::FilePath) -> String {
    match p {
        tauri_plugin_dialog::FilePath::Path(p) => p.to_string_lossy().to_string(),
        tauri_plugin_dialog::FilePath::Url(u) => u.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use package_manifest::OptionGroup;
    use tempfile::tempdir;

    /// Build a fake framework root with base + parts, then run
    /// [`install_framework`] against temp data dirs and assert what landed.
    fn build_framework_root(dir: &Path) {
        // base/prompts/main_agent.md, base/agent_files/USER.md
        let base = dir.join("base");
        fs::create_dir_all(base.join("prompts")).unwrap();
        fs::create_dir_all(base.join("agent_files")).unwrap();
        fs::write(base.join("prompts").join("main_agent.md"), "prompt").unwrap();
        fs::write(base.join("agent_files").join("USER.md"), "user").unwrap();
        // part_light/agent_files/intensity.md
        fs::create_dir_all(dir.join("part_light").join("agent_files")).unwrap();
        fs::write(
            dir.join("part_light").join("agent_files").join("intensity.md"),
            "light",
        )
        .unwrap();
        // part_hard/agent_files/intensity.md
        fs::create_dir_all(dir.join("part_hard").join("agent_files")).unwrap();
        fs::write(
            dir.join("part_hard").join("agent_files").join("intensity.md"),
            "hard",
        )
        .unwrap();
    }

    fn write_manifest(dir: &Path) {
        fs::write(
            dir.join("manifest.json"),
            r#"{
                "id": "test-fw",
                "name": "Test",
                "description": "d",
                "version": "1.0.0"
            }"#,
        )
        .unwrap();
    }

    fn write_config(dir: &Path) {
        fs::write(
            dir.join("config.json"),
            r#"{
                "options": [
                    {
                        "type": "single",
                        "id": "intensity",
                        "title": "Intensity",
                        "description": "",
                        "default": "light",
                        "choices": [
                            { "id": "light", "label": "Light", "description": "", "part": "part_light" },
                            { "id": "hard", "label": "Hard", "description": "", "part": "part_hard" }
                        ]
                    }
                ]
            }"#,
        )
        .unwrap();
    }

    #[test]
    fn test_install_base_only() {
        let root = tempdir().unwrap();
        build_framework_root(root.path());
        write_manifest(root.path());
        let data = tempdir().unwrap();
        let prompts = data.path().join("prompts");
        let agent = data.path().join("agent_data");
        fs::create_dir_all(&prompts).unwrap();
        fs::create_dir_all(&agent).unwrap();

        let manifest = Manifest::from_pkg_root(root.path()).unwrap();
        let config = Config::from_pkg_root(root.path()).unwrap();
        let res = install_framework(
            root.path(),
            "",
            &serde_json::Value::Null,
            &manifest,
            &config,
            data.path(),
            &agent,
            &prompts,
        )
        .unwrap();

        // Empty config → only base installed: base/USER.md (1 agent file).
        assert_eq!(res.prompts_files, 1);
        assert_eq!(res.agent_files, 1);
        assert!(prompts.join("main_agent.md").exists());
        assert!(agent.join("USER.md").exists());
        // No part selected → intensity.md not installed.
        assert!(!agent.join("intensity.md").exists());
    }

    #[test]
    fn test_install_with_choices() {
        let root = tempdir().unwrap();
        build_framework_root(root.path());
        write_manifest(root.path());
        write_config(root.path());
        let data = tempdir().unwrap();
        let prompts = data.path().join("prompts");
        let agent = data.path().join("agent_data");
        fs::create_dir_all(&prompts).unwrap();
        fs::create_dir_all(&agent).unwrap();

        let manifest = Manifest::from_pkg_root(root.path()).unwrap();
        let config = Config::from_pkg_root(root.path()).unwrap();
        let choices = serde_json::json!({ "intensity": "hard" });
        let res = install_framework(
            root.path(),
            "https://example.com/index.json",
            &choices,
            &manifest,
            &config,
            data.path(),
            &agent,
            &prompts,
        )
        .unwrap();

        assert_eq!(res.agent_files, 2);
        assert_eq!(
            fs::read_to_string(agent.join("intensity.md")).unwrap(),
            "hard"
        );

        // Record saved with source_url + choices.
        let rec = package_manifest::read_installed_framework(data.path()).unwrap();
        assert_eq!(rec.source_url, "https://example.com/index.json");
        assert_eq!(rec.choices, choices);
    }

    #[test]
    fn test_config_selected_parts_uses_default() {
        let cfg = Config {
            options: vec![OptionGroup::Single {
                id: "intensity".into(),
                title: "t".into(),
                description: "".into(),
                default: "medium".into(),
                choices: vec![
                    package_manifest::Choice {
                        id: "light".into(),
                        label: "l".into(),
                        description: "".into(),
                        part: "part_light".into(),
                    },
                    package_manifest::Choice {
                        id: "medium".into(),
                        label: "m".into(),
                        description: "".into(),
                        part: "part_medium".into(),
                    },
                ],
            }],
        };
        // No choices → default ("medium").
        let parts = cfg.selected_parts(&serde_json::Value::Null);
        assert_eq!(parts, vec!["part_medium".to_string()]);

        // Explicit choice overrides default.
        let parts = cfg.selected_parts(&serde_json::json!({ "intensity": "light" }));
        assert_eq!(parts, vec!["part_light".to_string()]);
    }

    #[test]
    fn test_config_multiple_group() {
        let cfg = Config {
            options: vec![OptionGroup::Multiple {
                id: "extras".into(),
                title: "t".into(),
                description: "".into(),
                default: vec![],
                choices: vec![
                    package_manifest::Choice {
                        id: "journal".into(),
                        label: "j".into(),
                        description: "".into(),
                        part: "journal".into(),
                    },
                    package_manifest::Choice {
                        id: "fitness".into(),
                        label: "f".into(),
                        description: "".into(),
                        part: "fitness".into(),
                    },
                ],
            }],
        };
        let parts =
            cfg.selected_parts(&serde_json::json!({ "extras": ["journal", "fitness"] }));
        assert_eq!(parts, vec!["journal".to_string(), "fitness".to_string()]);

        // Empty selection → no parts.
        let parts = cfg.selected_parts(&serde_json::json!({ "extras": [] }));
        assert!(parts.is_empty());
    }

    #[test]
    fn test_install_rejects_missing_base() {
        let root = tempdir().unwrap();
        // No base/ folder, just a manifest.
        write_manifest(root.path());
        let data = tempdir().unwrap();
        let prompts = data.path().join("prompts");
        let agent = data.path().join("agent_data");

        let manifest = Manifest::from_pkg_root(root.path()).unwrap();
        let config = Config::from_pkg_root(root.path()).unwrap();
        let err = install_framework(
            root.path(),
            "",
            &serde_json::Value::Null,
            &manifest,
            &config,
            data.path(),
            &agent,
            &prompts,
        )
        .unwrap_err();
        assert!(err.contains("base/"));
    }
}
