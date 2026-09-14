//! Native notification + progress-event glue for manifest rendering.
//!
//! This module owns the Tauri-facing half of the progress pipeline (the pure
//! half lives in [`crate::progress`]): it converts [`crate::progress::Snapshot`]
//! ticks into (a) the throttled `render-manifest-progress` push event the
//! frontend's render registry listens on, and (b) an in-place update of a
//! low-key native "Rendering…" notification.
//!
//! The notification lives on its own (`rendering`) channel, is `ongoing`
//! (non-dismissible on Android) while a render is in flight, and is updated
//! by re-issuing the same stable notification id. Cleared on success or
//! failure. All entry points are best-effort: errors are logged and swallowed
//! so a notification hiccup can never fail a render. `NotificationExt::show()`
//! is safe to call from the `spawn_blocking` worker — Tauri hands the actual
//! JNI work to its Android looper thread, so no manual thread attachment is
//! needed (and on desktop it's a plain OS call).

use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::progress::{self, EtaEstimator, Snapshot, Throttle};

/// Dedicated channel id for render-progress notifications. Kept separate
/// from `routine-reminders` so its importance/vibration can be tuned
/// independently (renders are low-key; reminders are high-importance).
const RENDER_CHANNEL_ID: &str = "rendering";

/// Stable notification id. Re-showing with the same id updates the existing
/// notification in place rather than stacking a new one.
pub const RENDER_NOTIF_ID: i32 = 7777;

/// Minimum gap between `render-manifest-progress` push events (~2 Hz). Fast
/// synthesis ticks get coalesced; it's fine to drop updates of a purely
/// cosmetic bar.
const EVENT_THROTTLE: Duration = Duration::from_millis(500);

/// Minimum gap between notification body updates. Long renders can emit
/// hundreds of progress ticks; we don't want to flood the notification shade.
const NOTIF_THROTTLE: Duration = Duration::from_millis(400);

/// Create the `rendering` channel on Android (no-op elsewhere). Channel
/// creation is idempotent at the OS level, so calling this every render is
/// cheap. Best-effort: errors are ignored.
pub fn ensure_channel<R: tauri::Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_notification::{Channel, Importance};
        let channel = Channel::builder(RENDER_CHANNEL_ID, "Rendering")
            .description("Progress while rendering conditioning scripts")
            .importance(Importance::Low)
            .build();
        if let Err(e) = app.notification().create_channel(channel) {
            log::warn!("create_channel failed: {e}");
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
    }
}

/// Request notification permission if not already granted. Best-effort.
///
/// NOTE: callers on an async critical path should prefer
/// [`request_permission_detached`]: on some Android OEM stacks the plugin's
/// `request_permission()` bridge can synchronously block on the UI looper,
/// which would stall the calling task.
pub fn request_permission_best_effort<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Err(e) = app.notification().request_permission() {
        log::debug!("request_permission failed: {e}");
    }
}

/// Spawn the notification-permission request on a detached blocking thread so
/// it can never stall the caller. Used by `render_manifest`, which runs on an
/// async command thread that must not block before it reaches `spawn_blocking`
/// (a blocked permission call here previously hung the whole render at
/// "Preparing…"). The handle is dropped intentionally (fire-and-forget); the
/// permission state is read lazily when a notification is actually shown.
pub fn request_permission_detached<R: tauri::Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    // `spawn_blocking` returns a JoinHandle we deliberately drop: the
    // permission result is best-effort and not needed to proceed.
    let _ = tauri::async_runtime::spawn_blocking(move || {
        request_permission_best_effort(&app);
    });
}

/// Show (or update) the render-progress notification from a snapshot. Marked
/// `ongoing` so it can't be dismissed while a render is in flight.
pub fn show_render_progress<R: tauri::Runtime>(
    app: &AppHandle<R>,
    title: &str,
    snap: &Snapshot,
    eta_secs: Option<u64>,
) {
    let body = progress::body_for(title, snap, eta_secs);
    let result = app
        .notification()
        .builder()
        .id(RENDER_NOTIF_ID)
        // `channel_id` only matters on Android, but the builder accepts it on
        // all platforms and ignores it where irrelevant.
        .channel_id(RENDER_CHANNEL_ID)
        .title("Rendering…")
        .body(&body)
        .ongoing()
        .show();
    if let Err(e) = result {
        log::debug!("show_render_progress failed: {e}");
    }
}

/// Remove the render-progress notification (e.g. on completion). Best-effort.
pub fn clear_render_progress<R: tauri::Runtime>(app: &AppHandle<R>) {
    // On mobile the notification is cancelled via `remove_active`; on desktop
    // there's no per-id cancel, so we re-show a transient (non-ongoing)
    // notification with the same id that the OS replaces — and it fades as a
    // normal notification. This keeps the tray tidy.
    #[cfg(target_os = "android")]
    {
        if let Err(e) = app.notification().remove_active(vec![RENDER_NOTIF_ID]) {
            log::debug!("remove_active failed: {e}");
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
    }
}

/// Build the per-render tick sink shared by every render driver (the UI
/// command and background pre-render passes): a [`Snapshot`] consumer that
/// emits the throttled `render-manifest-progress` event with a backend-ETA
/// estimate and — when `notify` is `Some` — updates the native notification
/// on its own (slightly faster) throttle. The completion tick always passes
/// both throttles so the bar lands exactly on 100%.
///
/// `notify` is `Some((app, title))` only for foreground UI renders; background
/// prerenders don't drive the native notification (the app may be in the
/// background and the pass is incremental).
pub fn make_tick_sink<R: tauri::Runtime>(
    progress_app: AppHandle<R>,
    script: String,
    notify: Option<(AppHandle<R>, String)>,
) -> progress::ProgressSink {
    let mut event_throttle = Throttle::new(EVENT_THROTTLE);
    let mut notif_throttle = Throttle::new(NOTIF_THROTTLE);
    let mut eta = EtaEstimator::default();
    Box::new(move |snap: &Snapshot| {
        let now = Instant::now();
        // Estimated seconds remaining from the cost rate (Some only once
        // synthesis has begun and progress exists; sticky afterwards).
        let eta_secs = eta.observe(now, snap.done, snap.total);
        if event_throttle.ready_or_complete(now, snap) {
            use tauri::Emitter;
            let _ = progress_app.emit(
                "render-manifest-progress",
                serde_json::json!({
                    "script": script,
                    "done": snap.done,
                    "total": snap.total,
                    "pct": snap.pct,
                    "label": snap.label,
                    "eta_secs": eta_secs,
                }),
            );
        }
        if let Some((app, title)) = &notify {
            if notif_throttle.ready_or_complete(now, snap) {
                show_render_progress(app, title, snap, eta_secs);
            }
        }
    })
}
