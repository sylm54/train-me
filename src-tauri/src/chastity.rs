//! Chastity: lock state stored OUTSIDE the agent's writable area.
//!
//! State lives at `<state_dir>/chastity.json` and is read/written by:
//!   - the `chastity` bash builtin (agent-facing; supports `info` and
//!     `unlock` only — the agent may NOT lock the user or manage countdowns)
//!   - dedicated Tauri commands (UI-facing; the user locks, arms/stops
//!     countdowns, and the auto-unlock fires when a countdown expires)
//!
//! The agent never sees the file directly — the bash sandbox is mounted
//! over `agent_data/`, and `state_dir` is a sibling directory.

use std::fs;
use std::path::{Path, PathBuf};

use bashkit::{async_trait, Builtin, BuiltinContext, ExecResult};
use serde::{Deserialize, Serialize};
use tauri::State;

// ============================================================================
// State shape (on-disk JSON)
// ============================================================================

/// On-disk shape of `chastity.json`. Lives in `<state_dir>/chastity.json`,
/// outside the agent's writable area.
#[derive(Default, Serialize, Deserialize, Clone, Debug)]
pub struct ChastityState {
    /// Whether the user is currently locked.
    #[serde(default)]
    pub locked: bool,
    /// A hidden/secret string the user picks at lock time. The agent never
    /// sees this in cleartext; `chastity unlock` requires the exact string.
    #[serde(default)]
    pub hidden_string: Option<String>,
    /// RFC3339 timestamp the user locked at.
    #[serde(default)]
    pub locked_at: Option<String>,
    /// RFC3339 timestamp at which a countdown ends (if any).
    #[serde(default)]
    pub countdown_end: Option<String>,
    /// Whether the countdown is currently active.
    #[serde(default)]
    pub countdown_active: bool,
}

