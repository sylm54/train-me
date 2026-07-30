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

/// Aggregated tracking stats for one item (keyed by the activity row's
/// `details`, which carries the stable item id — a conditioning JSON stem, a
/// rule/routine filename stem, …).
///
/// `last_ts` is the RFC 3339 timestamp of the most recent matching event.
/// `count` is the total number of matching events.
/// `streak` is the current consecutive-calendar-day streak of matching events
/// — counting back from the most recent event's date, only if that date is
/// today or yesterday (local time); otherwise `0`. This is meaningful for
/// "engagement" events (conditioning plays, routine done). For "broke rule"
/// events the frontend instead derives "days clean" from `last_ts`, since a
/// broke-event streak is not a desirable metric.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TrackStatRow {
    pub id: String,
    pub last_ts: String,
    pub count: i64,
    pub streak: i64,
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

/// Parse an RFC 3339 timestamp's local date, returning `None` on failure.
/// Used to bucket events into calendar days for streak counting.
fn local_date_from_rfc3339(ts: &str) -> Option<chrono::NaiveDate> {
    use chrono::DateTime;
    DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|dt| dt.with_timezone(&chrono::Local).date_naive())
}

/// Aggregate tracking stats (last_ts / count / streak) for every item id under
/// a given `(feature, action)` pair. `details` carries the item id; rows are
/// grouped by it, ordered by timestamp so the streak can be walked from newest
/// to oldest. The streak counts consecutive local calendar days with ≥1 event,
/// ending only if the most recent event's date is today or yesterday (local).
#[tauri::command]
pub async fn activity_track_stats(
    feature: String,
    action: String,
    state: State<'_, AppState>,
) -> Result<Vec<TrackStatRow>, String> {
    let agent_dir = state.agent_dir.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TrackStatRow>, String> {
        let conn = open_db(&agent_dir)?;
        let mut stmt = conn
            .prepare(
                "SELECT details, ts FROM activity \
                 WHERE feature = ?1 AND action = ?2 \
                 ORDER BY details, ts",
            )
            .map_err(|e| e.to_string())?;
        // Collect raw (id, ts) rows.
        let raw: rusqlite::Result<Vec<(String, String)>> = stmt
            .query_map(params![feature, action], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect();
        let raw = raw.map_err(|e| e.to_string())?;

        // Group by id, preserving insertion order of first-seen ids.
        use std::collections::BTreeMap;
        let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (id, ts) in raw {
            grouped.entry(id).or_default().push(ts);
        }

        let today = chrono::Local::now().date_naive();
        let mut out: Vec<TrackStatRow> = Vec::with_capacity(grouped.len());
        for (id, mut ts_list) in grouped {
            if ts_list.is_empty() {
                continue;
            }
            // ts_list is ascending (ordered by ts); the streak walk goes from
            // the newest backward, so reverse it once.
            ts_list.reverse();
            let last_ts = ts_list[0].clone();

            // Bucket into distinct local dates, newest first.
            let mut dates: Vec<chrono::NaiveDate> = Vec::new();
            for ts in &ts_list {
                if let Some(d) = local_date_from_rfc3339(ts) {
                    match dates.last() {
                        Some(&prev) if prev == d => {} // same day, skip
                        _ => dates.push(d),
                    }
                }
            }

            // Streak: only counts if the most recent event date is today or
            // yesterday (local). Walk distinct dates newest→oldest while they
            // are consecutive.
            let mut streak: i64 = 0;
            if let Some(&first) = dates.first() {
                if first == today || first == today.pred_opt().unwrap_or(today) {
                    streak = 1;
                    for window in dates.windows(2) {
                        // newest-first: window[0] should be window[1].succ().
                        if window[0].pred_opt().as_ref() == Some(&window[1]) {
                            streak += 1;
                        } else {
                            break;
                        }
                    }
                }
            }

            out.push(TrackStatRow {
                id,
                last_ts,
                count: ts_list.len() as i64,
                streak,
            });
        }
        // Stable order by id so the UI list is deterministic.
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
