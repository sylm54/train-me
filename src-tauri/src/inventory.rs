//! Inventory: user-owned items + agent/user-maintained wishlist, backed
//! by SQLite (`<state_dir>/inventory.db`).
//!
//! The DB is created automatically on first run with two tables
//! (`items`, `wishlist`). The agent may only read items; it has full
//! CRUD on wishlist entries.

use std::path::{Path, PathBuf};

use bashkit::{async_trait, Builtin, BuiltinContext, ExecResult};
use parking_lot::Mutex;
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
// DB init
// ============================================================================

/// Schema SQL shared by [`init_db`] (create-if-absent) and [`reset_db`]
/// (drop-and-recreate). Kept as a single source of truth so the two paths
/// can never drift.
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
);";

/// Open (and create + migrate) the inventory DB. Idempotent.
pub fn init_db(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA_SQL).map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Drop and recreate all inventory tables on an existing (held) connection,
/// wiping every row and resetting the autoincrement counters. Used by the
/// app-data reset so we never have to close/delete the open DB file.
pub fn reset_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS items;
         DROP TABLE IF EXISTS wishlist;",
    )
    .map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA_SQL).map_err(|e| e.to_string())?;
    Ok(())
}

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

// ============================================================================
// Row mappers
// ============================================================================

const ITEM_SELECT: &str = "id, name, category, quantity, notes, created_at, updated_at FROM items";

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

const WISH_SELECT: &str =
    "id, name, category, priority, notes, created_at, updated_at FROM wishlist";

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
// Tauri commands (UI-facing — full CRUD for both tables)
// ============================================================================