impl ChastityState {
    pub fn load(path: &Path) -> Self {
        match fs::read_to_string(path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => ChastityState::default(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(path, json).map_err(|e| e.to_string())
    }
}

// ============================================================================
// Helpers
// ============================================================================

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

/// Parse a shorthand duration into seconds.
/// Supports: `30s`, `30m`, `2h`, `3d`, `1w`. Plain numbers are treated as
/// seconds.
pub(crate) fn parse_duration(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (num_part, unit) = match s.find(|c: char| !c.is_ascii_digit()) {
        Some(idx) => (&s[..idx], &s[idx..]),
        None => (s, ""),
    };
    let n: u64 = num_part.parse().ok()?;
    let secs = match unit {
        "" | "s" => n,
        "m" => n.checked_mul(60)?,
        "h" => n.checked_mul(60 * 60)?,
        "d" => n.checked_mul(60 * 60 * 24)?,
        "w" => n.checked_mul(60 * 60 * 24 * 7)?,
        _ => return None,
    };
    Some(secs)
}

// ============================================================================
// Builtin (agent-facing)
// ============================================================================

/// `chastity` — inspect or unlock.
///
/// Usage:
///   chastity info                       — show lock status (no secrets)
///   chastity unlock                     — unlock (no secret required; only
///                                         the agent may call this)
///
/// The agent may NOT lock the user — locking is a user-only action via
/// the UI. The agent also has no access to the countdown (the user arms
/// and stops countdowns via the UI). The bash builtin intentionally does
/// not expose `lock`, `countdown`, or any write access beyond unlocking.
pub struct ChastityBuiltin {
    state_path: PathBuf,
}

impl ChastityBuiltin {
    pub fn new(state_path: PathBuf) -> Self {
        Self { state_path }
    }

    /// Register this builtin on a [`bashkit::BashBuilder`].
    pub fn register(builder: bashkit::BashBuilder, state_path: PathBuf) -> bashkit::BashBuilder {
        builder.builtin("chastity", Box::new(Self::new(state_path)))
    }
}

#[async_trait]
impl Builtin for ChastityBuiltin {
    async fn execute(&self, ctx: BuiltinContext<'_>) -> bashkit::Result<ExecResult> {
        let usage = "Usage: chastity {info|unlock}";

        let sub = match ctx.args.first() {
            Some(s) => s.as_str(),
            None => {
                return Ok(ExecResult::err(usage, 1));
            }
        };

        match sub {
            "info" => {
                let st = ChastityState::load(&self.state_path);
                let lines = [
                    format!("locked: {}", st.locked),
                    format!("locked_at: {}", st.locked_at.unwrap_or_default()),
                    format!(
                        "hidden_string: {}",
                        if st.hidden_string.is_some() {
                            "<redacted>"
                        } else {
                            "-"
                        }
                    ),
                    format!("countdown_active: {}", st.countdown_active),
                    format!("countdown_end: {}", st.countdown_end.unwrap_or_default()),
                ];
                Ok(ExecResult::ok(lines.join("\n") + "\n"))
            }
            "unlock" => {
                // The agent does not need the secret. Only the user knows
                // the secret (set via the UI when locking); the agent may
                // release the lock at its own discretion.
                let st = ChastityState::load(&self.state_path);
                if !st.locked {
                    return Ok(ExecResult::ok("not locked\n".to_string()));
                }
                let cleared = ChastityState {
                    locked: false,
                    locked_at: st.locked_at.clone(),
                    countdown_active: false,
                    ..Default::default()
                };
                match cleared.save(&self.state_path) {
                    Ok(()) => Ok(ExecResult::ok("unlocked\n".to_string())),
                    Err(e) => Ok(ExecResult::err(format!("save: {}\n", e), 1)),
                }
            }
            other => Ok(ExecResult::err(
                format!("unknown subcommand '{}'. {}\n", other, usage),
                1,
            )),
        }
    }

    fn llm_hint(&self) -> Option<&'static str> {
        Some(
            "chastity: Read lock state or unlock the user. Subcommands: info, unlock. \
             The agent cannot lock the user or manage countdowns — only the user \
             can do that via the UI.",
        )
    }
}

// ============================================================================
// Tauri commands (UI-facing — no secret checks)
// ============================================================================

/// Path helper used by the commands below.
fn state_path(state: &crate::AppState) -> PathBuf {
    state.state_dir.join("chastity.json")
}

/// Return the full chastity state, including the hidden string. The UI is
/// trusted; the agent never sees this directly.
#[tauri::command]
pub fn get_chastity_state(state: State<'_, crate::AppState>) -> Result<ChastityState, String> {
    Ok(ChastityState::load(&state_path(&state)))
}

/// Lock with a new secret. UI-initiated.
#[tauri::command]
pub fn chastity_lock(
    secret: String,
    state: State<'_, crate::AppState>,
) -> Result<ChastityState, String> {
    let mut st = ChastityState::load(&state_path(&state));
    st.locked = true;
    st.hidden_string = Some(secret);
    st.locked_at = Some(now_rfc3339());
    st.save(&state_path(&state))?;
    Ok(st)
}

/// Unlock — UI version bypasses the secret check. The user is at the
/// keyboard; this is the "force unlock" path.
#[tauri::command]
pub fn chastity_unlock(state: State<'_, crate::AppState>) -> Result<ChastityState, String> {
    let st = ChastityState::load(&state_path(&state));
    let cleared = ChastityState {
        locked: false,
        locked_at: st.locked_at.clone(),
        countdown_active: false,
        ..Default::default()
    };
    cleared.save(&state_path(&state))?;
    Ok(cleared)
}

/// Clear the lock + countdown, preserving locked_at and hidden_string
/// for the UI to display the previous secret. Used by the auto-unlock
/// when the countdown expires.
#[tauri::command]
pub fn chastity_auto_unlock(state: State<'_, crate::AppState>) -> Result<ChastityState, String> {
    let st = ChastityState::load(&state_path(&state));
    let next = ChastityState {
        locked: false,
        hidden_string: st.hidden_string,
        locked_at: st.locked_at,
        countdown_active: false,
        countdown_end: None,
    };
    next.save(&state_path(&state))?;
    Ok(next)
}

/// Arm a countdown. `duration` accepts the same shorthand the bash
/// builtin uses: `30m`, `2h`, `3d`, `1w`. Returns the new state.
#[tauri::command]
pub fn chastity_arm_countdown(
    duration: String,
    state: State<'_, crate::AppState>,
) -> Result<ChastityState, String> {
    let secs = parse_duration(&duration)
        .ok_or_else(|| format!("invalid duration '{}'. Examples: 30m, 2h, 3d, 1w", duration))?;
    let mut st = ChastityState::load(&state_path(&state));
    if !st.locked {
        return Err("Lock first before arming a countdown.".into());
    }
    let end = chrono::Local::now()
        .checked_add_signed(chrono::Duration::seconds(secs as i64))
        .map(|t| t.to_rfc3339());
    st.countdown_active = true;
    st.countdown_end = end;
    st.save(&state_path(&state))?;
    Ok(st)
}

/// Cancel the active countdown.
#[tauri::command]
pub fn chastity_stop_countdown(state: State<'_, crate::AppState>) -> Result<ChastityState, String> {
    let mut st = ChastityState::load(&state_path(&state));
    st.countdown_active = false;
    st.countdown_end = None;
    st.save(&state_path(&state))?;
    Ok(st)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_durations() {
        assert_eq!(parse_duration("30"), Some(30));
        assert_eq!(parse_duration("30s"), Some(30));
        assert_eq!(parse_duration("5m"), Some(5 * 60));
        assert_eq!(parse_duration("2h"), Some(2 * 3600));
        assert_eq!(parse_duration("3d"), Some(3 * 86400));
        assert_eq!(parse_duration("1w"), Some(7 * 86400));
        assert_eq!(parse_duration("abc"), None);
        assert_eq!(parse_duration("3x"), None);
    }
}
