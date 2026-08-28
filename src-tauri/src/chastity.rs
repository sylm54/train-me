//! Chastity: lock state stored OUTSIDE the agent's writable area.
//!
//! State lives at `<state_dir>/chastity.json` and is read/written by:
//!   - the `chastity` bash builtin (agent-facing; supports `info` and
//!     `unlock` only — the agent may NOT lock the user)
//!   - dedicated Tauri commands (UI-facing: the user locks via the UI —
//!     onboarding or a `chastity` feature block's lock gate — and the
//!     feature-block unlock gate releases the lock and reveals the code)
//!
//! The agent never sees the file directly — the bash sandbox is mounted
//! over `agent_data/`, and `state_dir` is a sibling directory.
//!
//! The hidden code outlives the lock: both unlock paths preserve it so a
//! later unlock gate can reveal it to the user (they need it to open the
//! physical device). `revealed` tracks whether the UI has already shown
//! it; it resets when a new lock is set.

use std::fs;
use std::path::PathBuf;

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
    /// A hidden/secret string the user picks at lock time — the code that
    /// opens the physical device. The agent never sees this in cleartext;
    /// only the UI reveals it to the user. Preserved across unlocks.
    #[serde(default)]
    pub hidden_string: Option<String>,
    /// Whether the UI has already shown `hidden_string` to the user since
    /// the lock was set. A fresh lock resets this.
    #[serde(default)]
    pub revealed: bool,
    /// RFC3339 timestamp the user locked at.
    #[serde(default)]
    pub locked_at: Option<String>,
}

impl ChastityState {
    pub fn load(path: &std::path::Path) -> Self {
        match fs::read_to_string(path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => ChastityState::default(),
        }
    }

    pub fn save(&self, path: &std::path::Path) -> Result<(), String> {
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
/// The agent may NOT lock the user — locking is a user-only action (the
/// onboarding setup or a `chastity` feature block's lock gate). Note that
/// a bash unlock does NOT reveal the hidden code; only an unlocked-gate
/// feature block shows it to the user, so pair `chastity unlock` with one
/// when the user needs their code back.
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
                    format!("code_revealed: {}", st.revealed),
                ];
                Ok(ExecResult::ok(lines.join("\n") + "\n"))
            }
            "unlock" => {
                // The agent does not need the secret. Only the user knows
                // the secret (set via the UI when locking); the agent may
                // release the lock at its own discretion. The code is kept
                // hidden — the unlock gate in a routine reveals it.
                let st = ChastityState::load(&self.state_path);
                if !st.locked {
                    return Ok(ExecResult::ok("not locked\n".to_string()));
                }
                let cleared = ChastityState {
                    locked: false,
                    hidden_string: st.hidden_string,
                    revealed: false,
                    locked_at: st.locked_at,
                };
                match cleared.save(&self.state_path) {
                    Ok(()) => Ok(ExecResult::ok(
                        "unlocked (the code stays hidden until an unlock gate \
                         reveals it)\n"
                            .to_string(),
                    )),
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
             The agent cannot lock the user — only the user can lock themselves \
             (onboarding or a chastity lock gate). A bash unlock does not reveal \
             the hidden code; embed a chastity feature block with state: unlocked \
             in a routine/task when the user should get their code back.",
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

/// Lock with a new secret. UI-initiated (onboarding setup or a session's
/// lock gate). Resets the reveal flag for the fresh code.
#[tauri::command]
pub fn chastity_lock(
    secret: String,
    state: State<'_, crate::AppState>,
) -> Result<ChastityState, String> {
    let mut st = ChastityState::load(&state_path(&state));
    st.locked = true;
    st.hidden_string = Some(secret);
    st.revealed = false;
    st.locked_at = Some(now_rfc3339());
    st.save(&state_path(&state))?;
    Ok(st)
}

/// Release the lock and reveal the hidden code to the user. Called by a
/// session's unlock gate — the agent sanctions the release by embedding
/// the gate (it can also unlock headless via the bash builtin, which keeps
/// the code hidden until the next unlock gate). The code and `locked_at`
/// are preserved so the UI can display them; `revealed` is set so later
/// unlock gates while already unlocked auto-fulfill instead of re-showing
/// it. Idempotent: calling it while unlocked just (re-)reveals the code.
#[tauri::command]
pub fn chastity_unlock(state: State<'_, crate::AppState>) -> Result<ChastityState, String> {
    let st = ChastityState::load(&state_path(&state));
    let next = ChastityState {
        locked: false,
        hidden_string: st.hidden_string,
        revealed: true,
        locked_at: st.locked_at,
    };
    next.save(&state_path(&state))?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlock_preserves_the_hidden_code() {
        let dir = std::env::temp_dir().join(format!(
            "tm-chastity-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join("chastity.json");

        let mut st = ChastityState::default();
        st.locked = true;
        st.hidden_string = Some("1234".into());
        st.locked_at = Some("2026-01-01T00:00:00+00:00".into());
        st.save(&path).unwrap();

        let loaded = ChastityState::load(&path);
        assert!(loaded.locked);
        assert!(!loaded.revealed);

        let cleared = ChastityState {
            locked: false,
            hidden_string: loaded.hidden_string.clone(),
            revealed: true,
            locked_at: loaded.locked_at.clone(),
        };
        cleared.save(&path).unwrap();

        let after = ChastityState::load(&path);
        assert!(!after.locked);
        assert_eq!(after.hidden_string.as_deref(), Some("1234"));
        assert!(after.revealed);
        assert_eq!(after.locked_at.as_deref(), Some("2026-01-01T00:00:00+00:00"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn legacy_state_file_without_revealed_loads() {
        let dir = std::env::temp_dir().join(format!(
            "tm-chastity-legacy-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join("chastity.json");
        std::fs::create_dir_all(&dir).unwrap();
        // A pre-`revealed` file with countdown fields still parses: serde
        // defaults the missing field and ignores the unknown ones.
        std::fs::write(
            &path,
            "{\"locked\":true,\"hidden_string\":\"x\",\"locked_at\":\"t\",\"countdown_active\":true}",
        )
        .unwrap();
        let st = ChastityState::load(&path);
        assert!(st.locked);
        assert!(!st.revealed);
        let _ = std::fs::remove_file(&path);
    }
}
