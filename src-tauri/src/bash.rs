//! Bash sandbox integration backed by bashkit.
//!
//! bashkit's `Bash` struct is `!Send` (it owns raw pointers internally), so
//! it cannot be shared across threads or awaited across thread boundaries.
//! We work around this by dedicating a single OS thread to the sandbox and
//! sending it commands through an MPSC channel. Each `exec_bash` Tauri
//! command sends a request, awaits a oneshot response, and returns.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::{mpsc, oneshot};

/// Request payload sent to the dedicated bash worker thread.
struct ExecRequest {
    command: String,
    reply: oneshot::Sender<Result<ExecReply, String>>,
}

struct ExecReply {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

/// Handle to the bash worker.
pub struct BashSandbox {
    tx: Mutex<mpsc::UnboundedSender<ExecRequest>>,
    /// Absolute host path of the data directory (the VFS root).
    pub data_dir: PathBuf,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BashResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Outcome of a successful `edit_data_file` search-and-replace.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct EditResult {
    pub path: String,
    /// Number of matches that were replaced.
    pub replacements: usize,
    /// Length of the file after the edit, in bytes.
    pub bytes: usize,
}

impl BashSandbox {
    /// Execute a bash script in the sandbox and await the result.
    ///
    /// This is the single entry point everything goes through — the
    /// `exec_bash` Tauri command, the activity-DB read/write helpers, and
    /// startup bootstrap (schema init) all funnel here. Commands are
    /// processed serially by the dedicated worker thread, so callers may
    /// queue behind a long-running agent command.
    ///
    /// Every invocation starts from the sandbox root `/` again. Bashkit's
    /// shell keeps its `cwd` across `exec()` calls (like a real shell), so
    /// a `cd /somewhere` inside one script would otherwise leak into the
    /// next one — and with several agents (spawned copies) sharing this
    /// sandbox, a subagent's `cd` would silently change where the main
    /// agent's relative paths resolve. The `cd /` line makes each
    /// command's working directory self-contained: a `cd` inside a single
    /// command still works exactly as written. (Prefixed on its own line,
    /// not `cd / && …`, so scripts starting with comments / heredocs /
    /// continuations parse the same as before.)
    pub async fn exec(&self, command: &str) -> Result<BashResult, String> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let tx = self.tx.lock().clone();
        tx.send(ExecRequest {
            command: format!("cd /\n{command}"),
            reply: reply_tx,
        })
        .map_err(|e| format!("bash worker disconnected: {}", e))?;
        let reply = reply_rx
            .await
            .map_err(|e| format!("bash worker dropped reply: {}", e))??;
        Ok(BashResult {
            stdout: reply.stdout,
            stderr: reply.stderr,
            exit_code: reply.exit_code,
        })
    }
}

/// Spawn a dedicated worker thread that owns the [`bashkit::Bash`] instance.
///
/// `agent_dir` is the directory the bash sandbox exposes as its root `/`,
/// mounted directly as a read-write [`bashkit::RealFs`] (not an overlay).
/// This is `<app_data>/agent_data` — the agent's writable scratch space, and
/// the *same* on-disk root the file tools (`read_data_file`, etc.) operate on,
/// so a file created/moved/edited in bash is immediately visible to them.
/// App-managed dirs (prompts/, model/, tracks/) live outside the sandbox.
///
// `state_dir` is the directory holding app-managed state that the agent
// must not access directly (`<app_data>/state`). Chastity and inventory
// live here; builtins reach them by absolute path. (Activity lives inside
// the sandbox root so the agent can query it via the embedded `sqlite`
// builtin. Inventory is accessed via the `inventory` builtin, also backed
// by rusqlite.)
pub fn create_bash_sandbox(agent_dir: &Path, state_dir: &Path) -> anyhow::Result<BashSandbox> {
    let agent_dir_owned = agent_dir.to_path_buf();
    let state_dir_owned = state_dir.to_path_buf();
    let (tx, mut rx) = mpsc::unbounded_channel::<ExecRequest>();

    let mount_path = agent_dir_owned.clone();
    std::thread::Builder::new()
        .name("bash-sandbox".into())
        .spawn(move || {
            // Inside this thread we own the runtime and the Bash instance.
            //
            // The `sqlite` feature requires a *multi-threaded* runtime:
            // the VFS-backed Turso IO bridges Turso's sync `IO` trait to
            // bashkit's async `FileSystem` via `tokio::task::block_in_place`,
            // which panics on a current-thread runtime. `block_on` still
            // drives our `!Send` Bash instance on this worker thread only
            // — the pool just has to exist so `block_in_place` can hand
            // off its blocked thread.
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("failed to build bash worker runtime");

            // Mount the agent's host directory directly as a read-write
            // RealFs, NOT via `mount_real_readwrite`. The latter wraps the
            // host dir in an `OverlayFs` whose upper layer is an
            // `InMemoryFs` — by design, all bash writes land in memory and
            // never reach the host dir that `read_data_file`/
            // `write_data_file`/etc. read via `std::fs`. That split caused
            // `bash mv a b` to succeed in bash while a subsequent
            // `read_file("b")` ENOENTed (and bash writes were lost on
            // restart). A direct `RealFs(ReadWrite)` makes bash and the
            // file tools share one on-disk root.
            //
            // `RealFs::new` canonicalizes the root and requires it to exist;
            // `agent_dir` is created (`ensure_agent_dir`) before this is
            // called. It still enforces per-path containment (no escapes via
            // `..` or symlinks), so the agent stays scoped to `agent_dir`.
            let realfs = bashkit::RealFs::new(&mount_path, bashkit::RealFsMode::ReadWrite)
                .expect("failed to mount agent dir as RealFs");
            let agent_fs: Arc<dyn bashkit::FileSystem> = Arc::new(bashkit::PosixFs::new(realfs));

            let builder = bashkit::Bash::builder()
                .fs(agent_fs)
                .username("agent")
                .hostname("train-me")
                .cwd("/")
                // Embedded SQLite (Turso). The runtime opt-in env var is
                // also required — without it the `sqlite` builtin refuses
                // to execute.
                //
                // Memory backend: loads the whole DB file at the start of
                // each `sqlite` invocation and writes it back after. This
                // guarantees that both the agent (via the builtin) and
                // external tools always see a consistent on-disk image.
                // The earlier Vfs backend kept pages in memory and flushed
                // via flush_dirty(), which proved unreliable — the UI could
                // read rows back through the cached engine, but the disk
                // file stayed empty and was invisible to DB browsers.
                .sqlite_with_limits(
                    bashkit::SqliteLimits::default().backend(bashkit::SqliteBackend::Memory),
                )
                .env("BASHKIT_ALLOW_INPROCESS_SQLITE", "1");
            let builder = crate::chastity::ChastityBuiltin::register(
                builder,
                state_dir_owned.join("chastity.json"),
            );
            let builder = crate::inventory::InventoryBuiltin::register(
                builder,
                state_dir_owned.join("inventory.db"),
            );
            let builder = crate::economy::PointsBuiltin::register(
                builder,
                state_dir_owned.join("economy.db"),
            );
            let mut bash = builder.build();

            rt.block_on(async move {
                while let Some(req) = rx.recv().await {
                    let result = bash.exec(&req.command).await;
                    let reply = match result {
                        Ok(r) => Ok(ExecReply {
                            stdout: r.stdout,
                            stderr: r.stderr,
                            exit_code: r.exit_code,
                        }),
                        Err(e) => Err(format!("bashkit error: {}", e)),
                    };
                    // Best-effort: ignore send errors (caller cancelled).
                    let _ = req.reply.send(reply);
                }
            });
        })
        .map_err(|e| anyhow::anyhow!("failed to spawn bash worker: {}", e))?;

    Ok(BashSandbox {
        tx: Mutex::new(tx),
        data_dir: agent_dir_owned,
    })
}

/// Tauri command: execute a bash script in the sandbox.
#[tauri::command]
pub async fn exec_bash(
    command: String,
    state: State<'_, crate::AppState>,
) -> Result<BashResult, String> {
    state.bash.exec(&command).await
}

/// Resolve a path inside `root`, rejecting traversal escapes.
///
/// `root` is the agent's writable area (`<app_data>/agent_data`), so this
/// is what backs `read_data_file` / `write_data_file` / `list_data_files`.
/// Re-used by other modules (e.g. `crate::write_script`) that need to write
/// under the agent's area with the same safety checks.
///
/// Accepts the path forms the agent encounters, all resolved under `root`:
/// - relative: `foo/bar`
/// - `.`-prefixed: `./foo/bar`
/// - sandbox-absolute: `/foo/bar` (the form bash emits, since `pwd` is `/`)
///
/// A single leading `/` (and any leading `./`) is stripped so the path is
/// treated as `root`-relative. This mirrors bashkit's own `RealFs::resolve`.
/// Host-absolute inputs that would escape `root` (e.g. `C:\foo` on Windows,
/// or a `/`-prefixed path whose remainder is itself absolute) are rejected.
/// The existing `..`-collapse + containment check still guards against
/// traversal escapes.
pub fn resolve_under(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // Normalize the leading form: strip a single leading '/' (sandbox-root
    // absolute) and any leading './'. Leave the rest intact so the path
    // stays a plain relative path for `root.join(...)`.
    let stripped = rel.trim_start_matches("./");
    let stripped = stripped.strip_prefix('/').unwrap_or(stripped);
    // Reject anything that's still absolute after stripping — that means it
    // carries a host prefix (e.g. `C:\...`) or an escaped root, which we never
    // want to resolve under the agent dir.
    let rel_path = Path::new(stripped);
    if rel_path.is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }
    let joined = root.join(rel_path);
    // Normalize without requiring the file to exist.
    let mut normalized = PathBuf::new();
    for c in joined.components() {
        match c {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    if !normalized.starts_with(root) {
        return Err("Path escapes the data directory".to_string());
    }
    Ok(normalized)
}

/// Tauri command: read a UTF-8 text file from the agent's writable data
/// directory (`<app_data>/agent_data`).
#[tauri::command]
pub fn read_data_file(path: String, state: State<'_, crate::AppState>) -> Result<String, String> {
    let p = resolve_under(&state.agent_dir, &path)?;
    std::fs::read_to_string(&p).map_err(|e| format!("read {}: {}", p.display(), e))
}

/// Tauri command: write a UTF-8 text file inside the agent's writable data
/// directory (`<app_data>/agent_data`).
#[tauri::command]
pub fn write_data_file(
    path: String,
    content: String,
    state: State<'_, crate::AppState>,
) -> Result<(), String> {
    let p = resolve_under(&state.agent_dir, &path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    std::fs::write(&p, content).map_err(|e| format!("write {}: {}", p.display(), e))
}

/// Tauri command: search-and-replace edit of a text file in the agent's
/// writable data directory (`<app_data>/agent_data`).
///
/// `old_string` must occur at least once. When `replace_all` is `false`
/// (the default) it must occur *exactly* once so the edit is unambiguous;
/// pass `replace_all: true` to substitute every occurrence. The file is
/// read, modified in memory, and written back in one operation.
#[tauri::command]
pub fn edit_data_file(
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
    state: State<'_, crate::AppState>,
) -> Result<EditResult, String> {
    let p = resolve_under(&state.agent_dir, &path)?;
    let content =
        std::fs::read_to_string(&p).map_err(|e| format!("read {}: {}", p.display(), e))?;

    let count = content.matches(&old_string).count();
    if count == 0 {
        return Err(format!(
            "edit {}: old_string not found in file",
            p.display()
        ));
    }
    let replace_all = replace_all.unwrap_or(false);
    if !replace_all && count > 1 {
        return Err(format!(
            "edit {}: old_string matches {} places; make it unique or set replace_all",
            p.display(),
            count
        ));
    }

    let new_content = if replace_all {
        content.replace(&old_string, &new_string)
    } else {
        content.replacen(&old_string, &new_string, 1)
    };

    std::fs::write(&p, &new_content).map_err(|e| format!("write {}: {}", p.display(), e))?;

    Ok(EditResult {
        path,
        replacements: if replace_all { count } else { 1 },
        bytes: new_content.len(),
    })
}

/// Tauri command: list entries in a directory under the agent's writable
/// data directory (`<app_data>/agent_data`).
#[tauri::command]
pub fn list_data_files(
    path: String,
    state: State<'_, crate::AppState>,
) -> Result<Vec<crate::FileEntry>, String> {
    let p = resolve_under(&state.agent_dir, &path)?;
    if !p.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&p).map_err(|e| format!("readdir {}: {}", p.display(), e))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_path = entry.path();
        // Relative-to-agent_dir path for the frontend.
        let rel = entry_path
            .strip_prefix(&state.agent_dir)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| entry_path.to_string_lossy().to_string());

        entries.push(crate::FileEntry {
            path: rel,
            name,
            is_dir: meta.is_dir(),
            size: meta.len(),
        });
    }

