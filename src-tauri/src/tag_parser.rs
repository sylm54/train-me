//! Parser for TTS tag markup language.
//!
//! Parses XML-like tags into an AST that can be rendered to audio. The
//! grammar is audio-only: voice, speed, volume, pause, tone, effect, overlay,
//! loop, background, random, scramble, include, clip, zone, mark.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

/// AST node for the TTS tag language.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Node {
    /// Plain text to be spoken.
    Text(String),

    /// Change speaking voice for inner content.
    Voice {
        speaker: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pitch: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        volume: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        speed: Option<String>,
        children: Vec<Node>,
    },

    /// Adjust speed of inner content.
    Speed { value: String, children: Vec<Node> },

    /// Adjust volume of inner content.
    Volume { value: String, children: Vec<Node> },

    /// Insert silence.
    Pause { duration: f32 },

    /// Play a background tone until end of segment.
    Tone {
        #[serde(rename = "type")]
        tone_type: String,
        preset: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        frequency: Option<f32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        volume: Option<String>,
    },

    /// Apply audio effect to inner content.
    Effect {
        #[serde(rename = "type")]
        effect_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        preset: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cutoff: Option<f32>,
        children: Vec<Node>,
    },

    /// Layer multiple audio parts.
    Overlay {
        #[serde(skip_serializing_if = "Option::is_none")]
        duration: Option<f32>,
        parts: Vec<OverlayPart>,
    },

    /// Repeat inner content N times.
    Loop { loops: u32, children: Vec<Node> },

    /// Render exactly one randomly-selected part (chosen at render time in the
    /// flat path; per-playback in the manifest path).
    Random { parts: Vec<OverlayPart> },

    /// Render all parts in a randomly-shuffled order (render time in flat path).
    Scramble { parts: Vec<OverlayPart> },

    /// Background audio layer (plays concurrently with following foreground).
    Background {
        #[serde(skip_serializing_if = "Option::is_none")]
        volume: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        speed: Option<String>,
        children: Vec<Node>,
    },

    /// Include another XML file at this point. Resolved by the audio renderer
    /// before rendering (see `audio_renderer::resolve_includes`).
    Include { src: String },

    /// Play a media file from the agent sandbox (WAV in v1). `src` resolves
    /// like an `<include>` target (script dir first, then the agent dir; no
    /// globs). The decoded audio is mixed into the surrounding static buffer,
    /// exactly where the tag sits — including inside `<background>` layers
    /// and `<overlay>` parts.
    Clip {
        src: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        volume: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        speed: Option<String>,
    },

    /// A named region of the timeline. Audio-transparent: children render
    /// exactly as if the wrapper were absent. The zone becomes a manifest
    /// `Zone` node at segment boundaries so the interaction layer can address
    /// it by name.
    Zone { name: String, children: Vec<Node> },

    /// A named zero-length boundary at this position. Becomes a manifest
    /// `Mark` node; carries no audio.
    Mark { name: String },
}

/// A part within an overlay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayPart {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub looped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
    pub children: Vec<Node>,
}

/// Parse a TTS tags document into an AST.
pub fn parse(input: &str) -> Result<Vec<Node>> {
    let mut parser = TagParser::new(input);
    parser.parse_nodes()
}

struct TagParser {
    input: Vec<char>,
    pos: usize,
}

impl TagParser {
    fn new(input: &str) -> Self {
        Self {
            input: input.chars().collect(),
            pos: 0,
        }
    }

    fn parse_nodes(&mut self) -> Result<Vec<Node>> {
        let mut nodes = Vec::new();
        while self.pos < self.input.len() {
            if self.peek_str("</") {
                break; // closing tag — return to parent
            }
            if self.peek_str("<!--") {
                self.skip_comment()?;
                continue;
            }
            if self.peek_str("<") {
                nodes.push(self.parse_tag()?);
            } else {
                nodes.push(self.parse_text()?);
            }
        }
        Ok(nodes)
    }

    fn parse_text(&mut self) -> Result<Node> {
        let mut text = String::new();
        while self.pos < self.input.len() && !self.peek_str("<") {
            text.push(self.input[self.pos]);
            self.pos += 1;
        }
        let trimmed = text.trim();
        if trimmed.is_empty() {
            // Return empty text node (will be filtered later)
            Ok(Node::Text(String::new()))
        } else {
            Ok(Node::Text(trimmed.to_string()))
        }
    }

    fn skip_comment(&mut self) -> Result<()> {
        self.expect_str("<!--")?;
        while self.pos + 2 < self.input.len() {
            if self.peek_str("-->") {
                self.expect_str("-->")?;
                return Ok(());
            }
            self.pos += 1;
        }
        bail!("Unterminated comment")
    }

    fn parse_tag(&mut self) -> Result<Node> {
        self.expect_str("<")?;
        self.skip_ws();
        let tag_name = self.read_tag_name()?;

        match tag_name.as_str() {
            "voice" => self.parse_voice_tag(),
            "speed" => self.parse_speed_tag(),
            "volume" => self.parse_volume_tag(),
            "pause" => self.parse_pause_tag(),
            "tone" => self.parse_tone_tag(),
            "effect" => self.parse_effect_tag(),
            "include" => self.parse_include_tag(),
            "overlay" => self.parse_overlay_tag(),
            "loop" => self.parse_loop_tag(),
            "background" => self.parse_background_tag(),
            "random" => self.parse_random_tag(),
            "scramble" => self.parse_scramble_tag(),
            "clip" => self.parse_clip_tag(),
            "zone" => self.parse_zone_tag(),
            "mark" => self.parse_mark_tag(),
            other => bail!("Unknown tag: <{}>", other),
        }
    }

