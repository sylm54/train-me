//! Multi-chat persistence: Rust-owned chat transcripts under
//! `<data_dir>/chats/`.
//!
//! Layout:
//!
//!   - `chats/index.json` — chat metadata index:
//!
//!     ```json
//!     {
//!       "version": 1,
//!       "activeChatId": "V1StGXR8_Z5jdHi6B-myT",
//!       "chats": [
//!         {
//!           "id": "V1StGXR8_Z5jdHi6B-myT",
//!           "title": "New chat",
//!           "createdAt": 1758240000000,
//!           "updatedAt": 1758240000000,
//!           "archivedAt": null,
//!           "archivedReason": "idle",
//!           "origin": "user"
//!         }
//!       ]
//!     }
//!     ```
//!
//!     `archivedReason` is omitted when the chat is not archived (matching the
//!     frontend's `archivedReason?:` optionality). `origin` records where a
//!     chat came from: `"user"` (the default, created by the UI) today; a
//!     later stage adds `"agent-action"` / `"cron"` origins. Nothing in the
//!     UI branches on it yet.
//!
//!   - `chats/<id>.jsonl` — one JSON message per line for that chat.
//!
//! Messages are stored as opaque [`serde_json::Value`]s: the AI SDK's
//! `UIMessage` shape is large and version-dependent, so the Rust side only
//! persists what it is given and never models it.
//!
//! All access goes through a process-wide store (parking_lot mutex over the
//! parsed index, write-through to disk with atomic temp+rename writes — the
//! same pattern as `settings.rs`). The free functions in this module are the
//! real API (usable by a future headless agent runner with no webview
//! running); the `#[tauri::command]` wrappers registered in `lib.rs` are thin
//! pass-throughs for the frontend.
//!
//! The `activeChatId` pointer tracks the user's working chat so the runner
//! (and the next app start) can find it without asking the webview.
//!
//! Lifecycle: `reset_app_data` wipes this directory — chats are user data and
//! do not survive a reset — while `export_all_zip` includes `chats/` in the
//! backup archive. There is deliberately NO migration from the old webview
//! localStorage store; that data is abandoned.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

// ============================================================================
// On-disk shape (mirrors src/lib/chatStore.ts)
// ============================================================================

/// Origin of a chat. `"user"` is the default; later stages set
/// `"agent-action"` / `"cron"`. Kept a plain string (not an enum) so an
/// unknown future value round-trips instead of failing the whole index load.
pub const DEFAULT_ORIGIN: &str = "user";

fn default_origin() -> String {
    DEFAULT_ORIGIN.to_string()
}

/// Metadata for one chat (active or archived). Mirrors the frontend's
/// `ChatMeta`. Timestamps are ms-since-epoch, matching `Date.now()`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatMeta {
    /// Stable id; also the `<id>.jsonl` filename stem here and the
    /// `chats/<id>.xml` stem in the agent's sandbox.
    pub id: String,
    /// Human title. Defaults to "New chat", derived from the first user
    /// message by the frontend.
    pub title: String,
    /// Creation time (ms epoch).
    pub created_at: i64,
    /// Last activity time (ms epoch); bumped on every send. Drives the idle
    /// sweep.
    pub updated_at: i64,
    /// `None` while active; set when archived/cleared.
    pub archived_at: Option<i64>,
    /// Why it was archived, if it was (`"cleared" | "idle" | "compact-reset"`
    /// today — plain string for forward compatibility).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_reason: Option<String>,
    /// Where the chat came from. Defaults to `"user"`.
    #[serde(default = "default_origin")]
    pub origin: String,
}

impl Default for ChatMeta {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: "New chat".into(),
            created_at: 0,
            updated_at: 0,
            archived_at: None,
            archived_reason: None,
            origin: default_origin(),
        }
    }
}

/// On-disk shape of `index.json`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatIndex {
    /// Schema version, currently always 1.
    pub version: u32,
    /// The working-chat pointer: the id of the chat the user (or runner) is
    /// currently in. `None` until a chat exists / is picked.
    pub active_chat_id: Option<String>,
    /// All chat metadata, active and archived, in creation order.
    pub chats: Vec<ChatMeta>,
}

impl Default for ChatIndex {
    fn default() -> Self {
        Self {
            version: 1,
            active_chat_id: None,
            chats: Vec::new(),
        }
    }
}

/// Read the index from disk. A missing or unparsable file yields the defaults
/// (empty index), matching the tolerant loader in `settings.rs`; unknown
/// fields are ignored and missing fields fall back per-field.
fn load_index(dir: &Path) -> ChatIndex {
    match fs::read_to_string(dir.join("index.json")) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => ChatIndex::default(),
    }
}

