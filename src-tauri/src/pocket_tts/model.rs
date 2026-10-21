//! The pocket-tts flow LM, generating audio chunk by chunk from a voice
//! state. Ported from pocket-tts' `rust/src/model.rs` (MIT, © Kyutai),
//! specialized to this app: the f32 CPU backend only, no voice cloning (the
//! public `without-voice-cloning` weights carry no Mimi encoder, so a voice
//! is always a predefined catalog name resolved to its exported state), and
//! downloads through the app's model cache.

use crate::pocket_tts::config::{Config, Origin};
use crate::pocket_tts::defaults;
use crate::pocket_tts::download;
use crate::pocket_tts::rng::NoiseRng;
use crate::pocket_tts::text::{TextOptions, prepare_text_prompt, split_into_best_sentences};
use crate::pocket_tts::tokenizer::{SharedTokenizer, Tokenizer};
use crate::pocket_tts::weights::{SafetensorsFile};
use anyhow::{Result, bail};
use ptts::flow_lm::{FlowLMState, StepInput};
use ptts::transformer::{LayerAttentionState, StreamingMHAState, StreamingTransformerState};
use ptts::tts_model::{TTSModel, TTSState};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::TryRecvError;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use xn::Tensor;

/// The engine's concrete quantization selector: the CPU, f32 weights.
/// `TTSModel`/`TTSState` are generic over it; the tensors themselves are
/// `Tensor<f32, CpuDevice>` (the selector's associated types).
type Backend = xn::Unquantized<f32, xn::CpuDevice>;
/// The concrete tensor backend (the `B` of `Backend`).
type Device = xn::CpuDevice;

const TOKENS_PER_SECOND_ESTIMATE: f64 = 3.0;
const GEN_SECONDS_PADDING: f64 = 2.0;
/// EOS is ignored on the first frames: before speech starts, the EOS logit of some voices can
/// cross the threshold, and a short text then ends before the word is spoken.
const MIN_FRAMES_BEFORE_EOS: usize = 6;

/// What the model load takes besides the config.
#[derive(Debug, Clone)]
pub struct LoadOptions {
    pub temperature: Option<f32>,
    pub sampler_decode_steps: usize,
    pub noise_clamp: Option<f32>,
    /// The config's `default_eos_threshold` when `None`.
    pub eos_threshold: Option<f32>,
}

impl Default for LoadOptions {
    fn default() -> Self {
        Self {
            temperature: None,
            sampler_decode_steps: defaults::DEFAULT_SAMPLER_DECODE_STEPS,
            noise_clamp: None,
            eos_threshold: None,
        }
    }
}

/// The flow LM state after a voice prompt, which every generation starts from.
pub struct VoiceState {
    transformer_state: StreamingTransformerState<f32, Device>,
}

impl VoiceState {
    /// Positions the prompt fills.
    pub fn len(&self) -> usize {
        match self.transformer_state.layer_states.first() {
            Some(LayerAttentionState::FlowLm(state)) => state.current_end,
            _ => 0,
        }
    }
}

pub struct TtsModel {
    pub config: Config,
    pub origin: Origin,
    /// The app model directory the engine's download cache lives under.
    model_dir: PathBuf,
    model: TTSModel<Backend>,
    tokenizer: Arc<Tokenizer>,
    text_options: TextOptions,
    rng: Mutex<NoiseRng>,
    num_layers: usize,
    num_kv_heads: usize,
    head_dim: usize,
}