#[tauri::command]
pub fn inventory_list_items(state: State<'_, AppState>) -> Result<Vec<InventoryItem>, String> {
    let conn = state.inventory_db.lock();
    let mut stmt = conn
        .prepare(&format!("SELECT {ITEM_SELECT} ORDER BY id"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_item).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn inventory_add_item(
    name: String,
    category: Option<String>,
    quantity: Option<i64>,
    notes: Option<String>,
    state: State<'_, AppState>,
) -> Result<InventoryItem, String> {
    let now = now_rfc3339();
    let qty = quantity.unwrap_or(1).max(0);
    let conn = state.inventory_db.lock();
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
}

#[tauri::command]
pub fn inventory_update_item(
    id: i64,
    name: String,
    category: Option<String>,
    quantity: i64,
    notes: Option<String>,
    state: State<'_, AppState>,
) -> Result<InventoryItem, String> {
    let now = now_rfc3339();
    let conn = state.inventory_db.lock();
    let changed = conn
        .execute(
            "UPDATE items SET name=?2, category=?3, quantity=?4, notes=?5, updated_at=?6 \
             WHERE id=?1",
            params![id, name, category, quantity.max(0), notes, now],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("item {id} not found"));
    }
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
pub fn inventory_remove_item(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.inventory_db.lock();
    let changed = conn
        .execute("DELETE FROM items WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("item {id} not found"));
    }
    Ok(())
}

#[tauri::command]
pub fn inventory_list_wishlist(state: State<'_, AppState>) -> Result<Vec<WishlistItem>, String> {
    let conn = state.inventory_db.lock();
    let mut stmt = conn
        .prepare(&format!("SELECT {WISH_SELECT} ORDER BY id"))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_wish).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn inventory_add_wishlist_item(
    name: String,
    category: Option<String>,
    priority: Option<String>,
    notes: Option<String>,
    state: State<'_, AppState>,
) -> Result<WishlistItem, String> {
    let now = now_rfc3339();
    let conn = state.inventory_db.lock();
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
}

#[tauri::command]
pub fn inventory_update_wishlist_item(
    id: i64,
    name: String,
    category: Option<String>,
    priority: Option<String>,
    notes: Option<String>,
    state: State<'_, AppState>,
) -> Result<WishlistItem, String> {
    let now = now_rfc3339();
    let conn = state.inventory_db.lock();
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
pub fn inventory_remove_wishlist_item(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.inventory_db.lock();
    let changed = conn
        .execute("DELETE FROM wishlist WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("wishlist item {id} not found"));
    }
    Ok(())
}

// ============================================================================
// Builtin (agent-facing)
// ============================================================================
//
//   inventory items                          — list all items
//   inventory items <id>                     — show one item
//   inventory wishlist                       — list all wishlist items
//   inventory wishlist <id>                  — show one wishlist item
//   inventory wishlist add <name> [cat] [priority] [notes...]
//                                            — add a wishlist entry
//   inventory wishlist remove <id>           — remove a wishlist entry
//
// The agent may not add/update/remove items — only the user can (via the UI
// or by instructing the user to do it).

pub struct InventoryBuiltin {
    db: Mutex<Connection>,
}

impl InventoryBuiltin {
    pub fn new(db_path: PathBuf) -> Self {
        let conn = init_db(&db_path).expect("failed to open inventory.db");
        Self {
            db: Mutex::new(conn),
        }
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
        let conn = self.db.lock();

        match group {
            "items" => {
                if let Some(id_str) = ctx.args.get(1) {
                    let id: i64 = match id_str.parse() {
                        Ok(n) => n,
                        Err(_) => return Ok(ExecResult::err("items <id> must be a number\n", 1)),
                    };
                    let item = match conn.query_row(
                        &format!("SELECT {ITEM_SELECT} WHERE id=?1"),
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
                    let mut stmt = match conn.prepare(&format!("SELECT {ITEM_SELECT} ORDER BY id"))
                    {
                        Ok(s) => s,
                        Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                    };
                    let rows = match stmt.query_map([], map_item) {
                        Ok(r) => r,
                        Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                    };
                    let mut out = String::new();
                    let mut count = 0;
                    out.push_str("id\tname\tcategory\tquantity\tnotes\tcreated_at\n");
                    for r in rows {
                        match r {
                            Ok(item) => fmt_item_row(&mut out, &item),
                            Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                        }
                        count += 1;
                    }
                    if count == 0 {
                        out.push_str("(no items)\n");
                    }
                    Ok(ExecResult::ok(out))
                }
            }
            "wishlist" => {
                let sub = ctx.args.get(1).map(|s| s.as_str()).unwrap_or("");
                match sub {
                    "" => {
                        let mut stmt =
                            match conn.prepare(&format!("SELECT {WISH_SELECT} ORDER BY id")) {
                                Ok(s) => s,
                                Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                            };
                        let rows = match stmt.query_map([], map_wish) {
                            Ok(r) => r,
                            Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                        };
                        let mut out = String::new();
                        let mut count = 0;
                        out.push_str("id\tname\tcategory\tpriority\tnotes\tcreated_at\n");
                        for r in rows {
                            match r {
                                Ok(item) => fmt_wish_row(&mut out, &item),
                                Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                            }
                            count += 1;
                        }
                        if count == 0 {
                            out.push_str("(no wishlist items)\n");
                        }
                        Ok(ExecResult::ok(out))
                    }
                    "add" => {
                        let name = match ctx.args.get(2) {
                            Some(s) if !s.is_empty() => s.clone(),
                            _ => return Ok(ExecResult::err("wishlist add requires <name>\n", 1)),
                        };
                        let category = ctx.args.get(3).filter(|s| !s.is_empty()).cloned();
                        let priority = ctx.args.get(4).filter(|s| !s.is_empty()).cloned();
                        let notes = ctx.args.get(5..).map(|slice| slice.join(" "));
                        let now = now_rfc3339();
                        match conn.execute(
                            "INSERT INTO wishlist (name, category, priority, notes, created_at, updated_at) \
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                            params![name, category, priority, notes, now, now],
                        ) {
                            Ok(_) => {
                                let id = conn.last_insert_rowid();
                                Ok(ExecResult::ok(format!("added wishlist #{id}\n")))
                            }
                            Err(e) => Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                        }
                    }
                    "remove" => {
                        let id_str = match ctx.args.get(2) {
                            Some(s) => s.as_str(),
                            None => {
                                return Ok(ExecResult::err("wishlist remove requires <id>\n", 1))
                            }
                        };
                        let id: i64 = match id_str.parse() {
                            Ok(n) => n,
                            Err(_) => {
                                return Ok(ExecResult::err(
                                    "wishlist remove <id> must be a number\n",
                                    1,
                                ))
                            }
                        };
                        match conn.execute("DELETE FROM wishlist WHERE id=?1", params![id]) {
                            Ok(0) => Ok(ExecResult::err(format!("wishlist {id} not found\n"), 1)),
                            Ok(_) => Ok(ExecResult::ok(format!("removed wishlist #{id}\n"))),
                            Err(e) => Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                        }
                    }
                    _ => {
                        // try numeric → show one wishlist item
                        let id: i64 = match sub.parse() {
                            Ok(n) => n,
                            Err(_) => {
                                return Ok(ExecResult::err(
                                    format!("unknown subcommand '{sub}'. {usage}\n"),
                                    1,
                                ))
                            }
                        };
                        let item = match conn.query_row(
                            &format!("SELECT {WISH_SELECT} WHERE id=?1"),
                            params![id],
                            map_wish,
                        ) {
                            Ok(it) => it,
                            Err(rusqlite::Error::QueryReturnedNoRows) => {
                                return Ok(ExecResult::err(format!("wishlist {id} not found\n"), 1))
                            }
                            Err(e) => return Ok(ExecResult::err(format!("db: {e}\n"), 1)),
                        };
                        let mut out = String::new();
                        out.push_str("id\tname\tcategory\tpriority\tnotes\tcreated_at\n");
                        fmt_wish_row(&mut out, &item);
                        Ok(ExecResult::ok(out))
                    }
                }
            }
            other => Ok(ExecResult::err(
                format!("unknown group '{other}'. {usage}\n"),
                1,
            )),
        }
    }

    fn llm_hint(&self) -> Option<&'static str> {
        Some(
            "inventory: Read items or read/modify the wishlist. \
             items [id], wishlist [id], \
             wishlist add <name> [category] [priority] [notes...], \
             wishlist remove <id>. \
             Items are user-only — never add/update/remove items yourself.",
        )
    }
}
