//! v2 economy store (`<state_dir>/economy.db`, outside the agent sandbox).
//!
//! Holds every piece of app-managed economy state from FORMAT.md §6:
//!
//!   - **Points**: an append-only ledger. The balance is always
//!     `SUM(delta)`; there is no set/rewrite operation anywhere. Every
//!     entry carries a `source` key (occurrence id, purchase id, agent
//!     grant) with a UNIQUE constraint — that is what makes the lazy
//!     schedule reconciliation in `schedule.rs` safe: applying the same
//!     source twice is a no-op.
//!   - **Exemptions**: scoped suspension windows (`habits` / `routines` /
//!     `tasks` / `all`). `all` is the blanket pause; expiry is enforced
//!     lazily by comparing timestamps, never by timers.
//!   - **Purchases + stock**: purchases are ledger rows keyed by store
//!     entry; stock is recomputed lazily from the entry's restock cron
//!     (each missed fire resets the sold counter).
//!   - **Pending actions**: `script` actions fired while no UI was there
//!     to play them land here; the Today view shows them for playback.
//!
//! The agent reaches this through the `points` bash builtin (read + grant
//! + deduct with a mandatory reason — never a balance rewrite).

use std::path::{Path, PathBuf};

use bashkit::async_trait;
use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::AppState;

const SCHEMA_SQL: &str = "
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS exemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    scope TEXT NOT NULL,
    until TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    entry TEXT NOT NULL,
    price INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_state (
    entry TEXT PRIMARY KEY,
    initial INTEGER NOT NULL,
    last_restock TEXT NOT NULL,
    sold_since INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pending_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT ''
);
";

pub fn ensure_schema(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA_SQL).map_err(|e| e.to_string())?;
    Ok(())
}