impl TtsModel {
    /// Load the config's checkpoint. Weights, tokenizer, and voice states
    /// cache under `model_dir/pocket-tts/`; anything missing is downloaded.
    pub fn load(
        model_dir: &Path,
        config: Config,
        origin: Origin,
        options: &LoadOptions,
    ) -> Result<Self> {
        let mut weight_files = crate::pocket_tts::weights::WeightFiles::default();
        if let Some(mimi_path) = config.mimi.weights_path.as_deref() {
            if config.flow_lm.weights_path.is_none() && config.weights_path.is_none() {
                bail!(
                    "If you specify mimi.weights_path you should specify flow_lm.weights_path or weights_path"
                )
            }
            weight_files.mimi = Some(download::download_if_necessary(model_dir, mimi_path)?);
        }
        if let Some(weights_path) = config.weights_path.as_deref() {
            log::info!("Loading pocket-tts weights from {weights_path}");
            let path = match download::download_if_necessary(model_dir, weights_path) {
                Ok(path) => path,
                Err(e) => {
                    // The voice-cloning weights are gated on the Hub; the
                    // public ones need no Hub terms. A gated download fails
                    // fast (401 is not retried), so the fallback is cheap.
                    let Some(fallback) = config.weights_path_without_voice_cloning.as_deref()
                    else {
                        return Err(e);
                    };
                    log::info!("falling back to the weights without voice cloning: {e:#}");
                    download::download_if_necessary(model_dir, fallback)?
                }
            };
            weight_files.bundle = Some(path);
        } else if let Some(flow_lm_path) = config.flow_lm.weights_path.as_deref() {
            if weight_files.mimi.is_none() {
                bail!("flow_lm.weights_path needs mimi.weights_path, for the Mimi weights")
            }
            weight_files.flow_lm =
                Some(download::download_if_necessary(model_dir, flow_lm_path)?);
        } else {
            bail!("No weights_path specified for the TTSModel, the model would be uninitialized")
        }

        let lookup_table = &config.flow_lm.lookup_table;
        let tokenizer = Arc::new(Tokenizer::load(
            model_dir,
            lookup_table.n_bins,
            &lookup_table.tokenizer_path,
            &lookup_table.tokenizer,
        )?);

        // The drifting and pointwise heads map the noise in one step, whatever the number of
        // steps asked.
        let decode_steps = match config.flow_type() {
            ptts::flow_lm::FlowType::Drifting | ptts::flow_lm::FlowType::Pointwise => 1,
            ptts::flow_lm::FlowType::Lsd | ptts::flow_lm::FlowType::FlowMatching => {
                options.sampler_decode_steps
            }
        };
        if decode_steps == 0 {
            bail!("the number of sampler decode steps must be positive")
        }
        let eos_threshold = options
            .eos_threshold
            .unwrap_or(config.default_eos_threshold);
        let ptts_config = config.to_ptts(decode_steps, eos_threshold)?;
        let weights = crate::pocket_tts::weights::load(&weight_files)?;
        let model = TTSModel::<Backend>::load(
            &weights.vb,
            Box::new(SharedTokenizer(tokenizer.clone())),
            &ptts_config,
            &std::collections::HashMap::new(),
        )?;
        drop(weights);

        let temperature = options.temperature.unwrap_or(config.default_temperature);
        let transformer = &config.flow_lm.transformer;
        Ok(Self {
            model_dir: model_dir.to_path_buf(),
            num_layers: transformer.num_layers,
            num_kv_heads: transformer.num_kv_heads(),
            head_dim: transformer.head_dim(),
            text_options: TextOptions::from_config(&config),
            rng: Mutex::new(NoiseRng::new(temperature, options.noise_clamp)?),
            config,
            origin,
            model,
            tokenizer,
        })
    }

    pub fn sample_rate(&self) -> usize {
        self.config.mimi.sample_rate
    }

    /// The exported state of a predefined voice, downloaded on first use and
    /// cached on disk. The Origin must be a language checkpoint: predefined
    /// voices are per-language exports.
    pub fn get_state_for_voice(&self, name: &str) -> Result<VoiceState> {
        if !defaults::is_predefined_voice(name) {
            bail!(
                "unknown voice {name:?}; the catalog is {:?}",
                defaults::predefined_voice_names()
            )
        }
        let Origin::Language(language) = &self.origin else {
            bail!(
                "Cannot use predefined voices when the model is not loaded from a config associated with a language. Here the origin is {}",
                self.origin.display_path()
            )
        };
        let voice = defaults::get_predefined_voice(language, name);
        let path = download::download_if_necessary(&self.model_dir, &voice)?;
        self.import_state(&path)
    }

