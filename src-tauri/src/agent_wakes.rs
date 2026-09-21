//! Scheduled agent wake-ups (Stage 5b): cron-driven agent turns that fire
//! even from a cold (not-running) app on Android.
//!
//! A JSON config at `<agent_dir>/agent_wakes.json` — an array of
//! `{ "cron": "<cron string>", "message": "<wake instruction>" }` objects —
//! causes the agent to be woken at those times. The pipeline:
//!
//!   1. `reschedule` (called from setup, after every reconcile pass, and when
//!      a run settles — the agent can edit its own config mid-run) reads the
//!      config, computes each entry's next fire, and dispatches ONE
//!      `AlarmManager.setExactAndAllowWhileIdle` alarm per entry through the
//!      Kotlin `AgentWakeScheduler` statics (via the webview JNI hop, same
//!      technique as `agent_service`). Request codes are entry indexes, so a
//!      reschedule overwrites prior PendingIntents and stale indexes are
//!      cancelled. Empty/absent config cancels every known code.
//!   2. When an alarm fires, the `WakeReceiver` broadcasts into
//!      `AgentService` (a foreground-service start — exact alarms and
//!      BOOT_COMPLETED are documented background-start exemptions), which
//!      promotes to foreground FIRST and then calls the native
//!      [`Java_com_sylm54_train_AgentService_agentWake`] on a worker thread.
//!   3. The native entry rate-caps globally at
//!      [`MAX_FIRES_PER_24H`] fires per rolling 24 h (ledger persisted at
//!      `<data_dir>/agent_wake_ledger.json`, so process death cannot reset
//!      it), then either routes through the live runtime (app process alive:
//!      `enqueue_seed("cron", …)` + a bounded wait for the seeded run) or
//!      builds a headless runtime (cold start: no Tauri app, no webview) and
//!      runs the seed turn to completion there. The result JSON tells Kotlin
//!      whether to post a completion notification and whether to stop the
//!      service (`stillActive == false` AND the service was not pinned by the
//!      live runtime).
//!
//! Path equivalence (cold start): the Kotlin payload carries
//! `context.dataDir.absolutePath` — NOT `filesDir`. Verified against
//! tauri-2.11.2 sources: `PathResolver::app_data_dir` on Android routes
//! through the mobile plugin's `getDataDir` command
//! (`tauri-2.11.2/src/path/android.rs:137`), which returns
//! `activity.dataDir.absolutePath`
//! (`.../mobile/android/.../PathPlugin.kt:64-70`). `Context.getFilesDir()` is
//! `dataDir/files` — one level deeper — so the cold path derives
//! `data_dir = dataDir`, `agent_dir = dataDir/agent_data`, EXACTLY the
//! relative layout `lib.rs::setup` builds (`agent_dir = data_dir.join
//! ("agent_data")`, and settings.json / chats/ / the wake ledger all hang off
//! `data_dir` the same way).
//!
//! JNI binding note (the #1 failure mode here): the native entry points are
//! declared as PLAIN INSTANCE `external fun`s on `AgentService` (NOT on its
//! companion). A companion `external fun` without `@JvmStatic` declares the
//! native method on the `Companion` class (symbol
//! `…AgentService_Companion_agentWake`), which would never link. The instance
//! form generates exactly `Java_com_sylm54_train_AgentService_agentWake` /
//! `_agentReschedule` — the same names for static or instance placement — and
//! arg 2 arrives as the service instance (a `Context`, which the cold
//! reschedule needs for `AlarmManager`). The Rust side declares it `JObject`
//! and treats it as opaque.
//!
//! Every exported symbol is wrapped in `catch_unwind` and always returns
//! valid JSON — a panic or JNI hiccup degrades to a `skipped` result, never a
//! process crash. On non-Android targets everything JNI-shaped is compiled
//! out; desktop builds/tests exercise the pure logic only.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

/// Where the wake config lives: `<agent_dir>/agent_wakes.json` (inside the
/// agent sandbox, so the agent can edit its own wake schedule with
/// `write_file`).
pub const CONFIG_FILE: &str = "agent_wakes.json";

/// Where the rate-cap ledger lives: `<data_dir>/agent_wake_ledger.json`
/// (OUTSIDE the sandbox — a runaway agent must not be able to erase its own
/// rate cap; `data_dir` is one level above `agent_data/` and not writable
/// through the sandbox-relative file tools).
pub const LEDGER_FILE: &str = "agent_wake_ledger.json";

/// Global cap: at most this many agent wakes per rolling 24 h, so a
/// self-edited config (`* * * * *` every minute) cannot burn API credits all
/// night. Checked BEFORE any agent work; fires are recorded BEFORE the run
/// starts, so a crash mid-run still counts (conservative).
pub const MAX_FIRES_PER_24H: usize = 2;