    fn parse_voice_tag(&mut self) -> Result<Node> {
        let attrs = self.read_attributes();
        self.skip_ws();
        let speaker = attrs
            .get("speaker")
            .cloned()
            .unwrap_or_else(|| "male".to_string());
        let pitch = attrs.get("pitch").cloned();
        let volume = attrs.get("volume").cloned();
        let speed = attrs.get("speed").cloned();

        if self.peek_str("/>") {
            self.expect_str("/>")?;
            bail!("<voice> tag must have children");
        }
        self.expect_str(">")?;
        let children = self.parse_nodes()?;
        self.expect_closing("voice")?;

        Ok(Node::Voice {
            speaker,
            pitch,
            volume,
            speed,
            children: filter_empty_text(children),
        })
    }

    fn parse_speed_tag(&mut self) -> Result<Node> {
        let attrs = self.read_attributes();
        let value = attrs
            .get("value")
            .cloned()
            .unwrap_or_else(|| "1.0".to_string());

        if self.peek_str("/>") {
            self.expect_str("/>")?;
            bail!("<speed> tag must have children");
        }
        self.expect_str(">")?;
        let children = self.parse_nodes()?;
        self.expect_closing("speed")?;

        Ok(Node::Speed {
            value,
            children: filter_empty_text(children),
        })
    }

    fn parse_volume_tag(&mut self) -> Result<Node> {
        let attrs = self.read_attributes();
        let value = attrs
            .get("value")
            .cloned()
            .unwrap_or_else(|| "1.0".to_string());

        if self.peek_str("/>") {
            self.expect_str("/>")?;
            bail!("<volume> tag must have children");
        }
        self.expect_str(">")?;
        let children = self.parse_nodes()?;
        self.expect_closing("volume")?;

        Ok(Node::Volume {
            value,
            children: filter_empty_text(children),
        })
    }

    fn parse_pause_tag(&mut self) -> Result<Node> {
        let attrs = self.read_attributes();
        self.skip_ws();
        let duration = attrs
            .get("duration")
            .and_then(|v| v.parse::<f32>().ok())
            .unwrap_or(0.5);
        self.expect_str("/>")?;
        Ok(Node::Pause { duration })
    }