/// Atomically replace `path` with `bytes`: write a temp file in the same
/// directory, then rename it over the target so a crash mid-write can never
/// leave a truncated file behind (same scheme as `settings.rs`).
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e.to_string())
        }
    }
}

/// Chat ids become filenames, so restrict them to nanoid's URL-safe alphabet.
fn validate_chat_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("chat id must not be empty".into());
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(format!("invalid chat id '{id}'"));
    }
    Ok(())
}

/// Current time as ms-since-epoch (the frontend's `Date.now()` shape).
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Generate a fresh chat id: 21 chars from a URL-safe 64-char alphabet (the
/// same shape as the frontend's `nanoid()` ids, so either side can mint ids).
fn new_chat_id() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut rng = rand::thread_rng();
    (0..21)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

// ============================================================================
// Store: in-memory index + write-through persistence
// ============================================================================

/// Process-wide chat store. Holds the parsed index under a mutex; every
/// mutation is persisted (atomically) BEFORE being committed to memory, so
/// the disk file is the source of truth and a failed write leaves both sides
/// consistent.
pub struct ChatsStore {
    dir: PathBuf,
    index: Mutex<ChatIndex>,
}

impl ChatsStore {
    /// Build a store rooted at `<data_dir>/chats/`. The directory is created
    /// lazily on the first write; a missing index loads as empty.
    pub fn new(data_dir: &std::path::Path) -> Self {
        let dir = data_dir.join("chats");
        let index = Mutex::new(load_index(&dir));
        Self { dir, index }
    }

    fn index_path(&self) -> PathBuf {
        self.dir.join("index.json")
    }

    fn chat_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.jsonl"))
    }

    /// Persist the index atomically.
    fn persist_index(&self, index: &ChatIndex) -> Result<(), String> {
        let json = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
        atomic_write(&self.index_path(), json.as_bytes())
    }

    /// All chat metadata (active + archived), in index (creation) order.
    /// The frontend sorts by `updatedAt` for display.
    pub fn list(&self) -> Vec<ChatMeta> {
        self.index.lock().chats.clone()
    }

    /// Create a chat with a caller-chosen id. The frontend passes its
    /// `nanoid()`; the runner can pass [`new_chat_id`] output (or call the
    /// free [`create`] helper, which mints one).
    pub fn create_with_id(
        &self,
        id: &str,
        title: &str,
        origin: Option<&str>,
    ) -> Result<ChatMeta, String> {
        validate_chat_id(id)?;
        let mut guard = self.index.lock();
        if guard.chats.iter().any(|c| c.id == id) {
            return Err(format!("chat '{id}' already exists"));
        }
        let now = now_ms();
        let meta = ChatMeta {
            id: id.to_string(),
            title: title.to_string(),
            created_at: now,
            updated_at: now,
            archived_at: None,
            archived_reason: None,
            origin: origin.unwrap_or(DEFAULT_ORIGIN).to_string(),
        };
        let mut next = guard.clone();
        next.chats.push(meta.clone());
        self.persist_index(&next)?;
        *guard = next;
        Ok(meta)
    }

    /// Archive a chat (messages are kept; only the metadata flags flip).
    /// Returns false if the chat doesn't exist.
    pub fn archive(&self, id: &str, reason: &str, now: i64) -> Result<bool, String> {
        let mut guard = self.index.lock();
        if !guard.chats.iter().any(|c| c.id == id) {
            return Ok(false);
        }
        let prev = guard
            .chats
            .iter()
            .find(|c| c.id == id)
            .map(|c| (c.archived_at, c.archived_reason.clone()));
        let mut next = guard.clone();
        if let Some(meta) = next.chats.iter_mut().find(|c| c.id == id) {
            meta.archived_at = Some(now);
            meta.archived_reason = Some(reason.to_string());
        }
        if let Err(e) = self.persist_index(&next) {
            // Roll the in-memory copy back so it stays consistent with disk.
            if let (Some(meta), Some((prev_at, prev_reason))) =
                (next.chats.iter_mut().find(|c| c.id == id), prev)
            {
                meta.archived_at = prev_at;
                meta.archived_reason = prev_reason;
            }
            return Err(e);
        }
        *guard = next;
        Ok(true)
    }

    /// Restore an archived chat back to active and bump its activity time.
    pub fn restore(&self, id: &str) -> Result<bool, String> {
        let mut guard = self.index.lock();
        if !guard.chats.iter().any(|c| c.id == id) {
            return Ok(false);
        }
        let now = now_ms();
        let mut next = guard.clone();
        if let Some(meta) = next.chats.iter_mut().find(|c| c.id == id) {
            meta.archived_at = None;
            meta.archived_reason = None;
            meta.updated_at = now;
        }
        self.persist_index(&next)?;
        *guard = next;
        Ok(true)
    }

    /// Set a chat's title (the frontend trims and applies the "Untitled"
    /// fallback before calling).
    pub fn rename(&self, id: &str, title: &str) -> Result<bool, String> {
        let mut guard = self.index.lock();
        if !guard.chats.iter().any(|c| c.id == id) {
            return Ok(false);
        }
        let mut next = guard.clone();
        if let Some(meta) = next.chats.iter_mut().find(|c| c.id == id) {
            meta.title = title.to_string();
        }
        self.persist_index(&next)?;
        *guard = next;
        Ok(true)
    }

    /// Bump a chat's `updatedAt` to now, optionally also setting its title
    /// (the frontend derives it from the first user message and only passes
    /// `Some` when the chat still has the default title).
    pub fn touch(&self, id: &str, title: Option<&str>) -> Result<bool, String> {
        let mut guard = self.index.lock();
        if !guard.chats.iter().any(|c| c.id == id) {
            return Ok(false);
        }
        let now = now_ms();
        let mut next = guard.clone();
        if let Some(meta) = next.chats.iter_mut().find(|c| c.id == id) {
            meta.updated_at = now;
            if let Some(t) = title {
                meta.title = t.to_string();
            }
        }
        self.persist_index(&next)?;
        *guard = next;
        Ok(true)
    }

    /// Permanently delete a chat: metadata, its transcript file, and the
    /// working-chat pointer if it pointed here. Returns false if absent.
    pub fn delete_permanently(&self, id: &str) -> Result<bool, String> {
        validate_chat_id(id)?;
        let mut guard = self.index.lock();
        if !guard.chats.iter().any(|c| c.id == id) {
            return Ok(false);
        }
        let mut next = guard.clone();
        next.chats.retain(|c| c.id != id);
        if next.active_chat_id.as_deref() == Some(id) {
            next.active_chat_id = None;
        }
        self.persist_index(&next)?;
        *guard = next;
        // Best-effort transcript removal; the index is already consistent.
        let _ = fs::remove_file(self.chat_path(id));
        Ok(true)
    }

    /// Delete one chat's transcript file (metadata is removed separately).
    /// A missing file is success (idempotent).
    pub fn delete_messages(&self, id: &str) -> Result<(), String> {
        validate_chat_id(id)?;
        match fs::remove_file(self.chat_path(id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Wipe every chat: reset the index to defaults and remove all transcript
    /// files (including orphans whose metadata is long gone).
    pub fn clear_all(&self) -> Result<(), String> {
        let mut guard = self.index.lock();
        let next = ChatIndex::default();
        self.persist_index(&next)?;
        *guard = next;
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    let _ = fs::remove_file(&path);
                }
            }
        }
        Ok(())
    }

    /// Return ids of active chats whose `updatedAt` is older than
    /// `now - idle_ms`. Computes candidates only — the caller archives them
    /// (via [`archive`]), mirroring the frontend sweeper's two-step flow.
    pub fn prune_idle(&self, idle_ms: i64, now: i64) -> Vec<String> {
        if idle_ms <= 0 {
            return Vec::new();
        }
        let cutoff = now - idle_ms;
        self.index
            .lock()
            .chats
            .iter()
            .filter(|c| c.archived_at.is_none() && c.updated_at < cutoff)
            .map(|c| c.id.clone())
            .collect()
    }

    /// Ensure a working chat exists and the pointer targets it:
    /// 1. the pointer, if it names an existing active chat;
    /// 2. otherwise the newest active chat (the pre-pointer heuristic);
    /// 3. otherwise a fresh `"user"` chat.
    pub fn ensure_active(&self) -> Result<ChatMeta, String> {
        let mut guard = self.index.lock();
        if let Some(id) = guard.active_chat_id.clone() {
            if let Some(meta) = guard
                .chats
                .iter()
                .find(|c| c.id == id && c.archived_at.is_none())
            {
                return Ok(meta.clone());
            }
        }
        let newest = guard
            .chats
            .iter()
            .filter(|c| c.archived_at.is_none())
            .max_by_key(|c| c.updated_at)
            .cloned();
        let now = now_ms();
        let mut next = guard.clone();
        let meta = match newest {
            Some(meta) => {
                next.active_chat_id = Some(meta.id.clone());
                meta
            }
            None => {
                let meta = ChatMeta {
                    id: new_chat_id(),
                    title: "New chat".into(),
                    created_at: now,
                    updated_at: now,
                    archived_at: None,
                    archived_reason: None,
                    origin: DEFAULT_ORIGIN.to_string(),
                };
                next.chats.push(meta.clone());
                next.active_chat_id = Some(meta.id.clone());
                meta
            }
        };
        self.persist_index(&next)?;
        *guard = next;
        Ok(meta)
    }

    /// Resolve the working-chat pointer to its metadata (None if unset or
    /// dangling — a pointer to an archived chat still resolves; callers that
    /// need an ACTIVE chat should use [`ensure_active`]).
    pub fn active_chat(&self) -> Option<ChatMeta> {
        let guard = self.index.lock();
        let id = guard.active_chat_id.as_deref()?;
        guard.chats.iter().find(|c| c.id == id).cloned()
    }

    /// Set the working-chat pointer. `Some(id)` must name an existing chat
    /// (archived is allowed — the pointer records intent, [`ensure_active`]
    /// falls through when it dangles or points at an archived chat).
    pub fn set_active_chat(&self, id: Option<&str>) -> Result<(), String> {
        if let Some(id) = id {
            validate_chat_id(id)?;
        }
        let mut guard = self.index.lock();
        if let Some(id) = id {
            if !guard.chats.iter().any(|c| c.id == id) {
                return Err(format!("cannot activate unknown chat '{id}'"));
            }
        }
        let mut next = guard.clone();
        next.active_chat_id = id.map(str::to_string);
        self.persist_index(&next)?;
        *guard = next;
        Ok(())
    }

    /// Replace the whole metadata array (the frontend's `saveMeta`). The
    /// working-chat pointer is preserved only if the new array still contains
    /// that chat.
    pub fn replace_meta(&self, chats: Vec<ChatMeta>) -> Result<(), String> {
        let mut guard = self.index.lock();
        let active = guard
            .active_chat_id
            .clone()
            .filter(|id| chats.iter().any(|c| &c.id == id));
        let mut next = guard.clone();
        next.version = 1;
        next.chats = chats;
        next.active_chat_id = active;
        self.persist_index(&next)?;
        *guard = next;
        Ok(())
    }

    // ── messages (opaque JSON values) ──────────────────────────────────────

    /// Persist one chat's full message array, rewriting `<id>.jsonl`
    /// (atomic temp+rename; a crash can't truncate the transcript).
    pub fn save_messages(&self, id: &str, messages: &[serde_json::Value]) -> Result<(), String> {
        validate_chat_id(id)?;
        let mut buf = String::new();
        for m in messages {
            buf.push_str(&serde_json::to_string(m).map_err(|e| e.to_string())?);
            buf.push('\n');
        }
        atomic_write(&self.chat_path(id), buf.as_bytes())
    }

    /// Load one chat's message array (empty if the file is absent). Tolerant
    /// parse: blank or corrupt lines are skipped rather than failing the load.
    pub fn load_messages(&self, id: &str) -> Result<Vec<serde_json::Value>, String> {
        validate_chat_id(id)?;
        let raw = match fs::read_to_string(self.chat_path(id)) {
            Ok(raw) => raw,
            Err(_) => return Ok(Vec::new()),
        };
        Ok(raw
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect())
    }

    /// Append one message to `<id>.jsonl`. Single-line append (no rewrite);
    /// meant for the future agent runner streaming a headless transcript.
    pub fn append_message(&self, id: &str, message: &serde_json::Value) -> Result<(), String> {
        validate_chat_id(id)?;
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let line = serde_json::to_string(message).map_err(|e| e.to_string())?;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.chat_path(id))
            .map_err(|e| e.to_string())?;
        writeln!(f, "{line}").map_err(|e| e.to_string())
    }
}

