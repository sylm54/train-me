//! Recursive segment manifest data model and pure helpers.
//!
//! A [`Manifest`] describes a rendered TTS script as a tree of [`Segment`]s.
//! Leaf segments reference WAV files (relative to the manifest's own
//! directory); interactive constructs (`Until`, `Random`, `Scramble`,
//! `Choice`) become first-class tree nodes so the player can resolve them at
//! playback time instead of at render time.
//!
//! This module holds the *data* types plus pure helpers (path relativisation,
//! content hashing, the split-detector, the nominal-duration estimator). The
//! actual rendering walker lives on [`crate::audio_renderer::AudioRenderer`]
//! because it needs the TTS engine.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

use crate::audio_renderer::resolve_scalar;
use crate::tag_parser::Node;

// ============================================================================
// Segment tree
// ============================================================================

/// One node of the recursive segment tree.
///
/// All `file` / `manifest` paths are stored **relative to the manifest's own
/// directory** (same-directory WAVs are bare filenames; import references may
/// contain `..`). The `read_manifest` command resolves them to absolute paths
/// before handing the tree to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Segment {
    Sequence {
        children: Vec<Segment>,
    },

    /// A pre-rendered, flat WAV clip.
    Static {
        file: String,
        duration: f32,
    },

    /// Loop the inner clip until the user presses `button`. An optional
    /// `waiting_sound` is a separate WAV the player layers while waiting.
    Until {
        file: String,
        duration: f32,
        button: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        waiting_sound: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        waiting_sound_volume: Option<f32>,
    },

    /// Reference to another manifest (a deduplicated `<include>` target).
    Import {
        manifest: String,
    },

    /// Render exactly one randomly-selected option (chosen at playback).
    Random {
        options: Vec<Segment>,
    },

    /// Render all options in a randomly-shuffled order (order chosen at
    /// playback).
    Scramble {
        options: Vec<Segment>,
    },

    /// Interactive branch; the user picks one option.
    Choice {
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        options: Vec<ChoiceOption>,
    },

    /// Repeat `child` exactly `loops` times.
    Loop {
        loops: u32,
        child: Box<Segment>,
    },

    /// A background audio layer that plays concurrently with following
    /// foreground content. `volume` / `speed` are the raw attribute strings
    /// (kept so the player can re-apply them if it ever re-renders).
    Background {
        #[serde(skip_serializing_if = "Option::is_none")]
        volume: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        speed: Option<String>,
        layer: Box<Segment>,
    },

    /// Multiple layered parts mixed together.
    Overlay {
        #[serde(skip_serializing_if = "Option::is_none")]
        duration: Option<f32>,
        parts: Vec<OverlayPartSegment>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChoiceOption {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub segment: Segment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayPartSegment {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub looped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
    pub segment: Segment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    /// Manifest format version (currently `2`).
    pub version: u32,
    /// Hex SHA-256 of the source script bytes; used for staleness checks.
    pub hash: String,
    /// Script path relative to `agent_dir` (forward-slash normalised), or an
    /// absolute path if the script lives outside the agent dir.
    pub script: String,
    pub root: Segment,
}

// ============================================================================
// Walk context
// ============================================================================

/// Inherited rendering context threaded through the manifest walker.
///
/// Mirrors the (speaker, volume_scale, speed_scale) triple the flat
/// `render_nodes` carries, plus `forbid_pause` which is set inside
/// `<background>`/`<overlay>` to reject interactive nodes that can't be
/// pre-rendered.
#[derive(Clone)]
pub(crate) struct WalkCtx {
    pub speaker: String,
    pub volume_scale: f32,
    pub speed_scale: f32,
    pub forbid_pause: bool,
}

impl WalkCtx {
    pub(crate) fn root() -> Self {
        Self {
            speaker: "male".to_string(),
            volume_scale: 1.0,
            speed_scale: 1.0,
            forbid_pause: false,
        }
    }

    pub(crate) fn with_speaker(mut self, speaker: &str) -> Self {
        self.speaker = speaker.to_string();
        self
    }

    /// Multiply the volume scale by the parsed attribute value (clamped 0–1.5),
    /// matching the flat renderer.
    pub(crate) fn with_vol(self, volume: Option<&str>) -> Self {
        let v = resolve_scalar(volume, 1.0);
        Self {
            volume_scale: (self.volume_scale * v).clamp(0.0, 1.5),
            ..self
        }
    }

    /// Multiply the speed scale by the parsed attribute value (clamped 0.5–1.5),
    /// matching the flat renderer.
    pub(crate) fn with_speed(self, speed: Option<&str>) -> Self {
        let s = resolve_scalar(speed, 1.0);
        Self {
            speed_scale: (self.speed_scale * s).clamp(0.5, 1.5),
            ..self
        }
    }

    pub(crate) fn with_forbid_pause(mut self, v: bool) -> Self {
        self.forbid_pause = v;
        self
    }
}

// ============================================================================
// Pure helpers
// ============================================================================

/// Lowercase hex encoding of a byte slice (no external `hex` dependency).
pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// SHA-256 (hex) of a byte slice — used for `Manifest::hash`.
pub(crate) fn hash_bytes(bytes: &[u8]) -> String {
    hex_encode(&Sha256::digest(bytes))
}

/// First 8 hex chars of SHA-256 of an absolute path's string form. Two
/// includes pointing at the same absolute file collapse to the same import
/// directory regardless of how their `src` was written.
pub(crate) fn sha8_of_path(abs_path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(abs_path.to_string_lossy().as_bytes());
    hex_encode(&hasher.finalize()[..4])
}

/// Derive the on-disk manifest id from a script path relative to `agent_dir`.
///
/// Path separators become `_`, `.xml` is stripped, remaining non-alphanumeric
/// characters (except `_`/`-`) become `_`, and the result is truncated to 64
/// chars. Stable across all commands.
pub(crate) fn manifest_id(script_rel: &str) -> String {
    let normalized: String = script_rel
        .chars()
        .map(|c| if c == '/' || c == '\\' { '_' } else { c })
        .collect();
    let stripped = normalized.strip_suffix(".xml").unwrap_or(&normalized);
    let sanitized: String = stripped
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    sanitized.chars().take(64).collect()
}

/// Compute a relative path from `from_dir` (a directory) to `to` (a file or
/// dir). Both must be absolute and share the same prefix/root (true for
/// everything under the app data dir). No `pathdiff` dependency.
pub(crate) fn relative_path(from_dir: &Path, to: &Path) -> PathBuf {
    let from: Vec<Component> = from_dir.components().collect();
    let to: Vec<Component> = to.components().collect();

    let mut i = 0;
    while i < from.len() && i < to.len() && from[i] == to[i] {
        i += 1;
    }

    let mut result = PathBuf::new();
    for _ in i..from.len() {
        result.push("..");
    }
    for c in &to[i..] {
        result.push(c.as_os_str());
    }
    if result.as_os_str().is_empty() {
        result.push(".");
    }
    result
}

/// True if `node`'s subtree contains an interactive construct
/// (`Until`/`Random`/`Scramble`/`Choice`) or an `Include`, recursing through
/// the context-carrying containers (`Voice`/`Speed`/`Volume`/`Loop`/
/// `Background`/`Overlay`).
///
/// Returns `false` for `Effect`/`Text`/`Pause`/`Sound`/`Tone`. In particular
/// interactive nodes nested inside `<effect>` are intentionally **not** treated
/// as splits: the flat Stage-1 fallback renders them inline, so the manifest
/// keeps the whole `<effect>` block in a single `Static` segment. This is a
/// documented v1 limitation.
pub(crate) fn contains_split(node: &Node) -> bool {
    match node {
        Node::Until { .. }
        | Node::Random { .. }
        | Node::Scramble { .. }
        | Node::Choice { .. }
        | Node::Include { .. } => true,

        Node::Voice { children, .. }
        | Node::Speed { children, .. }
        | Node::Volume { children, .. }
        | Node::Loop { children, .. }
        | Node::Background { children, .. } => children.iter().any(contains_split),

        Node::Overlay { parts, .. } => parts.iter().any(|p| p.children.iter().any(contains_split)),

        // Leaves (and `<effect>` — see doc comment) never split.
        Node::Effect { .. }
        | Node::Text(_)
        | Node::Pause { .. }
        | Node::Sound { .. }
        | Node::Tone { .. } => false,
    }
}

/// Best-effort nominal duration (seconds) of a segment tree.
///
/// `Import` contributes `0.0` (reading sub-manifests here would require file
/// I/O; the estimate is only used for UI display). `Background` contributes
/// `0.0` because it is concurrent with following siblings. This is a
/// good-enough estimate, not exact.
pub(crate) fn nominal_duration(seg: &Segment) -> f32 {
    match seg {
        Segment::Sequence { children } => children.iter().map(nominal_duration).sum(),
        Segment::Static { duration, .. } | Segment::Until { duration, .. } => *duration,
        Segment::Import { .. } | Segment::Background { .. } => 0.0,
        Segment::Random { options } => options.first().map(nominal_duration).unwrap_or(0.0),
        Segment::Scramble { options } => options.iter().map(nominal_duration).sum(),
        Segment::Choice { options, .. } => options
            .first()
            .map(|o| nominal_duration(&o.segment))
            .unwrap_or(0.0),
        Segment::Loop { loops, child } => nominal_duration(child) * (*loops as f32),
        Segment::Overlay { duration, parts } => {
            if let Some(d) = duration {
                *d
            } else {
                parts
                    .iter()
                    .map(|p| nominal_duration(&p.segment))
                    .fold(0.0, f32::max)
            }
        }
    }
}

/// Lexically normalise a path: collapse `.` and `..` components without
/// touching the filesystem (unlike `Path::canonicalize`, which requires the
/// file to exist). Used by [`resolve_paths_recursive`] so consumers get clean
/// absolute paths even when a manifest stores a relative `..` reference.
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Recursively resolve every relative `file`/`manifest` path in a parsed
/// manifest JSON value to an **absolute** path, relative to the manifest's own
/// directory (`base_dir`). Imports are resolved to an absolute path but their
/// subtrees are *not* recursed (the frontend loads them lazily by calling
/// `read_manifest` again on the referenced path).
pub(crate) fn resolve_paths_recursive(value: &mut serde_json::Value, base_dir: &Path) {
    use serde_json::json;

    let ty = value
        .get("type")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());

    // Resolve this node's own relative paths.
    match ty.as_deref() {
        Some("static") | Some("until") => {
            if let Some(f) = value
                .get("file")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
            {
                let abs = normalize_lexical(&base_dir.join(&f));
                value["file"] = json!(abs.to_string_lossy().to_string());
            }
            if ty.as_deref() == Some("until") {
                if let Some(w) = value
                    .get("waiting_sound")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
                {
                    let abs = normalize_lexical(&base_dir.join(&w));
                    value["waiting_sound"] = json!(abs.to_string_lossy().to_string());
                }
            }
        }
        Some("import") => {
            if let Some(m) = value
                .get("manifest")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
            {
                let abs = normalize_lexical(&base_dir.join(&m));
                value["manifest"] = json!(abs.to_string_lossy().to_string());
            }
            // Imports are loaded lazily; do not recurse into them.
            return;
        }
        _ => {}
    }

    // Recurse into children, keyed by segment type.
    match ty.as_deref() {
        Some("sequence") => {
            if let Some(arr) = value.get_mut("children").and_then(|x| x.as_array_mut()) {
                for c in arr {
                    resolve_paths_recursive(c, base_dir);
                }
            }
        }
        Some("random") | Some("scramble") => {
            if let Some(arr) = value.get_mut("options").and_then(|x| x.as_array_mut()) {
                for c in arr {
                    resolve_paths_recursive(c, base_dir);
                }
            }
        }
        Some("choice") => {
            if let Some(arr) = value.get_mut("options").and_then(|x| x.as_array_mut()) {
                for opt in arr {
                    if let Some(seg) = opt.get_mut("segment") {
                        resolve_paths_recursive(seg, base_dir);
                    }
                }
            }
        }
        Some("loop") => {
            if let Some(seg) = value.get_mut("child") {
                resolve_paths_recursive(seg, base_dir);
            }
        }
        Some("background") => {
            if let Some(seg) = value.get_mut("layer") {
                resolve_paths_recursive(seg, base_dir);
            }
        }
        Some("overlay") => {
            if let Some(arr) = value.get_mut("parts").and_then(|x| x.as_array_mut()) {
                for part in arr {
                    if let Some(seg) = part.get_mut("segment") {
                        resolve_paths_recursive(seg, base_dir);
                    }
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tag_parser::OverlayPart;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_contains_split_interactive() {
        assert!(contains_split(&Node::Include {
            src: "x.xml".into()
        }));
        assert!(contains_split(&Node::Random { parts: vec![] }));
        assert!(contains_split(&Node::Scramble { parts: vec![] }));
        assert!(contains_split(&Node::Choice {
            prompt: None,
            options: vec![],
        }));
        assert!(contains_split(&Node::Until {
            button: "ok".into(),
            waiting_sound: None,
            waiting_sound_volume: None,
            pre_pause: None,
            post_pause: None,
            children: vec![],
        }));
    }

    #[test]
    fn test_contains_split_leaves_and_recurse() {
        assert!(!contains_split(&Node::Text("hi".into())));
        assert!(!contains_split(&Node::Pause { duration: 1.0 }));
        // Voice wrapping a Random still splits.
        assert!(contains_split(&Node::Voice {
            speaker: "male".into(),
            pitch: None,
            volume: None,
            speed: None,
            children: vec![Node::Random { parts: vec![] }],
        }));
        // Effect wrapping a Random does NOT split (documented v1 limitation).
        assert!(!contains_split(&Node::Effect {
            effect_type: "lowpass".into(),
            preset: None,
            cutoff: None,
            children: vec![Node::Random { parts: vec![] }],
        }));
        // Overlay part with a Random splits.
        assert!(contains_split(&Node::Overlay {
            duration: None,
            parts: vec![OverlayPart {
                looped: None,
                volume: None,
                speed: None,
                label: None,
                children: vec![Node::Random { parts: vec![] }],
            }],
        }));
    }

    #[test]
    fn test_manifest_id() {
        assert_eq!(manifest_id("conditioning/foo.xml"), "conditioning_foo");
        assert_eq!(manifest_id("a\\b\\c.xml"), "a_b_c");
        assert_eq!(manifest_id("no ext"), "no_ext");
        // Long paths are truncated.
        let long = "x".repeat(200);
        assert!(manifest_id(&long).len() <= 64);
    }

    #[test]
    fn test_hash_bytes_stable() {
        let a = hash_bytes(b"hello");
        let b = hash_bytes(b"hello");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert_ne!(a, hash_bytes(b"world"));
    }

    #[test]
    fn test_sha8_of_path_stable_and_short() {
        let p = Path::new("/tmp/foo.xml");
        assert_eq!(sha8_of_path(p), sha8_of_path(p));
        assert_eq!(sha8_of_path(p).len(), 8);
        assert_ne!(sha8_of_path(p), sha8_of_path(Path::new("/tmp/bar.xml")));
    }

    #[test]
    fn test_relative_path() {
        let from = Path::new("/app/tracks/top1");
        let to = Path::new("/app/tracks/imports/abcd/manifest.json");
        let rel = relative_path(from, to);
        assert_eq!(
            rel.to_string_lossy().replace('\\', "/"),
            "../imports/abcd/manifest.json"
        );

        // Same directory.
        let from2 = Path::new("/app/tracks/top1");
        let to2 = Path::new("/app/tracks/top1/seg-000.wav");
        let rel2 = relative_path(from2, to2);
        assert_eq!(rel2.to_string_lossy().replace('\\', "/"), "seg-000.wav");

        // Sibling of ancestor.
        let from3 = Path::new("/app/tracks/imports/abcd");
        let to3 = Path::new("/app/tracks/top1/manifest.json");
        let rel3 = relative_path(from3, to3);
        assert_eq!(
            rel3.to_string_lossy().replace('\\', "/"),
            "../../top1/manifest.json"
        );
    }

    #[test]
    fn test_nominal_duration() {
        let seq = Segment::Sequence {
            children: vec![
                Segment::Static {
                    file: "a.wav".into(),
                    duration: 2.0,
                },
                Segment::Random {
                    options: vec![
                        Segment::Static {
                            file: "b.wav".into(),
                            duration: 3.0,
                        },
                        Segment::Static {
                            file: "c.wav".into(),
                            duration: 5.0,
                        },
                    ],
                },
                Segment::Loop {
                    loops: 2,
                    child: Box::new(Segment::Static {
                        file: "d.wav".into(),
                        duration: 1.0,
                    }),
                },
            ],
        };
        // 2.0 (static) + 3.0 (first random option) + 2.0 (loop 2x of 1.0)
        assert!((nominal_duration(&seq) - 7.0).abs() < 1e-6);

        // Scramble sums all options; background contributes 0.
        let seq2 = Segment::Sequence {
            children: vec![
                Segment::Scramble {
                    options: vec![
                        Segment::Static {
                            file: "x.wav".into(),
                            duration: 1.0,
                        },
                        Segment::Static {
                            file: "y.wav".into(),
                            duration: 2.0,
                        },
                    ],
                },
                Segment::Background {
                    volume: None,
                    speed: None,
                    layer: Box::new(Segment::Static {
                        file: "bg.wav".into(),
                        duration: 100.0,
                    }),
                },
            ],
        };
        assert!((nominal_duration(&seq2) - 3.0).abs() < 1e-6);
    }

    #[test]
    fn test_freshness_hash_roundtrip() {
        // Writing a manifest then re-hashing the same bytes should match.
        let dir = tempdir().unwrap();
        let script = dir.path().join("s.xml");
        fs::write(&script, "<voice speaker=\"male\">hi</voice>").unwrap();
        let bytes = fs::read(&script).unwrap();
        let h1 = hash_bytes(&bytes);

        let manifest = Manifest {
            version: 2,
            hash: h1.clone(),
            script: "s.xml".into(),
            root: Segment::Sequence { children: vec![] },
        };
        let mp = dir.path().join("manifest.json");
        fs::write(&mp, serde_json::to_string_pretty(&manifest).unwrap()).unwrap();

        let reloaded: Manifest = serde_json::from_str(&fs::read_to_string(&mp).unwrap()).unwrap();
        assert_eq!(reloaded.hash, h1);
        // Unchanged bytes → not stale.
        assert_eq!(hash_bytes(&fs::read(&script).unwrap()), reloaded.hash);
        // Changed bytes → stale.
        assert_ne!(hash_bytes(b"different"), reloaded.hash);
    }

    #[test]
    fn test_resolve_paths_recursive_static_and_import() {
        use serde_json::json;
        let mut val = json!({
            "type": "sequence",
            "children": [
                {"type": "static", "file": "seg-000.wav", "duration": 1.0},
                {"type": "import", "manifest": "../imports/abcd/manifest.json"},
                {"type": "until", "file": "seg-001.wav", "duration": 2.0, "button": "ok"}
            ]
        });
        let base = Path::new("/app/tracks/top1");
        resolve_paths_recursive(&mut val, base);
        let children = val.get("children").unwrap().as_array().unwrap();
        assert_eq!(
            children[0]
                .get("file")
                .unwrap()
                .as_str()
                .unwrap()
                .replace('\\', "/"),
            "/app/tracks/top1/seg-000.wav"
        );
        assert_eq!(
            children[1]
                .get("manifest")
                .unwrap()
                .as_str()
                .unwrap()
                .replace('\\', "/"),
            "/app/tracks/imports/abcd/manifest.json"
        );
        assert_eq!(
            children[2]
                .get("file")
                .unwrap()
                .as_str()
                .unwrap()
                .replace('\\', "/"),
            "/app/tracks/top1/seg-001.wav"
        );
    }
}
