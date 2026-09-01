//! Visual slideshow sources for the `<visual>` TTS tag.
//!
//! `<visual>` layers a gif/image slideshow over its audio content at
//! playback. The actual media comes from a pluggable **visual source**: this
//! module holds the [`VisualConfig`] carried in the manifest, the source
//! registry ([`source_by_id`]), and the first source implementation
//! ([`RedgifsSource`], modeled after the `redgifs` Python library's HTTP
//! layer: anonymous temporary token → `/v2/links/search` → media download).
//!
//! Resolution happens at PLAYBACK, not render time: the renderer only bakes
//! the config into the manifest, and the player calls the `visual_fetch`
//! command to resolve a fresh playlist. That keeps rendered manifests
//! network-free and gives per-playback variety (same philosophy as
//! `<random>`/glob includes). Downloaded media is cached on disk under
//! `<data_dir>/visuals/` (content-addressed by gif id), served to the
//! WebView by the audio server's `/visuals` mount.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Source used when `<visual>` declares no `source` attribute.
pub const DEFAULT_SOURCE: &str = "redgifs";

/// Default slide interval in seconds (a fresh value is drawn per slide).
pub const DEFAULT_EVERY_MIN: f32 = 5.0;
pub const DEFAULT_EVERY_MAX: f32 = 9.0;

/// Default playlist size (how many distinct slides one fetch resolves).
pub const DEFAULT_COUNT: u32 = 16;

/// Playback config for a `<visual>` tag, carried verbatim in the manifest
/// and passed to `visual_fetch` at playback. Mirrors the tag's attributes;
/// see `tts-tags.md` for the author-facing reference.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VisualConfig {
    /// Visual source plugin id (see [`KNOWN_SOURCES`]).
    pub source: String,
    /// Tags/niches the source should match (the `tags` attribute).
    #[serde(default)]
    pub tags: Vec<String>,
    /// Tags that disqualify a result (the `block` attribute).
    #[serde(default)]
    pub block: Vec<String>,
    /// Free-text search hint for the source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// Ordering hint passed through to the source (e.g. `recent`/`trending`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<String>,
    /// Slide interval bounds in seconds; the player draws uniformly in
    /// `[every_min, every_max]` per slide. `bpm` folds into this at parse
    /// time (`60/bpm`).
    pub every_min: f32,
    pub every_max: f32,
    /// How many distinct slides one fetch resolves (1–40).
    pub count: u32,
    /// Caption mode: `off` (default) or `meta` (show each slide's own
    /// caption from the source). Authored `<caption>` lines always apply
    /// unless this is `off`.
    pub captions: String,
    /// Visual effect presets (the comma-separated `effect` attribute).
    #[serde(default)]
    pub effects: Vec<String>,
    /// Authored `<caption>` lines, shown shuffled per playback.
    #[serde(default)]
    pub lines: Vec<String>,
}

/// Registered visual source ids. A `<visual source="…">` naming anything
/// else is a validation error.
pub const KNOWN_SOURCES: &[&str] = &["redgifs"];

/// Valid `effect` presets. `cut` disables the default crossfade; the rest
/// are CSS-side (filters, motion, overlays) — see `VisualStage.tsx`.
pub const KNOWN_EFFECTS: &[&str] = &[
    "cut",
    "zoom",
    "pulse",
    "flash",
    "shake",
    "grayscale",
    "sepia",
    "contrast",
    "blur",
    "vignette",
    "scanlines",
];

/// Valid `captions` modes.
pub const KNOWN_CAPTION_MODES: &[&str] = &["off", "meta"];

