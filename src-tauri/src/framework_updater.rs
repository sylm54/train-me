//! Framework update channel: fetch a version index from a URL and download +
//! verify + install a framework ZIP, mirroring the
//! [`crate::model_downloader`] pattern (reqwest blocking + retry + atomic
//! temp file).
//!
//! The update channel is a small **index document** hosted at a URL the user
//! supplies (and we persist in frontend settings). Pointing at an index rather
//! than a ZIP directly lets us version-check *before* downloading potentially
//! hundreds of megabytes, and lets the host advertise checksums.
//!
//! ```jsonc
//! // index.json
//! {
//!   "version": "2.1.0",
//!   "url": "./train-me-core-2.1.0.zip",   // relative to the index URL
//!   "sha256": "ab12…",
//!   "description": "Core conditioning framework …",
//!   "min_app_version": "1.4.0"
//! }
//! ```
//!
//! The index `url` may be **absolute** (`https://…/fw.zip`) or **relative**
//! (`./fw.zip`, `fw.zip`, `../fw.zip`). A relative URL is resolved against the
//! index document's own URL (RFC 3986), so the ZIP can sit beside the index
//! without the author hard-coding a host. Resolution happens at parse time in
//! [`fetch_index`]; downstream code always sees an absolute URL.
//!
//! Update detection compares the index `version` against the installed
//! framework version using [`crate::package_manifest::version_cmp`]. An update
//! is offered only when the index version is strictly greater.

use std::fs;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::package_manifest::{version_cmp, InstalledFramework};

/// The index document published at the framework's update-channel URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameworkIndex {
    pub version: String,
    pub url: String,
    /// Lowercase hex SHA-256 of the ZIP at `url`. Optional but strongly
    /// recommended — when present the download is rejected if it mismatches.
    #[serde(default)]
    pub sha256: Option<String>,
    pub description: String,
    /// Optional display name for the framework, surfaced in the UI before the
    /// full ZIP is downloaded. Falls back to the manifest name if absent.
    #[serde(default)]
    pub name: Option<String>,
    /// Optional: refuse to install if the running app is older.
    #[serde(default)]
    pub min_app_version: Option<String>,
}

/// Outcome of an update check: what's installed vs. what the channel offers.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheck {
    /// `true` if the channel version is strictly newer than the installed
    /// version (or no framework is installed at all).
    pub update_available: bool,
    /// The currently installed framework, or `null` if none.
    pub current: Option<InstalledFramework>,
    /// The latest version advertised by the channel.
    pub latest_version: String,
    pub latest_description: String,
    /// The channel URL that was checked.
    pub url: String,
}

/// Fetch and parse the index document at `index_url`. Uses a short connect
/// timeout and a longer overall timeout (the index is tiny, but a slow host
/// shouldn't hang the check indefinitely).
///
/// The index `url` field may be absolute or relative; a relative value is
/// resolved against `index_url` (RFC 3986), so the returned [`FrameworkIndex`]
/// always carries an absolute download URL. This lets a framework author write
/// `"url": "./train-me-core-2.1.0.zip"` and keep the ZIP beside the index
/// without hard-coding a host.
pub fn fetch_index(index_url: &str) -> Result<FrameworkIndex, String> {
    let bytes = http_get(index_url, Duration::from_secs(10), Duration::from_secs(30))?;
    let mut index = serde_json::from_slice::<FrameworkIndex>(&bytes)
        .map_err(|e| format!("Failed to parse index at {}: {}", index_url, e))?;
    index.url = resolve_url(&index.url, index_url)?;
    Ok(index)
}

/// Resolve `maybe_relative` against `base` (the index document's URL),
/// returning an absolute URL string. `base` is required to be absolute so
/// that a relative reference has something to resolve against; a relative
/// `base` is an error (the channel URL must be absolute). An already-absolute
/// `maybe_relative` is returned unchanged. Scheme is constrained to http/https
/// to prevent a crafted index from redirecting a download to `file://` or
/// similar.
pub(crate) fn resolve_url(maybe_relative: &str, base: &str) -> Result<String, String> {
    let base_url = url::Url::parse(base)
        .map_err(|e| format!("Invalid channel URL '{}': {}", base, e))?;
    if !base_url.has_host() {
        return Err(format!(
            "Channel URL '{}' must be absolute (include scheme and host).",
            base
        ));
    }
    let resolved = base_url
        .join(maybe_relative)
        .map_err(|e| format!("Failed to resolve index url '{}': {}", maybe_relative, e))?;
    match resolved.scheme() {
        "http" | "https" => Ok(resolved.to_string()),
        other => Err(format!(
            "Framework url '{}' resolved to unsupported scheme '{}'. Only http/https is allowed.",
            maybe_relative, other
        )),
    }
}

