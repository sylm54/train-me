//! Downloads for the pocket-tts engine: `hf://` repo paths and plain
//! `https://` URLs, cached under the app's model directory.
//!
//! Replaces pocket-tts' own `download_if_necessary` (hf-hub + `~/.cache`),
//! so downloads land in the app's managed space and the checkpoint
//! pre-download (`model_downloader`) and the engine share one cache. Files
//! keep their repo path and revision in the cache file name: voice
//! embeddings pin revisions, and two revisions of the same file must not
//! alias. Layout: `<model_dir>/pocket-tts/hf/<owner>/<repo>/<path>@<rev>`
//! (URL-downloaded files go under `url/<sha256><ext>` like upstream).

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Where engine files cache. `<model_dir>/pocket-tts`.
pub fn cache_root(model_dir: &Path) -> PathBuf {
    model_dir.join("pocket-tts")
}

/// Resolve a config reference (`hf://owner/repo/file[@rev]`, `https://…`, or
/// local path) to a local file, downloading when needed.
pub fn download_if_necessary(model_dir: &Path, file_path: &str) -> Result<PathBuf> {
    if file_path.starts_with("http://") || file_path.starts_with("https://") {
        download_url(model_dir, file_path)
    } else if let Some(rest) = file_path.strip_prefix("hf://") {
        let (repo_id, filename, revision) = split_hf_path(rest)?;
        download_hf(model_dir, repo_id, &filename, revision)
            .with_context(|| format!("cannot download {file_path}"))
    } else {
        Ok(PathBuf::from(file_path))
    }
}

/// Download without hitting the network when the file is already cached.
/// Used by the checkpoint pre-download; returns the cached path.
pub fn ensure_downloaded(model_dir: &Path, file_path: &str) -> Result<PathBuf> {
    download_if_necessary(model_dir, file_path)
}

/// Whether `file_path` is already fully cached (no network check — presence
/// of the cache file counts; partial downloads never land at the final path).
pub fn is_cached(model_dir: &Path, file_path: &str) -> bool {
    cached_path(model_dir, file_path).is_some()
}

/// The path a config reference caches to, when it is cached.
pub fn cached_path(model_dir: &Path, file_path: &str) -> Option<PathBuf> {
    resolve_path(model_dir, file_path).filter(|p| p.exists())
}

/// The path a config reference caches to, present or not.
fn resolve_path(model_dir: &Path, file_path: &str) -> Option<PathBuf> {
    if let Some(rest) = file_path.strip_prefix("hf://") {
        let (repo_id, filename, revision) = split_hf_path(rest).ok()?;
        Some(hf_cache_path(model_dir, repo_id, &filename, revision))
    } else if file_path.starts_with("https://") || file_path.starts_with("http://") {
        let digest = Sha256::digest(file_path.as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        let url_path = file_path.split(['?', '#']).next().unwrap_or(file_path);
        let url_path = url_path.splitn(4, '/').nth(3).unwrap_or("");
        let suffix = Path::new(url_path)
            .extension()
            .map(|ext| format!(".{}", ext.to_string_lossy()))
            .unwrap_or_default();
        Some(cache_root(model_dir).join("url").join(format!("{hex}{suffix}")))
    } else {
        None
    }
}

/// `owner/name/path/in/repo[@revision]` into its parts.
fn split_hf_path(path: &str) -> Result<(&str, String, Option<&str>)> {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 3 {
        bail!("`hf://{path}` should look like hf://<owner>/<repo>/<file>[@revision]")
    }
    let repo_end = parts[0].len() + 1 + parts[1].len();
    let repo_id = &path[..repo_end];
    let filename = &path[repo_end + 1..];
    match filename.split_once('@') {
        Some((filename, revision)) => Ok((repo_id, filename.to_string(), Some(revision))),
        None => Ok((repo_id, filename.to_string(), None)),
    }
}

fn hf_cache_path(model_dir: &Path, repo_id: &str, filename: &str, revision: Option<&str>) -> PathBuf {
    let mut path = cache_root(model_dir).join("hf");
    for part in repo_id.split('/') {
        path = path.join(sanitize(part));
    }
    // Keep the file's own subdirectories; revision pinned in the name so a
    // re-pointed embedding revision gets its own cache entry.
    let parts: Vec<String> = filename
        .split('/')
        .map(str::to_string)
        .filter(|p| !p.is_empty())
        .collect();
    let last = parts.len().saturating_sub(1);
    let mut name = String::new();
    for (i, part) in parts.iter().enumerate() {
        if i == last {
            if let Some(rev) = revision {
                let file = Path::new(part);
                let stem = file.with_extension("").to_string_lossy().to_string();
                let ext = file
                    .extension()
                    .map(|e| format!(".{}", e.to_string_lossy()))
                    .unwrap_or_default();
                name.push_str(&stem);
                name.push('@');
                name.push_str(&rev[..rev.len().min(12)]);
                name.push_str(&ext);
                break;
            }
        }
        if i > 0 {
            name.push('/');
        }
        name.push_str(part);
    }
    for part in name.split('/') {
        path = path.join(sanitize(part));
    }
    path
}

fn sanitize(part: &str) -> String {
    part.replace(['\\', ':', '*', '?', '"', '<', '>', '|'], "_")
}

fn download_hf(
    model_dir: &Path,
    repo_id: &str,
    filename: &str,
    revision: Option<&str>,
) -> Result<PathBuf> {
    let dest = hf_cache_path(model_dir, repo_id, filename, revision);
    if dest.exists() {
        return Ok(dest);
    }
    let rev = revision.unwrap_or("main");
    let url = format!(
        "https://huggingface.co/{repo_id}/resolve/{rev}/{}",
        filename.split('@').next().unwrap_or(filename)
    );
    download_to(url, &dest).with_context(|| format!("cannot download hf://{repo_id}/{filename}"))?;
    Ok(dest)
}

fn download_url(model_dir: &Path, url: &str) -> Result<PathBuf> {
    let cached = cached_path(model_dir, url)
        .with_context(|| format!("cannot determine cache path for {url}"))?;
    if cached.exists() {
        return Ok(cached);
    }
    download_to(url.to_string(), &cached)?;
    Ok(cached)
}

/// Statuses that will never succeed on retry — a gated or missing repo file
/// must fail fast so the voice-cloning weights fall back to the public ones
/// at load time instead of hanging through retry cycles.
fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

fn download_to(url: impl Into<String>, dest: &Path) -> Result<()> {
    let url = url.into();
    let max_retries = 3;
    let mut last_error = None;
    for attempt in 0..max_retries {
        match try_download(&url, dest) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let retryable = e
                    .downcast_ref::<StatusError>()
                    .is_none_or(|s| is_retryable_status(s.status));
                if !retryable {
                    return Err(e);
                }
                last_error = Some(e);
                if attempt < max_retries - 1 {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
            }
        }
    }
    Err(last_error.unwrap())
}