    fn parse_include_tag(&mut self) -> Result<Node> {
        let attrs = self.read_attributes();
        self.skip_ws();
        let src = attrs
            .get("src")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("<include> tag requires a 'src' attribute"))?;
        self.expect_str("/>")?;
        Ok(Node::Include { src })
    }

    /// Parse `<clip src="…" volume="…" speed="…"/>` — self-closing media
    /// paste from the sandbox.
    fn parse_clip_tag(&mut self) -> Result<Node> {
        let attrs = self.read_attributes();
        self.skip_ws();
        let src = attrs
            .get("src")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("<clip> tag requires a 'src' attribute"))?;
        if src.trim().is_empty() {
            bail!("<clip> has an empty 'src' attribute");
        }
        let volume = attrs.get("volume").cloned();
        let speed = attrs.get("speed").cloned();
        self.expect_str("/>")?;
        Ok(Node::Clip { src, volume, speed })
    }

    /// Parse `<zone name="…">…</zone>` — a named timeline region wrapping its
    /// (required) children.
    fn parse_zone_tag(&mut self) -> Result<Node> {
        let attrs = self.read_attributes();
        let name = attrs
            .get("name")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("<zone> tag requires a 'name' attribute"))?;
        if name.trim().is_empty() {
            bail!("<zone> has an empty 'name' attribute");
        }
        if self.peek_str("/>") {
            self.expect_str("/>")?;
            bail!("<zone> tag must have children");
        }
        self.expect_str(">")?;
        let children = self.parse_nodes()?;
        self.expect_closing("zone")?;
        Ok(Node::Zone {
            name,
            children: filter_empty_text(children),
        })
    }

    /// Parse `<mark name="…"/>` — a self-closing zero-length boundary.
    fn parse_mark_tag(&mut self) -> Result<Node> {
        let attrs = self.read_attributes();
        self.skip_ws();
        let name = attrs
            .get("name")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("<mark> tag requires a 'name' attribute"))?;
        if name.trim().is_empty() {
            bail!("<mark> has an empty 'name' attribute");
        }
        self.expect_str("/>")?;
        Ok(Node::Mark { name })
    }

    fn parse_tone_tag(&mut self) -> Result<Node> {
        let attrs = self.read_attributes();
        self.skip_ws();
        let tone_type = attrs
            .get("type")
            .cloned()
            .unwrap_or_else(|| "wave".to_string());
        let preset = attrs
            .get("preset")
            .cloned()
            .unwrap_or_else(|| "sine".to_string());
        let frequency = attrs.get("frequency").and_then(|v| v.parse::<f32>().ok());
        let volume = attrs.get("volume").cloned();
        self.expect_str("/>")?;
        Ok(Node::Tone {
            tone_type,
            preset,
            frequency,
            volume,
        })
    }

    fn parse_effect_tag(&mut self) -> Result<Node> {
        let attrs = self.read_attributes();
        let effect_type = attrs
            .get("type")
            .cloned()
            .unwrap_or_else(|| "echo".to_string());
        let preset = attrs.get("preset").cloned();
        let cutoff = attrs.get("cutoff").and_then(|v| v.parse::<f32>().ok());

        if self.peek_str("/>") {
            self.expect_str("/>")?;
            bail!("<effect> tag must have children");
        }
        self.expect_str(">")?;
        let children = self.parse_nodes()?;
        self.expect_closing("effect")?;

        Ok(Node::Effect {
            effect_type,
            preset,
            cutoff,
            children: filter_empty_text(children),
        })
    }

    fn parse_overlay_tag(&mut self) -> Result<Node> {
        let attrs = self.read_attributes();
        let duration = attrs.get("duration").and_then(|v| v.parse::<f32>().ok());

        self.expect_str(">")?;
        let parts = self.parse_parts_container("overlay")?;
        Ok(Node::Overlay { duration, parts })
    }

    /// Collect `<part>` children (wrapping stray tags/text in implicit parts)
    /// until the closing tag. Assumes the opening tag's `>` has already been
    /// consumed and any container-level attributes already read.
    fn parse_parts_container(&mut self, closing_tag: &str) -> Result<Vec<OverlayPart>> {
        let mut parts = Vec::new();

        while self.pos < self.input.len() {
            self.skip_ws();
            if self.peek_str(&format!("</{}>", closing_tag)) {
                break;
            }
            if self.peek_str("<part") {
                parts.push(self.parse_overlay_part()?);
            } else if self.peek_str("<") {
                // Non-part tags are wrapped in an implicit part
                let node = self.parse_tag()?;
                parts.push(OverlayPart {
                    looped: None,
                    volume: None,
                    speed: None,
                    children: vec![node],
                });
            } else {
                // Text is wrapped in an implicit part
                let node = self.parse_text()?;
                if let Node::Text(t) = &node {
                    if t.trim().is_empty() {
                        continue;
                    }
                }
                parts.push(OverlayPart {
                    looped: None,
                    volume: None,
                    speed: None,
                    children: vec![node],
                });
            }
        }

        self.expect_closing(closing_tag)?;
        Ok(parts)
    }

    fn parse_random_tag(&mut self) -> Result<Node> {
        let _attrs = self.read_attributes();
        self.expect_str(">")?;
        let parts = self.parse_parts_container("random")?;
        Ok(Node::Random { parts })
    }

    fn parse_scramble_tag(&mut self) -> Result<Node> {
        let _attrs = self.read_attributes();
        self.expect_str(">")?;
        let parts = self.parse_parts_container("scramble")?;
        Ok(Node::Scramble { parts })
    }

    fn parse_overlay_part(&mut self) -> Result<OverlayPart> {
        self.expect_str("<part")?;
        let attrs = self.read_attributes();
        let looped = attrs.get("looped").and_then(|v| v.parse::<bool>().ok());
        let volume = attrs.get("volume").cloned();
        let speed = attrs.get("speed").cloned();

        self.expect_str(">")?;
        let children = self.parse_nodes()?;
        self.expect_closing("part")?;

        Ok(OverlayPart {
            looped,
            volume,
            speed,
            children: filter_empty_text(children),
        })
    }

    fn parse_loop_tag(&mut self) -> Result<Node> {
        let attrs = self.read_attributes();
        let loops = attrs
            .get("loops")
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(2);

        self.expect_str(">")?;
        let children = self.parse_nodes()?;
        self.expect_closing("loop")?;

        Ok(Node::Loop {
            loops,
            children: filter_empty_text(children),
        })
    }

    fn parse_background_tag(&mut self) -> Result<Node> {
        let attrs = self.read_attributes();
        let volume = attrs.get("volume").cloned();
        let speed = attrs.get("speed").cloned();

        self.expect_str(">")?;
        let children = self.parse_nodes()?;
        self.expect_closing("background")?;

        Ok(Node::Background {
            volume,
            speed,
            children: filter_empty_text(children),
        })
    }

    // --- Helper methods ---

    fn peek_str(&self, s: &str) -> bool {
        let chars: Vec<char> = s.chars().collect();
        if self.pos + chars.len() > self.input.len() {
            return false;
        }
        &self.input[self.pos..self.pos + chars.len()] == &chars[..]
    }

    fn expect_str(&mut self, s: &str) -> Result<()> {
        let chars: Vec<char> = s.chars().collect();
        if self.pos + chars.len() > self.input.len() {
            bail!("Expected '{}' but reached end of input", s);
        }
        if &self.input[self.pos..self.pos + chars.len()] != &chars[..] {
            let context: String = self.input[self.pos..].iter().take(30).collect();
            bail!(
                "Expected '{}' at position {} but found: '{}'...",
                s,
                self.pos,
                context
            );
        }
        self.pos += chars.len();
        Ok(())
    }

    fn expect_closing(&mut self, tag: &str) -> Result<()> {
        self.skip_ws();
        self.expect_str("</")?;
        self.skip_ws();
        let found_tag = self.read_tag_name()?;
        if found_tag != tag {
            bail!("Expected closing tag </{}> but found </{}>", tag, found_tag);
        }
        self.skip_ws();
        self.expect_str(">")?;
        Ok(())
    }

    fn skip_ws(&mut self) {
        while self.pos < self.input.len() {
            match self.input[self.pos] {
                ' ' | '\t' | '\n' | '\r' => self.pos += 1,
                _ => break,
            }
        }
    }

    fn read_tag_name(&mut self) -> Result<String> {
        let mut name = String::new();
        while self.pos < self.input.len() {
            match self.input[self.pos] {
                'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => {
                    name.push(self.input[self.pos]);
                    self.pos += 1;
                }
                _ => break,
            }
        }
        if name.is_empty() {
            let context: String = self.input[self.pos..].iter().take(30).collect();
            bail!(
                "Expected tag name at position {} near: '{}'",
                self.pos,
                context
            );
        }
        Ok(name)
    }

    fn read_attributes(&mut self) -> std::collections::HashMap<String, String> {
        let mut attrs = std::collections::HashMap::new();
        loop {
            self.skip_ws();
            if self.pos >= self.input.len() || self.peek_str(">") || self.peek_str("/>") {
                break;
            }
            let key = match self.read_attr_name() {
                Ok(k) => k,
                Err(_) => break,
            };
            self.skip_ws();
            if self.peek_str("=") {
                self.expect_str("=").ok();
                self.skip_ws();
                let value = self.read_attr_value().unwrap_or_default();
                attrs.insert(key, value);
            } else {
                attrs.insert(key, "true".to_string());
            }
        }
        attrs
    }

    fn read_attr_name(&mut self) -> Result<String> {
        let mut name = String::new();
        while self.pos < self.input.len() {
            match self.input[self.pos] {
                'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => {
                    name.push(self.input[self.pos]);
                    self.pos += 1;
                }
                _ => break,
            }
        }
        if name.is_empty() {
            let context: String = self.input[self.pos..].iter().take(30).collect();
            bail!(
                "Expected attribute name at position {} near: '{}'",
                self.pos,
                context
            );
        }
        Ok(name)
    }

    fn read_attr_value(&mut self) -> Result<String> {
        self.skip_ws();
        if self.pos >= self.input.len() {
            bail!("Expected attribute value");
        }
        if self.input[self.pos] == '"' {
            self.pos += 1; // skip opening quote
            let mut value = String::new();
            while self.pos < self.input.len() && self.input[self.pos] != '"' {
                value.push(self.input[self.pos]);
                self.pos += 1;
            }
            if self.pos < self.input.len() {
                self.pos += 1; // skip closing quote
            }
            Ok(value)
        } else if self.input[self.pos] == '\'' {
            self.pos += 1;
            let mut value = String::new();
            while self.pos < self.input.len() && self.input[self.pos] != '\'' {
                value.push(self.input[self.pos]);
                self.pos += 1;
            }
            if self.pos < self.input.len() {
                self.pos += 1;
            }
            Ok(value)
        } else {
            // Unquoted value
            let mut value = String::new();
            while self.pos < self.input.len() {
                match self.input[self.pos] {
                    ' ' | '\t' | '\n' | '\r' | '>' | '/' => break,
                    _ => {
                        value.push(self.input[self.pos]);
                        self.pos += 1;
                    }
                }
            }
            Ok(value)
        }
    }
}

