//! Parser for TTS tag markup language.
//!
//! Parses XML-like tags into an AST that can be rendered to audio.
//! Supports: voice, pause, sound, tone, effect, overlay, loop, background, until,
//! speed, volume tags.

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

    /// Play a sound effect.
    Sound {
        #[serde(rename = "type")]
        sound_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        volume: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        speed: Option<String>,
    },

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

    /// Background audio layer (plays concurrently with following foreground).
    Background {
        #[serde(skip_serializing_if = "Option::is_none")]
        volume: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        speed: Option<String>,
        children: Vec<Node>,
    },

    /// Interactive pause - renders inner content repeatedly until button press.
    /// In pre-rendered mode, renders once.
    Until {
        button: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        waiting_sound: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        waiting_sound_volume: Option<f32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pre_pause: Option<f32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        post_pause: Option<f32>,
        children: Vec<Node>,
    },

    /// Include another XML file at this point. Resolved by the audio renderer
    /// before rendering (see `audio_renderer::resolve_includes`).
    Include { src: String },
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
            "sound" => self.parse_sound_tag(),
            "tone" => self.parse_tone_tag(),
            "effect" => self.parse_effect_tag(),
            "include" => self.parse_include_tag(),
            "overlay" => self.parse_overlay_tag(),
            "loop" => self.parse_loop_tag(),
            "background" => self.parse_background_tag(),
            "until" => self.parse_until_tag(),
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

    fn parse_sound_tag(&mut self) -> Result<Node> {
        let attrs = self.read_attributes();
        self.skip_ws();
        let sound_type = attrs
            .get("type")
            .cloned()
            .unwrap_or_else(|| "beep".to_string());
        let volume = attrs.get("volume").cloned();
        let speed = attrs.get("speed").cloned();
        self.expect_str("/>")?;
        Ok(Node::Sound {
            sound_type,
            volume,
            speed,
        })
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
        let mut parts = Vec::new();

        while self.pos < self.input.len() {
            self.skip_ws();
            if self.peek_str("</overlay>") {
                break;
            }
            if self.peek_str("<part") {
                parts.push(self.parse_overlay_part()?);
            } else if self.peek_str("<") {
                // Non-part tags inside overlay are wrapped in an implicit part
                let node = self.parse_tag()?;
                parts.push(OverlayPart {
                    looped: None,
                    volume: None,
                    speed: None,
                    children: vec![node],
                });
            } else {
                // Text inside overlay is wrapped in an implicit part
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

        self.expect_closing("overlay")?;
        Ok(Node::Overlay { duration, parts })
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

    fn parse_until_tag(&mut self) -> Result<Node> {
        let attrs = self.read_attributes();
        let button = attrs
            .get("button")
            .cloned()
            .unwrap_or_else(|| "Continue".to_string());
        let waiting_sound = attrs.get("waiting-sound").cloned();
        let waiting_sound_volume = attrs
            .get("waiting-sound-volume")
            .and_then(|v| v.parse::<f32>().ok());
        let pre_pause = attrs.get("pre-pause").and_then(|v| v.parse::<f32>().ok());
        let post_pause = attrs.get("post-pause").and_then(|v| v.parse::<f32>().ok());

        self.expect_str(">")?;
        let children = self.parse_nodes()?;
        self.expect_closing("until")?;

        Ok(Node::Until {
            button,
            waiting_sound,
            waiting_sound_volume,
            pre_pause,
            post_pause,
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

/// Extract all plain text from a node tree (useful for getting the text to synthesize).
#[cfg(test)]
pub fn extract_text(nodes: &[Node]) -> String {
    let mut texts = Vec::new();
    for node in nodes {
        extract_text_recursive(node, &mut texts);
    }
    texts.join(" ")
}

#[cfg(test)]
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
        | Node::Until { children, .. } => {
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
        Node::Pause { .. } | Node::Sound { .. } | Node::Tone { .. } | Node::Include { .. } => {}
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
    fn test_parse_sound_tag() {
        let nodes = parse(r#"<sound type="beep" volume="0.5"/>"#).unwrap();
        match &nodes[0] {
            Node::Sound {
                sound_type, volume, ..
            } => {
                assert_eq!(sound_type, "beep");
                assert_eq!(volume.as_deref(), Some("0.5"));
            }
            _ => panic!("Expected Sound node"),
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
        let input = r#"<overlay><part><sound type="beep"/></part><part>Hello</part></overlay>"#;
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
        let input = r#"<background volume="0.5"><sound type="beep"/></background>"#;
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
    fn test_parse_until() {
        let input =
            r#"<until button="I'm ready" waiting-sound="heart_beat">Press the button</until>"#;
        let nodes = parse(input).unwrap();
        match &nodes[0] {
            Node::Until {
                button,
                waiting_sound,
                children,
                ..
            } => {
                assert_eq!(button, "I'm ready");
                assert_eq!(*waiting_sound, Some("heart_beat".to_string()));
                assert_eq!(children.len(), 1);
            }
            _ => panic!("Expected Until node"),
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
            <until button="I'm ready" waiting-sound="heart_beat">
                Press the Button.
            </until>
            Now take a deep breath
            <background><sound type="swoosh" volume="0.4"/></background>
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
    fn test_parse_comprehensive_example() {
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

  <effect type="filter" preset="lowpass" cutoff="800">
    <voice speaker="female2">
      And this voice is filtered.
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
        let result = parse(input);
        assert!(result.is_ok(), "Failed to parse: {:?}", result.err());
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
}