    // Sort: dirs first, then by name.
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });

    Ok(entries)
}

/// Tauri command: read a UTF-8 text file from `prompts/` (always scoped).
#[tauri::command]
pub fn read_prompt(path: String, state: State<'_, crate::AppState>) -> Result<String, String> {
    let prompts_root = state.data_dir.join("prompts");
    let p = resolve_under(&prompts_root, &path)?;
    std::fs::read_to_string(&p).map_err(|e| format!("read {}: {}", p.display(), e))
}

/// Tauri command: list files under `prompts/<path>`.
#[tauri::command]
pub fn list_prompt_files(
    path: String,
    state: State<'_, crate::AppState>,
) -> Result<Vec<crate::FileEntry>, String> {
    let prompts_root = state.data_dir.join("prompts");
    let p = resolve_under(&prompts_root, &path)?;
    if !p.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&p).map_err(|e| format!("readdir {}: {}", p.display(), e))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_path = entry.path();
        let rel = entry_path
            .strip_prefix(&prompts_root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| entry_path.to_string_lossy().to_string());

        entries.push(crate::FileEntry {
            path: rel,
            name,
            is_dir: meta.is_dir(),
            size: meta.len(),
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });

    Ok(entries)
}

/// Ensure the prompts dir exists (called during startup).
pub fn ensure_prompts_dir(data_dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir.join("prompts"))?;
    Ok(())
}

