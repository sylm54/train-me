//! App settings: API keys, per-agent model config, and UI prefs.
//!
//! Persisted as pretty-printed JSON at `<data_dir>/settings.json` (the app
//! data dir root, next to `agent_data/` and `state/` — outside the agent's
//! writable sandbox so the agent cannot read the API keys). Read/written by
//! the UI via the `get_settings` / `set_settings` Tauri commands; the
//! frontend store (`src/lib/settings.ts`) is a thin async wrapper around
//! them.
//!
//! The Rust structs mirror the TS `AgentSettings` type in
//! `src/lib/types.ts` exactly (serde `camelCase` rename). Parsing is
//! tolerant: every field has a default, so a missing field (older file,
//! hand-edit) yields the default instead of failing the load, and unknown
//! fields are ignored (forward compatible). On parse failure the defaults
//! are used — matching the frontend's old behaviour when localStorage held
//! unparsable JSON.
//!
//! `reset_app_data` intentionally does NOT touch this file: its contract is
//! to preserve the API keys / per-agent model selection.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

// ============================================================================
// On-disk shape (mirrors src/lib/types.ts)
// ============================================================================

/// Per-agent provider/model configuration. Mirrors `AgentModelConfig`.
///
/// `provider` / `reasoning_effort` are plain strings (rather than enums) so
/// an unknown future value in the file round-trips instead of failing the
/// whole load (which would discard the API keys on the next save). The
/// frontend's TS unions are the real validators.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentModelConfig {
    /// `"openrouter"` or `"openai"`.
    pub provider: String,
    /// Exact model string sent to the provider API.
    pub model: String,
    /// Reasoning effort (`"xhigh" | "high" | "medium" | "low" | "minimal" |
    /// "none"`). Absent = reasoning disabled — skipped in the JSON so the
    /// on-disk shape matches what the TS side writes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

impl Default for AgentModelConfig {
    fn default() -> Self {
        Self {
            provider: "openrouter".into(),
            // Must track `DEFAULT_MODEL_ID.openrouter` (first OpenRouter
            // preset in `src/lib/models.ts`).
            model: "z-ai/glm-5.3-flash".into(),
            reasoning_effort: None,
        }
    }
}

/// Chat behaviour settings. Mirrors `ChatSettings`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatSettings {
    /// % of the context window at which auto-compact fires (50–95).
    pub compact_threshold_pct: u32,
    /// Manual context-window override in tokens; 0 = resolve automatically.
    pub context_window_override: u32,
    /// Recent user/assistant turns kept live when compacting.
    pub compact_keep_turns: u32,
    /// Minutes of inactivity before an idle chat auto-archives; 0 = off.
    pub idle_clear_minutes: u32,
    /// Chime when the agent finishes a response.
    pub completion_sound: bool,
}

impl Default for ChatSettings {
    fn default() -> Self {
        Self {
            compact_threshold_pct: 85,
            context_window_override: 0,
            compact_keep_turns: 6,
            idle_clear_minutes: 240,
            completion_sound: true,
        }
    }
}

/// Conditioning playback settings. Mirrors `PlaybackSettings`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct PlaybackSettings {
    /// Signed beat-click scheduling offset in ms.
    pub beat_offset_ms: i64,
}

impl Default for PlaybackSettings {
    fn default() -> Self {
        Self { beat_offset_ms: 0 }
    }
}

/// Audio rendering settings. Mirrors `AudioSettings`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioSettings {
    /// Pre-render every script shortly after startup.
    pub auto_prerender: bool,
    /// Show the floating render-progress pill while rendering.
    pub show_render_pill: bool,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            auto_prerender: true,
            show_render_pill: true,
        }
    }
}

/// Complete persisted settings. Mirrors `AgentSettings`.
///
/// `api_keys` mirrors the TS `Partial<Record<ProviderName, string>>`: an
/// absent entry = not set. The value stays an `Option` so an explicit
/// `null` (hand-edited file) parses instead of failing the whole load.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSettings {
    /// API keys indexed by provider (`"openrouter"` / `"openai"`).
    pub api_keys: HashMap<String, Option<String>>,
    /// Per-agent config, keyed by agent name (`"main"`).
    pub agents: HashMap<String, AgentModelConfig>,
    /// Chat behaviour (context limit, compaction, idle clear).
    pub chat: ChatSettings,
    /// Conditioning playback settings (beat offset, etc.).
    pub playback: PlaybackSettings,
    /// Audio rendering settings (background pre-rendering).
    pub audio: AudioSettings,
    /// Whether the user has completed the onboarding wizard.
    pub onboarded: bool,
}

impl AgentSettings {
    /// Defaults matching the frontend's `DEFAULT_SETTINGS` (a fresh install:
    /// no keys, the default OpenRouter model, stock UI prefs, onboarding
    /// pending).
    pub fn with_default_agent() -> Self {
        Self {
            api_keys: HashMap::new(),
            agents: HashMap::from([("main".to_string(), AgentModelConfig::default())]),
            chat: ChatSettings::default(),
            playback: PlaybackSettings::default(),
            audio: AudioSettings::default(),
            onboarded: false,
        }
    }

