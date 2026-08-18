//! v2 audio pre-render pipeline (FORMAT.md §6 "Audio Rendering").
//!
//! Every `.xml` script referenced by a v2 container (`audio` features,
//! markdown audio links, `script` actions, queued pending scripts) is
//! rendered in the background, keyed by the manifest's content hash —
//! edited scripts re-render automatically, and rendered tracks that are
//! no longer referenced are garbage-collected.
//!
//! Scheduling is prioritized: scripts queued in the economy's pending
//! list render first (the user is waiting on them), then scripts used by
//! scheduled routines ordered by their next fire time, then everything
//! else. Rendering shares the single engine lock with the UI
//! `render_manifest` command, so a background render simply queues behind
//! (or ahead of) a user-initiated one.
//!
//! The model gate mirrors `get_model_status`: if the ONNX model isn't
//! downloaded yet, prerender reports and skips — the frontend re-invokes
//! it periodically, so renders begin once the model exists. The renderer
//! is constructed lazily here (same as `load_model`), which means the
//! first prerender also warms the engine for the whole app.

use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::economy;
use crate::format;
use crate::AppState;

#[derive(Serialize, Clone, Debug, Default)]
pub struct PrerenderReport {
    /// Distinct referenced scripts found.
    pub referenced: usize,
    /// Scripts (re)rendered this pass.
    pub rendered: Vec<String>,
    /// Referenced scripts already current (hash match) — nothing done.
    pub fresh: usize,
    /// Track directories removed (unreferenced).
    pub gc_removed: Vec<String>,
    /// True when the pass was skipped because the TTS model isn't
    /// downloaded yet.
    pub model_missing: bool,
    /// Per-script render errors (rendering continues past them).
    pub errors: Vec<String>,
}

// ============================================================================
// Reference collection (pure-ish; filesystem only)
// ============================================================================

/// One referenced script with its render priority — smaller renders first.
#[derive(Clone, Debug)]
pub struct ScriptRef {
    pub src: String,
    /// Unix-seconds priority key: 0 = queued for the user now, else the
    /// referencing routine's next cron fire; unscheduled refs sort last.
    pub priority: i64,
}

fn next_fire_secs(expr: &str, now: chrono::DateTime<chrono::Utc>) -> i64 {
    use std::str::FromStr;
    let normalized = crate::validators::normalize_cron(expr);
    cron::Schedule::from_str(&normalized)
        .ok()
        .and_then(|s| s.after(&now).next())
        .map(|t| t.timestamp())
        .unwrap_or(i64::MAX / 2)
}

/// Scan every v2 container for referenced scripts. Reads files under
/// `agent_dir`; `econ` (open economy DB) contributes the pending-script
/// queue at top priority.
pub fn collect_script_refs(
    agent_dir: &Path,
    econ: Option<&Connection>,
    now: chrono::DateTime<chrono::Utc>,
) -> Vec<ScriptRef> {
    let mut refs: Vec<ScriptRef> = Vec::new();
    let mut push = |src: String, priority: i64| {
        refs.push(ScriptRef { src, priority })
    };

    // Queued scripts the user is waiting for — top priority.
    if let Some(conn) = econ {
        if let Ok(pending) = economy::list_pending(conn) {
            for p in pending {
                if p.kind == "script" {
                    push(p.payload, 0);
                }
            }
        }
    }

    let list = |dir: &str, ext: &str| crate::schedule::list_v2_files(agent_dir, dir, ext);

    // Routines: audio features/links + script actions, prioritized by the
    // routine's next fire (on-demand routines sort mid-pack).
    for (_, content) in list("routines", ".md") {
        if let Some(r) = format::parse_routine(&content).0 {
            let priority = match &r.schedule {
                Some(expr) => next_fire_secs(expr, now),
                None => now.timestamp() + 3600,
            };
            for src in format::audio_feature_srcs(&r.pages) {
                push(src, priority);
            }
            let mut arefs = format::ActionRefs::default();
            format::collect_action_refs(&r.success, &mut arefs);
            format::collect_action_refs(&r.failure, &mut arefs);
            for src in arefs.scripts {
                push(src, priority);
            }
        }
    }

    // Task templates: same model, no cron — mid-pack.
    for (_, content) in list("tasks", ".md") {
        if let Some(t) = format::parse_task(&content).0 {
            let priority = now.timestamp() + 3600;
            for src in format::audio_feature_srcs(&t.pages) {
                push(src, priority);
            }
            let mut arefs = format::ActionRefs::default();
            format::collect_action_refs(&t.success, &mut arefs);
            format::collect_action_refs(&t.failure, &mut arefs);
            for src in arefs.scripts {
                push(src, priority);
            }
        }
    }

    // Habits + store: script actions only, lowest priority.
    let low = now.timestamp() + 86_400;
    for (dir, ext) in [("habits", ".md"), ("store", ".json")] {
        for (_, content) in list(dir, ext) {
            let actions = if dir == "habits" {
                format::parse_habit(&content).0.map(|h| (h.success, h.failure))
            } else {
                format::parse_store_entry(&content).0.map(|s| (s.actions, Vec::new()))
            };
            if let Some((a, b)) = actions {
                let mut arefs = format::ActionRefs::default();
                format::collect_action_refs(&a, &mut arefs);
                format::collect_action_refs(&b, &mut arefs);
                for src in arefs.scripts {
                    push(src, low);
                }
            }
        }
    }

    // Dedupe (keep the smallest priority) and drop scripts that don't
    // exist on disk (the validator reports those; nothing to render).
    refs.sort_by(|a, b| a.src.cmp(&b.src).then(a.priority.cmp(&b.priority)));
    refs.dedup_by(|a, b| a.src == b.src);
    refs.retain(|r| crate::bash::resolve_under(agent_dir, &r.src).map(|p| p.exists()).unwrap_or(false));
    refs.sort_by_key(|r| r.priority);
    refs
}

