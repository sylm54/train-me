//! Visual slideshow sources for the `<visual>` TTS tag.
//!
//! `<visual>` layers a gif/image slideshow over its audio content at
//! playback. The actual media comes from a pluggable **visual source**: this
//! module holds the [`VisualConfig`] carried in the manifest, the source
//! registry ([`source_by_id`]), and the first source implementation
//! ([`RedgifsSource`], modeled after the `redgifs` Python library's HTTP
//! layer: anonymous temporary token → search → media download).
//!
//! NOTE on the RedGIFs API: the Python library targets `/v2/links/search`,
//! which the server has since retired (it 404s with `HttpNotFoundException`).
//! The live v2 API exposes `/v2/gifs/search` (params: `tags`, `niche_ids`,
//! `search_text`, `order` ∈ {top, top7, top28, latest, score, trending}),
//! `/v2/niches` (the subreddit-like communities, paginated ≤100) and
//! `/v2/tags/trending`. We implement against the live API and keep the
//! python-lib shape (temporary token, search → download) as the model.
//!
//! **Niches vs tags**: a *niche* is a curated RedGIFs community
//! (`/v2/niches`, e.g. `just-boobs`) — the coarse "subreddit" the agent picks
//! to steer content; a *tag* is free-form descriptive metadata matched
//! server-side — the fine-tuning. Niches the server doesn't know are silently
//! ignored in the query, so they are checked client-side against a cached
//! [`Discovery`] snapshot (see [`refresh_discovery`]); tags need no check.
//! The discovery snapshot is also written to
//! `agent_data/docs/redgifs-discovery.md` so the writing agent can browse
//! what exists.
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
    /// Niches the content should come from (the `niche` attribute) — the
    /// coarse, subreddit-like RedGIFs communities. Validated against the
    /// discovery snapshot at fetch time; unknown ids are dropped with a
    /// warning (the server ignores them silently).
    #[serde(default)]
    pub niches: Vec<String>,
    /// Descriptive tags the source should match (the `tags` attribute).
    /// Free-form — the server matches loosely, so no validation.
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

/// Valid `order` values for the RedGIFs search (the server 400s on anything
/// else — see `BadOrder`). Other sources may differ; validated only for
/// `redgifs`.
pub const KNOWN_ORDERS: &[&str] = &["top", "top7", "top28", "latest", "score", "trending"];

/// Canonical form of a free-form tag for include/block matching: RedGIFs tag
/// names are proper-cased with spaces (`Big Ass`), while authors write
/// `big-ass` or `big_ass` — fold everything to space-separated lowercase.
fn canonical_tag(s: &str) -> String {
    s.trim().to_lowercase().replace(['_', '-'], " ")
}

/// Canonical form of a niche reference: niche ids are lowercase hyphenated
/// (`just-boobs`); fold a display name (`Just Boobs`) onto the same form by
/// turning spaces into hyphens.
pub fn canonical_niche(s: &str) -> String {
    s.trim().to_lowercase().replace(' ', "-")
}

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
        if let Some(o) = &self.order {
            if !KNOWN_ORDERS.contains(&o.as_str()) {
                errors.push(format!(
                    "Unknown order '{}' in <visual order=\"{}\">. Valid orders: {}",
                    o,
                    o,
                    KNOWN_ORDERS.join(", ")
                ));
            }
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

/// Parse a comma-separated attribute (`tags`, `block`, `niche`, `effect`)
/// into a trimmed, lowercased, de-duplicated list. Empty items are dropped.
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
/// fine; zero slides is an error. `discovery` is the best-effort server
/// snapshot (may be `None` offline) for validating source-specific
/// vocabularies like niches.
pub trait VisualSource: Sync + Send {
    fn id(&self) -> &'static str;
    fn fetch(
        &self,
        cfg: &VisualConfig,
        cache_dir: &Path,
        discovery: Option<&Discovery>,
    ) -> Result<Vec<SlideAsset>>;
}

/// Look up a source by its `<visual source>` id.
pub fn source_by_id(id: &str) -> Option<&'static dyn VisualSource> {
    const SOURCES: &[&dyn VisualSource] = &[&RedgifsSource];
    SOURCES.iter().copied().find(|s| s.id() == id)
}