    /// Reads a voice state (a safetensors of per-layer KV caches) as the
    /// pocket-tts CLI's `export-voice` writes them.
    fn import_state(&self, path: &Path) -> Result<VoiceState> {
        let file = SafetensorsFile::open(path)?;
        let dim_per_head = self.head_dim;
        let mut layer_states = Vec::with_capacity(self.num_layers);
        for i in 0..self.num_layers {
            let module = format!("transformer.layers.{i}.self_attn");
            let cache_name = format!("{module}/cache");
            if !file.tensors.contains_key(&cache_name) {
                bail!(
                    "{} is not a voice state of this model: it has no {cache_name}",
                    path.display()
                )
            }
            let (cache, shape) = file.read_f32(&cache_name)?;
            let [2, b, capacity, h, d] = shape[..] else {
                bail!("{cache_name} has shape {shape:?}, expected [2, batch, time, heads, dim]")
            };
            if b != 1 || h != self.num_kv_heads || d != dim_per_head {
                bail!(
                    "{cache_name} has shape {shape:?}, this model needs [2, 1, _, {}, {dim_per_head}]",
                    self.num_kv_heads
                )
            }
            // States written before the offset was stored hold the position in the length of
            // `current_end`.
            let offset_name = format!("{module}/offset");
            let current_end_name = format!("{module}/current_end");
            let used = if file.tensors.contains_key(&offset_name) {
                file.read_i64(&offset_name)?.first().copied().unwrap_or(0) as usize
            } else if let Some(info) = file.tensors.get(&current_end_name) {
                info.shape.first().copied().unwrap_or(0)
            } else {
                capacity
            };
            if used > capacity {
                bail!("{offset_name} is {used}, past the {capacity} cached positions")
            }
            let per_position = h * d;
            let plane = capacity * per_position;
            let take = |start: usize| -> Result<Tensor<f32, Device>> {
                let data = cache[start..start + used * per_position].to_vec();
                Ok(Tensor::from_vec(
                    data,
                    (1, used, h, d),
                    self.model.device(),
                )?)
            };
            layer_states.push(LayerAttentionState::FlowLm(StreamingMHAState {
                k_cache: take(0)?,
                v_cache: take(plane)?,
                current_end: used,
            }));
        }
        Ok(VoiceState {
            transformer_state: StreamingTransformerState { layer_states },
        })
    }

    fn estimate_max_gen_len(&self, token_count: usize) -> usize {
        let gen_len_sec = token_count as f64 / TOKENS_PER_SECOND_ESTIMATE + GEN_SECONDS_PADDING;
        (gen_len_sec * self.config.mimi.frame_rate).ceil() as usize
    }

    /// Generate `text` from `voice`, handing decoded f32 chunks to `on_chunk`.
    /// Setting `stop` ends the generation early.
    pub fn generate_audio_stream(
        &self,
        voice: &VoiceState,
        text_to_generate: &str,
        max_tokens: usize,
        frames_after_eos: Option<usize>,
        stop: &AtomicBool,
        on_chunk: &mut (dyn FnMut(&[f32]) -> Result<()> + Send),
    ) -> Result<()> {
        let frames_after_eos = frames_after_eos.or(self.config.model_recommended_frames_after_eos);
        // This is a very simplistic way of handling long texts, as in the Python package.
        let chunks = split_into_best_sentences(
            self.tokenizer.as_ref(),
            text_to_generate,
            max_tokens,
            &self.text_options,
        )?;
        for chunk in chunks {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let (text, frames_after_eos_guess) = prepare_text_prompt(&chunk, &self.text_options)?;
            let frames = frames_after_eos.unwrap_or(frames_after_eos_guess + 2);
            self.generate_short_text(voice, &text, frames, stop, on_chunk)?;
        }
        Ok(())
    }

    fn generate_short_text(
        &self,
        voice: &VoiceState,
        text: &str,
        frames_after_eos: usize,
        stop: &AtomicBool,
        on_chunk: &mut (dyn FnMut(&[f32]) -> Result<()> + Send),
    ) -> Result<()> {
        let tokens = self.tokenizer.encode(text)?;
        let max_gen_len = self.estimate_max_gen_len(tokens.len());
        let seq_budget = voice.len() + tokens.len() + max_gen_len;
        let transformer_state = voice.transformer_state.with_seq_budget(seq_budget)?;
        let mut state = TTSState {
            flow_lm_state: FlowLMState {
                transformer_state,
                conditions: None,
            },
        };

        let t_generating = Instant::now();
        self.model.prompt_text(&mut state, &tokens)?;

        let sample_rate = self.sample_rate();
        let (latent_tx, latent_rx) = std::sync::mpsc::channel::<Option<Tensor<f32, Device>>>();
        let (generated, decoded) = std::thread::scope(|s| {
            let decoder = s.spawn(move || self.decode_worker(latent_rx, on_chunk));
            let generated = self.autoregressive_generation(
                &mut state,
                max_gen_len,
                frames_after_eos,
                &latent_tx,
                stop,
            );
            // Closes the stream, also on error, so that the decoder finishes.
            let _ = latent_tx.send(None);
            let decoded = decoder
                .join()
                .unwrap_or_else(|_| Err(anyhow::anyhow!("the decoder panicked")));
            (generated, decoded)
        });
        generated?;
        let total_samples = decoded?;

        let audio_ms = total_samples * 1000 / sample_rate;
        let generation_ms = t_generating.elapsed().as_millis().max(1) as usize;
        log::info!(
            "Generated: {audio_ms} ms of audio in {generation_ms} ms so {:.2}x faster than real-time",
            audio_ms as f64 / generation_ms as f64
        );
        Ok(())
    }

