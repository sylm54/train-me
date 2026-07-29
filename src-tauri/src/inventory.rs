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
// Tauri commands — CSV im/export (UI-facing)
// ============================================================================
//
// Both items and wishlist are round-tripped through a single CSV with a
// leading `type` column (`item` / `wishlist`). They share `id, name,
// category, notes, created_at, updated_at`; items additionally use
// `quantity` (blank for wishlist) and wishlist uses `priority` (blank for
// items). Import upserts by id (preserves ids for a true round-trip) and
// never deletes rows absent from the CSV — it's a merge/update.

/// Header row of the inventory CSV, in column order.
const CSV_HEADER: &[&str] = &[
    "type",
    "id",
    "name",
    "category",
    "quantity",
    "priority",
    "notes",
    "created_at",
    "updated_at",
];

/// Re-export of [`crate::ExportResult`] under a shorter local alias so the
/// CSV commands read symmetrically with the zip exports.
type ExportResult = crate::ExportResult;

/// Tauri command: export both tables to a single RFC-4180 CSV.
///
/// Writes rows for every item (type=`item`, blank `priority`) followed by
/// every wishlist row (type=`wishlist`, blank `quantity`). Quoting is handled
/// by the `csv` crate, so commas/quotes/newlines in `notes`/`name` are safe.
#[tauri::command]
pub async fn inventory_export_csv(
    out_path: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ExportResult, String> {
    let db_path = state.state_dir.join("inventory.db");
    let csv_bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let conn = open_db(&db_path)?;
        let items: Vec<InventoryItem> = {
            let mut stmt = conn
                .prepare(&format!("SELECT {ITEM_COLS} FROM items ORDER BY id"))
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], map_item).map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| e.to_string())?);
            }
            out
        };
        let wishlist: Vec<WishlistItem> = {
            let mut stmt = conn
                .prepare(&format!("SELECT {WISH_COLS} FROM wishlist ORDER BY id"))
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], map_wish).map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| e.to_string())?);
            }
            out
        };

        let mut wtr = csv::Writer::from_writer(Vec::new());
        wtr.write_record(CSV_HEADER).map_err(|e| e.to_string())?;
        for it in &items {
            wtr.write_record([
                "item",
                &it.id.to_string(),
                &it.name,
                it.category.as_deref().unwrap_or(""),
                &it.quantity.to_string(),
                "", // priority — not an items column
                it.notes.as_deref().unwrap_or(""),
                &it.created_at,
                &it.updated_at,
            ])
            .map_err(|e| e.to_string())?;
        }
        for wl in &wishlist {
            wtr.write_record([
                "wishlist",
                &wl.id.to_string(),
                &wl.name,
                wl.category.as_deref().unwrap_or(""),
                "", // quantity — not a wishlist column
                wl.priority.as_deref().unwrap_or(""),
                wl.notes.as_deref().unwrap_or(""),
                &wl.created_at,
                &wl.updated_at,
            ])
            .map_err(|e| e.to_string())?;
        }
        let bytes = wtr
            .into_inner()
            .map_err(|e| format!("csv flush failed: {}", e))?;
        Ok(bytes)
    })
    .await
    .map_err(|e| e.to_string())??;

    let total_bytes = csv_bytes.len() as u64;
    // CSV has no concept of entries; report the data-row count (header is row 1).
    let row_count = csv::Reader::from_reader(csv_bytes.as_slice())
        .records()
        .count();
    let note = crate::persist_export_artifact(&app, out_path, &csv_bytes, "inventory.csv", "text/csv").await?;

    Ok(ExportResult {
        files: row_count,
        bytes: total_bytes,
        note,
    })
}

/// Result of [`inventory_import_csv`]: how many rows were inserted vs.
/// updated, split per table.
#[derive(Serialize, Clone, Debug, Default)]
pub struct InventoryCsvImportResult {
    pub items_added: usize,
    pub items_updated: usize,
    pub wishlist_added: usize,
    pub wishlist_updated: usize,
    /// Non-fatal warnings, one per line (e.g. skipped malformed rows).
    pub note: Option<String>,
}