// ============================================================================
// Process-wide store
// ============================================================================

static STORE: OnceLock<Arc<ChatsStore>> = OnceLock::new();

/// Bind the process-wide chat store to the app data dir. Called once from
/// `run()` setup, before any command can fire.
pub fn init(data_dir: &std::path::Path) {
    let _ = STORE.set(Arc::new(ChatsStore::new(data_dir)));
}

/// The bound store, or an error for callers that raced ahead of `init`
/// (cannot happen in the app — setup runs first).
fn global() -> Result<&'static ChatsStore, String> {
    STORE
        .get()
        .map(Arc::as_ref)
        .ok_or_else(|| "chat store not initialised".to_string())
}

// ============================================================================
// Free functions (the agent runner's API) + thin Tauri command wrappers
// ============================================================================

/// All chat metadata (active + archived), in index (creation) order.
pub fn list() -> Result<Vec<ChatMeta>, String> {
    Ok(global()?.list())
}

#[tauri::command]
pub fn chats_list() -> Result<Vec<ChatMeta>, String> {
    list()
}

/// Create a chat with a caller-chosen id (the frontend passes its nanoid).
pub fn create_with_id(id: &str, title: &str, origin: Option<&str>) -> Result<ChatMeta, String> {
    global()?.create_with_id(id, title, origin)
}

