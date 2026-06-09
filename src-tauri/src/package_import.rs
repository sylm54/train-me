//! Package import: extract a user-supplied ZIP archive into the app's
//! data directories.
//!
//! A "package" is a ZIP file whose contents are merged into the running
//! app's data area. Two package kinds are recognised:
//!
//! - **Framework** (`kind = "framework"`): a full agent framework. Its
//!   `prompts/` folder is merged into `<data_dir>/prompts/` (the prompt
//!   store, kept outside the sandbox). Everything else is merged into the
//!   agent sandbox root (`<data_dir>/agent_data/`).
//!
//! - **Specialisation** (`kind = "specialisation"`): like a framework,
//!   but its non-prompt content is merged into `<agent_data>/special/`
//!   instead of the sandbox root. `prompts/` is still routed to the prompt
//!   store.
//!
//! Both kinds are designed to be imported on top of each other for
//! updates: existing files with the same relative path are overwritten,
//! unrelated files are left untouched. Directories are created on demand.

use std::fs;
use std::io::{self, Cursor, Read, Seek};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::AppState;

/// Where a package's non-prompt content should be written.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PackageKind {
    /// Merge into the agent sandbox root (`agent_data/`).
    Framework,
    /// Merge into `agent_data/special/`.
    Specialisation,
}

impl PackageKind {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "framework" => Ok(PackageKind::Framework),
            "specialisation" | "specialization" => Ok(PackageKind::Specialisation),
            other => Err(format!(
                "Unknown package kind '{}'. Expected 'framework' or 'specialisation'.",
                other
            )),
        }
    }

    fn as_str(&self) -> &'static str {
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
    /// Number of files copied to `prompts/`.
    pub prompts_files: usize,
    /// Number of files copied into the agent area (sandbox root for
    /// frameworks, `special/` for specialisations).
    pub agent_files: usize,
    /// Optional human-readable note (e.g., "no prompts/ folder found").
    pub note: Option<String>,
}

/// Tauri command: import a package from a ZIP file path.
///
/// `kind` must be `"framework"` or `"specialisation"`. See the module
/// docs for the destination rules of each.
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

    // For specialisations, non-prompt content lands under `special/`.
    let content_root = match pkg_kind {
        PackageKind::Framework => agent_root.clone(),
        PackageKind::Specialisation => agent_root.join("special"),
    };

    // The extraction and merging are synchronous, blocking I/O — run them
    // on a blocking thread so we don't stall the async runtime.
    let kind_str = pkg_kind.as_str().to_string();
    // Use the app's own data directory as the temp base so we don't
    // depend on /data/local/tmp being writable (it isn't on Android
    // emulators and some devices).
    let tmp_base = state.data_dir.join(".tmp");

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<ImportResult, String> {
        let bt0 = Instant::now();

        // Extract to a temp directory first so we can validate/inspect before
        // mutating the user's data folders.
        fs::create_dir_all(&tmp_base).ok();
        let temp = tempfile::tempdir_in(&tmp_base)
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

        // Look for a `prompts/` folder inside the package root. If it's absent
        // we still import the remaining files, but flag it in the result so
        // the UI can warn the user.
        let prompts_src = pkg_root.join("prompts");
        let mut prompts_files = 0usize;
        let mut note: Option<String> = None;

        if prompts_src.is_dir() {
            prompts_files = merge_dir(&prompts_src, &prompts_root)
                .map_err(|e| format!("Failed to copy prompts: {}", e))?;
            log::info!(
                "[import] merge prompts ({}) took {:.2}s",
                prompts_files,
                bt0.elapsed().as_secs_f64()
            );
        } else {
            note = Some("No 'prompts/' folder found in package.".to_string());
        }

        // Merge everything else (except the prompts/ folder we already handled)
        // into the content root.
        let agent_files = merge_package_into(&pkg_root, &content_root, &prompts_src)
            .map_err(|e| format!("Failed to copy agent files: {}", e))?;
        log::info!(
            "[import] merge agent files ({}) took {:.2}s",
            agent_files,
            bt0.elapsed().as_secs_f64()
        );

        Ok(ImportResult {
            kind: kind_str,
            prompts_files,
            agent_files,
            note,
        })
    })
    .await
    .map_err(|e| format!("Import task failed: {}", e))?;

    log::info!("[import] total took {:.2}s", t0.elapsed().as_secs_f64());
    result
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
/// exist. Returns the number of files copied.
fn merge_dir(src: &Path, dest: &Path) -> io::Result<usize> {
    if !src.is_dir() {
        return Ok(0);
    }
    fs::create_dir_all(dest)?;
    let mut count = 0usize;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let meta = entry.file_type()?;
        if meta.is_dir() {
            count += merge_dir(&from, &to)?;
        } else if meta.is_file() {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&from, &to)?;
            count += 1;
        }
        // Symlinks are ignored — we don't follow them across the trust
        // boundary represented by an imported archive.
    }
    Ok(count)
}

/// Merge the package root into `dest`, skipping the `prompts/` folder
/// (which has already been merged into the prompts dir).
fn merge_package_into(pkg_root: &Path, dest: &Path, prompts_src: &Path) -> io::Result<usize> {
    fs::create_dir_all(dest)?;
    let mut count = 0usize;
    for entry in fs::read_dir(pkg_root)? {
        let entry = entry?;
        let from = entry.path();

        // Skip the prompts folder — already handled.
        if from == prompts_src {
            continue;
        }

        let to = dest.join(entry.file_name());
        let meta = entry.file_type()?;
        if meta.is_dir() {
            count += merge_dir(&from, &to)?;
        } else if meta.is_file() {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&from, &to)?;
            count += 1;
        }
    }
    Ok(count)
}
