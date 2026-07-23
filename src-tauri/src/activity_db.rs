//! Activity log backed by SQLite (`<agent_dir>/activity.db`).
//!
//! The DB lives **inside the agent sandbox** so the agent can query it
//! directly via the embedded `sqlite` builtin. The UI commands below use
//! **rusqlite (host libsqlite3)** with transient connections instead of
//! routing through the sandbox's Turso engine — see `inventory.rs` for
//! the full rationale (short version: the Turso Memory backend's snapshot
//! mechanism proved unreliable for persistence; rusqlite writes directly
//! to the file).
//!
//! Entries are appended by the UI whenever the user takes a meaningful
//! action (locking chastity, saving a journal entry, adding an inventory
//! item, rendering a conditioning script, …). The React `ActivityView`
//! reads them back via `activity_list_entries`.
//!
//! The agent is directed (see the agent prompt) to treat the log as
//! read-only; the UI is the sole writer.

use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

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
/// Uses a transient libsqlite3 connection that is dropped before this
/// returns. Idempotent.
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
// rusqlite helpers
// ============================================================================

/// Open a transient rusqlite connection to `activity.db` inside the agent
/// sandbox. The caller drops the connection when done, so the file is
/// released immediately.
fn open_db(agent_dir: &Path) -> Result<Connection, String> {
    Connection::open(agent_dir.join("activity.db")).map_err(|e| e.to_string())
}

const ENTRY_COLS: &str = "id, ts, feature, action, details";

fn map_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<ActivityEntry> {
    Ok(ActivityEntry {
        id: row.get(0)?,
        ts: row.get(1)?,
        feature: row.get(2)?,
        action: row.get(3)?,
        details: row.get(4)?,
    })
}

// ============================================================================
// Tauri commands (UI-facing — rusqlite direct)
// ============================================================================

/// List all activity entries, newest first.
#[tauri::command]
pub async fn activity_list_entries(
    state: State<'_, AppState>,
) -> Result<Vec<ActivityEntry>, String> {
    let agent_dir = state.agent_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&agent_dir)?;
        let mut stmt =
            conn.prepare(&format!("SELECT {ENTRY_COLS} FROM activity ORDER BY id DESC"))
                .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], map_entry).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetch a single activity entry by id.
#[tauri::command]
pub async fn activity_get_entry(
    id: i64,
    state: State<'_, AppState>,
) -> Result<Option<ActivityEntry>, String> {
    let agent_dir = state.agent_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&agent_dir)?;
        conn.query_row(
            &format!("SELECT {ENTRY_COLS} FROM activity WHERE id = ?1"),
            params![id],
            map_entry,
        )
        .map(|e| Some(e))
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            _ => Err(e),
        })
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Append a new activity entry from the UI. Used for auto-logging user
/// interactions. Uses rusqlite directly so the write persists reliably
/// (parameter binding avoids the bash/quoting/SQL triple-escaping problem).
#[tauri::command]
pub async fn activity_log_entry(
    feature: String,
    action: String,
    details: Option<String>,
    state: State<'_, AppState>,
) -> Result<ActivityEntry, String> {
    let details = details.unwrap_or_default();
    let ts = now_rfc3339();
    let agent_dir = state.agent_dir.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<ActivityEntry, String> {
        let conn = open_db(&agent_dir)?;
        conn.execute(
            "INSERT INTO activity (ts, feature, action, details) \
             VALUES (?1, ?2, ?3, ?4)",
            params![ts, feature, action, details],
        )
        .map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();
        Ok(ActivityEntry {
            id,
            ts,
            feature,
            action,
            details,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