/// A single decoded CSV row, after the `type` column is interpreted.
enum CsvRow {
    Item {
        id: i64,
        name: String,
        category: Option<String>,
        quantity: i64,
        notes: Option<String>,
        created_at: String,
        updated_at: String,
    },
    Wishlist {
        id: i64,
        name: String,
        category: Option<String>,
        priority: Option<String>,
        notes: Option<String>,
        created_at: String,
        updated_at: String,
    },
}

/// Treat an empty string as `None`, otherwise `Some(trimmed)`.
fn opt_str(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Tauri command: import (upsert) rows from a single CSV produced by
/// [`inventory_export_csv`].
///
/// `path` is either a regular filesystem path (desktop) or an Android
/// `content://` URI (read into memory via `tauri-plugin-android-fs`). Rows
/// are upserted by id: an existing id is updated, a new id is inserted. Rows
/// absent from the CSV are left untouched (import = merge, not replace).
/// Unknown `type` values or unparseable rows are skipped with a warning.
#[tauri::command]
pub async fn inventory_import_csv(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<InventoryCsvImportResult, String> {
    // Read the file bytes (handles content:// on Android, plain path elsewhere).
    let bytes = read_csv_bytes(&app, &path).await?;

    // Parse + decode on a blocking thread.
    let rows = tauri::async_runtime::spawn_blocking(move || -> Result<(Vec<CsvRow>, Vec<String>), String> {
        let mut rdr = csv::Reader::from_reader(bytes.as_slice());
        let mut out: Vec<CsvRow> = Vec::new();
        let mut warnings: Vec<String> = Vec::new();
        for (i, rec) in rdr.records().enumerate() {
            let rec = match rec {
                Ok(r) => r,
                Err(e) => {
                    warnings.push(format!("row {}: skipped (parse error: {})", i + 2, e));
                    continue;
                }
            };
            // Columns: type,id,name,category,quantity,priority,notes,created_at,updated_at
            let get = |idx: usize| rec.get(idx).unwrap_or("").trim();
            let kind = get(0);
            let id_str = get(1);
            let id: i64 = match id_str.parse() {
                Ok(n) => n,
                Err(_) => {
                    warnings.push(format!(
                        "row {}: skipped (bad id {:?})",
                        i + 2,
                        id_str
                    ));
                    continue;
                }
            };
            let name = get(2).to_string();
            if name.is_empty() {
                warnings.push(format!("row {}: skipped (empty name)", i + 2));
                continue;
            }
            let category = opt_str(get(3));
            // For rows missing timestamps, stamp both with the same `now` so a
            // freshly-imported row is internally consistent.
            let now = now_rfc3339();
            let created_at = opt_str(get(7)).unwrap_or_else(|| now.clone());
            let updated_at = opt_str(get(8)).unwrap_or(now);
            match kind {
                "item" => {
                    let quantity = get(4).parse::<i64>().unwrap_or(1).max(0);
                    let notes = opt_str(get(6));
                    out.push(CsvRow::Item {
                        id,
                        name,
                        category,
                        quantity,
                        notes,
                        created_at,
                        updated_at,
                    });
                }
                "wishlist" => {
                    let priority = opt_str(get(5));
                    let notes = opt_str(get(6));
                    out.push(CsvRow::Wishlist {
                        id,
                        name,
                        category,
                        priority,
                        notes,
                        created_at,
                        updated_at,
                    });
                }
                other => {
                    warnings.push(format!(
                        "row {}: skipped (unknown type {:?}, want 'item' or 'wishlist')",
                        i + 2,
                        other
                    ));
                }
            }
        }
        Ok((out, warnings))
    })
    .await
    .map_err(|e| format!("Import parse task failed: {}", e))??;

    // Upsert on a blocking thread.
    let db_path = state.state_dir.join("inventory.db");
    let (rows, warnings) = rows;
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<InventoryCsvImportResult, String> {
        let conn = open_db(&db_path)?;
        let mut res = InventoryCsvImportResult::default();
        for row in rows {
            match row {
                CsvRow::Item {
                    id,
                    name,
                    category,
                    quantity,
                    notes,
                    created_at,
                    updated_at,
                } => {
                    // EXISTS first so we can report insert vs. update (an
                    // UPSERT always reports 1 row affected either way).
                    let existed: bool = conn
                        .query_row("SELECT 1 FROM items WHERE id=?1", params![id], |_| Ok(()))
                        .is_ok();
                    conn.execute(
                        "INSERT INTO items (id, name, category, quantity, notes, created_at, updated_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
                         ON CONFLICT(id) DO UPDATE SET \
                         name=excluded.name, category=excluded.category, \
                         quantity=excluded.quantity, notes=excluded.notes, \
                         updated_at=excluded.updated_at",
                        params![id, name, category, quantity, notes, created_at, updated_at],
                    )
                    .map_err(|e| e.to_string())?;
                    if existed {
                        res.items_updated += 1;
                    } else {
                        res.items_added += 1;
                    }
                }
                CsvRow::Wishlist {
                    id,
                    name,
                    category,
                    priority,
                    notes,
                    created_at,
                    updated_at,
                } => {
                    let existed: bool = conn
                        .query_row("SELECT 1 FROM wishlist WHERE id=?1", params![id], |_| Ok(()))
                        .is_ok();
                    conn.execute(
                        "INSERT INTO wishlist (id, name, category, priority, notes, created_at, updated_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
                         ON CONFLICT(id) DO UPDATE SET \
                         name=excluded.name, category=excluded.category, \
                         priority=excluded.priority, notes=excluded.notes, \
                         updated_at=excluded.updated_at",
                        params![id, name, category, priority, notes, created_at, updated_at],
                    )
                    .map_err(|e| e.to_string())?;
                    if existed {
                        res.wishlist_updated += 1;
                    } else {
                        res.wishlist_added += 1;
                    }
                }
            }
        }
        Ok(res)
    })
    .await
    .map_err(|e| format!("Import task failed: {}", e))??;

    let mut result = result;
    if !warnings.is_empty() {
        result.note = Some(warnings.join("\n"));
    }
    Ok(result)
}

/// Read a CSV file's bytes, transparently handling an Android `content://`
/// URI (read fully into memory via `tauri-plugin-android-fs`) or a plain
/// filesystem path (`std::fs::read`). Mirrors `package_import::open_zip`.
async fn read_csv_bytes(app: &tauri::AppHandle, path: &str) -> Result<Vec<u8>, String> {
    if path.starts_with("content://") {
        #[cfg(target_os = "android")]
        {
            use tauri_plugin_android_fs::{AndroidFsExt, FileUri};
            let uri = FileUri::from_uri(path);
            let api = app.android_fs_async();
            let file = api
                .open_file_readable(&uri)
                .await
                .map_err(|e| format!("Failed to open Android content URI '{}': {}", path, e))?;
            tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, std::io::Error> {
                let mut buf = Vec::new();
                std::io::Read::read_to_end(&mut std::io::BufReader::new(file), &mut buf)?;
                Ok(buf)
            })
            .await
            .map_err(|e| format!("Read task panicked: {}", e))?
            .map_err(|e| format!("Failed to read content URI '{}': {}", path, e))
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = app;
            Err(format!(
                "content:// URI not supported on this platform: {}",
                path
            ))
        }
    } else {
        let p = PathBuf::from(path);
        if !p.exists() {
            return Err(format!("CSV file not found: {}", path));
        }
        std::fs::read(&p).map_err(|e| format!("Failed to read '{}': {}", path, e))
    }
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