#[tauri::command]
pub fn chats_create(id: String, title: String, origin: Option<String>) -> Result<ChatMeta, String> {
    create_with_id(&id, &title, origin.as_deref())
}

/// Save a chat's full message array (rewrites the transcript file).
pub fn save_messages(id: &str, messages: &[serde_json::Value]) -> Result<(), String> {
    global()?.save_messages(id, messages)
}

#[tauri::command]
pub fn chats_save_messages(id: String, messages: Vec<serde_json::Value>) -> Result<(), String> {
    save_messages(&id, &messages)
}

/// Load a chat's message array (empty if absent).
pub fn load_messages(id: &str) -> Result<Vec<serde_json::Value>, String> {
    global()?.load_messages(id)
}

#[tauri::command]
pub fn chats_get_messages(id: String) -> Result<Vec<serde_json::Value>, String> {
    load_messages(&id)
}

/// Append a single message to a chat's transcript (runner streaming path).
pub fn append_message(id: &str, message: &serde_json::Value) -> Result<(), String> {
    global()?.append_message(id, message)
}

#[tauri::command]
pub fn chats_append_message(id: String, message: serde_json::Value) -> Result<(), String> {
    append_message(&id, &message)
}

/// Archive a chat with a reason (messages are kept). False if absent.
pub fn archive(id: &str, reason: &str) -> Result<bool, String> {
    global()?.archive(id, reason, now_ms())
}

