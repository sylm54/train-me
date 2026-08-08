use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

mod activity_db;
mod audio_renderer;
mod audio_server;
mod bash;
mod chastity;
mod expression;
mod helper;
mod inventory;
mod manifest;
mod model_downloader;
mod package_import;
mod package_manifest;
mod framework_updater;
mod render_notify;
mod sounds;
mod tag_parser;
mod validators;

// ============================================================================
// Application State
// ============================================================================

/// Managed state shared across all Tauri commands.
///
/// `data_dir`      = the app's full data directory
/// `agent_dir`     = `<app_data>/agent_data` — the agent's writable scratch
///                    space, also the bash sandbox root. The activity DB
///                    (`activity.db`) lives here so the agent can query
///                    it directly via the embedded `sqlite` builtin.
/// `state_dir`     = `<app_data>/state` — app-managed state (chastity)
///                    that the agent must not touch
/// `model_dir`     = `<app_data>/model`
/// `tracks_dir`    = `<app_data>/tracks`
/// `bash`          = bashkit sandbox mounted over `agent_dir`
/// `audio_base_url` = base URL of the in-process audio server
///                    (`http://127.0.0.1:<port>?t=<token>`), used by the
///                    frontend to stream rendered WAVs reliably on Android.
pub struct AppState {
    pub data_dir: PathBuf,
    pub agent_dir: PathBuf,
    pub state_dir: PathBuf,
    pub model_dir: PathBuf,
    pub tracks_dir: PathBuf,
    pub audio_base_url: String,
    pub renderer: Arc<Mutex<Option<audio_renderer::AudioRenderer>>>,
    pub bash: Arc<bash::BashSandbox>,
}

// ============================================================================
// Serde types for the frontend
// ============================================================================

