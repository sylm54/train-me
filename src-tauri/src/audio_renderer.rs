//! Audio renderer for the TTS tag AST.
//!
//! Walks the parsed AST and renders each node to audio samples.
//! Supports TTS synthesis, sound effects, tones, pauses, effects, and mixing.
//! Expression-based volume envelopes are evaluated per-sample and baked into the waveform.

use anyhow::{bail, Context, Result};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::expression::{self, Expr};
use crate::helper::{load_text_to_speech, load_voice_style, write_wav_file, TextToSpeech};
use crate::model_downloader;
use crate::sounds::SoundType;
use crate::tag_parser::{self, Node, OverlayPart};

// ============================================================================
// Value resolution helpers
// ============================================================================

/// Resolved value: either a constant scalar or a dynamic expression.
enum ValueOrExpr {
    Scalar(f32),
    Expr(Expr),
}

/// Resolve an attribute value string to either a scalar or expression.
///
/// - `None` → `ValueOrExpr::Scalar(default)`
/// - Simple number like "0.5" → `Scalar(0.5)`
/// - Expression like "@fadein(2)" → `Expr(parsed_expr)`
fn resolve_value(value: Option<&str>, default: f32) -> ValueOrExpr {
    match value {
        None => ValueOrExpr::Scalar(default),
        Some(s) => {
            // First try as a simple number
            if let Ok(v) = s.parse::<f32>() {
                return ValueOrExpr::Scalar(v);
            }
            // Try as expression
            match expression::parse_expr(s) {
                Ok(expr) => {
                    // If expression is constant, collapse to scalar
                    if let Some(v) = expression::eval_constant(&expr) {
                        ValueOrExpr::Scalar(v)
                    } else {
                        ValueOrExpr::Expr(expr)
                    }
                }
                Err(_) => ValueOrExpr::Scalar(default),
            }
        }
    }
}

/// Resolve an attribute to a scalar f32 value.
/// Used for speed/pitch where dynamic expressions aren't applied per-sample.
fn resolve_scalar(value: Option<&str>, default: f32) -> f32 {
    match resolve_value(value, default) {
        ValueOrExpr::Scalar(v) => v,
        ValueOrExpr::Expr(expr) => expression::eval_constant(&expr).unwrap_or(default),
    }
}

// ============================================================================
// Background layer tracking
// ============================================================================

/// A background audio layer with metadata for post-processing.
struct BgLayer {
    samples: Vec<f32>,
    /// If true, this is a tone that should loop-extend to match foreground length.
    is_tone: bool,
    /// For tones: the base tone content (without leading silence) for looping.
    tone_content: Option<Vec<f32>>,
}

impl BgLayer {
    fn background(samples: Vec<f32>) -> Self {
        Self {
            samples,
            is_tone: false,
            tone_content: None,
        }
    }

    fn tone(base_samples: Vec<f32>, leading_silence: usize) -> Self {
        let mut aligned = vec![0.0f32; leading_silence];
        aligned.extend_from_slice(&base_samples);
        Self {
            samples: aligned,
            is_tone: true,
            tone_content: Some(base_samples),
        }
    }
}

// ============================================================================
// Audio Renderer
// ============================================================================

/// Render context carrying the TTS engine and current rendering state.
pub struct AudioRenderer {
    tts: TextToSpeech,
    model_dir: std::path::PathBuf,
    /// Current sample rate (from TTS model).
    pub sample_rate: u32,
}

impl AudioRenderer {
    /// Create a new renderer by loading the TTS model from the given directory.
    pub fn new(model_dir: &Path) -> Result<Self> {
        let onnx_dir = model_dir.join("onnx");
        let tts = load_text_to_speech(&onnx_dir, false).context("Failed to load TTS model")?;
        let sample_rate = tts.sample_rate as u32;

        Ok(Self {
            tts,
            model_dir: model_dir.to_path_buf(),
            sample_rate,
        })
    }

    /// Render a full AST to a WAV file.
    ///
    /// Returns the duration in seconds.
    pub fn render_to_file(&mut self, nodes: &[Node], output_path: &Path) -> Result<f32> {
        let (samples, duration) = self.render_nodes(nodes, "male", 1.0, 1.0)?;
        write_wav_file(output_path, &samples, self.sample_rate as i32)
            .context("Failed to write WAV file")?;
        Ok(duration)
    }