impl VisualConfig {
    /// Validate the semantic constraints the parser guarantees structurally
    /// but not numerically. Appends human-readable errors (mirrors the
    /// style of `tag_parser::validate`).
    pub fn validate_into(&self, errors: &mut Vec<String>) {
        if !KNOWN_SOURCES.contains(&self.source.as_str()) {
            errors.push(format!(
                "Unknown source '{}' in <visual source=\"{}\">. Valid sources: {}",
                self.source,
                self.source,
                KNOWN_SOURCES.join(", ")
            ));
        }
        if !(self.every_min > 0.0) || self.every_max < self.every_min {
            errors.push(format!(
                "<visual> every/bpm must be > 0 with min ≤ max (got {}..{})",
                self.every_min, self.every_max
            ));
        }
        if self.count < 1 || self.count > 40 {
            errors.push(format!(
                "<visual> count must be between 1 and 40 (got {})",
                self.count
            ));
        }
        if !KNOWN_CAPTION_MODES.contains(&self.captions.as_str()) {
            errors.push(format!(
                "Unknown captions mode '{}' in <visual captions=\"{}\">. Valid modes: {}",
                self.captions,
                self.captions,
                KNOWN_CAPTION_MODES.join(", ")
            ));
        }
        for e in &self.effects {
            if !KNOWN_EFFECTS.contains(&e.as_str()) {
                errors.push(format!(
                    "Unknown effect '{}' in <visual effect=\"{}\">. Valid effects: {}",
                    e,
                    e,
                    KNOWN_EFFECTS.join(", ")
                ));
            }
        }
    }
}

/// Parse the `every` attribute: `every="6"` (fixed) or `every="4..8"`
/// (uniform random per slide). Returns `(min, max)` seconds.
pub fn parse_every(raw: &str) -> Result<(f32, f32)> {
    let raw = raw.trim();
    if let Some((lo, hi)) = raw.split_once("..") {
        let lo: f32 = lo
            .trim()
            .parse()
            .map_err(|_| anyhow!("'{lo}' is not a number"))?;
        let hi: f32 = hi
            .trim()
            .parse()
            .map_err(|_| anyhow!("'{hi}' is not a number"))?;
        if !(lo > 0.0) || hi < lo {
            bail!("range must be positive with min ≤ max (got {lo}..{hi})");
        }
        Ok((lo, hi))
    } else {
        let v: f32 = raw
            .parse()
            .map_err(|_| anyhow!("'{raw}' is not a number or a min..max range"))?;
        if !(v > 0.0) {
            bail!("must be > 0 (got {v})");
        }
        Ok((v, v))
    }
}

/// Parse a comma-separated attribute (`tags`, `block`, `effect`) into a
/// trimmed, lowercased, de-duplicated list. Empty items are dropped.
pub fn parse_attr_list(raw: Option<&String>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(raw) = raw {
        for item in raw.split(',') {
            let item = item.trim().to_lowercase();
            if !item.is_empty() && !out.contains(&item) {
                out.push(item);
            }
        }
    }
    out
}

// ============================================================================
// Source registry
// ============================================================================

/// One downloadable slide resolved by a source. `file` is a local path under
/// the visual cache dir; the command layer turns it into a servable URL.
pub struct SlideAsset {
    pub file: PathBuf,
    pub kind: SlideKind,
    pub caption: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlideKind {
    Video,
    Image,
}

/// A pluggable provider of slideshow media. Sources are stateless: given a
/// config + the on-disk cache dir, they resolve a playlist of slides
/// (downloading whatever is missing). Implementations should be careful to
/// stay resilient — a source that yields fewer slides than requested is
/// fine; zero slides is an error.
pub trait VisualSource: Sync + Send {
    fn id(&self) -> &'static str;
    fn fetch(&self, cfg: &VisualConfig, cache_dir: &Path) -> Result<Vec<SlideAsset>>;
}

/// Look up a source by its `<visual source>` id.
pub fn source_by_id(id: &str) -> Option<&'static dyn VisualSource> {
    const SOURCES: &[&dyn VisualSource] = &[&RedgifsSource];
    SOURCES.iter().copied().find(|s| s.id() == id)
}