/// Resolve a config against its source and convert the result into
/// frontend-ready slides (absolute URLs on the audio server's `/visuals`
/// mount). The playlist order is shuffled here so every playback differs.
/// `cache_dir` is the media cache (`<data_dir>/visuals`); `agent_dir` is
/// where the discovery snapshot's agent-readable doc is written.
pub fn fetch_playlist(
    cfg: &VisualConfig,
    cache_dir: &Path,
    agent_dir: &Path,
    base_url: &str,
) -> Result<Vec<VisualSlide>> {
    let source = source_by_id(&cfg.source)
        .ok_or_else(|| anyhow!("unknown visual source '{}'", cfg.source))?;
    std::fs::create_dir_all(cache_dir)
        .with_context(|| format!("creating visual cache dir {}", cache_dir.display()))?;
    // Best-effort discovery refresh (cached for a day): drives niche
    // validation and keeps the agent's browsing doc current.
    let discovery = refresh_discovery(cache_dir, DISCOVERY_TTL);
    let mut assets = source.fetch(cfg, cache_dir, discovery.as_ref())?;
    if let Some(disc) = &discovery {
        let unknown = unknown_niches(cfg, Some(disc));
        if !unknown.is_empty() {
            log::warn!(
                "<visual> niches not known to source '{}': {} (see docs/redgifs-discovery.md)",
                cfg.source,
                unknown.join(", ")
            );
        }
    }
    write_agent_doc(agent_dir, discovery.as_ref());
    if assets.is_empty() {
        bail!(
            "visual source '{}' returned no results (niches: {:?}, tags: {:?}, query: {:?})",
            cfg.source,
            cfg.niches,
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

/// The subset of `/v2/gifs/search`'s gif object the source consumes. Kept
/// loose (serde defaults everywhere) so API additions don't break parsing.
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

    /// Search RedGIFs (`/v2/gifs/search`) for `cfg.count` slides matching
    /// the config's niches / tags / query, download each into `cache_dir`
    /// (`<gif-id>.<ext>`, reused when already cached), and drop results
    /// carrying a blocked tag.
    fn fetch(
        &self,
        cfg: &VisualConfig,
        cache_dir: &Path,
        discovery: Option<&Discovery>,
    ) -> Result<Vec<SlideAsset>> {
        let http = reqwest::blocking::Client::builder()
            .user_agent(REDGIFS_UA)
            .timeout(Duration::from_secs(30))
            .build()
            .context("building HTTP client")?;

        let token = temp_token(&http)?;

        // Niches are curated ids the server silently ignores when unknown —
        // filter them against the discovery snapshot so a typo narrows the
        // search loudly instead of returning unrelated content.
        let niches: Vec<String> = match discovery {
            Some(disc) if !cfg.niches.is_empty() => {
                let known: Vec<String> = disc.niches.iter().map(|n| n.id.clone()).collect();
                let kept: Vec<String> = cfg
                    .niches
                    .iter()
                    .filter(|n| known.contains(&canonical_niche(n)))
                    .cloned()
                    .collect();
                if kept.is_empty() {
                    bail!(
                        "none of the requested niches exist on redgifs: {:?} — browse docs/redgifs-discovery.md for valid ids",
                        cfg.niches
                    );
                }
                kept
            }
            _ => cfg.niches.clone(),
        };

        // Ask for headroom over the requested count: blocked-tag filtering
        // and download failures both shrink the result set.
        let want = cfg.count.clamp(1, 40);
        let page_size = (want * 2).clamp(8, 80);

        let mut url = format!("{REDGIFS_API}/v2/gifs/search");
        let mut params: Vec<(String, String)> = vec![("count".into(), page_size.to_string())];
        if !niches.is_empty() {
            params.push(("niche_ids".into(), niches.join(",")));
        }
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

        let block: Vec<String> = cfg.block.iter().map(|t| canonical_tag(t)).collect();
        let mut slides = Vec::new();
        for gif in gifs {
            if slides.len() >= want as usize {
                break;
            }
            let blocked = gif
                .tags
                .iter()
                .any(|t| block.contains(&canonical_tag(t)));
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

// ============================================================================
// Discovery: what niches / tags exist (cached snapshot + agent-facing doc)
// ============================================================================

/// How long a discovery snapshot is considered fresh.
pub const DISCOVERY_TTL: Duration = Duration::from_secs(60 * 60 * 24);

/// How many niches (top by subscriber count) the snapshot keeps — two
/// pages of the API's max-100 page size. Plenty for picking a vibe; the
/// tail is long-tail niche communities nobody needs by id.
const DISCOVERY_NICHE_PAGES: u32 = 2;
const DISCOVERY_NICHE_PAGE_SIZE: u32 = 100;

/// One curated RedGIFs community ("niche" — the subreddit-like bucket).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NicheInfo {
    /// Id to use verbatim in `<visual niche="…">`.
    pub id: String,
    pub name: String,
    /// Gif count, as a rough popularity signal.
    pub gifs: u64,
}

/// One trending tag.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagInfo {
    pub name: String,
    pub count: u64,
}

/// A cached snapshot of the source's vocabulary: which niches exist (so
/// `<visual niche>` typos can be flagged at validate/fetch time) and which
/// tags are currently trending. Refreshed lazily — whenever a `<visual>`
/// script is validated or its slideshow fetched — and mirrored into
/// `docs/redgifs-discovery.md` in the agent sandbox so the writing agent can
/// browse what exists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Discovery {
    /// Unix seconds of the fetch.
    pub fetched_at: u64,
    pub niches: Vec<NicheInfo>,
    pub trending_tags: Vec<TagInfo>,
}

/// Where the discovery snapshot is cached (`<data_dir>/visuals/`, next to
/// the media cache; it also gets served harmlessly under `/visuals`).
pub fn discovery_file(cache_dir: &Path) -> PathBuf {
    cache_dir.join("discovery.json")
}

/// Load the cached snapshot, if any (no network).
pub fn load_discovery(cache_dir: &Path) -> Option<Discovery> {
    let bytes = std::fs::read(discovery_file(cache_dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Config niches the snapshot doesn't know about (empty when everything is
/// fine or there's no snapshot to check against).
pub fn unknown_niches(cfg: &VisualConfig, disc: Option<&Discovery>) -> Vec<String> {
    let Some(disc) = disc else {
        return Vec::new();
    };
    let known: Vec<String> = disc.niches.iter().map(|n| canonical_niche(&n.id)).collect();
    cfg.niches
        .iter()
        .filter(|n| !known.contains(&canonical_niche(n)))
        .cloned()
        .collect()
}

/// Return a usable snapshot: the cached one when fresh, otherwise a fresh
/// fetch (falling back to a stale cache when offline). `None` when there is
/// no snapshot at all and the network fetch fails. Blocking — run it on a
/// worker thread.
pub fn refresh_discovery(cache_dir: &Path, max_age: Duration) -> Option<Discovery> {
    if let Some(existing) = load_discovery(cache_dir) {
        let age = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|now| now.as_secs().saturating_sub(existing.fetched_at))
            .unwrap_or(0);
        if Duration::from_secs(age) < max_age {
            return Some(existing);
        }
    }
    match fetch_discovery() {
        Some(disc) => {
            if let Ok(bytes) = serde_json::to_vec_pretty(&disc) {
                let _ = std::fs::create_dir_all(cache_dir);
                let _ = std::fs::write(discovery_file(cache_dir), &bytes);
            }
            Some(disc)
        }
        None => load_discovery(cache_dir),
    }
}

/// Fetch the live snapshot from RedGIFs: the top niches by subscribers
/// (paginated) plus the current trending tags. `None` on any failure —
/// discovery is always best-effort.
fn fetch_discovery() -> Option<Discovery> {
    let http = reqwest::blocking::Client::builder()
        .user_agent(REDGIFS_UA)
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?;
    let token = temp_token(&http).ok()?;

    let mut niches: Vec<NicheInfo> = Vec::new();
    for page in 1..=DISCOVERY_NICHE_PAGES {
        let url = format!(
            "{REDGIFS_API}/v2/niches?count={}&page={page}&order=subscribers",
            DISCOVERY_NICHE_PAGE_SIZE
        );
        let resp = http
            .get(&url)
            .bearer_auth(&token)
            .header("Referer", REDGIFS_REFERER)
            .send()
            .ok()?;
        if !resp.status().is_success() {
            log::warn!("redgifs niches page {page} returned {}", resp.status());
            break;
        }
        let body: serde_json::Value = resp.json().ok()?;
        let Some(arr) = body.get("niches").and_then(|n| n.as_array()) else {
            break;
        };
        for n in arr {
            let (Some(id), Some(name)) = (
                n.get("id").and_then(|v| v.as_str()),
                n.get("name").and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            niches.push(NicheInfo {
                id: id.to_string(),
                name: name.to_string(),
                gifs: n.get("gifs").and_then(|v| v.as_u64()).unwrap_or(0),
            });
        }
        let total = body.get("total").and_then(|v| v.as_u64()).unwrap_or(0);
        if (niches.len() as u64) >= total || arr.is_empty() {
            break;
        }
    }

    let trending_tags: Vec<TagInfo> = http
        .get(format!("{REDGIFS_API}/v2/tags/trending"))
        .bearer_auth(&token)
        .header("Referer", REDGIFS_REFERER)
        .send()
        .ok()
        .and_then(|r| r.json::<serde_json::Value>().ok())
        .and_then(|body| {
            let arr = body.get("tags")?.as_array()?.clone();
            Some(
                arr.iter()
                    .filter_map(|t| {
                        Some(TagInfo {
                            name: t.get("name")?.as_str()?.to_string(),
                            count: t.get("count").and_then(|v| v.as_u64()).unwrap_or(0),
                        })
                    })
                    .collect(),
            )
        })
        .unwrap_or_default();

    if niches.is_empty() {
        return None;
    }
    let fetched_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(Discovery {
        fetched_at,
        niches,
        trending_tags,
    })
}

/// Mirror the discovery snapshot into the agent sandbox as
/// `docs/redgifs-discovery.md` (surfaced to the agent by `{{docs}}`) so the
/// script-writing agent can browse valid niche ids and trending tags.
/// App-managed content in the agent's docs tree: always overwritten with the
/// latest snapshot; removed when discovery has never succeeded.
pub fn write_agent_doc(agent_dir: &Path, disc: Option<&Discovery>) {
    let path = agent_dir.join("docs").join("redgifs-discovery.md");
    let Some(disc) = disc else { return };
    let mut md = String::new();
    md.push_str("---\n");
    md.push_str("description: Live RedGIFs niches + trending tags for <visual> scripts (app-managed, refreshed automatically)\n");
    md.push_str("---\n\n");
    md.push_str("# RedGIFs discovery\n\n");
    md.push_str(
        "App-managed snapshot for `<visual>` sources — do not edit by hand; \
         it is refreshed automatically (on validation/playback of a visual script, \
         at most once a day). Use niche ids verbatim in `<visual niche=\"…\">`; \
         tags are free-form descriptions the server matches loosely, so prefer \
         ids/names from the lists below.\n\n",
    );
    md.push_str("## Niches (top by subscribers)\n\n");
    md.push_str("| niche id | name | gifs |\n|---|---|---|\n");
    for n in disc.niches.iter().take(200) {
        md.push_str(&format!("| `{}` | {} | {} |\n", n.id, n.name, n.gifs));
    }
    if !disc.trending_tags.is_empty() {
        md.push_str("\n## Trending tags\n\n");
        for t in &disc.trending_tags {
            md.push_str(&format!("- `{}` ({})\n", t.name, t.count));
        }
    }
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(agent_dir));
    let _ = std::fs::write(&path, md);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> VisualConfig {
        VisualConfig {
            source: "redgifs".into(),
            niches: vec![],
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
    fn test_canonical_tag_and_niche() {
        // Tags: proper-cased-with-spaces server-side; authors write any form.
        assert_eq!(canonical_tag("Big Ass"), "big ass");
        assert_eq!(canonical_tag("big_ass"), "big ass");
        assert_eq!(canonical_tag("big-ass"), "big ass");
        // Niches: hyphenated ids; display names fold onto the same form.
        assert_eq!(canonical_niche("Just Boobs"), "just-boobs");
        assert_eq!(canonical_niche("just-boobs"), "just-boobs");
    }

    #[test]
    fn test_unknown_niches() {
        let disc = Discovery {
            fetched_at: 0,
            niches: vec![NicheInfo {
                id: "just-boobs".into(),
                name: "Just Boobs".into(),
                gifs: 869_026,
            }],
            trending_tags: vec![],
        };
        let mut c = cfg();
        c.niches = vec!["just-boobs".into(), "made-up".into()];
        assert_eq!(unknown_niches(&c, Some(&disc)), vec!["made-up"]);
        c.niches = vec!["Just Boobs".into()];
        assert!(unknown_niches(&c, Some(&disc)).is_empty());
        // No snapshot → no opinion.
        assert!(unknown_niches(&c, None).is_empty());
    }

    #[test]
    fn test_order_validation() {
        let mut c = cfg();
        let mut errors = Vec::new();
        c.order = Some("trending".into());
        c.validate_into(&mut errors);
        assert!(errors.is_empty(), "{errors:?}");
        c.order = Some("recent".into());
        let mut errors = Vec::new();
        c.validate_into(&mut errors);
        assert!(errors.iter().any(|e| e.contains("Unknown order")), "{errors:?}");
    }

    #[test]
    fn test_agent_doc_render() {
        let disc = Discovery {
            fetched_at: 0,
            niches: vec![NicheInfo {
                id: "just-boobs".into(),
                name: "Just Boobs".into(),
                gifs: 869_026,
            }],
            trending_tags: vec![TagInfo {
                name: "gooning".into(),
                count: 12_345,
            }],
        };
        let dir = tempfile::tempdir().unwrap();
        write_agent_doc(dir.path(), Some(&disc));
        let md = std::fs::read_to_string(dir.path().join("docs/redgifs-discovery.md")).unwrap();
        assert!(md.contains("description:"), "needs {{docs}} frontmatter");
        assert!(md.contains("`just-boobs`"));
        assert!(md.contains("gooning"));
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
