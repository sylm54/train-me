//! v2 schedule engine (`<state_dir>/schedule.db`).
//!
//! The source of truth for "what was supposed to happen" — the occurrence
//! ledger from FORMAT.md §6. Nothing here trusts OS alarms: expected
//! occurrences (routine × cron fire, habit × local day, task instance)
//! are materialized idempotently, and [`reconcile`] resolves whatever
//! lapsed whenever the app is running. Background work (boot receivers,
//! WorkManager nudges — future) only reduces detection latency; running
//! [`reconcile_schedule`] on app open is what makes the engine correct.
//!
//! Layout:
//!
//!   - `occurrences`   — one row per expected routine run (id =
//!                       `routine:<path>:<due>` / ad-hoc ids for on-demand
//!                       starts), `pending → in_progress → completed |
//!                       failed | lapsed | lapsed-exempt`.
//!   - `habit_days`    — per-habit daily counters (`open → success |
//!                       failed`), evaluated at day boundaries.
//!   - `task_instances`— assigned template instances with deadline,
//!                       escalation timeouts, and their fired markers.
//!
//! Actions are executed by [`execute_actions`], idempotently keyed by a
//! `source` prefix (occurrence/instance id + action index) — the economy
//! ledger's UNIQUE(source) turns any double evaluation into a no-op.
//! Failure-side actions respect active exemptions (which also protect
//! streaks by suppressing the break-causing activity log entry);
//! success-side actions always fire.

use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{Emitter, State};

use crate::economy;
use crate::format::{self, Action};
use crate::AppState;

/// How far back reconcile looks for un-materialized cron fires / unevaluated
/// habit days. Anything older is treated as intentionally forgotten.
const LOOKBACK_SECS: i64 = 36 * 3600;
/// How far ahead occurrences are materialized (for the Today view).
const HORIZON_SECS: i64 = 24 * 3600;
/// Default completion window for scheduled routines without a `timeframe`.
const DEFAULT_WINDOW_SECS: i64 = 12 * 3600;