fn open(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Best-effort opener for background readers (prerender's pending-script
/// scan). Returns None instead of an error — background passes skip.
pub fn open_ro(db_path: &Path) -> Option<Connection> {
    let conn = Connection::open(db_path).ok()?;
    conn.busy_timeout(std::time::Duration::from_secs(1)).ok()?;
    Some(conn)
}

pub fn now_ts() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn ts_at(dt: chrono::DateTime<chrono::Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn parse_ts(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&chrono::Utc))
}

// ============================================================================
// Core store operations (sync, testable; commands wrap them)
// ============================================================================

pub fn balance(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COALESCE(SUM(delta), 0) FROM ledger", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// Append a points entry unless `source` has already been applied.
/// Returns the new balance when applied, `None` when it was a duplicate.
pub fn apply_points(
    conn: &Connection,
    delta: i64,
    reason: &str,
    source: &str,
) -> Result<Option<i64>, String> {
    let applied = conn
        .execute(
            "INSERT OR IGNORE INTO ledger (ts, delta, reason, source) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![now_ts(), delta, reason, source],
        )
        .map_err(|e| e.to_string())?;
    if applied == 0 {
        return Ok(None);
    }
    balance(conn).map(Some)
}

#[derive(Serialize, Clone, Debug)]
pub struct LedgerRow {
    pub ts: String,
    pub delta: i64,
    pub reason: String,
    pub source: String,
}

pub fn recent_ledger(conn: &Connection, limit: usize) -> Result<Vec<LedgerRow>, String> {
    let mut stmt = conn
        .prepare("SELECT ts, delta, reason, source FROM ledger ORDER BY id DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![limit as i64], |r| {
            Ok(LedgerRow {
                ts: r.get(0)?,
                delta: r.get(1)?,
                reason: r.get(2)?,
                source: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn grant_exemption(conn: &Connection, scope: &str, until: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO exemptions (ts, scope, until) VALUES (?1, ?2, ?3)",
        rusqlite::params![now_ts(), scope, until],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, Clone, Debug)]
pub struct ExemptionRow {
    pub scope: String,
    pub ts: String,
    pub until: String,
}

/// Active exemptions covering `scope` (exact match or `all`), purging
/// expired rows first. Expiry is lazy by design — see FORMAT.md §6.
pub fn exemption_active(conn: &Connection, scope: &str) -> Result<bool, String> {
    let now = now_ts();
    conn.execute("DELETE FROM exemptions WHERE until <= ?1", rusqlite::params![now])
        .map_err(|e| e.to_string())?;
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM exemptions WHERE scope = ?1 OR scope = 'all'",
            rusqlite::params![scope],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

pub fn active_exemptions(conn: &Connection) -> Result<Vec<ExemptionRow>, String> {
    let now = now_ts();
    conn.execute("DELETE FROM exemptions WHERE until <= ?1", rusqlite::params![now])
        .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT scope, ts, until FROM exemptions ORDER BY until")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ExemptionRow {
                scope: r.get(0)?,
                ts: r.get(1)?,
                until: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Current stock for a store entry, `None` = unlimited. Lazily advances
/// `stock_state` through missed restock cron fires; each fire resets the
/// sold-since counter (stock returns to the entry's initial value).
pub fn stock_for(
    conn: &Connection,
    entry: &str,
    initial: i64,
    restock_cron: Option<&str>,
) -> Result<Option<i64>, String> {
    let now = now_ts();
    conn.execute(
        "INSERT OR IGNORE INTO stock_state (entry, initial, last_restock, sold_since) \
         VALUES (?1, ?2, ?3, 0)",
        rusqlite::params![entry, initial, now],
    )
    .map_err(|e| e.to_string())?;

    if let Some(expr) = restock_cron {
        use std::str::FromStr;
        let normalized = crate::validators::normalize_cron(expr);
        if let Ok(schedule) = cron::Schedule::from_str(&normalized) {
            // Advance through every fire between the last restock and now.
            loop {
                let last: String = conn
                    .query_row(
                        "SELECT last_restock FROM stock_state WHERE entry = ?1",
                        rusqlite::params![entry],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                let last_dt = parse_ts(&last).unwrap_or_else(chrono::Utc::now);
                let Some(next) = schedule.after(&last_dt).next() else {
                    break;
                };
                if next > chrono::Utc::now() {
                    break;
                }
                conn.execute(
                    "UPDATE stock_state SET last_restock = ?2, sold_since = 0 WHERE entry = ?1",
                    rusqlite::params![entry, ts_at(next)],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    let (initial, sold): (i64, i64) = conn
        .query_row(
            "SELECT initial, sold_since FROM stock_state WHERE entry = ?1",
            rusqlite::params![entry],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(Some((initial - sold).max(0)))
}

pub fn record_sold(conn: &Connection, entry: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE stock_state SET sold_since = sold_since + 1 WHERE entry = ?1",
        rusqlite::params![entry],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Insert a purchase row and return its id (used as the idempotency
/// source key when executing the entry's actions).
pub fn record_purchase(conn: &Connection, entry: &str, price: i64) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO purchases (ts, entry, price) VALUES (?1, ?2, ?3)",
        rusqlite::params![now_ts(), entry, price],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[derive(Serialize, Clone, Debug)]
pub struct PendingRow {
    pub id: i64,
    pub ts: String,
    pub kind: String,
    pub payload: String,
}

/// Queue a pending action row; returns the new row's id (the script
/// autoplay path uses it to dismiss the row once playback completes).
pub fn queue_pending(conn: &Connection, kind: &str, payload: &str) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO pending_actions (ts, kind, payload) VALUES (?1, ?2, ?3)",
        rusqlite::params![now_ts(), kind, payload],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn list_pending(conn: &Connection) -> Result<Vec<PendingRow>, String> {
    let mut stmt = conn
        .prepare("SELECT id, ts, kind, payload FROM pending_actions ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PendingRow {
                id: r.get(0)?,
                ts: r.get(1)?,
                kind: r.get(2)?,
                payload: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn dismiss_pending(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM pending_actions WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================================
// Tauri commands
// ============================================================================

#[derive(Serialize)]
pub struct EconomySummary {
    pub balance: i64,
    pub ledger: Vec<LedgerRow>,
    pub exemptions: Vec<ExemptionRow>,
    pub pending: Vec<PendingRow>,
}

#[tauri::command]
pub async fn economy_summary(state: State<'_, AppState>) -> Result<EconomySummary, String> {
    let db = state.state_dir.join("economy.db");
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&db)?;
        Ok(EconomySummary {
            balance: balance(&conn)?,
            ledger: recent_ledger(&conn, 20)?,
            exemptions: active_exemptions(&conn)?,
            pending: list_pending(&conn)?,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn economy_dismiss_pending(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.state_dir.join("economy.db");
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&db)?;
        dismiss_pending(&conn, id)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============================================================================
// `points` bash builtin (agent CLI: read + deltas, never a rewrite)
// ============================================================================

pub struct PointsBuiltin {
    db_path: PathBuf,
}

impl PointsBuiltin {
    pub fn new(db_path: PathBuf) -> Self {
        Self { db_path }
    }

    /// Register this builtin on a [`bashkit::BashBuilder`].
    pub fn register(builder: bashkit::BashBuilder, db_path: PathBuf) -> bashkit::BashBuilder {
        builder.builtin("points", Box::new(Self::new(db_path)))
    }
}

#[async_trait]
impl bashkit::Builtin for PointsBuiltin {
    async fn execute(&self, ctx: bashkit::BuiltinContext<'_>) -> bashkit::Result<bashkit::ExecResult> {
        let usage = "usage: points info | points grant <n> \"reason\" | points deduct <n> \"reason\"";
        let conn = match Connection::open(&self.db_path) {
            Ok(c) => c,
            Err(e) => return Ok(bashkit::ExecResult::err(format!("points: {e}\n"), 1)),
        };

        match ctx.args.first().map(String::as_str) {
            None | Some("info") => {
                let bal = match balance(&conn) {
                    Ok(b) => b,
                    Err(e) => return Ok(bashkit::ExecResult::err(format!("points: {e}\n"), 1)),
                };
                let mut out = format!("balance: {bal}\n");
                if let Ok(rows) = recent_ledger(&conn, 5) {
                    for r in rows {
                        out.push_str(&format!(
                            "  {ts} {delta:+} ({reason}) [{source}]\n",
                            ts = r.ts,
                            delta = r.delta,
                            reason = r.reason,
                            source = r.source
                        ));
                    }
                }
                Ok(bashkit::ExecResult::ok(out))
            }
            Some(cmd @ ("grant" | "deduct")) => {
                let sign = if cmd == "grant" { 1 } else { -1 };
                let Some(n) = ctx.args.get(1).and_then(|s| s.parse::<i64>().ok()) else {
                    return Ok(bashkit::ExecResult::err(format!("points: {usage}\n"), 1));
                };
                let reason = ctx.args.get(2..).map(|a| a.join(" ")).unwrap_or_default();
                if reason.trim().is_empty() {
                    return Ok(bashkit::ExecResult::err(
                        "points: a reason is required\n".to_string(),
                        1,
                    ));
                }
                // Unique source per grant — every entry is auditable.
                let source = format!(
                    "agent:{}:{}",
                    chrono::Utc::now().timestamp_micros(),
                    rand::random::<u32>()
                );
                match apply_points(&conn, sign * n, &reason, &source) {
                    Ok(Some(bal)) => Ok(bashkit::ExecResult::ok(format!("balance: {bal}\n"))),
                    Ok(None) => Ok(bashkit::ExecResult::ok("balance unchanged\n".to_string())),
                    Err(e) => Ok(bashkit::ExecResult::err(format!("points: {e}\n"), 1)),
                }
            }
            Some(_) => Ok(bashkit::ExecResult::err(format!("points: {usage}\n"), 1)),
        }
    }

    fn llm_hint(&self) -> Option<&'static str> {
        Some(
            "points — the user's point balance. `points info` shows the balance and recent \
             entries. `points grant <n> \"reason\"` / `points deduct <n> \"reason\"` append to \
             the ledger (a reason is required; every entry is visible to the user). The \
             balance can never be rewritten, only adjusted with a visible, reasoned delta. \
             Negative balances are allowed and are just a number.",
        )
    }
}

// ============================================================================
// Unit tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (tempfile::TempDir, Connection) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("economy.db");
        ensure_schema(&path).expect("schema");
        let conn = open(&path).expect("open");
        (tmp, conn)
    }

    #[test]
    fn points_apply_is_idempotent_by_source() {
        let (_t, conn) = db();
        assert_eq!(
            apply_points(&conn, 15, "routine", "r:1:success").unwrap(),
            Some(15)
        );
        assert_eq!(apply_points(&conn, 15, "routine", "r:1:success").unwrap(), None);
        assert_eq!(
            apply_points(&conn, -5, "fine", "r:2:failure").unwrap(),
            Some(10)
        );
        assert_eq!(balance(&conn).unwrap(), 10);
    }

    #[test]
    fn exemptions_scope_and_expiry() {
        let (_t, conn) = db();
        let future = ts_at(chrono::Utc::now() + chrono::Duration::hours(24));
        let past = ts_at(chrono::Utc::now() - chrono::Duration::hours(1));
        grant_exemption(&conn, "habits", &future).unwrap();
        assert!(exemption_active(&conn, "habits").unwrap());
        assert!(!exemption_active(&conn, "all").unwrap()); // no blanket yet
        assert!(!exemption_active(&conn, "routines").unwrap());

        // An already-expired exemption is purged and never active.
        grant_exemption(&conn, "tasks", &past).unwrap();
        assert!(!exemption_active(&conn, "tasks").unwrap(), "expired purged");

        // The blanket exemption covers every scope.
        grant_exemption(&conn, "all", &future).unwrap();
        assert!(exemption_active(&conn, "routines").unwrap());
        assert!(exemption_active(&conn, "tasks").unwrap());
        assert_eq!(active_exemptions(&conn).unwrap().len(), 2);
    }

    #[test]
    fn stock_counts_down_and_restocks_lazily() {
        let (_t, conn) = db();
        // No restock cron: stock just counts down, floored at 0.
        assert_eq!(stock_for(&conn, "store/a.json", 2, None).unwrap(), Some(2));
        record_sold(&conn, "store/a.json").unwrap();
        assert_eq!(stock_for(&conn, "store/a.json", 2, None).unwrap(), Some(1));
        record_sold(&conn, "store/a.json").unwrap();
        record_sold(&conn, "store/a.json").unwrap();
        assert_eq!(stock_for(&conn, "store/a.json", 2, None).unwrap(), Some(0));
    }

    #[test]
    fn pending_queue_roundtrip() {
        let (_t, conn) = db();
        queue_pending(&conn, "script", "hypnos/x.xml").unwrap();
        queue_pending(&conn, "script", "hypnos/y.xml").unwrap();
        let rows = list_pending(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        dismiss_pending(&conn, rows[0].id).unwrap();
        assert_eq!(list_pending(&conn).unwrap().len(), 1);
        assert_eq!(list_pending(&conn).unwrap()[0].payload, "hypnos/y.xml");
    }
}
