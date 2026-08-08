//! Package import: extract a user-supplied ZIP archive into the app's
//! data directories, honouring a mandatory [`package_manifest::Manifest`].
//!
//! A "package" is a ZIP whose root must contain a `manifest.json`. Two
//! package kinds are recognised:
//!
//! - **Framework** (`kind = "framework"`): a full agent framework. Its
//!   `prompts/` folder is merged into `<data_dir>/prompts/` (the prompt
//!   store, kept outside the sandbox). Everything else is merged into the
//!   agent sandbox root (`<data_dir>/agent_data/`). On success an
//!   installed-framework record is written to `<data_dir>/framework.json`.
//!
//! - **Specialisation** (`kind = "specialisation"`): like a framework,
//!   but its non-prompt content is merged into `<agent_data>/special/`
//!   instead of the sandbox root. `prompts/` is still routed to the prompt
//!   store. No installed-framework record is written (specialisations are
//!   additive).
//!
//! ## Merge semantics
//!
//! The manifest drives three behaviours, applied in order:
//!
//! 1. **Cleanup** (pre-merge): explicit `remove` globs delete matching files.
//!    On an update (same `id` already installed) `owned_files` globs also
//!    prune any owned file that is absent from the new ZIP, so renamed or
//!    removed files don't linger.
//! 2. **Merge**: files are copied from the extracted ZIP into the prompt store
//!    and content root, **skipping** any path that matches a `preserve` glob
//!    and already exists on disk — this protects user-authored content such
//!    as `USER.md` or `journal/**` from being clobbered on update.
//! 3. **Record**: for a framework, `<data_dir>/framework.json` is
//!    (over)written with the manifest's identity + version.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Cursor, Read, Seek};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::package_manifest::{
    self, cleanup_before_merge, installed_from_manifest, write_installed_framework, Cleanup,
    GlobSet, MergeRoots,
};
use crate::AppState;

/// Where a package's non-prompt content should be written.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PackageKind {
    /// Merge into the agent sandbox root (`agent_data/`).
    Framework,
    /// Merge into `agent_data/special/`.
    Specialisation,
}

impl PackageKind {
    pub(crate) fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "framework" => Ok(PackageKind::Framework),
            "specialisation" | "specialization" => Ok(PackageKind::Specialisation),
            other => Err(format!(
                "Unknown package kind '{}'. Expected 'framework' or 'specialisation'.",
                other
            )),
        }
    }

    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            PackageKind::Framework => "framework",
            PackageKind::Specialisation => "specialisation",
        }
    }
}

/// Result returned by the `import_package` Tauri command.
#[derive(Serialize, Clone, Debug)]
pub struct ImportResult {
    /// Which kind was imported (`"framework"` / `"specialisation"`).
    pub kind: String,
    /// Manifest identity of the imported package.
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    /// Number of files copied to `prompts/`.
    pub prompts_files: usize,
    /// Number of files copied into the agent area (sandbox root for
    /// frameworks, `special/` for specialisations).
    pub agent_files: usize,
    /// Number of existing files left untouched because a `preserve` glob
    /// matched them (user content protected from overwrite).
    pub preserved: usize,
    /// Files deleted by explicit `remove` globs.
    pub removed: usize,
    /// Files deleted by `owned_files` pruning (owned + absent from new ZIP).
    pub pruned: usize,
    /// Whether this import was an update (same framework id already
    /// installed) or a fresh install.
    pub updated: bool,
    /// Optional human-readable note.
    pub note: Option<String>,
}

/// Tauri command: import a package from a ZIP file path.
///
/// `kind` must be `"framework"` or `"specialisation"`. See the module
/// docs for the destination rules and merge semantics of each.
///
/// On Android the file picker returns a `content://` URI rather than a
/// filesystem path. Such URIs are fully read into memory through the
/// Android-aware FS plugin (`tauri-plugin-android-fs`) and then presented
/// as a seekable `Cursor<Vec<u8>>`. This avoids relying on the raw file
/// descriptor being seekable or staying valid across threads.
#[tauri::command]
pub async fn import_package(
    app: AppHandle,
    zip_path: String,
    kind: String,
    state: State<'_, AppState>,
) -> Result<ImportResult, String> {
    let t0 = Instant::now();
    let pkg_kind = PackageKind::parse(&kind)?;
    log::info!("[import] command invoked, zip_path={}", zip_path);

    // Obtain a readable handle to the ZIP. On Android the entire file is
    // read into memory via the ContentResolver so we get a seekable reader
    // that is independent of the Android file descriptor's lifetime.
    let zip_input = open_zip(&app, &zip_path).await?;
    log::info!("[import] open_zip took {:.2}s", t0.elapsed().as_secs_f64());

    let prompts_root = state.data_dir.join("prompts");
    let agent_root = state.agent_dir.clone();
    let data_dir = state.data_dir.clone();
    let tmp_base = state.data_dir.join(".tmp");

    let result = tauri::async_runtime::spawn_blocking(move || {
        import_from_zip_input(zip_input, pkg_kind, &data_dir, &agent_root, &prompts_root, &tmp_base)
    })
    .await
    .map_err(|e| format!("Import task failed: {}", e))?;

    log::info!("[import] total took {:.2}s", t0.elapsed().as_secs_f64());
    result
}

