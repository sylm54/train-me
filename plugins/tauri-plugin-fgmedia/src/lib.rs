//! Android foreground media service plugin.
//!
//! Keeps the app process alive (and audio playing) when backgrounded by
//! running an Android foreground service of type `mediaPlayback` that holds
//! an active `MediaSession`, audio focus, and a partial wake lock — the set
//! of signals Chromium-WebView uses to treat an app as a legitimate media
//! player.
//!
//! The Kotlin implementation (`FgMediaPlugin` + `MediaService`) lives under
//! `android/`. On non-Android targets the commands are no-ops so the same
//! frontend code runs everywhere.

#![cfg_attr(not(target_os = "android"), allow(dead_code, unused_variables))]

mod commands;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

pub use commands::{start_media_service, stop_media_service, update_media_state};

/// Handle to the Kotlin plugin, stored in Tauri state.
///
/// On Android `handle` is the bridge used to invoke Kotlin commands. On other
/// platforms there's no Kotlin side, so the state is empty (a `()` marker) —
/// the commands are no-ops. `PluginHandle<R>` is `Send + Sync` for any
/// `R: Runtime`, so this type needs no manual `unsafe impl`.
pub struct FgMedia<R: Runtime> {
    #[cfg(target_os = "android")]
    pub handle: tauri::plugin::PluginHandle<R>,
    // On non-Android targets the handle is unused (commands no-op); the
    // `PhantomData<fn() -> R>` marker keeps `R` live without inheriting its
    // `Sync` bound (a bare `PhantomData<R>` would require `R: Sync`, which the
    // `wry` runtime isn't).
    #[cfg(not(target_os = "android"))]
    #[allow(dead_code)]
    pub _phantom: std::marker::PhantomData<fn() -> R>,
}

/// Initialize the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("fgmedia")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("com.sylm54.train.fgmedia", "FgMediaPlugin")?;
                app.manage(FgMedia::<R> { handle });
            }
            #[cfg(not(target_os = "android"))]
            {
                app.manage(FgMedia::<R> {
                    _phantom: std::marker::PhantomData,
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_media_service,
            commands::stop_media_service,
            commands::update_media_state
        ])
        .build()
}
