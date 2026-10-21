//! The pocket-tts checkpoint catalog and its downloader.
//!
//! Replaces the Supertone/supertonic-3 downloader. A "checkpoint" is what
//! pocket-tts calls a language config: one YAML (embedded in the binary)
//! pointing at a weights safetensors, a tokenizer, and per-voice state
//! exports on the Hugging Face Hub. The user picks which one to download;
//! files cache under `<model_dir>/pocket-tts/` (see `pocket_tts::download`)
//! and the same cache serves the engine at load time.
//!
//! The voice-cloning weights are Hub-gated, so the catalog only ever
//! downloads the public `without-voice-cloning` weights — the engine falls
//! back to those anyway at load time.

use crate::pocket_tts::{config, defaults, download};
use anyhow::Result;
use std::path::Path;

/// One selectable checkpoint in the UI.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointInfo {
    /// Config id (`"english"`, `"french_24l"`, …).
    pub id: String,
    /// Short human label (`"English"`).
    pub label: String,
    /// One-line description for the picker (size/speed/quality guidance).
    pub description: String,
    /// Rough download size of weights + tokenizer + the mapped voices.
    pub approx_bytes: u64,
    /// Needs the `tts-small-models` feature (SentencePiece tokenizer).
    pub requires_sentencepiece: bool,
    /// Whether everything this checkpoint needs is already cached.
    pub downloaded: bool,
}

/// Curated (id, label, description, weights-MB) for the English variants.
/// Weight sizes are the Hub's `x-linked-size` of the public weights file.
const CURATED: &[(&str, &str, &str, u64)] = &[
    (
        "english",
        "English",
        "The default Kyutai model. Best overall quality — the recommended pick.",
        219,
    ),
    (
        "english_18m_2026-10",
        "English · small",
        "Distilled 18M-parameter model. Roughly twice as fast, a bit flatter.",
        112,
    ),
    (
        "english_18m_refl_2026-10",
        "English · small (reward-tuned)",
        "The 18M model with reward fine-tuning.",
        112,
    ),
    (
        "english_7m_2026-10",
        "English · tiny",
        "Distilled 7M-parameter model. Fast on phones, thinner prosody.",
        66,
    ),
    (
        "english_7m_refl_2026-10",
        "English · tiny (reward-tuned)",
        "The 7M model with reward fine-tuning.",
        66,
    ),
    (
        "english_2m_2026-10",
        "English · extra tiny",
        "Smallest model (2M parameters). For low-end devices.",
        47,
    ),
    (
        "english_2m_refl_2026-10",
        "English · extra tiny (reward-tuned)",
        "The 2M model with reward fine-tuning.",
        47,
    ),
    (
        "english_drifting_26-09",
        "English · drifting sampler",
        "Same size as English; a different sampler head (experimental).",
        219,
    ),
    (
        "english_2026-04_24l",
        "English · large preview (Apr)",
        "24-layer preview model. Highest quality, ~6× the download and slower.",
        1304,
    ),
    (
        "english_2026-09_24l",
        "English · large preview (Sep)",
        "24-layer preview model. Highest quality, ~6× the download and slower.",
        1304,
    ),
    (
        "english_2026-10",
        "English (Oct)",
        "Archived English revision (same weights as the default).",
        219,
    ),
    (
        "english_2026-09_2",
        "English (Sep, rev 2)",
        "Archived English revision.",
        219,
    ),
    (
        "english_2026-09",
        "English (Sep)",
        "Archived English revision.",
        219,
    ),
    (
        "english_2026-04",
        "English (Apr)",
        "Archived English revision.",
        219,
    ),
    (
        "english_2026-01",
        "English (Jan)",
        "Archived English revision.",
        219,
    ),
];

/// Pretty names for the non-English base languages.
const LANGUAGE_LABELS: &[(&str, &str)] = &[
    ("french", "French"),
    ("german", "German"),
    ("spanish", "Spanish"),
    ("italian", "Italian"),
    ("portuguese", "Portuguese"),
    ("dutch", "Dutch"),
];