/// Resolve a config against its source and convert the result into
/// frontend-ready slides (absolute URLs on the audio server's `/visuals`
/// mount). The playlist order is shuffled here so every playback differs.
pub fn fetch_playlist(
    cfg: &VisualConfig,
    cache_dir: &Path,
    base_url: &str,
) -> Result<Vec<VisualSlide>> {
    let source = source_by_id(&cfg.source)
        .ok_or_else(|| anyhow!("unknown visual source '{}'", cfg.source))?;
    std::fs::create_dir_all(cache_dir)
        .with_context(|| format!("creating visual cache dir {}", cache_dir.display()))?;
    let mut assets = source.fetch(cfg, cache_dir)?;
    if assets.is_empty() {
        bail!(
            "visual source '{}' returned no results (tags: {:?}, query: {:?})",
            cfg.source,
            cfg.tags,
            cfg.query
        );
    }
    shuffle(&mut assets);
    Ok(assets
        .into_iter()
        .map(|a| VisualSlide {
            url: slide_url(base_url, &a.file),
            kind: a.kind,
            caption: a.caption,
        })
        .collect())
}

fn shuffle<T>(slice: &mut [T]) {
    use rand::seq::SliceRandom;
    let mut rng = rand::thread_rng();
    slice.shuffle(&mut rng);
}

/// Build a URL on the audio server for a cached slide. Mirrors the
/// frontend's `audioUrlForPath` convention: the base ends with `?t=<token>`,
/// so the path is inserted BEFORE the query.
fn slide_url(base_url: &str, file: &Path) -> String {
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    match base_url.split_once('?') {
        Some((before, query)) => format!("{before}/visuals/{name}?{query}"),
        None => format!("{base_url}/visuals/{name}"),
    }
}

/// One playlist entry handed to the player.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisualSlide {
    /// Absolute URL on the audio server's `/visuals` mount.
    pub url: String,
    pub kind: SlideKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
}

// ============================================================================
// RedGIFs source (modeled after the `redgifs` Python library's http.py)
// ============================================================================

const REDGIFS_API: &str = "https://api.redgifs.com";
const REDGIFS_REFERER: &str = "https://www.redgifs.com/";
/// Desktop-browser-ish UA: the API and CDN are stricter with unknown agents.
const REDGIFS_UA: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
/// How long to reuse the anonymous temporary token before re-fetching.
/// RedGIFs temporary tokens are valid ~24h; refresh well before that.
const TOKEN_TTL: Duration = Duration::from_secs(60 * 60);

/// Cache of the anonymous temporary auth token (`/v2/auth/temporary`),
/// shared across fetches so a slideshow's paging doesn't re-auth per call.
static TEMP_TOKEN: Mutex<Option<(String, Instant)>> = Mutex::new(None);

struct RedgifsSource;

/// The subset of `/v2/links/search`'s gif object the source consumes. Kept
/// loose (`Value` for the rest) so API additions don't break parsing.
#[derive(Debug, Deserialize)]
struct GifStub {
    id: String,
    #[serde(default)]
    caption: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    urls: GifUrls,
}

#[derive(Debug, Deserialize, Default)]
struct GifUrls {
    #[serde(default)]
    hd: Option<String>,
    #[serde(default)]
    sd: Option<String>,
    #[serde(default)]
    poster: Option<String>,
}

