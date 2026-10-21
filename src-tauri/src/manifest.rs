//! Recursive segment manifest data model and pure helpers.
//!
//! A [`Manifest`] describes a rendered TTS script as a tree of [`Segment`]s.
//! Leaf segments reference WAV files (relative to the manifest's own
//! directory); dynamic constructs (`Random`, `Scramble`) become first-class
//! tree nodes so the player can resolve them at playback time instead of at
//! render time. `Zone`/`Mark` are named boundary nodes the interaction layer
//! can target (jump-to/seek/display); they carry no audio of their own.
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

/// Current on-disk manifest format version (see [`Manifest::version`]).
/// v5: audio-only grammar. The interactive/visual segment variants
/// (`until`/`choice`/`rating`/`react`/`cond`/`section`/`visual` and the
/// beatmeter metadata) are gone, and `zone`/`mark` boundary nodes were added.
/// Bumped to 6 for the pocket-tts engine swap: every track rendered by the
/// previous engine is stale (different voices, sample rate, synthesis).
pub const MANIFEST_VERSION: u32 = 6;

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

    /// A named region of the timeline (`<zone name="…">`). Audio-transparent:
    /// `child` plays exactly as if the wrapper were absent. The name is
    /// unique within its script, so the interaction layer can address the
    /// zone (jump to it, read its position).
    Zone {
        name: String,
        child: Box<Segment>,
    },

    /// A named zero-length boundary (`<mark name="…"/>`) at the position
    /// between the surrounding segments. Carries no audio; useful as a
    /// seek/sync target for the interaction layer.
    Mark {
        name: String,
    },
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
    /// Manifest format version. Bumped when the on-disk layout of the
    /// segment tree changes in a way that requires re-rendering existing
    /// scripts (e.g. v3: `<include>` targets moved from the shared
    /// `tracks/imports/` side directory to each script's canonical track
    /// directory). Freshness checks compare against [`MANIFEST_VERSION`] so
    /// stale-format manifests rebuild once after an app update.
    pub version: u32,
    /// Hex SHA-256 of the source script bytes; used for staleness checks.
    pub hash: String,
    /// Digest of the script's glob `<include>` expansions (see
    /// `audio_renderer::glob_digest`); `None` when the script declares no
    /// glob include. A glob's match set is baked into the manifest at render
    /// time, so freshness must also compare the CURRENT expansion against
    /// this digest — adding/removing a matching file re-renders the script
    /// even though its own bytes didn't change.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glob_digest: Option<String>,
    /// Digest of every `<clip src>` file's CONTENT hash (see
    /// `audio_renderer::clips_digest`); `None` when the script references no
    /// clips. Clip audio is baked into the rendered WAVs, so editing a WAV on
    /// disk must re-render the script even though its own bytes didn't
    /// change — freshness compares the CURRENT digest against this one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clips_digest: Option<String>,
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
/// `render_nodes` carries.
#[derive(Clone)]
pub(crate) struct WalkCtx {
    pub speaker: String,
    pub volume_scale: f32,
    pub speed_scale: f32,
}

