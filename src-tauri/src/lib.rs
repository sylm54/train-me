use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

mod activity_db;
mod audio_renderer;
mod bash;
mod chastity;
mod expression;
mod helper;
mod inventory;
mod manifest;
mod model_downloader;
mod package_import;
mod render_notify;
mod sounds;
mod tag_parser;

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
pub struct AppState {
    pub data_dir: PathBuf,
    pub agent_dir: PathBuf,
    pub state_dir: PathBuf,
    pub model_dir: PathBuf,
    pub tracks_dir: PathBuf,
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

// ============================================================================
// Tauri Commands
// ============================================================================

/// Check whether the model has been downloaded and is loaded.
#[tauri::command]
fn get_model_status(state: State<'_, AppState>) -> Result<ModelStatus, String> {
    let downloaded = model_downloader::is_model_downloaded(&state.model_dir);
    let loaded = state.renderer.lock().is_some();
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

/// Return the absolute path of the agent's writable data directory.
#[tauri::command]
fn get_agent_dir(state: State<'_, AppState>) -> String {
    state.agent_dir.to_string_lossy().to_string()
}

/// Whether a framework has been imported: we treat the presence of
/// `prompts/main_agent.md` as the signal that onboarding is complete.
/// The frontend uses this to decide whether to show the onboarding flow.
#[tauri::command]
fn framework_installed(state: State<'_, AppState>) -> bool {
    state
        .data_dir
        .join("prompts")
        .join("main_agent.md")
        .exists()
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
    wipe_dir_contents(&state.data_dir.join("prompts"))?;
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
// writeScript command (writer subagent)
// ============================================================================

/// Result returned by the `write_script` Tauri command.
/// `valid=false` means the XML failed validation; the writer subagent
/// should look at `error` and try again.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WriteScriptResult {
    pub valid: bool,
    /// Absolute path the file was written to (only present on success).
    pub path: Option<String>,
    /// Validation error message (only present on failure).
    pub error: Option<String>,
    /// Number of top-level AST nodes parsed (debug info).
    pub node_count: usize,
}

/// Tauri command invoked by the writer subagent's `writeScript` tool.
///
/// Validates the XML body via `tag_parser::parse()` and writes it to
/// `<agent_data>/<path>` on success. On validation failure, returns
/// `valid=false` with the parser error — the writer can read the error
/// from the tool result and try again.
#[tauri::command]
fn write_script(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<WriteScriptResult, String> {
    // Validate XML by parsing the TTS tag AST.
    let nodes = match tag_parser::parse(&content) {
        Ok(nodes) => nodes,
        Err(e) => {
            return Ok(WriteScriptResult {
                valid: false,
                path: None,
                error: Some(format!("Invalid TTS markup: {}", e)),
                node_count: 0,
            });
        }
    };

    // Second-pass semantic validation: catch unknown sound types, tone
    // presets, effect types, speaker names, etc. These pass the parser
    // but would fail the renderer with an opaque "parse …" error.
    if let Err(e) = tag_parser::validate(&nodes) {
        return Ok(WriteScriptResult {
            valid: false,
            path: None,
            error: Some(format!("Invalid TTS markup: {}", e)),
            node_count: nodes.len(),
        });
    }

    // Resolve the destination under the agent's writable area.
    // We reuse the same traversal-safe resolver used for read_data_file /etc.
    let resolved = match bash::resolve_under(&state.agent_dir, &path) {
        Ok(p) => p,
        Err(e) => return Err(e),
    };

    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }

    fs::write(&resolved, &content).map_err(|e| format!("write {}: {}", resolved.display(), e))?;

    Ok(WriteScriptResult {
        valid: true,
        path: Some(resolved.to_string_lossy().to_string()),
        error: None,
        node_count: nodes.len(),
    })
}

// ============================================================================
// Manifest commands (recursive segment manifest backend)
// ============================================================================

/// Render (or reuse) a recursive segment manifest for `script_path` (relative
/// to `agent_dir`). Runs on a blocking thread; idempotent via freshness hash.
///
/// Emits `render-manifest-progress` events (carrying `script`, `step`,
/// `total`, `label`) as each speakable node renders, and drives an ongoing
/// native "Rendering…" notification. Both are cleared when the render
/// finishes (success or failure). The frontend filters progress events by
/// `script` so concurrent renders don't cross-feed.
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

    // Set up the native notification up front so it's visible during the
    // whole render. Best-effort: failures here must not break the render.
    render_notify::ensure_channel(&app);
    render_notify::request_permission_best_effort(&app);
    render_notify::show_render_progress(&app, &display_title, 0, 0);

    // Progress tracker: each tick emits a Tauri event (for the in-app bar)
    // and throttles a notification body update. The total is seeded lazily
    // inside the walker as it parses each file (see render_manifest_file).
    let progress_app = app.clone();
    let progress_script = script_path.clone();
    let notify_throttle = Arc::new(render_notify::RenderNotifyThrottle::new());
    let notify_app = app.clone();
    let notify_title = display_title.clone();
    let progress_callback = Box::new(move |step: usize, total: usize, label: &str| {
        let _ = progress_app.emit(
            "render-manifest-progress",
            serde_json::json!({
                "script": progress_script,
                "step": step,
                "total": total,
                "label": label,
            }),
        );
        notify_throttle.maybe_update(&notify_app, &notify_title, step, total);
    });

    let result = tauri::async_runtime::spawn_blocking(move || {
        let tracker = Arc::new(std::sync::Mutex::new(audio_renderer::ProgressTracker {
            step: 0,
            total: 0,
            callback: progress_callback,
        }));
        let mut guard = renderer_arc.lock();
        let renderer = guard
            .as_mut()
            .ok_or_else(|| "Model not loaded. Please load the model first.".to_string())?;
        renderer
            .render_manifest(&script_path, &agent_dir, &tracks_dir, Some(&tracker))
            .map_err(|e| format!("Render error: {:#}", e))
    })
    .await
    .map_err(|e| e.to_string())?;

    // Whether the render succeeded or failed, tear down the notification so
    // it doesn't linger forever.
    render_notify::clear_render_progress(&app);
    result
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

/// Compute the next `count` fire times for a 5-field cron expression.
///
/// Returns RFC 3339 strings. If the expression is invalid or produces
/// fewer matches, returns a shorter (or empty) vec.
#[tauri::command]
fn next_cron_times(expr: &str, count: usize) -> Vec<String> {
    use chrono::Utc;
    use cron::Schedule as CronSchedule;
    use std::str::FromStr;

    let Ok(schedule) = CronSchedule::from_str(expr) else {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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

            app.manage(AppState {
                data_dir,
                agent_dir,
                state_dir,
                model_dir,
                tracks_dir,
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
            // Agent / bash / file commands
            bash::exec_bash,
            bash::read_data_file,
            bash::write_data_file,
            bash::edit_data_file,
            bash::list_data_files,
            bash::read_prompt,
            bash::list_prompt_files,
            // Subagent commands
            write_script,
            get_data_dir,
            get_agent_dir,
            // Onboarding: has a framework been imported?
            framework_installed,
            // Package import
            package_import::import_package,
            // App-data reset (preserves model/ + API keys)
            reset_app_data,
            // Cron computation for routine scheduling
            next_cron_times,
            // Inventory (SQLite-backed)
            inventory::inventory_list_items,
            inventory::inventory_add_item,
            inventory::inventory_update_item,
            inventory::inventory_remove_item,
            inventory::inventory_list_wishlist,
            inventory::inventory_add_wishlist_item,
            inventory::inventory_update_wishlist_item,
            inventory::inventory_remove_wishlist_item,
            // Activity (SQLite-backed)
            activity_db::activity_list_entries,
            activity_db::activity_get_entry,
            activity_db::activity_log_entry,
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