/// Rolling window for the rate cap, in ms.
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Request-code space shared with `AgentWakeScheduler.MAX_REQUEST_CODES`
/// (Kotlin). Keep the two in sync: `reschedule` cancels every code from
/// `entries.len()` up to this bound, so stale alarms from a previously larger
/// config die on the next reschedule.
pub const MAX_WAKE_ENTRIES: usize = 32;

/// Hard bound on how long the JNI wake thread waits for the seeded run to
/// settle. Generous on purpose (wakes may run long tool loops); on timeout
/// the result reports `stillActive: true` so Kotlin keeps the service pinned
/// and the run finishes unobserved.
pub const WAKE_WAIT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Origin tag on seeded wake runs (`enqueue_seed(origin)`), stored in the
/// seed message's metadata so cron turns are distinguishable in the chat
/// index from `debug` and `agent-action` wakes.
pub const WAKE_ORIGIN: &str = "cron";

// ============================================================================
// Config schema + parsing
// ============================================================================

/// One on-disk config entry (the JSON the agent writes).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WakeEntry {
    /// Cron string. 5-field classic crons are normalized the same way the
    /// schedule engine's are (`validators::normalize_cron`), so
    /// `"30 8 * * *"` means 08:30 local — same dialect everywhere.
    pub cron: String,
    /// The wake instruction seeded into the working chat.
    pub message: String,
}

/// A config entry that passed validation, with its next fire time.
#[derive(Serialize, Clone, Debug)]
pub struct ParsedWake {
    pub cron: String,
    pub message: String,
    /// Next fire after "now" (epoch ms), or `None` when the schedule has no
    /// future fire (nothing gets scheduled for the entry).
    #[serde(rename = "nextFireMs", skip_serializing_if = "Option::is_none")]
    pub next_fire_ms: Option<i64>,
}

/// Compute the entry's next fire after `now` (epoch ms). Cron strings are
/// normalized through the same `normalize_cron` the schedule engine uses so
/// 5-field classic crons behave identically in both subsystems.
fn next_fire_after(cron_expr: &str, now_ms: i64) -> Result<i64, String> {
    use std::str::FromStr;
    let normalized = crate::validators::normalize_cron(cron_expr);
    let schedule =
        cron::Schedule::from_str(&normalized).map_err(|e| format!("cron {cron_expr:?}: {e}"))?;
    let now = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms)
        .ok_or_else(|| format!("bad now timestamp {now_ms}"))?;
    schedule
        .after(&now)
        .next()
        .map(|dt| dt.timestamp_millis())
        .ok_or_else(|| format!("cron {cron_expr:?} has no future fire"))
}

/// Read + validate the wake config. Invalid entries (unparsable cron, empty
/// message) are SKIPPED — with a warn log and an entry in the returned error
/// list so the settings UI can show them — never fatal: a half-broken config
/// still schedules its good entries. A missing file is an empty config.
pub fn load_config(agent_dir: &Path) -> (Vec<ParsedWake>, Vec<String>) {
    let path = agent_dir.join(CONFIG_FILE);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return (Vec::new(), Vec::new());
        }
        Err(e) => {
            log::warn!("agent_wakes: could not read {}: {e}", path.display());
            return (Vec::new(), vec![format!("read {}: {e}", path.display())]);
        }
    };
    let now = chrono::Utc::now().timestamp_millis();
    parse_config_str(&raw, now)
}

/// Validate a config's JSON text against a fixed "now" (unit-testable core
/// of [`load_config`]).
fn parse_config_str(raw: &str, now_ms: i64) -> (Vec<ParsedWake>, Vec<String>) {
    let entries: Vec<WakeEntry> = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => return (Vec::new(), vec![format!("config unparsable: {e}")]),
    };
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for (i, entry) in entries.into_iter().enumerate() {
        if entry.message.trim().is_empty() {
            errors.push(format!("entry {i}: message is empty"));
            continue;
        }
        match next_fire_after(&entry.cron, now_ms) {
            Ok(next) => out.push(ParsedWake {
                cron: entry.cron,
                message: entry.message,
                next_fire_ms: Some(next),
            }),
            Err(e) => {
                log::warn!("agent_wakes: skipping entry {i}: {e}");
                errors.push(format!("entry {i}: {e}"));
            }
        }
    }
    (out, errors)
}

// ============================================================================
// Rate-cap ledger
// ============================================================================