/// Label + description + weights MB for an id, falling back to generic
/// wording derived from the config name (24-layer ids are ~4× bigger).
fn metadata_for(id: &str) -> (String, String, u64) {
    if let Some((_, label, description, mb)) = CURATED.iter().find(|(key, ..)| *key == id) {
        return (label.to_string(), description.to_string(), *mb);
    }
    let base = id.trim_end_matches("_24l");
    let language = LANGUAGE_LABELS
        .iter()
        .find(|(key, _)| *key == base)
        .map(|(_, label)| label.to_string())
        .unwrap_or_else(|| base.to_string());
    if id.ends_with("_24l") {
        (
            format!("{language} · large preview"),
            "24-layer model. Higher quality, much larger download and slower.".to_string(),
            672,
        )
    } else {
        (language, "Language checkpoint.".to_string(), 219)
    }
}

/// Catalog order: recommended first, archived revisions and large previews
/// after, other languages last (base before its 24-layer variant).
pub fn catalog_order() -> Vec<String> {
    let mut ids: Vec<String> = config::available_languages()
        .into_iter()
        .map(str::to_string)
        .collect();
    fn rank(id: &str) -> u8 {
        if id == "english" {
            0
        } else if id.starts_with("english_2m")
            || id.starts_with("english_7m")
            || id.starts_with("english_18m")
        {
            1
        } else if id.starts_with("english_drifting") {
            2
        } else if id.starts_with("english_2026") && !id.contains("24l") {
            3
        } else if id.contains("24l") && id.starts_with("english") {
            4
        } else if id.contains("24l") {
            6
        } else {
            5
        }
    }
    ids.sort_by_cached_key(|id| rank(id));
    ids
}

/// The catalog the UI renders. `model_dir` decides the `downloaded` flags.
pub fn list_checkpoints(model_dir: &Path) -> Vec<CheckpointInfo> {
    catalog_order()
        .into_iter()
        .map(|id| checkpoint_info(model_dir, &id))
        .collect()
}

/// Catalog info for one checkpoint.
pub fn checkpoint_info(model_dir: &Path, id: &str) -> CheckpointInfo {
    let (label, description, weights_mb) = metadata_for(id);
    let requires_sentencepiece = config::Config::load(model_dir, Some(id), None)
        .map(|(config, _)| {
            // tokenizer references carry a "@revision" suffix.
            config
                .flow_lm
                .lookup_table
                .tokenizer_path
                .split('@')
                .next()
                .unwrap_or("")
                .ends_with(".model")
        })
        .unwrap_or(false);
    CheckpointInfo {
        id: id.to_string(),
        label,
        description,
        approx_bytes: (weights_mb + 70) * 1024 * 1024,
        requires_sentencepiece,
        downloaded: is_checkpoint_downloaded(model_dir, id),
    }
}

/// Everything a checkpoint needs on disk: the public weights, the tokenizer,
/// and the state export of every voice the speaker mapping uses.
fn checkpoint_files(model_dir: &Path, id: &str) -> Result<Vec<String>> {
    let (config, origin) = config::Config::load(model_dir, Some(id), None)?;
    let mut files = Vec::new();
    // The gated weights_path is deliberately absent: the engine falls back
    // to the public weights, so only that one is ever downloaded.
    if let Some(fallback) = config.weights_path_without_voice_cloning.as_deref() {
        files.push(fallback.to_string());
    } else if let Some(weights) = config.weights_path.as_deref() {
        files.push(weights.to_string());
    }
    files.push(config.flow_lm.lookup_table.tokenizer_path.clone());
    if let config::Origin::Language(language) = &origin {
        let mut voices: Vec<&str> = crate::pocket_tts::available_speakers()
            .iter()
            .filter_map(|speaker| crate::pocket_tts::speaker_voice_for(speaker))
            .collect();
        voices.sort_unstable();
        voices.dedup();
        for voice in voices {
            files.push(defaults::get_predefined_voice(language, voice));
        }
    }
    Ok(files)
}

/// Whether every file the checkpoint needs is cached.
pub fn is_checkpoint_downloaded(model_dir: &Path, id: &str) -> bool {
    match checkpoint_files(model_dir, id) {
        Ok(files) => files.iter().all(|f| download::is_cached(model_dir, f)),
        Err(_) => false,
    }
}

