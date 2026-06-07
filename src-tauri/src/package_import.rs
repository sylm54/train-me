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
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

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
#[tauri::command]
pub fn import_package(
    zip_path: String,
    kind: String,
    state: State<'_, AppState>,
) -> Result<ImportResult, String> {
    let pkg_kind = PackageKind::parse(&kind)?;

    let zip_file = PathBuf::from(&zip_path);
    if !zip_file.exists() {
        return Err(format!("ZIP file not found: {}", zip_path));
    }

    let prompts_root = state.data_dir.join("prompts");
    let agent_root = state.agent_dir.clone();

    // For specialisations, non-prompt content lands under `special/`.
    let content_root = match pkg_kind {
        PackageKind::Framework => agent_root.clone(),
        PackageKind::Specialisation => agent_root.join("special"),
    };

    // Extract to a temp directory first so we can validate/inspect before
    // mutating the user's data folders.
    let temp = tempfile::tempdir().map_err(|e| format!("Failed to create temp dir: {}", e))?;
    extract_zip(&zip_file, temp.path()).map_err(|e| format!("Failed to extract ZIP: {}", e))?;

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
    } else {
        note = Some("No 'prompts/' folder found in package.".to_string());
    }

    // Merge everything else (except the prompts/ folder we already handled)
    // into the content root.
    let agent_files = merge_package_into(&pkg_root, &content_root, &prompts_src)
        .map_err(|e| format!("Failed to copy agent files: {}", e))?;

    Ok(ImportResult {
        kind: pkg_kind.as_str().to_string(),
        prompts_files,
        agent_files,
        note,
    })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Extract every entry from `zip_path` into `dest`, preserving directory
/// structure. Empty directory entries (`/`-suffixed names) are honoured.
fn extract_zip(zip_path: &Path, dest: &Path) -> io::Result<()> {
    fs::create_dir_all(dest)?;
    let file = fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)
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
