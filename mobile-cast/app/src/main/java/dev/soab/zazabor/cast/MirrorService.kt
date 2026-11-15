package dev.soab.zazabor.cast

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.provider.Settings
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import org.json.JSONObject
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Mirrors the screen (and the sound other apps play) to one PC: a VirtualDisplay into an H.264
 * encoder, AudioPlaybackCapture into AAC, both sent over ZMIR. Runs as a foreground service of
 * type mediaProjection with an ongoing notification that can stop it.
 */
class MirrorService : Service() {
    companion object {
        const val ACTION_START = "dev.soab.zazabor.cast.START"
        const val ACTION_STOP = "dev.soab.zazabor.cast.STOP"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_DATA = "data"
        const val EXTRA_HOST = "host"
        const val EXTRA_PORT = "port"
        const val EXTRA_NAME = "name"
        private const val CHANNEL = "mirroring"
        private const val NOTIFICATION = 1
        private const val TAG = "ZazaborCast"

        fun start(context: Context, pc: Pc, resultCode: Int, data: Intent) {
            val intent = Intent(context, MirrorService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_DATA, data)
                .putExtra(EXTRA_HOST, pc.host)
                .putExtra(EXTRA_PORT, pc.port)
                .putExtra(EXTRA_NAME, pc.name)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, MirrorService::class.java).setAction(ACTION_STOP))
        }
    }

    private val ended = AtomicBoolean(false)
    private var started = false
    private lateinit var pcName: String
    private val events = HandlerThread("mirror-events").apply { start() }
    private val handler = Handler(events.looper)

    @Volatile private var projection: MediaProjection? = null
    @Volatile private var display: VirtualDisplay? = null
    @Volatile private var video: VideoEncoder? = null
    @Volatile private var audio: AudioEncoder? = null
    @Volatile private var connection: Zmir? = null
    private var displayListener: DisplayManager.DisplayListener? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                if (started) finish(null) else stopSelf()
            }
            ACTION_START -> {
                if (started) return START_NOT_STICKY
                started = true
                pcName = intent.getStringExtra(EXTRA_NAME) ?: "PC"
                val host = intent.getStringExtra(EXTRA_HOST) ?: ""
                val port = intent.getIntExtra(EXTRA_PORT, Zmir.DEFAULT_PORT)
                MirrorState.set(MirrorStatus.Connecting(pcName))
                // The foreground service must run before the projection is taken (Android 14).
                startForeground(NOTIFICATION, notification("Connecting to $pcName…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
                val data = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(EXTRA_DATA, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION") intent.getParcelableExtra(EXTRA_DATA)
                }
                val code = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
                val manager = getSystemService(MediaProjectionManager::class.java)
                val projection = data?.let {
                    try {
                        manager.getMediaProjection(code, it)
                    } catch (e: Exception) {
                        Log.w(TAG, "no projection", e)
                        null
                    }
                }
                if (projection == null) {
                    finish("Screen capture wasn't allowed")
                    return START_NOT_STICKY
                }
                projection.registerCallback(object : MediaProjection.Callback() {
                    override fun onStop() = finish(null)
                }, handler)
                this.projection = projection
                thread(name = "mirror-start") { run(host, port, projection) }
            }
            else -> if (!started) stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun run(host: String, port: Int, projection: MediaProjection) {
        try {
            val size = captureSize()
            val record = if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                AudioEncoder.capture(projection)
            } else {
                null
            }
            val zmir = Zmir(host, port)
            connection = zmir
            zmir.connect()
            if (ended.get()) return
            MirrorState.set(MirrorStatus.Waiting(pcName))
            notify("Waiting for $pcName to allow…")
            val hello = JSONObject()
                .put("name", deviceName())
                .put("id", deviceId())
                .put("width", size.width)
                .put("height", size.height)
                .put("audio", record != null)
                .put("sampleRate", AudioEncoder.RATE)
                .put("channels", AudioEncoder.CHANNELS)
            val refusal = zmir.hello(hello)
            if (refusal != null) {
                record?.release()
                finish(if (refusal == "declined") "$pcName declined" else refusal)
                return
            }
            if (ended.get()) {
                record?.release()
                return
            }
            zmir.onLine = { line -> if (line == "key") video?.requestKeyFrame() }
            zmir.onCongested = { video?.requestKeyFrame() }
            zmir.onEnded = { reason -> if (reason != null) finish(reason) }
            zmir.start()

            handler.post {
                if (ended.get()) return@post
                try {
                    val encoder = VideoEncoder(size, zmir::send)
                    val surface = encoder.start()
                    video = encoder
                    display = projection.createVirtualDisplay(
                        "Zazabor Cast", encoder.width, encoder.height, size.dpi,
                        DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, null, handler,
                    )
                    watchRotation()
                } catch (e: Exception) {
                    Log.w(TAG, "couldn't start the screen", e)
                    finish("Couldn't capture the screen: ${e.message ?: e.javaClass.simpleName}")
                }
            }
            if (record != null) {
                val encoder = AudioEncoder(record, zmir::send)
                encoder.start()
                audio = encoder
            }
            MirrorState.set(MirrorStatus.Mirroring(pcName, record != null))
            notify(if (record != null) "Mirroring screen and sound to $pcName" else "Mirroring the screen to $pcName (no sound)")
        } catch (e: Exception) {
            Log.w(TAG, "mirroring failed", e)
            finish(friendly(e, host, port))
        }
    }

    /** On rotation the encoder restarts at the new size; the display keeps its projection. */
    private fun watchRotation() {
        val displays = getSystemService(DisplayManager::class.java)
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) {}
            override fun onDisplayRemoved(displayId: Int) {}
            override fun onDisplayChanged(displayId: Int) {
                if (displayId != Display.DEFAULT_DISPLAY || ended.get()) return
                val old = video ?: return
                val size = captureSize()
                if (size.width == old.requested.width && size.height == old.requested.height) return
                restartVideo(size)
            }
        }
        displays.registerDisplayListener(listener, handler)
        displayListener = listener
    }

    private fun restartVideo(size: CaptureSize) {
        val zmir = connection ?: return
        val virtual = display ?: return
        try {
            virtual.surface = null
            video?.stop()
            val encoder = VideoEncoder(size, zmir::send)
            val surface = encoder.start()
            video = encoder
            virtual.resize(encoder.width, encoder.height, size.dpi)
            virtual.surface = surface
        } catch (e: Exception) {
            Log.w(TAG, "couldn't restart the encoder", e)
            finish("The video encoder stopped")
        }
    }

    private fun captureSize(): CaptureSize {
        val metrics = DisplayMetrics()
        val screen = getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
        @Suppress("DEPRECATION") screen.getRealMetrics(metrics)
        return CaptureSize.of(metrics.widthPixels, metrics.heightPixels, metrics.densityDpi)
    }

    /** Ends mirroring; `reason` is shown (null: the user stopped it). */
    private fun finish(reason: String?) {
        if (!ended.compareAndSet(false, true)) return
        val name = if (::pcName.isInitialized) pcName else "PC"
        MirrorState.set(MirrorStatus.Ended(name, reason ?: "Stopped"))
        handler.post {
            displayListener?.let { getSystemService(DisplayManager::class.java).unregisterDisplayListener(it) }
            connection?.close()
            display?.release()
            video?.stop()
            audio?.stop()
            projection?.stop()
            display = null
            video = null
            audio = null
            projection = null
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    override fun onDestroy() {
        finish(null)
        events.quitSafely()
        super.onDestroy()
    }

    private fun friendly(e: Exception, host: String, port: Int): String = when (e) {
        is ConnectException, is NoRouteToHostException ->
            "Couldn't reach $host:$port. In Zazabor Home, turn on Video → Network Streams → Cast to this PC."
        is SocketTimeoutException -> "$pcName didn't answer"
        is UnknownHostException -> "Unknown address $host"
        else -> e.message ?: e.javaClass.simpleName
    }

    private fun deviceName(): String =
        Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() } ?: Build.MODEL

    /**
     * The hello's `id`: a secret this phone makes once (256 random bits, hex) and keeps in the
     * app's private preferences (no backup). The PC remembers only its hash for "Always allow", so
     * it is never shown, advertised or sent anywhere but in the hello.
     */
    private fun deviceId(): String {
        val prefs = getSharedPreferences("cast", MODE_PRIVATE)
        prefs.getString("mirrorSecret", null)?.let { return it }
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val secret = bytes.joinToString("") { "%02x".format(it) }
        prefs.edit().putString("mirrorSecret", secret).commit()
        return secret
    }

    private fun notify(text: String) {
        if (ended.get()) return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification(text))
    }

    private fun notification(text: String): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Screen mirroring", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while this phone mirrors to a PC"
                },
            )
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, MirrorService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_cast)
            .setContentTitle("Zazabor Cast")
            .setContentText(text)
            .setColor(getColor(R.color.accent))
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_stop), "Stop", stop).build())
            .apply { if (Build.VERSION.SDK_INT >= 31) setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE) }
            .build()
    }
}
