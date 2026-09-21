package com.sylm54.train

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.annotation.Keep

/**
 * Static scheduling helpers for Stage 5b agent wake-ups, called from Rust
 * over JNI — both from the live app (through the webview JNI hop, same route
 * as `AgentService.start`/`stop`) and from the cold-start native path
 * (`AgentService.agentReschedule`, which already holds a JNIEnv on its own
 * thread and calls these statics directly).
 *
 * One exact alarm per config entry. Request codes ARE the entry indexes
 * (0-based position in the validated config), so:
 *  - a reschedule overwrites a prior alarm for the same index
 *    ([PendingIntent.FLAG_UPDATE_CURRENT]),
 *  - stale codes above the live entry count are cancelled by index
 *    ([cancelRange]; the bound must stay in sync with
 *    `agent_wakes::MAX_WAKE_ENTRIES` in agent_wakes.rs).
 *
 * The alarm carries the wake payload as extras (entry index, message
 * snapshot, token) and targets [WakeReceiver] via an EXPLICIT component
 * intent — the receiver's manifest intent-filter is for BOOT_COMPLETED only,
 * so explicit delivery is what makes our own alarms work.
 *
 * Exact-alarm policy: `setExactAndAllowWhileIdle` needs SCHEDULE_EXACT_ALARM
 * (declared in the manifest; default-DENIED for apps targeting API 33+).
 * When the grant is missing we log and SKIP — graceful degradation, and the
 * Settings "Agent wake-ups" row surfaces a grant button that fires
 * [requestExactPermission] (the ACTION_REQUEST_SCHEDULE_EXACT_ALARM settings
 * screen — Android 14+ requires the user to be in that screen; the grant
 * cannot be requested programmatically).
 *
 * The class is only referenced by name from Rust, so @Keep is required to
 * survive R8 in release builds.
 */
@Keep
object AgentWakeScheduler {
    private const val TAG = "AgentWakeScheduler"

    /** Must match [WakeReceiver.ACTION_AGENT_WAKE]. */
    const val ACTION_AGENT_WAKE = "com.sylm54.train.AGENT_WAKE"

    /** Keep in sync with agent_wakes::MAX_WAKE_ENTRIES (Rust). */
    const val MAX_REQUEST_CODES = 32

    /**
     * Whether exact alarms may currently be scheduled. Below S we don't need
     * (or check) the permission; from API 31 the grant is user-revocable and
     * default-denied for apps targeting 33+.
     */
    @JvmStatic
    fun canScheduleExact(context: Context): Boolean {
        return try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                true
            } else {
                context.getSystemService(AlarmManager::class.java)
                    ?.canScheduleExactAlarms() ?: false
            }
        } catch (e: Exception) {
            Log.w(TAG, "canScheduleExact failed: $e")
            false
        }
    }

    /**
     * Launch the system screen where the user grants SCHEDULE_EXACT_ALARM.
     * Fire-and-forget: failures (screen unavailable on some OEM stacks) are
     * logged; the Settings row still explains the manual path.
     */
    @JvmStatic
    fun requestExactPermission(context: Context) {
        try {
            val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
                .setData(Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "requestExactPermission failed: $e")
        }
    }

    /** The alarm PendingIntent: explicit to [WakeReceiver], payload in extras. */
    private fun wakePendingIntent(
        context: Context,
        requestCode: Int,
        message: String,
        token: String,
    ): PendingIntent {
        val intent = Intent(context, WakeReceiver::class.java).apply {
            action = ACTION_AGENT_WAKE
            putExtra(WakeReceiver.EXTRA_INDEX, requestCode)
            putExtra(WakeReceiver.EXTRA_MESSAGE, message)
            putExtra(WakeReceiver.EXTRA_TOKEN, token)
        }
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /**
     * Schedule ONE next fire for entry `requestCode` at `epochMillis`. The
     * message/token land in the alarm's extras (extras don't participate in
     * PendingIntent matching, so a later [cancel] rebuilds a filter-equal
     * intent safely).
     */
    @JvmStatic
    fun scheduleNext(
        context: Context,
        requestCode: Int,
        epochMillis: Long,
        message: String,
        token: String,
    ) {
        try {
            val am = context.getSystemService(AlarmManager::class.java) ?: return
            if (!canScheduleExact(context)) {
                // Graceful degradation — Settings offers the grant intent.
                Log.w(
                    TAG,
                    "SCHEDULE_EXACT_ALARM not granted; wake $requestCode not scheduled",
                )
                return
            }
            am.setExactAndAllowWhileIdle(
                AlarmManager.RTC_WAKEUP,
                epochMillis,
                wakePendingIntent(context, requestCode, message, token),
            )
        } catch (e: Exception) {
            Log.w(TAG, "scheduleNext($requestCode) failed: $e")
        }
    }

    /** Cancel the alarm for `requestCode` (a no-op when none is set). */
    @JvmStatic
    fun cancel(context: Context, requestCode: Int) {
        try {
            val am = context.getSystemService(AlarmManager::class.java) ?: return
            am.cancel(wakePendingIntent(context, requestCode, "", ""))
        } catch (e: Exception) {
            Log.w(TAG, "cancel($requestCode) failed: $e")
        }
    }

    /** Cancel every request code in `[fromInclusive, toExclusive)`. */
    @JvmStatic
    fun cancelRange(context: Context, fromInclusive: Int, toExclusive: Int) {
        for (code in fromInclusive until toExclusive) {
            cancel(context, code)
        }
    }
}
