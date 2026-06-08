//! Model downloader for Supertone/supertonic-3 from HuggingFace.
//!
//! Downloads ONNX model files and voice style JSON files to the app data directory.

use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

const HF_REPO: &str = "Supertone/supertonic-3";
const HF_BASE_URL: &str = "https://huggingface.co";

/// Model files that must be downloaded from the `onnx/` directory.
const MODEL_FILES: &[&str] = &[
    "onnx/duration_predictor.onnx",
    "onnx/text_encoder.onnx",
    "onnx/vector_estimator.onnx",
    "onnx/vocoder.onnx",
    "onnx/tts.json",
    "onnx/unicode_indexer.json",
];

/// Voice style JSON files from the `voice_styles/` directory.
const VOICE_STYLE_FILES: &[&str] = &[
    "voice_styles/M1.json",
    "voice_styles/M2.json",
    "voice_styles/M3.json",
    "voice_styles/M4.json",
    "voice_styles/M5.json",
    "voice_styles/F1.json",
    "voice_styles/F2.json",
    "voice_styles/F3.json",
    "voice_styles/F4.json",
    "voice_styles/F5.json",
];

/// All files that need to be downloaded.
fn all_download_files() -> Vec<&'static str> {
    let mut files: Vec<&str> = MODEL_FILES.to_vec();
    files.extend(VOICE_STYLE_FILES);
    files
}

/// Check if the model is already downloaded (all required files exist).
pub fn is_model_downloaded(model_dir: &Path) -> bool {
    for file in MODEL_FILES {
        let path = model_dir.join(file);
        if !path.exists() {
            return false;
        }
    }
    // At least one voice style should exist
    for file in VOICE_STYLE_FILES {
        if model_dir.join(file).exists() {
            return true;
        }
    }
    false
}

/// Get the list of missing model files.
pub fn missing_files(model_dir: &Path) -> Vec<String> {
    all_download_files()
        .iter()
        .filter(|f| !model_dir.join(f).exists())
        .map(|f| f.to_string())
        .collect()
}

/// Download the model from HuggingFace.
///
/// `on_progress` is called with (current_file_index, total_files, filename).
pub fn download_model<F: Fn(usize, usize, &str)>(model_dir: &Path, on_progress: F) -> Result<()> {
    let files = all_download_files();
    let total = files.len();

    fs::create_dir_all(model_dir).context("Failed to create model directory")?;

    for (i, file) in files.iter().enumerate() {
        on_progress(i, total, file);

        let local_path = model_dir.join(file);

        // Skip if already exists
        if local_path.exists() {
            continue;
        }

        // Create parent directories
        if let Some(parent) = local_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let url = format!("{}/{}/resolve/main/{}", HF_BASE_URL, HF_REPO, file);

        download_file(&url, &local_path).with_context(|| format!("Failed to download {}", file))?;
    }

    Ok(())
}

/// Download a single file with retry logic.
fn download_file(url: &str, dest: &Path) -> Result<()> {
    let max_retries = 3;
    let mut last_error = None;

    for attempt in 0..max_retries {
        match try_download(url, dest) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_error = Some(e);
                if attempt < max_retries - 1 {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
            }
        }
    }

    Err(last_error.unwrap())
}

fn try_download(url: &str, dest: &Path) -> Result<()> {
    let response = reqwest::blocking::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(600)) // 10 minute timeout for large files
        .send()
        .context("Failed to send HTTP request")?;

    if !response.status().is_success() {
        anyhow::bail!("HTTP {} for {}", response.status(), url);
    }

    let bytes = response.bytes().context("Failed to read response body")?;

    // Write to temp file first, then rename (atomic)
    let tmp_path = dest.with_extension("tmp");
    fs::write(&tmp_path, &bytes).context("Failed to write temp file")?;
    fs::rename(&tmp_path, dest).context("Failed to rename temp file")?;

    Ok(())
}

/// Get the available voice style names and their file paths.
#[cfg(test)]
pub fn list_voice_styles(model_dir: &Path) -> Vec<(String, PathBuf)> {
    VOICE_STYLE_FILES
        .iter()
        .filter_map(|f| {
            let path = model_dir.join(f);
            if path.exists() {
                let name = Path::new(f)
                    .file_stem()
                    .unwrap()
                    .to_string_lossy()
                    .to_string();
                Some((name, path))
            } else {
                None
            }
        })
        .collect()
}

/// Map speaker name from TTS tags to voice style file name.
/// Returns the style code (e.g., "M1", "F1").
pub fn speaker_to_style(speaker: &str) -> Option<&'static str> {
    match speaker {
        "male" => Some("M1"),
        "male2" => Some("M2"),
        "male3" => Some("M3"),
        "male4" => Some("M4"),
        "male5" => Some("M5"),
        "female" => Some("F1"),
        "female2" => Some("F2"),
        "female3" => Some("F3"),
        "female4" => Some("F4"),
        "female5" => Some("F5"),
        _ => None,
    }
}

/// Get the voice style file path for a given speaker name.
pub fn voice_style_path(model_dir: &Path, speaker: &str) -> Option<PathBuf> {
    speaker_to_style(speaker).map(|style| model_dir.join(format!("voice_styles/{}.json", style)))
}

/// List all available speaker names.
pub fn available_speakers() -> Vec<&'static str> {
    vec![
        "male", "male2", "male3", "male4", "male5", "female", "female2", "female3", "female4",
        "female5",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_speaker_to_style() {
        assert_eq!(speaker_to_style("male"), Some("M1"));
        assert_eq!(speaker_to_style("female"), Some("F1"));
        assert_eq!(speaker_to_style("male2"), Some("M2"));
        assert_eq!(speaker_to_style("female5"), Some("F5"));
        assert_eq!(speaker_to_style("unknown"), None);
    }

    #[test]
    fn test_available_speakers() {
        let speakers = available_speakers();
        assert!(speakers.contains(&"male"));
        assert!(speakers.contains(&"female"));
        assert_eq!(speakers.len(), 10);
    }

    #[test]
    fn test_all_download_files() {
        let files = all_download_files();
        assert!(files.contains(&"onnx/duration_predictor.onnx"));
        assert!(files.contains(&"voice_styles/M1.json"));
        assert_eq!(files.len(), 16);
    }

    #[test]
    fn test_voice_style_path() {
        let dir = Path::new("/tmp/model");
        assert_eq!(
            voice_style_path(&dir, "male"),
            Some(dir.join("voice_styles/M1.json"))
        );
        assert_eq!(voice_style_path(&dir, "unknown"), None);
    }

    #[test]
    fn test_list_voice_styles_empty() {
        let dir = Path::new("/nonexistent");
        let styles = list_voice_styles(dir);
        assert!(styles.is_empty());
    }
}
