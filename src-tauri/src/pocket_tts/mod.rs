//! Kyutai pocket-tts speech synthesis engine.
//!
//! A port of the engine side of [pocket-tts](https://github.com/kyutai-labs/pocket-tts)'s
//! standalone Rust binary (MIT, © Kyutai), adapted to train-me: the f32 CPU
//! backend only, downloads through the app's model cache, no voice cloning
//! (the public weights carry no Mimi encoder), and a fixed mapping from the
//! TTS markup's speaker names to the pocket-tts voice catalog.
//!
//! Checkpoints ("languages" in pocket-tts terms) are swappable at runtime:
//! the embedded configs carry the whole catalog, the checkpoint files are
//! downloaded on demand (pre-fetched by `model_downloader`), and the engine
//! is rebuilt when the active checkpoint changes.

pub mod config;
pub mod download;
// Vendored near-verbatim from upstream; a few of its catalog helpers are
// unused here but kept for parity.
#[allow(dead_code)]
pub mod defaults;
pub mod model;
pub mod rng;
pub mod text;
pub mod tokenizer;
pub mod weights;

use anyhow::{Context, Result};
use model::{LoadOptions, TtsModel, VoiceState};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;


/// Threads for the tensor operations. The model is small enough that more
/// threads cost more to dispatch than they save: four were fastest on the
/// machines pocket-tts measured (see its `main.rs`).
const DEFAULT_NUM_THREADS: usize = 4;

/// The catalog voices a speaker name maps to. Kept to the public
/// `kyutai/tts-voices` catalog (English voices, plus the per-language
/// defaults), so every voice works with every checkpoint.
fn speaker_to_voice(speaker: &str) -> Option<&'static str> {
    match speaker {
        "male" => Some("marius"),
        "male2" => Some("george"),
        "male3" => Some("paul"),
        "male4" => Some("charles"),
        "male5" => Some("stuart_bell"),
        "female" => Some("alba"),
        "female2" => Some("anna"),
        "female3" => Some("jane"),
        "female4" => Some("mary"),
        "female5" => Some("cosette"),
        _ => None,
    }
}

/// The catalog voice behind a speaker name, for callers outside this module
/// (the checkpoint downloader pre-fetches these voices' state exports).
pub fn speaker_voice_for(speaker: &str) -> Option<&'static str> {
    speaker_to_voice(speaker)
}

/// All available speaker names (the TTS markup vocabulary).
pub fn available_speakers() -> Vec<&'static str> {
    vec![
        "male", "male2", "male3", "male4", "male5", "female", "female2", "female3", "female4",
        "female5",
    ]
}

/// The loaded engine: the checkpoint's model plus one voice state per
/// speaker already spoken in this renderer's lifetime. Renders are
/// sequential per renderer instance, so plain `HashMap` state is safe.
pub struct PocketTtsEngine {
    model: TtsModel,
    /// Cached voice states keyed by speaker name.
    voices: HashMap<String, VoiceState>,
    sample_rate: u32,
}