const SCHEMA_SQL: &str = "
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS occurrences (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    container TEXT NOT NULL,
    due TEXT NOT NULL,
    window_end TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created TEXT NOT NULL,
    started TEXT,
    resolved TEXT
);
CREATE INDEX IF NOT EXISTS idx_occ_container ON occurrences(container);
CREATE INDEX IF NOT EXISTS idx_occ_status ON occurrences(status);
CREATE TABLE IF NOT EXISTS habit_days (
    habit TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    PRIMARY KEY (habit, day)
);
CREATE TABLE IF NOT EXISTS task_instances (
    iid TEXT PRIMARY KEY,
    template TEXT NOT NULL,
    title TEXT NOT NULL,
    assigned TEXT NOT NULL,
    deadline TEXT,
    max_timeout TEXT,
    timeouts_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'assigned',
    fired_timeouts TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS containers (
    container TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    first_seen TEXT NOT NULL
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

// ============================================================================
// Small helpers
// ============================================================================

fn utc_now() -> chrono::DateTime<chrono::Utc> {
    // Engine clock = wall clock + debug offset (always 0 in release).
    crate::debug_time::now()
}

fn ts(dt: chrono::DateTime<chrono::Utc>) -> String {
    economy::ts_at(dt)
}

fn parse_ts(s: &str) -> chrono::DateTime<chrono::Utc> {
    economy::parse_ts(s).unwrap_or_else(utc_now)
}

fn local_day(d: chrono::DateTime<chrono::Utc>) -> String {
    d.with_timezone(&chrono::Local)
        .date_naive()
        .format("%Y-%m-%d")
        .to_string()
}

/// Notify the user of an engine outcome. The Rust side must not touch
/// the notification plugin from new call graphs (linking its desktop
/// backend from anywhere beyond render_notify's existing calls exploded
/// the Windows test binary's imports — STATUS_ENTRYPOINT_NOT_FOUND), so
/// this emits an event and the frontend delivers the OS notification via
/// its existing `notifications.ts` wrapper.
fn notify(app: Option<&tauri::AppHandle>, title: &str, body: &str) {
    notify_kind(app, title, body, "notice")
}

/// Like [`notify`], but with an explicit `kind`. `alert` marks messages
/// that originate from a `notification` action — the frontend shows those
/// as a prominent fullscreen popup while the user is in the app (the
/// screen dims around the message) instead of a transient toast.
fn notify_kind(app: Option<&tauri::AppHandle>, title: &str, body: &str, kind: &str) {
    use tauri::Emitter;
    if let Some(app) = app {
        let _ = app.emit(
            "v2-notify",
            serde_json::json!({ "title": title, "body": body, "kind": kind }),
        );
    }
}

/// Write an activity-log entry directly (same schema the UI writes via
/// `activity_log_entry`; DELETE journal mode like activity_db.rs).
pub fn log_activity(agent_dir: &Path, feature: &str, action: &str, details: &str) {
    let path = agent_dir.join("activity.db");
    let Ok(conn) = Connection::open(&path) else { return };
    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS activity (\
             id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, \
             feature TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL DEFAULT '')",
        [],
    );
    let _ = conn.execute(
        "INSERT INTO activity (ts, feature, action, details) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![economy::now_ts(), feature, action, details],
    );
}

/// List `dir/*.ext` files under the agent dir (non-recursive). Public for
/// the prerender scanner.
pub fn list_v2_files(agent_dir: &Path, dir: &str, ext: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(agent_dir.join(dir)) else {
        return out;
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_ascii_lowercase().ends_with(ext) {
            continue;
        }
        let rel = format!("{dir}/{name}");
        if let Ok(content) = std::fs::read_to_string(entry.path()) {
            out.push((rel, content));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

// ============================================================================
// Action executor
// ============================================================================

/// Execute a list of actions idempotently. `source_prefix` must be unique
/// per triggering event (occurrence / instance / purchase id) — each
/// action's source is `<prefix>:<index>`, and the economy ledger's
/// UNIQUE(source) makes re-execution a no-op. Returns human-readable log
/// lines (one per action) for the UI and the reconcile report.
pub fn execute_actions(
    econ: &Connection,
    sched: &Connection,
    app: Option<&tauri::AppHandle>,
    agent_dir: &Path,
    actions: &[Action],
    source_prefix: &str,
) -> Vec<String> {
    actions
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let source = format!("{source_prefix}:{i}");
            execute_action(econ, sched, app, agent_dir, a, &source)
        })
        .collect()
}

fn execute_action(
    econ: &Connection,
    sched: &Connection,
    app: Option<&tauri::AppHandle>,
    agent_dir: &Path,
    action: &Action,
    source: &str,
) -> String {
    match action {
        Action::Points { delta } => match economy::apply_points(econ, *delta, "scheduled action", source) {
            Ok(Some(bal)) => format!("points {delta:+} (balance {bal})"),
            Ok(None) => "points (already applied)".to_string(),
            Err(e) => format!("points failed: {e}"),
        },
        Action::Task { template } => match assign_task_instance(sched, agent_dir, template, source) {
            Ok(title) => format!("task assigned: {title}"),
            Err(e) => format!("task assignment failed: {e}"),
        },
        Action::Script { src } => {
            // Queue the script (Today's "Queued for you" list + top prerender
            // priority) and tell the frontend to auto-play it as a jingle when
            // the user is in the app — the audio companion to the notification.
            // The frontend gates on focus/interactivity and dismisses the
            // pending row itself once playback completes.
            match economy::queue_pending(econ, "script", src) {
                Ok(id) => {
                    notify(app, "Script queued", src);
                    if let Some(app) = app {
                        use tauri::Emitter;
                        let _ = app.emit("v2-autoplay", serde_json::json!({ "src": src, "id": id }));
                    }
                }
                Err(_) => notify(app, "Script queued", src),
            }
            format!("script queued: {src}")
        }
        Action::Notification { text } => {
            notify_kind(app, "Notice", text, "alert");
            format!("notified: {text}")
        }
        Action::Exemption {
            duration_secs,
            scope,
        } => {
            let until = ts(utc_now() + chrono::Duration::seconds(*duration_secs as i64));
            match economy::grant_exemption(econ, &scope_label(scope), &until) {
                Ok(()) => format!("exemption granted: {} until {until}", scope_label(scope)),
                Err(e) => format!("exemption failed: {e}"),
            }
        }
        Action::Roulette { outcomes } => {
            let total: u64 = outcomes.iter().map(|o| o.weight).sum();
            let mut pick = deterministic_u64(source) % total.max(1);
            let chosen = outcomes
                .iter()
                .find(|o| {
                    if pick < o.weight {
                        true
                    } else {
                        pick -= o.weight;
                        false
                    }
                })
                .unwrap_or(&outcomes[0]);
            let inner = execute_action(econ, sched, app, agent_dir, &chosen.action, source);
            format!("roulette → {inner}")
        }
    }
}

fn scope_label(scope: &format::Scope) -> String {
    match scope {
        format::Scope::Habits => "habits".to_string(),
        format::Scope::Routines => "routines".to_string(),
        format::Scope::Tasks => "tasks".to_string(),
        format::Scope::All => "all".to_string(),
    }
}

/// Stable pseudo-random u64 from a source key — roulette draws are
/// deterministic per source, so a re-evaluation can never re-roll.
fn deterministic_u64(source: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    source.hash(&mut h);
    h.finish()
}

/// Create a task instance from a template (used by `task` actions).
pub fn assign_task_instance(
    sched: &Connection,
    agent_dir: &Path,
    template: &str,
    source: &str,
) -> Result<String, String> {
    let rel = format::template_to_path(template);
    let full = crate::bash::resolve_under(agent_dir, &rel)?;
    let content = std::fs::read_to_string(&full).map_err(|e| format!("`{rel}`: {e}"))?;
    let (task, diags) = format::parse_task(&content);
    let errors: Vec<String> = diags
        .iter()
        .filter(|d| d.severity == format::Severity::Error)
        .map(|d| d.message.clone())
        .collect();
    if !errors.is_empty() {
        return Err(format!("template `{rel}` invalid: {}", errors.join("; ")));
    }
    let task = task.ok_or("template parse failed")?;
    let now = utc_now();
    let iid = format!("task:{template}:{}", deterministic_u64(source));
    let deadline = task
        .timeframe_secs
        .map(|s| ts(now + chrono::Duration::seconds(s as i64)));
    let max_timeout = task
        .max_timeout_secs
        .map(|s| ts(now + chrono::Duration::seconds(s as i64)));
    let timeouts_json = serde_json::to_string(&task.timeouts).map_err(|e| e.to_string())?;
    sched
        .execute(
            "INSERT OR IGNORE INTO task_instances \
             (iid, template, title, assigned, deadline, max_timeout, timeouts_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![iid, template, task.title, ts(now), deadline, max_timeout, timeouts_json],
        )
        .map_err(|e| e.to_string())?;
    Ok(task.title)
}

// ============================================================================
// Reconciliation (the correctness core — see module docs)
// ============================================================================

#[derive(Serialize, Clone, Debug, Default)]
pub struct ReconcileReport {
    pub materialized: usize,
    pub lapsed: usize,
    pub habit_days_evaluated: usize,
    pub tasks_failed: usize,
    pub actions_fired: usize,
    pub lines: Vec<String>,
}

/// When `rel`'s content was first seen. A routine the agent just wrote (or
/// edited) must not be punished for windows that closed before the content
/// existed, so reconcile only materializes fires from `first_seen` onward.
/// Re-seeing unchanged content (app restarts) keeps the original timestamp,
/// so genuinely missed windows still lapse. The content hash makes an edit
/// count as "new" — a rewritten schedule gets a fresh start too.
fn touch_container(
    sched: &Connection,
    rel: &str,
    content: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> chrono::DateTime<chrono::Utc> {
    let hash = crate::manifest::hash_bytes(content.as_bytes());
    let known: Option<String> = sched
        .query_row("SELECT hash FROM containers WHERE container = ?1", [rel], |r| r.get(0))
        .ok();
    if known.as_deref() != Some(hash.as_str()) {
        let _ = sched.execute(
            "INSERT INTO containers (container, hash, first_seen) VALUES (?1, ?2, ?3) \
             ON CONFLICT(container) DO UPDATE SET hash = ?2, first_seen = ?3",
            rusqlite::params![rel, hash, ts(now)],
        );
        return now;
    }
    sched
        .query_row("SELECT first_seen FROM containers WHERE container = ?1", [rel], |r| {
            r.get(0)
        })
        .ok()
        .and_then(|s: String| economy::parse_ts(&s))
        .unwrap_or(now)
}

pub fn reconcile_blocking(
    agent_dir: &Path,
    state_dir: &Path,
    app: Option<&tauri::AppHandle>,
) -> ReconcileReport {
    let mut report = ReconcileReport::default();
    let Ok(sched) = open(&state_dir.join("schedule.db")) else {
        report.lines.push("could not open schedule.db".into());
        return report;
    };
    let Ok(econ) = open(&state_dir.join("economy.db")) else {
        report.lines.push("could not open economy.db".into());
        return report;
    };
    let now = utc_now();

    // ── Routines: materialize expected occurrences, resolve lapses ──────
    for (rel, content) in list_v2_files(agent_dir, "routines", ".md") {
        let (Some(routine), _) = format::parse_routine(&content) else {
            continue;
        };
        let Some(schedule_expr) = routine.schedule.clone() else {
            continue;
        };

        // Materialize fires in [max(lookback, first_seen), now + horizon].
        // The success window is the routine's `timeframe` (or the default).
        let window_secs = routine
            .timeframe_secs
            .map_or(DEFAULT_WINDOW_SECS, |s| s as i64);
        {
            let first_seen = touch_container(&sched, &rel, &content, now);
            let from = std::cmp::max(now - chrono::Duration::seconds(LOOKBACK_SECS), first_seen);
            let to = now + chrono::Duration::seconds(HORIZON_SECS);
            if let Ok(fires) = cron_fires_between(&schedule_expr, from, to) {
                for due in fires {
                    let id = format!("routine:{rel}:{}", ts(due));
                    let window_end = ts(due + chrono::Duration::seconds(window_secs));
                    let created = sched
                        .execute(
                            "INSERT OR IGNORE INTO occurrences \
                             (id, kind, container, due, window_end, status, created) \
                             VALUES (?1, 'routine', ?2, ?3, ?4, 'pending', ?5)",
                            rusqlite::params![id, rel, ts(due), window_end, ts(now)],
                        )
                        .unwrap_or(0);
                    report.materialized += created;
                }
            }
        }

        // Resolve lapsed pending/in-progress occurrences (window passed).
        let lapse = resolve_lapsed_routine(&sched, &econ, app, agent_dir, &rel, &content, now);
        report.lapsed += lapse.0;
        report.actions_fired += lapse.1;
        report.lines.extend(lapse.2);
    }

    // ── Habits: ensure today's row, evaluate past days ──────────────────
    let today = local_day(now);
    let habits: Vec<(String, format::Habit)> = list_v2_files(agent_dir, "habits", ".md")
        .into_iter()
        .filter_map(|(rel, content)| {
            format::parse_habit(&content).0.map(|h| (rel, h))
        })
        .collect();
    for (rel, _) in &habits {
        let created = sched
            .execute(
                "INSERT OR IGNORE INTO habit_days (habit, day, count, status) \
                 VALUES (?1, ?2, 0, 'open')",
                rusqlite::params![rel, today],
            )
            .unwrap_or(0);
        report.materialized += created;
    }
    // Past open days: evaluate under/over the count, fire actions once.
    let past_rows: Vec<(String, String, i64)> = sched
        .prepare("SELECT habit, day, count FROM habit_days WHERE status = 'open' AND day < ?1")
        .and_then(|mut stmt| {
            let rows = stmt.query_map(rusqlite::params![today], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?;
            Ok(rows.filter_map(Result::ok).collect::<Vec<_>>())
        })
        .unwrap_or_default();
    for (habit_rel, day, count) in past_rows {
        let Some((_, habit)) = habits.iter().find(|(rel, _)| *rel == habit_rel) else {
            // Habit file deleted — close the day without consequences.
            let _ = sched.execute(
                "UPDATE habit_days SET status = 'success' WHERE habit = ?1 AND day = ?2",
                rusqlite::params![habit_rel, day],
            );
            continue;
        };
        let limit = habit.count as i64;
        let success = match habit.htype {
            format::HabitType::Max => count <= limit,
            format::HabitType::Min => count >= limit,
        };
        if habit_day_resolve(&sched, &econ, app, agent_dir, &habit_rel, &day, habit, success, &mut report) {
            report.habit_days_evaluated += 1;
        }
    }

    // ── Task instances: escalate timeouts, fail past deadlines ──────────
    let task_lines = reconcile_tasks(&sched, &econ, app, agent_dir, now, &mut report);
    report.lines.extend(task_lines);

    report.lines.truncate(50);
    report
}

/// Fires of `expr` in [from, to] (UTC, inclusive-exclusive).
fn cron_fires_between(
    expr: &str,
    from: chrono::DateTime<chrono::Utc>,
    to: chrono::DateTime<chrono::Utc>,
) -> Result<Vec<chrono::DateTime<chrono::Utc>>, String> {
    use std::str::FromStr;
    let normalized = crate::validators::normalize_cron(expr);
    let schedule = cron::Schedule::from_str(&normalized).map_err(|e| e.to_string())?;
    Ok(schedule.after(&from).take_while(|t| *t <= to).collect())
}

/// Lapse any pending/in_progress occurrence of `rel` whose window ended,
/// firing failure actions (unless an exemption covers routines).
fn resolve_lapsed_routine(
    sched: &Connection,
    econ: &Connection,
    app: Option<&tauri::AppHandle>,
    agent_dir: &Path,
    rel: &str,
    content: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> (usize, usize, Vec<String>) {
    let rows: Vec<(String, String)> = match sched.prepare(
        "SELECT id, window_end FROM occurrences \
         WHERE container = ?1 AND status IN ('pending', 'in_progress') AND window_end < ?2",
    ) {
        Ok(mut stmt) => stmt
            .query_map(rusqlite::params![rel, ts(now)], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let (routine, _) = format::parse_routine(content);
    let exempt = economy::exemption_active(econ, "routines").unwrap_or(false);

    let mut lapsed = 0;
    let mut fired = 0;
    let mut lines = Vec::new();
    // A distinct status for exempted misses lets the run-context streak
    // walk skip them without breaking the streak (exemptions protect
    // streaks — FORMAT.md §6).
    let lapse_status = if exempt { "lapsed-exempt" } else { "lapsed" };
    for (id, _window_end) in rows {
        // Mark first — structural idempotency before any side effects.
        let marked = sched
            .execute(
                "UPDATE occurrences SET status = ?2, resolved = ?3 WHERE id = ?1 \
                 AND status IN ('pending', 'in_progress')",
                rusqlite::params![id, lapse_status, ts(now)],
            )
            .unwrap_or(0);
        if marked == 0 {
            continue;
        }
        lapsed += 1;
        if exempt {
            lines.push(format!("{id}: lapsed (exempt — no failure fired)"));
            log_activity(agent_dir, "routine", "missed", &id);
            continue;
        }
        if let Some(routine) = &routine {
            fired += routine.failure.len();
            lines.extend(execute_actions(
                econ,
                sched,
                app,
                agent_dir,
                &routine.failure,
                &format!("{id}:failure"),
            ));
        }
        log_activity(agent_dir, "routine", "missed", &id);
        notify(
            app,
            "Routine lapsed",
            &routine
                .as_ref()
                .map(|r| r.title.clone())
                .unwrap_or_else(|| rel.to_string()),
        );
    }
    (lapsed, fired, lines)
}

/// Resolve a habit day: set status, fire success (always) or failure
/// (unless exempt). Returns true when the day transitioned.
fn habit_day_resolve(
    sched: &Connection,
    econ: &Connection,
    app: Option<&tauri::AppHandle>,
    agent_dir: &Path,
    habit_rel: &str,
    day: &str,
    habit: &format::Habit,
    success: bool,
    report: &mut ReconcileReport,
) -> bool {
    let new_status = if success { "success" } else { "failed" };
    let marked = sched
        .execute(
            "UPDATE habit_days SET status = ?3 WHERE habit = ?1 AND day = ?2 AND status = 'open'",
            rusqlite::params![habit_rel, day, new_status],
        )
        .unwrap_or(0);
    if marked == 0 {
        return false;
    }
    let source = format!("habit:{habit_rel}:{day}:{}", if success { "success" } else { "failure" });
    if success {
        report.actions_fired += habit.success.len();
        report.lines.extend(execute_actions(
            econ, sched, app, agent_dir, &habit.success, &source,
        ));
    } else if economy::exemption_active(econ, "habits").unwrap_or(false) {
        report
            .lines
            .push(format!("{habit_rel} {day}: failed (exempt — no failure fired)"));
    } else {
        report.actions_fired += habit.failure.len();
        report.lines.extend(execute_actions(
            econ, sched, app, agent_dir, &habit.failure, &source,
        ));
        log_activity(agent_dir, "habit", "broke", habit_rel);
        notify(app, "Habit failed", &habit.title);
    }
    true
}

/// Escalate elapsed timeouts and fail instances past their deadline.
fn reconcile_tasks(
    sched: &Connection,
    econ: &Connection,
    app: Option<&tauri::AppHandle>,
    agent_dir: &Path,
    now: chrono::DateTime<chrono::Utc>,
    report: &mut ReconcileReport,
) -> Vec<String> {
    let mut lines = Vec::new();
    let rows: Vec<(String, String, String, Option<String>, Option<String>, String, String)> = {
        let Ok(mut stmt) = sched.prepare(
            "SELECT iid, title, assigned, deadline, max_timeout, timeouts_json, fired_timeouts \
             FROM task_instances WHERE status IN ('assigned', 'in_progress')",
        ) else {
            return lines;
        };
        stmt.query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
    };

    for (iid, title, assigned_s, deadline_s, max_timeout_s, timeouts_json, fired) in rows {
        let assigned = parse_ts(&assigned_s);
        let hard_deadline = [deadline_s.as_deref(), max_timeout_s.as_deref()]
            .iter()
            .filter_map(|s| *s)
            .min()
            .map(parse_ts);
        let lapsed = hard_deadline.map(|d| now > d).unwrap_or(false);

        // On a hard lapse, mark failed first — then the elapsed timeout
        // levels still fire (FORMAT.md §4.3: "the largest `after` whose
        // time has passed fires"), followed by the failure actions.
        if lapsed {
            let marked = sched
                .execute(
                    "UPDATE task_instances SET status = 'failed' WHERE iid = ?1 \
                     AND status IN ('assigned', 'in_progress')",
                    rusqlite::params![iid],
                )
                .unwrap_or(0);
            if marked > 0 {
                report.tasks_failed += 1;
            }
        }

        // Timeout escalation — each `after` level fires exactly once.
        if let Ok(rules) = serde_json::from_str::<Vec<format::TimeoutRule>>(&timeouts_json) {
            let fired_set: Vec<String> = fired
                .split(',')
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect();
            for rule in rules {
                let key = rule.after_secs.to_string();
                if fired_set.contains(&key) {
                    continue;
                }
                if now >= assigned + chrono::Duration::seconds(rule.after_secs as i64) {
                    sched
                        .execute(
                            "UPDATE task_instances SET fired_timeouts = \
                             CASE WHEN fired_timeouts = '' THEN ?2 \
                                  ELSE fired_timeouts || ',' || ?2 END WHERE iid = ?1",
                            rusqlite::params![iid, key],
                        )
                        .ok();
                    if economy::exemption_active(econ, "tasks").unwrap_or(false) {
                        lines.push(format!("{iid}: timeout {key}s (exempt — suppressed)"));
                        continue;
                    }
                    report.actions_fired += rule.actions.len();
                    lines.extend(execute_actions(
                        econ,
                        sched,
                        app,
                        agent_dir,
                        &rule.actions,
                        &format!("{iid}:t{key}"),
                    ));
                }
            }
        }

        if lapsed {
            if economy::exemption_active(econ, "tasks").unwrap_or(false) {
                lines.push(format!("{iid}: failed (exempt — no failure fired)"));
            } else if let Some(failure) = load_task_failure(sched, agent_dir, &iid) {
                report.actions_fired += failure.len();
                lines.extend(execute_actions(
                    econ,
                    sched,
                    app,
                    agent_dir,
                    &failure,
                    &format!("{iid}:failure"),
                ));
            }
            notify(app, "Task failed", &title);
        }
    }
    lines
}

/// Load a task template's failure actions (for lapse handling).
fn load_task_failure(sched: &Connection, agent_dir: &Path, iid: &str) -> Option<Vec<Action>> {
    let template: String = sched
        .query_row("SELECT template FROM task_instances WHERE iid = ?1", [iid], |r| {
            r.get(0)
        })
        .ok()?;
    let rel = format::template_to_path(&template);
    let full = crate::bash::resolve_under(agent_dir, &rel).ok()?;
    let content = std::fs::read_to_string(full).ok()?;
    format::parse_task(&content).0.map(|t| t.failure)
}

// ============================================================================
// Run lifecycle commands
// ============================================================================

// ============================================================================
// Run context (condition variables)
// ============================================================================

/// Engine-provided run-context variables, consumed by every condition in
/// feature files (routine `@when`/`{{#if}}`/`when:`, TTS `<if cond>`) and
/// by `{{ var }}` interpolation. Names mirror `RESERVED_VARS` in
/// `src/lib/cond.ts`; answer fields merge on top at run time.
///
/// `target` names the container the context is for — `("routine", rel_path)`
/// or `("task", template_name)` — adding its history stats (`streak`,
/// `done`, …). `None` yields environment-only variables (standalone audio
/// playback outside any run).
pub fn build_run_context(
    sched: &Connection,
    econ: &Connection,
    state_dir: &Path,
    target: Option<(&str, &str)>,
) -> serde_json::Map<String, serde_json::Value> {
    use chrono::{Datelike, Timelike};

    let mut vars = serde_json::Map::new();
    let local = crate::debug_time::now().with_timezone(&chrono::Local);
    const DAYS: [&str; 7] = [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
    ];
    let dow = local.weekday().num_days_from_sunday() as usize;
    vars.insert("weekday".into(), serde_json::json!(DAYS[dow]));
    vars.insert("is_weekend".into(), serde_json::json!(dow == 0 || dow == 6));
    vars.insert("hour".into(), serde_json::json!(local.hour() as i64));
    vars.insert("date".into(), serde_json::json!(local.day() as i64));
    vars.insert("month".into(), serde_json::json!(local.month() as i64));
    vars.insert(
        "points".into(),
        serde_json::json!(economy::balance(econ).unwrap_or(0)),
    );
    vars.insert(
        "locked".into(),
        serde_json::json!(
            crate::chastity::ChastityState::load(&state_dir.join("chastity.json")).locked
        ),
    );

    match target {
        Some(("task", template)) => collect_task_stats(sched, template, &mut vars),
        Some(("routine", rel)) | Some((_, rel)) => {
            collect_routine_stats(sched, rel, &local, &mut vars)
        }
        None => {}
    }
    vars
}

/// History stats for a routine, derived from the occurrence ledger.
fn collect_routine_stats(
    sched: &Connection,
    rel: &str,
    local: &chrono::DateTime<chrono::Local>,
    vars: &mut serde_json::Map<String, serde_json::Value>,
) {
    let scalar = |sql: &str| -> i64 {
        sched
            .query_row(sql, [rel], |r| r.get::<_, i64>(0))
            .unwrap_or(0)
    };
    let done = scalar(
        "SELECT COUNT(*) FROM occurrences WHERE container = ?1 AND status = 'completed'",
    );
    let fails = scalar("SELECT COUNT(*) FROM occurrences WHERE container = ?1 AND status IN ('failed', 'lapsed')");
    vars.insert("done".into(), serde_json::json!(done));
    vars.insert("fails".into(), serde_json::json!(fails));

    // Newest-first statuses; exempted misses (`lapsed-exempt`) are
    // streak-neutral. `streak` = leading completed run; `best_streak` =
    // longest completed run anywhere in history.
    let statuses: Vec<String> = {
        let mut stmt = match sched.prepare(
            "SELECT status FROM occurrences \
             WHERE container = ?1 AND status IN ('completed', 'failed', 'lapsed', 'lapsed-exempt') \
             ORDER BY COALESCE(resolved, started, created) DESC",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        let collected: Vec<String> = match stmt.query_map([rel], |r| r.get::<_, String>(0)) {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => return,
        };
        collected
    };
    let mut streak: i64 = 0;
    for status in &statuses {
        match status.as_str() {
            "completed" => streak += 1,
            "lapsed-exempt" => {}
            _ => break,
        }
    }
    let mut best: i64 = 0;
    let mut run: i64 = 0;
    for status in statuses.iter().rev() {
        match status.as_str() {
            "completed" => {
                run += 1;
                best = best.max(run);
            }
            "lapsed-exempt" => {}
            _ => run = 0,
        }
    }
    vars.insert("streak".into(), serde_json::json!(streak));
    vars.insert("best_streak".into(), serde_json::json!(best));

    if done > 0 {
        let last: Option<String> = sched
            .query_row(
                "SELECT COALESCE(resolved, started, created) FROM occurrences \
                 WHERE container = ?1 AND status = 'completed' \
                 ORDER BY COALESCE(resolved, started, created) DESC LIMIT 1",
                [rel],
                |r| r.get(0),
            )
            .ok();
        if let Some(last) = last.and_then(|s| economy::parse_ts(&s)) {
            let days =
                (local.date_naive() - last.with_timezone(&chrono::Local).date_naive()).num_days();
            vars.insert("days_since_last".into(), serde_json::json!(days));
        }
    }
}

/// History stats for task instances of one template.
fn collect_task_stats(
    sched: &Connection,
    template: &str,
    vars: &mut serde_json::Map<String, serde_json::Value>,
) {
    let statuses: Vec<String> = {
        let mut stmt = match sched.prepare(
            "SELECT status FROM task_instances \
             WHERE template = ?1 AND status IN ('completed', 'failed') ORDER BY assigned DESC",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        let collected: Vec<String> = match stmt.query_map([template], |r| r.get::<_, String>(0)) {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => return,
        };
        collected
    };
    let done = statuses.iter().filter(|s| s.as_str() == "completed").count() as i64;
    let fails = statuses.iter().filter(|s| s.as_str() == "failed").count() as i64;
    let mut streak: i64 = 0;
    for status in &statuses {
        match status.as_str() {
            "completed" => streak += 1,
            _ => break,
        }
    }
    let mut best: i64 = 0;
    let mut run: i64 = 0;
    for status in statuses.iter().rev() {
        if status == "completed" {
            run += 1;
            best = best.max(run);
        } else {
            run = 0;
        }
    }
    vars.insert("done".into(), serde_json::json!(done));
    vars.insert("fails".into(), serde_json::json!(fails));
    vars.insert("streak".into(), serde_json::json!(streak));
    vars.insert("best_streak".into(), serde_json::json!(best));
}

#[derive(Serialize)]
pub struct RunStart {
    pub run_id: String,
    pub title: String,
    pub kind: String, // "routine" | "task"
    pub routine: Option<format::Routine>,
    pub task: Option<format::TaskTemplate>,
    /// Engine-computed run-context variables (conditions + interpolation).
    pub context: serde_json::Map<String, serde_json::Value>,
}

fn parse_errors(diags: &[format::Diag]) -> Option<String> {
    let errors: Vec<&str> = diags
        .iter()
        .filter(|d| d.severity == format::Severity::Error)
        .map(|d| d.message.as_str())
        .collect();
    if errors.is_empty() {
        None
    } else {
        Some(errors.join("; "))
    }
}

#[tauri::command]
pub async fn v2_start_run(
    kind: String,
    ref_id: String,
    occurrence: Option<String>,
    state: State<'_, AppState>,
) -> Result<RunStart, String> {
    let agent_dir = state.agent_dir.clone();
    let state_dir = state.state_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sched = open(&state_dir.join("schedule.db"))?;
        let econ = open(&state_dir.join("economy.db"))?;
        let now = utc_now();

        if kind == "task" {
            let (title, template): (String, String) = sched.query_row(
                "SELECT title, template FROM task_instances WHERE iid = ?1",
                [&ref_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ).map_err(|_| format!("unknown task instance `{ref_id}`"))?;
            if !sched.execute(
                "UPDATE task_instances SET status = 'in_progress' WHERE iid = ?1 AND status IN ('assigned', 'in_progress')",
                [&ref_id],
            ).map(|n| n > 0).unwrap_or(false) {
                return Err("task instance is no longer open".into());
            }
            let full = crate::bash::resolve_under(&agent_dir, &format::template_to_path(&template))?;
            let content = std::fs::read_to_string(full).map_err(|e| e.to_string())?;
            let (task, diags) = format::parse_task(&content);
            if let Some(e) = parse_errors(&diags) {
                return Err(format!("task template invalid: {e}"));
            }
            let context = build_run_context(
                &sched,
                &econ,
                &state_dir,
                Some(("task", template.as_str())),
            );
            return Ok(RunStart {
                run_id: ref_id.clone(),
                title,
                kind: "task".into(),
                routine: None,
                task,
                context,
            });
        }

        // Routine.
        let full = crate::bash::resolve_under(&agent_dir, &ref_id)?;
        let content = std::fs::read_to_string(&full).map_err(|e| e.to_string())?;
        let (routine, diags) = format::parse_routine(&content);
        if let Some(e) = parse_errors(&diags) {
            return Err(format!("routine invalid: {e}"));
        }
        let routine = routine.ok_or("routine parse failed")?;

        // Resume an in-progress occurrence if one exists.
        if let Ok((id,)) = sched.query_row(
            "SELECT id FROM occurrences WHERE container = ?1 AND status = 'in_progress' \
             ORDER BY started DESC LIMIT 1",
            [&ref_id],
            |r| Ok((r.get(0)?,)),
        ) {
            let context = build_run_context(&sched, &econ, &state_dir, Some(("routine", &ref_id)));
            return Ok(RunStart {
                run_id: id,
                title: routine.title.clone(),
                kind: "routine".into(),
                routine: Some(routine),
                task: None,
                context,
            });
        }

        let run_id = if routine.schedule.is_none() {
            // On-demand: enforce cooldown (starts) and limit (completions).
            if let Some(cooldown) = routine.cooldown_secs {
                let last: Option<String> = sched
                    .query_row(
                        "SELECT started FROM occurrences \
                         WHERE container = ?1 AND started IS NOT NULL \
                         ORDER BY started DESC LIMIT 1",
                        [&ref_id],
                        |r| r.get(0),
                    )
                    .ok();
                if let Some(last) = last {
                    let until = parse_ts(&last) + chrono::Duration::seconds(cooldown as i64);
                    if now < until {
                        return Err(format!(
                            "cooldown active — try again in {}",
                            humanize((until - now).num_seconds())
                        ));
                    }
                }
            }
            if let Some(limit) = &routine.limit {
                let completions: Vec<String> = {
                    let mut stmt = sched.prepare(
                        "SELECT resolved FROM occurrences WHERE container = ?1 \
                         AND status = 'completed' AND resolved IS NOT NULL",
                    ).map_err(|e| e.to_string())?;
                    let rows = stmt.query_map([&ref_id], |r| r.get(0)).map_err(|e| e.to_string())?;
                    rows.filter_map(Result::ok).collect()
                };
                let today_s = local_day(now);
                let daily: usize = completions
                    .iter()
                    .filter(|c| local_day(parse_ts(c)) == today_s)
                    .count();
                let total = completions.len();
                if let Some(d) = limit.daily {
                    if daily >= d as usize {
                        return Err(format!(
                            "daily limit reached ({daily}/{} rewarded completions today)",
                            d
                        ));
                    }
                }
                if let Some(t) = limit.total {
                    if total >= t as usize {
                        return Err(format!("total limit reached ({total}/{t} completions)"));
                    }
                }
            }
            format!(
                "routine:{ref_id}:adhoc:{}{}",
                now.timestamp_micros(),
                rand::random::<u32>()
            )
        } else if let Some(occ) = occurrence {
            occ
        } else {
            // Scheduled start from the library: claim the occurrence whose
            // window is open, else the next pending one, else ad-hoc now.
            let now_s = ts(now);
            if let Ok((id,)) = sched.query_row(
                "SELECT id FROM occurrences WHERE container = ?1 AND status = 'pending' \
                 AND due <= ?2 AND window_end > ?2 ORDER BY due DESC LIMIT 1",
                rusqlite::params![ref_id, now_s],
                |r| Ok((r.get(0)?,)),
            ) {
                id
            } else if let Ok((id,)) = sched.query_row(
                "SELECT id FROM occurrences WHERE container = ?1 AND status = 'pending' \
                 ORDER BY due ASC LIMIT 1",
                [&ref_id],
                |r| Ok((r.get(0)?,)),
            ) {
                id
            } else {
                format!(
                    "routine:{ref_id}:adhoc:{}{}",
                    now.timestamp_micros(),
                    rand::random::<u32>()
                )
            }
        };

        let window_end = ts(
            now + chrono::Duration::seconds(
                routine.timeframe_secs.map(|s| s as i64).unwrap_or(DEFAULT_WINDOW_SECS),
            ),
        );
        sched.execute(
            "INSERT INTO occurrences (id, kind, container, due, window_end, status, created, started) \
             VALUES (?1, 'routine', ?2, ?3, ?4, 'in_progress', ?3, ?3) \
             ON CONFLICT(id) DO UPDATE SET status = 'in_progress', started = ?3",
            rusqlite::params![run_id, ref_id, ts(now), window_end],
        ).map_err(|e| e.to_string())?;
        log_activity(&agent_dir, "routine", "start", &run_id);
        let context = build_run_context(&sched, &econ, &state_dir, Some(("routine", &ref_id)));
        Ok(RunStart {
            run_id,
            title: routine.title.clone(),
            kind: "routine".into(),
            routine: Some(routine),
            task: None,
            context,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run-context variables for playback outside a session: `ref_id` absent
/// (or not a recognized container path) yields environment-only variables
/// (`weekday`, `points`, `locked`, …) — the standalone-player default.
#[tauri::command]
pub async fn v2_context(
    ref_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let state_dir = state.state_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sched = open(&state_dir.join("schedule.db"))?;
        let econ = open(&state_dir.join("economy.db"))?;
        let target = ref_id.as_deref().map(|r| {
            if let Some(stem) = r.strip_prefix("tasks/").or_else(|| r.strip_prefix("tasks\\")) {
                let stem = stem.strip_suffix(".md").unwrap_or(stem);
                ("task", stem.to_string())
            } else {
                ("routine", r.to_string())
            }
        });
        Ok(build_run_context(
            &sched,
            &econ,
            &state_dir,
            target.as_ref().map(|(k, r)| (*k, r.as_str())),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn humanize(secs: i64) -> String {
    if secs >= 3600 {
        format!("{}h {}m", secs / 3600, (secs % 3600) / 60)
    } else if secs >= 60 {
        format!("{}m", secs / 60)
    } else {
        format!("{secs}s")
    }
}

#[derive(Serialize)]
pub struct RunOutcome {
    pub lines: Vec<String>,
    pub balance: i64,
}

#[tauri::command]
pub async fn v2_finish_run(
    run_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RunOutcome, String> {
    let agent_dir = state.agent_dir.clone();
    let state_dir = state.state_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sched = open(&state_dir.join("schedule.db"))?;
        let econ = open(&state_dir.join("economy.db"))?;
        let now = utc_now();

        if let Some((_, template)) = as_task_instance(&sched, &run_id) {
            let full = crate::bash::resolve_under(
                &agent_dir,
                &format::template_to_path(&template),
            )?;
            let content = std::fs::read_to_string(full).map_err(|e| e.to_string())?;
            let (task, _) = format::parse_task(&content);
            sched.execute(
                "UPDATE task_instances SET status = 'completed' WHERE iid = ?1",
                [&run_id],
            ).map_err(|e| e.to_string())?;
            let actions = task.map(|t| t.success).unwrap_or_default();
            let lines = execute_actions(&econ, &sched, Some(&app), &agent_dir, &actions, &format!("{run_id}:success"));
            log_activity(&agent_dir, "task", "done", &run_id);
            return Ok(RunOutcome {
                lines,
                balance: economy::balance(&econ)?,
            });
        }

        let container: String = sched
            .query_row("SELECT container FROM occurrences WHERE id = ?1", [&run_id], |r| r.get(0))
            .map_err(|_| format!("unknown run `{run_id}`"))?;
        sched.execute(
            "UPDATE occurrences SET status = 'completed', resolved = ?2 WHERE id = ?1",
            rusqlite::params![run_id, ts(now)],
        ).map_err(|e| e.to_string())?;
        let full = crate::bash::resolve_under(&agent_dir, &container)?;
        let content = std::fs::read_to_string(full).map_err(|e| e.to_string())?;
        let (routine, _) = format::parse_routine(&content);
        let actions = routine.map(|r| r.success).unwrap_or_default();
        let lines = execute_actions(&econ, &sched, Some(&app), &agent_dir, &actions, &format!("{run_id}:success"));
        log_activity(&agent_dir, "routine", "done", &container);
        Ok(RunOutcome {
            lines,
            balance: economy::balance(&econ)?,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn v2_fail_run(
    run_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RunOutcome, String> {
    let agent_dir = state.agent_dir.clone();
    let state_dir = state.state_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sched = open(&state_dir.join("schedule.db"))?;
        let econ = open(&state_dir.join("economy.db"))?;
        let now = utc_now();

        // Task instance give-up.
        if let Some((_, template)) = as_task_instance(&sched, &run_id) {
            sched.execute(
                "UPDATE task_instances SET status = 'failed' WHERE iid = ?1",
                [&run_id],
            ).map_err(|e| e.to_string())?;
            let full = crate::bash::resolve_under(&agent_dir, &format::template_to_path(&template))?;
            let content = std::fs::read_to_string(full).map_err(|e| e.to_string())?;
            let (task, _) = format::parse_task(&content);
            let actions = task.map(|t| t.failure).unwrap_or_default();
            let lines = if economy::exemption_active(&econ, "tasks").unwrap_or(false) {
                vec!["give-up recorded (exempt — no failure fired)".into()]
            } else {
                execute_actions(&econ, &sched, Some(&app), &agent_dir, &actions, &format!("{run_id}:failure"))
            };
            log_activity(&agent_dir, "task", "quit", &run_id);
            return Ok(RunOutcome {
                lines,
                balance: economy::balance(&econ)?,
            });
        }

        let container: String = sched
            .query_row("SELECT container FROM occurrences WHERE id = ?1", [&run_id], |r| r.get(0))
            .map_err(|_| format!("unknown run `{run_id}`"))?;
        sched.execute(
            "UPDATE occurrences SET status = 'failed', resolved = ?2 WHERE id = ?1",
            rusqlite::params![run_id, ts(now)],
        ).map_err(|e| e.to_string())?;
        let full = crate::bash::resolve_under(&agent_dir, &container)?;
        let content = std::fs::read_to_string(full).map_err(|e| e.to_string())?;
        let (routine, _) = format::parse_routine(&content);
        let actions = routine.map(|r| r.failure).unwrap_or_default();
        let lines = if economy::exemption_active(&econ, "routines").unwrap_or(false) {
            vec!["give-up recorded (exempt — no failure fired)".into()]
        } else {
            execute_actions(&econ, &sched, Some(&app), &agent_dir, &actions, &format!("{run_id}:failure"))
        };
        log_activity(&agent_dir, "routine", "quit", &container);
        Ok(RunOutcome {
            lines,
            balance: economy::balance(&econ)?,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// If `run_id` names a task instance, return `(iid, template)`.
fn as_task_instance(sched: &Connection, run_id: &str) -> Option<(String, String)> {
    sched
        .query_row(
            "SELECT iid, template FROM task_instances WHERE iid = ?1",
            [run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()
}

// ============================================================================
// Habits + store commands
// ============================================================================

#[derive(Serialize)]
pub struct HabitLogResult {
    pub count: i64,
    pub limit: i64,
    pub htype: String,
    pub status: String,
    pub title: String,
    pub lines: Vec<String>,
    pub balance: i64,
}

#[tauri::command]
pub async fn v2_habit_log(
    habit_ref: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<HabitLogResult, String> {
    let agent_dir = state.agent_dir.clone();
    let state_dir = state.state_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sched = open(&state_dir.join("schedule.db"))?;
        let econ = open(&state_dir.join("economy.db"))?;
        let full = crate::bash::resolve_under(&agent_dir, &habit_ref)?;
        let content = std::fs::read_to_string(&full).map_err(|e| e.to_string())?;
        let (habit, diags) = format::parse_habit(&content);
        if let Some(e) = parse_errors(&diags) {
            return Err(format!("habit invalid: {e}"));
        }
        let habit = habit.ok_or("habit parse failed")?;

        let today = local_day(utc_now());
        sched.execute(
            "INSERT OR IGNORE INTO habit_days (habit, day, count, status) VALUES (?1, ?2, 0, 'open')",
            rusqlite::params![habit_ref, today],
        ).map_err(|e| e.to_string())?;
        sched.execute(
            "UPDATE habit_days SET count = count + 1 WHERE habit = ?1 AND day = ?2",
            rusqlite::params![habit_ref, today],
        ).map_err(|e| e.to_string())?;
        let (count, status): (i64, String) = sched.query_row(
            "SELECT count, status FROM habit_days WHERE habit = ?1 AND day = ?2",
            rusqlite::params![habit_ref, today],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|e| e.to_string())?;

        log_activity(&agent_dir, "habit", "log", &habit_ref);

        // Immediate consequences at the moment of logging.
        let limit = habit.count as i64;
        let mut lines = Vec::new();
        let mut report = ReconcileReport::default();
        if status == "open" {
            let resolved = match habit.htype {
                // Any action beyond the limit fails immediately.
                format::HabitType::Max if count > limit => {
                    Some(habit_day_resolve(&sched, &econ, Some(&app), &agent_dir, &habit_ref, &today, &habit, false, &mut report))
                }
                // Success the moment the count is reached.
                format::HabitType::Min if count >= limit => {
                    let r = habit_day_resolve(&sched, &econ, Some(&app), &agent_dir, &habit_ref, &today, &habit, true, &mut report);
                    if r {
                        lines.push("goal reached — success fired".to_string());
                    }
                    Some(r)
                }
                _ => None,
            };
            if resolved == Some(true) && matches!(habit.htype, format::HabitType::Max) {
                lines.push(format!("limit exceeded ({count}/{limit}) — failure fired"));
            }
        }
        lines.extend(report.lines);

        let (count, status): (i64, String) = sched.query_row(
            "SELECT count, status FROM habit_days WHERE habit = ?1 AND day = ?2",
            rusqlite::params![habit_ref, today],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(|e| e.to_string())?;
        Ok(HabitLogResult {
            count,
            limit,
            htype: match habit.htype {
                format::HabitType::Max => "max".into(),
                format::HabitType::Min => "min".into(),
            },
            status,
            title: habit.title,
            lines,
            balance: economy::balance(&econ)?,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct PurchaseResult {
    pub lines: Vec<String>,
    pub balance: i64,
}

// ============================================================================
// Habit detail (drives the habit inspector in the Today view)
// ============================================================================

#[derive(Serialize)]
pub struct HabitDay {
    pub day: String,
    pub count: i64,
    pub status: String,
}

#[derive(Serialize)]
pub struct HabitDetail {
    pub habit: format::Habit,
    /// Recorded days, newest first (capped at 60).
    pub history: Vec<HabitDay>,
}

#[tauri::command]
pub async fn v2_habit_history(
    habit_ref: String,
    state: State<'_, AppState>,
) -> Result<HabitDetail, String> {
    let agent_dir = state.agent_dir.clone();
    let state_dir = state.state_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sched = open(&state_dir.join("schedule.db"))?;
        let full = crate::bash::resolve_under(&agent_dir, &habit_ref)?;
        let content = std::fs::read_to_string(&full).map_err(|e| e.to_string())?;
        let (habit, diags) = format::parse_habit(&content);
        if let Some(e) = parse_errors(&diags) {
            return Err(format!("habit invalid: {e}"));
        }
        let habit = habit.ok_or("habit parse failed")?;
        let history: Vec<HabitDay> = sched
            .prepare(
                "SELECT day, count, status FROM habit_days \
                 WHERE habit = ?1 ORDER BY day DESC LIMIT 60",
            )
            .and_then(|mut stmt| {
                let rows = stmt.query_map([&habit_ref], |r| {
                    Ok(HabitDay {
                        day: r.get(0)?,
                        count: r.get(1)?,
                        status: r.get(2)?,
                    })
                })?;
                Ok(rows.filter_map(Result::ok).collect())
            })
            .map_err(|e| e.to_string())?;
        Ok(HabitDetail { habit, history })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn v2_purchase(
    entry: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<PurchaseResult, String> {
    let agent_dir = state.agent_dir.clone();
    let state_dir = state.state_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sched = open(&state_dir.join("schedule.db"))?;
        let econ = open(&state_dir.join("economy.db"))?;
        let full = crate::bash::resolve_under(&agent_dir, &entry)?;
        let content = std::fs::read_to_string(&full).map_err(|e| e.to_string())?;
        let (store, diags) = format::parse_store_entry(&content);
        if let Some(e) = parse_errors(&diags) {
            return Err(format!("store entry invalid: {e}"));
        }
        let store = store.ok_or("store entry parse failed")?;

        if let Some(initial) = store.stock {
            let stock = economy::stock_for(&econ, &entry, initial, store.restock.as_deref())?;
            if stock.is_some_and(|s| s <= 0) {
                return Err("out of stock".into());
            }
        }
        let bal = economy::balance(&econ)?;
        if bal < store.price {
            return Err(format!("not enough points ({bal} / {})", store.price));
        }

        let purchase_id = economy::record_purchase(&econ, &entry, store.price)?;
        let source = format!("purchase:{entry}:{purchase_id}");
        economy::apply_points(&econ, -store.price, &format!("bought {}", store.title.clone().unwrap_or_else(|| entry.clone())), &source)?;
        if store.stock.is_some() {
            economy::record_sold(&econ, &entry)?;
        }
        let lines = execute_actions(&econ, &sched, Some(&app), &agent_dir, &store.actions, &format!("{source}:actions"));
        log_activity(&agent_dir, "store", "purchase", &entry);
        Ok(PurchaseResult {
            lines,
            balance: economy::balance(&econ)?,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============================================================================
// Summary (drives the Today view)
// ============================================================================

#[derive(Serialize, Clone)]
pub struct DueInfo {
    pub occurrence: String,
    pub due: String,
    pub window_end: String,
}

#[derive(Serialize, Clone)]
pub struct RoutineCard {
    pub path: String,
    pub title: String,
    pub schedule: Option<String>,
    pub on_demand: bool,
    /// Why the routine cannot be started right now (cooldown/limit), if so.
    pub locked: Option<String>,
    pub current: Option<DueInfo>,
    pub next: Option<DueInfo>,
    pub in_progress: Option<String>,
    /// Audio scripts referenced by this routine (pages + actions) — drives
    /// the per-item prerender affordance.
    pub audio: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct HabitCard {
    pub path: String,
    pub title: String,
    pub htype: String,
    pub limit: i64,
    pub today_count: i64,
    pub status: String,
    /// Audio scripts referenced by this habit's actions.
    pub audio: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct TaskCard {
    pub iid: String,
    pub title: String,
    pub template: String,
    pub deadline: Option<String>,
    pub status: String,
    /// Audio scripts referenced by the template (pages + actions).
    pub audio: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct StoreCard {
    pub path: String,
    pub title: String,
    pub description: Option<String>,
    pub price: i64,
    pub stock: Option<i64>,
    /// Audio scripts referenced by this entry's action.
    pub audio: Vec<String>,
}

/// One routine occurrence on the Today view's day timeline.
#[derive(Serialize, Clone)]
pub struct TimelineItem {
    /// Routine path (back-reference to the card list).
    pub container: String,
    pub title: String,
    pub occurrence: String,
    pub due: String,
    pub window_end: String,
    /// `pending | in_progress | completed | failed | lapsed | lapsed-exempt`
    pub status: String,
    /// Ad-hoc (on-demand) start rather than a scheduled fire — rendered as
    /// activity history, not as a timetable slot.
    pub adhoc: bool,
}

/// Script paths referenced by a container's pages and action lists,
/// deduped — the summary cards expose them so the UI can offer prerender
/// without starting anything.
fn container_audio(pages: &[format::Page], action_lists: &[&[format::Action]]) -> Vec<String> {
    let mut srcs = format::audio_feature_srcs(pages);
    for actions in action_lists {
        let mut arefs = format::ActionRefs::default();
        format::collect_action_refs(actions, &mut arefs);
        srcs.extend(arefs.scripts);
    }
    srcs.sort();
    srcs.dedup();
    srcs
}

#[derive(Serialize)]
pub struct V2Summary {
    pub balance: i64,
    pub exemptions: Vec<economy::ExemptionRow>,
    pub pending: Vec<economy::PendingRow>,
    pub ledger: Vec<economy::LedgerRow>,
    pub routines: Vec<RoutineCard>,
    pub habits: Vec<HabitCard>,
    pub tasks: Vec<TaskCard>,
    pub store: Vec<StoreCard>,
    /// Routine occurrences overlapping today (local day) — the timeline.
    pub timeline: Vec<TimelineItem>,
}

#[tauri::command]
pub async fn v2_summary(state: State<'_, AppState>) -> Result<V2Summary, String> {
    let agent_dir = state.agent_dir.clone();
    let state_dir = state.state_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sched = open(&state_dir.join("schedule.db"))?;
        let econ = open(&state_dir.join("economy.db"))?;
        let now = utc_now();
        let now_s = ts(now);
        let today = local_day(now);

        // Routines.
        let mut routines = Vec::new();
        // Titles for the timeline's occurrence → routine join.
        let mut titles: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for (rel, content) in list_v2_files(&agent_dir, "routines", ".md") {
            let Some(routine) = format::parse_routine(&content).0 else {
                continue;
            };
            titles.insert(rel.clone(), routine.title.clone());
            let query = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> Option<DueInfo> {
                sched
                    .query_row(sql, params, |r| {
                        Ok(DueInfo {
                            occurrence: r.get(0)?,
                            due: r.get(1)?,
                            window_end: r.get(2)?,
                        })
                    })
                    .ok()
            };
            let current = query(
                "SELECT id, due, window_end FROM occurrences WHERE container = ?1 \
                 AND status = 'pending' AND due <= ?2 AND window_end > ?2 ORDER BY due DESC LIMIT 1",
                &[&rel, &now_s],
            );
            let next = query(
                "SELECT id, due, window_end FROM occurrences WHERE container = ?1 \
                 AND status = 'pending' AND due > ?2 ORDER BY due ASC LIMIT 1",
                &[&rel, &now_s],
            );
            let in_progress: Option<String> = sched
                .query_row(
                    "SELECT id FROM occurrences WHERE container = ?1 AND status = 'in_progress' \
                     ORDER BY started DESC LIMIT 1",
                    [&rel],
                    |r| r.get(0),
                )
                .ok();

            let mut locked = None;
            if routine.schedule.is_none() {
                if let Some(limit) = &routine.limit {
                    let completed: Vec<String> = {
                        let mut stmt = sched.prepare(
                            "SELECT resolved FROM occurrences WHERE container = ?1 \
                             AND status = 'completed' AND resolved IS NOT NULL",
                        ).map_err(|e| e.to_string())?;
                        let rows = stmt.query_map([&rel], |r| r.get(0)).map_err(|e| e.to_string())?;
                        rows.filter_map(Result::ok).collect()
                    };
                    let daily = completed
                        .iter()
                        .filter(|c| local_day(parse_ts(c)) == today)
                        .count();
                    if let Some(d) = limit.daily {
                        if daily >= d as usize {
                            locked = Some(format!("rewarded {daily}/{} today", d));
                        }
                    }
                    if locked.is_none() {
                        if let Some(t) = limit.total {
                            if completed.len() >= t as usize {
                                locked = Some(format!("total limit {}/{}", completed.len(), t));
                            }
                        }
                    }
                }
            }

            let on_demand = routine.schedule.is_none();
            routines.push(RoutineCard {
                path: rel,
                title: routine.title,
                schedule: routine.schedule,
                on_demand,
                locked,
                current,
                next,
                in_progress,
                audio: container_audio(&routine.pages, &[&routine.success, &routine.failure]),
            });
        }

        // Habits.
        let mut habits = Vec::new();
        for (rel, content) in list_v2_files(&agent_dir, "habits", ".md") {
            let Some(habit) = format::parse_habit(&content).0 else {
                continue;
            };
            sched.execute(
                "INSERT OR IGNORE INTO habit_days (habit, day, count, status) VALUES (?1, ?2, 0, 'open')",
                rusqlite::params![rel, today],
            ).map_err(|e| e.to_string())?;
            let (today_count, status): (i64, String) = sched.query_row(
                "SELECT count, status FROM habit_days WHERE habit = ?1 AND day = ?2",
                rusqlite::params![rel, today],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ).map_err(|e| e.to_string())?;
            habits.push(HabitCard {
                path: rel,
                title: habit.title,
                htype: match habit.htype {
                    format::HabitType::Max => "max".into(),
                    format::HabitType::Min => "min".into(),
                },
                limit: habit.count as i64,
                today_count,
                status,
                audio: container_audio(&[], &[&habit.success, &habit.failure]),
            });
        }

        // Tasks. Open instances only; template audio refs are parsed once
        // per template file so each card can offer prerender. Keyed by the
        // resolved template path (templates may be bare names or full
        // `tasks/…md` paths — see `template_to_path`).
        let mut template_audio: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        for (rel, content) in list_v2_files(&agent_dir, "tasks", ".md") {
            if let Some(t) = format::parse_task(&content).0 {
                template_audio.insert(
                    rel,
                    container_audio(&t.pages, &[&t.success, &t.failure]),
                );
            }
        }
        let tasks = {
            let mut stmt = sched.prepare(
                "SELECT iid, title, template, deadline, status FROM task_instances \
                 WHERE status IN ('assigned', 'in_progress') ORDER BY assigned",
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |r| {
                let template: String = r.get(2)?;
                Ok(TaskCard {
                    iid: r.get(0)?,
                    title: r.get(1)?,
                    audio: template_audio
                        .get(&format::template_to_path(&template))
                        .cloned()
                        .unwrap_or_default(),
                    template,
                    deadline: r.get(3)?,
                    status: r.get(4)?,
                })
            }).map_err(|e| e.to_string())?;
            rows.filter_map(Result::ok).collect()
        };

        // Store.
        let mut store = Vec::new();
        for (rel, content) in list_v2_files(&agent_dir, "store", ".json") {
            let Some(entry) = format::parse_store_entry(&content).0 else {
                continue;
            };
            let stock = match entry.stock {
                Some(initial) => economy::stock_for(&econ, &rel, initial, entry.restock.as_deref())?,
                None => None,
            };
            let title = entry.title.clone().unwrap_or_else(|| rel.clone());
            store.push(StoreCard {
                path: rel,
                title,
                description: entry.description,
                price: entry.price,
                stock,
                audio: container_audio(&[], &[&entry.actions]),
            });
        }

        // Timeline: every routine occurrence whose window overlaps today's
        // local day (completed/lapsed history included — the timetable shows
        // the whole day, not just what's still open). Ad-hoc on-demand starts
        // ride along, flagged so the UI renders them as activity markers.
        let timeline = {
            use chrono::TimeZone;
            let day = chrono::NaiveDate::parse_from_str(&today, "%Y-%m-%d").ok();
            let (day_start, day_end) = day
                .map(|d| {
                    let s = chrono::Local
                        .from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap())
                        .single()
                        .map(|s| s.with_timezone(&chrono::Utc))
                        .unwrap_or_else(utc_now);
                    (s, s + chrono::Duration::days(1))
                })
                .unwrap_or((now - chrono::Duration::hours(12), now + chrono::Duration::hours(12)));
            let mut items: Vec<TimelineItem> = Vec::new();
            if let Ok(mut stmt) = sched.prepare(
                "SELECT container, due, window_end, status, id FROM occurrences \
                 WHERE kind = 'routine' AND due < ?1 AND window_end > ?2 \
                 ORDER BY due ASC, container ASC",
            ) {
                let rows = stmt.query_map(
                    rusqlite::params![ts(day_end), ts(day_start)],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, String>(4)?,
                        ))
                    },
                );
                if let Ok(rows) = rows {
                    for (container, due, window_end, status, id) in rows.flatten() {
                        let title = titles
                            .get(&container)
                            .cloned()
                            .unwrap_or_else(|| container.clone());
                        let adhoc = id.contains(":adhoc:");
                        items.push(TimelineItem {
                            container,
                            title,
                            occurrence: id,
                            due,
                            window_end,
                            status,
                            adhoc,
                        });
                    }
                }
            }
            items
        };

        Ok(V2Summary {
            balance: economy::balance(&econ)?,
            exemptions: economy::active_exemptions(&econ)?,
            pending: economy::list_pending(&econ)?,
            ledger: economy::recent_ledger(&econ, 10)?,
            routines,
            habits,
            tasks,
            store,
            timeline,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============================================================================
// Reconcile command + startup hook
// ============================================================================

#[tauri::command]
pub async fn reconcile_schedule(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ReconcileReport, String> {
    let agent_dir = state.agent_dir.clone();
    let state_dir = state.state_dir.clone();
    let app_for_blocking = app.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        reconcile_blocking(&agent_dir, &state_dir, Some(&app_for_blocking))
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = app.emit("v2-reconciled", &report);
    Ok(report)
}

/// Fire-and-forget reconcile for app startup (never blocks setup).
pub fn spawn_reconcile(app: tauri::AppHandle) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let agent_dir = state.agent_dir.clone();
        let state_dir = state.state_dir.clone();
        let app_for_blocking = app.clone();
        let report = tauri::async_runtime::spawn_blocking(move || {
            reconcile_blocking(&agent_dir, &state_dir, Some(&app_for_blocking))
        })
        .await;
        if let Ok(report) = report {
            let _ = app.emit("v2-reconciled", &report);
        }
    });
}

// ============================================================================
// parse_v2_file (typed parse for the frontend)
// ============================================================================

#[derive(Serialize)]
pub struct DiagOut {
    pub severity: String,
    pub message: String,
    pub line: Option<usize>,
}

#[derive(Serialize)]
pub struct ParsedV2File {
    pub kind: String,
    pub diags: Vec<DiagOut>,
    pub routine: Option<format::Routine>,
    pub habit: Option<format::Habit>,
    pub task: Option<format::TaskTemplate>,
    pub store: Option<format::StoreEntry>,
}

#[tauri::command]
pub fn parse_v2_file(path: String, state: State<'_, AppState>) -> Result<ParsedV2File, String> {
    let full = crate::bash::resolve_under(&state.agent_dir, &path)?;
    let content = std::fs::read_to_string(&full).map_err(|e| e.to_string())?;
    let to_out = |diags: Vec<format::Diag>| {
        diags
            .into_iter()
            .map(|d| DiagOut {
                severity: match d.severity {
                    format::Severity::Error => "error".into(),
                    format::Severity::Warning => "warning".into(),
                },
                message: d.message,
                line: d.line,
            })
            .collect()
    };
    let head = path.split('/').next().unwrap_or_default();
    match head {
        "routines" => {
            let (routine, diags) = format::parse_routine(&content);
            Ok(ParsedV2File {
                kind: "routine".into(),
                diags: to_out(diags),
                routine,
                habit: None,
                task: None,
                store: None,
            })
        }
        "habits" => {
            let (habit, diags) = format::parse_habit(&content);
            Ok(ParsedV2File {
                kind: "habit".into(),
                diags: to_out(diags),
                routine: None,
                habit,
                task: None,
                store: None,
            })
        }
        "tasks" => {
            let (task, diags) = format::parse_task(&content);
            Ok(ParsedV2File {
                kind: "task".into(),
                diags: to_out(diags),
                routine: None,
                habit: None,
                task,
                store: None,
            })
        }
        "store" => {
            let (store, diags) = format::parse_store_entry(&content);
            Ok(ParsedV2File {
                kind: "store".into(),
                diags: to_out(diags),
                routine: None,
                habit: None,
                task: None,
                store,
            })
        }
        other => Err(format!(
            "`{other}` is not a v2 container directory (routines/, habits/, tasks/, store/)"
        )),
    }
}


// ============================================================================
// Upcoming reminders (drives OS notifications from the frontend)
// ============================================================================

#[derive(Serialize, Clone, Debug)]
pub struct UpcomingRun {
    pub occurrence: String,
    pub title: String,
    pub due: String,
}

/// Pending occurrences ordered by due time (for the reminder scheduler —
/// the frontend turns these into OS notifications, mirroring the v1
/// routine notifier).
#[tauri::command]
pub async fn v2_upcoming(state: State<'_, AppState>) -> Result<Vec<UpcomingRun>, String> {
    let agent_dir = state.agent_dir.clone();
    let state_dir = state.state_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sched = open(&state_dir.join("schedule.db"))?;
        let now_s = economy::now_ts();
        let rows: Vec<(String, String)> = sched
            .prepare(
                "SELECT id, container FROM occurrences                  WHERE status = 'pending' AND due > ?1 ORDER BY due ASC LIMIT 30",
            )
            .and_then(|mut stmt| {
                let rows = stmt.query_map(rusqlite::params![now_s], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?;
                Ok(rows.filter_map(Result::ok).collect())
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for (occurrence, container) in rows {
            // Best-effort title from the routine file.
            let title = std::fs::read_to_string(agent_dir.join(&container))
                .ok()
                .and_then(|content| format::parse_routine(&content).0.map(|r| r.title))
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| container.clone());
            let due: String = occurrence.rsplit(':').next().map(String::from).unwrap_or_default();
            out.push(UpcomingRun {
                occurrence,
                title,
                due,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============================================================================
// Unit tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn env(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let agent = tmp.path().join("agent_data");
        let state = tmp.path().join("state");
        for (rel, content) in files {
            let p = agent.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, content).unwrap();
        }
        ensure_schema(&state.join("schedule.db")).expect("schedule schema");
        economy::ensure_schema(&state.join("economy.db")).expect("economy schema");
        (tmp, agent, state)
    }

    fn habit() -> String {
        "---\ntitle: No X\ntype: max\ncount: 0\nsuccess: { \"type\": \"points\", \"delta\": 5 }\nfailure: { \"type\": \"points\", \"delta\": -10 }\n---\npositive case\n".to_string()
    }

    #[test]
    fn reconcile_materializes_and_lapses_routines() {
        // Schedule: every minute, 1-minute window → guarantees a lapsed
        // pending occurrence within the lookback window.
        let routine = "---\nformat: 2\ntitle: Drill\nschedule: * * * * *\ntimeframe: 1m\n\
                       success: { \"type\": \"points\", \"delta\": 15 }\n\
                       failure: { \"type\": \"points\", \"delta\": -5 }\n---\nintro\n";
        let (tmp, agent, state) = env(&[("routines/drill.md", routine)]);
        // Pretend the routine has existed for two days (same content hash),
        // so the lookback materializes the missed fires of the past day.
        {
            let sched = open(&state.join("schedule.db")).unwrap();
            sched
                .execute(
                    "INSERT INTO containers (container, hash, first_seen) VALUES (?1, ?2, ?3)",
                    rusqlite::params![
                        "routines/drill.md",
                        crate::manifest::hash_bytes(routine.as_bytes()),
                        ts(utc_now() - chrono::Duration::days(2))
                    ],
                )
                .unwrap();
        }
        let report = reconcile_blocking(&agent, &state, None);
        assert!(report.materialized > 0, "materialized: {:?}", report);
        assert!(report.lapsed > 0, "lapsed: {:?}", report);
        // Failure fired exactly -5 points (all older windows lapsed once;
        // the ledger dedupes by source, and the near-term occurrence is
        // still pending or in-window).
        let econ = open(&state.join("economy.db")).unwrap();
        assert!(economy::balance(&econ).unwrap() <= 0, "failure points applied");
        drop(econ);
        // Reconcile again — idempotent (no double penalties). Close the
        // remaining pending occurrences first so a minute-boundary
        // rollover between the two runs can't lapse anything new (which
        // would make this test flaky near the top of a minute).
        let bal_after_first = {
            let econ = open(&state.join("economy.db")).unwrap();
            economy::balance(&econ).unwrap()
        };
        {
            let sched = open(&state.join("schedule.db")).unwrap();
            sched
                .execute("UPDATE occurrences SET status = 'completed' WHERE status = 'pending'", [])
                .unwrap();
        }
        let report2 = reconcile_blocking(&agent, &state, None);
        let econ = open(&state.join("economy.db")).unwrap();
        assert_eq!(economy::balance(&econ).unwrap(), bal_after_first, "second reconcile changed balance: {report2:?}");
        let _ = tmp;
    }

    #[test]
    fn new_routine_is_not_failed_retroactively() {
        // A routine the agent just wrote must not be punished for windows
        // that closed before the file existed — its first occurrence is
        // the next scheduled fire, not the missed past ones.
        let routine = "---\nformat: 2\ntitle: Drill\nschedule: * * * * *\ntimeframe: 1m\n\
                       failure: { \"type\": \"points\", \"delta\": -5 }\n---\nintro\n";
        let (tmp, agent, state) = env(&[("routines/drill.md", routine)]);
        let report = reconcile_blocking(&agent, &state, None);
        assert!(report.materialized > 0, "future fires materialized: {report:?}");
        assert_eq!(report.lapsed, 0, "no retro-failures for a new routine: {report:?}");
        let econ = open(&state.join("economy.db")).unwrap();
        assert_eq!(economy::balance(&econ).unwrap(), 0, "no failure points fired");
        let _ = tmp;
    }

    #[test]
    fn edited_routine_reschedules_without_retro_failures() {
        // Re-writing a routine (here: tightening the schedule) counts as
        // new content — the past of the NEW schedule is not punished either.
        let v1 = "---\nformat: 2\ntitle: Drill\nschedule: 0 6 * * *\n---\nintro\n";
        let (tmp, agent, state) = env(&[("routines/drill.md", v1)]);
        reconcile_blocking(&agent, &state, None);
        let v2 = "---\nformat: 2\ntitle: Drill\nschedule: * * * * *\ntimeframe: 1m\n\
                  failure: { \"type\": \"points\", \"delta\": -5 }\n---\nintro\n";
        std::fs::write(agent.join("routines/drill.md"), v2).unwrap();
        let report = reconcile_blocking(&agent, &state, None);
        assert_eq!(report.lapsed, 0, "edit must not retro-fail: {report:?}");
        let econ = open(&state.join("economy.db")).unwrap();
        assert_eq!(economy::balance(&econ).unwrap(), 0);
        let _ = tmp;
    }

    #[test]
    fn habit_max_breach_fires_failure_immediately() {
        let (tmp, agent, state) = env(&[("habits/nox.md", &habit())]);
        // Insert an open row for TODAY as if logged once already.
        let sched = open(&state.join("schedule.db")).unwrap();
        let today = local_day(utc_now());
        sched
            .execute(
                "INSERT INTO habit_days (habit, day, count, status) VALUES ('habits/nox.md', ?1, 0, 'open')",
                [&today],
            )
            .unwrap();
        drop(sched);
        let report = reconcile_blocking(&agent, &state, None);
        assert_eq!(report.habit_days_evaluated, 0, "today not evaluated");
        let econ = open(&state.join("economy.db")).unwrap();
        assert_eq!(economy::balance(&econ).unwrap(), 0);
        let _ = tmp;
    }

    #[test]
    fn habit_past_day_evaluates_max_under_limit_success() {
        let (tmp, agent, state) = env(&[("habits/nox.md", &habit())]);
        let sched = open(&state.join("schedule.db")).unwrap();
        let yesterday = local_day(utc_now() - chrono::Duration::days(1));
        sched
            .execute(
                "INSERT INTO habit_days (habit, day, count, status) VALUES ('habits/nox.md', ?1, 0, 'open')",
                [&yesterday],
            )
            .unwrap();
        drop(sched);
        let report = reconcile_blocking(&agent, &state, None);
        assert!(report.habit_days_evaluated >= 1);
        let econ = open(&state.join("economy.db")).unwrap();
        assert_eq!(economy::balance(&econ).unwrap(), 5, "success fired once");
        // Idempotent on re-reconcile.
        reconcile_blocking(&agent, &state, None);
        let econ = open(&state.join("economy.db")).unwrap();
        assert_eq!(economy::balance(&econ).unwrap(), 5);
        let _ = tmp;
    }

    #[test]
    fn task_timeout_escalates_then_fails() {
        let task = "---\ntitle: Check\n\
                    timeouts: [{ \"after\": \"1s\", \"action\": { \"type\": \"points\", \"delta\": -5 } }]\n\
                    max_timeout: 1m\n\
                    success: { \"type\": \"points\", \"delta\": 10 }\n\
                    failure: { \"type\": \"points\", \"delta\": -20 }\n---\nbody\n";
        let (tmp, agent, state) = env(&[("tasks/check.md", task)]);
        let sched = open(&state.join("schedule.db")).unwrap();
        let assigned = ts(utc_now() - chrono::Duration::minutes(5));
        sched
            .execute(
                "INSERT INTO task_instances (iid, template, title, assigned, deadline, max_timeout, timeouts_json) \
                 VALUES ('task:check:t1', 'check', 'Check', ?1, ?1, ?1, \
                 '[{\"after_secs\":1,\"actions\":[{\"type\":\"points\",\"delta\":-5}]}]')",
                [&assigned],
            )
            .unwrap();
        drop(sched);
        let report = reconcile_blocking(&agent, &state, None);
        assert_eq!(report.tasks_failed, 1);
        let econ = open(&state.join("economy.db")).unwrap();
        // Timeout -5 AND failure -20 both fired.
        assert_eq!(economy::balance(&econ).unwrap(), -25);
        // Idempotent.
        reconcile_blocking(&agent, &state, None);
        let econ = open(&state.join("economy.db")).unwrap();
        assert_eq!(economy::balance(&econ).unwrap(), -25);
        let _ = tmp;
    }

    #[test]
    fn exemption_suppresses_failure_but_not_success() {
        let (tmp, agent, state) = env(&[("habits/nox.md", &habit())]);
        let econ = open(&state.join("economy.db")).unwrap();
        economy::grant_exemption(
            &econ,
            "habits",
            &economy::ts_at(utc_now() + chrono::Duration::hours(1)),
        )
        .unwrap();
        drop(econ);
        let sched = open(&state.join("schedule.db")).unwrap();
        let yesterday = local_day(utc_now() - chrono::Duration::days(1));
        // count 3 over limit 0 → would fail without exemption.
        sched
            .execute(
                "INSERT INTO habit_days (habit, day, count, status) VALUES ('habits/nox.md', ?1, 3, 'open')",
                [&yesterday],
            )
            .unwrap();
        drop(sched);
        let report = reconcile_blocking(&agent, &state, None);
        assert!(report.lines.iter().any(|l| l.contains("exempt")));
        let econ = open(&state.join("economy.db")).unwrap();
        assert_eq!(economy::balance(&econ).unwrap(), 0, "failure suppressed");
        let _ = tmp;
    }
}