/// Ensure the agent's writable data dir exists, with a few conventional
/// subdirectories pre-created so the agent has obvious places to write.
///
/// Also seeds `agent_data/examples/` with bundled example files (rule,
/// routine, journal format, voice config) so the agent has canonical
/// formatting references without depending on a framework to ship them.
/// Existing files are never overwritten — only missing ones are written,
/// so user/agent edits to the examples survive.
///
/// Also seeds `agent_data/docs/internal/` with the app-owned reference docs
/// surfaced by the `{{docs}}` prompt directive. Unlike examples, these are
/// app-managed: they are overwritten whenever their bundled content changes,
/// so docs stay in sync with the running app.
///
/// Note: `inventory/` is intentionally NOT created here — inventory lives
/// in `<state_dir>/inventory.db`, accessed via the `inventory` builtin.
pub fn ensure_agent_dir(data_dir: &Path) -> std::io::Result<()> {
    let agent = data_dir.join("agent_data");
    std::fs::create_dir_all(&agent)?;
    // Conventional subdirs the agent is expected to populate. We pre-create
    // them so the layout is discoverable on first run; the agent is free to
    // create others. (`habits`, `tasks`, `store` are v2-format dirs —
    // see FORMAT.md.)
    for sub in ["docs", "routines", "habits", "tasks", "store", "hypnos"] {
        std::fs::create_dir_all(agent.join(sub))?;
    }
    seed_examples(&agent)?;
    seed_internal_docs(&agent)?;
    Ok(())
}