    fn autoregressive_generation(
        &self,
        state: &mut TTSState<Backend>,
        max_gen_len: usize,
        frames_after_eos: usize,
        latent_tx: &std::sync::mpsc::Sender<Option<Tensor<f32, Device>>>,
        stop: &AtomicBool,
    ) -> Result<()> {
        let mut previous: Option<Tensor<f32, Device>> = None;
        let mut eos_step = None;
        let mut reached_max_len = true;
        for generation_step in 0..max_gen_len {
            if stop.load(Ordering::Relaxed) {
                reached_max_len = false;
                break;
            }
            let input = match &previous {
                None => StepInput::Bos { batch: 1 },
                Some(latent) => StepInput::Latent(latent),
            };
            let (latent, is_eos) = {
                let mut rng = self.rng.lock().unwrap_or_else(|e| e.into_inner());
                self.model.generate_step(state, input, &mut *rng)?
            };
            if is_eos && eos_step.is_none() && generation_step >= MIN_FRAMES_BEFORE_EOS {
                eos_step = Some(generation_step);
            }
            if eos_step.is_some_and(|eos_step| generation_step >= eos_step + frames_after_eos) {
                reached_max_len = false;
                break;
            }
            // A closed channel means the decoder stopped on an error, which it reports.
            if latent_tx.send(Some(latent.clone())).is_err() {
                reached_max_len = false;
                break;
            }
            previous = Some(latent);
        }
        if reached_max_len {
            log::warn!("Maximum generation length reached without EOS");
        }
        Ok(())
    }

    /// Decodes the latents as they come, as many as are queued in one call, and hands the audio
    /// to `on_chunk`. Returns the number of samples decoded.
    fn decode_worker(
        &self,
        latent_rx: std::sync::mpsc::Receiver<Option<Tensor<f32, Device>>>,
        on_chunk: &mut (dyn FnMut(&[f32]) -> Result<()> + Send),
    ) -> Result<usize> {
        let mut mimi_state = self.model.init_mimi_state(1)?;
        // A fresh Mimi decoder state puts a small step in its first samples, heard as a click at
        // the start of every chunk: fade the first 5 ms in.
        let fade_len = self.sample_rate() / 200;
        let mut fade_in = true;
        let mut total = 0;
        while let Ok(Some(latent)) = latent_rx.recv() {
            let mut latents = vec![latent];
            let mut finished = false;
            loop {
                match latent_rx.try_recv() {
                    Ok(Some(latent)) => latents.push(latent),
                    Ok(None) | Err(TryRecvError::Disconnected) => {
                        finished = true;
                        break;
                    }
                    Err(TryRecvError::Empty) => break,
                }
            }
            let refs: Vec<&Tensor<f32, Device>> = latents.iter().collect();
            let batch = Tensor::cat(&refs, 1)?;
            let audio = self.model.decode_latent(&batch, &mut mimi_state)?;
            let mut pcm = audio.to_vec()?;
            if fade_in {
                let n = fade_len.min(pcm.len());
                for (i, sample) in pcm[..n].iter_mut().enumerate() {
                    *sample *= if fade_len > 1 {
                        i as f32 / (fade_len - 1) as f32
                    } else {
                        0.0
                    };
                }
                fade_in = false;
            }
            total += pcm.len();
            on_chunk(&pcm)?;
            if finished {
                break;
            }
        }
        Ok(total)
    }
}