fn filter_empty_text(nodes: Vec<Node>) -> Vec<Node> {
    nodes
        .into_iter()
        .filter(|n| {
            if let Node::Text(t) = n {
                !t.is_empty()
            } else {
                true
            }
        })
        .collect()
}

/// Extract all plain text from a node tree (useful for getting the text to
/// synthesize). Boundary wrappers (`<zone>`) recurse; audio leaves
/// (`<pause>`/`<tone>`/`<clip>`/`<mark>`) contribute nothing.
///
/// Not referenced by the render paths since `<until>` (which surfaced its
/// text) left the grammar; kept for tests and the lint/later phases.
#[allow(dead_code)]
pub fn extract_text(nodes: &[Node]) -> String {
    let mut texts = Vec::new();
    for node in nodes {
        extract_text_recursive(node, &mut texts);
    }
    texts.join(" ")
}

fn extract_text_recursive(node: &Node, texts: &mut Vec<String>) {
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
        | Node::Zone { children, .. } => {
            for child in children {
                extract_text_recursive(child, texts);
            }
        }
        Node::Overlay { parts, .. } => {
            for part in parts {
                for child in &part.children {
                    extract_text_recursive(child, texts);
                }
            }
        }
        Node::Random { parts } | Node::Scramble { parts } => {
            for part in parts {
                for child in &part.children {
                    extract_text_recursive(child, texts);
                }
            }
        }
        Node::Pause { .. }
        | Node::Tone { .. }
        | Node::Include { .. }
        | Node::Clip { .. }
        | Node::Mark { .. } => {}
    }
}

// ============================================================================
// Semantic validation
// ============================================================================

/// Known tone presets accepted by `generate_tone`.
const VALID_TONE_PRESETS: &[&str] = &[
    "sine", "square", "sawtooth", "triangle", "whitenoise",
    "pinknoise", "brownnoise",
    "binaural_theta", "binaural_alpha", "binaural_beta", "binaural_delta",
];

/// Known effect types accepted by `apply_effect`.
const VALID_EFFECT_TYPES: &[&str] = &[
    "echo", "reverb", "filter",
];

/// Known reverb presets for the "reverb" effect.
const VALID_REVERB_PRESETS: &[&str] = &[
    "medium", "small_room", "large_hall", "cathedral", "plate",
];

/// Known echo presets for the "echo" effect.
const VALID_ECHO_PRESETS: &[&str] = &[
    "light", "medium", "heavy",
];

/// Known speaker names accepted by the TTS engine.
const VALID_SPEAKERS: &[&str] = &[
    "male", "male2", "male3", "male4", "male5",
    "female", "female2", "female3", "female4", "female5",
];

// ============================================================================
// Glob <include> helpers (pure; shared by the renderer and validators)
// ============================================================================

