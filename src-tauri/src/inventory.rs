//! Inventory: user-owned items + wishlist, backed by SQLite
//! (`<state_dir>/inventory.db`).
//!
//! The DB lives **outside the agent sandbox** (in `state_dir/`) and is
//! accessed exclusively via **rusqlite (host libsqlite3)**. This ensures
//! reliable persistence — the earlier design routed everything through
//! bashkit's Turso Memory backend, whose snapshot/write-back mechanism
//! silently lost committed rows on restart.
//!
//! Access paths:
//! - **UI**: the Tauri commands below use transient rusqlite connections
//!   (open → operate → close on a blocking thread).
//! - **Agent**: the `inventory` bashkit builtin (registered in `bash.rs`),
//!   which also uses transient rusqlite connections. The agent gets
//!   read access to items and full CRUD on the wishlist.
//!
//! WAL journal mode allows the UI and agent to access the file concurrently
//! without "database is locked" errors.

use std::path::{Path, PathBuf};

use bashkit::{async_trait, Builtin, BuiltinContext, ExecResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

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
// Schema bootstrap
// ============================================================================

const SCHEMA_SQL: &str = "\
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
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

/// Create / migrate the inventory DB schema and pin `journal_mode=WAL`.
/// Idempotent.
pub fn ensure_schema(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA_SQL).map_err(|e| e.to_string())?;
    Ok(())
}

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

// ============================================================================
// rusqlite helpers
// ============================================================================

/// Open a transient rusqlite connection to the inventory DB.
fn open_db(db_path: &Path) -> Result<Connection, String> {
    Connection::open(db_path).map_err(|e| e.to_string())
}

const ITEM_COLS: &str = "id, name, category, quantity, notes, created_at, updated_at";

