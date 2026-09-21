package com.sylm54.train

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.annotation.Keep
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Foreground service that pins the process while a native agent turn runs.
 *
 * Without this, an agent turn that outlives the activity (background seed,
 * long tool loop while the user switches away) dies with the cached-app
 * freezer. Same deal as [RenderService] for audio rendering: the actual
 * work lives in Rust; this service only holds the process at foreground
 * priority and owns the ongoing "Agent active" notification whose body
 * mirrors the turn's phase (working / waiting for an answer / finishing).
 *
 * Rust drives it through the static helpers below (called over JNI):
 * `start` when the first run (or queued seed) acquires a slot,
 * `updateText` on throttled phase changes, `stop` when the last slot is
 * released.
 *
 * The class is only referenced by name from Rust, so @Keep is required to
 * survive R8 in release builds.
 */
@Keep
class AgentService : Service() {

    companion object {
        private const val TAG = "AgentService"

        /** Same channel id the Rust agent_service module documents. */
        const val CHANNEL_ID = "agent"

        /** Must match agent_service::AGENT_NOTIF_ID so Rust-driven updates
         *  and the service's own foreground notification are the same entry
         *  (RenderService owns 7777/7778; agent owns 7779). */
        const val NOTIF_ID = 7779

        fun ensureChannels(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                return
            }
            val mgr = context.getSystemService(NotificationManager::class.java) ?: return
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Agent activity",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Shown while an agent turn is running"
                setShowBadge(false)
            }
            mgr.createNotificationChannel(channel)
        }

        private fun contentIntent(context: Context): PendingIntent {
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            return PendingIntent.getActivity(
                context,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }

        private fun notification(context: Context, body: String): Notification =
            NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_render_notification)
                .setContentTitle("Agent active")
                .setContentText(body)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(contentIntent(context))
                .build()

        @JvmStatic
        fun start(context: Context) {
            try {
                ensureChannels(context)
                val intent = Intent(context, AgentService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (e: Exception) {
                // Background starts can be rejected on API 31+; the turn
                // simply proceeds without the foreground elevation.
                Log.w(TAG, "start failed: $e")
            }
        }

        @JvmStatic
        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, AgentService::class.java))
                // Belt and braces: if the service never actually started
                // (background start rejected) but phase updates were posted
                // through the NotificationManager anyway, the ongoing entry
                // would linger after the run. Cancel by id — a no-op when
                // stopService already removed it via STOP_FOREGROUND_REMOVE.
                context.getSystemService(NotificationManager::class.java)
                    ?.cancel(NOTIF_ID)
            } catch (e: Exception) {
                Log.w(TAG, "stop failed: $e")
            }
        }

        @JvmStatic
        fun updateText(context: Context, body: String) {
            try {
                ensureChannels(context)
                context.getSystemService(NotificationManager::class.java)
                    ?.notify(NOTIF_ID, notification(context, body))
            } catch (e: Exception) {
                Log.w(TAG, "updateText failed: $e")
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannels(this)
        promoteToForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Re-promote on every start: startForegroundService requires
        // startForeground within a few seconds of each start request, and a
        // start can arrive while the service is already running.
        promoteToForeground()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun promoteToForeground() {
        val notif = notification(this, "Working…")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }
}