/// True when an `<include src>` is a glob pattern (contains `*` or `?`).
/// A glob expands to every matching file; one match is chosen per playback.
pub fn include_src_is_glob(src: &str) -> bool {
    src.contains('*') || src.contains('?')
}

/// Split a glob `src` into its (directory, file-name-pattern) parts on the
/// last separator. Returns `None` when there is no separator (bare pattern,
/// resolved against the base directory directly).
pub fn split_glob_src(src: &str) -> Option<(&str, &str)> {
    let normalized = src.replace('\\', "/");
    normalized
        .rfind('/')
        .map(|i| (&src[..i], &src[i + 1..]))
}

/// Case-insensitive wildcard match supporting `*` (any run of characters)
/// and `?` (exactly one character). Classic two-pointer algorithm — no regex.
pub fn wildcard_match(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            mark = ni;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Validate a parsed AST for semantic correctness.
///
/// This catches issues the parser doesn't: unknown tone presets, effect
/// types, effect presets, speaker names, and duplicate `<zone>`/`<mark>`
/// names. The renderer would trip on these with an opaque error; this gives
/// the writer agent a clear message at validation time instead.
///
/// Returns `Err` with a multi-line summary of all semantic problems found.
pub fn validate(nodes: &[Node]) -> Result<()> {
    let mut errors: Vec<String> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    validate_nodes(nodes, &mut errors, &mut Vec::new(), &mut names);
    if errors.is_empty() {
        Ok(())
    } else if errors.len() == 1 {
        bail!("{}", errors[0])
    } else {
        let summary = errors
            .iter()
            .enumerate()
            .map(|(i, e)| format!("  {}. {}", i + 1, e))
            .collect::<Vec<_>>()
            .join("\n");
        bail!("Semantic validation found {} errors:\n{}", errors.len(), summary)
    }
}

fn validate_nodes(
    nodes: &[Node],
    errors: &mut Vec<String>,
    breadcrumb: &mut Vec<String>,
    boundary_names: &mut Vec<String>,
) {
    for node in nodes {
        match node {
            Node::Text(_) => {}

            Node::Voice {
                speaker,
                children,
                ..
            } => {
                if !VALID_SPEAKERS.contains(&speaker.as_str()) {
                    errors.push(format!(
                        "Unknown speaker '{}'. Valid speakers: {}",
                        speaker,
                        VALID_SPEAKERS.join(", ")
                    ));
                }
                breadcrumb.push(format!("<voice speaker=\"{}\">", speaker));
                validate_nodes(children, errors, breadcrumb, boundary_names);
                breadcrumb.pop();
            }

            Node::Speed { children, .. } | Node::Volume { children, .. } => {
                breadcrumb.push("<speed>|<volume>".to_string());
                validate_nodes(children, errors, breadcrumb, boundary_names);
                breadcrumb.pop();
            }

            Node::Tone { preset, .. } => {
                if !VALID_TONE_PRESETS.contains(&preset.as_str()) {
                    let near = breadcrumb.last().map(|s| s.as_str()).unwrap_or("top-level");
                    errors.push(format!(
                        "Unknown tone preset '{}' in <tone preset=\"{}\"> (inside {}). Valid presets: {}",
                        preset,
                        preset,
                        near,
                        VALID_TONE_PRESETS.join(", ")
                    ));
                }
            }

            Node::Effect {
                effect_type,
                preset,
                children,
                ..
            } => {
                if !VALID_EFFECT_TYPES.contains(&effect_type.as_str()) {
                    errors.push(format!(
                        "Unknown effect type '{}'. Valid types: {}",
                        effect_type,
                        VALID_EFFECT_TYPES.join(", ")
                    ));
                } else if effect_type == "echo" {
                    if let Some(p) = preset {
                        if !VALID_ECHO_PRESETS.contains(&p.as_str()) {
                            errors.push(format!(
                                "Unknown echo preset '{}'. Valid presets: {}",
                                p,
                                VALID_ECHO_PRESETS.join(", ")
                            ));
                        }
                    }
                } else if effect_type == "reverb" {
                    if let Some(p) = preset {
                        if !VALID_REVERB_PRESETS.contains(&p.as_str()) {
                            errors.push(format!(
                                "Unknown reverb preset '{}'. Valid presets: {}",
                                p,
                                VALID_REVERB_PRESETS.join(", ")
                            ));
                        }
                    }
                }
                breadcrumb.push(format!("<effect type=\"{}\">", effect_type));
                validate_nodes(children, errors, breadcrumb, boundary_names);
                breadcrumb.pop();
            }

            Node::Include { src } => {
                if src.is_empty() {
                    errors.push("<include> has an empty 'src' attribute".to_string());
                } else if include_src_is_glob(src) {
                    // Wildcards are only expanded over one directory; reject
                    // patterns that would need recursive directory matching.
                    if let Some((dir, _)) = split_glob_src(src) {
                        if dir.contains('*') || dir.contains('?') {
                            errors.push(format!(
                                "Wildcards in <include src=\"{}\"> are only allowed in the file name, not in directories",
                                src
                            ));
                        }
                    }
                }
            }

            Node::Clip { src, .. } => {
                if src.is_empty() {
                    errors.push("<clip> has an empty 'src' attribute".to_string());
                } else if include_src_is_glob(src) {
                    errors.push(format!(
                        "Wildcards are not allowed in <clip src=\"{}\"> — point at one file",
                        src
                    ));
                }
            }

            Node::Zone { name, children } => {
                // Zone and mark names share one namespace per script: both
                // are interaction-layer addresses, so a collision between a
                // zone and a mark is just as ambiguous as a duplicate zone.
                if boundary_names.iter().any(|n| n == name) {
                    errors.push(format!(
                        "Duplicate name '{}' on a <zone>/<mark> — names must be unique within a script",
                        name
                    ));
                } else {
                    boundary_names.push(name.clone());
                }
                breadcrumb.push(format!("<zone name=\"{}\">", name));
                validate_nodes(children, errors, breadcrumb, boundary_names);
                breadcrumb.pop();
            }

            Node::Mark { name } => {
                if boundary_names.iter().any(|n| n == name) {
                    errors.push(format!(
                        "Duplicate name '{}' on a <zone>/<mark> — names must be unique within a script",
                        name
                    ));
                } else {
                    boundary_names.push(name.clone());
                }
            }

            Node::Loop { children, .. } => {
                breadcrumb.push("<loop>".to_string());
                validate_nodes(children, errors, breadcrumb, boundary_names);
                breadcrumb.pop();
            }

            Node::Background { children, .. } => {
                breadcrumb.push("<background>".to_string());
                validate_nodes(children, errors, breadcrumb, boundary_names);
                breadcrumb.pop();
            }

            Node::Overlay { parts, .. }
            | Node::Random { parts }
            | Node::Scramble { parts } => {
                for part in parts {
                    validate_nodes(&part.children, errors, breadcrumb, boundary_names);
                }
            }

            Node::Pause { .. } => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_text() {
        let nodes = parse("Hello world").unwrap();
        assert_eq!(nodes.len(), 1);
        assert!(matches!(&nodes[0], Node::Text(t) if t == "Hello world"));
    }

    #[test]
    fn test_parse_voice_tag() {
        let input = r#"<voice speaker="male">Hello world</voice>"#;
        let nodes = parse(input).unwrap();
        assert_eq!(nodes.len(), 1);
        match &nodes[0] {
            Node::Voice {
                speaker, children, ..
            } => {
                assert_eq!(speaker, "male");
                assert_eq!(children.len(), 1);
            }
            _ => panic!("Expected Voice node"),
        }
    }

    #[test]
    fn test_parse_pause_tag() {
        let nodes = parse(r#"<pause duration="1.5"/>"#).unwrap();
        match &nodes[0] {
            Node::Pause { duration } => assert_eq!(*duration, 1.5),
            _ => panic!("Expected Pause node"),
        }
    }

    #[test]
    fn test_removed_tags_are_unknown() {
        // The grammar is audio-only: interactive/visual/section/sound tags
        // no longer parse at all.
        for gone in [
            r#"<sound type="beep"/>"#,
            r#"<until button="go">x</until>"#,
            r#"<choice><part>a</part></choice>"#,
            r#"<rating min="1" max="5"/>"#,
            r#"<react button="b"><part role="main">a</part></react>"#,
            r#"<if cond="a">x</if>"#,
            r#"<else>x</else>"#,
            "<intro>x</intro>",
            "<main>x</main>",
            "<outro>x</outro>",
            r#"<beatmeter bpm="120">x</beatmeter>"#,
            r#"<visual>x</visual>"#,
            r#"<caption>x</caption>"#,
        ] {
            assert!(
                parse(gone).is_err(),
                "removed tag should not parse anymore: {gone}"
            );
        }
    }

    #[test]
    fn test_parse_tone_tag() {
        let nodes =
            parse(r#"<tone type="wave" preset="sine" frequency="440" volume="0.3"/>"#).unwrap();
        match &nodes[0] {
            Node::Tone {
                tone_type,
                preset,
                frequency,
                volume,
            } => {
                assert_eq!(tone_type, "wave");
                assert_eq!(preset, "sine");
                assert_eq!(*frequency, Some(440.0));
                assert_eq!(volume.as_deref(), Some("0.3"));
            }
            _ => panic!("Expected Tone node"),
        }
    }

    #[test]
    fn test_parse_nested() {
        let input = r#"<voice speaker="female">Hello <pause duration="0.5"/> World</voice>"#;
        let nodes = parse(input).unwrap();
        match &nodes[0] {
            Node::Voice {
                speaker, children, ..
            } => {
                assert_eq!(speaker, "female");
                assert_eq!(children.len(), 3); // Text, Pause, Text
            }
            _ => panic!("Expected Voice node"),
        }
    }

    #[test]
    fn test_parse_overlay() {
        let input = r#"<overlay><part><pause duration="1"/></part><part>Hello</part></overlay>"#;
        let nodes = parse(input).unwrap();
        match &nodes[0] {
            Node::Overlay { parts, .. } => {
                assert_eq!(parts.len(), 2);
            }
            _ => panic!("Expected Overlay node"),
        }
    }

    #[test]
    fn test_parse_loop() {
        let nodes = parse(r#"<loop loops="3">Say this three times</loop>"#).unwrap();
        match &nodes[0] {
            Node::Loop { loops, .. } => assert_eq!(*loops, 3),
            _ => panic!("Expected Loop node"),
        }
    }

    #[test]
    fn test_parse_background() {
        let input = r#"<background volume="0.5"><pause duration="1"/></background>"#;
        let nodes = parse(input).unwrap();
        match &nodes[0] {
            Node::Background {
                volume, children, ..
            } => {
                assert_eq!(volume.as_deref(), Some("0.5"));
                assert_eq!(children.len(), 1);
            }
            _ => panic!("Expected Background node"),
        }
    }

    #[test]
    fn test_parse_effect() {
        let input = r#"<effect type="reverb" preset="large_hall">Hello</effect>"#;
        let nodes = parse(input).unwrap();
        match &nodes[0] {
            Node::Effect {
                effect_type,
                preset,
                ..
            } => {
                assert_eq!(effect_type, "reverb");
                assert_eq!(*preset, Some("large_hall".to_string()));
            }
            _ => panic!("Expected Effect node"),
        }
    }

    #[test]
    fn test_parse_speed_volume() {
        let input = r#"<speed value="1.2"><volume value="0.8">Hello</volume></speed>"#;
        let nodes = parse(input).unwrap();
        match &nodes[0] {
            Node::Speed { value, children } => {
                assert_eq!(value, "1.2");
                match &children[0] {
                    Node::Volume { value, .. } => assert_eq!(value, "0.8"),
                    _ => panic!("Expected Volume node"),
                }
            }
            _ => panic!("Expected Speed node"),
        }
    }

    #[test]
    fn test_extract_text() {
        let input = r#"<voice speaker="male">Hello <pause duration="0.5"/>World</voice>"#;
        let nodes = parse(input).unwrap();
        let text = extract_text(&nodes);
        assert_eq!(text, "Hello World");
    }

    #[test]
    fn test_parse_full_example() {
        let input = r#"<voice speaker="male" volume="0.8">
            <tone type="noise" preset="pinknoise" volume="0.15"/>
            Welcome to the exercise.
            Now take a deep breath
            <background><pause duration="1"/></background>
            and let it go slowly.
        </voice>"#;
        let result = parse(input);
        assert!(
            result.is_ok(),
            "Failed to parse full example: {:?}",
            result.err()
        );
        let nodes = result.unwrap();
        assert_eq!(nodes.len(), 1);
    }

    #[test]
    fn test_parse_comment() {
        let input = r#"Hello <!-- this is a comment --> World"#;
        let nodes = parse(input).unwrap();
        let text = extract_text(&nodes);
        assert_eq!(text, "Hello World");
    }

    #[test]
    fn test_unknown_tag_errors() {
        let input = r#"<unknowntag>test</unknowntag>"#;
        let result = parse(input);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Unknown tag"));
    }

    #[test]
    fn test_empty_input() {
        let nodes = parse("").unwrap();
        assert!(nodes.is_empty());
    }

    #[test]
    fn test_parse_include_tag() {
        let nodes = parse(r#"<include src="foo.xml"/>"#).unwrap();
        assert_eq!(nodes.len(), 1);
        match &nodes[0] {
            Node::Include { src } => assert_eq!(src, "foo.xml"),
            _ => panic!("Expected Include node"),
        }
    }

    #[test]
    fn test_parse_include_missing_src() {
        let result = parse(r#"<include/>"#);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("src"),
            "Error should mention missing src attribute: {}",
            err,
        );
    }

    #[test]
    fn test_parse_include_not_self_closing() {
        let result = parse(r#"<include src="foo.xml"></include>"#);
        assert!(
            result.is_err(),
            "Non-self-closing <include> should error; got {:?}",
            result,
        );
    }

    #[test]
    fn test_parse_clip_tag() {
        let nodes = parse(r#"<clip src="sfx/click.wav" volume="0.4" speed="1.2"/>"#).unwrap();
        match &nodes[0] {
            Node::Clip { src, volume, speed } => {
                assert_eq!(src, "sfx/click.wav");
                assert_eq!(volume.as_deref(), Some("0.4"));
                assert_eq!(speed.as_deref(), Some("1.2"));
            }
            _ => panic!("Expected Clip node"),
        }
        validate(&nodes).unwrap();
    }

    #[test]
    fn test_parse_clip_requires_src() {
        assert!(parse("<clip/>").is_err());
        let err = parse(r#"<clip src="  "/>"#).unwrap_err().to_string();
        assert!(err.contains("src"), "unexpected error: {err}");
        // Not self-closing is a structural error too.
        assert!(parse(r#"<clip src="a.wav"></clip>"#).is_err());
    }

    #[test]
    fn test_validate_rejects_clip_glob() {
        let nodes = parse(r#"<clip src="sfx/*.wav"/>"#).unwrap();
        let err = validate(&nodes).unwrap_err().to_string();
        assert!(err.contains("Wildcards"), "unexpected error: {err}");
    }

    #[test]
    fn test_parse_zone() {
        let nodes = parse(r#"<zone name="warmup"><voice speaker="male">Breathe.</voice></zone>"#)
            .unwrap();
        match &nodes[0] {
            Node::Zone { name, children } => {
                assert_eq!(name, "warmup");
                assert_eq!(children.len(), 1);
                assert!(matches!(&children[0], Node::Voice { .. }));
            }
            _ => panic!("Expected Zone node"),
        }
        validate(&nodes).unwrap();
        // Zone text is spoken (audio-transparent wrapper).
        assert_eq!(extract_text(&nodes), "Breathe.");
    }

    #[test]
    fn test_parse_zone_requires_name_and_children() {
        assert!(parse("<zone>x</zone>").is_err(), "missing name");
        let err = parse(r#"<zone name="  ">x</zone>"#).unwrap_err().to_string();
        assert!(err.contains("name"), "unexpected error: {err}");
        assert!(parse(r#"<zone name="a"/>"#).is_err(), "self-closing zone");
    }

    #[test]
    fn test_parse_mark() {
        let nodes = parse(r#"Before <mark name="halfway"/> After"#).unwrap();
        assert_eq!(nodes.len(), 3);
        assert!(matches!(&nodes[1], Node::Mark { name } if name == "halfway"));
        // A mark contributes no text.
        assert_eq!(extract_text(&nodes), "Before After");
        validate(&nodes).unwrap();
    }

    #[test]
    fn test_parse_mark_requires_name() {
        assert!(parse("<mark/>").is_err(), "missing name");
        let err = parse(r#"<mark name=""/>"#).unwrap_err().to_string();
        assert!(err.contains("name"), "unexpected error: {err}");
        assert!(parse(r#"<mark name="a"></mark>"#).is_err(), "not self-closing");
    }

    #[test]
    fn test_validate_rejects_duplicate_boundary_names() {
        // zone + zone
        let nodes = parse(
            r#"<zone name="a">x</zone><zone name="a">y</zone>"#,
        )
        .unwrap();
        let err = validate(&nodes).unwrap_err().to_string();
        assert!(err.contains("Duplicate name"), "unexpected error: {err}");

        // mark + mark
        let nodes = parse(r#"<mark name="m"/><mark name="m"/>"#).unwrap();
        assert!(validate(&nodes).is_err());

        // zone + mark collide (one namespace)
        let nodes = parse(r#"<zone name="z">x</zone><mark name="z"/>"#).unwrap();
        let err = validate(&nodes).unwrap_err().to_string();
        assert!(err.contains("Duplicate name"), "unexpected error: {err}");

        // Nested duplicates count too.
        let nodes = parse(r#"<zone name="outer"><mark name="outer"/></zone>"#).unwrap();
        assert!(validate(&nodes).is_err());

        // Distinct names are fine, including across nesting.
        let nodes =
            parse(r#"<zone name="outer"><mark name="inner"/></zone><mark name="after"/>"#).unwrap();
        validate(&nodes).unwrap();
    }

    #[test]
    fn test_wildcard_match() {
        assert!(wildcard_match("*.xml", "a.xml"));
        assert!(wildcard_match("*.xml", "A.XML")); // case-insensitive
        assert!(!wildcard_match("*.xml", "a.txt"));
        assert!(!wildcard_match("*.xml", "a.xml.bak"));
        assert!(wildcard_match("tease-?.xml", "tease-3.xml"));
        assert!(!wildcard_match("tease-?.xml", "tease-33.xml"));
        assert!(wildcard_match("*", "anything"));
        assert!(wildcard_match("a*b*c", "aXXbYYc"));
        assert!(!wildcard_match("a*b*c", "aXXbYY"));
        assert!(wildcard_match("", ""));
        assert!(!wildcard_match("", "x"));
    }

    #[test]
    fn test_split_glob_src() {
        assert_eq!(split_glob_src("dir/*.xml"), Some(("dir", "*.xml")));
        assert_eq!(split_glob_src("a\\b/*.xml"), Some(("a\\b", "*.xml")));
        assert_eq!(split_glob_src("*.xml"), None);
    }

    #[test]
    fn test_validate_glob_include_directory_wildcard_rejected() {
        let nodes = parse(r#"<include src="hy*nos/*.xml"/>"#).unwrap();
        let err = validate(&nodes).unwrap_err().to_string();
        assert!(
            err.contains("only allowed in the file name"),
            "unexpected error: {err}"
        );
        // Wildcard in the file name alone is fine.
        let ok = parse(r#"<include src="hypnos/*.xml"/>"#).unwrap();
        assert!(validate(&ok).is_ok());
    }

    #[test]
    fn test_parse_random() {
        let input = r#"<random>
  <part>You feel a warm glow.</part>
  <part>A cool breeze sweeps over you.</part>
</random>"#;
        let nodes = parse(input).unwrap();
        match &nodes[0] {
            Node::Random { parts } => {
                assert_eq!(parts.len(), 2);
                assert_eq!(parts[0].children.len(), 1);
                assert_eq!(parts[1].children.len(), 1);
            }
            _ => panic!("Expected Random node"),
        }
    }

    #[test]
    fn test_parse_scramble() {
        let input = r#"<scramble>
  <part>Inhale deeply.</part>
  <part>Hold for a moment.</part>
  <part>Exhale slowly.</part>
</scramble>"#;
        let nodes = parse(input).unwrap();
        match &nodes[0] {
            Node::Scramble { parts } => {
                assert_eq!(parts.len(), 3);
                for part in parts {
                    assert_eq!(part.children.len(), 1);
                }
            }
            _ => panic!("Expected Scramble node"),
        }
    }

    #[test]
    fn test_parse_random_implicit_part() {
        let input = r#"<random>
  Bare text here
  <part>Explicit part</part>
  <pause duration="1"/>
</random>"#;
        let nodes = parse(input).unwrap();
        match &nodes[0] {
            Node::Random { parts } => {
                // Implicit text part, explicit part, implicit tag-wrapped part
                assert_eq!(parts.len(), 3);
                assert_eq!(parts[0].children.len(), 1);
                assert_eq!(parts[1].children.len(), 1);
                assert!(matches!(&parts[2].children[0], Node::Pause { .. }));
            }
            _ => panic!("Expected Random node"),
        }
    }

    #[test]
    fn test_validate_allows_repeated_includes() {
        // The same src may appear any number of times in one file; only true
        // cycles (an include back to an ancestor) are rejected, and those are
        // detected where includes are resolved across files, not in this
        // per-file semantic pass.
        let nodes = parse(
            r#"<include src="foo.xml"/>
               <voice speaker="female">between</voice>
               <include src="foo.xml"/>"#,
        )
        .unwrap();
        validate(&nodes).unwrap();
    }
}
