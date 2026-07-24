//! Tauri command implementations for the fgmedia plugin.
//!
//! Kept in a separate module from `generate_handler!` (the same convention
//! used by the official Tauri plugins) to avoid macro symbol collisions
//! between `#[tauri::command]` and `generate_handler!`.
//
// `app`/`args` are only read on Android (via the mobile plugin bridge); on
// other targets they're intentionally unused, so silence the dead-code noise.
#![cfg_attr(not(target_os = "android"), allow(unused_variables))]

use serde::{Deserialize, Serialize};
#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::{command, AppHandle, Runtime};

/// Args for [`start_media_service`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    /// Title shown in the "Now playing" notification (e.g. the script title).
    pub title: Option<String>,
}

/// Args for [`update_media_state`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateArgs {
    pub title: Option<String>,
    pub playing: Option<bool>,
}

/// Start the foreground media service (Android). No-op elsewhere.
#[command]
pub fn start_media_service<R: Runtime>(app: AppHandle<R>, args: StartArgs) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use std::collections::HashMap;
        let fg = app.state::<crate::FgMedia<R>>();
        let mut payload = HashMap::new();
        payload.insert("title", args.title.unwrap_or_default());
        fg.handle
            .run_mobile_plugin::<()>("start", payload)
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "android"))]
    {
        log::debug!(
            "start_media_service is a no-op on this platform (title={:?})",
            args.title
        );
    }
    Ok(())
}

/// Update the foreground service's playback state / title (Android). No-op elsewhere.
#[command]
pub fn update_media_state<R: Runtime>(app: AppHandle<R>, args: StateArgs) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let fg = app.state::<crate::FgMedia<R>>();
        // `title` is a String and `playing` is a bool, so the payload value
        // type must be `serde_json::Value` (not `String`) to carry both.
        let payload = serde_json::json!({
            "title": args.title.unwrap_or_default(),
            "playing": args.playing.unwrap_or(true),
        });
        fg.handle
            .run_mobile_plugin::<()>("setState", payload)
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "android"))]
    {
        log::debug!(
            "update_media_state is a no-op on this platform (title={:?}, playing={:?})",
            args.title,
            args.playing
        );
    }
    Ok(())
}

/// Stop the foreground media service (Android). No-op elsewhere.
#[command]
pub fn stop_media_service<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let fg = app.state::<crate::FgMedia<R>>();
        fg.handle
            .run_mobile_plugin::<()>("stop", ())
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "android"))]
    {
        log::debug!("stop_media_service is a no-op on this platform");
    }
    Ok(())
}