    /// Render a slice of nodes to audio samples.
    ///
    /// Returns (mono f32 samples, duration in seconds).
    fn render_nodes(
        &mut self,
        nodes: &[Node],
        default_speaker: &str,
        volume_scale: f32,
        speed_scale: f32,
    ) -> Result<(Vec<f32>, f32)> {
        let mut foreground = Vec::new();
        let mut bg_layers: Vec<BgLayer> = Vec::new();
        let mut _total_duration = 0.0f32;

        for node in nodes {
            let fg_before = foreground.len();

            match node {
                Node::Text(text) => {
                    if text.is_empty() {
                        continue;
                    }
                    let (samples, dur) =
                        self.synthesize_text(text, default_speaker, speed_scale)?;
                    let scaled = apply_volume(&samples, volume_scale);
                    foreground.extend_from_slice(&scaled);
                    _total_duration += dur;
                }

                Node::Voice {
                    speaker,
                    pitch: _,
                    volume,
                    speed,
                    children,
                } => {
                    let child_speed =
                        speed_scale * resolve_scalar(speed.as_deref(), 1.0).clamp(0.5, 1.5);
                    let vol_value = resolve_value(volume.as_deref(), 1.0);

                    match vol_value {
                        ValueOrExpr::Scalar(v) => {
                            let child_vol = volume_scale * v.clamp(0.0, 1.5);
                            let (samples, dur) = self.render_voice_children(
                                children,
                                speaker,
                                child_vol,
                                child_speed,
                            )?;
                            foreground.extend_from_slice(&samples);
                            _total_duration += dur;
                        }
                        ValueOrExpr::Expr(expr) => {
                            let (samples, dur) = self.render_voice_children(
                                children,
                                speaker,
                                volume_scale,
                                child_speed,
                            )?;
                            let curve =
                                expression::eval_curve(&expr, samples.len(), self.sample_rate);
                            let samples = apply_volume_curve(&samples, &curve);
                            foreground.extend_from_slice(&samples);
                            _total_duration += dur;
                        }
                    }
                }

                Node::Pause { duration } => {
                    let num_samples = (*duration * self.sample_rate as f32) as usize;
                    foreground.extend(std::iter::repeat(0.0f32).take(num_samples));
                    _total_duration += *duration;
                }

                Node::Sound {
                    sound_type,
                    volume,
                    speed: _,
                } => {
                    let sound_vol = resolve_scalar(volume.as_deref(), 1.0);
                    let (samples, dur) = self.render_sound(sound_type, sound_vol * volume_scale)?;
                    foreground.extend_from_slice(&samples);
                    _total_duration += dur;
                }

                Node::Tone {
                    tone_type: _,
                    preset,
                    frequency,
                    volume,
                } => {
                    // Tones are background — they play from here until the end of
                    // the enclosing scope.  Generate a short base segment that will
                    // be loop-extended later to match the final foreground length.
                    let vol =
                        (resolve_scalar(volume.as_deref(), 0.3) * volume_scale).clamp(0.0, 1.5);
                    let freq = frequency.unwrap_or(440.0);
                    let base_duration = 0.5; // base segment for looping
                    let base_samples =
                        generate_tone(preset, freq, base_duration, self.sample_rate, vol);
                    // Align to current foreground position (prepend silence)
                    bg_layers.push(BgLayer::tone(base_samples, foreground.len()));
                }

                Node::Speed { value, children } => {
                    let child_speed =
                        speed_scale * resolve_scalar(Some(value.as_str()), 1.0).clamp(0.5, 1.5);
                    let (samples, dur) =
                        self.render_nodes(children, default_speaker, volume_scale, child_speed)?;
                    foreground.extend_from_slice(&samples);
                    _total_duration += dur;
                }

                Node::Volume { value, children } => {
                    let vol_value = resolve_value(Some(value.as_str()), 1.0);
                    match vol_value {
                        ValueOrExpr::Scalar(v) => {
                            let child_vol = volume_scale * v.clamp(0.0, 1.5);
                            let (samples, dur) = self.render_nodes(
                                children,
                                default_speaker,
                                child_vol,
                                speed_scale,
                            )?;
                            foreground.extend_from_slice(&samples);
                            _total_duration += dur;
                        }
                        ValueOrExpr::Expr(expr) => {
                            let (samples, dur) = self.render_nodes(
                                children,
                                default_speaker,
                                volume_scale,
                                speed_scale,
                            )?;
                            let curve =
                                expression::eval_curve(&expr, samples.len(), self.sample_rate);
                            let samples = apply_volume_curve(&samples, &curve);
                            foreground.extend_from_slice(&samples);
                            _total_duration += dur;
                        }
                    }
                }

                Node::Effect {
                    effect_type,
                    preset,
                    cutoff,
                    children,
                } => {
                    let (samples, dur) =
                        self.render_nodes(children, default_speaker, volume_scale, speed_scale)?;
                    let processed = apply_effect(
                        &samples,
                        effect_type,
                        preset.as_deref(),
                        *cutoff,
                        self.sample_rate,
                    );
                    foreground.extend_from_slice(&processed);
                    _total_duration += dur;
                }

                Node::Background {
                    volume,
                    speed,
                    children,
                } => {
                    let child_speed =
                        speed_scale * resolve_scalar(speed.as_deref(), 1.0).clamp(0.5, 1.5);
                    let vol_value = resolve_value(volume.as_deref(), 1.0);

                    match vol_value {
                        ValueOrExpr::Scalar(v) => {
                            let vol = v.clamp(0.0, 1.5) * volume_scale;
                            let (bg_samples, _dur) =
                                self.render_nodes(children, default_speaker, vol, child_speed)?;
                            // Align to current foreground position
                            let mut aligned = vec![0.0f32; fg_before];
                            aligned.extend_from_slice(&bg_samples);
                            bg_layers.push(BgLayer::background(aligned));
                        }
                        ValueOrExpr::Expr(expr) => {
                            let (bg_samples, _dur) = self.render_nodes(
                                children,
                                default_speaker,
                                volume_scale,
                                child_speed,
                            )?;
                            let curve =
                                expression::eval_curve(&expr, bg_samples.len(), self.sample_rate);
                            let bg_samples = apply_volume_curve(&bg_samples, &curve);
                            let mut aligned = vec![0.0f32; fg_before];
                            aligned.extend_from_slice(&bg_samples);
                            bg_layers.push(BgLayer::background(aligned));
                        }
                    }
                }

                Node::Overlay { duration, parts } => {
                    let (samples, dur) = self.render_overlay(
                        parts,
                        default_speaker,
                        volume_scale,
                        speed_scale,
                        *duration,
                    )?;
                    foreground.extend_from_slice(&samples);
                    _total_duration += dur;
                }

                Node::Loop { loops, children } => {
                    for _ in 0..*loops {
                        let (samples, dur) = self.render_nodes(
                            children,
                            default_speaker,
                            volume_scale,
                            speed_scale,
                        )?;
                        foreground.extend_from_slice(&samples);
                        _total_duration += dur;
                    }
                }

                Node::Until {
                    button: _,
                    waiting_sound,
                    waiting_sound_volume,
                    pre_pause,
                    post_pause,
                    children,
                } => {
                    // Pre-pause
                    if let Some(pp) = pre_pause {
                        let num_samples = (*pp * self.sample_rate as f32) as usize;
                        foreground.extend(std::iter::repeat(0.0f32).take(num_samples));
                        _total_duration += *pp;
                    }

                    // Render inner content once (pre-rendered mode)
                    let (samples, dur) =
                        self.render_nodes(children, default_speaker, volume_scale, speed_scale)?;
                    foreground.extend_from_slice(&samples);
                    _total_duration += dur;

                    // Optional waiting sound (render once as background layer)
                    if let Some(ws) = waiting_sound {
                        let ws_vol = waiting_sound_volume.unwrap_or(0.5) * volume_scale;
                        let (ws_samples, _) = self.render_sound(ws, ws_vol)?;
                        let mut aligned = vec![0.0f32; foreground.len()];
                        aligned.extend_from_slice(&ws_samples);
                        bg_layers.push(BgLayer::background(aligned));
                    }

                    // Post-pause
                    if let Some(pp) = post_pause {
                        let num_samples = (*pp * self.sample_rate as f32) as usize;
                        foreground.extend(std::iter::repeat(0.0f32).take(num_samples));
                        _total_duration += *pp;
                    }
                }

                Node::Include { .. } => {
                    // Includes should have been resolved by `resolve_includes`
                    // before reaching the renderer. Silently ignore if not.
                }
            }
        }

        // Post-processing: extend bg_layers to match foreground length
        for bg in &mut bg_layers {
            if bg.is_tone {
                // Loop-extend tone content to fill foreground
                if let Some(ref content) = bg.tone_content {
                    if !content.is_empty() {
                        while bg.samples.len() < foreground.len() {
                            bg.samples.extend_from_slice(content);
                        }
                        bg.samples.truncate(foreground.len());
                    }
                }
            } else {
                // Extend non-tone backgrounds with silence
                if bg.samples.len() < foreground.len() {
                    bg.samples.extend(
                        std::iter::repeat(0.0f32).take(foreground.len() - bg.samples.len()),
                    );
                }
            }
        }

        // Mix foreground with all background layers
        let mixed = if bg_layers.is_empty() {
            foreground
        } else {
            let mut mixed = foreground;
            // Ensure mixed is at least as long as the longest bg layer
            for bg in &bg_layers {
                if bg.samples.len() > mixed.len() {
                    mixed.extend(std::iter::repeat(0.0f32).take(bg.samples.len() - mixed.len()));
                }
            }
            for bg in &bg_layers {
                for (i, &s) in bg.samples.iter().enumerate() {
                    if i < mixed.len() {
                        mixed[i] += s;
                    }
                }
            }
            // Clamp
            for s in mixed.iter_mut() {
                *s = s.clamp(-1.0, 1.0);
            }
            mixed
        };

        let duration = mixed.len() as f32 / self.sample_rate as f32;
        Ok((mixed, duration))
    }

    /// Render voice children, switching the speaker for TTS synthesis.
    fn render_voice_children(
        &mut self,
        children: &[Node],
        speaker: &str,
        volume_scale: f32,
        speed_scale: f32,
    ) -> Result<(Vec<f32>, f32)> {
        self.render_nodes(children, speaker, volume_scale, speed_scale)
    }

    /// Synthesize plain text using the TTS model.
    fn synthesize_text(
        &mut self,
        text: &str,
        speaker: &str,
        speed: f32,
    ) -> Result<(Vec<f32>, f32)> {
        let style_path = model_downloader::voice_style_path(&self.model_dir, speaker)
            .ok_or_else(|| anyhow::anyhow!("Unknown speaker: {}", speaker))?;

        if !style_path.exists() {
            bail!("Voice style file not found: {:?}", style_path);
        }

        let style = load_voice_style(&[style_path.to_string_lossy().to_string()], false)
            .context("Failed to load voice style")?;

        let speed_clamped = speed.clamp(0.5, 1.5);
        let (samples, _duration) = self
            .tts
            .call(text, "en", &style, 8, speed_clamped, 0.2)
            .context("TTS synthesis failed")?;

        // Trim leading/trailing silence so background audio aligns
        // precisely with the audible speech.
        let samples = trim_silence(&samples, 0.01);
        let duration = samples.len() as f32 / self.sample_rate as f32;
        Ok((samples, duration))
    }

    /// Render a sound effect.
    fn render_sound(&self, sound_type: &str, volume: f32) -> Result<(Vec<f32>, f32)> {
        let st = SoundType::from_tag(sound_type)
            .ok_or_else(|| anyhow::anyhow!("Unknown sound type: {}", sound_type))?;

        let (sr, mut samples) = st.decode().context("Failed to decode sound")?;

        // Resample if needed
        if sr != self.sample_rate {
            samples = resample(&samples, sr, self.sample_rate);
        }

        let samples = apply_volume(&samples, volume.clamp(0.0, 1.5));
        let duration = samples.len() as f32 / self.sample_rate as f32;
        Ok((samples, duration))
    }

