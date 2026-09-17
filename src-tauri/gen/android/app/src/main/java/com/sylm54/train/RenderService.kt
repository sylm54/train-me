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
 * Foreground service that hosts audio/TTS rendering.
 *
 * The actual synthesis lives in Rust; this service only pins the process at
 * foreground priority while a render is in flight (so a background prerender
 * survives the app being backgrounded and cached-app freezing) and owns the
 * ongoing "Rendering audio" notification with its native progress bar.
 *
 * Rust drives it through the static helpers below (called over JNI): `start`
 * when the first render begins, `updateProgress` on throttled progress ticks,
 * `notifyDone` when a render pass completes, `stop` when the last render ends.
 *
 * The class is only referenced by name from Rust, so @Keep is required to
 * survive R8 in release builds.
 */
@Keep
class RenderService : Service() {

    companion object {
        private const val TAG = "RenderService"

        /** Same channel id the Rust notification plugin uses for renders. */
        const val PROGRESS_CHANNEL_ID = "rendering"
        const val DONE_CHANNEL_ID = "rendering-done"

        /** Must match render_notify::RENDER_NOTIF_ID so Rust-driven updates
         *  and the service's own foreground notification are the same entry. */
        const val PROGRESS_NOTIF_ID = 7777
        const val DONE_NOTIF_ID = 7778

        fun ensureChannels(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                return
            }
            val mgr = context.getSystemService(NotificationManager::class.java) ?: return
            val progress = NotificationChannel(
                PROGRESS_CHANNEL_ID,
                "Rendering",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Progress while rendering conditioning scripts"
                setShowBadge(false)
            }
            val done = NotificationChannel(
                DONE_CHANNEL_ID,
                "Rendering finished",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Shown when audio rendering finishes"
                setShowBadge(false)
            }
            mgr.createNotificationChannel(progress)
            mgr.createNotificationChannel(done)
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

        private fun progressNotification(
            context: Context,
            body: String,
            pct: Int,
            indeterminate: Boolean,
        ): Notification =
            NotificationCompat.Builder(context, PROGRESS_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_render_notification)
                .setContentTitle("Rendering audio")
                .setContentText(body)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(contentIntent(context))
                .apply {
                    if (indeterminate) {
                        setProgress(0, 0, true)
                    } else {
                        setProgress(100, pct.coerceIn(0, 100), false)
                    }
                }
                .build()

        @JvmStatic
        fun start(context: Context) {
            try {
                ensureChannels(context)
                val intent = Intent(context, RenderService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (e: Exception) {
                // Background starts can be rejected on API 31+; rendering
                // simply proceeds without the foreground elevation.
                Log.w(TAG, "start failed: $e")
            }
        }

        @JvmStatic
        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, RenderService::class.java))
            } catch (e: Exception) {
                Log.w(TAG, "stop failed: $e")
            }
        }

        @JvmStatic
        fun updateProgress(context: Context, body: String, pct: Int, indeterminate: Boolean) {
            try {
                ensureChannels(context)
                val notif = progressNotification(context, body, pct, indeterminate)
                context.getSystemService(NotificationManager::class.java)
                    ?.notify(PROGRESS_NOTIF_ID, notif)
            } catch (e: Exception) {
                Log.w(TAG, "updateProgress failed: $e")
            }
        }

        @JvmStatic
        fun notifyDone(context: Context, title: String, body: String) {
            try {
                ensureChannels(context)
                val notif = NotificationCompat.Builder(context, DONE_CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_render_notification)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                    .setAutoCancel(true)
                    .setContentIntent(contentIntent(context))
                    .build()
                context.getSystemService(NotificationManager::class.java)
                    ?.notify(DONE_NOTIF_ID, notif)
            } catch (e: Exception) {
                Log.w(TAG, "notifyDone failed: $e")
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
        val notif = progressNotification(this, "Preparing…", 0, true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(PROGRESS_NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(PROGRESS_NOTIF_ID, notif)
        }
    }
}
