//! Android foreground-service bridge for native agent turns.
//!
//! While an agent turn is in flight — or queued behind one — the Kotlin
//! `AgentService` foreground service (`gen/android/.../AgentService.kt`)
//! pins the process at foreground priority, so a turn that outlives the
//! activity (background seed, long tool loop while the user switches away)
//! survives cached-app freezing. Same deal as [`crate::render_service`]
//! for audio rendering. The service also owns the ongoing "Agent active"
//! notification (channel `agent`, id 7779 — pairing documented on the
//! consts below) whose body mirrors the turn's phase via `updateText`.
//!
//! Rust drives the service through static methods on the Kotlin class, run
//! over JNI on the wry main-pipe thread. The runner holds an `AppHandle`,
//! not a `Webview`, so the hop resolves the main window first
//! (`get_webview_window("main")` → `with_webview` →
//! `PlatformWebview::jni_handle().exec`, the public Tauri v2 route for
//! app-side JNI). When there is no main window — a headless seed run after
//! the activity is gone — the pin is skipped at debug; Stage 5b's
//! service-owned path covers that cold case. The class is looked up via
//! the activity's `getAppClass` (the app's PathClassLoader); plain
//! `find_class` only sees the system loader and would miss app classes.
//! Every call is best-effort: failures are logged and swallowed so a
//! notification or service hiccup can never fail a run. On non-Android
//! targets every entry point is a no-op.
//!
//! The runner acquires/releases slots instead of starting/stopping the
//! service directly: a background seed pins at ENQUEUE time (a queued wake
//! must not be lost to the freezer while it waits behind the FIFO turn
//! gate), interactive runs pin when their ticket frees and the run starts,
//! and every run releases when it settles — via the [`AgentHold`] guard,
//! so a panic mid-turn can't leak the pin. The first holder starts the
//! service; releasing the last slot stops it. The gate's direct handoff
//! means one run releasing while another starts just dips and raises the
//! count — the start/stop dispatches are cheap and idempotent (the Kotlin
//! side catches everything), so that's fine.

use std::sync::OnceLock;

use tauri::AppHandle;

#[cfg(target_os = "android")]
use {
    jni::objects::{JClass, JObject},
    jni::JNIEnv,
    std::sync::atomic::{AtomicUsize, Ordering},
    std::time::{Duration, Instant},
};

/// Number of in-flight agent slots (runs — including queued seeds — holding
/// the process at foreground priority). 0 → 1 starts the service, 1 → 0
/// stops it. Access only through [`acquire`]/[`release`] so the transitions
/// stay paired with their JNI dispatches.
#[cfg(target_os = "android")]
static HOLDERS: AtomicUsize = AtomicUsize::new(0);

#[cfg(target_os = "android")]
const SERVICE_CLASS: &str = "com.sylm54.train.AgentService";

/// The main window's webview — the JNI dispatch hop. `tauri.conf.json`
/// declares a single unnamed window, which gets Tauri's default label.
#[cfg(target_os = "android")]
const MAIN_WEBVIEW_LABEL: &str = "main";

/// Minimum gap between notification body updates. Phase flips are rare
/// (start / question / answer / end), so this only coalesces rapid
/// working-detail churn; see [`update_phase`] for the transition override.
#[cfg(target_os = "android")]
const NOTIF_THROTTLE: Duration = Duration::from_millis(400);

/// Last notification body we dispatched, as `(when, body, phase)`. The body
/// dedupes identical updates; the phase lets a semantic transition
/// (working ↔ waiting) through the throttle — a dropped "Waiting for your
/// answer" is never retried, so it must land.
#[cfg(target_os = "android")]
static LAST_SEND: parking_lot::Mutex<Option<(Instant, String, String)>> =
    parking_lot::Mutex::new(None);

/// Stable notification id. Must match `AgentService.NOTIF_ID` so Rust-driven
/// `updateText` posts and the service's own `startForeground` entry are the
/// SAME notification (RenderService owns 7777/7778; agent owns 7779). Never
/// consumed from Rust — the Kotlin service hardcodes the same value — kept
/// defined here so the pairing stays documented in one place.
#[allow(dead_code)]
pub const AGENT_NOTIF_ID: i32 = 7779;

/// Notification channel id. Must match `AgentService.CHANNEL_ID`; the
/// channel itself is created Kotlin-side (`ensureChannels`). Documented here
/// for the same one-place pairing as [`AGENT_NOTIF_ID`].
#[allow(dead_code)]
pub const CHANNEL_ID: &str = "agent";

/// The app handle [`update_phase`] dispatches through. Bound once from
/// Tauri setup ([`init`]) so tool/runner call sites stay thin (the phase
/// update deliberately takes no handle — see its doc).
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Bind the app handle used for JNI dispatch. Called once from Tauri setup,
/// before any run can start.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