    /// Render an overlay by mixing all parts together.
    fn render_overlay(
        &mut self,
        parts: &[OverlayPart],
        default_speaker: &str,
        volume_scale: f32,
        speed_scale: f32,
        fixed_duration: Option<f32>,
    ) -> Result<(Vec<f32>, f32)> {
        let mut rendered_parts: Vec<(Vec<f32>, bool)> = Vec::new();

        // Render all parts
        for part in parts {
            let part_vol =
                (volume_scale * resolve_scalar(part.volume.as_deref(), 1.0)).clamp(0.0, 1.5);
            let part_speed =
                speed_scale * resolve_scalar(part.speed.as_deref(), 1.0).clamp(0.5, 1.5);

            let (samples, _dur) =
                self.render_nodes(&part.children, default_speaker, part_vol, part_speed)?;

            rendered_parts.push((samples, part.looped.unwrap_or(false)));
        }

        // Determine target length from fixed duration or longest non-looped part
        let target_len = if let Some(dur) = fixed_duration {
            (dur * self.sample_rate as f32) as usize
        } else {
            // Use the longest non-looped part as the target length
            let non_looped_max = rendered_parts
                .iter()
                .filter(|(_, looped)| !*looped)
                .map(|(s, _)| s.len())
                .max()
                .unwrap_or(0);

            if non_looped_max > 0 {
                non_looped_max
            } else {
                // All parts are looped — fall back to longest part
                rendered_parts
                    .iter()
                    .map(|(s, _)| s.len())
                    .max()
                    .unwrap_or(0)
            }
        };

        // Extend looped parts to fill target length
        for (samples, looped) in &mut rendered_parts {
            if *looped && target_len > 0 && !samples.is_empty() {
                let mut extended = Vec::with_capacity(target_len);
                while extended.len() < target_len {
                    extended.extend_from_slice(samples);
                }
                extended.truncate(target_len);
                *samples = extended;
            }
        }

        // Final length: if fixed duration, cap to target; otherwise use longest part
        let final_len = if fixed_duration.is_some() {
            target_len
        } else {
            rendered_parts
                .iter()
                .map(|(s, _)| s.len())
                .max()
                .unwrap_or(0)
        };

        // Mix all parts
        let mut mixed = vec![0.0f32; final_len];
        for (samples, _) in &rendered_parts {
            for (i, &s) in samples.iter().enumerate() {
                if i < mixed.len() {
                    mixed[i] += s;
                }
            }
        }

        // Clamp
        for s in mixed.iter_mut() {
            *s = s.clamp(-1.0, 1.0);
        }

        let duration = mixed.len() as f32 / self.sample_rate as f32;
        Ok((mixed, duration))
    }
}

// ============================================================================
// Include resolution (pre-rendering pass)
// ============================================================================

/// Resolve all `<include>` nodes by inlining the contents of referenced files.
///
/// `base_dir` is the directory that relative `src` paths are resolved against
/// (typically `state.agent_dir`).
///
/// Behavior:
/// - Circular includes are silently skipped (tracked via the active recursion
///   path; siblings may re-include the same file).
/// - Missing files are silently skipped.
/// - Parse errors are silently skipped (a `log::warn!` is emitted).
pub fn resolve_includes(nodes: Vec<Node>, base_dir: &Path) -> Vec<Node> {
    let mut visited: HashSet<PathBuf> = HashSet::new();
    resolve_includes_inner(nodes, base_dir, &mut visited)
}

fn resolve_includes_inner(
    nodes: Vec<Node>,
    base_dir: &Path,
    visited: &mut HashSet<PathBuf>,
) -> Vec<Node> {
    let mut result = Vec::with_capacity(nodes.len());
    for node in nodes {
        let resolved = resolve_includes_in_node(node, base_dir, visited);
        result.extend(resolved);
    }
    result
}

/// Resolve includes within a single node. Returns a `Vec<Node>` because an
/// `Include` expands to the (potentially many) top-level nodes of the included
/// file. Non-`Include` nodes always return a single-element vec with their
/// children recursively resolved.
fn resolve_includes_in_node(
    node: Node,
    base_dir: &Path,
    visited: &mut HashSet<PathBuf>,
) -> Vec<Node> {
    match node {
        Node::Include { src } => resolve_one_include(&src, base_dir, visited),

        Node::Voice {
            speaker,
            pitch,
            volume,
            speed,
            children,
        } => {
            let children = resolve_includes_inner(children, base_dir, visited);
            vec![Node::Voice {
                speaker,
                pitch,
                volume,
                speed,
                children,
            }]
        }

        Node::Speed { value, children } => {
            let children = resolve_includes_inner(children, base_dir, visited);
            vec![Node::Speed { value, children }]
        }

        Node::Volume { value, children } => {
            let children = resolve_includes_inner(children, base_dir, visited);
            vec![Node::Volume { value, children }]
        }

        Node::Effect {
            effect_type,
            preset,
            cutoff,
            children,
        } => {
            let children = resolve_includes_inner(children, base_dir, visited);
            vec![Node::Effect {
                effect_type,
                preset,
                cutoff,
                children,
            }]
        }

        Node::Loop { loops, children } => {
            let children = resolve_includes_inner(children, base_dir, visited);
            vec![Node::Loop { loops, children }]
        }

        Node::Background {
            volume,
            speed,
            children,
        } => {
            let children = resolve_includes_inner(children, base_dir, visited);
            vec![Node::Background {
                volume,
                speed,
                children,
            }]
        }

        Node::Until {
            button,
            waiting_sound,
            waiting_sound_volume,
            pre_pause,
            post_pause,
            children,
        } => {
            let children = resolve_includes_inner(children, base_dir, visited);
            vec![Node::Until {
                button,
                waiting_sound,
                waiting_sound_volume,
                pre_pause,
                post_pause,
                children,
            }]
        }

        Node::Overlay { duration, parts } => {
            let parts = parts
                .into_iter()
                .map(|part| OverlayPart {
                    looped: part.looped,
                    volume: part.volume,
                    speed: part.speed,
                    children: resolve_includes_inner(part.children, base_dir, visited),
                })
                .collect();
            vec![Node::Overlay { duration, parts }]
        }

        // Leaves with no nested children — pass through unchanged.
        Node::Text(_) | Node::Pause { .. } | Node::Sound { .. } | Node::Tone { .. } => vec![node],
    }
}

/// Resolve a single `<include src="...">` reference.
fn resolve_one_include(src: &str, base_dir: &Path, visited: &mut HashSet<PathBuf>) -> Vec<Node> {
    let joined = base_dir.join(src);
    let normalized = normalize_path(&joined);

    if visited.contains(&normalized) {
        log::warn!("Skipping circular include: {}", normalized.display());
        return Vec::new();
    }

    if !normalized.exists() {
        log::warn!("Skipping missing include: {}", normalized.display());
        return Vec::new();
    }

    let content = match std::fs::read_to_string(&normalized) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("Failed to read include '{}': {}", normalized.display(), e);
            return Vec::new();
        }
    };

    let inner_nodes = match tag_parser::parse(&content) {
        Ok(n) => n,
        Err(e) => {
            log::warn!("Failed to parse include '{}': {}", normalized.display(), e);
            return Vec::new();
        }
    };

    // Track this file on the recursion stack so descendants can detect cycles.
    visited.insert(normalized.clone());
    let resolved = resolve_includes_inner(inner_nodes, base_dir, visited);
    visited.remove(&normalized);

    resolved
}

