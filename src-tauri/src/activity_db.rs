//! Activity log backed by SQLite (`<agent_dir>/activity.db`).
//!
//! The DB lives **inside the agent sandbox** and is accessed by a single
//! engine — the embedded Turso-backed `sqlite` builtin — from both sides:
//!
//! - **Agent**: runs `sqlite` queries directly against `/activity.db`.
//! - **UI**: the Tauri commands below (`activity_log_entry`,
//!   `activity_list_entries`, `activity_get_entry`) also route through the
//!   sandbox (`BashSandbox::exec`), so every read and write goes through the
//!   same Turso engine. This avoids the cross-engine locking mismatch that
//!   would arise if the UI used a separate libsqlite3 connection.
//!
//! Entries are appended by the UI whenever the user takes a meaningful
//! action (locking chastity, saving a journal entry, adding an inventory
//! item, rendering a conditioning script, …). The React `ActivityView`
//! reads them back via `activity_list_entries`.
//!
//! Notes on the storage choice:
//! - **`journal_mode=DELETE`** (not WAL): Turso may not consult SQLite's
//!   `-wal` sidecar, so WAL could leave recently-committed rows invisible.
//!   Rollback-journal mode keeps all committed data in the main `.db` file.
//! - **Schema bootstrap** (`ensure_schema`) uses a *transient* libsqlite3
//!   connection at startup purely to create the table and pin the journal
//!   mode. It is closed before the app finishes setup, so at runtime Turso
//!   is the only engine touching the file.
//! - The agent is directed (see the agent prompt) to treat the log as
//!   read-only; the UI is the sole writer.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::bash::BashSandbox;
use crate::AppState;

// ============================================================================
// Types
// ============================================================================

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ActivityEntry {
    pub id: i64,
    pub ts: String,
    pub feature: String,
    pub action: String,
    pub details: String,
}

// ============================================================================
// Schema bootstrap (one-shot, transient libsqlite3 connection)
// ============================================================================

const SCHEMA_SQL: &str = "\
PRAGMA journal_mode=DELETE;
CREATE TABLE IF NOT EXISTS activity (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT    NOT NULL,
    feature  TEXT    NOT NULL,
    action   TEXT    NOT NULL,
    details  TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_activity_feature ON activity(feature);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts);
";

/// Create / migrate the activity DB schema and pin `journal_mode=DELETE`.
///
/// Uses a *transient* libsqlite3 connection that is dropped before this
/// returns, so it does not hold the file open at runtime — Turso (via the
/// sandbox) is the sole runtime engine. Idempotent.
pub fn ensure_schema(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA_SQL).map_err(|e| e.to_string())?;
    // Connection dropped here -> file is closed before the sandbox reads it.
    Ok(())
}

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

// ============================================================================
// Sandbox helpers
// ============================================================================

/// Run a fixed (no user input) `SELECT` against `/activity.db` through the
/// sandbox and return the `-json` output. Fails on a non-zero exit code.
async fn query_json(bash: &BashSandbox, sql: &str) -> Result<String, String> {
    // The SQL is built by us with no interpolated user text, so wrapping it
    // in bash double quotes is safe (no `"`, `$`, backticks, or backslashes).
    let cmd = format!("sqlite -json activity.db \"{sql}\"");
    let res = bash.exec(&cmd).await?;
    if res.exit_code != 0 {
        let msg = res.stderr.trim();
        return Err(if msg.is_empty() {
            format!("sqlite exited {} (no stderr)", res.exit_code)
        } else {
            msg.to_string()
        });
    }
    Ok(res.stdout)
}

/// Parse the `-json` array produced by [`query_json`] into entries.
/// An empty result set renders as `[]`, which we accept as "no rows".
fn parse_entries(json: &str) -> Result<Vec<ActivityEntry>, String> {
    let trimmed = json.trim();
    if trimmed.is_empty() || trimmed == "null" || trimmed == "[]" {
        return Ok(Vec::new());
    }
    serde_json::from_str(trimmed).map_err(|e| format!("parse activity json: {e}"))
}

/// Escape a string for safe interpolation into a SQL single-quoted literal:
/// double every `'`.
fn sql_escape(s: &str) -> String {
    s.replace('\'', "''")
}

