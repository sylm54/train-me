use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

mod audio_renderer;
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
/// `model_dir` = `<app_data>/model`
/// `tracks_dir` = `<app_data>/tracks`
pub struct AppState {
    pub model_dir: PathBuf,
    pub tracks_dir: PathBuf,
    pub renderer: Arc<Mutex<Option<audio_renderer::AudioRenderer>>>,
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
    let renderer_arc = state.renderer.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Ensure output directory exists
        fs::create_dir_all(&tracks_dir).map_err(|e| e.to_string())?;

        // Parse tags
        let nodes = tag_parser::parse(&req.text).map_err(|e| format!("Parse error: {}", e))?;
        if nodes.is_empty() {
            return Err("No content to synthesize".to_string());
        }

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

            let model_dir = data_dir.join("model");
            let tracks_dir = data_dir.join("tracks");

            // Ensure they exist
            std::fs::create_dir_all(&model_dir).ok();
            std::fs::create_dir_all(&tracks_dir).ok();

            log::info!("Model dir: {:?}", model_dir);
            log::info!("Tracks dir: {:?}", model_dir);

            app.manage(AppState {
                model_dir,
                tracks_dir,
                renderer: Arc::new(Mutex::new(None)),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_model_status,
            download_model,
            load_model,
            synthesize,
            list_tracks,
            get_track_audio,
            delete_track,
            get_sound_names,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
