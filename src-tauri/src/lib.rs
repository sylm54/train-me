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
mod model_downloader;
mod package_import;
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
/// `state_dir`     = `<app_data>/state` — app-managed state (chastity,
///                    inventory) that the agent must not touch
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
    pub inventory_db: Mutex<rusqlite::Connection>,
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
/// - `inventory.db` — items + wishlist tables dropped & recreated
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

    // 4. Inventory — drop & recreate the tables on the held connection.
    //    (We can't delete the DB file: the rusqlite connection in
    //    AppState keeps it open, and on Windows that locks the file.)
    {
        let conn = state.inventory_db.lock();
        inventory::reset_db(&conn)?;
    }
    report.inventory = true;

    // 5. Agent feature data — wipe the writable scratch space, skipping
    //    `activity.db*` (the sandbox's Turso engine owns those at runtime;
    //    we reset the log through the sandbox in step 6 instead).
    wipe_agent_data(&state.agent_dir)?;
    bash::ensure_agent_dir(&state.data_dir).map_err(|e| e.to_string())?;
    report.agent_data = true;

    // 6. Activity log — route through the bash sandbox so Turso (the
    //    sole runtime engine for `activity.db`) performs the wipe. We only
    //    clear the rows: Turso refuses direct writes to its internal
    //    `sqlite_sequence` table, so the autoincrement counter is left
    //    as-is (purely cosmetic — ids simply continue from where they
    //    left off rather than restarting at 1).
    let res = state
        .bash
        .exec("sqlite activity.db \"DELETE FROM activity;\"")
        .await?;
    if res.exit_code != 0 {
        let msg = res.stderr.trim();
        return Err(if msg.is_empty() {
            format!("activity reset exited {}", res.exit_code)
        } else {
            msg.to_string()
        });
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
/// the bash sandbox (see [`reset_app_data`]) because Turso holds them open
/// at runtime.
fn wipe_agent_data(agent_dir: &std::path::Path) -> Result<(), String> {
    if !agent_dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(agent_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // activity.db (+ any -wal/-shm sidecars) is owned by the sandbox's
        // Turso engine at runtime; reset it via the sandbox instead.
        if name_str == "activity.db" || name_str.starts_with("activity.db-") {
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

            // Initialize app-managed SQLite DBs. Inventory lives in
            // state/ (agent-unreachable) and is owned by a libsqlite3
            // connection here. Activity lives inside the agent sandbox
            // (`agent_dir/activity.db`) and is accessed solely through the
            // embedded Turso `sqlite` builtin (by both the agent and the
            // UI commands), so it has no persistent connection here — we
            // only bootstrap its schema once with a transient connection.
            let inventory_db = inventory::init_db(&state_dir.join("inventory.db"))
                .expect("failed to init inventory.db");
            activity_db::ensure_schema(&agent_dir.join("activity.db"))
                .expect("failed to init activity.db schema");

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
                inventory_db: Mutex::new(inventory_db),
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