/// Monotonic counter so concurrent UI writes never collide on the temp
/// `.read` file used by [`activity_log_entry`].
static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

// ============================================================================
// Tauri commands (UI-facing — all routed through the sandbox/Turso engine)
// ============================================================================

/// List all activity entries, newest first.
#[tauri::command]
pub async fn activity_list_entries(
    state: State<'_, AppState>,
) -> Result<Vec<ActivityEntry>, String> {
    let out = query_json(
        &state.bash,
        "SELECT id, ts, feature, action, details FROM activity ORDER BY id DESC",
    )
    .await?;
    parse_entries(&out)
}

/// Fetch a single activity entry by id.
#[tauri::command]
pub async fn activity_get_entry(
    id: i64,
    state: State<'_, AppState>,
) -> Result<Option<ActivityEntry>, String> {
    // `id` is an i64, so it is safe to interpolate directly.
    let out = query_json(
        &state.bash,
        &format!("SELECT id, ts, feature, action, details FROM activity WHERE id = {id}"),
    )
    .await?;
    let mut entries = parse_entries(&out)?;
    Ok(entries.pop())
}

/// Append a new activity entry from the UI. Used for auto-logging user
/// interactions. Routed through the sandbox so Turso is the sole writer.
///
/// Because user-supplied `feature`/`action`/`details` can contain arbitrary
/// characters, the INSERT is written to a temp `.read` file (escaping only
/// the SQL layer) rather than embedded in the bash command line — sidestepping
/// the bash/quoting/SQL triple-escaping problem entirely. The file is removed
/// after the statement runs.
#[tauri::command]
pub async fn activity_log_entry(
    feature: String,
    action: String,
    details: Option<String>,
    state: State<'_, AppState>,
) -> Result<ActivityEntry, String> {
    let details = details.unwrap_or_default();
    let ts = now_rfc3339();

    let sql = format!(
        "INSERT INTO activity (ts, feature, action, details) \
         VALUES ('{ts}', '{feature}', '{action}', '{details}');\n",
        ts = sql_escape(&ts),
        feature = sql_escape(&feature),
        action = sql_escape(&action),
        details = sql_escape(&details),
    );

    // Unique temp path under the sandbox root so concurrent writes don't race.
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let rel = format!(".activity_write_{seq}.sql");
    let path: PathBuf = crate::bash::resolve_under(&state.agent_dir, &rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    std::fs::write(&path, &sql).map_err(|e| format!("write {}: {}", path.display(), e))?;

    // Execute, then clean up best-effort regardless of outcome.
    let cmd = format!("sqlite activity.db \".read {rel}\"");
    let exec_res = state.bash.exec(&cmd).await;
    let _ = std::fs::remove_file(&path);
    let res = exec_res?;

    if res.exit_code != 0 {
        let msg = res.stderr.trim();
        return Err(if msg.is_empty() {
            format!("sqlite exited {} (no stderr)", res.exit_code)
        } else {
            msg.to_string()
        });
    }

    // The entry id isn't fetched back (no caller consumes it; ActivityView
    // reads real ids via `activity_list_entries`). Keep the type honest with
    // the values we persisted.
    Ok(ActivityEntry {
        id: 0,
        ts,
        feature,
        action,
        details,
    })
}

// ============================================================================
// Migration
// ============================================================================

/// Move an existing `activity.db` (plus any WAL/SHM sidecars it accrued
/// under the old WAL-mode config) from the legacy `<state_dir>/` location
/// into the agent sandbox. No-op if the destination already exists or the
/// source is absent, so it is safe to call on every startup.
///
/// After the move, [`ensure_schema`] opens the file (idempotently) and
/// switches it to `journal_mode=DELETE`, checkpointing/absorbing any moved
/// `-wal`.
pub fn migrate_into_sandbox(new_db: &Path, old_db: &Path) {
    if new_db.exists() || !old_db.exists() {
        return;
    }
    if let Some(parent) = new_db.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let base = old_db.to_string_lossy();
    for suffix in ["", "-wal", "-shm"] {
        let from = format!("{base}{suffix}");
        if std::path::Path::new(&from).exists() {
            let to = format!("{}{suffix}", new_db.to_string_lossy());
            let _ = std::fs::rename(&from, &to);
        }
    }
}
