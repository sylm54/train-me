//! Bash sandbox integration backed by bashkit.
//!
//! bashkit's `Bash` struct is `!Send` (it owns raw pointers internally), so
//! it cannot be shared across threads or awaited across thread boundaries.
//! We work around this by dedicating a single OS thread to the sandbox and
//! sending it commands through an MPSC channel. Each `exec_bash` Tauri
//! command sends a request, awaits a oneshot response, and returns.

use std::path::{Path, PathBuf};

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

/// Spawn a dedicated worker thread that owns the [`bashkit::Bash`] instance.
///
/// `agent_dir` is the directory the bash sandbox mounts as its root `/`.
/// This is `<app_data>/agent_data` — the agent's writable scratch space.
/// App-managed dirs (prompts/, model/, tracks/) live outside the sandbox.
pub fn create_bash_sandbox(agent_dir: &Path) -> anyhow::Result<BashSandbox> {
    let agent_dir_owned = agent_dir.to_path_buf();
    let (tx, mut rx) = mpsc::unbounded_channel::<ExecRequest>();

    let mount_path = agent_dir_owned.clone();
    std::thread::Builder::new()
        .name("bash-sandbox".into())
        .spawn(move || {
            // Inside this thread we own the runtime and the Bash instance.
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to build bash worker runtime");

            let builder = bashkit::Bash::builder()
                .mount_real_readwrite(&mount_path)
                .username("agent")
                .hostname("train-me")
                .cwd("/");
            let builder = crate::builtins::register_train_me_builtins(builder, &mount_path);
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
    let (reply_tx, reply_rx) = oneshot::channel();

    let tx = state.bash.tx.lock().clone();

    tx.send(ExecRequest {
        command,
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

/// Resolve a relative path inside `root`, rejecting traversal escapes.
///
/// `root` is the agent's writable area (`<app_data>/agent_data`), so this
/// is what backs `read_data_file` / `write_data_file` / `list_data_files`.
/// Re-used by other modules (e.g. `crate::write_script`) that need to write
/// under the agent's area with the same safety checks.
pub fn resolve_under(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
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
    std::fs::create_dir_all(data_dir.join("prompts").join("special"))?;
    Ok(())
}

/// Ensure the agent's writable data dir exists, with a few conventional
/// subdirectories pre-created so the agent has obvious places to write.
pub fn ensure_agent_dir(data_dir: &Path) -> std::io::Result<()> {
    let agent = data_dir.join("agent_data");
    std::fs::create_dir_all(&agent)?;
    // Conventional subdirs the agent is expected to populate. We pre-create
    // them so the layout is discoverable on first run; the agent is free to
    // create others.
    for sub in [
        "conditioning",
        "rule",
        "routines",
        "inventory",
        "journal",
        "voice",
    ] {
        std::fs::create_dir_all(agent.join(sub))?;
    }
    Ok(())
}

// Suppress unused-import warnings for symbols we once needed but no longer do.
#[allow(dead_code)]
fn _unused_imports() {}