    /// Load from disk. A missing or unparsable file yields the defaults;
    /// missing fields fall back to their defaults per-field. The `main`
    /// agent slot is always populated (the frontend indexes it unguarded).
    pub fn load(path: &std::path::Path) -> Self {
        let mut s: Self = match fs::read_to_string(path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| Self::with_default_agent()),
            Err(_) => Self::with_default_agent(),
        };
        if !s.agents.contains_key("main") {
            s.agents
                .insert("main".to_string(), AgentModelConfig::default());
        }
        s
    }

    /// Persist to disk atomically: write a temp file in the same directory,
    /// then rename it over the target so a crash mid-write can never leave
    /// a truncated (key-losing) settings.json behind.
    pub fn save(&self, path: &std::path::Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| e.to_string())?;
        match fs::rename(&tmp, path) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                Err(e.to_string())
            }
        }
    }

    /// Minimal sanity check before persisting: the frontend always keeps a
    /// `main` agent entry with a provider + model, and downstream code
    /// (`agent.ts`) reads `agents.main` unguarded.
    fn validate(&self) -> Result<(), String> {
        match self.agents.get("main") {
            Some(cfg) if !cfg.provider.is_empty() && !cfg.model.is_empty() => Ok(()),
            Some(_) => Err("agents.main needs a non-empty provider and model".into()),
            None => Err("agents.main is required".into()),
        }
    }
}

// ============================================================================
// Tauri commands (UI-facing)
// ============================================================================

/// Path helper used by the commands below. The file lives at the data-dir
/// root (outside `agent_data/`, so the sandboxed agent can't read keys).
fn settings_path(state: &crate::AppState) -> PathBuf {
    state.data_dir.join("settings.json")
}

/// Return the current settings; the defaults if nothing is persisted yet.
#[tauri::command]
pub fn get_settings(state: State<'_, crate::AppState>) -> Result<AgentSettings, String> {
    Ok(AgentSettings::load(&settings_path(&state)))
}

/// Validate and persist the settings (whole-object replace).
#[tauri::command]
pub fn set_settings(
    settings: AgentSettings,
    state: State<'_, crate::AppState>,
) -> Result<(), String> {
    settings.validate()?;
    settings.save(&settings_path(&state))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "tm-settings-test-{}-{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn missing_file_yields_defaults_with_main_agent() {
        let dir = tmp_dir("missing");
        let path = dir.join("settings.json");
        let s = AgentSettings::load(&path);
        assert!(s.api_keys.is_empty());
        assert_eq!(s.agents["main"].provider, "openrouter");
        assert_eq!(s.agents["main"].model, "z-ai/glm-5.3-flash");
        assert_eq!(s.chat.compact_threshold_pct, 85);
        assert!(s.audio.auto_prerender);
        assert!(!s.onboarded);
    }

    #[test]
    fn save_roundtrips_camel_case_and_values() {
        let dir = tmp_dir("roundtrip");
        let path = dir.join("settings.json");

        let mut s = AgentSettings::with_default_agent();
        s.api_keys
            .insert("openrouter".into(), Some("sk-test".into()));
        s.agents.get_mut("main").unwrap().reasoning_effort =
            Some("xhigh".into());
        s.onboarded = true;
        s.save(&path).unwrap();

        // On-disk keys are camelCase to mirror the TS shape exactly.
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"apiKeys\""));
        assert!(raw.contains("\"compactThresholdPct\""));
        assert!(raw.contains("\"reasoningEffort\""));

        let loaded = AgentSettings::load(&path);
        assert_eq!(loaded.api_keys["openrouter"].as_deref(), Some("sk-test"));
        assert_eq!(
            loaded.agents["main"].reasoning_effort.as_deref(),
            Some("xhigh")
        );
        assert!(loaded.onboarded);
        // No temp file left behind by the atomic write.
        assert!(!path.with_extension("json.tmp").exists());

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn partial_file_fills_defaults_and_absent_reasoning_is_omitted() {
        let dir = tmp_dir("partial");
        let path = dir.join("settings.json");
        std::fs::create_dir_all(&dir).unwrap();
        // Unknown fields ignored, missing fields defaulted, explicit null
        // API key tolerated.
        std::fs::write(
            &path,
            r#"{"onboarded":true,"apiKeys":{"openai":null},"futureField":1}"#,
        )
        .unwrap();

        let s = AgentSettings::load(&path);
        assert!(s.onboarded);
        assert_eq!(s.chat.compact_threshold_pct, 85);
        assert!(s.api_keys.contains_key("openai"));
        assert!(s.agents["main"].reasoning_effort.is_none());
        // Re-serializing omits the absent reasoningEffort (matches TS).
        let json = serde_json::to_value(&s.agents["main"]).unwrap();
        assert!(json.get("reasoningEffort").is_none());

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn validate_requires_a_sane_main_agent() {
        let mut s = AgentSettings::with_default_agent();
        assert!(s.validate().is_ok());

        s.agents.remove("main");
        assert!(s.validate().is_err());

        s.agents.insert("main".into(), AgentModelConfig::default());
        s.agents.get_mut("main").unwrap().model = String::new();
        assert!(s.validate().is_err());
    }
}