/// Track directories under `tracks/` that no referenced script owns.
/// `imports/` is shared include storage — never GC'd. Directories touched
/// recently (mid-render safety margin) are left alone.
pub fn gc_targets(
    tracks_dir: &Path,
    referenced_srcs: &[ScriptRef],
    min_age: std::time::Duration,
) -> Vec<String> {
    let referenced: std::collections::HashSet<String> = referenced_srcs
        .iter()
        .map(|r| crate::manifest::manifest_id(&r.src))
        .collect();
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(tracks_dir) else {
        return out;
    };
    let cutoff = std::time::SystemTime::now()
        .checked_sub(min_age)
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !entry.metadata().map(|m| m.is_dir()).unwrap_or(false) {
            continue;
        }
        if name == "imports" || referenced.contains(&name) {
            continue;
        }
        let recent = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t > cutoff)
            .unwrap_or(true);
        if recent {
            continue;
        }
        out.push(name);
    }
    out.sort();
    out
}

/// True when `tracks/<manifest_id(src)>/manifest.json` exists and its
/// stored hash matches the current script bytes.
fn is_fresh(tracks_dir: &Path, agent_dir: &Path, src: &str) -> bool {
    let Ok(script_bytes) = std::fs::read(agent_dir.join(src)) else {
        return false;
    };
    let manifest_path = tracks_dir
        .join(crate::manifest::manifest_id(src))
        .join("manifest.json");
    let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    value
        .get("hash")
        .and_then(|h| h.as_str())
        .map(|h| h == crate::manifest::hash_bytes(&script_bytes))
        .unwrap_or(false)
}

// ============================================================================
// The pass itself
// ============================================================================

pub fn prerender_blocking(
    agent_dir: &Path,
    state_dir: &Path,
    tracks_dir: &Path,
    model_dir: &Path,
    renderer_arc: &parking_lot::Mutex<Option<crate::audio_renderer::AudioRenderer>>,
) -> PrerenderReport {
    let mut report = PrerenderReport::default();
    let now = chrono::Utc::now();

    let econ = economy::open_ro(&state_dir.join("economy.db"));
    let refs = collect_script_refs(agent_dir, econ.as_ref(), now);
    report.referenced = refs.len();

    // GC targets computed up front, executed after rendering (so a script
    // we just re-rendered keeps its dir).
    let gc = gc_targets(
        tracks_dir,
        &refs,
        std::time::Duration::from_secs(600),
    );

    let stale: Vec<&ScriptRef> = refs.iter().filter(|r| !is_fresh(tracks_dir, agent_dir, &r.src)).collect();
    report.fresh = refs.len() - stale.len();

    if !stale.is_empty() {
        if !crate::model_downloader::is_model_downloaded(model_dir) {
            report.model_missing = true;
        } else {
            // Lazily construct the renderer (same as load_model) and hold
            // the engine lock for the whole batch — renders serialize with
            // the UI path on the same mutex.
            let mut guard = renderer_arc.lock();
            if guard.is_none() {
                match crate::audio_renderer::AudioRenderer::new(model_dir) {
                    Ok(r) => *guard = Some(r),
                    Err(e) => report.errors.push(format!("engine init failed: {e:#}")),
                }
            }
            if let Some(renderer) = guard.as_mut() {
                for r in &stale {
                    match renderer.render_manifest(&r.src, agent_dir, tracks_dir, None) {
                        Ok(_) => report.rendered.push(r.src.clone()),
                        Err(e) => report.errors.push(format!("{}: {e:#}", r.src)),
                    }
                }
            }
        }
    }

    for dir in gc {
        if std::fs::remove_dir_all(tracks_dir.join(&dir)).is_ok() {
            report.gc_removed.push(dir);
        }
    }
    report
}