impl WalkCtx {
    pub(crate) fn root() -> Self {
        Self {
            speaker: "male".to_string(),
            volume_scale: 1.0,
            speed_scale: 1.0,
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

/// True if `node`'s subtree contains a construct that must become its own
/// manifest node — a dynamic option (`Random`/`Scramble`), an `Include`
/// (linked, not baked), or a `Zone`/`Mark` boundary (their positions must be
/// segment boundaries) — recursing through the context-carrying containers
/// (`Voice`/`Speed`/`Volume`/`Loop`/`Background`/`Overlay`).
///
/// Returns `false` for `Effect`/`Text`/`Pause`/`Tone`/`Clip`. In particular
/// dynamic nodes nested inside `<effect>` are intentionally **not** treated
/// as splits: the flat Stage-1 fallback renders them inline, so the manifest
/// keeps the whole `<effect>` block in a single `Static` segment. This is a
/// documented v1 limitation.
pub(crate) fn contains_split(node: &Node) -> bool {
    match node {
        Node::Random { .. }
        | Node::Scramble { .. }
        | Node::Include { .. }
        | Node::Zone { .. }
        | Node::Mark { .. } => true,

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
        | Node::Tone { .. }
        | Node::Clip { .. } => false,
    }
}

/// Best-effort nominal duration (seconds) of a segment tree.
///
/// `Import` contributes `0.0` (reading sub-manifests here would require file
/// I/O; the estimate is only used for UI display). `Background` contributes
/// `0.0` because it is concurrent with following siblings. `Zone` passes its
/// child's duration through; `Mark` is zero-length. This is a good-enough
/// estimate, not exact.
pub(crate) fn nominal_duration(seg: &Segment) -> f32 {
    match seg {
        Segment::Sequence { children } => children.iter().map(nominal_duration).sum(),
        Segment::Static { duration, .. } => *duration,
        Segment::Import { .. } | Segment::Background { .. } | Segment::Mark { .. } => 0.0,
        Segment::Random { options } => options.first().map(nominal_duration).unwrap_or(0.0),
        Segment::Scramble { options } => options.iter().map(nominal_duration).sum(),
        Segment::Loop { loops, child } => nominal_duration(child) * (*loops as f32),
        Segment::Zone { child, .. } => nominal_duration(child),
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
        Some("static") => {
            if let Some(f) = value
                .get("file")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
            {
                let abs = normalize_lexical(&base_dir.join(&f));
                value["file"] = json!(abs.to_string_lossy().to_string());
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
        Some("loop") | Some("zone") => {
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
    fn test_contains_split_dynamic_and_boundaries() {
        assert!(contains_split(&Node::Include {
            src: "x.xml".into()
        }));
        assert!(contains_split(&Node::Random { parts: vec![] }));
        assert!(contains_split(&Node::Scramble { parts: vec![] }));
        // Zone and mark are split points: their positions must land on
        // segment boundaries.
        assert!(contains_split(&Node::Zone {
            name: "warmup".into(),
            children: vec![],
        }));
        assert!(contains_split(&Node::Mark {
            name: "halfway".into()
        }));
    }

    #[test]
    fn test_contains_split_leaves_and_recurse() {
        assert!(!contains_split(&Node::Text("hi".into())));
        assert!(!contains_split(&Node::Pause { duration: 1.0 }));
        assert!(!contains_split(&Node::Clip {
            src: "click.wav".into(),
            volume: None,
            speed: None,
        }));
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
    fn test_relative_path() {
        let from = Path::new("/app/tracks/top1");
        let to = Path::new("/app/tracks/hypnos_sub/manifest.json");
        let rel = relative_path(from, to);
        assert_eq!(
            rel.to_string_lossy().replace('\\', "/"),
            "../hypnos_sub/manifest.json"
        );

        // Same directory.
        let from2 = Path::new("/app/tracks/top1");
        let to2 = Path::new("/app/tracks/top1/seg-000.wav");
        let rel2 = relative_path(from2, to2);
        assert_eq!(rel2.to_string_lossy().replace('\\', "/"), "seg-000.wav");

        // Sibling of ancestor.
        let from3 = Path::new("/app/tracks/hypnos_sub");
        let to3 = Path::new("/app/tracks/top1/manifest.json");
        let rel3 = relative_path(from3, to3);
        assert_eq!(
            rel3.to_string_lossy().replace('\\', "/"),
            "../top1/manifest.json"
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
    fn test_nominal_duration_zone_and_mark() {
        // Zone passes its child's duration through.
        let zone = Segment::Zone {
            name: "warmup".into(),
            child: Box::new(Segment::Static {
                file: "a.wav".into(),
                duration: 10.0,
            }),
        };
        assert!((nominal_duration(&zone) - 10.0).abs() < 1e-6);

        // Mark is zero-length.
        let mark = Segment::Mark {
            name: "peak".into(),
        };
        assert!((nominal_duration(&mark) - 0.0).abs() < 1e-6);

        // A sequence static+mark+static sums the statics only.
        let seq = Segment::Sequence {
            children: vec![
                Segment::Static {
                    file: "a.wav".into(),
                    duration: 2.0,
                },
                Segment::Mark {
                    name: "split".into(),
                },
                Segment::Static {
                    file: "b.wav".into(),
                    duration: 3.0,
                },
            ],
        };
        assert!((nominal_duration(&seq) - 5.0).abs() < 1e-6);
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
            version: MANIFEST_VERSION,
            hash: h1.clone(),
            glob_digest: None,
            clips_digest: None,
            script: "s.xml".into(),
            root: Segment::Sequence { children: vec![] },
        };
        let mp = dir.path().join("manifest.json");
        fs::write(&mp, serde_json::to_string_pretty(&manifest).unwrap()).unwrap();

        let reloaded: Manifest = serde_json::from_str(&fs::read_to_string(&mp).unwrap()).unwrap();
        assert_eq!(reloaded.hash, h1);
        assert_eq!(reloaded.version, MANIFEST_VERSION);
        // Unchanged bytes → not stale.
        assert_eq!(hash_bytes(&fs::read(&script).unwrap()), reloaded.hash);
        // Changed bytes → stale.
        assert_ne!(hash_bytes(b"different"), reloaded.hash);
    }

    #[test]
    fn test_manifest_v5_json_shape() {
        // The on-disk shape of the new segment types: snake_case `zone` /
        // `mark` tags, `child` on zone, bare `name` on mark, and no
        // removed variants can deserialize anymore.
        let root: Segment = serde_json::from_value(serde_json::json!({
            "type": "sequence",
            "children": [
                {"type": "static", "file": "seg-000.wav", "duration": 1.5},
                {"type": "mark", "name": "halfway"},
                {"type": "zone", "name": "cooldown", "child": {
                    "type": "static", "file": "seg-001.wav", "duration": 2.0
                }}
            ]
        }))
        .unwrap();
        let Segment::Sequence { children } = root else {
            panic!("expected sequence");
        };
        assert_eq!(children.len(), 3);
        assert!(matches!(&children[0], Segment::Static { duration, .. } if (*duration - 1.5).abs() < 1e-6));
        assert!(matches!(&children[1], Segment::Mark { name } if name == "halfway"));
        assert!(matches!(&children[2], Segment::Zone { name, .. } if name == "cooldown"));

        // Removed variants no longer parse as Segments.
        for gone in ["until", "choice", "rating", "react", "cond", "section", "visual"] {
            let v = serde_json::json!({"type": gone});
            assert!(
                serde_json::from_value::<Segment>(v).is_err(),
                "{gone} should not deserialize into a v5 Segment"
            );
        }
    }

    #[test]
    fn test_resolve_paths_recursive_zone_and_static() {
        use serde_json::json;
        let mut val = json!({
            "type": "sequence",
            "children": [
                {"type": "static", "file": "seg-000.wav", "duration": 1.0},
                {"type": "mark", "name": "mid"},
                {"type": "zone", "name": "tail", "child": {
                    "type": "static", "file": "seg-001.wav", "duration": 2.0
                }},
                {"type": "import", "manifest": "../imports/abcd/manifest.json"}
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
        // The mark passes through untouched.
        assert_eq!(children[1].get("name").unwrap().as_str().unwrap(), "mid");
        // The zone's nested static resolves through `child`.
        assert_eq!(
            children[2]
                .get("child")
                .unwrap()
                .get("file")
                .unwrap()
                .as_str()
                .unwrap()
                .replace('\\', "/"),
            "/app/tracks/top1/seg-001.wav"
        );
        assert_eq!(
            children[3]
                .get("manifest")
                .unwrap()
                .as_str()
                .unwrap()
                .replace('\\', "/"),
            "/app/tracks/imports/abcd/manifest.json"
        );
    }
}