impl VisualSource for RedgifsSource {
    fn id(&self) -> &'static str {
        "redgifs"
    }

    /// Search RedGIFs for `cfg.count` slides matching the config's tags /
    /// query, download each into `cache_dir` (`<gif-id>.<ext>`, reused when
    /// already cached), and drop results carrying a blocked tag.
    fn fetch(&self, cfg: &VisualConfig, cache_dir: &Path) -> Result<Vec<SlideAsset>> {
        let http = reqwest::blocking::Client::builder()
            .user_agent(REDGIFS_UA)
            .timeout(Duration::from_secs(30))
            .build()
            .context("building HTTP client")?;

        let token = temp_token(&http)?;

        // Ask for headroom over the requested count: blocked-tag filtering
        // and download failures both shrink the result set.
        let want = cfg.count.clamp(1, 40);
        let page_size = (want * 2).clamp(8, 80);

        let mut url = format!("{REDGIFS_API}/v2/links/search");
        let mut params: Vec<(String, String)> = vec![("count".into(), page_size.to_string())];
        if !cfg.tags.is_empty() {
            params.push(("tags".into(), cfg.tags.join(",")));
        }
        if let Some(q) = cfg.query.as_deref().filter(|q| !q.trim().is_empty()) {
            params.push(("search_text".into(), q.to_string()));
        }
        if let Some(o) = cfg.order.as_deref().filter(|o| !o.trim().is_empty()) {
            params.push(("order".into(), o.to_string()));
        }
        let query = params
            .iter()
            .map(|(k, v)| format!("{k}={}", urlencode(v)))
            .collect::<Vec<_>>()
            .join("&");
        if !query.is_empty() {
            url.push('?');
            url.push_str(&query);
        }

        let resp = http
            .get(&url)
            .bearer_auth(&token)
            .header("Referer", REDGIFS_REFERER)
            .send()
            .context("search request failed")?;
        if !resp.status().is_success() {
            bail!("redgifs search returned {}", resp.status());
        }
        let body: serde_json::Value = resp.json().context("decoding search response")?;
        let gifs: Vec<GifStub> = body
            .get("gifs")
            .and_then(|g| g.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|g| serde_json::from_value::<GifStub>(g.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();

        let block: Vec<String> = cfg.block.iter().cloned().collect();
        let mut slides = Vec::new();
        for gif in gifs {
            if slides.len() >= want as usize {
                break;
            }
            let blocked = gif
                .tags
                .iter()
                .any(|t| block.contains(&t.to_lowercase().replace(' ', "_")));
            if blocked {
                continue;
            }
            match download_slide(&http, &token, &gif, cache_dir) {
                Ok(Some(slide)) => slides.push(slide),
                // Skipped (unsupported/failed download) — keep going.
                Ok(None) => {}
                Err(e) => log::warn!("redgifs slide {} skipped: {e:#}", gif.id),
            }
        }
        Ok(slides)
    }
}

/// Pick the best URL for a gif (hd → sd → poster), derive its kind from the
/// extension, download it into the cache (reusing an existing file), and
/// return the slide. `Ok(None)` means "no usable media, skip".
fn download_slide(
    http: &reqwest::blocking::Client,
    token: &str,
    gif: &GifStub,
    cache_dir: &Path,
) -> Result<Option<SlideAsset>> {
    let (url, kind) = media_url(gif)?;
    let ext = Path::new(url.path())
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .filter(|e| !e.is_empty() && e.len() <= 5)
        .unwrap_or_else(|| match kind {
            SlideKind::Video => "mp4".into(),
            SlideKind::Image => "jpg".into(),
        });
    let id: String = gif
        .id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let path = cache_dir.join(format!("{id}.{ext}"));

    if !path.exists()
        || std::fs::metadata(&path)
            .map(|m| m.len() == 0)
            .unwrap_or(true)
    {
        let resp = http
            .get(url.as_str())
            .bearer_auth(token)
            .header("Referer", REDGIFS_REFERER)
            .timeout(Duration::from_secs(120))
            .send()
            .with_context(|| format!("downloading {}", url.as_str()))?;
        if !resp.status().is_success() {
            bail!("media returned {}", resp.status());
        }
        let bytes = resp.bytes().context("reading media bytes")?;
        if bytes.is_empty() {
            bail!("empty media body");
        }
        // Write via temp + rename so a crashed download never leaves a
        // truncated file that future playbacks would treat as cached.
        let tmp = cache_dir.join(format!(".{id}.{ext}.part"));
        std::fs::write(&tmp, &bytes).with_context(|| format!("writing {}", tmp.display()))?;
        std::fs::rename(&tmp, &path).with_context(|| format!("finalizing {}", path.display()))?;
    }

    Ok(Some(SlideAsset {
        file: path,
        kind,
        caption: gif.caption.clone().filter(|c| !c.trim().is_empty()),
    }))
}

/// Choose the media URL for a gif: prefer the mp4 (hd, then sd), falling
/// back to the poster image. Returns `(url, kind)`.
fn media_url(gif: &GifStub) -> Result<(reqwest::Url, SlideKind)> {
    for (raw, kind) in [
        (gif.urls.hd.as_deref(), SlideKind::Video),
        (gif.urls.sd.as_deref(), SlideKind::Video),
        (gif.urls.poster.as_deref(), SlideKind::Image),
    ] {
        let Some(raw) = raw else { continue };
        if let Ok(u) = reqwest::Url::parse(raw) {
            return Ok((u, kind));
        }
    }
    bail!("no usable media url")
}

/// GET `/v2/auth/temporary` and return a fresh token, or the cached one if
/// it is younger than [`TOKEN_TTL`]. Modeled after the Python library's
/// `get_temporary_token()`.
fn temp_token(http: &reqwest::blocking::Client) -> Result<String> {
    if let Some((token, at)) = TEMP_TOKEN.lock().unwrap().clone() {
        if at.elapsed() < TOKEN_TTL {
            return Ok(token);
        }
    }
    let resp = http
        .get(format!("{REDGIFS_API}/v2/auth/temporary"))
        .header("Referer", REDGIFS_REFERER)
        .send()
        .context("token request failed")?;
    if !resp.status().is_success() {
        bail!("redgifs auth returned {}", resp.status());
    }
    let body: serde_json::Value = resp.json().context("decoding token response")?;
    let token = body
        .get("token")
        .and_then(|t| t.as_str())
        .ok_or_else(|| anyhow!("token response missing 'token' field"))?
        .to_string();
    *TEMP_TOKEN.lock().unwrap() = Some((token.clone(), Instant::now()));
    Ok(token)
}

/// Minimal percent-encoding for search query values (spaces, `&`, `#`, …).
fn urlencode(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for b in v.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> VisualConfig {
        VisualConfig {
            source: "redgifs".into(),
            tags: vec!["test".into()],
            block: vec![],
            query: None,
            order: None,
            every_min: 5.0,
            every_max: 9.0,
            count: 10,
            captions: "off".into(),
            effects: vec![],
            lines: vec![],
        }
    }

    #[test]
    fn test_parse_every_fixed() {
        assert_eq!(parse_every("6").unwrap(), (6.0, 6.0));
        assert_eq!(parse_every("4..8").unwrap(), (4.0, 8.0));
        assert!(parse_every("0").is_err());
        assert!(parse_every("-1").is_err());
        assert!(parse_every("8..4").is_err());
        assert!(parse_every("abc").is_err());
        assert!(parse_every("4..x").is_err());
    }

    #[test]
    fn test_parse_attr_list() {
        let raw = " Hypno , Joi,,joi ".to_string();
        assert_eq!(parse_attr_list(Some(&raw)), vec!["hypno", "joi"]);
        assert!(parse_attr_list(None).is_empty());
    }

    #[test]
    fn test_config_validate() {
        let mut c = cfg();
        let mut errors = Vec::new();
        c.validate_into(&mut errors);
        assert!(errors.is_empty(), "{errors:?}");

        c.source = "nope".into();
        c.count = 0;
        c.captions = "always".into();
        c.effects = vec!["laser".into()];
        c.every_min = 3.0;
        c.every_max = 2.0;
        let mut errors = Vec::new();
        c.validate_into(&mut errors);
        assert_eq!(errors.len(), 5, "{errors:?}");
    }

    #[test]
    fn test_slide_url_keeps_token_query() {
        let url = slide_url(
            "http://127.0.0.1:1234?t=abc",
            Path::new("/data/visuals/x1.mp4"),
        );
        assert_eq!(url, "http://127.0.0.1:1234/visuals/x1.mp4?t=abc");
    }

    #[test]
    fn test_media_url_prefers_hd_then_sd_then_poster() {
        let g = GifStub {
            id: "a".into(),
            caption: None,
            tags: vec![],
            urls: GifUrls {
                hd: Some("https://media.redgifs.com/a.mp4".into()),
                sd: None,
                poster: Some("https://media.redgifs.com/a.jpg".into()),
            },
        };
        let (u, k) = media_url(&g).unwrap();
        assert_eq!(u.as_str(), "https://media.redgifs.com/a.mp4");
        assert_eq!(k, SlideKind::Video);

        let g2 = GifStub {
            urls: GifUrls {
                hd: None,
                sd: None,
                poster: Some("https://media.redgifs.com/a.jpg".into()),
            },
            ..g
        };
        let (u, k) = media_url(&g2).unwrap();
        assert_eq!(k, SlideKind::Image);
        assert!(u.path().ends_with(".jpg"));
    }
}