fn map_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<InventoryItem> {
    Ok(InventoryItem {
        id: row.get(0)?,
        name: row.get(1)?,
        category: row.get(2)?,
        quantity: row.get(3)?,
        notes: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const WISH_COLS: &str = "id, name, category, priority, notes, created_at, updated_at";

fn map_wish(row: &rusqlite::Row<'_>) -> rusqlite::Result<WishlistItem> {
    Ok(WishlistItem {
        id: row.get(0)?,
        name: row.get(1)?,
        category: row.get(2)?,
        priority: row.get(3)?,
        notes: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

// ============================================================================
// Tauri commands — Items (UI-facing, rusqlite direct)
// ============================================================================

#[tauri::command]
pub async fn inventory_list_items(
    state: State<'_, AppState>,
) -> Result<Vec<InventoryItem>, String> {
    let db_path = state.state_dir.join("inventory.db");
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&db_path)?;
        let mut stmt =
            conn.prepare(&format!("SELECT {ITEM_COLS} FROM items ORDER BY id"))
                .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], map_item).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
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
    let db_path = state.state_dir.join("inventory.db");
    tauri::async_runtime::spawn_blocking(move || -> Result<InventoryItem, String> {
        let conn = open_db(&db_path)?;
        conn.execute(
            "INSERT INTO items (name, category, quantity, notes, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![name, category, qty, notes, now, now],
        )
        .map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();
        Ok(InventoryItem {
            id,
            name,
            category,
            quantity: qty,
            notes,
            created_at: now.clone(),
            updated_at: now,
        })
    })
    .await
    .map_err(|e| e.to_string())?
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
    let qty = quantity.max(0);
    let db_path = state.state_dir.join("inventory.db");
    tauri::async_runtime::spawn_blocking(move || -> Result<InventoryItem, String> {
        let conn = open_db(&db_path)?;
        let changed = conn
            .execute(
                "UPDATE items SET name=?2, category=?3, quantity=?4, notes=?5, updated_at=?6 \
                 WHERE id=?1",
                params![id, name, category, qty, notes, now],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(format!("item {id} not found"));
        }
        let created_at: String = conn
            .query_row(
                "SELECT created_at FROM items WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(InventoryItem {
            id,
            name,
            category,
            quantity: qty,
            notes,
            created_at,
            updated_at: now,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inventory_remove_item(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let db_path = state.state_dir.join("inventory.db");
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let conn = open_db(&db_path)?;
        let changed = conn
            .execute("DELETE FROM items WHERE id=?1", params![id])
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(format!("item {id} not found"));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============================================================================
// Tauri commands — Wishlist (UI-facing, rusqlite direct)
// ============================================================================

#[tauri::command]
pub async fn inventory_list_wishlist(
    state: State<'_, AppState>,
) -> Result<Vec<WishlistItem>, String> {
    let db_path = state.state_dir.join("inventory.db");
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db(&db_path)?;
        let mut stmt =
            conn.prepare(&format!("SELECT {WISH_COLS} FROM wishlist ORDER BY id"))
                .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], map_wish).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
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
    let db_path = state.state_dir.join("inventory.db");
    tauri::async_runtime::spawn_blocking(move || -> Result<WishlistItem, String> {
        let conn = open_db(&db_path)?;
        conn.execute(
            "INSERT INTO wishlist (name, category, priority, notes, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![name, category, priority, notes, now, now],
        )
        .map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();
        Ok(WishlistItem {
            id,
            name,
            category,
            priority,
            notes,
            created_at: now.clone(),
            updated_at: now,
        })
    })
    .await
    .map_err(|e| e.to_string())?
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
    let db_path = state.state_dir.join("inventory.db");
    tauri::async_runtime::spawn_blocking(move || -> Result<WishlistItem, String> {
        let conn = open_db(&db_path)?;
        let changed = conn
            .execute(
                "UPDATE wishlist SET name=?2, category=?3, priority=?4, notes=?5, updated_at=?6 \
                 WHERE id=?1",
                params![id, name, category, priority, notes, now],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(format!("wishlist item {id} not found"));
        }
        let created_at: String = conn
            .query_row(
                "SELECT created_at FROM wishlist WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(WishlistItem {
            id,
            name,
            category,
            priority,
            notes,
            created_at,
            updated_at: now,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inventory_remove_wishlist_item(
    id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db_path = state.state_dir.join("inventory.db");
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let conn = open_db(&db_path)?;
        let changed = conn
            .execute("DELETE FROM wishlist WHERE id=?1", params![id])
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(format!("wishlist item {id} not found"));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============================================================================
// Builtin (agent-facing)
// ============================================================================
//
//   inventory items                                    — list all items
//   inventory items <id>                               — show one item
//   inventory wishlist                                 — list all wishlist items
//   inventory wishlist <id>                            — show one wishlist item
//   inventory wishlist add <name> [category] [priority] [notes...]
//                                                      — add a wishlist entry
//   inventory wishlist remove <id>                     — remove a wishlist entry
//
// The agent may read items but may not add/update/remove them — only the
// user can (via the UI). The agent has full CRUD on the wishlist.

pub struct InventoryBuiltin {
    db_path: PathBuf,
}

impl InventoryBuiltin {
    pub fn new(db_path: PathBuf) -> Self {
        Self { db_path }
    }

    /// Register this builtin on a [`bashkit::BashBuilder`].
    pub fn register(builder: bashkit::BashBuilder, db_path: PathBuf) -> bashkit::BashBuilder {
        builder.builtin("inventory", Box::new(Self::new(db_path)))
    }
}

fn fmt_item_row(out: &mut String, item: &InventoryItem) {
    out.push_str(&format!(
        "{}\t{}\t{}\t{}\t{}\t{}\n",
        item.id,
        item.name,
        item.category.as_deref().unwrap_or(""),
        item.quantity,
        item.notes.as_deref().unwrap_or(""),
        item.created_at,
    ));
}

fn fmt_wish_row(out: &mut String, item: &WishlistItem) {
    out.push_str(&format!(
        "{}\t{}\t{}\t{}\t{}\t{}\n",
        item.id,
        item.name,
        item.category.as_deref().unwrap_or(""),
        item.priority.as_deref().unwrap_or(""),
        item.notes.as_deref().unwrap_or(""),
        item.created_at,
    ));
}

#[async_trait]
impl Builtin for InventoryBuiltin {
    async fn execute(&self, ctx: BuiltinContext<'_>) -> bashkit::Result<ExecResult> {
        let usage = "Usage: inventory items [id] | wishlist [id | add <name> [cat] [priority] [notes...] | remove <id>]";

        let group = match ctx.args.first() {
            Some(s) => s.as_str(),
            None => return Ok(ExecResult::err(usage, 1)),
        };

        let conn = match Connection::open(&self.db_path) {
            Ok(c) => c,
            Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
        };

        match group {
            "items" => {
                if let Some(id_str) = ctx.args.get(1) {
                    let id: i64 = match id_str.parse() {
                        Ok(n) => n,
                        Err(_) => return Ok(ExecResult::err("items <id> must be a number\n", 1)),
                    };
                    let item = match conn.query_row(
                        &format!("SELECT {ITEM_COLS} FROM items WHERE id=?1"),
                        params![id],
                        map_item,
                    ) {
                        Ok(it) => it,
                        Err(rusqlite::Error::QueryReturnedNoRows) => {
                            return Ok(ExecResult::err(format!("item {id} not found\n"), 1))
                        }
                        Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                    };
                    let mut out = String::new();
                    out.push_str("id\tname\tcategory\tquantity\tnotes\tcreated_at\n");
                    fmt_item_row(&mut out, &item);
                    Ok(ExecResult::ok(out))
                } else {
                    let mut stmt = match conn.prepare(&format!(
                        "SELECT {ITEM_COLS} FROM items ORDER BY id"
                    )) {
                        Ok(s) => s,
                        Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                    };
                    let rows = match stmt.query_map([], map_item) {
                        Ok(r) => r,
                        Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                    };
                    let mut out = String::new();
                    out.push_str("id\tname\tcategory\tquantity\tnotes\tcreated_at\n");
                    for r in rows {
                        let item = match r {
                            Ok(it) => it,
                            Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                        };
                        fmt_item_row(&mut out, &item);
                    }
                    Ok(ExecResult::ok(out))
                }
            }
            "wishlist" => {
                let sub = ctx.args.get(1).map(|s| s.as_str()).unwrap_or("");
                match sub {
                    "" => {
                        let mut stmt = match conn.prepare(&format!(
                            "SELECT {WISH_COLS} FROM wishlist ORDER BY id"
                        )) {
                            Ok(s) => s,
                            Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                        };
                        let rows = match stmt.query_map([], map_wish) {
                            Ok(r) => r,
                            Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                        };
                        let mut out = String::new();
                        out.push_str("id\tname\tcategory\tpriority\tnotes\tcreated_at\n");
                        for r in rows {
                            let item = match r {
                                Ok(it) => it,
                                Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                            };
                            fmt_wish_row(&mut out, &item);
                        }
                        Ok(ExecResult::ok(out))
                    }
                    "add" => {
                        let name = match ctx.args.get(2) {
                            Some(n) => n.clone(),
                            None => {
                                return Ok(ExecResult::err(
                                    "wishlist add <name> [category] [priority] [notes...]\n",
                                    1,
                                ))
                            }
                        };
                        let category = ctx.args.get(3).cloned();
                        let priority = ctx.args.get(4).cloned();
                        let notes: Option<String> = if ctx.args.len() > 5 {
                            Some(ctx.args[5..].join(" "))
                        } else {
                            None
                        };
                        let now = now_rfc3339();
                        match conn.execute(
                            "INSERT INTO wishlist (name, category, priority, notes, \
                             created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                            params![name, category, priority, notes, now, now],
                        ) {
                            Ok(_) => {
                                let id = conn.last_insert_rowid();
                                Ok(ExecResult::ok(format!(
                                    "added wishlist item {id}: {name}\n"
                                )))
                            }
                            Err(e) => Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                        }
                    }
                    "remove" => {
                        let id_str = match ctx.args.get(2) {
                            Some(s) => s,
                            None => return Ok(ExecResult::err("wishlist remove <id>\n", 1)),
                        };
                        let id: i64 = match id_str.parse() {
                            Ok(n) => n,
                            Err(_) => {
                                return Ok(ExecResult::err("remove <id> must be a number\n", 1))
                            }
                        };
                        match conn.execute("DELETE FROM wishlist WHERE id=?1", params![id]) {
                            Ok(0) => Ok(ExecResult::err(format!("item {id} not found\n"), 1)),
                            Ok(_) => Ok(ExecResult::ok(format!("removed wishlist item {id}\n"))),
                            Err(e) => Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                        }
                    }
                    other => {
                        // Try parsing as an id.
                        if let Ok(id) = other.parse::<i64>() {
                            let item = match conn.query_row(
                                &format!("SELECT {WISH_COLS} FROM wishlist WHERE id=?1"),
                                params![id],
                                map_wish,
                            ) {
                                Ok(it) => it,
                                Err(rusqlite::Error::QueryReturnedNoRows) => {
                                    return Ok(ExecResult::err(
                                        format!("wishlist item {id} not found\n"),
                                        1,
                                    ))
                                }
                                Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                            };
                            let mut out = String::new();
                            out.push_str("id\tname\tcategory\tpriority\tnotes\tcreated_at\n");
                            fmt_wish_row(&mut out, &item);
                            Ok(ExecResult::ok(out))
                        } else {
                            Ok(ExecResult::err(
                                format!("unknown wishlist subcommand '{other}'. {usage}\n"),
                                1,
                            ))
                        }
                    }
                }
            }
            other => Ok(ExecResult::err(
                format!("unknown command '{other}'. {usage}\n"),
                1,
            )),
        }
    }

    fn llm_hint(&self) -> Option<&'static str> {
        Some(
            "inventory: View owned items or manage the wishlist. \
             Subcommands: items [id], wishlist [id], wishlist add <name> [cat] [priority] [notes], \
             wishlist remove <id>. Items are read-only (managed by the user via the UI).",
        )
    }
}