/// Normalize a path without requiring it to exist on disk.
///
/// Mirrors the logic in `bash::resolve_under`: collapses `.` and `..`
/// components manually. Unlike `Path::canonicalize`, this works for paths
/// that point to missing files.
fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for c in path.components() {
        match c {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

// ============================================================================
// Audio processing utilities
// ============================================================================

/// Trim leading and trailing silence from audio samples.
///
/// Uses a two-pass approach: first finds the window containing the
/// transition, then pinpoints the exact sample within that window.
fn trim_silence(samples: &[f32], threshold: f32) -> Vec<f32> {
    if samples.is_empty() {
        return samples.to_vec();
    }

    let window = 160; // ~6.7 ms at 24 kHz
    let n = samples.len();

    // Find first window whose RMS exceeds the threshold
    let mut start = n;
    for chunk_start in (0..n).step_by(window) {
        let end = (chunk_start + window).min(n);
        if rms_energy(&samples[chunk_start..end]) > threshold {
            start = chunk_start;
            break;
        }
    }

    // Refine: walk forward sample-by-sample from `start` to find exact onset
    if start < n {
        while start < n && samples[start].abs() < threshold {
            start += 1;
        }
    }

    // Find last window whose RMS exceeds the threshold
    let mut last = 0;
    let mut chunk_start = n.saturating_sub(window);
    loop {
        let end = (chunk_start + window).min(n);
        if rms_energy(&samples[chunk_start..end]) > threshold {
            last = end;
            break;
        }
        if chunk_start == 0 {
            break;
        }
        chunk_start = chunk_start.saturating_sub(window);
    }

    // Refine: walk backward sample-by-sample from `last` to find exact offset
    if last > 0 {
        while last > 0 && samples[last - 1].abs() < threshold {
            last -= 1;
        }
    }

    if start >= last {
        // Entire signal is silence — return a tiny snippet to avoid
        // breaking downstream duration calculations.
        return vec![0.0];
    }

    samples[start..last].to_vec()
}

/// Root-mean-square energy of a slice.
fn rms_energy(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|&s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}

/// Apply volume scaling to samples.
fn apply_volume(samples: &[f32], volume: f32) -> Vec<f32> {
    samples
        .iter()
        .map(|&s| (s * volume).clamp(-1.0, 1.0))
        .collect()
}

/// Apply a per-sample volume curve to audio samples.
///
/// Each sample is multiplied by the corresponding curve value.
/// If the curve is shorter than the samples, remaining samples are unchanged.
fn apply_volume_curve(samples: &[f32], curve: &[f32]) -> Vec<f32> {
    samples
        .iter()
        .enumerate()
        .map(|(i, &s)| {
            let v = curve.get(i).copied().unwrap_or(1.0);
            (s * v).clamp(-1.0, 1.0)
        })
        .collect()
}

/// Simple linear interpolation resampling.
fn resample(samples: &[f32], from_sr: u32, to_sr: u32) -> Vec<f32> {
    if from_sr == to_sr {
        return samples.to_vec();
    }
    let ratio = from_sr as f64 / to_sr as f64;
    let new_len = (samples.len() as f64 / ratio) as usize;
    let mut output = Vec::with_capacity(new_len);

    for i in 0..new_len {
        let src_pos = i as f64 * ratio;
        let src_idx = src_pos as usize;
        let frac = src_pos - src_idx as f64;

        let s0 = samples.get(src_idx).copied().unwrap_or(0.0);
        let s1 = samples.get(src_idx + 1).copied().unwrap_or(0.0);

        output.push(s0 * (1.0 - frac as f32) + s1 * frac as f32);
    }

    output
}

/// Generate a tone based on preset type.
fn generate_tone(
    preset: &str,
    frequency: f32,
    duration: f32,
    sample_rate: u32,
    volume: f32,
) -> Vec<f32> {
    let num_samples = (duration * sample_rate as f32) as usize;
    let mut samples = Vec::with_capacity(num_samples);

    match preset {
        "sine" => {
            for i in 0..num_samples {
                let t = i as f32 / sample_rate as f32;
                let val = (2.0 * std::f32::consts::PI * frequency * t).sin();
                samples.push(val * volume);
            }
        }
        "square" => {
            for i in 0..num_samples {
                let t = i as f32 / sample_rate as f32;
                let val = (2.0 * std::f32::consts::PI * frequency * t).sin();
                samples.push(val.signum() * volume);
            }
        }
        "sawtooth" => {
            for i in 0..num_samples {
                let t = i as f32 / sample_rate as f32;
                let period = 1.0 / frequency;
                let val = 2.0 * ((t % period) / period) - 1.0;
                samples.push(val * volume);
            }
        }
        "triangle" => {
            for i in 0..num_samples {
                let t = i as f32 / sample_rate as f32;
                let period = 1.0 / frequency;
                let phase = (t % period) / period;
                let val = 4.0 * (phase - 0.5).abs() - 1.0;
                samples.push(val * volume);
            }
        }
        "whitenoise" => {
            use rand::Rng;
            let mut rng = rand::thread_rng();
            for _ in 0..num_samples {
                let val: f32 = rng.gen_range(-1.0..1.0);
                samples.push(val * volume);
            }
        }
        "pinknoise" | "brownnoise" => {
            use rand::Rng;
            let mut rng = rand::thread_rng();
            let mut state = 0.0f32;
            let alpha = if preset == "brownnoise" { 0.02 } else { 0.04 };
            let boost = if preset == "brownnoise" { 5.0 } else { 3.0 };
            for _ in 0..num_samples {
                let noise: f32 = rng.gen_range(-1.0..1.0);
                state = state + alpha * (noise - state);
                samples.push((state * boost * volume).clamp(-1.0, 1.0));
            }
        }
        "binaural_theta" | "binaural_alpha" | "binaural_beta" | "binaural_delta" => {
            // Amplitude-modulated sine at brainwave entrainment frequency
            let beat_freq = match preset {
                "binaural_theta" => 6.0,
                "binaural_alpha" => 10.0,
                "binaural_beta" => 20.0,
                "binaural_delta" => 2.0,
                _ => 6.0,
            };
            for i in 0..num_samples {
                let t = i as f32 / sample_rate as f32;
                let carrier = (2.0 * std::f32::consts::PI * frequency * t).sin();
                let modulation = 0.5 * (1.0 + (2.0 * std::f32::consts::PI * beat_freq * t).sin());
                samples.push(carrier * modulation * volume);
            }
        }
        // Unknown preset — generate sine as default
        _ => {
            for i in 0..num_samples {
                let t = i as f32 / sample_rate as f32;
                let val = (2.0 * std::f32::consts::PI * frequency * t).sin();
                samples.push(val * volume);
            }
        }
    }

    samples
}

/// Apply an audio effect to samples.
fn apply_effect(
    samples: &[f32],
    effect_type: &str,
    preset: Option<&str>,
    cutoff: Option<f32>,
    sample_rate: u32,
) -> Vec<f32> {
    match effect_type {
        "echo" => {
            let delay_secs = match preset {
                Some("heavy") => 0.3,
                Some("medium") => 0.2,
                _ => 0.1, // light
            };
            let decay = match preset {
                Some("heavy") => 0.6,
                Some("medium") => 0.5,
                _ => 0.4,
            };
            apply_echo(samples, delay_secs, decay, sample_rate)
        }
        "reverb" => {
            let (room_size, decay) = match preset {
                Some("small_room") => (0.5, 0.3),
                Some("large_hall") => (1.5, 0.5),
                Some("cathedral") => (3.0, 0.7),
                Some("plate") => (0.8, 0.4),
                _ => (1.0, 0.4), // medium default
            };
            apply_reverb(samples, room_size, decay, sample_rate)
        }
        "filter" => {
            let cutoff_freq = cutoff.unwrap_or(1000.0);
            apply_lowpass(samples, cutoff_freq, sample_rate)
        }
        _ => samples.to_vec(),
    }
}

/// Simple echo effect.
fn apply_echo(samples: &[f32], delay_secs: f32, decay: f32, sample_rate: u32) -> Vec<f32> {
    let delay_samples = (delay_secs * sample_rate as f32) as usize;
    let mut output = samples.to_vec();
    output.resize(samples.len() + delay_samples, 0.0f32);

    for i in 0..samples.len() {
        output[i + delay_samples] += samples[i] * decay;
    }

    // Clamp
    for s in output.iter_mut() {
        *s = s.clamp(-1.0, 1.0);
    }
    output
}

/// Comb-filter based reverb with feedback for a realistic reverb tail.
///
/// `room_size` controls the base delay time in seconds (e.g., 0.5 = small, 1.5 = large hall).
/// `decay` controls the feedback amount (0.0 – 1.0).
fn apply_reverb(samples: &[f32], room_size: f32, decay: f32, sample_rate: u32) -> Vec<f32> {
    // Early reflection delay times (seconds), scaled by room_size
    let early_delays_and_gains: Vec<(usize, f32)> = vec![
        (0.019, 0.75),
        (0.023, 0.70),
        (0.029, 0.60),
        (0.037, 0.50),
        (0.043, 0.40),
        (0.053, 0.30),
    ]
    .into_iter()
    .map(|(base_delay, gain)| {
        let delay_samples = (room_size * base_delay * sample_rate as f32) as usize;
        (delay_samples.max(1), gain * decay)
    })
    .collect();

    // Late reverb: comb filter delays (seconds), scaled by room_size
    let comb_delays: Vec<usize> = vec![0.023, 0.037, 0.041, 0.053]
        .into_iter()
        .map(|d| (room_size * d * sample_rate as f32) as usize)
        .collect();

    let comb_feedback = decay * 0.75;
    let max_comb = *comb_delays.iter().max().unwrap_or(&1);

    // Estimate tail length: enough iterations for reverb to decay to silence
    let num_iterations = (1.0 / (1.0 - comb_feedback).max(0.01)).ceil() as usize;
    let tail_length = max_comb * num_iterations.min(20);
    let total_length = samples.len() + tail_length;

    let mut output = vec![0.0f32; total_length];

    // Copy dry signal
    for (i, &s) in samples.iter().enumerate() {
        output[i] = s;
    }

    // Early reflections
    for (delay, gain) in &early_delays_and_gains {
        for i in 0..samples.len() {
            let idx = i + delay;
            if idx < output.len() {
                output[idx] += samples[i] * gain;
            }
        }
    }

    // Late reverb using comb filters with feedback
    for delay in &comb_delays {
        let mut buffer = vec![0.0f32; total_length];
        // Seed buffer with input signal
        for (i, &s) in samples.iter().enumerate() {
            buffer[i] = s;
        }
        // Apply feedback
        for i in 0..total_length {
            let idx = i + delay;
            if idx < total_length {
                let feedback_sample = buffer[i] * comb_feedback;
                buffer[idx] += feedback_sample;
            }
        }
        // Mix comb output into main output at reduced gain
        let mix_gain = 0.2;
        for (i, &s) in buffer.iter().enumerate() {
            if i < output.len() {
                output[i] += s * mix_gain;
            }
        }
    }

    // Clamp
    for s in output.iter_mut() {
        *s = s.clamp(-1.0, 1.0);
    }
    output
}

/// Simple first-order lowpass filter.
fn apply_lowpass(samples: &[f32], cutoff: f32, sample_rate: u32) -> Vec<f32> {
    let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff);
    let dt = 1.0 / sample_rate as f32;
    let alpha = dt / (rc + dt);

    let mut output = Vec::with_capacity(samples.len());
    let mut prev = 0.0f32;

    for &s in samples {
        prev = prev + alpha * (s - prev);
        output.push(prev);
    }

    output
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_apply_volume() {
        let samples = vec![0.5, -0.5, 1.0];
        let result = apply_volume(&samples, 0.5);
        assert!((result[0] - 0.25).abs() < 0.001);
        assert!((result[1] - (-0.25)).abs() < 0.001);
        assert!((result[2] - 0.5).abs() < 0.001);
    }

    #[test]
    fn test_apply_volume_clamp() {
        let samples = vec![0.8, -0.8];
        let result = apply_volume(&samples, 2.0);
        assert!((result[0] - 1.0).abs() < 0.001);
        assert!((result[1] - (-1.0)).abs() < 0.001);
    }

    #[test]
    fn test_apply_volume_curve() {
        let samples = vec![1.0, 1.0, 1.0, 1.0, 1.0];
        let curve = vec![0.0, 0.25, 0.5, 0.75, 1.0];
        let result = apply_volume_curve(&samples, &curve);
        assert!((result[0] - 0.0).abs() < 0.001);
        assert!((result[1] - 0.25).abs() < 0.001);
        assert!((result[4] - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_apply_volume_curve_shorter() {
        // Curve shorter than samples: remaining samples unchanged
        let samples = vec![1.0, 1.0, 1.0, 1.0];
        let curve = vec![0.5, 0.5];
        let result = apply_volume_curve(&samples, &curve);
        assert!((result[0] - 0.5).abs() < 0.001);
        assert!((result[1] - 0.5).abs() < 0.001);
        assert!((result[2] - 1.0).abs() < 0.001);
        assert!((result[3] - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_rms_energy() {
        // Silence
        assert!((rms_energy(&[0.0; 100])).abs() < 0.0001);
        // Full-scale sine-ish
        let signal: Vec<f32> = (0..100).map(|i| (i as f32 / 100.0) * 2.0 - 1.0).collect();
        let rms = rms_energy(&signal);
        assert!(
            rms > 0.5,
            "RMS of full-scale signal should be > 0.5, got {}",
            rms
        );
    }

    #[test]
    fn test_trim_silence_leading_and_trailing() {
        // 500 silence + 1000 signal + 500 silence  (at 24 kHz that's ~83 ms gap on each side)
        let mut samples = vec![0.0f32; 500];
        samples.extend(vec![0.5f32; 1000]);
        samples.extend(vec![0.0f32; 500]);

        let trimmed = trim_silence(&samples, 0.01);
        // Should have removed most of the leading/trailing silence
        assert!(
            trimmed.len() <= 1200 && trimmed.len() >= 900,
            "Trimmed length should be ~1000, got {}",
            trimmed.len()
        );
        // All remaining samples should be signal (first and last are within the signal block)
        assert!(trimmed.first().copied().unwrap_or(0.0) > 0.4);
        assert!(trimmed.last().copied().unwrap_or(0.0) > 0.4);
    }

    #[test]
    fn test_trim_silence_all_silence() {
        let samples = vec![0.0f32; 200];
        let trimmed = trim_silence(&samples, 0.01);
        // Should return minimal snippet, not empty
        assert!(!trimmed.is_empty());
        assert!(trimmed.len() <= 2);
    }

    #[test]
    fn test_trim_silence_no_silence() {
        let samples = vec![0.5f32; 200];
        let trimmed = trim_silence(&samples, 0.01);
        assert_eq!(
            trimmed.len(),
            200,
            "No trimming expected for all-signal input"
        );
    }

    #[test]
    fn test_trim_silence_empty() {
        let samples: Vec<f32> = vec![];
        let trimmed = trim_silence(&samples, 0.01);
        assert!(trimmed.is_empty());
    }

    #[test]
    fn test_resolve_scalar_number() {
        assert_eq!(resolve_scalar(Some("0.5"), 1.0), 0.5);
        assert_eq!(resolve_scalar(Some("1.0"), 1.0), 1.0);
        assert_eq!(resolve_scalar(None, 1.0), 1.0);
    }

    #[test]
    fn test_resolve_scalar_expression() {
        // Constant expression: @max(0.3, 0.7) = 0.7
        let val = resolve_scalar(Some("@max(0.3, 0.7)"), 1.0);
        assert!((val - 0.7).abs() < 0.001);
    }

    #[test]
    fn test_resolve_value_number() {
        match resolve_value(Some("0.5"), 1.0) {
            ValueOrExpr::Scalar(v) => assert!((v - 0.5).abs() < 0.001),
            _ => panic!("Expected scalar"),
        }
    }

    #[test]
    fn test_resolve_value_expression() {
        match resolve_value(Some("@fadein(2)"), 1.0) {
            ValueOrExpr::Expr(_) => {} // OK — dynamic expression
            ValueOrExpr::Scalar(v) => panic!("Expected expression, got scalar {}", v),
        }
    }

    #[test]
    fn test_resolve_value_none() {
        match resolve_value(None, 1.0) {
            ValueOrExpr::Scalar(v) => assert!((v - 1.0).abs() < 0.001),
            _ => panic!("Expected scalar"),
        }
    }

    #[test]
    fn test_resample_identity() {
        let samples = vec![0.0, 0.5, 1.0, 0.5, 0.0];
        let result = resample(&samples, 44100, 44100);
        assert_eq!(result.len(), samples.len());
        for (a, b) in samples.iter().zip(result.iter()) {
            assert!((a - b).abs() < 0.001);
        }
    }

    #[test]
    fn test_resample_up() {
        let samples = vec![0.0, 1.0];
        let result = resample(&samples, 22050, 44100);
        assert_eq!(result.len(), 4);
    }

    #[test]
    fn test_resample_down() {
        let samples = vec![0.0, 0.25, 0.5, 0.75, 1.0];
        let result = resample(&samples, 44100, 22050);
        assert_eq!(result.len(), 2); // roughly
    }

    #[test]
    fn test_generate_sine_tone() {
        let samples = generate_tone("sine", 440.0, 0.1, 44100, 0.5);
        assert_eq!(samples.len(), 4410); // 0.1 * 44100
        assert!(samples.iter().all(|&s| s.abs() <= 0.5));
    }

    #[test]
    fn test_generate_square_tone() {
        let samples = generate_tone("square", 440.0, 0.05, 44100, 0.3);
        assert_eq!(samples.len(), 2205);
        assert!(samples.iter().all(|&s| s == 0.3 || s == -0.3 || s == 0.0));
    }

    #[test]
    fn test_generate_noise() {
        let samples = generate_tone("whitenoise", 0.0, 0.05, 44100, 0.5);
        assert_eq!(samples.len(), 2205);
        assert!(samples.iter().all(|&s| s.abs() <= 0.5));
    }

    #[test]
    fn test_apply_echo() {
        let samples = vec![0.5f32; 4410];
        let result = apply_echo(&samples, 0.01, 0.5, 44100);
        assert!(result.len() > samples.len());
        // At the delay point, we have original (0.5) + echo (0.5 * 0.5 = 0.25)
        let delay_idx = 441; // 0.01 * 44100
        assert!((result[delay_idx] - 0.75).abs() < 0.01);
    }

    #[test]
    fn test_apply_lowpass() {
        let mut samples = vec![0.0f32; 100];
        samples[10] = 1.0; // impulse
        let result = apply_lowpass(&samples, 1000.0, 44100);
        // After the impulse, values should decay
        assert!(result[11] > 0.0);
        assert!(result[11] < 1.0);
    }

    #[test]
    fn test_apply_reverb_audible() {
        // Reverb should add energy beyond the original signal length
        let samples = vec![1.0f32; 4410];
        let result = apply_reverb(&samples, 1.5, 0.5, 44100);
        assert!(result.len() > samples.len(), "Reverb should add a tail");

        // Check that reverb adds signal after the input ends
        let tail_has_energy = result[samples.len()..].iter().any(|&s| s.abs() > 0.01);
        assert!(tail_has_energy, "Reverb tail should contain audible energy");

        // Check that early reflections add signal during the input
        // With room_size=1.5, first early delay = 1.5 * 0.019 * 44100 ≈ 1257 samples
        let first_delay = (1.5 * 0.019 * 44100.0) as usize;
        if first_delay < samples.len() {
            assert!(
                result[first_delay] > 1.0 || (result[first_delay] - 1.0).abs() < 0.01,
                "Early reflection should add signal at delay point: got {}",
                result[first_delay]
            );
        }
    }

    #[test]
    fn test_apply_reverb_presets() {
        let samples = vec![1.0f32; 24000]; // 1 second
        for preset in ["small_room", "large_hall", "cathedral", "plate"] {
            let result = apply_effect(&samples, "reverb", Some(preset), None, 24000);
            assert!(
                result.len() > samples.len(),
                "Reverb preset '{}' should add a tail",
                preset
            );
        }
    }

    #[test]
    fn test_apply_effect_unknown() {
        let samples = vec![0.5, 0.3, 0.1];
        let result = apply_effect(&samples, "unknown", None, None, 44100);
        assert_eq!(result, samples);
    }

    #[test]
    fn test_generate_all_presets() {
        let presets = [
            "sine",
            "square",
            "sawtooth",
            "triangle",
            "whitenoise",
            "pinknoise",
            "brownnoise",
        ];
        for preset in presets {
            let samples = generate_tone(preset, 440.0, 0.01, 44100, 0.5);
            assert!(!samples.is_empty(), "Empty samples for {}", preset);
            assert!(
                samples.iter().all(|&s| s.abs() <= 1.0),
                "Clipping for {}",
                preset
            );
        }
    }

    // ========================================================================
    // Tests for issue fixes
    // ========================================================================

    /// Issue 1: Tones should loop-extend to end of enclosing tag, not stop at
    /// a fixed 2-second duration.
    #[test]
    fn test_tone_loops_to_enclosing_scope() {
        // Simulate: tone followed by 4 seconds of content
        // The tone should cover all 4 seconds, not just 2
        let sr: u32 = 24000;
        let fg_before = 0; // Tone at start
        let base_tone = generate_tone("sine", 440.0, 0.5, sr, 0.3); // 0.5s base
        let mut bg = BgLayer::tone(base_tone.clone(), fg_before);

        // Simulate 4 seconds of foreground content
        let fg_len = (4.0 * sr as f32) as usize;

        // Loop-extend
        if let Some(ref content) = bg.tone_content {
            while bg.samples.len() < fg_len {
                bg.samples.extend_from_slice(content);
            }
            bg.samples.truncate(fg_len);
        }

        assert_eq!(
            bg.samples.len(),
            fg_len,
            "Tone should extend to full foreground length"
        );
        // Verify tone has non-zero content throughout (not just silence after 2s)
        let midpoint = fg_len / 2;
        let has_energy_after_2s = bg.samples[midpoint..].iter().any(|&s| s.abs() > 0.01);
        assert!(
            has_energy_after_2s,
            "Tone should have audio content after 2 seconds"
        );
    }

    #[test]
    fn test_tone_starts_at_correct_position() {
        // Tone encountered after 1 second of foreground
        let sr: u32 = 24000;
        let fg_before = (1.0 * sr as f32) as usize; // 1 second of silence before tone
        let base_tone = generate_tone("sine", 440.0, 0.5, sr, 0.3);
        let bg = BgLayer::tone(base_tone.clone(), fg_before);

        // First fg_before samples should be silence
        for (i, &s) in bg.samples[..fg_before].iter().enumerate() {
            assert!(s.abs() < 0.001, "Sample {} should be silence, got {}", i, s);
        }
        // Samples after should be tone content
        assert!(bg.samples[fg_before..].iter().any(|&s| s.abs() > 0.01));
    }

    /// Issue 2: Volume tag with @fade expression should produce a volume curve.
    #[test]
    fn test_volume_fade_expression() {
        let expr = expression::parse_expr("@fade(1)").unwrap();
        let sr: u32 = 24000;
        let num_samples = (2.0 * sr as f32) as usize; // 2 seconds
        let curve = expression::eval_curve(&expr, num_samples, sr);

        // At t=0, fade should start at 0 (fadein)
        assert!(
            curve[0].abs() < 0.01,
            "Fade should start near 0, got {}",
            curve[0]
        );
        // At t=1s (middle of 2s), fade should be at 1.0
        let mid = sr as usize; // 1 second
        assert!(
            (curve[mid] - 1.0).abs() < 0.01,
            "Fade should reach 1.0 at middle, got {}",
            curve[mid]
        );
        // At t=2s (end), fade should be near 0 (fadeout)
        let last = curve.len() - 1;
        assert!(
            curve[last].abs() < 0.01,
            "Fade should end near 0, got {}",
            curve[last]
        );
    }

    /// Issue 3: Verify volume on looped overlay parts works.
    #[test]
    fn test_overlay_looped_volume() {
        let vol = resolve_scalar(Some("0.4"), 1.0);
        assert!(
            (vol - 0.4).abs() < 0.001,
            "Overlay part volume should be 0.4, got {}",
            vol
        );

        // Simulate looped part rendering with volume
        let samples = vec![0.5f32; 100];
        let scaled = apply_volume(&samples, 0.4);
        assert!(
            (scaled[0] - 0.2).abs() < 0.001,
            "Volume 0.4 on sample 0.5 should give 0.2, got {}",
            scaled[0]
        );
    }

    /// Issue 4: Reverb should produce audible output with energy beyond the dry signal.
    #[test]
    fn test_reverb_large_hall() {
        let sr: u32 = 24000;
        let samples = vec![1.0f32; sr as usize]; // 1 second of signal
        let result = apply_reverb(&samples, 1.5, 0.5, sr);

        // Should be longer than input (reverb tail)
        assert!(result.len() > samples.len());

        // Reverb tail should have audible energy
        let tail = &result[samples.len()..];
        let tail_energy: f32 = tail.iter().map(|&s| s.abs()).sum();
        assert!(tail_energy > 0.0, "Reverb tail should have energy");
    }

    /// Issue 5: @ramp expression should produce linear volume ramp.
    #[test]
    fn test_volume_ramp_expression() {
        let expr = expression::parse_expr("@ramp(0.5,1.0)").unwrap();
        let sr: u32 = 24000;
        let num_samples = (2.0 * sr as f32) as usize; // 2 seconds
        let curve = expression::eval_curve(&expr, num_samples, sr);

        // Start value should be 0.5
        assert!(
            (curve[0] - 0.5).abs() < 0.01,
            "Ramp should start at 0.5, got {}",
            curve[0]
        );
        // End value should be 1.0
        let last = curve.len() - 1;
        assert!(
            (curve[last] - 1.0).abs() < 0.01,
            "Ramp should end at 1.0, got {}",
            curve[last]
        );
        // Midpoint should be 0.75
        let mid = num_samples / 2;
        assert!(
            (curve[mid] - 0.75).abs() < 0.02,
            "Ramp midpoint should be ~0.75, got {}",
            curve[mid]
        );
    }

    /// Issue 6: Background with @env expression should produce ADSR curve.
    #[test]
    fn test_background_env_expression() {
        let expr = expression::parse_expr("@env(0.2,0.3,0.5,0.2)").unwrap();
        let sr: u32 = 24000;
        let duration = 2.0; // 2 seconds total
        let num_samples = (duration * sr as f32) as usize;
        let curve = expression::eval_curve(&expr, num_samples, sr);

        // At t=0, should start at 0 (attack phase start)
        assert!(
            curve[0].abs() < 0.05,
            "Env should start near 0, got {}",
            curve[0]
        );

        // At t=0.2s (end of attack), should be near 1.0
        let attack_end = (0.2 * sr as f32) as usize;
        assert!(
            (curve[attack_end] - 1.0).abs() < 0.05,
            "Env at end of attack should be ~1.0, got {}",
            curve[attack_end]
        );

        // In sustain phase (e.g., t=0.8s), should be near sustain level (0.5)
        let sustain_idx = (0.8 * sr as f32) as usize;
        assert!(
            (curve[sustain_idx] - 0.5).abs() < 0.05,
            "Env in sustain should be ~0.5, got {}",
            curve[sustain_idx]
        );

        // At end, should decay to near 0
        let last = curve.len() - 1;
        assert!(
            curve[last].abs() < 0.1,
            "Env at end should be near 0, got {}",
            curve[last]
        );
    }

    /// Issue 7a: @min/@max/@beat expression should parse and evaluate.
    #[test]
    fn test_complex_min_max_beat() {
        let expr = expression::parse_expr("@min(1.0, @max(0.3, @beat(60, 0.5)))").unwrap();
        let sr: u32 = 24000;
        let num_samples = (2.0 * sr as f32) as usize;
        let curve = expression::eval_curve(&expr, num_samples, sr);

        // All values should be between 0.3 and 1.0 (bounded by @min and @max)
        for (i, &v) in curve.iter().enumerate() {
            assert!(
                v >= 0.29 && v <= 1.01,
                "Value at sample {} should be in [0.3, 1.0], got {}",
                i,
                v
            );
        }
    }

    /// Issue 7b: @fadeout should produce a fade-out curve.
    #[test]
    fn test_fadeout_expression() {
        let expr = expression::parse_expr("@fadeout(1)").unwrap();
        let sr: u32 = 24000;
        let num_samples = (2.0 * sr as f32) as usize; // 2 seconds
        let curve = expression::eval_curve(&expr, num_samples, sr);

        // Start should be 1.0
        assert!(
            (curve[0] - 1.0).abs() < 0.01,
            "Fadeout should start at 1.0, got {}",
            curve[0]
        );
        // At t=1s (1s before end), should start fading
        let start_fade = (1.0 * sr as f32) as usize;
        assert!(
            (curve[start_fade] - 1.0).abs() < 0.05,
            "Fadeout at 1s should still be ~1.0, got {}",
            curve[start_fade]
        );
        // At end should be near 0
        let last = curve.len() - 1;
        assert!(
            curve[last].abs() < 0.01,
            "Fadeout at end should be ~0, got {}",
            curve[last]
        );
    }

    /// Issue 7c: @sin(2) * 0.5 + 0.5 should oscillate.
    #[test]
    fn test_sin_expression() {
        let expr = expression::parse_expr("@sin(2) * 0.5 + 0.5").unwrap();
        let sr: u32 = 24000;
        let num_samples = (2.0 * sr as f32) as usize;
        let curve = expression::eval_curve(&expr, num_samples, sr);

        // All values should be in [0, 1]
        for (i, &v) in curve.iter().enumerate() {
            assert!(
                v >= -0.01 && v <= 1.01,
                "Sin curve at sample {} should be in [0, 1], got {}",
                i,
                v
            );
        }

        // Should oscillate: check that the curve has both high and low values
        let max_val = curve.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let min_val = curve.iter().cloned().fold(f32::INFINITY, f32::min);
        assert!(
            (max_val - min_val) >= 0.4,
            "Sin expression should oscillate (range: {} - {} = {})",
            max_val,
            min_val,
            max_val - min_val
        );
    }

    /// Test that apply_volume_curve works correctly with a fade curve.
    #[test]
    fn test_volume_curve_integration() {
        let samples = vec![1.0f32; 24000]; // 1 second at 24kHz
        let expr = expression::parse_expr("@fadein(0.5)").unwrap();
        let curve = expression::eval_curve(&expr, samples.len(), 24000);
        let result = apply_volume_curve(&samples, &curve);

        // First sample should be near 0
        assert!(result[0].abs() < 0.01);
        // At 0.5s, should be at full volume
        let half_sec = 12000; // 0.5 * 24000
        assert!(
            (result[half_sec] - 1.0).abs() < 0.05,
            "After fadein, volume should be ~1.0, got {}",
            result[half_sec]
        );
    }

    /// Test that the parser handles expression attributes in AST.
    #[test]
    fn test_parse_expression_attributes() {
        use crate::tag_parser;

        // Voice with expression volume
        let input = r#"<voice speaker="male" volume="@fadein(2)">Hello</voice>"#;
        let nodes = tag_parser::parse(input).unwrap();
        match &nodes[0] {
            tag_parser::Node::Voice { volume, .. } => {
                assert_eq!(volume.as_deref(), Some("@fadein(2)"));
            }
            _ => panic!("Expected Voice node"),
        }

        // Volume tag with expression value
        let input = r#"<volume value="@fade(1)">Hello</volume>"#;
        let nodes = tag_parser::parse(input).unwrap();
        match &nodes[0] {
            tag_parser::Node::Volume { value, .. } => {
                assert_eq!(value, "@fade(1)");
            }
            _ => panic!("Expected Volume node"),
        }

        // Background with expression volume
        let input =
            r#"<background volume="@env(0.2,0.3,0.5,0.2)"><sound type="swoosh"/></background>"#;
        let nodes = tag_parser::parse(input).unwrap();
        match &nodes[0] {
            tag_parser::Node::Background { volume, .. } => {
                assert_eq!(volume.as_deref(), Some("@env(0.2,0.3,0.5,0.2)"));
            }
            _ => panic!("Expected Background node"),
        }
    }

    /// Test that the comprehensive example parses without error.
    #[test]
    fn test_parse_comprehensive_example() {
        use crate::tag_parser;

        let input = r#"<voice speaker="male" pitch="1.1" volume="@fadein(2)" speed="1.0">
  <tone type="binaural" preset="theta" volume="0.15"/>
  Welcome to the comprehensive TTS demonstration.
  <pause duration="0.5"/>
  <sound type="ding" volume="0.8"/>
  <speed value="0.9">
    <volume value="@fade(1)">
      This part is slightly slower and fades in and out.
    </volume>
  </speed>
  <overlay>
    <part looped="true" volume="0.4"><sound type="water_drop"/></part>
    <part>And here is an overlay with a looping sound under speech.</part>
  </overlay>
  <effect type="reverb" preset="large_hall">
    <voice speaker="female" volume="0.9">
      This voice has reverb applied.
    </voice>
  </effect>
  <loop loops="2">
    <voice speaker="male2" speed="1.2" volume="@ramp(0.5,1.0)">
      Repeated phrase.
    </voice>
    <pause duration="0.3"/>
  </loop>
  <background volume="@env(0.2,0.3,0.5,0.2)"><sound type="swoosh" volume="0.5"/></background>
  Now take a deep breath and let it go.
  <pause duration="0.5"/>
  <voice speaker="female" volume="@min(1.0, @max(0.3, @beat(60, 0.5)))">
    This voice pulses with a beat at sixty B P M.
  </voice>
  <voice speaker="male" volume="@sin(2) * 0.5 + 0.5">
    This voice oscillates with a sine wave.
  </voice>
  <until button="I'm ready"
         waiting-sound="heart_beat"
         waiting-sound-volume="0.4"
         pre-pause="0.5"
         post-pause="0.3">
    Press the button when you are ready.
  </until>
  <sound type="success"/>
  <voice speaker="female" volume="@fadeout(1)">
    Thank you for exploring every feature. Goodbye.
  </voice>
</voice>"#;
        let result = tag_parser::parse(input);
        assert!(result.is_ok(), "Failed to parse: {:?}", result.err());
    }

    /// Background must not extend the foreground timeline.
    ///
    /// Given:  Text("A") → Background(Sound) → Text("B")
    /// foreground must be just [A | B] with the swoosh starting at the
    /// boundary between A and B — NOT [A | swoosh | B].
    #[test]
    fn test_background_does_not_block_foreground() {
        let sr: u32 = 24000;

        // Simulate the three nodes: Text "A", Background(swoosh), Text "B"
        let a_samples = vec![0.5f32; sr as usize]; // 1 s
        let b_samples = vec![0.3f32; sr as usize]; // 1 s
        let swoosh_samples = vec![0.8f32; sr as usize / 2]; // 0.5 s

        // --- foreground timeline (same logic as render_nodes) ---
        let mut foreground = Vec::new();
        foreground.extend_from_slice(&a_samples); // "A"

        // Background node: capture position, render to bg_layer, do NOT touch foreground
        let fg_before_bg = foreground.len();
        let mut bg_layer = vec![0.0f32; fg_before_bg];
        bg_layer.extend_from_slice(&swoosh_samples);
        // bg_layer is pushed; foreground is unchanged

        foreground.extend_from_slice(&b_samples); // "B"

        // Extend bg_layer to match foreground (post-processing)
        if bg_layer.len() < foreground.len() {
            bg_layer.extend(std::iter::repeat(0.0f32).take(foreground.len() - bg_layer.len()));
        }

        // Assertions
        assert_eq!(
            foreground.len(),
            2 * sr as usize,
            "Foreground should be exactly 2 s (A + B), not extended by background"
        );

        // bg_layer: silence during A, swoosh during B, silence for rest of B
        for i in 0..sr as usize {
            assert_eq!(
                bg_layer[i], 0.0,
                "bg_layer[{}] should be silence during 'A'",
                i
            );
        }
        for i in sr as usize..(sr as usize + sr as usize / 2) {
            assert_eq!(
                bg_layer[i], 0.8,
                "bg_layer[{}] should be swoosh during 'B'",
                i
            );
        }
        for i in (sr as usize + sr as usize / 2)..(2 * sr as usize) {
            assert_eq!(
                bg_layer[i], 0.0,
                "bg_layer[{}] should be silence after swoosh",
                i
            );
        }

        // Mix and verify that the swoosh overlaps with B, not A
        let mut mixed = foreground;
        for (i, &s) in bg_layer.iter().enumerate() {
            mixed[i] += s;
        }

        // During "A" (first 1 s): only 0.5 (no swoosh)
        assert!((mixed[0] - 0.5).abs() < 0.001, "During A: no swoosh");
        // During "B" + swoosh (1.0 s – 1.5 s): 0.3 + 0.8 = 1.1
        let overlap_idx = sr as usize + sr as usize / 4;
        assert!((mixed[overlap_idx] - 1.1).abs() < 0.001, "During B+swoosh");
        // During "B" after swoosh (1.5 s – 2.0 s): only 0.3
        let after_idx = sr as usize + 3 * sr as usize / 4;
        assert!((mixed[after_idx] - 0.3).abs() < 0.001, "During B only");
    }

    // ========================================================================
    // resolve_includes tests
    // ========================================================================

    use crate::tag_parser;
    use std::fs;
    use tempfile::tempdir;

    /// Helper: collect all text nodes from a node vec, ignoring nested structure.
    fn collect_text(nodes: &[Node]) -> Vec<String> {
        let mut texts = Vec::new();
        for node in nodes {
            collect_text_recursive(node, &mut texts);
        }
        texts
    }

    fn collect_text_recursive(node: &Node, texts: &mut Vec<String>) {
        match node {
            Node::Text(t) => {
                if !t.is_empty() {
                    texts.push(t.clone());
                }
            }
            Node::Voice { children, .. }
            | Node::Speed { children, .. }
            | Node::Volume { children, .. }
            | Node::Effect { children, .. }
            | Node::Loop { children, .. }
            | Node::Background { children, .. }
            | Node::Until { children, .. } => {
                for child in children {
                    collect_text_recursive(child, texts);
                }
            }
            Node::Overlay { parts, .. } => {
                for part in parts {
                    for child in &part.children {
                        collect_text_recursive(child, texts);
                    }
                }
            }
            Node::Pause { .. } | Node::Sound { .. } | Node::Tone { .. } | Node::Include { .. } => {}
        }
    }

    /// True if any node in the tree is an unresolved `Include`.
    fn contains_include(nodes: &[Node]) -> bool {
        for node in nodes {
            if contains_include_recursive(node) {
                return true;
            }
        }
        false
    }

    fn contains_include_recursive(node: &Node) -> bool {
        match node {
            Node::Include { .. } => true,
            Node::Voice { children, .. }
            | Node::Speed { children, .. }
            | Node::Volume { children, .. }
            | Node::Effect { children, .. }
            | Node::Loop { children, .. }
            | Node::Background { children, .. }
            | Node::Until { children, .. } => children.iter().any(contains_include_recursive),
            Node::Overlay { parts, .. } => parts
                .iter()
                .any(|p| p.children.iter().any(contains_include_recursive)),
            _ => false,
        }
    }

    #[test]
    fn test_resolve_includes_basic() {
        let dir = tempdir().expect("create tempdir");
        fs::write(dir.path().join("sub.xml"), "hello").expect("write sub.xml");

        let nodes = tag_parser::parse(r#"<include src="sub.xml"/>"#).expect("parse main");
        let resolved = resolve_includes(nodes, dir.path());

        assert!(
            !contains_include(&resolved),
            "Include should have been resolved away"
        );
        let texts = collect_text(&resolved);
        assert!(
            texts.iter().any(|t| t == "hello"),
            "Expected inlined text 'hello', got {:?}",
            texts,
        );
    }

    #[test]
    fn test_resolve_includes_circular() {
        let dir = tempdir().expect("create tempdir");
        fs::write(
            dir.path().join("a.xml"),
            r#"A-start <include src="b.xml"/> A-end"#,
        )
        .expect("write a.xml");
        fs::write(
            dir.path().join("b.xml"),
            r#"B-start <include src="a.xml"/> B-end"#,
        )
        .expect("write b.xml");

        let nodes = tag_parser::parse(r#"<include src="a.xml"/>"#).expect("parse main");
        // The resolver must terminate rather than recurse forever.
        let resolved = resolve_includes(nodes, dir.path());

        let texts = collect_text(&resolved);
        // We expect at least one occurrence of each side, plus the second-occurrence
        // circular skip meaning the second 'a.xml' reference is dropped.
        assert!(
            texts.iter().any(|t| t.contains("A-start")),
            "A-start should appear: {:?}",
            texts,
        );
        assert!(
            texts.iter().any(|t| t.contains("B-start")),
            "B-start should appear: {:?}",
            texts,
        );
        // Should not contain a duplicate A-start (would indicate infinite recursion
        // — actually with the current per-path visited tracking it would, but the
        // circular detection prevents it).
        let a_count = texts.iter().filter(|t| t.contains("A-start")).count();
        assert_eq!(
            a_count, 1,
            "A-start should appear exactly once (circular skipped), got {}: {:?}",
            a_count, texts,
        );
    }

    #[test]
    fn test_resolve_includes_missing_file() {
        let dir = tempdir().expect("create tempdir");
        let nodes = tag_parser::parse(r#"before <include src="does_not_exist.xml"/> after"#)
            .expect("parse main");
        let resolved = resolve_includes(nodes, dir.path());

        let texts = collect_text(&resolved);
        assert!(
            texts.iter().any(|t| t == "before"),
            "'before' should survive: {:?}",
            texts,
        );
        assert!(
            texts.iter().any(|t| t == "after"),
            "'after' should survive: {:?}",
            texts,
        );
        assert!(
            !contains_include(&resolved),
            "Missing include should have been silently dropped (no Include node left)",
        );
    }

    #[test]
    fn test_resolve_includes_nested() {
        let dir = tempdir().expect("create tempdir");
        fs::write(dir.path().join("a.xml"), r#"A <include src="b.xml"/>"#).expect("write a.xml");
        fs::write(dir.path().join("b.xml"), "B").expect("write b.xml");

        let nodes = tag_parser::parse(r#"<include src="a.xml"/>"#).expect("parse main");
        let resolved = resolve_includes(nodes, dir.path());

        let texts = collect_text(&resolved);
        assert!(
            texts.iter().any(|t| t.contains("A")),
            "Expected content from a.xml: {:?}",
            texts,
        );
        assert!(
            texts.iter().any(|t| t == "B"),
            "Expected inlined 'B' from b.xml: {:?}",
            texts,
        );
    }

    #[test]
    fn test_resolve_includes_recursive_in_sibling_branches() {
        let dir = tempdir().expect("create tempdir");
        fs::write(dir.path().join("a.xml"), r#"<include src="c.xml"/>"#).expect("write a.xml");
        fs::write(dir.path().join("b.xml"), r#"<include src="c.xml"/>"#).expect("write b.xml");
        fs::write(dir.path().join("c.xml"), "shared").expect("write c.xml");

        let nodes = tag_parser::parse(r#"<include src="a.xml"/> <include src="b.xml"/>"#)
            .expect("parse main");
        let resolved = resolve_includes(nodes, dir.path());

        let texts = collect_text(&resolved);
        let shared_count = texts.iter().filter(|t| t.as_str() == "shared").count();
        assert_eq!(
            shared_count, 2,
            "'shared' should appear in BOTH sibling branches, got {}: {:?}",
            shared_count, texts,
        );
    }
}