// ============================================================================
// Command
// ============================================================================

#[tauri::command]
pub async fn v2_prerender(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<PrerenderReport, String> {
    let agent_dir = state.agent_dir.clone();
    let state_dir = state.state_dir.clone();
    let tracks_dir = state.tracks_dir.clone();
    let model_dir = state.model_dir.clone();
    let renderer_arc = state.renderer.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        prerender_blocking(&agent_dir, &state_dir, &tracks_dir, &model_dir, &renderer_arc)
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = tauri::Emitter::emit(&app, "v2-prerender-done", &report);
    Ok(report)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn env(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let agent = tmp.path().join("agent_data");
        let tracks = tmp.path().join("tracks");
        std::fs::create_dir_all(&tracks).unwrap();
        for (rel, content) in files {
            let p = agent.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, content).unwrap();
        }
        (tmp, agent, tracks)
    }

    #[test]
    fn collect_refs_prioritizes_and_filters_missing() {
        let routine = "---\nformat: 2\ntitle: R\nschedule: 0 8 * * *\n---\n```feature\ntype: audio\nsrc: hypnos/a.xml\n---\nx\n```\n[link](hypnos/b.xml)\n";
        let habit = "---\ntitle: H\ntype: min\ncount: 1\nfailure: { \"type\": \"script\", \"src\": \"hypnos/c.xml\" }\n---\n";
        let (tmp, agent, _tracks) = env(&[
            ("routines/r.md", routine),
            ("habits/h.md", habit),
            ("hypnos/a.xml", "<voice>a</voice>"),
            ("hypnos/b.xml", "<voice>b</voice>"),
            ("hypnos/c.xml", "<voice>c</voice>"),
            // hypnos/missing.xml referenced nowhere on disk — filter target.
        ]);
        let refs = collect_script_refs(&agent, None, chrono::Utc::now());
        let srcs: Vec<&str> = refs.iter().map(|r| r.src.as_str()).collect();
        assert!(srcs.contains(&"hypnos/a.xml"));
        assert!(srcs.contains(&"hypnos/b.xml"));
        assert!(srcs.contains(&"hypnos/c.xml"));
        // The habit (unscheduled, lowest priority) sorts after the routine.
        let habit_ref = refs.iter().find(|r| r.src == "hypnos/c.xml").unwrap();
        let routine_ref = refs.iter().find(|r| r.src == "hypnos/a.xml").unwrap();
        assert!(habit_ref.priority > routine_ref.priority);
        let _ = tmp;
    }

    #[test]
    fn gc_targets_skips_referenced_imports_and_recent() {
        let routine = "---
format: 2
title: R
---
```feature
type: audio
src: hypnos/a.xml
---
x
```
";
        let (tmp, agent, tracks) = env(&[
            ("routines/r.md", routine),
            ("hypnos/a.xml", "<voice>a</voice>"),
        ]);
        let refs = collect_script_refs(&agent, None, chrono::Utc::now());
        // Owned by the referenced script; imports dir; fresh dir → all kept.
        std::fs::create_dir_all(tracks.join(crate::manifest::manifest_id("hypnos/a.xml"))).unwrap();
        std::fs::create_dir_all(tracks.join("imports")).unwrap();
        std::fs::create_dir_all(tracks.join("orphan")).unwrap();
        // min_age 0: everything older than "now" is collectable, so the
        // freshly-created orphan is eligible (the 10-minute grace only
        // protects dirs from *concurrent* renders in production).
        let targets = gc_targets(&tracks, &refs, std::time::Duration::ZERO);
        assert_eq!(targets, vec!["orphan".to_string()]);
        let _ = tmp;
    }
}
