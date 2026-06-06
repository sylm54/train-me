//! Custom bashkit builtins for Train-Me.
//!
//! These builtins are registered into the bash sandbox so the agent can
//! interact with feature-specific state via familiar shell commands:
//!
//!   - `chastity`  — read/modify the lock state in `chastity.json`
//!   - `activity`  — append/query the activity log
//!
//! Phase 2 ships these as operational surface even though the underlying
//! state files (`chastity.json`, `activity.db`) are introduced in Phase 4.
//! For now `activity` operates against a simple append-only log file
//! (`activity.log`) and `chastity` against a JSON file the agent can read
//! and write directly. Phase 4 will swap `activity` over to SQLite without
//! changing the command-line interface.

use std::fs;
use std::path::PathBuf;

use bashkit::{async_trait, Builtin, BuiltinContext, ExecResult};
use serde::{Deserialize, Serialize};

// ============================================================================
// chastity
// ============================================================================

/// On-disk shape of `chastity.json`. Lives at the root of the agent's
/// writable area (`<app_data>/agent_data/chastity.json`).
#[derive(Default, Serialize, Deserialize, Clone, Debug)]
struct ChastityState {
    /// Whether the user is currently locked.
    #[serde(default)]
    locked: bool,
    /// A hidden/secret string the user picks at lock time. The agent never
    /// sees this in cleartext; `chastity unlock` requires the exact string.
    #[serde(default)]
    hidden_string: Option<String>,
    /// RFC3339 timestamp the user locked at.
    #[serde(default)]
    locked_at: Option<String>,
    /// RFC3339 timestamp at which a countdown ends (if any).
    #[serde(default)]
    countdown_end: Option<String>,
    /// Whether the countdown is currently active.
    #[serde(default)]
    countdown_active: bool,
}

/// `chastity` — inspect or update the lock state.
///
/// Usage:
///   chastity info                 — show lock status (no secrets)
///   chastity lock <hidden_string> — lock with the given secret string
///   chastity unlock <hidden_string> — unlock if the string matches
///   chastity countdown <duration> — arm a countdown (2h, 3d, 1w, 1m)
///   chastity countdown stop       — cancel the active countdown
///
/// Returns exit code 0 on success, 1 on argument/runtime errors,
/// 2 on authorization failures (wrong secret string).
pub struct ChastityBuiltin {
    /// Absolute path to the chastity state file inside the agent's data dir.
    state_path: PathBuf,
}

impl ChastityBuiltin {
    pub fn new(state_path: PathBuf) -> Self {
        Self { state_path }
    }

    fn load(&self) -> ChastityState {
        match fs::read_to_string(&self.state_path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => ChastityState::default(),
        }
    }

    fn save(&self, st: &ChastityState) -> Result<(), String> {
        if let Some(parent) = self.state_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;
        fs::write(&self.state_path, json).map_err(|e| e.to_string())
    }
}