impl PocketTtsEngine {
    /// Load a checkpoint by id (`"english"`, `"french_24l"`, …). Downloads
    /// whatever is missing into `model_dir/pocket-tts/` — voice states
    /// included, on first use per voice.
    pub fn load(model_dir: &Path, checkpoint: &str) -> Result<Self> {
        // 4 threads beat 1 and 8 on pocket-tts' measurements; leave a core
        // for the app when the machine is small.
        let cpus = std::thread::available_parallelism().map_or(1, |n| n.get());
        xn::set_num_threads(DEFAULT_NUM_THREADS.min(cpus));
        let (config, origin) = config::Config::load(model_dir, Some(checkpoint), None)
            .with_context(|| format!("unknown checkpoint {checkpoint:?}"))?;
        let model = TtsModel::load(model_dir, config, origin, &LoadOptions::default())
            .with_context(|| format!("failed to load checkpoint {checkpoint:?}"))?;
        let sample_rate = model.sample_rate() as u32;
        Ok(Self {
            model,
            voices: HashMap::new(),
            sample_rate,
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Synthesize `text` in `speaker`'s voice to mono f32 samples at the
    /// engine's sample rate.
    pub fn synthesize(&mut self, text: &str, speaker: &str) -> Result<Vec<f32>> {
        let voice_name = speaker_to_voice(speaker)
            .ok_or_else(|| anyhow::anyhow!("Unknown speaker: {}", speaker))?;
        if !self.voices.contains_key(speaker) {
            let state = self
                .model
                .get_state_for_voice(voice_name)
                .with_context(|| format!("failed to load voice {voice_name:?} for {speaker:?}"))?;
            self.voices.insert(speaker.to_string(), state);
        }
        let voice = self.voices.get(speaker).expect("just inserted");

        let mut samples = Vec::new();
        {
            let mut on_chunk = |pcm: &[f32]| -> Result<()> {
                samples.extend_from_slice(pcm);
                Ok(())
            };
            self.model.generate_audio_stream(
                voice,
                text,
                defaults::MAX_TOKEN_PER_CHUNK,
                None,
                &AtomicBool::new(false),
                &mut on_chunk,
            )?;
        }
        Ok(samples)
    }

    /// Warm a voice's state (downloads its embedding on first use) without
    /// synthesizing anything. Checkpoint downloads pre-fetch the mapped
    /// voices; this covers a first render that skipped the pre-fetch.
    pub fn warm_voice(&mut self, speaker: &str) -> Result<()> {
        let voice_name = speaker_to_voice(speaker)
            .ok_or_else(|| anyhow::anyhow!("Unknown speaker: {}", speaker))?;
        if self.voices.contains_key(speaker) {
            return Ok(());
        }
        let state = self
            .model
            .get_state_for_voice(voice_name)
            .with_context(|| format!("failed to load voice {voice_name:?} for {speaker:?}"))?;
        self.voices.insert(speaker.to_string(), state);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn every_speaker_maps_into_the_catalog() {
        for speaker in available_speakers() {
            let voice = speaker_to_voice(speaker).expect("mapped");
            assert!(
                defaults::is_predefined_voice(voice),
                "{voice} is not a predefined voice"
            );
        }
        assert!(speaker_to_voice("narrator").is_none());
        assert_eq!(available_speakers().len(), 10);
    }

    #[test]
    fn unknown_checkpoint_lists_alternatives() {
        let err = config::Config::load(Path::new("/x"), Some("nope"), None).unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("Available languages"), "{msg}");
    }

    /// Full pass: download the checkpoint (weights + tokenizer + voices),
    /// load the engine, render the static test script, check the audio.
    /// Skips unless TRAIN_ME_MODEL_DIR points somewhere writable; set
    /// TRAIN_ME_DOWNLOAD=1 to let it download what's missing.
    #[test]
    fn render_test_script_end_to_end() {
        let model_dir = std::env::var_os("TRAIN_ME_MODEL_DIR")
            .map(PathBuf::from)
            .unwrap_or_default();
        let checkpoint =
            std::env::var("TRAIN_ME_TTS_CHECKPOINT").unwrap_or_else(|_| "english".into());
        if !crate::model_downloader::is_model_downloaded(&model_dir, &checkpoint) {
            if std::env::var_os("TRAIN_ME_DOWNLOAD").is_none() {
                eprintln!(
                    "skipping: checkpoint {checkpoint:?} not under {} (set TRAIN_ME_DOWNLOAD=1 to fetch)",
                    model_dir.display()
                );
                return;
            }
            crate::model_downloader::download_checkpoint(&model_dir, &checkpoint, |i, n, f| {
                eprintln!("[{}/{}] {f}", i + 1, n);
            })
            .expect("download checkpoint");
        }

        let mut engine = PocketTtsEngine::load(&model_dir, &checkpoint).expect("load engine");
        assert_eq!(engine.sample_rate(), 24000);

        // Warm both mapped voices of the test script, then synthesize a
        // sentence and check the output is real speech-shaped audio.
        engine.warm_voice("female").expect("warm female");
        let samples = engine
            .synthesize("Welcome to train-me. This voice was rendered locally.", "female")
            .expect("synthesize");
        let seconds = samples.len() as f32 / engine.sample_rate() as f32;
        assert!(seconds > 1.5, "only {seconds}s of audio");
        let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.05, "waveform is near-silent (peak {peak})");
    }

    /// The onboarding test script (the one `render_test_track` serves)
    /// parses and renders end-to-end through the full renderer — voices,
    /// speeds, pauses, background tones, the echo effect, the looped
    /// overlay and the random branch. Skips like the test above.
    #[test]
    fn onboarding_test_script_renders_end_to_end() {
        let model_dir = std::env::var_os("TRAIN_ME_MODEL_DIR")
            .map(PathBuf::from)
            .unwrap_or_default();
        let checkpoint =
            std::env::var("TRAIN_ME_TTS_CHECKPOINT").unwrap_or_else(|_| "english".into());
        if !crate::model_downloader::is_model_downloaded(&model_dir, &checkpoint) {
            eprintln!("skipping: checkpoint {checkpoint:?} not downloaded");
            return;
        }
        let nodes = crate::tag_parser::parse(crate::TTS_TEST_SCRIPT).expect("parse test script");
        let nodes = crate::audio_renderer::resolve_includes(nodes, &model_dir);
        assert!(!nodes.is_empty());

        let mut renderer =
            crate::audio_renderer::AudioRenderer::new(&model_dir, &checkpoint).expect("engine");
        let out = model_dir.join("tts_test_script.wav");
        let start = std::time::Instant::now();
        let seconds = renderer
            .render_to_file(&nodes, &out)
            .expect("render test script");
        let render_ms = start.elapsed().as_millis();
        eprintln!(
            "test script: {seconds:.1}s of audio in {render_ms} ms ({:.1}x realtime)",
            seconds / (render_ms as f32 / 1000.0)
        );
        assert!(seconds > 10.0, "only {seconds}s rendered");
        assert!(out.exists() && out.metadata().unwrap().len() > 100_000);
        if std::env::var_os("TRAIN_ME_KEEP_WAV").is_none() {
            let _ = std::fs::remove_file(&out);
        }
    }
}
