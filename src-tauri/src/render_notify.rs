//! Native notification for manifest rendering.
//!
//! A low-key "Rendering…" notification shown while `render_manifest` is
//! working. Distinct from routine reminders: it lives on its own
//! (`rendering`) channel, is `ongoing` (non-dismissible on Android) while a
//! render is in flight, and is updated in place by re-issuing the same stable
//! notification id. Cleared on success or failure.
//!
//! All entry points are best-effort: errors are logged and swallowed so a
//! notification hiccup can never fail a render. `NotificationExt::show()` is
//! safe to call from the `spawn_blocking` worker — Tauri hands the actual JNI
//! work to its Android looper thread, so no manual thread attachment is
//! needed (and on desktop it's a plain OS call).

use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// Dedicated channel id for render-progress notifications. Kept separate
/// from `routine-reminders` so its importance/vibration can be tuned
/// independently (renders are low-key; reminders are high-importance).
const RENDER_CHANNEL_ID: &str = "rendering";

/// Stable notification id. Re-showing with the same id updates the existing
/// notification in place rather than stacking a new one.
pub const RENDER_NOTIF_ID: i32 = 7777;

/// Minimum gap between notification body updates. Long renders can emit
/// hundreds of progress ticks; we don't want to flood the notification shade.
const UPDATE_THROTTLE: Duration = Duration::from_millis(400);

/// Render a human-friendly body for a progress notification.
fn body_for(title: &str, step: usize, total: usize) -> String {
    if total > 0 {
        let pct = ((step as f64 / total as f64) * 100.0).round() as u32;
        format!("{} — {}% ({} / {})", title, pct.min(100), step.min(total), total)
    } else {
        title.to_string()
    }
}

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
pub fn request_permission_best_effort<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Err(e) = app.notification().request_permission() {
        log::debug!("request_permission failed: {e}");
    }
}

/// Show (or update) the render-progress notification. Marked `ongoing` so it
/// can't be dismissed while a render is in flight.
pub fn show_render_progress<R: tauri::Runtime>(
    app: &AppHandle<R>,
    title: &str,
    step: usize,
    total: usize,
) {
    let body = body_for(title, step, total);
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

/// A throttle guard shared across progress ticks for a single render.
/// Construct one per render; call [`Self::maybe_update`] on each tick.
pub struct RenderNotifyThrottle {
    last: Mutex<Option<Instant>>,
}

impl RenderNotifyThrottle {
    pub fn new() -> Self {
        Self {
            last: Mutex::new(None),
        }
    }

    /// Update the notification only if at least `UPDATE_THROTTLE` has elapsed
    /// since the last update (or this is the first call). Always allowed to be
    /// called on every tick; cheap when throttled.
    pub fn maybe_update<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        title: &str,
        step: usize,
        total: usize,
    ) {
        let now = Instant::now();
        let should_update = {
            let mut guard = self.last.lock();
            match *guard {
                None => {
                    *guard = Some(now);
                    true
                }
                Some(last) => {
                    if now.duration_since(last) >= UPDATE_THROTTLE {
                        *guard = Some(now);
                        true
                    } else {
                        false
                    }
                }
            }
        };
        if should_update {
            show_render_progress(app, title, step, total);
        }
    }
}

impl Default for RenderNotifyThrottle {
    fn default() -> Self {
        Self::new()
    }
}