#[tauri::command]
pub fn chats_archive(id: String, reason: String) -> Result<bool, String> {
    archive(&id, &reason)
}

/// Restore an archived chat back to active. False if absent.
pub fn restore(id: &str) -> Result<bool, String> {
    global()?.restore(id)
}

#[tauri::command]
pub fn chats_restore(id: String) -> Result<bool, String> {
    restore(&id)
}

/// Rename a chat. False if absent.
pub fn rename(id: &str, title: &str) -> Result<bool, String> {
    global()?.rename(id, title)
}

#[tauri::command]
pub fn chats_rename(id: String, title: String) -> Result<bool, String> {
    rename(&id, &title)
}

/// Bump a chat's activity time, optionally re-titling it. False if absent.
pub fn touch(id: &str, title: Option<&str>) -> Result<bool, String> {
    global()?.touch(id, title)
}

#[tauri::command]
pub fn chats_touch(id: String, title: Option<String>) -> Result<bool, String> {
    touch(&id, title.as_deref())
}

/// Permanently delete a chat (metadata + transcript + pointer). False if
/// absent.
pub fn delete_permanently(id: &str) -> Result<bool, String> {
    global()?.delete_permanently(id)
}

#[tauri::command]
pub fn chats_delete_permanently(id: String) -> Result<bool, String> {
    delete_permanently(&id)
}

/// Delete one chat's transcript file (idempotent).
pub fn delete_messages(id: &str) -> Result<(), String> {
    global()?.delete_messages(id)
}

#[tauri::command]
pub fn chats_delete_messages(id: String) -> Result<(), String> {
    delete_messages(&id)
}

/// Wipe every chat (index + all transcript files).
pub fn clear_all() -> Result<(), String> {
    global()?.clear_all()
}

#[tauri::command]
pub fn chats_clear_all() -> Result<(), String> {
    clear_all()
}

/// Ids of active chats idle past `idle_ms` (candidates — the caller archives
/// them, mirroring the frontend sweeper's flow).
pub fn prune_idle(idle_ms: i64, now: Option<i64>) -> Result<Vec<String>, String> {
    Ok(global()?.prune_idle(idle_ms, now.unwrap_or_else(now_ms)))
}