/// Run `f` with the JNI env + activity on the wry main-pipe thread, hopping
/// through the main window's webview. The runner holds an `AppHandle`, not
/// a `Webview`, so resolve the config window first: `get_webview_window`
/// (the stable `Manager` route — `get_webview` is behind tauri's
/// `unstable` feature) hands back the window+webview combo whose
/// `with_webview` exposes `PlatformWebview::jni_handle().exec`, the public
/// Tauri v2 route for app-side JNI. No main window (headless seed run after
/// the activity is gone) → debug log and skip.
#[cfg(target_os = "android")]
fn exec_on_main<R, F>(app: &AppHandle<R>, f: F)
where
    R: tauri::Runtime,
    F: FnOnce(&mut JNIEnv, &JObject, &JObject) + Send + 'static,
{
    use tauri::Manager;
    let Some(ww) = app.get_webview_window(MAIN_WEBVIEW_LABEL) else {
        log::debug!("AgentService: no '{MAIN_WEBVIEW_LABEL}' window; skipping service pin");
        return;
    };
    let _ = ww.with_webview(move |platform| {
        platform.jni_handle().exec(f);
    });
}

/// Resolve the `AgentService` class through the activity's class loader and
/// hand it to `f` along with the env + activity (usable as the `Context`
/// argument of the static Kotlin helpers).
#[cfg(target_os = "android")]
fn with_service_class<T>(
    env: &mut JNIEnv,
    activity: &JObject,
    f: impl FnOnce(&mut JNIEnv, &JObject, &JClass) -> jni::errors::Result<T>,
) -> jni::errors::Result<T> {
    let name = env.new_string(SERVICE_CLASS)?;
    let class: JClass = env
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

/// Acquire one agent slot; the first holder starts the foreground service.
pub fn acquire<R: tauri::Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "android")]
    {
        if HOLDERS.fetch_add(1, Ordering::SeqCst) == 0 {
            exec_on_main(app, |env, activity, _| {
                if let Err(e) = with_service_class(env, activity, |env, activity, class| {
                    env.call_static_method(
                        class,
                        "start",
                        "(Landroid/content/Context;)V",
                        &[activity.into()],
                    )?;
                    Ok(())
                }) {
                    log::warn!("AgentService.start failed: {e}");
                }
            });
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
    }
}

/// Release one agent slot; releasing the last stops the service, which
/// removes the ongoing notification.
pub fn release<R: tauri::Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "android")]
    {
        if HOLDERS.fetch_sub(1, Ordering::SeqCst) == 1 {
            exec_on_main(app, |env, activity, _| {
                if let Err(e) = with_service_class(env, activity, |env, activity, class| {
                    env.call_static_method(
                        class,
                        "stop",
                        "(Landroid/content/Context;)V",
                        &[activity.into()],
                    )?;
                    Ok(())
                }) {
                    log::warn!("AgentService.stop failed: {e}");
                }
            });
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
    }
}

/// Update the ongoing notification's body from the run's phase. Best-effort,
/// deduped (identical bodies skip the JNI hop) and throttled to ~400 ms —
/// except a phase TRANSITION always lands, because a dropped
/// "Waiting for your answer" is never retried. Phase → body mapping:
///
/// - `running`            → `detail`, or "Working…"
/// - `waiting-for-answer` → "Waiting for your answer"
/// - `finished` / `idle`  → nothing: release stops the service, which
///   removes the whole entry — a body update would be cancelled by the stop
///   (or fight it in the handoff dip), so the runner's terminal phase call
///   is deliberately a no-op.
pub fn update_phase(phase: &str, detail: Option<&str>) {
    #[cfg(target_os = "android")]
    {
        let body = match phase {
            "running" => detail.unwrap_or("Working…").to_string(),
            "waiting-for-answer" => "Waiting for your answer".to_string(),
            _ => return,
        };
        let Some(app) = APP.get() else {
            log::debug!("AgentService.updateText before init; skipping");
            return;
        };
        {
            let mut last = LAST_SEND.lock();
            if last.as_ref().map(|(_, b, _)| b.as_str()) == Some(body.as_str()) {
                return;
            }
            let transition = last.as_ref().map(|(_, _, p)| p.as_str()) != Some(phase);
            let due = last
                .as_ref()
                .map(|(t, _, _)| Instant::now().duration_since(*t) >= NOTIF_THROTTLE)
                .unwrap_or(true);
            if !due && !transition {
                return;
            }
            *last = Some((Instant::now(), body.clone(), phase.to_string()));
        }
        exec_on_main(app, move |env, activity, _| {
            if let Err(e) = with_service_class(env, activity, |env, activity, class| {
                let jbody = env.new_string(body.as_str())?;
                env.call_static_method(
                    class,
                    "updateText",
                    "(Landroid/content/Context;Ljava/lang/String;)V",
                    &[activity.into(), (&jbody).into()],
                )?;
                Ok(())
            }) {
                log::debug!("AgentService.updateText failed: {e}");
            }
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (phase, detail);
    }
}

/// RAII agent slot: [`AgentHold::hold`] acquires (the first holder starts
/// the service), drop releases (the last stops it). The runner holds one per
/// run — moved into the spawned seed task at enqueue time — so a panic
/// anywhere in a turn can't leak the pin.
pub struct AgentHold<R: tauri::Runtime> {
    app: AppHandle<R>,
}

impl<R: tauri::Runtime> AgentHold<R> {
    /// Acquire a slot for this guard's lifetime.
    pub fn hold(app: &AppHandle<R>) -> Self {
        acquire(app);
        Self { app: app.clone() }
    }
}

impl<R: tauri::Runtime> Drop for AgentHold<R> {
    fn drop(&mut self) {
        release(&self.app);
    }
}
