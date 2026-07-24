const COMMANDS: &[&str] = &["start_media_service", "stop_media_service", "update_media_state"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();

    // Inject our foreground-media-service declarations into the generated
    // AndroidManifest.xml. The manifest under src-tauri/gen/android/ is
    // auto-generated (and gitignored), so declarations made there are lost on
    // every `tauri android init`. Injecting here makes them survive.
    //
    // Two injections, keyed by stable block identifiers so re-runs overwrite
    // cleanly (same convention as tauri-plugin-android-fs):
    //   1. <uses-permission> entries under the <manifest> root.
    //   2. the <service> entry under <application>.
    let permissions = [
        r#"<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />"#,
        r#"<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />"#,
        r#"<uses-permission android:name="android.permission.WAKE_LOCK" />"#,
        r#"<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />"#,
    ]
    .join("\n    ");

    let service = r#"<service
            android:name="com.sylm54.train.fgmedia.MediaService"
            android:exported="false"
            android:foregroundServiceType="mediaPlayback" />"#;

    if let Err(e) =
        tauri_plugin::mobile::update_android_manifest("FGMEDIA PERMISSIONS", "manifest", permissions)
    {
        println!("cargo:warning=failed to inject fgmedia permissions: {e}");
    }
    if let Err(e) = tauri_plugin::mobile::update_android_manifest(
        "FGMEDIA SERVICE",
        "application",
        service.to_string(),
    ) {
        println!("cargo:warning=failed to inject fgmedia service: {e}");
    }
}
