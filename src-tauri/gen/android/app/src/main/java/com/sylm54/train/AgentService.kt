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
import org.json.JSONObject

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
 * Stage 5b (scheduled agent wake-ups): the service is ALSO started cold by
 * [WakeReceiver] — from an exact alarm or from BOOT_COMPLETED, both
 * documented background-start exemptions — with an [ACTION_AGENT_WAKE] or
 * [ACTION_BOOT_RESCHEDULE] intent. The contract stays the same: promote to
 * foreground in `onCreate`/`onStartCommand` FIRST (the
 * startForegroundService requirement), then run the native call on a worker
 * thread, never the main thread, and never let a native failure crash the
 * process. `agentWake` blocks until the seeded turn settles and answers
 * with `{skipped, reason?, stillActive, summary?}`; the completion
 * notification posts on the "agent-done" channel when a run actually
 * happened, and the service stops itself only when Rust says nothing else
 * holds the pin (`stillActive == false`) AND the live runtime never pinned
 * it (`pinnedByRuntime` — that path stops the service itself via `stop`).
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

        /** One-shot completion notifications after a scheduled wake's run
         *  actually happened (never on skips). Paired with the "agent-done"
         *  channel; 7780 keeps the numbering scheme (render 7777/7778,
         *  agent ongoing 7779). */
        const val DONE_CHANNEL_ID = "agent-done"
        const val DONE_NOTIF_ID = 7780

        /** Intent actions carried by [WakeReceiver]-forwarded starts. */
        const val ACTION_AGENT_WAKE = "com.sylm54.train.AGENT_WAKE"
        const val ACTION_BOOT_RESCHEDULE = "com.sylm54.train.BOOT_RESCHEDULE"

        init {
            // Cold starts load the library here — no WebView/activity ever
            // ran in that process to do it. Safe to call repeatedly.
            try {
                System.loadLibrary("train_me_lib")
            } catch (t: Throwable) {
                Log.w(TAG, "loadLibrary(train_me_lib) failed: $t")
            }
        }

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
            val done = NotificationChannel(
                DONE_CHANNEL_ID,
                "Agent wake results",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Shown when a scheduled agent wake finishes its run"
                setShowBadge(true)
            }
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

    // ── Native entry points (Stage 5b) ──────────────────────────────────

    /**
     * Run one scheduled agent wake (BLOCKING — call off the main thread).
     * `payloadJson`: `{"index": N, "message": "…", "token": "…",
     * "dataDirPath": "…"}`. Returns
     * `{skipped: bool, reason?: string, stillActive: bool, summary?: string}`.
     *
     * Declared as a plain INSTANCE `external fun` on purpose: a companion
     * `external fun` without @JvmStatic declares its native method on the
     * Companion class (symbol `…AgentService_Companion_agentWake`), which
     * would never link against the Rust export. The instance form generates
     * exactly `Java_com_sylm54_train_AgentService_agentWake`, and the
     * implicit receiver arrives as the JNI function's second argument — the
     * Rust side treats it as an opaque jobject (and uses it as the
     * `Context` for the cold reschedule's AlarmManager calls).
     */
    private external fun agentWake(payloadJson: String): String

    /** Cold-start reschedule (BLOCKING — call off the main thread). Payload
     *  is the raw `dataDir` path; returns a summary JSON. Same symbol-naming
     *  rationale as [agentWake]. */
    private external fun agentReschedule(dataDirPath: String): String

    /**
     * True once a start WITHOUT a wake action arrived — i.e. the live
     * runtime pinned the service (its slot counting starts/stops it via the
     * `start`/`stop` statics). A finishing wake thread must then never
     * stopSelf: the runtime owns the service lifecycle in that overlap.
     * Reset in onDestroy (the runtime's `stop` destroys the service).
     */
    @Volatile
    private var pinnedByRuntime = false

    /** The at-most-one running wake job (alarms are serialized; a second
     *  start while one runs is dropped with a log — the global rate cap in
     *  Rust bounds how much a dropped wake can matter). */
    @Volatile
    private var wakeThread: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // Companion init runs here (ensureChannels is a companion member),
        // which is where the native library gets loaded — before any
        // external call can happen in a cold-started process.
        ensureChannels(this)
        promoteToForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Re-promote on every start: startForegroundService requires
        // startForeground within a few seconds of each start request, and a
        // start can arrive while the service is already running.
        promoteToForeground()
        when (intent?.action) {
            ACTION_AGENT_WAKE -> {
                val payload = JSONObject().apply {
                    put("index", intent.getIntExtra(WakeReceiver.EXTRA_INDEX, -1))
                    put("message", intent.getStringExtra(WakeReceiver.EXTRA_MESSAGE) ?: "")
                    put("token", intent.getStringExtra(WakeReceiver.EXTRA_TOKEN) ?: "")
                    put("dataDirPath", dataDirPath())
                }.toString()
                startWakeThread(payload)
            }

            ACTION_BOOT_RESCHEDULE ->
                Thread {
                    runReschedule()
                }.start()

            // Plain start from the live runtime's slot counting (or a
            // null-intent restart): the service lifecycle belongs to Rust's
            // holders from here on.
            else -> pinnedByRuntime = true
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        pinnedByRuntime = false
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

    /**
     * The app data dir, resolved the same way Tauri's path plugin resolves
     * `app_data_dir` on Android (`Context.getDataDir` on API 24+ — verified
     * against PathPlugin.kt in tauri 2.11; NOT filesDir, which is one level
     * deeper at `dataDir/files`). agent_wakes.rs derives data_dir/agent_dir
     * from this value and must reproduce the app's exact on-disk layout.
     */
    private fun dataDirPath(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            dataDir?.absolutePath
        } else {
            null
        } ?: applicationInfo.dataDir

    /** Serialize wake jobs: at most one native wake at a time in a process. */
    private fun startWakeThread(payload: String) {
        val existing = wakeThread
        if (existing?.isAlive == true) {
            Log.w(TAG, "wake already running; dropping the overlapping wake")
            return
        }
        wakeThread = Thread {
            runWake(payload)
        }.also { it.start() }
    }

    /** The blocking native wake + result handling (worker thread only). */
    private fun runWake(payload: String) {
        val resultJson = try {
            agentWake(payload)
        } catch (t: Throwable) {
            Log.w(TAG, "agentWake native call failed: $t")
            JSONObject().apply {
                put("skipped", true)
                put("reason", "native agentWake failed: $t")
                put("stillActive", false)
            }.toString()
        }
        try {
            val result = JSONObject(resultJson)
            val skipped = result.optBoolean("skipped", true)
            val stillActive = result.optBoolean("stillActive", false)
            val summary = result.optString("summary", "")
            if (!skipped) {
                postDoneNotification(summary.ifEmpty { "Wake run finished" })
            }
            if (!stillActive && !pinnedByRuntime) {
                stopSelf()
            }
        } catch (e: Exception) {
            Log.w(TAG, "wake result handling failed: $e")
            if (!pinnedByRuntime) stopSelf()
        }
    }

    /** Blocking cold reschedule + always-stop (boot path). */
    private fun runReschedule() {
        try {
            val summary = agentReschedule(dataDirPath())
            Log.i(TAG, "boot reschedule: $summary")
        } catch (t: Throwable) {
            Log.w(TAG, "agentReschedule native call failed: $t")
        }
        // Reschedule owns no further work: stop unless the live runtime
        // pinned the service in the meantime (it manages its own lifecycle).
        if (!pinnedByRuntime) {
            stopSelf()
        }
    }

    /** Completion notification for an actually-run wake (tap → MainActivity). */
    private fun postDoneNotification(summary: String) {
        try {
            val notif = NotificationCompat.Builder(this, DONE_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_render_notification)
                .setContentTitle("Agent finished")
                .setContentText(summary)
                .setStyle(NotificationCompat.BigTextStyle().bigText(summary))
                .setAutoCancel(true)
                .setContentIntent(contentIntent(this))
                .build()
            getSystemService(NotificationManager::class.java)
                ?.notify(DONE_NOTIF_ID, notif)
        } catch (e: Exception) {
            Log.w(TAG, "done notification failed: $e")
        }
    }
}