#[derive(Debug)]
struct StatusError {
    status: reqwest::StatusCode,
    url: String,
}

impl std::fmt::Display for StatusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "HTTP {} for {}", self.status, self.url)
    }
}

impl std::error::Error for StatusError {}

fn try_download(url: &str, dest: &Path) -> Result<()> {
    let response = reqwest::blocking::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .context("Failed to send HTTP request")?;

    if !response.status().is_success() {
        return Err(anyhow::Error::new(StatusError {
            status: response.status(),
            url: url.to_string(),
        }));
    }

    let bytes = response.bytes().context("Failed to read response body")?;

    // Write to temp file first, then rename (atomic), so a crashed download
    // never looks like a cached file.
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("cannot create {}", parent.display()))?;
    }
    let mut tmp = dest.as_os_str().to_owned();
    tmp.push(".partial");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, &bytes).context("Failed to write temp file")?;
    std::fs::rename(&tmp, dest).context("Failed to rename temp file into place")?;
    Ok(())
}

/// Plant a dummy cache file for a config reference (unit tests).
#[cfg(test)]
pub fn install_stub(model_dir: &Path, file_path: &str) -> PathBuf {
    let path = resolve_path(model_dir, file_path)
        .unwrap_or_else(|| panic!("{file_path} is not a cacheable reference"));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&path, b"stub").unwrap();
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hf_paths_split_like_upstream() {
        assert_eq!(
            split_hf_path("kyutai/pocket-tts/languages/english/model.safetensors@abc").unwrap(),
            (
                "kyutai/pocket-tts",
                "languages/english/model.safetensors".to_string(),
                Some("abc")
            )
        );
        assert_eq!(
            split_hf_path("user/repo/config.yaml").unwrap(),
            ("user/repo", "config.yaml".to_string(), None)
        );
        assert!(split_hf_path("user/repo").is_err());
    }

    #[test]
    fn hf_cache_paths_pin_the_revision() {
        let dir = Path::new("/model");
        let a = hf_cache_path(dir, "kyutai/pocket-tts", "languages/english/model.safetensors", Some("abcdef1234567890"));
        assert!(a.to_string_lossy().contains("model@abcdef123456.safetensors"));
        let b = hf_cache_path(dir, "kyutai/pocket-tts", "languages/english/model.safetensors", None);
        assert!(b.to_string_lossy().ends_with("model.safetensors"));
        assert_ne!(a, b);
    }

    #[test]
    fn retryable_statuses_are_classified() {
        assert!(!is_retryable_status(reqwest::StatusCode::UNAUTHORIZED));
        assert!(!is_retryable_status(reqwest::StatusCode::NOT_FOUND));
        assert!(is_retryable_status(reqwest::StatusCode::BAD_GATEWAY));
        assert!(is_retryable_status(reqwest::StatusCode::TOO_MANY_REQUESTS));
    }
}