/// Core import pipeline, run on a blocking thread. Shared by the
/// [`import_package`] command (file picker) and the framework updater
/// (downloaded bytes). Extracts the ZIP to a temp dir, parses the mandatory
/// manifest, runs cleanup (`remove` + `owned_files` pruning on update), merges
/// with `preserve` honoured, and writes the installed-framework record for
/// frameworks.
///
/// `prompts_root` = `<data_dir>/prompts`, `agent_root` = `<data_dir>/agent_data`,
/// `tmp_base` = a temp dir (the app's `.tmp`).
pub(crate) fn import_from_zip_input<R: Read + Seek + Send + 'static>(
    zip_input: R,
    pkg_kind: PackageKind,
    data_dir: &Path,
    agent_root: &Path,
    prompts_root: &Path,
    tmp_base: &Path,
) -> Result<ImportResult, String> {
    let bt0 = Instant::now();

    // For specialisations, non-prompt content lands under `special/`.
    let content_root = match pkg_kind {
        PackageKind::Framework => agent_root.to_path_buf(),
        PackageKind::Specialisation => agent_root.join("special"),
    };
    let kind_str = pkg_kind.as_str().to_string();
    let is_framework = pkg_kind == PackageKind::Framework;

    // Extract to a temp directory first so we can validate/inspect before
    // mutating the user's data folders.
    fs::create_dir_all(tmp_base).ok();
    let temp = tempfile::tempdir_in(tmp_base)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    log::info!("[import] tempdir took {:.2}s", bt0.elapsed().as_secs_f64());

    extract_zip(zip_input, temp.path()).map_err(|e| format!("Failed to extract ZIP: {}", e))?;
    log::info!(
        "[import] extract_zip took {:.2}s",
        bt0.elapsed().as_secs_f64()
    );

    // Determine the "package root" — either the temp dir itself, or its
    // sole sub-directory if the archive contains a single top-level folder
    // (a common convention when zipping a project folder).
    let pkg_root = resolve_package_root(temp.path());

    // The manifest is mandatory.
    let manifest = package_manifest::Manifest::from_pkg_root(&pkg_root)?;
    // Gate on min_app_version when knowable. The crate version is the
    // running app version.
    let app_version = env!("CARGO_PKG_VERSION");
    if manifest.rejects_app_version(app_version) {
        return Err(format!(
            "This package requires app version {} or newer (you are running {}). \
             Please update the app before importing.",
            manifest.min_app_version.as_deref().unwrap_or("?"),
            app_version
        ));
    }

    let prompts_src = pkg_root.join("prompts");
    let mut note: Option<String> = None;
    if !prompts_src.is_dir() {
        note = Some("No 'prompts/' folder found in package.".to_string());
    }

    // Detect update vs fresh install (frameworks only — they carry the
    // installed record). An update is one with the same manifest id
    // already present.
    let installed = package_manifest::read_installed_framework(data_dir);
    let is_update = is_framework
        && installed.as_ref().map(|i| i.id == manifest.id).unwrap_or(false);

    // Pre-merge cleanup: apply `remove` globs always, and `owned_files`
    // pruning on a same-id update.
    let new_zip_rels = enumerate_package_rels(&pkg_root);
    let roots = MergeRoots {
        prompts_root,
        content_root: &content_root,
    };
    let Cleanup { removed, pruned } =
        cleanup_before_merge(&roots, &manifest, is_update, &new_zip_rels);
    log::info!(
        "[import] cleanup: removed={}, pruned={}",
        removed,
        pruned
    );

    // Merge with `preserve` honoured. `preserve` globs are package-root
    // relative, so we match against the same forward-slash rels.
    let preserve = GlobSet::new(&manifest.preserve);
    let mut preserved = 0usize;

    let prompts_files = if prompts_src.is_dir() {
        let (n, p) =
            merge_dir(&prompts_src, prompts_root, "prompts/", &preserve)
                .map_err(|e| format!("Failed to copy prompts: {}", e))?;
        preserved += p;
        n
    } else {
        0
    };
    let agent_files = {
        let (n, p) = merge_package_into(&pkg_root, &content_root, &prompts_src, &preserve)
            .map_err(|e| format!("Failed to copy agent files: {}", e))?;
        preserved += p;
        n
    };

    log::info!(
        "[import] merge: prompts={}, agent={}, preserved={}",
        prompts_files,
        agent_files,
        preserved
    );

    // Record the installed framework (frameworks only).
    if is_framework {
        write_installed_framework(data_dir, &installed_from_manifest(&manifest))?;
    }

    Ok(ImportResult {
        kind: kind_str,
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
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
/// This avoids depending on the raw file descriptor being seekable or
/// remaining valid when later read on a blocking thread — both of which
/// are unreliable for Android content-provider file descriptors.
///
/// Any other value is treated as a regular filesystem path and opened
/// directly.
async fn open_zip(app: &AppHandle, zip_path: &str) -> Result<ZipInput, String> {
    if zip_path.starts_with("content://") {
        use tauri_plugin_android_fs::{AndroidFsExt, FileUri};
        let uri = FileUri::from_uri(zip_path);
        let api = app.android_fs_async();

        // Step 1: open the file descriptor via the Kotlin plugin IPC.
        let t_fd = Instant::now();
        let file = api
            .open_file_readable(&uri)
            .await
            .map_err(|e| format!("Failed to open Android content URI '{}': {}", zip_path, e))?;
        log::info!(
            "[import] open_file_readable took {:.2}s",
            t_fd.elapsed().as_secs_f64()
        );

        // Step 2: read the entire file into memory on a blocking thread.
        // We do this ourselves instead of using `api.read()` so we can
        // time the IPC and the I/O independently.
        let t_read = Instant::now();
        let bytes = tauri::async_runtime::spawn_blocking(move || {
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut std::io::BufReader::new(file), &mut buf)?;
            Ok::<Vec<u8>, std::io::Error>(buf)
        })
        .await
        .map_err(|e| format!("Read task panicked: {}", e))?
        .map_err(|e| format!("Failed to read content URI '{}': {}", zip_path, e))?;
        log::info!(
            "[import] read {} bytes took {:.2}s",
            bytes.len(),
            t_read.elapsed().as_secs_f64()
        );

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
enum ZipInput {
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
        // Sanitised name (already uses `/` separators on Windows too).
        let entry_name = entry.name().to_string();

        // Skip absolute paths and parent-dir escapes for safety.
        if entry_name.starts_with('/') || entry_name.split('/').any(|c| c == "..") {
            continue;
        }

        let out_path = dest.join(&entry_name);

        // Directory entry: create and continue.
        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }

        // Regular file: ensure parent exists, then copy.
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
/// `package/...` or the bare contents.
fn resolve_package_root(dir: &Path) -> PathBuf {
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
/// package-root-relative prefix of the current directory (e.g. `"prompts/"`
/// or `"journal/"`); a file's full rel for glob matching is
/// `rel_prefix + file_name`. Returns `(files_copied, files_preserved)`.
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
            // Preserve: if the file already exists on disk AND matches a
            // preserve glob, leave it untouched.
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

/// Merge the package root into `dest`, skipping the `prompts/` folder
/// (which has already been merged into the prompts dir). Returns
/// `(files_copied, files_preserved)`.
fn merge_package_into(
    pkg_root: &Path,
    dest: &Path,
    prompts_src: &Path,
    preserve: &GlobSet,
) -> io::Result<(usize, usize)> {
    fs::create_dir_all(dest)?;
    let mut copied = 0usize;
    let mut preserved = 0usize;
    for entry in fs::read_dir(pkg_root)? {
        let entry = entry?;
        let from = entry.path();

        // Skip the prompts folder — already handled.
        if from == prompts_src {
            continue;
        }

        let to = dest.join(entry.file_name());
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = entry.file_type()?;
        if meta.is_dir() {
            // Recurse with a package-root-relative prefix built from this
            // entry's name, so preserve globs match against e.g.
            // `journal/...`.
            let rel_prefix = format!("{name}/");
            let (c, p) = merge_dir(&from, &to, &rel_prefix, preserve)?;
            copied += c;
            preserved += p;
        } else if meta.is_file() {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)?;
            }
            if to.exists() && !preserve.is_empty() && preserve.matches(&name) {
                preserved += 1;
                continue;
            }
            fs::copy(&from, &to)?;
            copied += 1;
        }
    }
    Ok((copied, preserved))
}

/// Enumerate every file under `pkg_root` as a set of package-root-relative
/// forward-slash paths (e.g. `prompts/a.md`, `rules/r1.md`,
/// `manifest.json`). Used to decide which owned files are absent from the
/// incoming ZIP during the pruning pass.
fn enumerate_package_rels(pkg_root: &Path) -> HashSet<String> {
    let mut set = HashSet::new();
    collect_rels(pkg_root, pkg_root, &mut set);
    set
}

/// Recursive helper for [`enumerate_package_rels`].
fn collect_rels(base: &Path, dir: &Path, out: &mut HashSet<String>) {
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
            collect_rels(base, &path, out);
        } else if meta.is_file() {
            if let Ok(rel) = path.strip_prefix(base) {
                let fwd: String = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                out.insert(fwd);
            }
        }
    }
}