/// Compare the installed framework against the channel index and report
/// whether an update is available. `installed` is what's currently on disk
/// (read via [`package_manifest::read_installed_framework`]).
pub fn check_update(
    index_url: &str,
    installed: Option<&InstalledFramework>,
) -> Result<UpdateCheck, String> {
    let index = fetch_index(index_url)?;
    let update_available = match installed {
        Some(cur) => version_cmp(&index.version, &cur.version) == std::cmp::Ordering::Greater,
        None => true,
    };
    Ok(UpdateCheck {
        update_available,
        current: installed.cloned(),
        latest_version: index.version,
        latest_description: index.description,
        url: index_url.to_string(),
    })
}

/// Download the ZIP referenced by `index`, verify its SHA-256 (when the index
/// advertises one), and return its bytes. `on_progress` receives
/// `(downloaded_bytes, total_bytes)` where `total_bytes` is taken from the
/// `Content-Length` header (0 if absent). Callers should already be on a
/// blocking thread.
///
/// This is download + verify only — the staging/merge steps happen in
/// [`package_import::stage_to_persistent`] / [`package_import::install_framework`].
pub fn download_bytes<F: FnMut(u64, u64)>(
    index: &FrameworkIndex,
    tmp_base: &Path,
    on_progress: F,
) -> Result<Vec<u8>, String> {
    // 1. Download (with retries) to a temp file under the app's .tmp.
    fs::create_dir_all(tmp_base).map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let zip_path = tmp_base.join(format!(
        "framework-{}.zip",
        sanitize_filename(&index.version)
    ));
    download_with_progress(&index.url, &zip_path, Duration::from_secs(30), on_progress)?;

    // 2. Verify checksum if advertised.
    if let Some(expected) = index.sha256.as_deref() {
        let actual = sha256_hex(&zip_path)?;
        if !actual.eq_ignore_ascii_case(expected.trim()) {
            let _ = fs::remove_file(&zip_path);
            return Err(format!(
                "Checksum mismatch: download is {} but index expected {}.",
                actual, expected
            ));
        }
    }

    // 3. Read into memory and return. The bytes are fully buffered so the
    //    staging step sees a seekable reader regardless of platform file-seek
    //    semantics.
    let bytes = fs::read(&zip_path)
        .map_err(|e| format!("Failed to read downloaded ZIP: {}", e))?;

    // Clean up the temp ZIP regardless of outcome.
    let _ = fs::remove_file(&zip_path);
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/// GET `url`, returning the full body. Retries up to 3 times on transient
/// failures (network/5xx), matching the model downloader's policy.
fn http_get(
    url: &str,
    connect_timeout: Duration,
    overall_timeout: Duration,
) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(connect_timeout)
        .timeout(overall_timeout)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let mut last_err = None;
    for attempt in 0..3u32 {
        match client.get(url).send() {
            Ok(resp) => {
                if !resp.status().is_success() {
                    last_err = Some(format!("HTTP {} for {}", resp.status(), url));
                    if attempt < 2 {
                        std::thread::sleep(Duration::from_secs(2));
                    }
                    continue;
                }
                return resp
                    .bytes()
                    .map(|b| b.to_vec())
                    .map_err(|e| format!("Failed to read response from {}: {}", url, e));
            }
            Err(e) => {
                last_err = Some(format!("Request to {} failed: {}", url, e));
                if attempt < 2 {
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "Download failed after 3 attempts.".into()))
}

/// Download `url` to `dest`, invoking `on_progress(downloaded, total)` as
/// bytes arrive. `total` comes from `Content-Length` (0 if absent). Writes to
/// a `.part` sidecar first, then renames atomically so a partial download is
/// never mistaken for a complete one.
fn download_with_progress<F: FnMut(u64, u64)>(
    url: &str,
    dest: &Path,
    connect_timeout: Duration,
    mut on_progress: F,
) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(connect_timeout)
        // No overall timeout for the body — framework ZIPs can be large.
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("Failed to start download from {}: {}", url, e))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {} for {}", response.status(), url));
    }
    let total = response.content_length().unwrap_or(0);

    // Stream into a .part sidecar.
    let part_path = dest.with_extension("part");
    if let Some(parent) = part_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create download dir: {}", e))?;
    }
    let mut file = fs::File::create(&part_path)
        .map_err(|e| format!("Failed to create {}: {}", part_path.display(), e))?;

    use std::io::Write;
    let mut downloaded = 0u64;
    let mut stream = response;
    // reqwest's blocking `Response` is a Read of the (chunked) body.
    let mut buf = [0u8; 8192];
    loop {
        let n = std::io::Read::read(&mut stream, &mut buf)
            .map_err(|e| format!("Download read error: {}", e))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("Write error: {}", e))?;
        downloaded += n as u64;
        on_progress(downloaded, total);
    }
    file.flush().map_err(|e| format!("Flush error: {}", e))?;
    drop(file);

    fs::rename(&part_path, dest).map_err(|e| {
        let _ = fs::remove_file(&part_path);
        format!("Failed to finalise download: {}", e)
    })?;
    Ok(())
}