/// Load the fire ledger (epoch-ms timestamps). A missing file is an empty
/// ledger; an unparsable one is treated as empty (the cap fails OPEN only in
/// the sense that history resets — the per-fire append still re-persists it).
fn load_ledger(data_dir: &Path) -> Result<Vec<i64>, String> {
    let path = data_dir.join(LEDGER_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw)
            .map_err(|e| format!("ledger unparsable: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
/// Persist the ledger (compact JSON array of epoch-ms timestamps).
fn save_ledger(data_dir: &Path, ledger: &[i64]) -> Result<(), String> {
    let path = data_dir.join(LEDGER_FILE);
    let json = serde_json::to_string(ledger).map_err(|e| format!("ledger serialize: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Prune entries older than the rolling window.
fn prune_ledger(mut ledger: Vec<i64>, now_ms: i64) -> Vec<i64> {
    ledger.retain(|t| now_ms - *t < DAY_MS);
    ledger
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
/// Whether a fire is allowed under the rolling 24 h cap. Prunes expired
/// entries (and persists the prune) as a side effect — the "prune on each
/// check" contract. Errors are conservative: if the ledger cannot be
/// read/written the cap's enforceability is in doubt, so the wake is skipped.
fn fire_allowed(data_dir: &Path, now_ms: i64) -> Result<bool, String> {
    let ledger = prune_ledger(load_ledger(data_dir)?, now_ms);
    save_ledger(data_dir, &ledger)?;
    Ok(ledger.len() < MAX_FIRES_PER_24H)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
/// Record an actual fire (prune + append + persist). Called right before the
/// wake run starts, so a crash mid-run still consumed a cap slot.
fn record_fire(data_dir: &Path, now_ms: i64) -> Result<(), String> {
    let mut ledger = prune_ledger(load_ledger(data_dir)?, now_ms);
    ledger.push(now_ms);
    save_ledger(data_dir, &ledger)
}

/// Recent fires (newest last), for the settings UI. Best-effort.
fn recent_fires(data_dir: &Path, now_ms: i64) -> Vec<i64> {
    prune_ledger(load_ledger(data_dir).unwrap_or_default(), now_ms)
}

// ============================================================================
// Path derivation (cold start)
// ============================================================================

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
/// `agent_dir` for a known `data_dir` — the same relative layout
/// `lib.rs::setup` builds (`agent_dir = data_dir.join("agent_data")`).
pub(crate) fn agent_dir_of(data_dir: &Path) -> PathBuf {
    data_dir.join("agent_data")
}

// ============================================================================
// Reschedule (live runtime → Kotlin AlarmManager)
// ============================================================================

/// Read the wake config and (re)schedule every entry's next fire through the
/// Kotlin `AgentWakeScheduler` statics. Best-effort everywhere: config and
/// JNI failures are logged, never fatal to the caller (setup / reconcile /
/// run-settle paths must not break). Entries beyond the current config length
/// are cancelled by request code, so shrinking configs don't leave stale
/// alarms behind; an empty/absent config cancels everything.
pub fn reschedule(app: &tauri::AppHandle) {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let (schedule_list, entry_count) = {
            let Some(state) = app.try_state::<crate::AppState>() else {
                log::debug!("agent_wakes: AppState not managed yet; skipping reschedule");
                return;
            };
            let agent_dir = state.agent_dir.clone();
            drop(state);
            let (entries, errors) = load_config(&agent_dir);
            for e in &errors {
                log::warn!("agent_wakes: {e}");
            }
            let count = entries.len();
            let list = entries
                .into_iter()
                .enumerate()
                .filter_map(|(i, e)| e.next_fire_ms.map(|ms| (i as i32, ms, e.message)))
                .collect::<Vec<_>>();
            (list, count)
        };
        // The hop closure is 'static — it owns the schedule list. Fire-and-
        // forget: scheduling failures are logged inside the closure.
        crate::agent_service::exec_on_main(app, move |env, activity, _| {
            if let Err(e) =
                with_scheduler_class(env, activity, |env, activity, class| {
                    for (index, epoch_ms, message) in &schedule_list {
                        let jmsg = env.new_string(message)?;
                        let jtoken = env.new_string(&epoch_ms.to_string())?;
                        env.call_static_method(
                            class,
                            "scheduleNext",
                            "(Landroid/content/Context;IJLjava/lang/String;Ljava/lang/String;)V",
                            &[
                                activity.into(),
                                jni::objects::JValue::Int(*index),
                                jni::objects::JValue::Long(*epoch_ms),
                                (&jmsg).into(),
                                (&jtoken).into(),
                            ],
                        )?;
                    }
                    // Cancel everything above the live entry count (all codes
                    // for an empty config).
                    env.call_static_method(
                        class,
                        "cancelRange",
                        "(Landroid/content/Context;II)V",
                        &[
                            activity.into(),
                            jni::objects::JValue::Int(entry_count as i32),
                            jni::objects::JValue::Int(MAX_WAKE_ENTRIES as i32),
                        ],
                    )?;
                    Ok(())
                })
            {
                log::warn!("agent_wakes: reschedule dispatch failed: {e}");
            }
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
    }
}

// ============================================================================
// Tauri commands (Settings → Agent wake-ups)
// ============================================================================

/// Snapshot for the settings UI: the parsed config (with each entry's next
/// fire), validation errors, recent fires, and whether exact alarms may be
/// scheduled (false → offer the grant button).
#[tauri::command]
pub async fn agent_wakes_state(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let (agent_dir, data_dir) = {
        let state = app.state::<crate::AppState>();
        (state.agent_dir.clone(), state.data_dir.clone())
    };
    let (entries, errors) =
        tauri::async_runtime::spawn_blocking(move || load_config(&agent_dir))
            .await
            .map_err(|e| format!("config task: {e}"))?;
    let now = chrono::Utc::now().timestamp_millis();
    Ok(json!({
        "canScheduleExact": can_schedule_exact(&app),
        "entries": entries,
        "errors": errors,
        "recentFires": recent_fires(&data_dir, now),
        "maxFiresPer24h": MAX_FIRES_PER_24H,
    }))
}

/// Launch the system settings screen where the user can grant
/// SCHEDULE_EXACT_ALARM (Android 14+ requires the user to be in that screen;
/// the toggle cannot be granted programmatically). Fire-and-forget.
#[tauri::command]
pub fn request_exact_alarm_permission(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::agent_service::exec_on_main(&app, |env, activity, _| {
            if let Err(e) = with_scheduler_class(env, activity, |env, activity, class| {
                env.call_static_method(
                    class,
                    "requestExactPermission",
                    "(Landroid/content/Context;)V",
                    &[activity.into()],
                )?;
                Ok(())
            }) {
                log::warn!("agent_wakes: requestExactPermission failed: {e}");
            }
        });
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}

/// Whether exact alarms may currently be scheduled (JNI →
/// `AgentWakeScheduler.canScheduleExact`; always true off-Android). Blocks up
/// to ~2 s on the JNI hop, so callers run it off the main thread.
pub fn can_schedule_exact(app: &tauri::AppHandle) -> bool {
    #[cfg(target_os = "android")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        crate::agent_service::exec_on_main(app, move |env, activity, _| {
            let result = with_scheduler_class(env, activity, |env, activity, class| {
                Ok(env
                    .call_static_method(
                        class,
                        "canScheduleExact",
                        "(Landroid/content/Context;)Z",
                        &[activity.into()],
                    )?
                    .z()?)
            })
            .unwrap_or(false);
            let _ = tx.send(result);
        });
        rx.recv_timeout(Duration::from_secs(2)).unwrap_or(false)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        true
    }
}

// ============================================================================
// JNI: class lookup helpers (Android only)
// ============================================================================

#[cfg(target_os = "android")]
fn with_scheduler_class<T>(
    env: &mut jni::JNIEnv,
    activity: &jni::objects::JObject,
    f: impl FnOnce(
        &mut jni::JNIEnv,
        &jni::objects::JObject,
        &jni::objects::JClass,
    ) -> jni::errors::Result<T>,
) -> jni::errors::Result<T> {
    let name = env.new_string("com.sylm54.train.AgentWakeScheduler")?;
    let class: jni::objects::JClass = env
        .call_method(
            activity,
            "getAppClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&name).into()],
        )?
        .l()?
        .into();
    f(env, activity, &class)
}

// ============================================================================
// JNI: exported cold-start entry points (Android only)
// ============================================================================

/// Payload Kotlin passes to `agentWake`: the alarm's entry index, the wake
/// instruction snapshot, the scheduling token (the scheduled epoch —
/// informational), and the app's `dataDir` path so the cold path can derive
/// `data_dir`/`agent_dir` exactly as AppState does.
#[derive(Deserialize, Debug, Clone)]
pub struct WakePayload {
    #[serde(default = "default_index")]
    pub index: i64,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub token: String,
    #[serde(default, rename = "dataDirPath")]
    pub data_dir_path: String,
}

fn default_index() -> i64 {
    -1
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn panic_msg(p: Box<dyn std::any::Any + Send>) -> String {
    match p.downcast::<&'static str>() {
        Ok(s) => (*s).to_string(),
        Err(p) => match p.downcast::<String>() {
            Ok(s) => (*s).clone(),
            Err(_) => "unknown panic".to_string(),
        },
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn skipped_json(skipped: bool, reason: &str, still_active: bool) -> serde_json::Value {
    json!({ "skipped": skipped, "reason": reason, "stillActive": still_active })
}

/// `stillActive` for the LIVE-runtime path: other agent slots held (a user
/// turn or queued run owns the service pin). Cold path is always `false`.
#[cfg(target_os = "android")]
fn live_slot_active() -> bool {
    crate::agent::runtime_up() && crate::agent_service::holder_count() > 0
}

#[cfg(target_os = "android")]
mod android_jni {
    use super::*;
    use jni::objects::{JClass, JObject, JString};
    use jni::JNIEnv;
    use std::sync::OnceLock;

    /// Cached JavaVM from the first JNI entry, so later helper threads could
    /// `attach_current_thread` if a cross-thread hop is ever needed. The
    /// current design deliberately stays on the calling thread; this is
    /// future-proofing only.
    static JAVA_VM: OnceLock<jni::JavaVM> = OnceLock::new();

    fn cache_vm(env: &JNIEnv) {
        if let Ok(vm) = env.get_java_vm() {
            let _ = JAVA_VM.set(vm);
        }
    }

    /// Build the result JSON string on `env`. Falls back to a minimal error
    /// JSON, then to a NULL jstring (Kotlin treats null as a native failure —
    /// its own try/catch logs it) if even that fails (OOM).
    fn to_jstring(env: &mut JNIEnv, json: String) -> jni::sys::jstring {
        env.new_string(&json)
            .or_else(|_| env.new_string("{\"skipped\":true,\"reason\":\"result serialize failed\"}"))
            .map(|s| s.into_raw())
            .unwrap_or(std::ptr::null_mut())
    }

    /// Native agent wake. See the module docs for the full pipeline. Payload:
    /// `{"index": N, "message": "…", "token": "…", "dataDirPath": "…"}`
    /// Returns `{skipped: bool, reason?: string, stillActive: bool,
    /// summary?: string, ok?: bool, reschedule?: {...}}`.
    #[no_mangle]
    pub extern "system" fn Java_com_sylm54_train_AgentService_agentWake(
        mut env: JNIEnv,
        thiz: JObject,
        payload: JString,
    ) -> jni::sys::jstring {
        cache_vm(&env);
        let payload = match env.get_string(&payload) {
            Ok(s) => s.to_string_lossy().into_owned(),
            Err(e) => {
                return to_jstring(
                    &mut env,
                    skipped_json(true, &format!("payload read failed: {e}"), false).to_string(),
                )
            }
        };
        let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            agent_wake_impl(&mut env, &thiz, &payload)
        }))
        .unwrap_or_else(|p| {
            let msg = panic_msg(p);
            log::error!("agent_wakes: agentWake panicked: {msg}");
            skipped_json(true, &format!("agentWake panicked: {msg}"), false).to_string()
        });
        to_jstring(&mut env, out)
    }

    /// Native cold reschedule: load config from the derived agent_dir,
    /// compute next fires, schedule alarms via `AgentWakeScheduler` on this
    /// same thread (we already hold a JNIEnv — no wry hop needed). Payload is
    /// the raw `dataDir` path. Returns a summary JSON.
    #[no_mangle]
    pub extern "system" fn Java_com_sylm54_train_AgentService_agentReschedule(
        mut env: JNIEnv,
        thiz: JObject,
        data_dir: JString,
    ) -> jni::sys::jstring {
        cache_vm(&env);
        let data_dir = match env.get_string(&data_dir) {
            Ok(s) => s.to_string_lossy().into_owned(),
            Err(e) => {
                return to_jstring(
                    &mut env,
                    json!({ "error": format!("path read failed: {e}") }).to_string(),
                )
            }
        };
        let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            agent_reschedule_impl(&mut env, &thiz, &data_dir)
        }))
        .unwrap_or_else(|p| {
            let msg = panic_msg(p);
            log::error!("agent_wakes: agentReschedule panicked: {msg}");
            json!({ "error": format!("agentReschedule panicked: {msg}") }).to_string()
        });
        to_jstring(&mut env, out)
    }

    /// Resolve the `AgentWakeScheduler` class through the SERVICE INSTANCE's
    /// own class loader (`getClass → getClassLoader → loadClass`). In the
    /// cold process there is no activity to call `getAppClass` on, and plain
    /// `find_class` may resolve through the system loader; the defining
    /// class's loader is the reliable route.
    fn scheduler_class<'local>(
        env: &mut JNIEnv<'local>,
        thiz: &JObject,
    ) -> jni::errors::Result<JClass<'local>> {
        let class_obj = env.call_method(thiz, "getClass", "()Ljava/lang/Class;", &[])?.l()?;
        let loader = env
            .call_method(&class_obj, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
            .l()?;
        let name = env.new_string("com.sylm54.train.AgentWakeScheduler")?;
        let cls = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[(&name).into()],
            )?
            .l()?;
        Ok(cls.into())
    }

    /// The service instance (`thiz`) IS a Context — usable for AlarmManager.
    fn schedule_via_jni(
        env: &mut JNIEnv,
        thiz: &JObject,
        entries: &[ParsedWake],
    ) -> jni::errors::Result<(usize, usize)> {
        let class = scheduler_class(env, thiz)?;
        let mut scheduled = 0usize;
        for (i, entry) in entries.iter().enumerate() {
            let Some(next) = entry.next_fire_ms else { continue };
            let jmsg = env.new_string(&entry.message)?;
            let jtoken = env.new_string(&next.to_string())?;
            env.call_static_method(
                &class,
                "scheduleNext",
                "(Landroid/content/Context;IJLjava/lang/String;Ljava/lang/String;)V",
                &[
                    thiz.into(),
                    jni::objects::JValue::Int(i as i32),
                    jni::objects::JValue::Long(next),
                    (&jmsg).into(),
                    (&jtoken).into(),
                ],
            )?;
            scheduled += 1;
        }
        env.call_static_method(
            &class,
            "cancelRange",
            "(Landroid/content/Context;II)V",
            &[
                thiz.into(),
                jni::objects::JValue::Int(entries.len() as i32),
                jni::objects::JValue::Int(MAX_WAKE_ENTRIES as i32),
            ],
        )?;
        Ok((scheduled, entries.len()))
    }

    fn agent_reschedule_impl(env: &mut JNIEnv, thiz: &JObject, data_dir_path: &str) -> String {
        let data_dir = PathBuf::from(data_dir_path);
        let agent_dir = agent_dir_of(&data_dir);
        let (entries, errors) = load_config(&agent_dir);
        match schedule_via_jni(env, thiz, &entries) {
            Ok((scheduled, total)) => json!({
                "scheduled": scheduled,
                "entries": total,
                "errors": errors,
            })
            .to_string(),
            Err(e) => json!({ "scheduled": 0, "entries": entries.len(), "error": format!("{e}") })
                .to_string(),
        }
    }

    fn agent_wake_impl(env: &mut JNIEnv, thiz: &JObject, payload: &str) -> String {
        let payload: WakePayload = match serde_json::from_str(payload) {
            Ok(p) => p,
            Err(e) => {
                return skipped_json(true, &format!("payload unparsable: {e}"), false).to_string()
            }
        };
        let live = crate::agent::runtime_up();

        // Cold path path-derivation: data_dir comes from the payload's
        // dataDirPath (Context.getDataDir — see the module docs for the
        // verified equivalence with Tauri's app_data_dir). The live path
        // trusts its own managed state; the derived path is only a fallback
        // there.
        let derived = PathBuf::from(&payload.data_dir_path);
        let data_dir = if live {
            crate::agent::runtime()
                .ok()
                .map(|rt| rt.data_dir())
                .unwrap_or_else(|| derived.clone())
        } else {
            derived.clone()
        };
        let agent_dir = agent_dir_of(&data_dir);
        let now = chrono::Utc::now().timestamp_millis();

        // (1) Rate cap FIRST — before any agent work. Skips cost nothing.
        match fire_allowed(&data_dir, now) {
            Ok(false) => {
                log::info!("agent_wakes: capped ({} per 24h) — skipping", MAX_FIRES_PER_24H);
                return skipped_json(true, "rate-capped: max 2 agent wakes per rolling 24h", live_slot_active()).to_string();
            }
            Ok(true) => {}
            Err(e) => {
                log::warn!("agent_wakes: ledger error: {e}");
                return skipped_json(true, &format!("ledger error: {e}"), live_slot_active())
                    .to_string();
            }
        }

        // (2) Stale guard: the config may have dropped this entry since the
        // alarm was set. Not an actual fire — no ledger append, but do
        // re-reschedule so the stale alarm's request code gets rewritten.
        let (entries, _) = load_config(&agent_dir);
        if payload.index < 0 || payload.index as usize >= entries.len() {
            log::info!("agent_wakes: stale wake (index {} of {} entries)", payload.index, entries.len());
            let reschedule = cold_reschedule_best_effort(env, thiz, &agent_dir);
            let mut v = skipped_json(true, "stale wake: entry no longer in agent_wakes.json", live_slot_active());
            v["reschedule"] = reschedule;
            return v.to_string();
        }

        // (3) An actual fire: record BEFORE the run so a crash mid-run
        // cannot bypass the cap.
        if let Err(e) = record_fire(&data_dir, now) {
            log::warn!("agent_wakes: could not persist fire: {e}");
        }

        // (4) Route through the live runtime, or build a headless one.
        if live {
            live_wake(&payload)
        } else {
            cold_wake(env, thiz, &data_dir, &payload)
        }
    }

    /// Live-runtime wake: enqueue a seed turn and wait (bounded) for it to
    /// settle. `tauri::async_runtime::block_on` only parks THIS thread (the
    /// service's wake thread); the seeded run progresses on the global
    /// runtime. Never a deadlock: the completion signal is a oneshot
    /// (drop-safe, cancellation-safe) and the wait is bounded.
    fn live_wake(payload: &WakePayload) -> String {
        let rt = match crate::agent::runtime() {
            Ok(rt) => rt,
            Err(e) => return skipped_json(true, &format!("runtime: {e}"), false).to_string(),
        };
        let rx = tauri::async_runtime::block_on(rt.enqueue_seed(WAKE_ORIGIN, payload.message.clone()));
        let waited = tauri::async_runtime::block_on(async {
            tokio::time::timeout(WAKE_WAIT_TIMEOUT, rx).await
        });
        let still_active = crate::agent_service::holder_count() > 0;
        match waited {
            Ok(Ok(info)) => json!({
                "skipped": false,
                "stillActive": still_active,
                "ok": info.ok,
                "summary": summarize(&info),
            })
            .to_string(),
            Ok(Err(_)) => json!({
                "skipped": false,
                "stillActive": still_active,
                "ok": false,
                "summary": "wake run finished but its result record was lost",
            })
            .to_string(),
            Err(_) => json!({
                "skipped": false,
                "stillActive": true,
                "ok": false,
                "summary": "wake run still in progress after the 30m wait; service stays pinned",
            })
            .to_string(),
        }
    }

    /// Cold-start wake: no Tauri runtime exists in this process — build a
    /// headless runtime (chats store, settings, bash sandbox, prompts all
    /// work off plain paths) and run the seed turn to completion on the
    /// global async runtime, then re-reschedule (the agent may have edited
    /// its own wake config mid-run) via a direct JNI call on this thread.
    fn cold_wake(env: &mut JNIEnv, thiz: &JObject, data_dir: &Path, payload: &WakePayload) -> String {
        let rt = match crate::agent::runner::AgentRuntime::new_headless(data_dir.to_path_buf()) {
            Ok(rt) => std::sync::Arc::new(rt),
            Err(e) => {
                return skipped_json(true, &format!("headless runtime: {e}"), false).to_string()
            }
        };
        let rx = tauri::async_runtime::block_on(rt.enqueue_seed(WAKE_ORIGIN, payload.message.clone()));
        let waited = tauri::async_runtime::block_on(async {
            tokio::time::timeout(WAKE_WAIT_TIMEOUT, rx).await
        });
        let reschedule = cold_reschedule_best_effort(env, thiz, &agent_dir_of(data_dir));
        let mut result = match waited {
            Ok(Ok(info)) => json!({
                "skipped": false,
                "stillActive": false,
                "ok": info.ok,
                "summary": summarize(&info),
            }),
            Ok(Err(_)) => json!({
                "skipped": false,
                "stillActive": false,
                "ok": false,
                "summary": "wake run finished but its result record was lost",
            }),
            Err(_) => json!({
                "skipped": false,
                "stillActive": false,
                "ok": false,
                "summary": "wake run still in progress after the 30m wait (abandoned; service released)",
            }),
        };
        result["reschedule"] = reschedule;
        result.to_string()
    }

    /// Best-effort cold reschedule (errors folded into a JSON value, never
    /// fatal — the run already happened).
    fn cold_reschedule_best_effort(
        env: &mut JNIEnv,
        thiz: &JObject,
        agent_dir: &Path,
    ) -> serde_json::Value {
        let (entries, errors) = load_config(agent_dir);
        match schedule_via_jni(env, thiz, &entries) {
            Ok((scheduled, total)) => json!({ "scheduled": scheduled, "entries": total, "errors": errors }),
            Err(e) => json!({ "error": format!("{e}") }),
        }
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
/// Human-facing one-liner for a settled run (goes into the completion
/// notification).
fn summarize(info: &crate::agent::RunInfo) -> String {
    match (&info.error, info.aborted) {
        (Some(e), _) => format!("Wake run failed: {e}"),
        (_, true) => "Wake run was aborted".to_string(),
        _ => format!("Wake run finished ({} step{})", info.steps, if info.steps == 1 { "" } else { "s" }),
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tm-agent-wakes-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(cron: &str, message: &str) -> WakeEntry {
        WakeEntry { cron: cron.into(), message: message.into() }
    }

    #[test]
    fn payload_deserializes_with_defaults() {
        let p: WakePayload =
            serde_json::from_str(r#"{"index": 2, "message": "hi"}"#).unwrap();
        assert_eq!(p.index, 2);
        assert_eq!(p.token, "");
        assert_eq!(p.data_dir_path, "");
        let p: WakePayload = serde_json::from_str(
            r#"{"index":0,"message":"m","token":"1758000000000","dataDirPath":"/data/user/0/com.sylm54.train"}"#,
        )
        .unwrap();
        assert_eq!(p.index, 0);
        assert_eq!(p.token, "1758000000000");
        assert_eq!(p.data_dir_path, "/data/user/0/com.sylm54.train");
        // Missing index defaults to -1 (the stale-guard sentinel).
        let p: WakePayload = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(p.index, -1);
    }

    #[test]
    fn config_parses_valid_and_skips_invalid() {
        let now = chrono::Utc::now().timestamp_millis();
        let raw = serde_json::to_string(&vec![
            entry("30 8 * * *", "Morning check-in"),
            entry("not a cron", "broken"),
            entry("0 9 * * *", "   "),
            entry("*/5 * * * *", "Every five"),
        ])
        .unwrap();
        let (parsed, errors) = parse_config_str(&raw, now);
        assert_eq!(parsed.len(), 2, "valid entries survive: {parsed:?}");
        assert_eq!(parsed[0].message, "Morning check-in");
        assert_eq!(parsed[1].message, "Every five");
        assert!(parsed.iter().all(|p| p.next_fire_ms.is_some()));
        assert_eq!(errors.len(), 2, "bad cron + empty message reported: {errors:?}");
        assert!(errors[0].contains("entry 1"));
        assert!(errors[1].contains("entry 2"));
    }

    #[test]
    fn config_missing_file_is_empty_and_unparsable_is_error() {
        let dir = temp_dir("missing");
        let (parsed, errors) = load_config(&dir);
        assert!(parsed.is_empty() && errors.is_empty());

        std::fs::write(dir.join(CONFIG_FILE), r#"not json"#).unwrap();
        let (parsed, errors) = load_config(&dir);
        assert!(parsed.is_empty());
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("unparsable"));
    }

    #[test]
    fn next_fire_computation_normalizes_five_field_crons() {
        let now = chrono::Utc::now().timestamp_millis();
        // 5-field classic → same normalization the schedule engine applies.
        let next = next_fire_after("*/2 * * * *", now).unwrap();
        assert!(next > now, "next fire is in the future");
        // A 6-field (seconds-first) cron also parses.
        let next6 = next_fire_after("0 */3 * * * *", now).unwrap();
        assert!(next6 > now);
        assert!(next_fire_after("garbage", now).is_err());
        // Far past single-shot: no future fire.
        assert!(next_fire_after("0 0 1 1 2000", now).is_err());
    }

    #[test]
    fn ledger_caps_and_prunes() {
        let dir = temp_dir("ledger");
        let now = 1_000_000_000_000i64;
        assert!(fire_allowed(&dir, now).unwrap(), "empty ledger allows");
        record_fire(&dir, now).unwrap();
        record_fire(&dir, now + 1).unwrap();
        assert!(!fire_allowed(&dir, now + 2).unwrap(), "2 fires in window → capped");
        // Beyond the window the old entries prune and the cap reopens.
        assert!(fire_allowed(&dir, now + DAY_MS + 5).unwrap());
        // Recording the post-prune fire lands as the only entry.
        record_fire(&dir, now + DAY_MS + 5).unwrap();
        let ledger = load_ledger(&dir).unwrap();
        assert_eq!(ledger, vec![now + DAY_MS + 5]);
    }

    #[test]
    fn ledger_unparsable_is_conservative_error() {
        let dir = temp_dir("ledger-bad");
        std::fs::write(dir.join(LEDGER_FILE), "nope").unwrap();
        assert!(fire_allowed(&dir, 0).is_err(), "unreadable ledger blocks the wake");
    }

    #[test]
    fn agent_dir_layout_matches_app_state() {
        // The cold-start derivation contract: agent_dir is data_dir/agent_data,
        // exactly as lib.rs::setup builds it.
        let data = Path::new("/data/user/0/com.sylm54.train");
        assert_eq!(agent_dir_of(data), data.join("agent_data"));
    }
}
