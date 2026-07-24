# Keep the foreground-media plugin classes.
#
# `FgMediaPlugin` is loaded reflectively by class name from Rust
# (`tauri::plugin::PluginHandle::register_android_plugin`), so the compiler
# sees no static references to it. R8/fullMode minification in release builds
# therefore strips the class (and its @Command methods), and the app crashes
# at launch with a ClassNotFoundException when the plugin setup tries to load
# it. The Tauri codegen keep rule only matches classes annotated
# `@TauriPlugin`; this plugin's Kotlin class relies on the plain `Plugin`
# base, so we keep the whole package explicitly.
-keep class com.sylm54.train.fgmedia.** { *; }
