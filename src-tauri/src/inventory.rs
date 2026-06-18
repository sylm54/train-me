//! Inventory: user-owned items + wishlist, backed by SQLite
//! (`<agent_dir>/inventory.db`).
//!
//! The DB lives **inside the agent sandbox** and is accessed by a single
//! engine — the embedded Turso-backed `sqlite` builtin — from both sides:
//!
//! - **Agent**: runs `sqlite` queries directly against `/inventory.db`,
//!   with full read/write access to both the `items` and `wishlist`
//!   tables.
//! - **UI**: the Tauri commands below also route through the sandbox
//!   (`BashSandbox::exec`), so every read and write goes through the same
//!   Turso engine.
//!
//! This mirrors the architecture of `activity_db.rs` — see that module's
//! docs for the rationale on `journal_mode=DELETE` and the transient
//! schema-bootstrap connection.

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
pub struct InventoryItem {
    pub id: i64,
    pub name: String,
    pub category: Option<String>,
    pub quantity: i64,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WishlistItem {
    pub id: i64,
    pub name: String,
    pub category: Option<String>,
    pub priority: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// ============================================================================
// Schema bootstrap (one-shot, transient libsqlite3 connection)
// ============================================================================

const SCHEMA_SQL: &str = "\
PRAGMA journal_mode=DELETE;
CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    category    TEXT,
    quantity    INTEGER NOT NULL DEFAULT 1,
    notes       TEXT,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS wishlist (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    category    TEXT,
    priority    TEXT,
    notes       TEXT,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
CREATE INDEX IF NOT EXISTS idx_wishlist_category ON wishlist(category);
";

/// Create / migrate the inventory DB schema and pin `journal_mode=DELETE`.
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

/// Run a fixed (no user input) `SELECT` against `/inventory.db` through the
/// sandbox and return the `-json` output. Fails on a non-zero exit code.
async fn query_json(bash: &BashSandbox, sql: &str) -> Result<String, String> {
    // The SQL is built by us with no interpolated user text, so wrapping it
    // in bash double quotes is safe (no `"`, `$`, backticks, or backslashes).
    let cmd = format!("sqlite -json inventory.db \"{sql}\"");
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

/// Parse the `-json` array produced by [`query_json`] into items.
/// An empty result set renders as `[]`, which we accept as "no rows".
fn parse_items(json: &str) -> Result<Vec<InventoryItem>, String> {
    let trimmed = json.trim();
    if trimmed.is_empty() || trimmed == "null" || trimmed == "[]" {
        return Ok(Vec::new());
    }
    serde_json::from_str(trimmed).map_err(|e| format!("parse items json: {e}"))
}

/// Parse the `-json` array produced by [`query_json`] into wishlist items.
fn parse_wishlist(json: &str) -> Result<Vec<WishlistItem>, String> {
    let trimmed = json.trim();
    if trimmed.is_empty() || trimmed == "null" || trimmed == "[]" {
        return Ok(Vec::new());
    }
    serde_json::from_str(trimmed).map_err(|e| format!("parse wishlist json: {e}"))
}

/// Escape a string for safe interpolation into a SQL single-quoted literal:
/// double every `'`.
fn sql_escape(s: &str) -> String {
    s.replace('\'', "''")
}

/// Render an `Option<String>` as a SQL literal: `NULL` or `'escaped'`.
fn sql_opt(s: &Option<String>) -> String {
    match s {
        Some(v) => format!("'{}'", sql_escape(v)),
        None => "NULL".to_string(),
    }
}

/// Monotonic counter so concurrent UI writes never collide on the temp
/// `.read` file.
static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Write a SQL statement (which may contain user-supplied text) to a temp
/// `.read` file under the sandbox root, execute it via the sandbox, and
/// remove the file. Sidesteps the bash/quoting/SQL triple-escaping problem.
async fn exec_write(bash: &BashSandbox, agent_dir: &Path, sql: &str) -> Result<(), String> {
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let rel = format!(".inventory_write_{seq}.sql");
    let path: PathBuf = crate::bash::resolve_under(agent_dir, &rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    std::fs::write(&path, sql).map_err(|e| format!("write {}: {}", path.display(), e))?;

    // Execute, then clean up best-effort regardless of outcome.
    let cmd = format!("sqlite inventory.db \".read {rel}\"");
    let exec_res = bash.exec(&cmd).await;
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
    Ok(())
}

// ============================================================================
// Tauri commands — Items (UI-facing, routed through the sandbox)
// ============================================================================

#[tauri::command]
pub async fn inventory_list_items(
    state: State<'_, AppState>,
) -> Result<Vec<InventoryItem>, String> {
    let out = query_json(
        &state.bash,
        "SELECT id, name, category, quantity, notes, created_at, updated_at \
         FROM items ORDER BY id",
    )
    .await?;
    parse_items(&out)
}

#[tauri::command]
pub async fn inventory_add_item(
    name: String,
    category: Option<String>,
    quantity: Option<i64>,
    notes: Option<String>,
    state: State<'_, AppState>,
) -> Result<InventoryItem, String> {
    let now = now_rfc3339();
    let qty = quantity.unwrap_or(1).max(0);

    let sql = format!(
        "INSERT INTO items (name, category, quantity, notes, created_at, updated_at) \
         VALUES ('{name}', {category}, {qty}, {notes}, '{ts}', '{ts}');\n",
        name = sql_escape(&name),
        category = sql_opt(&category),
        notes = sql_opt(&notes),
        ts = sql_escape(&now),
    );

    exec_write(&state.bash, &state.agent_dir, &sql).await?;

    Ok(InventoryItem {
        id: 0,
        name,
        category,
        quantity: qty,
        notes,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
pub async fn inventory_update_item(
    id: i64,
    name: String,
    category: Option<String>,
    quantity: i64,
    notes: Option<String>,
    state: State<'_, AppState>,
) -> Result<InventoryItem, String> {
    let now = now_rfc3339();

    let sql = format!(
        "UPDATE items SET name='{name}', category={category}, quantity={qty}, \
         notes={notes}, updated_at='{ts}' WHERE id={id};\n",
        name = sql_escape(&name),
        category = sql_opt(&category),
        qty = quantity.max(0),
        notes = sql_opt(&notes),
        ts = sql_escape(&now),
        id = id,
    );

    exec_write(&state.bash, &state.agent_dir, &sql).await?;

    Ok(InventoryItem {
        id,
        name,
        category,
        quantity: quantity.max(0),
        notes,
        created_at: now.clone(), // We don't read back; UI refetches.
        updated_at: now,
    })
}

#[tauri::command]
pub async fn inventory_remove_item(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    // `id` is an i64, so it is safe to interpolate directly.
    let cmd = format!("sqlite inventory.db \"DELETE FROM items WHERE id = {id}\"");
    let res = state.bash.exec(&cmd).await?;
    if res.exit_code != 0 {
        let msg = res.stderr.trim();
        return Err(if msg.is_empty() {
            format!("sqlite exited {} (no stderr)", res.exit_code)
        } else {
            msg.to_string()
        });
    }
    Ok(())
}

// ============================================================================
// Tauri commands — Wishlist (UI-facing, routed through the sandbox)
// ============================================================================

#[tauri::command]
pub async fn inventory_list_wishlist(
    state: State<'_, AppState>,
) -> Result<Vec<WishlistItem>, String> {
    let out = query_json(
        &state.bash,
        "SELECT id, name, category, priority, notes, created_at, updated_at \
         FROM wishlist ORDER BY id",
    )
    .await?;
    parse_wishlist(&out)
}

#[tauri::command]
pub async fn inventory_add_wishlist_item(
    name: String,
    category: Option<String>,
    priority: Option<String>,
    notes: Option<String>,
    state: State<'_, AppState>,
) -> Result<WishlistItem, String> {
    let now = now_rfc3339();

    let sql = format!(
        "INSERT INTO wishlist (name, category, priority, notes, created_at, updated_at) \
         VALUES ('{name}', {category}, {priority}, {notes}, '{ts}', '{ts}');\n",
        name = sql_escape(&name),
        category = sql_opt(&category),
        priority = sql_opt(&priority),
        notes = sql_opt(&notes),
        ts = sql_escape(&now),
    );

    exec_write(&state.bash, &state.agent_dir, &sql).await?;

    Ok(WishlistItem {
        id: 0,
        name,
        category,
        priority,
        notes,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
pub async fn inventory_update_wishlist_item(
    id: i64,
    name: String,
    category: Option<String>,
    priority: Option<String>,
    notes: Option<String>,
    state: State<'_, AppState>,
) -> Result<WishlistItem, String> {
    let now = now_rfc3339();

    let sql = format!(
        "UPDATE wishlist SET name='{name}', category={category}, priority={priority}, \
         notes={notes}, updated_at='{ts}' WHERE id={id};\n",
        name = sql_escape(&name),
        category = sql_opt(&category),
        priority = sql_opt(&priority),
        notes = sql_opt(&notes),
        ts = sql_escape(&now),
        id = id,
    );

    exec_write(&state.bash, &state.agent_dir, &sql).await?;

    Ok(WishlistItem {
        id,
        name,
        category,
        priority,
        notes,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
pub async fn inventory_remove_wishlist_item(
    id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // `id` is an i64, so it is safe to interpolate directly.
    let cmd = format!("sqlite inventory.db \"DELETE FROM wishlist WHERE id = {id}\"");
    let res = state.bash.exec(&cmd).await?;
    if res.exit_code != 0 {
        let msg = res.stderr.trim();
        return Err(if msg.is_empty() {
            format!("sqlite exited {} (no stderr)", res.exit_code)
        } else {
            msg.to_string()
        });
    }
    Ok(())
}