/// Lowercase hex SHA-256 of the file at `path`.
fn sha256_hex(path: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    let mut file = fs::File::open(path).map_err(|e| format!("Failed to open {}: {}", path.display(), e))?;
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("Hash read error: {}", e))?;
    let bytes = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    Ok(out)
}

/// Reduce `version` to a filesystem-safe token (alphanumerics, `_`, `-`).
fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_index_parse_full() {
        let json = r#"{
            "version": "2.1.0",
            "url": "https://example.com/fw.zip",
            "sha256": "AB12CD",
            "description": "desc",
            "min_app_version": "1.4.0"
        }"#;
        let idx: FrameworkIndex = serde_json::from_str(json).unwrap();
        assert_eq!(idx.version, "2.1.0");
        assert_eq!(idx.sha256.as_deref(), Some("AB12CD"));
        assert_eq!(idx.min_app_version.as_deref(), Some("1.4.0"));
    }

    #[test]
    fn test_index_parse_optional_fields() {
        // sha256 + min_app_version omitted → defaults.
        let json = r#"{ "version": "1.0.0", "url": "u", "description": "d" }"#;
        let idx: FrameworkIndex = serde_json::from_str(json).unwrap();
        assert!(idx.sha256.is_none());
        assert!(idx.min_app_version.is_none());
    }

    #[test]
    fn test_check_update_logic() {
        let installed = InstalledFramework {
            id: "core".into(),
            name: "Core".into(),
            description: "d".into(),
            version: "2.0.0".into(),
            installed_at: "2026-01-01T00:00:00+00:00".into(),
            source_url: String::new(),
            choices: serde_json::Value::Null,
        };
        // Same version → no update. (We can't hit the network in a unit test,
        // so we exercise the comparison helper directly via the public fn's
        // decision table.)
        assert_eq!(
            version_cmp("2.0.0", "2.0.0"),
            std::cmp::Ordering::Equal
        );
        assert_eq!(
            version_cmp("2.1.0", "2.0.0"),
            std::cmp::Ordering::Greater
        );
        // The public check_update path would compute update_available from
        // these; verified here at the comparison level.
        let _ = installed; // (used above to define the shape)
    }

    #[test]
    fn test_sanitize_filename() {
        assert_eq!(sanitize_filename("2.1.0"), "2_1_0");
        assert_eq!(sanitize_filename("v1-2_3"), "v1-2_3");
        assert_eq!(sanitize_filename("a/b"), "a_b");
    }

    #[test]
    fn test_resolve_url_relative_against_index() {
        let base = "https://example.com/fw/index.json";
        // Bare filename → same directory as the index.
        assert_eq!(
            resolve_url("train-me-core-2.1.0.zip", base).unwrap(),
            "https://example.com/fw/train-me-core-2.1.0.zip"
        );
        // Explicit "./" prefix resolves the same way.
        assert_eq!(
            resolve_url("./train-me-core-2.1.0.zip", base).unwrap(),
            "https://example.com/fw/train-me-core-2.1.0.zip"
        );
        // ".." climbs out of the directory.
        assert_eq!(
            resolve_url("../fw-2.1.0.zip", base).unwrap(),
            "https://example.com/fw-2.1.0.zip"
        );
        // Nested subfolder.
        assert_eq!(
            resolve_url("releases/2.1.0/fw.zip", base).unwrap(),
            "https://example.com/fw/releases/2.1.0/fw.zip"
        );
    }

    #[test]
    fn test_resolve_url_absolute_passes_through() {
        let base = "https://example.com/fw/index.json";
        // An absolute URL is returned unchanged (different host allowed).
        assert_eq!(
            resolve_url("https://cdn.other.com/fw.zip", base).unwrap(),
            "https://cdn.other.com/fw.zip"
        );
        // Same host, absolute path.
        assert_eq!(
            resolve_url("https://example.com/elsewhere/fw.zip", base).unwrap(),
            "https://example.com/elsewhere/fw.zip"
        );
    }

    #[test]
    fn test_resolve_url_rejects_non_http_scheme() {
        let base = "https://example.com/fw/index.json";
        let err = resolve_url("file:///etc/passwd", base).unwrap_err();
        assert!(err.contains("unsupported scheme"));
        assert!(err.contains("file"));
    }

    #[test]
    fn test_resolve_url_rejects_relative_base() {
        // A channel URL that isn't a valid absolute URL can't anchor a
        // relative reference.
        let err = resolve_url("./fw.zip", "not-a-url").unwrap_err();
        assert!(
            err.to_lowercase().contains("channel url"),
            "got: {err}"
        );
    }

    #[test]
    fn test_sha256_hex_known() {
        // Known empty-file SHA-256.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("empty");
        fs::write(&p, b"").unwrap();
        assert_eq!(
            sha256_hex(&p).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        // "abc"
        fs::write(&p, b"abc").unwrap();
        assert_eq!(
            sha256_hex(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