/// Missing cached files, for the status readout.
pub fn missing_files(model_dir: &Path, id: &str) -> Vec<String> {
    match checkpoint_files(model_dir, id) {
        Ok(files) => files
            .into_iter()
            .filter(|f| !download::is_cached(model_dir, f))
            .map(|f| short_name(&f))
            .collect(),
        Err(e) => vec![format!("catalog error: {e:#}")],
    }
}

/// Trim an hf:// reference to something readable in the UI.
fn short_name(file: &str) -> String {
    match file.strip_prefix("hf://") {
        Some(rest) => rest.split('@').next().unwrap_or(rest).to_string(),
        None => file.to_string(),
    }
}

/// The active checkpoint's downloaded state (settings supply the id).
pub fn is_model_downloaded(model_dir: &Path, checkpoint: &str) -> bool {
    is_checkpoint_downloaded(model_dir, checkpoint)
}

/// Download everything a checkpoint needs, reporting per-file progress via
/// `on_progress(current_file_index, total_files, name)`. Already-cached
/// files are skipped (without advancing the callback — the caller's UI is
/// computed from the missing set).
pub fn download_checkpoint<F: FnMut(usize, usize, &str)>(
    model_dir: &Path,
    id: &str,
    mut on_progress: F,
) -> Result<()> {
    let files = checkpoint_files(model_dir, id)?;
    let missing: Vec<&String> = files
        .iter()
        .filter(|f| !download::is_cached(model_dir, f))
        .collect();
    let total = missing.len();
    for (i, file) in missing.iter().enumerate() {
        on_progress(i, total, &short_name(file));
        download::ensure_downloaded(model_dir, file)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_model_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tm-checkpoint-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn catalog_lists_every_embedded_config_with_metadata() {
        let dir = tmp_model_dir("catalog");
        let catalog = list_checkpoints(&dir);
        assert_eq!(catalog.len(), config::available_languages().len());
        assert_eq!(catalog[0].id, "english");
        let english = &catalog[0];
        assert_eq!(english.label, "English");
        assert!(english.approx_bytes > 200 * 1024 * 1024);
        assert!(!english.downloaded);
        assert!(!english.requires_sentencepiece);

        let tiny = catalog
            .iter()
            .find(|c| c.id == "english_2m_2026-10")
            .expect("tiny model in catalog");
        assert!(tiny.approx_bytes < 150 * 1024 * 1024);
        #[cfg(feature = "tts-small-models")]
        assert!(tiny.requires_sentencepiece);

        // Curated metadata covers every English variant; the rest get labels.
        for entry in &catalog {
            assert!(!entry.label.is_empty(), "{} has no label", entry.id);
            assert!(!entry.description.is_empty(), "{} has no description", entry.id);
            assert!(entry.approx_bytes > 0);
        }
    }

    #[test]
    fn checkpoint_files_cover_weights_tokenizer_and_voices() {
        let dir = tmp_model_dir("files");
        let files = checkpoint_files(&dir, "english").unwrap();
        // 1 weights + 1 tokenizer + 10 voice exports (the mapping is 1:1).
        assert_eq!(files.len(), 12, "{files:?}");
        assert!(files.iter().all(|f| f.contains("without-voice-cloning")));
        // The gated weights are never in the download set.
        assert!(!files
            .iter()
            .any(|f| f.starts_with("hf://kyutai/pocket-tts/")));
    }

    #[test]
    fn missing_files_is_empty_when_downloaded() {
        let dir = tmp_model_dir("missing");
        let id = "english";
        assert!(!missing_files(&dir, id).is_empty());
        for file in checkpoint_files(&dir, id).unwrap() {
            download::install_stub(&dir, &file);
        }
        let missing = missing_files(&dir, id);
        assert!(missing.is_empty(), "still missing: {missing:?}");
        assert!(is_model_downloaded(&dir, id));
    }

    #[test]
    fn curated_order_puts_english_first_and_previews_last() {
        let ids = catalog_order();
        assert_eq!(ids[0], "english");
        let previews: Vec<usize> = ids
            .iter()
            .enumerate()
            .filter(|(_, id)| id.contains("24l") && id.starts_with("english"))
            .map(|(i, _)| i)
            .collect();
        assert!(previews.iter().all(|i| *i >= ids.len() / 2));
    }
}