#[async_trait]
impl Builtin for ChastityBuiltin {
    async fn execute(&self, ctx: BuiltinContext<'_>) -> bashkit::Result<ExecResult> {
        let usage = "Usage: chastity {info|lock <secret>|unlock <secret>|countdown <duration>|countdown stop}";

        let sub = match ctx.args.first() {
            Some(s) => s.as_str(),
            None => {
                return Ok(ExecResult::err(usage, 1));
            }
        };

        match sub {
            "info" => {
                let st = self.load();
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
            "lock" => {
                let secret = match ctx.args.get(1) {
                    Some(s) if !s.is_empty() => s.clone(),
                    _ => return Ok(ExecResult::err("lock requires a secret string\n", 1)),
                };
                let mut st = self.load();
                st.locked = true;
                st.hidden_string = Some(secret);
                st.locked_at = Some(now_rfc3339());
                match self.save(&st) {
                    Ok(()) => Ok(ExecResult::ok("locked\n".to_string())),
                    Err(e) => Ok(ExecResult::err(format!("save: {}\n", e), 1)),
                }
            }
            "unlock" => {
                let provided = match ctx.args.get(1) {
                    Some(s) => s.clone(),
                    None => return Ok(ExecResult::err("unlock requires a secret string\n", 1)),
                };
                let st = self.load();
                if !st.locked {
                    return Ok(ExecResult::ok("not locked\n".to_string()));
                }
                match &st.hidden_string {
                    Some(actual) if actual == &provided => {
                        let cleared = ChastityState {
                            locked: false,
                            locked_at: st.locked_at.clone(),
                            countdown_active: false,
                            ..Default::default()
                        };
                        match self.save(&cleared) {
                            Ok(()) => Ok(ExecResult::ok("unlocked\n".to_string())),
                            Err(e) => Ok(ExecResult::err(format!("save: {}\n", e), 1)),
                        }
                    }
                    _ => Ok(ExecResult::err("wrong secret string\n", 2)),
                }
            }
            "countdown" => {
                let arg = match ctx.args.get(1) {
                    Some(s) => s.as_str(),
                    None => {
                        return Ok(ExecResult::err(
                            "usage: chastity countdown <duration>|stop\n",
                            1,
                        ))
                    }
                };
                if arg == "stop" {
                    let mut st = self.load();
                    st.countdown_active = false;
                    st.countdown_end = None;
                    return match self.save(&st) {
                        Ok(()) => Ok(ExecResult::ok("countdown stopped\n".to_string())),
                        Err(e) => Ok(ExecResult::err(format!("save: {}\n", e), 1)),
                    };
                }
                // Parse a duration like "2h", "30m", "3d", "1w".
                let secs = match parse_duration(arg) {
                    Some(s) => s,
                    None => {
                        return Ok(ExecResult::err(
                            format!("invalid duration '{}'. Examples: 30m, 2h, 3d, 1w\n", arg),
                            1,
                        ))
                    }
                };
                let end = chrono::Local::now()
                    .checked_add_signed(chrono::Duration::seconds(secs as i64))
                    .map(|t| t.to_rfc3339());
                let mut st = self.load();
                st.countdown_active = true;
                st.countdown_end = end;
                match self.save(&st) {
                    Ok(()) => Ok(ExecResult::ok(format!(
                        "countdown armed: ends at {}\n",
                        st.countdown_end.unwrap_or_default(),
                    ))),
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
            "chastity: Read or update lock state. Subcommands: info, lock <secret>, \
             unlock <secret>, countdown <duration|stop>. Duration format: 30m/2h/3d/1w.",
        )
    }
}

// ============================================================================
// activity
// ============================================================================

/// `activity` — append/query the agent's activity log.
///
/// Backed by a simple append-only file (`activity.log` in the agent data
/// dir) so it works without any extra crate. Each line is a JSON object:
///   { "ts": <rfc3339>, "id": <seq>, "feature": "...", "action": "...", "details": "..." }
///
/// Phase 4 will swap this for SQLite without changing the CLI.
///
/// Usage:
///   activity log <feature> <action> [details...]   — append a log entry
///   activity list [-w <window>] [-t <time>]        — list entries (newest last)
///   activity inspect <id>                          — show one entry by id
pub struct ActivityBuiltin {
    log_path: PathBuf,
}

impl ActivityBuiltin {
    pub fn new(log_path: PathBuf) -> Self {
        Self { log_path }
    }

    fn read_entries(&self) -> Result<Vec<ActivityEntry>, String> {
        let raw = match fs::read_to_string(&self.log_path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.to_string()),
        };
        let mut out = Vec::new();
        for line in raw.lines() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<ActivityEntry>(line) {
                Ok(e) => out.push(e),
                Err(_) => continue,
            }
        }
        Ok(out)
    }

    fn next_id(entries: &[ActivityEntry]) -> u64 {
        entries.iter().map(|e| e.id).max().unwrap_or(0) + 1
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ActivityEntry {
    id: u64,
    ts: String,
    feature: String,
    action: String,
    details: String,
}

#[async_trait]
impl Builtin for ActivityBuiltin {
    async fn execute(&self, ctx: BuiltinContext<'_>) -> bashkit::Result<ExecResult> {
        let usage = "Usage: activity {log <feature> <action> [details...] | list | inspect <id>}";
        let sub = match ctx.args.first() {
            Some(s) => s.as_str(),
            None => return Ok(ExecResult::err(usage, 1)),
        };

        match sub {
            "log" => {
                let feature = match ctx.args.get(1) {
                    Some(s) if !s.is_empty() => s.clone(),
                    _ => return Ok(ExecResult::err("log requires <feature>\n", 1)),
                };
                let action = match ctx.args.get(2) {
                    Some(s) if !s.is_empty() => s.clone(),
                    _ => return Ok(ExecResult::err("log requires <action>\n", 1)),
                };
                let details = ctx
                    .args
                    .get(3..)
                    .map(|slice| slice.join(" "))
                    .unwrap_or_default();

                let entries = self.read_entries().unwrap_or_default();
                let entry = ActivityEntry {
                    id: Self::next_id(&entries),
                    ts: now_rfc3339(),
                    feature,
                    action,
                    details,
                };
                let line = serde_json::to_string(&entry).unwrap_or_default();

                if let Some(parent) = self.log_path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let mut content = fs::read_to_string(&self.log_path).unwrap_or_default();
                if !content.is_empty() && !content.ends_with('\n') {
                    content.push('\n');
                }
                content.push_str(&line);
                content.push('\n');
                if let Err(e) = fs::write(&self.log_path, content) {
                    return Ok(ExecResult::err(format!("write: {}\n", e), 1));
                }
                Ok(ExecResult::ok(format!("logged #{}\n", entry.id)))
            }
            "list" => {
                let entries = match self.read_entries() {
                    Ok(v) => v,
                    Err(e) => return Ok(ExecResult::err(format!("read: {}\n", e), 1)),
                };
                if entries.is_empty() {
                    return Ok(ExecResult::ok("(no activity)\n".to_string()));
                }
                let mut out = String::new();
                for e in &entries {
                    out.push_str(&format!(
                        "{}\t{}\t{}\t{}\t{}\n",
                        e.id, e.ts, e.feature, e.action, e.details
                    ));
                }
                Ok(ExecResult::ok(out))
            }
            "inspect" => {
                let id = match ctx.args.get(1).and_then(|s| s.parse::<u64>().ok()) {
                    Some(n) => n,
                    None => return Ok(ExecResult::err("inspect requires numeric <id>\n", 1)),
                };
                let entries = match self.read_entries() {
                    Ok(v) => v,
                    Err(e) => return Ok(ExecResult::err(format!("read: {}\n", e), 1)),
                };
                match entries.iter().find(|e| e.id == id) {
                    Some(e) => {
                        let pretty = serde_json::to_string_pretty(e).unwrap_or_default();
                        Ok(ExecResult::ok(pretty + "\n"))
                    }
                    None => Ok(ExecResult::err(format!("id {} not found\n", id), 1)),
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
            "activity: Append/query the activity log. Subcommands: \
             log <feature> <action> [details...], list, inspect <id>.",
        )
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
fn parse_duration(s: &str) -> Option<u64> {
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

/// Register Train-Me's custom builtins on a [`bashkit::BashBuilder`].
///
/// Call this on the builder *before* `.build()` so the commands are
/// available inside the sandbox.
pub fn register_train_me_builtins(
    mut builder: bashkit::BashBuilder,
    agent_dir: &std::path::Path,
) -> bashkit::BashBuilder {
    builder = builder.builtin(
        "chastity",
        Box::new(ChastityBuiltin::new(agent_dir.join("chastity.json"))),
    );
    builder = builder.builtin(
        "activity",
        Box::new(ActivityBuiltin::new(agent_dir.join("activity.log"))),
    );
    builder
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