#[tauri::command]
pub fn chats_prune_idle(idle_ms: i64, now: Option<i64>) -> Result<Vec<String>, String> {
    prune_idle(idle_ms, now)
}

/// Ensure a working chat exists and the pointer targets it; returns it.
pub fn ensure_active() -> Result<ChatMeta, String> {
    global()?.ensure_active()
}

#[tauri::command]
pub fn chats_ensure_active() -> Result<ChatMeta, String> {
    ensure_active()
}

/// The working-chat pointer, resolved to metadata (None if unset/dangling).
pub fn active_chat() -> Result<Option<ChatMeta>, String> {
    Ok(global()?.active_chat())
}

#[tauri::command]
pub fn chats_get_active_chat() -> Result<Option<ChatMeta>, String> {
    active_chat()
}

/// Set the working-chat pointer (`None` clears it).
pub fn set_active_chat(id: Option<&str>) -> Result<(), String> {
    global()?.set_active_chat(id)
}

#[tauri::command]
pub fn chats_set_active_chat(id: Option<String>) -> Result<(), String> {
    set_active_chat(id.as_deref())
}

/// Replace the whole metadata array (pointer preserved when still valid).
pub fn replace_meta(chats: Vec<ChatMeta>) -> Result<(), String> {
    global()?.replace_meta(chats)
}

