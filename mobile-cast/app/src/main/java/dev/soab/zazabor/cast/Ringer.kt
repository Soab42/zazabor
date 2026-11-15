package dev.soab.zazabor.cast

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Handler
import android.os.Looper

/**
 * "Ring my phone": the alarm sound at full alarm volume, looping until the phone is touched
 * (screen turned on or unlocked), the notification's Stop is pressed, or 30 s pass.
 */
object Ringer {
    private const val MAX_MS = 30_000L
    private val main = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private var savedVolume = -1
    private var receiver: BroadcastReceiver? = null
    private var onStopped: (() -> Unit)? = null
    private val timeout = Runnable { stopNow() }

    val ringing: Boolean get() = player != null

    /** Main thread. `onStopped` runs once when it ends (to take the notification away). */
    fun start(context: Context, onStopped: () -> Unit) {
        stopNow()
        val app = context.applicationContext
        val audio = app.getSystemService(AudioManager::class.java)
        try {
            savedVolume = audio.getStreamVolume(AudioManager.STREAM_ALARM)
            audio.setStreamVolume(AudioManager.STREAM_ALARM, audio.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
        } catch (_: SecurityException) {
            // Do Not Disturb can forbid volume changes; ring at the current volume.
            savedVolume = -1
        }
        val uri = RingtoneManager.getActualDefaultRingtoneUri(app, RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getActualDefaultRingtoneUri(app, RingtoneManager.TYPE_RINGTONE)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val p = MediaPlayer()
        try {
            p.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            p.setDataSource(app, uri)
            p.isLooping = true
            p.prepare()
            p.start()
        } catch (e: Exception) {
            p.release()
            restore(app)
            throw e
        }
        player = p
        this.onStopped = onStopped
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) = stopNow()
        }
        app.registerReceiver(r, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        })
        receiver = r
        appContext = app
        main.postDelayed(timeout, MAX_MS)
    }

    private var appContext: Context? = null

    fun stop() = main.post { stopNow() }

    private fun stopNow() {
        main.removeCallbacks(timeout)
        val p = player ?: return
        player = null
        try {
            p.stop()
        } catch (_: Exception) {
        }
        p.release()
        val app = appContext
        receiver?.let { r -> try { app?.unregisterReceiver(r) } catch (_: Exception) {} }
        receiver = null
        if (app != null) restore(app)
        onStopped?.invoke()
        onStopped = null
    }

    private fun restore(context: Context) {
        if (savedVolume >= 0) {
            try {
                context.getSystemService(AudioManager::class.java).setStreamVolume(AudioManager.STREAM_ALARM, savedVolume, 0)
            } catch (_: SecurityException) {
            }
        }
        savedVolume = -1
    }
}