#[derive(Serialize, Deserialize, Clone)]
pub struct TrackInfo {
    pub name: String,
    pub filename: String,
    pub path: String,
    pub duration: f32,
    pub created: String,
    pub size_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SynthesizeRequest {
    pub text: String,
    pub name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ModelStatus {
    pub downloaded: bool,
    pub loaded: bool,
    pub missing_files: Vec<String>,
    pub speakers: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Result of rendering (or reusing) a script manifest.
/// Returned by `render_manifest` and `list_manifests`.
#[derive(Serialize, Deserialize, Clone)]
pub struct RenderedManifest {
    /// Sanitised script path (the on-disk manifest dir name under `tracks/`).
    pub id: String,
    /// Absolute path to `manifest.json`.
    pub manifest_path: String,
    /// Script path relative to `agent_dir` (forward-slash normalised).
    pub script: String,
    /// Best-effort nominal duration in seconds.
    pub duration: f32,
    /// RFC 3339 creation timestamp (manifest.json mtime).
    pub created: String,
}

/// Status of a script's manifest, returned by `manifest_status`.
#[derive(Serialize, Deserialize, Clone)]
pub struct ManifestStatus {
    pub rendered: bool,
    pub stale: bool,
    pub duration: Option<f32>,
    pub created: Option<String>,
    pub manifest_path: Option<String>,
}

/// Result of `export_scripts_zip`: how many files were archived and the total
/// uncompressed byte count. `note` carries non-fatal warnings (e.g. a
/// conditioning JSON that failed to parse, or a referenced script missing).
#[derive(Serialize, Clone, Debug)]
pub struct ExportResult {
    /// Number of files written into the archive.
    pub files: usize,
    /// Total uncompressed bytes across all archived files.
    pub bytes: u64,
    /// Non-fatal warnings, one per line (e.g. missing/malformed inputs).
    pub note: Option<String>,
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Check whether the model has been downloaded and is loaded.
///
/// This is a synchronous command (runs on the main thread) and is called on
/// every ConditioningView mount. A render in flight holds `renderer`'s mutex
/// for its entire duration (see `render_manifest`), so a blocking `.lock()`
/// here would freeze the UI until the render finishes — exactly the
/// "stuck on refreshing" hang when navigating away and back mid-render. We
/// use `try_lock` instead: if the renderer is busy we still report `loaded:
/// true` (it IS loaded, just busy), which is the correct answer for the UI.
#[tauri::command]
fn get_model_status(state: State<'_, AppState>) -> Result<ModelStatus, String> {
    let downloaded = model_downloader::is_model_downloaded(&state.model_dir);
    let loaded = state.renderer.try_lock().map(|g| g.is_some()).unwrap_or(true);
    let missing_files = model_downloader::missing_files(&state.model_dir);
    let speakers = model_downloader::available_speakers()
        .iter()
        .map(|s| s.to_string())
        .collect();
    Ok(ModelStatus {
        downloaded,
        loaded,
        missing_files,
        speakers,
    })
}

/// Download model files from HuggingFace.
/// Runs on a blocking thread so the UI stays responsive.
#[tauri::command]
async fn download_model(state: State<'_, AppState>) -> Result<String, String> {
    let model_dir = state.model_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        model_downloader::download_model(&model_dir, |current, total, file| {
            log::info!("[{}/{}] Downloading {}", current + 1, total, file);
        })
        .map_err(|e| e.to_string())?;
        Ok("Model downloaded successfully".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Load (or reload) the TTS engine. Must be called after `download_model`.
/// Runs on a blocking thread so the UI stays responsive.
#[tauri::command]
async fn load_model(state: State<'_, AppState>) -> Result<String, String> {
    let model_dir = state.model_dir.clone();
    let renderer = state.renderer.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let r = audio_renderer::AudioRenderer::new(&model_dir)
            .map_err(|e| format!("Failed to load model: {}", e))?;
        *renderer.lock() = Some(r);
        Ok("Model loaded".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Synthesize TTS tags markup to a WAV track.
/// Runs on a blocking thread so the UI stays responsive.
#[tauri::command]
async fn synthesize(
    req: SynthesizeRequest,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<TrackInfo, String> {
    let tracks_dir = state.tracks_dir.clone();
    let agent_dir = state.agent_dir.clone();
    let renderer_arc = state.renderer.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Ensure output directory exists
        fs::create_dir_all(&tracks_dir).map_err(|e| e.to_string())?;

        // Parse tags
        let nodes = tag_parser::parse(&req.text).map_err(|e| format!("Parse error: {}", e))?;
        if nodes.is_empty() {
            return Err("No content to synthesize".to_string());
        }

        // Resolve <include> tags against the agent's writable data directory.
        // Missing/circular/invalid includes are silently skipped here.
        let nodes = audio_renderer::resolve_includes(nodes, &agent_dir);

        // Count speakable nodes for progress tracking
        let total = audio_renderer::count_speakable_nodes(&nodes);

        // Build progress callback that emits Tauri events
        let app_handle = app.clone();
        let progress_callback = Box::new(move |step: usize, total: usize, label: &str| {
            let _ = app_handle.emit(
                "synthesize-progress",
                serde_json::json!({
                    "step": step,
                    "total": total,
                    "label": label,
                }),
            );
        });

        let tracker = Arc::new(std::sync::Mutex::new(audio_renderer::ProgressTracker {
            step: 0,
            total,
            callback: progress_callback,
        }));

        // Lock renderer
        let mut guard = renderer_arc.lock();
        let renderer = guard
            .as_mut()
            .ok_or_else(|| "Model not loaded. Please load the model first.".to_string())?;

        // Build output filename
        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let safe_name = req
            .name
            .as_deref()
            .map(|n| sanitize_track_name(n))
            .unwrap_or_else(|| format!("track_{}", timestamp));
        let filename = format!("{}.wav", safe_name);
        let output_path = tracks_dir.join(&filename);

        // Render with progress
        let duration = renderer
            .render_to_file_with_progress(&nodes, &output_path, tracker)
            .map_err(|e| format!("Render error: {}", e))?;

        let metadata = fs::metadata(&output_path).map_err(|e| e.to_string())?;

        Ok(TrackInfo {
            name: safe_name,
            filename,
            path: output_path.to_string_lossy().to_string(),
            duration,
            created: chrono::Local::now().to_rfc3339(),
            size_bytes: metadata.len(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List all saved tracks.
#[tauri::command]
fn list_tracks(state: State<'_, AppState>) -> Result<Vec<TrackInfo>, String> {
    if !state.tracks_dir.exists() {
        return Ok(Vec::new());
    }

    let mut tracks = Vec::new();
    let entries = fs::read_dir(&state.tracks_dir).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("wav") {
            let filename = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            let metadata = match fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let created = metadata
                .created()
                .ok()
                .map(|t| {
                    let dt: chrono::DateTime<chrono::Local> = t.into();
                    dt.to_rfc3339()
                })
                .unwrap_or_default();

            let name = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            // Estimate duration from file size (16-bit mono WAV)
            let duration = if metadata.len() > 44 {
                let data_size = metadata.len() - 44;
                // 16-bit mono at renderer's sample rate
                data_size as f32 / (24000.0 * 2.0)
            } else {
                0.0
            };

            tracks.push(TrackInfo {
                name,
                filename,
                path: path.to_string_lossy().to_string(),
                duration,
                created,
                size_bytes: metadata.len(),
            });
        }
    }

    // Sort newest first
    tracks.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(tracks)
}

/// Delete a track by file path.
#[tauri::command]
fn delete_track(path: String) -> Result<String, String> {
    fs::remove_file(&path).map_err(|e| format!("Failed to delete track: {}", e))?;
    Ok("Deleted".to_string())
}

/// Delete a conditioning script's rendered manifest (the `tracks/<id>/`
/// directory holding manifest.json + seg-*.wav). The script source itself is
/// untouched, so it can be re-rendered anytime. The shared `tracks/imports/`
/// dedup dirs are deliberately left alone — another script may reference them.
#[tauri::command]
fn delete_manifest(script_path: String, state: State<'_, AppState>) -> Result<(), String> {
    let dir = state
        .tracks_dir
        .join(manifest::manifest_id(&script_path));
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|e| format!("Failed to delete render: {}", e))?;
    }
    Ok(())
}

/// Return available sound effect names.
#[tauri::command]
fn get_sound_names() -> Vec<String> {
    sounds::available_sound_names()
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Return the absolute path of the app data directory (for debugging UI).
#[tauri::command]
fn get_data_dir(state: State<'_, AppState>) -> String {
    state.data_dir.to_string_lossy().to_string()
}

/// Return the base URL of the in-process audio server, e.g.
/// `http://127.0.0.1:43219?t=<token>`. The frontend appends
/// `/tracks/<relative-path>` to stream rendered WAVs. This real loopback
/// socket avoids the Android WebView `shouldInterceptRequest` media-streaming
/// bug that truncates `asset://` audio at ~10s. See `audio_server` module docs.
#[tauri::command]
fn get_audio_base_url(state: State<'_, AppState>) -> String {
    state.audio_base_url.clone()
}

/// Return the absolute path of the agent's writable data directory.
#[tauri::command]
fn get_agent_dir(state: State<'_, AppState>) -> String {
    state.agent_dir.to_string_lossy().to_string()
}

/// Whether a framework has been imported: a framework import writes an
/// installed-framework record (`framework.json`) under the data dir, so the
/// presence of that record is the signal that onboarding is complete. The
/// frontend uses this to decide whether to show the onboarding flow.
#[tauri::command]
fn framework_installed(state: State<'_, AppState>) -> bool {
    package_manifest::read_installed_framework(&state.data_dir).is_some()
}

/// The currently installed framework (identity + version), or `null` if none.
/// Used by Settings to show which framework/version is present.
#[tauri::command]
fn get_installed_framework(
    state: State<'_, AppState>,
) -> Option<package_manifest::InstalledFramework> {
    package_manifest::read_installed_framework(&state.data_dir)
}

/// Check the framework's update channel at `url` and report whether a newer
/// version is available. Runs the (blocking) HTTP fetch on a blocking thread.
#[tauri::command]
async fn check_framework_update(
    url: String,
    state: State<'_, AppState>,
) -> Result<framework_updater::UpdateCheck, String> {
    let data_dir = state.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let installed = package_manifest::read_installed_framework(&data_dir);
        framework_updater::check_update(&url, installed.as_ref())
    })
    .await
    .map_err(|e| format!("Update check failed: {}", e))?
}

/// Download and install a framework from its update channel. Fetches the
/// index at `url`, downloads + verifies (sha256) the ZIP, and runs the
/// manifest-aware import pipeline. Emits `framework-download-progress`
/// events with `{ downloaded, total }` as bytes arrive (throttled to ~5 Hz
/// on the emit side by the UI, not here).
#[tauri::command]
async fn download_and_install_framework(
    url: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<package_import::ImportResult, String> {
    let data_dir = state.data_dir.clone();
    let agent_root = state.agent_dir.clone();
    let prompts_root = state.data_dir.join("prompts");
    let tmp_base = state.data_dir.join(".tmp");

    tauri::async_runtime::spawn_blocking(move || -> Result<package_import::ImportResult, String> {
        // 1. Fetch + parse the index.
        let index = framework_updater::fetch_index(&url)?;

        // 2. Download + verify + install, streaming progress to the UI.
        let progress_app = app.clone();
        let result = framework_updater::download_and_install(
            &index,
            &data_dir,
            &agent_root,
            &prompts_root,
            &tmp_base,
            |downloaded, total| {
                let _ = progress_app.emit(
                    "framework-download-progress",
                    serde_json::json!({ "downloaded": downloaded, "total": total }),
                );
            },
        )?;
        Ok(result)
    })
    .await
    .map_err(|e| format!("Install failed: {}", e))?
}

/// Result of a successful [`reset_app_data`] reset. Each flag names a
/// category that was wiped, so the UI can report what happened.
#[derive(Serialize, Clone, Debug, Default)]
pub struct ResetReport {
    pub prompts: bool,
    pub agent_data: bool,
    pub activity: bool,
    pub inventory: bool,
    pub chastity: bool,
    pub tracks: bool,
}

/// Tauri command: wipe all user data **except** the downloaded TTS model
/// (in `<data_dir>/model/`) and the API keys / per-agent model selection
/// (which live in the frontend's localStorage, never touched by the
/// backend).
///
/// Reset categories:
/// - `prompts/`   — cleared (no defaults re-seeded; re-import a framework)
/// - `agent_data/` — scripts, conditioning, journal, routines, rules, …
/// - `activity.db` — the activity log is emptied (autoincrement reset)
/// - `inventory.db` — items + wishlist rows deleted (autoincrement left as-is)
/// - `chastity.json` — lock + countdown reset to defaults
/// - `tracks/`     — rendered TTS audio removed
///
/// The TTS model directory and the frontend settings are intentionally
/// preserved. After this returns, the frontend should reload so every
/// view re-fetches from the now-empty backend.
#[tauri::command]
async fn reset_app_data(state: State<'_, AppState>) -> Result<ResetReport, String> {
    let mut report = ResetReport::default();

    // 1. Rendered tracks (plain files; safe to delete from the host).
    wipe_dir_contents(&state.tracks_dir)?;
    report.tracks = true;

    // 2. Prompts — wipe (no defaults are re-seeded; the user re-imports
    //    a framework, which the frontend will prompt for via onboarding).
    //    Also drop the installed-framework record so the app returns to the
    //    "no framework" onboarding state.
    wipe_dir_contents(&state.data_dir.join("prompts"))?;
    package_manifest::clear_installed_framework(&state.data_dir);
    report.prompts = true;

    // 3. Chastity — reset to the default (unlocked, no countdown) state.
    chastity::ChastityState::default().save(&state.state_dir.join("chastity.json"))?;
    report.chastity = true;

    // 4. Inventory — wipe via rusqlite. The DB is at state_dir/inventory.db.
    {
        let state_dir = state.state_dir.clone();
        rusqlite::Connection::open(state_dir.join("inventory.db"))
            .map_err(|e| e.to_string())?
            .execute_batch("DELETE FROM items; DELETE FROM wishlist;")
            .map_err(|e| e.to_string())?;
    }
    report.inventory = true;

    // 5. Agent feature data — wipe the writable scratch space, skipping
    //    `activity.db*` (reset in step 6). inventory.db lives in state_dir,
    //    not agent_dir, so it's not affected by this wipe.
    wipe_agent_data(&state.agent_dir)?;
    bash::ensure_agent_dir(&state.data_dir).map_err(|e| e.to_string())?;
    report.agent_data = true;

    // 6. Activity log — wipe via rusqlite. We only clear the rows; the
    //    autoincrement counter is left as-is (cosmetic — ids continue
    //    from where they left off rather than restarting at 1).
    {
        let agent_dir = state.agent_dir.clone();
        rusqlite::Connection::open(agent_dir.join("activity.db"))
            .map_err(|e| e.to_string())?
            .execute_batch("DELETE FROM activity;")
            .map_err(|e| e.to_string())?;
    }
    report.activity = true;

    Ok(report)
}

/// Recursively remove every entry inside `dir`, keeping `dir` itself.
fn wipe_dir_contents(dir: &std::path::Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|e| format!("readdir {}: {}", dir.display(), e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let r = if meta.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        r.map_err(|e| format!("remove {}: {}", path.display(), e))?;
    }
    Ok(())
}

/// Wipe the agent's writable scratch space (`agent_data/`), skipping
/// `activity.db` and its journal sidecars. Those are reset separately via
/// rusqlite in [`reset_app_data`]. (inventory.db lives in `state_dir/`,
/// not `agent_dir/`, so it's not affected by this wipe.)
fn wipe_agent_data(agent_dir: &std::path::Path) -> Result<(), String> {
    if !agent_dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(agent_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // activity.db (+ sidecars) is reset via rusqlite in reset_app_data.
        if name_str == "activity.db"
            || name_str.starts_with("activity.db-")
        {
            continue;
        }
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let r = if meta.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        r.map_err(|e| format!("remove {}: {}", path.display(), e))?;
    }
    Ok(())
}

// ============================================================================
// Manifest commands (recursive segment manifests backend)
// ============================================================================

/// Render (or reuse) a recursive segment manifest for `script_path` (relative
/// to `agent_dir`). Runs on a blocking thread; idempotent via freshness hash.
///
/// Emits `render-manifest-progress` events (carrying `script`, `step`,
/// `total`, `label`) as each speakable node renders, throttled to ~2 Hz
/// (see `emit_throttle_ms` in the callback below — fast synthesis ticks get
/// coalesced; it's fine to drop updates). Also drives an ongoing native
/// "Rendering…" notification (throttled independently). The frontend filters
/// progress events by `script` so concurrent renders don't cross-feed.
#[tauri::command]
async fn render_manifest(
    script_path: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<RenderedManifest, String> {
    let agent_dir = state.agent_dir.clone();
    let tracks_dir = state.tracks_dir.clone();
    let renderer_arc = state.renderer.clone();

    // Friendly title for the notification body: prefer the file stem.
    let display_title = script_path
        .split(|c| c == '/' || c == '\\')
        .last()
        .filter(|s| !s.is_empty())
        .unwrap_or(&script_path)
        .to_string();

    // Progress tracker: each tick emits a Tauri push event for the in-app
    // progress bar, throttled to 2 Hz (a render can emit hundreds of ticks —
    // we don't need them all, and dropping is fine for a purely cosmetic bar).
    // The native "Rendering…" notification is throttled independently. The
    // total is seeded lazily inside the walker as it parses each file (see
    // render_manifest_file).
    let progress_app = app.clone();
    let progress_script = script_path.clone();
    let notify_throttle = Arc::new(render_notify::RenderNotifyThrottle::new());
    let notify_app = app.clone();
    let notify_title = display_title.clone();
    // Shared throttle state for the push-event emit. The first tick always
    // emits; subsequent ticks emit only if ≥2 Hz has elapsed. Held behind a
    // Mutex because the callback is `Fn` (called from the worker thread).
    let emit_last: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
    /// Minimum gap between `render-manifest-progress` push events (~2 Hz).
    /// Phase labels (each does real work) are naturally further apart than
    /// this, so they always come through; only fast synthesis ticks coalesce.
    const EMIT_THROTTLE: Duration = Duration::from_millis(500);
    let progress_callback = Box::new(move |step: usize, total: usize, label: &str| {
        // Throttle the push event to ~2 Hz. Always emit the first tick of a
        // render so the bar moves immediately; otherwise require the gap.
        let should_emit = {
            let mut guard = emit_last.lock();
            let now = Instant::now();
            match *guard {
                None => {
                    *guard = Some(now);
                    true
                }
                Some(last) if now.duration_since(last) >= EMIT_THROTTLE => {
                    *guard = Some(now);
                    true
                }
                _ => false,
            }
        };
        if should_emit {
            let _ = progress_app.emit(
                "render-manifest-progress",
                serde_json::json!({
                    "script": progress_script,
                    "step": step,
                    "total": total,
                    "label": label,
                }),
            );
        }
        // The notification has its own (independent) throttle.
        notify_throttle.maybe_update(&notify_app, &notify_title, step, total);
    });

    // Fire the notification-permission request detached, NOT on this async
    // command thread. On some Android OEM stacks (e.g. ColorOS/OxygenOS) the
    // plugin's `request_permission()` JNI bridge can synchronously block
    // waiting on the UI looper; calling it inline here wedged the whole
    // `render_manifest` command before `spawn_blocking` even ran — no phase
    // event ever emitted and the invoke never resolved ("stuck on Preparing").
    // Detaching means a blocked permission call can never stall the render.
    render_notify::request_permission_detached(&app);

    let notify_app_for_setup = app.clone();
    let notify_title_for_setup = display_title.clone();
    log::info!("render_manifest: dispatching to spawn_blocking (script={})", script_path);
    let result = tauri::async_runtime::spawn_blocking(move || {
        // First signal to the UI: the command reached the worker. If this
        // never appears, the hang is in dispatch (event-loop starvation), not
        // in the render itself.
        let tracker = Arc::new(std::sync::Mutex::new(audio_renderer::ProgressTracker {
            step: 0,
            total: 0,
            callback: progress_callback,
        }));
        log::info!("render_manifest: worker started");
        if let Ok(mut t) = tracker.lock() {
            t.emit_phase("Entering worker…");
        }

        // Best-effort notification setup, off the main thread. Failures are
        // logged and swallowed inside render_notify so they can't fail the
        // render. Done after the "Entering worker…" phase so a hang in channel
        // creation / show is diagnosable too.
        render_notify::ensure_channel(&notify_app_for_setup);
        render_notify::show_render_progress(&notify_app_for_setup, &notify_title_for_setup, 0, 0);

        // Surface the (possibly slow / contended) engine acquisition as its own
        // phase so a hang here doesn't read as an opaque "Preparing…".
        if let Ok(mut t) = tracker.lock() {
            t.emit_phase("Acquiring engine…");
        }
        log::info!("render_manifest: acquiring engine lock");
        let mut guard = renderer_arc.lock();
        log::info!("render_manifest: engine lock acquired");
        let renderer = guard
            .as_mut()
            .ok_or_else(|| "Model not loaded. Please load the model first.".to_string())?;
        log::info!("render_manifest: starting render_manifest on engine");
        let r = renderer
            .render_manifest(&script_path, &agent_dir, &tracks_dir, Some(&tracker))
            .map_err(|e| format!("Render error: {:#}", e));
        log::info!("render_manifest: engine returned");
        r
    })
    .await;

    // Whether the render succeeded or failed, tear down the notification so
    // it doesn't linger forever.
    render_notify::clear_render_progress(&app);
    result.map_err(|e| e.to_string())?
}

/// Report whether a manifest exists for `script_path` and whether it is stale.
#[tauri::command]
fn manifest_status(
    script_path: String,
    state: State<'_, AppState>,
) -> Result<ManifestStatus, String> {
    let manifest_path = state
        .tracks_dir
        .join(manifest::manifest_id(&script_path))
        .join("manifest.json");

    if !manifest_path.exists() {
        return Ok(ManifestStatus {
            rendered: false,
            stale: false,
            duration: None,
            created: None,
            manifest_path: None,
        });
    }

    let existing_str = fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
    // A parse failure here means an old/incompatible manifest format. Rather
    // than erroring out, treat it as "not rendered" so the UI offers to
    // re-render (which regenerates it in the current format).
    let existing: manifest::Manifest = match serde_json::from_str(&existing_str) {
        Ok(m) => m,
        Err(_) => {
            return Ok(ManifestStatus {
                rendered: false,
                stale: false,
                duration: None,
                created: None,
                manifest_path: None,
            })
        }
    };

    let source_abs = state.agent_dir.join(&script_path);
    let stale = match fs::read(&source_abs) {
        Ok(bytes) => existing.hash != manifest::hash_bytes(&bytes),
        // Source file missing — surface as stale so the UI re-renders.
        Err(_) => true,
    };

    Ok(ManifestStatus {
        rendered: true,
        stale,
        duration: Some(manifest::nominal_duration(&existing.root)),
        created: Some(mtime_rfc3339_pub(&manifest_path)),
        manifest_path: Some(manifest_path.to_string_lossy().to_string()),
    })
}

/// Read a manifest.json and return it as JSON with every relative `file` /
/// `manifest` path resolved to an absolute path (relative to the manifest's
/// own dir). Imports are resolved to an absolute path but NOT recursed — the
/// frontend loads them lazily by calling `read_manifest` again.
#[tauri::command]
fn read_manifest(manifest_path: String) -> Result<serde_json::Value, String> {
    let path = PathBuf::from(&manifest_path);
    let base_dir = path
        .parent()
        .ok_or_else(|| "invalid manifest path".to_string())?
        .to_path_buf();
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut value: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    manifest::resolve_paths_recursive(&mut value["root"], &base_dir);
    Ok(value)
}

/// List every top-level manifest under `tracks/` (one level deep, excluding
/// the shared `imports/` subdir).
#[tauri::command]
fn list_manifests(state: State<'_, AppState>) -> Result<Vec<RenderedManifest>, String> {
    let mut out = Vec::new();
    if !state.tracks_dir.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(&state.tracks_dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "imports" {
            continue;
        }
        let mp = path.join("manifest.json");
        if !mp.exists() {
            continue;
        }
        let Ok(content) = fs::read_to_string(&mp) else {
            continue;
        };
        let Ok(m): std::result::Result<manifest::Manifest, _> = serde_json::from_str(&content)
        else {
            continue;
        };
        out.push(RenderedManifest {
            id: name,
            manifest_path: mp.to_string_lossy().to_string(),
            script: m.script,
            duration: manifest::nominal_duration(&m.root),
            created: mtime_rfc3339_pub(&mp),
        });
    }
    // Newest first.
    out.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(out)
}

// ============================================================================
// Debug: export all conditioning scripts (+ referenced files + includes) as ZIP
// ============================================================================

/// Conditioning metadata JSON shape (only `script_path` is needed here).
#[derive(Deserialize)]
struct ConditioningMeta {
    script_path: String,
}

/// Lexically collapse `.` / `..` without requiring the path to exist, then
/// verify the result stays under `root`. Mirrors `bash::resolve_under` but
/// accepts an already-joined absolute path (used for include resolution, where
/// the base is the *script's* directory rather than `agent_dir` directly).
fn normalize_under(root: &Path, joined: &Path) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();
    for c in joined.components() {
        match c {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    if !normalized.starts_with(root) {
        return Err("path escapes the agent directory".to_string());
    }
    Ok(normalized)
}

/// Resolve a `<include src>` to an absolute path, using the SAME rule as the
/// renderer (`audio_renderer::AudioRenderer::emit_include`): relative to the
/// including script's directory first, then relative to `agent_dir`. Returns
/// `None` (with a warning pushed to `warnings`) if neither exists.
fn resolve_include(
    src: &str,
    script_dir: &Path,
    agent_dir: &Path,
    warnings: &mut Vec<String>,
) -> Option<PathBuf> {
    let rel = script_dir.join(src);
    if rel.exists() {
        if let Ok(n) = normalize_under(agent_dir, &rel) {
            return Some(n);
        }
    }
    let abs = agent_dir.join(src);
    if abs.exists() {
        if let Ok(n) = normalize_under(agent_dir, &abs) {
            return Some(n);
        }
    }
    warnings.push(format!("include not found: {}", src));
    None
}

/// Recursively collect every `<include src>` target reachable from `nodes`,
/// appending each resolved (absolute) path to `out` and recursing into the
/// included file's own AST. `visited` prevents cycles / duplicate work
/// (mirrors the renderer's `visited` set).
fn collect_includes(
    nodes: &[tag_parser::Node],
    script_dir: &Path,
    agent_dir: &Path,
    out: &mut Vec<PathBuf>,
    visited: &mut std::collections::HashSet<PathBuf>,
    warnings: &mut Vec<String>,
) {
    for node in nodes {
        match node {
            tag_parser::Node::Include { src } => {
                if let Some(abs) = resolve_include(src, script_dir, agent_dir, warnings) {
                    if visited.insert(abs.clone()) {
                        out.push(abs.clone());
                        // Recurse into the included file's AST, resolving its
                        // own includes relative to ITS directory.
                        let inc_dir = abs
                            .parent()
                            .unwrap_or_else(|| std::path::Path::new("."))
                            .to_path_buf();
                        if let Ok(bytes) = fs::read(&abs) {
                            if let Ok(src_str) = std::str::from_utf8(&bytes) {
                                if let Ok(inc_nodes) = tag_parser::parse(src_str) {
                                    collect_includes(
                                        &inc_nodes, &inc_dir, agent_dir, out, visited, warnings,
                                    );
                                }
                            }
                        }
                    }
                }
            }
            // Container nodes — recurse to find nested includes.
            tag_parser::Node::Voice { children, .. }
            | tag_parser::Node::Speed { children, .. }
            | tag_parser::Node::Volume { children, .. }
            | tag_parser::Node::Effect { children, .. }
            | tag_parser::Node::Background { children, .. }
            | tag_parser::Node::Until { children, .. }
            | tag_parser::Node::Loop { children, .. }
            | tag_parser::Node::Section { children, .. } => {
                collect_includes(children, script_dir, agent_dir, out, visited, warnings);
            }
            tag_parser::Node::Overlay { parts, .. }
            | tag_parser::Node::Random { parts }
            | tag_parser::Node::Scramble { parts }
            | tag_parser::Node::Choice { options: parts, .. } => {
                for part in parts {
                    collect_includes(
                        &part.children, script_dir, agent_dir, out, visited, warnings,
                    );
                }
            }
            // Leaves with no children / no includes.
            tag_parser::Node::Text(_)
            | tag_parser::Node::Pause { .. }
            | tag_parser::Node::Sound { .. }
            | tag_parser::Node::Tone { .. } => {}
        }
    }
}

/// Debug export: write every conditioning script and everything needed to
/// re-render it to a ZIP.
///
/// Scope is the minimal set needed to reproduce a render: each
/// `conditioning/*.json`, its referenced `script_path`, and every
/// `<include>` target resolved recursively (same rule the renderer uses).
/// Entries are stored under their `agent_dir`-relative paths so the archive
/// preserves the on-disk layout. Unrelated/sensitive data (journal, routines,
/// voice, …) is intentionally excluded.
///
/// The destination depends on the platform:
/// - **Desktop**: `out_path` (from the OS save dialog) is the ZIP file to
///   write directly.
/// - **Android**: the save dialog returns an unusable `content://` URI, so
///   `out_path` is `None`. Instead we write the archive into public
///   `Downloads/train-me/` via `tauri-plugin-android-fs` (which yields a
///   shareable `content://` URI) and immediately fire the system share sheet,
///   letting the user send/save the file with another app. This sidesteps the
///   `fs::File::create` failure entirely.
///
/// Returns counts and any non-fatal warnings.
#[tauri::command]
async fn export_scripts_zip(
    out_path: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ExportResult, String> {
    let agent_dir = state.agent_dir.clone();

    // ── 1. Build the ZIP bytes (in memory). The script set is small text
    //    files, so buffering in memory is fine and works identically on both
    //    platforms — no filesystem handle to keep open across the IPC below.
    let zip_bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        gather_scripts_zip(&agent_dir)
    })
    .await
    .map_err(|e| format!("Export task failed: {}", e))??;

    let total_bytes = zip_bytes.len() as u64;
    // Count entries by reopening the archive we just built (cheap, in-memory).
    let count = count_zip_entries(&zip_bytes);

    // ── 2. Persist + hand off to the user via the shared helper (handles
    //    the desktop save-path vs. Android Downloads + share-sheet split).
    let note = persist_export_artifact(&app, out_path, &zip_bytes, "scripts.zip", "application/zip").await?;

    Ok(ExportResult {
        files: count,
        bytes: total_bytes,
        note,
    })
}

/// Persist an export artifact (zip/csv/…) to the user-chosen destination and
/// hand it off.
///
/// Branches on platform at compile time:
/// - **Desktop**: writes the bytes to `out_path` (from the OS save dialog).
///   Returns an error if `out_path` is `None` (dialog was cancelled).
/// - **Android**: the save dialog returns an unusable `content://` URI, so
///   `out_path` is ignored (`None` is expected). Instead the bytes are written
///   into public `Downloads/train-me/<default_name>` via `tauri-plugin-android-fs`
///   (which yields a shareable `content://` URI) and the system share sheet is
///   fired so the user can send/save the file with another app.
///
/// Returns `Some(warnings)` if anything non-fatal happened (e.g. the share
/// sheet failed to open), otherwise `None`.
pub async fn persist_export_artifact(
    app: &tauri::AppHandle,
    out_path: Option<String>,
    bytes: &[u8],
    default_name: &str,
    mime: &str,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_android_fs::{AndroidFsExt, PublicGeneralPurposeDir};
        let api = app.android_fs_async();
        let rel = format!("train-me/{}", default_name);

        // Write into public Downloads/train-me/<default_name> → a persistent,
        // shareable content:// URI (no permissions needed on Android 11+).
        let uri = api
            .public_storage()
            .write_new(None, PublicGeneralPurposeDir::Download, &rel, Some(mime), bytes)
            .await
            .map_err(|e| format!("Failed to write {} to Downloads: {}", default_name, e))?;

        // Fire the system share sheet. Returns immediately (non-blocking).
        let mut warnings = Vec::new();
        if let Err(e) = api.file_opener().share_file(&uri).await {
            warnings.push(format!("share sheet failed: {}", e));
        }
        return Ok(if warnings.is_empty() {
            None
        } else {
            Some(warnings.join("\n"))
        });
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let _ = (default_name, mime);
        let out_path = out_path.ok_or_else(|| {
            "No output path provided (the save dialog was cancelled).".to_string()
        })?;
        let out_path = PathBuf::from(out_path);
        fs::write(&out_path, bytes)
            .map_err(|e| format!("Failed to write {}: {}", out_path.display(), e))?;
        Ok(None)
    }
}

/// Walk `agent_dir/conditioning/*.json`, collect each script + its recursive
/// `<include>` targets, and write them all to a fresh in-memory ZIP. Entries
/// use `agent_dir`-relative, forward-slash names so unzipping reproduces the
/// layout. Returns the raw archive bytes.
fn gather_scripts_zip(agent_dir: &Path) -> Result<Vec<u8>, String> {
    let cond_dir = agent_dir.join("conditioning");

    // Gather the set of absolute files to archive, deduplicated. Order:
    // conditioning JSONs first, then each one's script + includes.
    let mut files: Vec<PathBuf> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut add = |abs: PathBuf, seen: &mut std::collections::HashSet<PathBuf>| {
        if seen.insert(abs.clone()) {
            files.push(abs);
        }
    };

    if cond_dir.is_dir() {
        let entries = fs::read_dir(&cond_dir).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            // Always archive the conditioning JSON itself.
            add(path.clone(), &mut seen);

            let raw = match fs::read_to_string(&path) {
                Ok(s) => s,
                Err(e) => {
                    warnings.push(format!(
                        "couldn't read {}: {}",
                        path.file_name().unwrap_or_default().to_string_lossy(),
                        e
                    ));
                    continue;
                }
            };
            let meta: ConditioningMeta = match serde_json::from_str(&raw) {
                Ok(m) => m,
                Err(_) => {
                    warnings.push(format!(
                        "couldn't parse {} (not a conditioning JSON?)",
                        path.file_name().unwrap_or_default().to_string_lossy()
                    ));
                    continue;
                }
            };

            // Resolve the referenced script under agent_dir.
            let script_abs = match bash::resolve_under(agent_dir, &meta.script_path) {
                Ok(p) => p,
                Err(e) => {
                    warnings.push(format!(
                        "bad script_path {:?} in {}: {}",
                        meta.script_path,
                        path.file_name().unwrap_or_default().to_string_lossy(),
                        e
                    ));
                    continue;
                }
            };
            if !script_abs.exists() {
                warnings.push(format!("script not found: {}", meta.script_path));
            } else {
                add(script_abs.clone(), &mut seen);
                let script_dir = script_dir_of(&script_abs);
                if let Ok(bytes) = fs::read(&script_abs) {
                    if let Ok(src_str) = std::str::from_utf8(&bytes) {
                        if let Ok(nodes) = tag_parser::parse(src_str) {
                            let mut incs: Vec<PathBuf> = Vec::new();
                            collect_includes(
                                &nodes,
                                &script_dir,
                                agent_dir,
                                &mut incs,
                                &mut std::collections::HashSet::new(),
                                &mut warnings,
                            );
                            for inc in incs {
                                add(inc, &mut seen);
                            }
                        }
                    }
                }
            }
        }
    } else {
        warnings.push("no conditioning/ directory found".to_string());
    }

    // Build the ZIP into a memory buffer.
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    for abs in &files {
        let bytes = match fs::read(abs) {
            Ok(b) => b,
            Err(e) => {
                warnings.push(format!("couldn't read {}: {}", abs.display(), e));
                continue;
            }
        };
        // agent_dir-relative archive name, forward-slash normalised.
        let rel = abs
            .strip_prefix(agent_dir)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| abs.to_string_lossy().replace('\\', "/"));
        zip.start_file(&rel, opts)
            .map_err(|e| format!("zip write failed: {}", e))?;
        zip.write_all(&bytes)
            .map_err(|e| format!("zip write failed: {}", e))?;
    }
    let cursor = zip
        .finish()
        .map_err(|e| format!("Failed to finalize zip: {}", e))?;

    // Fold the (non-fatal) collection warnings into the archive as a README so
    // the user sees them when debugging — they explain missing files.
    let mut bytes = cursor.into_inner();
    if !warnings.is_empty() {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(std::mem::take(&mut bytes)));
        zip.start_file("_export-warnings.txt", opts)
            .map_err(|e| format!("zip write failed: {}", e))?;
        zip.write_all(warnings.join("\n").as_bytes())
            .map_err(|e| format!("zip write failed: {}", e))?;
        bytes = zip
            .finish()
            .map_err(|e| format!("Failed to finalize zip: {}", e))?
            .into_inner();
    }
    Ok(bytes)
}

/// Parent directory of `abs`, or "." if none (mirrors the renderer's
/// `emit_include` default).
fn script_dir_of(abs: &Path) -> PathBuf {
    abs.parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf()
}

/// Count entries in an in-memory ZIP (for the result's `files` count).
fn count_zip_entries(zip_bytes: &[u8]) -> usize {
    zip::ZipArchive::new(std::io::Cursor::new(zip_bytes))
        .map(|a| a.len())
        .unwrap_or(0)
}

// ============================================================================
// Full-data ZIP export
// ============================================================================

/// A `(source_dir, archive_prefix)` pair: everything under `source_dir` is
/// added to the zip under the `archive_prefix/` folder. Empty `source_dir`s
/// (e.g. nothing rendered yet) are skipped silently. Owns its path so it can
/// move into a `spawn_blocking` closure (`'static`).
struct ArchiveRoot {
    source: PathBuf,
    prefix: &'static str,
}

/// Full backup: bundle everything the user could want to restore **except**
/// the (large, redownloadable) TTS model.
///
/// Archive layout:
/// - `prompts/`            — system prompts (`data_dir/prompts/`)
/// - `agent_data/`         — agent scratch: journal, scripts, conditioning,
///                           routines, rules, voice, `activity.db`, …
/// - `state/`              — `inventory.db`, `chastity.json`
/// - `tracks/`             — rendered TTS audio
/// - `settings.json`       — frontend settings (incl. API keys) from localStorage
/// - `chat-history.json`   — the saved chat transcript from localStorage
///
/// `settings_json` / `chat_history_json` are the raw localStorage strings the
/// frontend passes in (they may be `None` if nothing is stored yet). The TTS
/// model in `model/` is intentionally excluded.
#[tauri::command]
async fn export_all_zip(
    out_path: Option<String>,
    settings_json: Option<String>,
    chat_history_json: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ExportResult, String> {
    // Clone everything the blocking task needs up front (paths are cheap).
    let prompts_dir = state.data_dir.join("prompts");
    let agent_dir = state.agent_dir.clone();
    let state_dir = state.state_dir.clone();
    let tracks_dir = state.tracks_dir.clone();

    let roots = vec![
        ArchiveRoot { source: prompts_dir, prefix: "prompts" },
        ArchiveRoot { source: agent_dir, prefix: "agent_data" },
        ArchiveRoot { source: state_dir, prefix: "state" },
        ArchiveRoot { source: tracks_dir, prefix: "tracks" },
    ];

    let zip_bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        gather_full_zip(roots, settings_json, chat_history_json)
    })
    .await
    .map_err(|e| format!("Export task failed: {}", e))??;

    let total_bytes = zip_bytes.len() as u64;
    let count = count_zip_entries(&zip_bytes);

    let note = persist_export_artifact(&app, out_path, &zip_bytes, "train-me-backup.zip", "application/zip").await?;

    Ok(ExportResult {
        files: count,
        bytes: total_bytes,
        note,
    })
}

/// Walk every `ArchiveRoot` recursively and write the whole tree into a fresh
/// in-memory ZIP. `settings_json` and `chat_history_json` (if present) are
/// added as top-level `settings.json` / `chat-history.json` entries.
///
/// Files are stored under their `prefix/` + source-relative, forward-slash
/// names so unzipping reproduces the on-disk layout. Unreadable files are
/// skipped with a non-fatal warning rather than aborting the whole backup.
fn gather_full_zip(
    roots: Vec<ArchiveRoot>,
    settings_json: Option<String>,
    chat_history_json: Option<String>,
) -> Result<Vec<u8>, String> {
    let mut warnings: Vec<String> = Vec::new();

    // Collect (archive_name, bytes) entries. We buffer file bytes eagerly so
    // the ZipWriter borrows are short-lived and we can't deadlock on a deep
    // recursion holding the cursor borrow open.
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();

    for root in roots {
        if !root.source.is_dir() {
            continue;
        }
        let base = root.source.clone();
        let prefix = root.prefix;
        let mut stack: Vec<PathBuf> = vec![base.clone()];
        while let Some(dir) = stack.pop() {
            let read = match fs::read_dir(&dir) {
                Ok(r) => r,
                Err(e) => {
                    warnings.push(format!("couldn't read {}: {}", dir.display(), e));
                    continue;
                }
            };
            for entry in read.flatten() {
                let path = entry.path();
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(e) => {
                        warnings.push(format!("couldn't stat {}: {}", path.display(), e));
                        continue;
                    }
                };
                if meta.is_dir() {
                    stack.push(path);
                } else if meta.is_file() {
                    let bytes = match fs::read(&path) {
                        Ok(b) => b,
                        Err(e) => {
                            warnings.push(format!("couldn't read {}: {}", path.display(), e));
                            continue;
                        }
                    };
                    // <prefix>/<source-relative path>, forward-slash normalised.
                    let rel = match path.strip_prefix(&base) {
                        Ok(p) => p.to_string_lossy().replace('\\', "/"),
                        Err(_) => path.to_string_lossy().replace('\\', "/"),
                    };
                    let name = if rel.is_empty() {
                        prefix.to_string()
                    } else {
                        format!("{}/{}", prefix, rel)
                    };
                    entries.push((name, bytes));
                }
                // Symlinks are skipped — never followed across a backup.
            }
        }
    }

    if let Some(s) = settings_json {
        entries.push(("settings.json".to_string(), s.into_bytes()));
    }
    if let Some(c) = chat_history_json {
        entries.push(("chat-history.json".to_string(), c.into_bytes()));
    }

    // Build the ZIP.
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    for (name, bytes) in &entries {
        zip.start_file(name, opts)
            .map_err(|e| format!("zip write failed: {}", e))?;
        zip.write_all(bytes)
            .map_err(|e| format!("zip write failed: {}", e))?;
    }

    // Fold non-fatal warnings into the archive so the user sees them.
    if !warnings.is_empty() {
        zip.start_file("_export-warnings.txt", opts)
            .map_err(|e| format!("zip write failed: {}", e))?;
        zip.write_all(warnings.join("\n").as_bytes())
            .map_err(|e| format!("zip write failed: {}", e))?;
    }

    let cursor = zip
        .finish()
        .map_err(|e| format!("Failed to finalize zip: {}", e))?;
    Ok(cursor.into_inner())
}

/// Whether the backend was compiled for Android. The frontend uses this to
/// decide whether to show the OS save dialog (desktop) or let the backend
/// share via the system share sheet (Android, where the save dialog returns
/// an unusable `content://` URI).
#[tauri::command]
fn is_android() -> bool {
    cfg!(target_os = "android")
}

/// Diagnostic helper: emit a short stream of `test-event` push events so the
/// Settings UI can verify end-to-end that backend → frontend event delivery is
/// working (and surface dropped / duplicated events). Sends 5 events ~300 ms
/// apart; the payload carries an index, message, and RFC 3339 timestamp.
#[tauri::command]
async fn test_event(app: tauri::AppHandle) -> Result<(), String> {
    for i in 1..=5 {
        let _ = app.emit(
            "test-event",
            serde_json::json!({
                "index": i,
                "total": 5,
                "message": format!("Test event #{i}"),
                "ts": chrono::Local::now().to_rfc3339(),
            }),
        );
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    Ok(())
}

/// RFC 3339 mtime of a path ("now" fallback). Thin pub(crate) wrapper so
/// command functions in lib.rs can reuse the helper living in audio_renderer.
fn mtime_rfc3339_pub(path: &std::path::Path) -> String {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| {
            let dt: chrono::DateTime<chrono::Local> = t.into();
            dt.to_rfc3339()
        })
        .unwrap_or_else(|_| chrono::Local::now().to_rfc3339())
}

// ============================================================================
// Helpers
// ============================================================================

/// Generate a random per-launch token for the audio server. 32 hex chars
/// (128 bits of entropy) is more than enough to make loopback port-scanning
/// useless: even a local attacker who finds the port can't guess the token.
fn generate_audio_token() -> String {
    use rand::RngCore;
    use std::fmt::Write;
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    let mut s = String::with_capacity(32);
    for b in buf {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn sanitize_track_name(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // Limit length
    let truncated = sanitized.chars().take(64).collect::<String>();
    truncated
}

// ============================================================================
// Cron helpers
// ============================================================================

/// Compute the next `count` fire times for a cron expression.
///
/// Accepts the documented 5-field form (`min hour dom month dow`) as well
/// as 6/7-field (`sec min hour dom month dow [year]`) and `@`-shorthands:
/// a 5-field expression is normalized to 6-field by prepending a `0`
/// seconds field before handing it to the `cron` crate (which otherwise
/// silently rejects 5-field input and schedules nothing). See
/// `validators::normalize_cron`.
///
/// Returns RFC 3339 strings. If the expression is invalid or produces
/// fewer matches, returns a shorter (or empty) vec.
#[tauri::command]
fn next_cron_times(expr: &str, count: usize) -> Vec<String> {
    use chrono::Utc;
    use cron::Schedule as CronSchedule;
    use std::str::FromStr;

    let normalized = validators::normalize_cron(expr);
    let Ok(schedule) = CronSchedule::from_str(&normalized) else {
        return Vec::new();
    };
    schedule
        .upcoming(Utc)
        .take(count)
        .map(|t| t.to_rfc3339())
        .collect()
}

// ============================================================================
// App entrypoint
// ============================================================================

/// Initialise the `log` facade so `log::info!` / `warn!` / `debug!` calls
/// actually go somewhere observable.
///
/// On Android the default `log` sink is a no-op — without an initialised
/// logger every `log::*!` call in the backend is silently discarded, which
/// made a stuck render (see `render_manifest`) invisible: logcat showed nothing
/// from the Rust side even though the worker had hung. We route through
/// `android_logger` (tag `RustStdout`, matching Tauri's convention) so the
/// existing `log::*!` callsites show up in `adb logcat`.
///
/// On non-Android (desktop) targets we fall back to `env_logger`, which prints
/// to stderr — useful when running `cargo tauri dev` on the host. Filter is
/// `info` by default; override with `RUST_LOG` (desktop) or by editing here.
#[cfg(target_os = "android")]
fn init_logger() {
    use android_logger::Config;
    android_logger::init_once(
        Config::default()
            .with_max_level(log::LevelFilter::Info)
            .with_tag("RustStdout"),
    );
}

#[cfg(not(target_os = "android"))]
fn init_logger() {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logger();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // Android-aware FS: lets package imports read `content://` URIs
        // returned by the Android file picker. On non-Android targets the
        // plugin initialises as a no-op stub.
        .plugin(tauri_plugin_android_fs::init())
        .setup(|app| {
            // Resolve data directories
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to resolve app data directory");

            let agent_dir = data_dir.join("agent_data");
            let state_dir = data_dir.join("state");
            let model_dir = data_dir.join("model");
            let tracks_dir = data_dir.join("tracks");

            // Ensure they exist
            std::fs::create_dir_all(&data_dir).ok();
            std::fs::create_dir_all(&agent_dir).ok();
            std::fs::create_dir_all(&state_dir).ok();
            std::fs::create_dir_all(&model_dir).ok();
            std::fs::create_dir_all(&tracks_dir).ok();

            // Ensure prompts/ exists (empty — no default prompts are
            // shipped; the user imports a framework during onboarding).
            bash::ensure_prompts_dir(&data_dir).ok();
            // Ensure agent_data/ exists with conventional subdirs.
            bash::ensure_agent_dir(&data_dir).ok();

            // Bootstrap the SQLite DB schemas.
            //
            // activity.db lives inside the agent sandbox (agent_dir/) so
            // the agent can query it via the embedded `sqlite` builtin.
            // The UI reads/writes it via rusqlite directly.
            //
            // inventory.db lives outside the sandbox (state_dir/) and is
            // accessed only via rusqlite — the UI commands and the
            // `inventory` bashkit builtin both use transient connections.
            activity_db::ensure_schema(&agent_dir.join("activity.db"))
                .expect("failed to init activity.db schema");
            inventory::ensure_schema(&state_dir.join("inventory.db"))
                .expect("failed to init inventory.db schema");

            log::info!("Data dir: {:?}", data_dir);
            log::info!("Agent dir: {:?}", agent_dir);
            log::info!("State dir: {:?}", state_dir);
            log::info!("Model dir: {:?}", model_dir);
            log::info!("Tracks dir: {:?}", tracks_dir);

            // Build the bash sandbox scoped to the agent's writable area.
            let bash_sandbox = bash::create_bash_sandbox(&agent_dir, &state_dir)
                .expect("Failed to initialize bashkit sandbox");

            // Start the in-process audio server. Bound synchronously
            // (`block_on`) so the base URL is available before the first
            // `get_audio_base_url` call can fire — binding a loopback socket
            // is sub-millisecond. The serve loop itself is detached inside
            // `bind_audio_server` and runs for the app's lifetime. See
            // `audio_server` module docs for why we serve audio over HTTP
            // rather than Tauri's `asset://` protocol.
            let audio_token = generate_audio_token();
            let audio_base_url =
                match tauri::async_runtime::block_on(audio_server::bind_audio_server(
                    tracks_dir.clone(),
                    audio_token.clone(),
                )) {
                    Ok((addr, _join)) => {
                        let url = format!(
                            "http://{}?{}={}",
                            addr,
                            audio_server::TOKEN_PARAM,
                            audio_token
                        );
                        log::info!("Audio server listening on {}", addr);
                        url
                    }
                    Err(e) => {
                        // Non-fatal: audio playback will be broken, but the
                        // rest of the app should still start. The frontend
                        // falls back to a clearly-invalid URL it can surface.
                        log::error!("Failed to start audio server: {e}");
                        String::from("about:blank")
                    }
                };

            app.manage(AppState {
                data_dir,
                agent_dir,
                state_dir,
                model_dir,
                tracks_dir,
                audio_base_url,
                renderer: Arc::new(Mutex::new(None)),
                bash: Arc::new(bash_sandbox),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Existing TTS commands
            get_model_status,
            download_model,
            load_model,
            synthesize,
            list_tracks,
            delete_track,
            get_sound_names,
            // Recursive segment manifest commands
            render_manifest,
            manifest_status,
            read_manifest,
            list_manifests,
            delete_manifest,
            // Debug: export all conditioning scripts (+ includes) as a zip
            export_scripts_zip,
            // Full backup: export all data (except the TTS model) as a zip
            export_all_zip,
            is_android,
            // Diagnostics: emit a test-event stream (Settings → Diagnostics).
            test_event,
            // Agent / bash / file commands
            bash::exec_bash,
            bash::read_data_file,
            bash::write_data_file,
            bash::edit_data_file,
            bash::list_data_files,
            bash::read_prompt,
            bash::list_prompt_files,
            get_data_dir,
            get_audio_base_url,
            get_agent_dir,
            // Onboarding: has a framework been imported?
            framework_installed,
            get_installed_framework,
            // Package import
            package_import::import_package,
            // Framework update channel (URL download + install)
            check_framework_update,
            download_and_install_framework,
            // App-data reset (preserves model/ + API keys)
            reset_app_data,
            // Cron computation for routine scheduling
            next_cron_times,
            // Feature-file validation (routines, rules, conditioning, journal, voice)
            validators::validate_data_files,
            // Inventory (SQLite-backed)
            inventory::inventory_list_items,
            inventory::inventory_add_item,
            inventory::inventory_update_item,
            inventory::inventory_remove_item,
            inventory::inventory_list_wishlist,
            inventory::inventory_add_wishlist_item,
            inventory::inventory_update_wishlist_item,
            inventory::inventory_remove_wishlist_item,
            inventory::inventory_export_csv,
            inventory::inventory_import_csv,
            // Activity (SQLite-backed)
            activity_db::activity_list_entries,
            activity_db::activity_get_entry,
            activity_db::activity_log_entry,
            activity_db::activity_track_stats,
            // Chastity (state-dir-backed)
            chastity::get_chastity_state,
            chastity::chastity_lock,
            chastity::chastity_unlock,
            chastity::chastity_auto_unlock,
            chastity::chastity_arm_countdown,
            chastity::chastity_stop_countdown,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