#[tauri::command]
pub fn chats_replace_meta(chats: Vec<ChatMeta>) -> Result<(), String> {
    replace_meta(chats)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Unique temp root per test (nanos + tag) so parallel tests don't clash.
    fn temp_store(tag: &str) -> (PathBuf, ChatsStore) {
        let dir = std::env::temp_dir().join(format!(
            "tm-chats-test-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = ChatsStore::new(&dir);
        (dir, store)
    }

    #[test]
    fn create_roundtrips_persisted_camel_case_index() {
        let (dir, store) = temp_store("roundtrip");
        let a = store.create_with_id("chatA", "First", None).unwrap();
        assert_eq!(a.origin, "user"); // origin defaults to "user"
        let b = store
            .create_with_id("chatB", "Second", Some("cron"))
            .unwrap();
        assert_eq!(b.origin, "cron");

        // On-disk keys are camelCase to mirror the TS shape exactly.
        let raw = fs::read_to_string(dir.join("chats").join("index.json")).unwrap();
        assert!(raw.contains("\"createdAt\""));
        assert!(raw.contains("\"updatedAt\""));
        assert!(raw.contains("\"origin\""));
        // No tmp file left behind by the atomic write.
        assert!(!dir.join("chats").join("index.json.tmp").exists());

        // A fresh store over the same dir sees both chats (persistence).
        let reloaded = ChatsStore::new(&dir);
        let metas = reloaded.list();
        assert_eq!(metas.len(), 2);
        assert_eq!(metas[0].id, "chatA");
        assert_eq!(metas[0].origin, "user");
        assert_eq!(metas[1].origin, "cron");
        assert!(metas.iter().all(|m| m.archived_at.is_none()));
    }

    #[test]
    fn messages_roundtrip_as_opaque_jsonl() {
        let (dir, store) = temp_store("messages");
        store.create_with_id("chatA", "T", None).unwrap();
        let msgs = vec![
            json!({"id":"m1","role":"user","parts":[{"type":"text","text":"hi"}],"weird":{"nested":[1,2,3]}}),
            json!({"id":"m2","role":"assistant","parts":[]}),
            json!({"id":"m3","role":"user","parts":[{"type":"tool-x","input":null}]}),
        ];
        store.save_messages("chatA", &msgs).unwrap();

        // One JSON message per line.
        let raw = fs::read_to_string(dir.join("chats").join("chatA.jsonl")).unwrap();
        assert_eq!(raw.lines().count(), 3);
        assert!(!dir.join("chats").join("chatA.jsonl.tmp").exists());

        // Same store and a reloaded store both read back exactly what was saved.
        assert_eq!(store.load_messages("chatA").unwrap(), msgs);
        let reloaded = ChatsStore::new(&dir);
        assert_eq!(reloaded.load_messages("chatA").unwrap(), msgs);

        // Missing chat → empty, and corrupt lines are skipped, not fatal.
        assert!(reloaded.load_messages("nope").unwrap().is_empty());
        std::fs::write(
            dir.join("chats").join("chatA.jsonl"),
            "{\"id\":\"ok\"}\nnot-json\n\n{\"id\":\"ok2\"}\n",
        )
        .unwrap();
        let salvaged = reloaded.load_messages("chatA").unwrap();
        assert_eq!(salvaged.len(), 2);
        assert_eq!(salvaged[0]["id"], "ok");
        assert_eq!(salvaged[1]["id"], "ok2");
    }

    #[test]
    fn append_message_streams_without_rewriting() {
        let (_dir, store) = temp_store("append");
        store.create_with_id("chatA", "T", None).unwrap();
        store
            .append_message("chatA", &json!({"id":"m1","role":"user"}))
            .unwrap();
        store
            .append_message("chatA", &json!({"id":"m2","role":"assistant"}))
            .unwrap();
        let msgs = store.load_messages("chatA").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1]["role"], "assistant");
    }

    #[test]
    fn prune_idle_returns_only_stale_active_ids() {
        let (dir, _unused) = temp_store("prune");
        let now = chrono::Utc::now().timestamp_millis();
        // Write an index directly so activity times are precisely controlled:
        // "stale" (active, old), "fresh" (active, recent), "gone" (archived).
        let meta = |id: &str, updated_at: i64, archived_at: Option<i64>| ChatMeta {
            id: id.to_string(),
            title: "t".into(),
            created_at: now - 60_000,
            updated_at,
            archived_at,
            archived_reason: archived_at.map(|_| "idle".to_string()),
            origin: "user".into(),
        };
        let index = ChatIndex {
            version: 1,
            active_chat_id: None,
            chats: vec![
                meta("stale", now - 9_000, None),
                meta("fresh", now - 100, None),
                meta("gone", now - 9_000, Some(now - 8_000)),
            ],
        };
        std::fs::create_dir_all(dir.join("chats")).unwrap();
        std::fs::write(
            dir.join("chats").join("index.json"),
            serde_json::to_string_pretty(&index).unwrap(),
        )
        .unwrap();
        let store = ChatsStore::new(&dir);

        // idle_ms = 0 disables the sweep entirely.
        assert!(store.prune_idle(0, now).is_empty());
        // Only the stale ACTIVE chat is a candidate; archived and fresh are not.
        assert_eq!(store.prune_idle(5_000, now), vec!["stale".to_string()]);
        // Prune computes candidates only — nothing was archived as a side effect.
        let stale = store.list().into_iter().find(|c| c.id == "stale").unwrap();
        assert!(stale.archived_at.is_none());
    }

    #[test]
    fn archive_restore_rename_touch_semantics() {
        let (_dir, store) = temp_store("lifecycle");
        store.create_with_id("chatA", "New chat", None).unwrap();

        // Archive with a reason.
        assert!(store.archive("chatA", "idle", 1_000).unwrap());
        let meta = store.list().remove(0);
        assert_eq!(meta.archived_at, Some(1_000));
        assert_eq!(meta.archived_reason.as_deref(), Some("idle"));

        // Restore clears both and bumps activity.
        assert!(store.restore("chatA").unwrap());
        let meta = store.list().remove(0);
        assert_eq!(meta.archived_at, None);
        assert_eq!(meta.archived_reason, None);
        assert!(meta.updated_at >= 1_000);

        // Rename.
        assert!(store.rename("chatA", "Renamed").unwrap());
        assert_eq!(store.list().remove(0).title, "Renamed");

        // Touch bumps activity; optional title sticks.
        assert!(store.touch("chatA", Some("Titled")).unwrap());
        let meta = store.list().remove(0);
        assert_eq!(meta.title, "Titled");

        // Operations on unknown ids report false, not errors.
        assert!(!store.archive("ghost", "idle", 0).unwrap());
        assert!(!store.restore("ghost").unwrap());
        assert!(!store.rename("ghost", "x").unwrap());
        assert!(!store.touch("ghost", None).unwrap());
        assert!(!store.delete_permanently("ghost").unwrap());
    }

    #[test]
    fn delete_permanently_removes_meta_transcript_and_pointer() {
        let (dir, store) = temp_store("delete");
        store.create_with_id("chatA", "A", None).unwrap();
        store.create_with_id("chatB", "B", None).unwrap();
        store.save_messages("chatA", &[json!({"id":"m1"})]).unwrap();
        store.set_active_chat(Some("chatA")).unwrap();

        assert!(store.delete_permanently("chatA").unwrap());
        assert!(!dir.join("chats").join("chatA.jsonl").exists());
        let metas = store.list();
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].id, "chatB");
        // The pointer was cleared with its chat.
        assert_eq!(store.active_chat().map(|m| m.id), None);

        // delete_messages is idempotent on a missing file.
        store.delete_messages("chatA").unwrap();
    }

    #[test]
    fn ensure_active_pointer_fallback_chain() {
        let (_dir, store) = temp_store("ensure");

        // 1. Empty index → creates a user chat and points at it.
        let first = store.ensure_active().unwrap();
        assert_eq!(first.origin, "user");
        assert_eq!(store.active_chat().map(|m| m.id), Some(first.id.clone()));

        // 2. Pointer to an archived chat falls through to the newest active.
        store.create_with_id("older", "old", None).unwrap();
        {
            let mut guard = store.index.lock();
            guard
                .chats
                .iter_mut()
                .find(|c| c.id == "older")
                .unwrap()
                .updated_at = first.created_at - 10_000;
        }
        store.archive(&first.id, "cleared", now_ms()).unwrap();
        let second = store.ensure_active().unwrap();
        assert_ne!(second.id, first.id);

        // 3. A live pointer wins.
        store.set_active_chat(Some("older")).unwrap();
        assert_eq!(store.ensure_active().unwrap().id, "older");
    }

    #[test]
    fn set_active_validates_and_replace_meta_keeps_valid_pointer() {
        let (_dir, store) = temp_store("pointer");
        store.create_with_id("chatA", "A", None).unwrap();
        store.create_with_id("chatB", "B", None).unwrap();

        assert!(store.set_active_chat(Some("chatB")).is_ok());
        assert_eq!(store.active_chat().map(|m| m.id), Some("chatB".into()));
        // Unknown chat rejected; clearing (None) always allowed.
        assert!(store.set_active_chat(Some("ghost")).is_err());
        assert!(store.set_active_chat(None).is_ok());
        assert!(store.active_chat().is_none());

        // replace_meta preserves a still-valid pointer, drops a stale one.
        store.set_active_chat(Some("chatA")).unwrap();
        store.replace_meta(vec![ChatMeta {
            id: "chatB".into(),
            ..ChatMeta::default()
        }])
        .unwrap();
        assert!(store.active_chat().is_none()); // chatA no longer exists
        store.replace_meta(vec![ChatMeta {
            id: "chatC".into(),
            ..ChatMeta::default()
        }])
        .unwrap();
        store.set_active_chat(Some("chatC")).unwrap();
        store.replace_meta(vec![ChatMeta {
            id: "chatC".into(),
            ..ChatMeta::default()
        }])
        .unwrap();
        assert_eq!(store.active_chat().map(|m| m.id), Some("chatC".into()));
    }

    #[test]
    fn clear_all_resets_index_and_removes_transcripts() {
        let (dir, store) = temp_store("clear");
        store.create_with_id("chatA", "A", None).unwrap();
        store.create_with_id("orphan", "O", None).unwrap();
        store.save_messages("chatA", &[json!({"id":"m1"})]).unwrap();
        store.save_messages("orphan", &[json!({"id":"m2"})]).unwrap();
        store.set_active_chat(Some("chatA")).unwrap();

        // Orphan: remove its metadata but keep the file, like an interrupted
        // delete would leave behind.
        store.delete_permanently("orphan").unwrap();
        std::fs::write(dir.join("chats").join("orphan.jsonl"), "{}\n").unwrap();

        store.clear_all().unwrap();
        assert!(store.list().is_empty());
        assert!(store.active_chat().is_none());
        assert!(!dir.join("chats").join("chatA.jsonl").exists());
        assert!(!dir.join("chats").join("orphan.jsonl").exists());
        let raw = fs::read_to_string(dir.join("chats").join("index.json")).unwrap();
        assert!(raw.contains("\"activeChatId\": null"));
    }

    #[test]
    fn invalid_ids_and_atomic_write_contract() {
        let (_dir, store) = temp_store("validate");
        assert!(store.create_with_id("../evil", "x", None).is_err());
        assert!(store.create_with_id("a/b", "x", None).is_err());
        assert!(store.create_with_id("", "x", None).is_err());
        assert!(store.save_messages("../evil", &[]).is_err());
        // Duplicate create is rejected.
        store.create_with_id("chatA", "A", None).unwrap();
        assert!(store.create_with_id("chatA", "dup", None).is_err());

        // atomic_write replaces content and never leaves a .tmp sibling.
        let target = _dir.join("probe.bin");
        let tmp_sibling = PathBuf::from(format!("{}.tmp", target.display()));
        atomic_write(&target, b"one").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"one");
        assert!(!tmp_sibling.exists());
        atomic_write(&target, b"two").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"two");
        assert!(!tmp_sibling.exists());
    }
}
