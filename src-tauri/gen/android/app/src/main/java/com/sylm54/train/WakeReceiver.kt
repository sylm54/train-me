package com.sylm54.train

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.annotation.Keep

/**
 * Stage 5b agent wake-ups: receives (a) the alarm app itself scheduled —
 * an EXPLICIT intent from [AgentWakeScheduler]'s AlarmManager PendingIntent —
 * and (b) ACTION_BOOT_COMPLETED (alarms do not survive a reboot, so boot
 * only re-arms them via the native reschedule path). Both are forwarded to
 * [AgentService] as a foreground-service start; the service promotes to
 * foreground FIRST and only then touches the native library.
 *
 * Background-start exemptions (why this is legal): BOOT_COMPLETED is a
 * documented foreground-service-start exemption, and so is firing an exact
 * alarm scheduled with `setExactAndAllowWhileIdle` — both let this receiver
 * call `startForegroundService` from the background.
 *
 * Manifest/exported note: the receiver is declared `exported="true"` BECAUSE
 * of the BOOT_COMPLETED filter — per the Broadcasts overview, manifest
 * receivers with an intent-filter for system broadcasts must be exported
 * (a non-exported receiver silently stops receiving them on modern Android).
 * That is safe here: BOOT_COMPLETED is a protected broadcast only the system
 * can send, and our own alarm delivery is an explicit component intent. The
 * custom wake action is deliberately NOT in the intent-filter, so implicit
 * broadcasts of ACTION_AGENT_WAKE from other apps are not delivered; the
 * residual spoofing route (an explicit intent to this component) only wakes
 * the agent with an attacker-chosen message and is bounded by the global
 * 2-fires-per-24h rate cap in agent_wakes.rs.
 *
 * This receiver NEVER touches the native library — a crash here would loop
 * the alarm; the service owns all native calls behind try/catch.
 */
@Keep
class WakeReceiver : BroadcastReceiver() {
    companion object {
        /** Must match [AgentWakeScheduler.ACTION_AGENT_WAKE]. */
        const val ACTION_AGENT_WAKE = "com.sylm54.train.AGENT_WAKE"
        const val EXTRA_INDEX = "wake_index"
        const val EXTRA_MESSAGE = "wake_message"
        const val EXTRA_TOKEN = "wake_token"

        private const val TAG = "WakeReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        try {
            val serviceIntent = Intent(context, AgentService::class.java)
            when (intent.action) {
                // Boot: alarms were wiped — re-arm from the persisted config.
                Intent.ACTION_BOOT_COMPLETED ->
                    serviceIntent.action = AgentService.ACTION_BOOT_RESCHEDULE

                // A scheduled wake: forward the payload verbatim.
                ACTION_AGENT_WAKE -> {
                    serviceIntent.action = AgentService.ACTION_AGENT_WAKE
                    serviceIntent.putExtra(
                        EXTRA_INDEX,
                        intent.getIntExtra(EXTRA_INDEX, -1),
                    )
                    serviceIntent.putExtra(
                        EXTRA_MESSAGE,
                        intent.getStringExtra(EXTRA_MESSAGE) ?: "",
                    )
                    serviceIntent.putExtra(
                        EXTRA_TOKEN,
                        intent.getStringExtra(EXTRA_TOKEN) ?: "",
                    )
                }

                else -> return
            }
            context.startForegroundService(serviceIntent)
        } catch (e: Exception) {
            // Includes ForegroundServiceStartNotAllowedException on OEM
            // stacks that deny even the exemptions — logged, never fatal.
            Log.w(TAG, "forward to AgentService failed: $e")
        }
    }
}