/// Bundled example files (compiled into the binary with `include_str!` so
/// the app ships them without relying on a framework). Written into
/// `agent_data/examples/` on startup, but only when absent — existing files
/// are left untouched so edits persist.
///
/// The system prompt's docs (`docs/internal/feature-files.md`) reference
/// these paths as the formatting standard for rules, routines, the journal
/// format, and voice config.
fn seed_examples(agent_dir: &Path) -> std::io::Result<()> {
    /// One bundled example: its relative path under `examples/` and its
    /// contents (embedded at compile time from the repo's `examples/` dir).
    struct BundledExample {
        rel: &'static str,
        contents: &'static str,
    }
    const EXAMPLES: &[BundledExample] = &[
        BundledExample {
            rel: "examples/routine-v2.md",
            contents: include_str!("../../examples/routine-v2.md"),
        },
        BundledExample {
            rel: "examples/habit.md",
            contents: include_str!("../../examples/habit.md"),
        },
        BundledExample {
            rel: "examples/task.md",
            contents: include_str!("../../examples/task.md"),
        },
        BundledExample {
            rel: "examples/store.json",
            contents: include_str!("../../examples/store.json"),
        },
    ];

    for ex in EXAMPLES {
        let path = agent_dir.join(ex.rel);
        if path.exists() {
            continue; // never overwrite an existing (possibly user-edited) file
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, ex.contents)?;
    }
    Ok(())
}

