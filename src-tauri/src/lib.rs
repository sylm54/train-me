use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

mod audio_renderer;
mod bash;
mod builtins;
mod expression;
mod helper;
mod model_downloader;
mod sounds;
mod tag_parser;

// ============================================================================
// Application State
// ============================================================================

/// Managed state shared across all Tauri commands.
///
/// `data_dir`   = the app's full data directory
/// `agent_dir`  = `<app_data>/agent_data` — the agent's writable scratch
///                 space, also the bash sandbox root
/// `model_dir`  = `<app_data>/model`
/// `tracks_dir` = `<app_data>/tracks`
/// `bash`       = bashkit sandbox mounted over `agent_dir`
pub struct AppState {
    pub data_dir: PathBuf,
    pub agent_dir: PathBuf,
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

        // Render
        let duration = renderer
            .render_to_file(&nodes, &output_path)
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

/// Return a track's WAV data as a base64 data-URL.
#[tauri::command]
fn get_track_audio(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read track: {}", e))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:audio/wav;base64,{}", b64))
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
// App entrypoint
// ============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Resolve data directories
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to resolve app data directory");

            let agent_dir = data_dir.join("agent_data");
            let model_dir = data_dir.join("model");
            let tracks_dir = data_dir.join("tracks");

            // Ensure they exist
            std::fs::create_dir_all(&data_dir).ok();
            std::fs::create_dir_all(&agent_dir).ok();
            std::fs::create_dir_all(&model_dir).ok();
            std::fs::create_dir_all(&tracks_dir).ok();

            // Ensure prompts/ exists with a placeholder main_agent.md if missing.
            bash::ensure_prompts_dir(&data_dir).ok();
            // Ensure agent_data/ exists with conventional subdirs.
            bash::ensure_agent_dir(&data_dir).ok();
            seed_default_prompts(&data_dir).ok();

            log::info!("Data dir: {:?}", data_dir);
            log::info!("Agent dir: {:?}", agent_dir);
            log::info!("Model dir: {:?}", model_dir);
            log::info!("Tracks dir: {:?}", tracks_dir);

            // Build the bash sandbox scoped to the agent's writable area.
            let bash_sandbox = bash::create_bash_sandbox(&agent_dir)
                .expect("Failed to initialize bashkit sandbox");

            app.manage(AppState {
                data_dir,
                agent_dir,
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
            get_track_audio,
            delete_track,
            get_sound_names,
            // Agent / bash / file commands
            bash::exec_bash,
            bash::read_data_file,
            bash::write_data_file,
            bash::list_data_files,
            bash::read_prompt,
            bash::list_prompt_files,
            // Subagent commands
            write_script,
            get_data_dir,
            get_agent_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Write starter prompts if they're missing.
///
/// - `prompts/main_agent.md` is required for the chat view.
/// - `prompts/hypno_planner.md` and `prompts/hypno_writer.md` are required
///   for the subagent orchestration (Phase 2).
fn seed_default_prompts(data_dir: &std::path::Path) -> std::io::Result<()> {
    let main = data_dir.join("prompts").join("main_agent.md");
    if !main.exists() {
        fs::write(&main, DEFAULT_MAIN_AGENT_PROMPT)?;
    }
    let planner = data_dir.join("prompts").join("hypno_planner.md");
    if !planner.exists() {
        fs::write(&planner, DEFAULT_PLANNER_PROMPT)?;
    }
    let writer = data_dir.join("prompts").join("hypno_writer.md");
    if !writer.exists() {
        fs::write(&writer, DEFAULT_WRITER_PROMPT)?;
    }
    Ok(())
}

const DEFAULT_MAIN_AGENT_PROMPT: &str = include_str!("default_main_agent_prompt.md");
const DEFAULT_PLANNER_PROMPT: &str = include_str!("default_hypno_planner_prompt.md");
const DEFAULT_WRITER_PROMPT: &str = include_str!("default_hypno_writer_prompt.md");
