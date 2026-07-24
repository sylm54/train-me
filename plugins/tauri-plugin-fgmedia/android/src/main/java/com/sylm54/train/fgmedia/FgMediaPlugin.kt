package com.sylm54.train.fgmedia

import android.app.Activity
import android.content.Intent
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/** Args for the `start` command. */
@InvokeArg
class StartArgs {
    var title: String? = null
}

/** Args for the `setState` command. */
@InvokeArg
class StateArgs {
    var title: String? = null
    var playing: Boolean = true
}

/**
 * Tauri plugin that owns the foreground-media-service lifecycle.
 *
 * The heavy lifting (MediaSession, AudioFocus, wake lock, the notification)
 * lives in [MediaService]. This plugin bridges the Rust commands:
 *  - `start` → `startForegroundService`
 *  - `setState` → [MediaService.updateState] on the live instance (no service
 *    restart, so no `ForegroundServiceDidNotStartInTimeException` risk)
 *  - `stop` → `stopService`
 *
 * Command method names must match the strings Rust passes to
 * `run_mobile_plugin` exactly (no case conversion): `start`, `stop`,
 * `setState`.
 */
class FgMediaPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun start(invoke: Invoke) {
        val args = invoke.parseArgs(StartArgs::class.java)
        try {
            val intent = Intent(activity, MediaService::class.java)
            intent.putExtra(MediaService.EXTRA_TITLE, args.title ?: "train-me")
            ContextCompat.startForegroundService(activity, intent)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Failed to start media service: ${e.message}", null, null, null)
        }
    }

    @Command
    fun setState(invoke: Invoke) {
        val args = invoke.parseArgs(StateArgs::class.java)
        try {
            MediaService.updateState(args.title ?: "train-me", args.playing)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Failed to update media state: ${e.message}", null, null, null)
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        try {
            activity.stopService(Intent(activity, MediaService::class.java))
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Failed to stop media service: ${e.message}", null, null, null)
        }
    }
}