/// App-owned reference docs surfaced by the `{{docs}}` prompt directive
/// (compiled into the binary with `include_str!` from the repo's
/// `internal-docs/` dir). Written into `agent_data/docs/internal/` on
/// startup and OVERWRITTEN whenever their bundled content differs — these
/// are the app's documentation, not the user's, so app updates propagate.
/// Frameworks must not ship `docs/internal/**` (enforced by the framework
/// CLI linter).
fn seed_internal_docs(agent_dir: &Path) -> std::io::Result<()> {
    /// One bundled internal doc: its path under `docs/` and its contents.
    struct InternalDoc {
        rel: &'static str,
        contents: &'static str,
    }
    const DOCS: &[InternalDoc] = &[
        InternalDoc {
            rel: "docs/internal/overview.md",
            contents: include_str!("../internal-docs/overview.md"),
        },
        InternalDoc {
            rel: "docs/internal/feature-files.md",
            contents: include_str!("../internal-docs/feature-files.md"),
        },
        InternalDoc {
            rel: "docs/internal/voice-training.md",
            contents: include_str!("../internal-docs/voice-training.md"),
        },
        InternalDoc {
            rel: "docs/internal/chastity.md",
            contents: include_str!("../internal-docs/chastity.md"),
        },
        InternalDoc {
            rel: "docs/internal/feedback.md",
            contents: include_str!("../internal-docs/feedback.md"),
        },
        InternalDoc {
            rel: "docs/internal/data.md",
            contents: include_str!("../internal-docs/data.md"),
        },
        InternalDoc {
            rel: "docs/internal/tts-tags.md",
            contents: include_str!("../internal-docs/tts-tags.md"),
        },
    ];

    for doc in DOCS {
        let path = agent_dir.join(doc.rel);
        if std::fs::read(&path)
            .map(|existing| existing == doc.contents.as_bytes())
            .unwrap_or(false)
        {
            continue; // already up to date
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, doc.contents)?;
    }
    Ok(())
}

/// Ensure the app-managed state directory exists. Holds chastity state
/// and inventory (which the agent accesses via builtins, not directly).
/// Activity lives in the agent sandbox so the agent can query it via the
/// embedded `sqlite` builtin.
#[allow(dead_code)]
pub fn ensure_state_dir(data_dir: &Path) -> std::io::Result<PathBuf> {
    let state = data_dir.join("state");
    std::fs::create_dir_all(&state)?;
    Ok(state)
}

