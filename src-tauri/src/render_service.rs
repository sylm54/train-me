//! Android foreground-service bridge for audio/TTS rendering.
//!
//! While any render is in flight, the Kotlin `RenderService` foreground
//! service (`gen/android/.../RenderService.kt`) pins the process at
//! foreground priority — so a background prerender survives the app being
//! backgrounded and Android's cached-app freezing — and owns the ongoing
//! "Rendering audio" notification with its native progress bar. When the
//! last render finishes, the service stops (removing the ongoing
//! notification) and a completion notification is posted.
//!
//! Rust drives the service through static methods on the Kotlin class, run
//! over JNI on the wry main-pipe thread (`with_webview` →
//! `PlatformWebview::jni_handle().exec`, the public Tauri v2 route for
//! app-side JNI). The class is looked up via the
//! activity's `getAppClass` (the app's PathClassLoader); plain `find_class`
//! only sees the system loader and would miss app classes. Every call is
//! best-effort: failures are logged and swallowed so a notification or
//! service hiccup can never fail a render. On non-Android targets every
//! entry point is a no-op.
//!
//! Renderers acquire/release slots instead of starting/stopping the service
//! directly: the UI `render_manifest` command and a prerender pass can
//! overlap (the engine lock serializes synthesis, not the callers), and the
//! ongoing notification must outlive the shorter of the two. The first
//! holder starts the service; releasing the last slot stops it.

use tauri::Webview;

#[cfg(target_os = "android")]
use {
    jni::objects::{JClass, JObject, JValue},
    jni::JNIEnv,
    std::sync::atomic::{AtomicUsize, Ordering},
};

/// Number of in-flight render slots. 0 → 1 starts the service, 1 → 0 stops
/// it. Access only through [`acquire`]/[`release`] so the transitions stay
/// paired with their JNI dispatches.
#[cfg(target_os = "android")]
static HOLDERS: AtomicUsize = AtomicUsize::new(0);

#[cfg(target_os = "android")]
const SERVICE_CLASS: &str = "com.sylm54.train.RenderService";

/// Run `f` with the JNI env + activity on the wry main-pipe thread. The
/// platform-webview hop is the stable public route to the JNI handle (the
/// direct one lives behind tauri's `unstable` feature).
#[cfg(target_os = "android")]
fn exec_on_main<R, F>(webview: &Webview<R>, f: F)
where
    R: tauri::Runtime,
    F: FnOnce(&mut JNIEnv, &JObject, &JObject) + Send + 'static,
{
    let _ = webview.with_webview(move |platform| {
        platform.jni_handle().exec(f);
    });
}

/// Resolve the `RenderService` class through the activity's class loader and
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

/// Acquire one render slot; the first holder starts the foreground service.
pub fn acquire<R: tauri::Runtime>(webview: &Webview<R>) {
    #[cfg(target_os = "android")]
    {
        if HOLDERS.fetch_add(1, Ordering::SeqCst) == 0 {
            exec_on_main(webview, |env, activity, _| {
                if let Err(e) = with_service_class(env, activity, |env, activity, class| {
                    env.call_static_method(
                        class,
                        "start",
                        "(Landroid/content/Context;)V",
                        &[activity.into()],
                    )?;
                    Ok(())
                }) {
                    log::warn!("RenderService.start failed: {e}");
                }
            });
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = webview;
    }
}

/// Release one render slot; releasing the last stops the service, which
/// removes the ongoing notification.
pub fn release<R: tauri::Runtime>(webview: &Webview<R>) {
    #[cfg(target_os = "android")]
    {
        if HOLDERS.fetch_sub(1, Ordering::SeqCst) == 1 {
            exec_on_main(webview, |env, activity, _| {
                if let Err(e) = with_service_class(env, activity, |env, activity, class| {
                    env.call_static_method(
                        class,
                        "stop",
                        "(Landroid/content/Context;)V",
                        &[activity.into()],
                    )?;
                    Ok(())
                }) {
                    log::warn!("RenderService.stop failed: {e}");
                }
            });
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = webview;
    }
}

/// Update the ongoing service notification's progress bar. `total == 0`
/// renders an indeterminate spinner; otherwise a percent bar for
/// `done.min(total)` of `total`.
#[cfg(target_os = "android")]
pub fn update_progress<R: tauri::Runtime>(webview: &Webview<R>, body: &str, done: u64, total: u64) {
    let body = body.to_string();
    let indeterminate = total == 0;
    let pct: i32 = if indeterminate {
        0
    } else {
        ((done.min(total) * 100 / total) as i32).clamp(0, 100)
    };
    exec_on_main(webview, move |env, activity, _| {
        if let Err(e) = with_service_class(env, activity, |env, activity, class| {
            let jbody = env.new_string(body.as_str())?;
            env.call_static_method(
                class,
                "updateProgress",
                "(Landroid/content/Context;Ljava/lang/String;IZ)V",
                &[
                    activity.into(),
                    (&jbody).into(),
                    JValue::from(pct),
                    JValue::from(indeterminate),
                ],
            )?;
            Ok(())
        }) {
            log::debug!("RenderService.updateProgress failed: {e}");
        }
    });
}

/// Post the "rendering finished" completion notification.
#[cfg(target_os = "android")]
pub fn notify_done<R: tauri::Runtime>(webview: &Webview<R>, title: &str, body: &str) {
    let title = title.to_string();
    let body = body.to_string();
    exec_on_main(webview, move |env, activity, _| {
        if let Err(e) = with_service_class(env, activity, |env, activity, class| {
            let jtitle = env.new_string(title.as_str())?;
            let jbody = env.new_string(body.as_str())?;
            env.call_static_method(
                class,
                "notifyDone",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V",
                &[activity.into(), (&jtitle).into(), (&jbody).into()],
            )?;
            Ok(())
        }) {
            log::debug!("RenderService.notifyDone failed: {e}");
        }
    });
}

/// RAII render slot: the first [`hold`](Self::hold) starts the service, the
/// guard's drop releases it. Lets a prerender pass hold the service across
/// phases (synthesis loop, visual prefetch) and early exits alike.
pub struct RenderHold<'a, R: tauri::Runtime> {
    webview: Option<&'a Webview<R>>,
}

impl<'a, R: tauri::Runtime> RenderHold<'a, R> {
    pub fn new() -> Self {
        Self { webview: None }
    }

    /// Acquire a slot (once, no matter how often called).
    pub fn hold(&mut self, webview: &'a Webview<R>) {
        if self.webview.is_none() {
            acquire(webview);
            self.webview = Some(webview);
        }
    }
}

impl<R: tauri::Runtime> Drop for RenderHold<'_, R> {
    fn drop(&mut self) {
        if let Some(webview) = self.webview.take() {
            release(webview);
        }
    }
}
