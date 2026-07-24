package com.sylm54.train.fgmedia

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat

/**
 * Foreground media service that keeps conditioning audio alive when the app
 * is backgrounded.
 *
 * What it holds while running:
 *  - A foreground notification of type `mediaPlayback` (the signal that lets
 *    Android keep the process and, in practice, Chromium-WebView's audio
 *    output running).
 *  - An active [MediaSessionCompat] reporting STATE_PLAYING — the lock-screen
 *    / media-routing signal WebView keys off.
 *  - Audio focus ([AudioManager.AUDIOFOCUS_GAIN]) with media usage attributes.
 *  - A partial wake lock so the CPU keeps decoding audio with the screen off.
 *
 * Limitation: the audio itself still plays in the WebView (`HTMLAudioElement`).
 * This service maximises the chance that Android/WebView keep it alive, but
 * it is not a 100% guarantee across all OEMs; moving playback native (Media3)
 * would be the bulletproof follow-up.
 */
class MediaService : Service() {

    companion object {
        const val EXTRA_TITLE = "title"
        const val EXTRA_PLAYING = "playing"

        private const val CHANNEL_ID = "media-playback"
        private const val NOTIF_ID = 4242

        /** Live service instance, set in `onCreate` and cleared in
         *  `onDestroy`. Lets the plugin update playback state in place
         *  without (re)starting the service. */
        @Volatile
        private var instance: MediaService? = null

        /** Update the running service's title/playing state, if it's alive. */
        fun updateState(title: String?, playing: Boolean) {
            instance?.apply {
                title?.let { this.title = it }
                this.playing = playing
                updateSession()
                refreshNotification()
            }
        }

        fun isRunning(): Boolean = instance != null
    }

    private var session: MediaSessionCompat? = null
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var title: String = "train-me"
    private var playing: Boolean = true

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        // Pause our reported state if another app took focus; resume when it
        // returns. (This only updates the session state we report — the actual
        // audio is owned by the WebView.)
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                playing = false
                updateSession()
                refreshNotification()
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                playing = true
                updateSession()
                refreshNotification()
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        ensureChannel()
        acquireWakeLock()
        setupSession()
        requestFocus()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Initial start: carry the title if present.
        intent?.getStringExtra(EXTRA_TITLE)?.let { t -> title = t }
        startForeground(NOTIF_ID, buildNotification())
        updateSession()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        instance = null
        abandonFocus()
        releaseWakeLock()
        session?.run {
            isActive = false
            release()
        }
        session = null
        super.onDestroy()
    }

    // ── Setup helpers ───────────────────────────────────────────────────

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Media playback",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Now playing notification (keeps audio alive in the background)"
                setShowBadge(false)
            }
            nm.createNotificationChannel(channel)
        }
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "train-me:media").apply {
            setReferenceCounted(false)
            acquire(/* 12h cap */ 12 * 60 * 60 * 1000L)
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
    }

    private fun setupSession() {
        session = MediaSessionCompat(this, "train-me").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                // Transport callbacks from lock screen / notification. We
                // don't wire them back to the WebView player in v1; keeping
                // them empty avoids no-op noise.
            })
            isActive = true
        }
        updateSession()
    }

    private fun updateSession() {
        val s = session ?: return
        val state = if (playing) PlaybackStateCompat.STATE_PLAYING
        else PlaybackStateCompat.STATE_PAUSED
        val builder = PlaybackStateCompat.Builder()
            .setActions(
                PlaybackStateCompat.ACTION_PLAY or
                    PlaybackStateCompat.ACTION_PAUSE or
                    PlaybackStateCompat.ACTION_PLAY_PAUSE or
                    PlaybackStateCompat.ACTION_STOP
            )
            .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1.0f)
        s.setPlaybackState(builder.build())
        // Update the metadata title so the lock-screen shows the script name.
        s.setMetadata(
            android.support.v4.media.MediaMetadataCompat.Builder()
                .putString(
                    android.support.v4.media.MediaMetadataCompat.METADATA_KEY_TITLE,
                    title
                )
                .build()
        )
    }

    private fun requestFocus() {
        audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener(focusListener)
                .build()
            audioManager?.requestAudioFocus(focusRequest!!)
        } else {
            @Suppress("DEPRECATION")
            audioManager?.requestAudioFocus(
                focusListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN
            )
        }
    }

    private fun abandonFocus() {
        val am = audioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { am.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            am.abandonAudioFocus(focusListener)
        }
    }

    // ── Notification ────────────────────────────────────────────────────

    private fun buildNotification(): Notification {
        val contentIntent = packageManager.getLaunchIntentForPackage(packageName)
            ?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE) }
        // Build the MediaStyle fluently — `setMediaSession`/`setShowActionsInCompactView`
        // are builder methods on androidx MediaStyle that return the style itself, so we
        // chain them instead of using an `apply {}` block (whose receiver resolution
        // trips the Kotlin compiler here).
        val style = MediaStyle()
            .setShowActionsInCompactView(0)
        session?.sessionToken?.let { style.setMediaSession(it) }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(if (playing) "Playing" else "Paused")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(contentIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setStyle(style)
            .build()
    }

    private fun refreshNotification() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, buildNotification())
    }
}