// Suppress unused-import warnings for symbols we once needed but no longer do.
#[allow(dead_code)]
fn _unused_imports() {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    // --- resolve_under: path-form acceptance ------------------------------

    #[test]
    fn resolve_under_accepts_relative() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let got = resolve_under(&root, "rules/daily.md").unwrap();
        assert_eq!(got, root.join("rules/daily.md"));
    }

    #[test]
    fn resolve_under_accepts_dot_slash() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let got = resolve_under(&root, "./rules/daily.md").unwrap();
        assert_eq!(got, root.join("rules/daily.md"));
    }

    #[test]
    fn resolve_under_accepts_sandbox_absolute() {
        // The form bash emits (pwd is "/"): leading "/" means sandbox root.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let got = resolve_under(&root, "/rules/daily.md").unwrap();
        assert_eq!(got, root.join("rules/daily.md"));
    }

    #[test]
    fn resolve_under_rejects_parent_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        assert!(resolve_under(&root, "../escape.md").is_err());
        assert!(resolve_under(&root, "/../escape.md").is_err());
        assert!(resolve_under(&root, "rules/../../escape.md").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn resolve_under_rejects_host_absolute_on_windows() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        // `C:\...` must not be resolved under the agent dir.
        assert!(resolve_under(&root, "C:\\Windows\\system32").is_err());
    }

    // --- the CWD leak fix: every exec starts from the sandbox root --------

    /// A `cd` inside one exec() must not leak into the next one. Subagents
    /// share this sandbox with the main agent, so without the per-exec
    /// `cd /` reset a spawned builder's `cd /hypnos/...` silently changed
    /// where the parent's later relative paths resolved.
    #[tokio::test]
    async fn bash_cwd_resets_between_execs() {
        let tmp = tempfile::tempdir().unwrap();
        let agent_dir = tmp.path().join("agent_data");
        let state_dir = tmp.path().join("state");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::create_dir_all(&state_dir).unwrap();
        let sandbox = create_bash_sandbox(&agent_dir, &state_dir).unwrap();

        let r = sandbox
            .exec("mkdir -p /sub && cd /sub && pwd")
            .await
            .unwrap();
        assert_eq!(r.exit_code, 0, "stderr: {}", r.stderr);
        assert_eq!(r.stdout.trim(), "/sub");

        // A `cd` inside a single command still works as written…
        let r2 = sandbox.exec("cd /sub && pwd").await.unwrap();
        assert_eq!(r2.exit_code, 0, "stderr: {}", r2.stderr);
        assert_eq!(r2.stdout.trim(), "/sub");

        // …but the NEXT invocation starts back at the sandbox root.
        let r3 = sandbox.exec("pwd").await.unwrap();
        assert_eq!(r3.exit_code, 0, "stderr: {}", r3.stderr);
        assert_eq!(r3.stdout.trim(), "/");
    }

    // --- the actual fix: bash writes are visible on the host --------------
    //
    // Reproduces the dump scenario at the filesystem layer: a write through
    // the same RealFs(ReadWrite) the sandbox now uses must be observable via
    // std::fs (which is what read_data_file uses), and vice-versa. Under the
    // old mount_real_readwrite (OverlayFs + InMemoryFs upper) this would fail
    // because the write never reached the host dir.
    #[tokio::test]
    async fn bash_fs_write_is_visible_to_std_fs() {
        use bashkit::{FileSystem, PosixFs, RealFs, RealFsMode};

        let tmp = tempfile::tempdir().unwrap();
        let backend = RealFs::new(tmp.path(), RealFsMode::ReadWrite).unwrap();
        let fs: Arc<dyn FileSystem> = Arc::new(PosixFs::new(backend));

        // Write via the sandbox's filesystem (as `echo > /rules/daily.md` would).
        fs.mkdir(std::path::Path::new("/rules"), true)
            .await
            .unwrap();
        fs.write_file(std::path::Path::new("/rules/daily.md"), b"hello")
            .await
            .unwrap();

        // Read via std::fs (as read_data_file does). This is the regression:
        // it must see the bash-side write.
        let on_host = std::fs::read(tmp.path().join("rules/daily.md")).unwrap();
        assert_eq!(on_host, b"hello");

        // And the reverse: a std::fs write is visible to the sandbox fs.
        std::fs::write(tmp.path().join("rules/other.md"), b"world").unwrap();
        let via_fs = fs
            .read_file(std::path::Path::new("/rules/other.md"))
            .await
            .unwrap();
        assert_eq!(via_fs, b"world");
    }
}
