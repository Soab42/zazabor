package dev.soab.zazabor.cast

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * Phone Link (docs/plans/phone-link.md §5): a foreground service of type connectedDevice that
 * keeps the `ZLNK` link to the paired PC while there is one. It waits for Wi-Fi, finds the PC
 * over mDNS (or its last address), reconnects with backoff, answers the PC's requests and pushes
 * texts, notifications, call state and status as they happen.
 */
class LinkService : Service() {
    companion object {
        private const val TAG = "ZazaborLink"
        const val ACTION_START = "dev.soab.zazabor.cast.link.START"
        const val ACTION_PAIR = "dev.soab.zazabor.cast.link.PAIR"
        const val ACTION_PAIR_ANSWER = "dev.soab.zazabor.cast.link.PAIR_ANSWER"
        const val ACTION_REFRESH = "dev.soab.zazabor.cast.link.REFRESH"
        const val ACTION_STOP_RING = "dev.soab.zazabor.cast.link.STOP_RING"
        const val ACTION_RETRY = "dev.soab.zazabor.cast.link.RETRY"
        const val EXTRA_HOST = "host"
        const val EXTRA_PORT = "port"
        const val EXTRA_NAME = "name"
        const val EXTRA_OK = "ok"
        const val EXTRA_TEXT = "text"
        private const val CHANNEL_LINK = "link"
        private const val CHANNEL_ALERTS = "link-alerts"
        private const val NOTIFICATION = 11
        private const val NOTIFY_PAIR = 12
        const val NOTIFY_MIRROR = 13
        private const val NOTIFY_RING = 14
        private val BACKOFF_S = intArrayOf(1, 2, 5, 10, 30)

        @Volatile
        private var instance: LinkService? = null

        /** A sealed session is up and `hello` went out. */
        val linked: Boolean get() = instance?.linkedSession != null

        /** Sends a phone→PC message if linked (any thread; never blocks the caller). */
        fun emit(msg: JSONObject) {
            instance?.emitLater(msg)
        }

        private fun launch(context: Context, intent: Intent) {
            try {
                context.startForegroundService(intent)
            } catch (e: Exception) {
                // Android refuses to start foreground services from the background in some cases.
                Log.w(TAG, "couldn't start the link", e)
            }
        }

        /** Starts (or nudges) the link when a PC is paired. */
        fun start(context: Context) {
            if (LinkPrefs(context).paired) launch(context, Intent(context, LinkService::class.java).setAction(ACTION_START))
        }

        fun pair(context: Context, host: String, port: Int, name: String) {
            launch(
                context,
                Intent(context, LinkService::class.java).setAction(ACTION_PAIR)
                    .putExtra(EXTRA_HOST, host).putExtra(EXTRA_PORT, port).putExtra(EXTRA_NAME, name),
            )
        }

        /** The user's answer to the code comparison. */
        fun answerPairing(ok: Boolean) {
            instance?.pairAnswer(ok)
        }

        fun forget(context: Context) {
            LinkPrefs(context).forget()
            LinkState.set(LinkStatus.Unpaired)
            instance?.forgotten()
        }

        /** Permissions or settings changed: a new `hello` with the new caps (reconnects if they differ). */
        fun refresh(context: Context) {
            val i = instance
            if (i != null) i.refreshCaps() else start(context)
        }

        fun retry(context: Context) = launch(context, Intent(context, LinkService::class.java).setAction(ACTION_RETRY))

        /**
         * Files (or text) from the share sheet, offered to the PC one by one. The files come
         * already opened: the sharing app's uri grant ends with the share screen, an open file
         * doesn't.
         */
        fun share(files: List<SharedFile>, text: String?): Boolean {
            val i = instance ?: return false
            if (i.linkedSession == null) return false
            try {
                i.offers.execute { i.offerShared(files, text) }
            } catch (_: Exception) {
                return false
            }
            return true
        }

        /** Asks the PC to cancel pairing (or drops a pairing that waits for the PC). */
        fun cancelPairing() {
            val i = instance ?: return
            if (i.pendingAnswer != null) {
                i.pairAnswer(false)
            } else if (i.linkedSession == null) {
                i.userCancelled = true
                i.dropConnection()
            }
        }

        /** The caps the PC may use: the ones whose permission is granted. */
        fun caps(context: Context): List<String> {
            fun has(p: String) = context.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
            return buildList {
                if (has(Manifest.permission.READ_SMS)) add("sms")
                if (has(Manifest.permission.READ_CALL_LOG)) add("calls")
                if (has(Manifest.permission.READ_CONTACTS)) add("contacts")
                if (NotifListener.enabled(context)) add("notifications")
                if (PhoneFiles.allAccess(context)) add("files")
                if (PhotoLibrary.allowed(context)) add("photos")
                if (LinkPrefs(context).clip) add("clipboard")
                add("mirror")
            }
        }

        val pcName: String? get() = instance?.linkedSession?.pcName

        private class MirrorRequest(val token: String, val pc: Pc, val at: Long)

        @Volatile
        private var mirrorRequest: MirrorRequest? = null

        /**
         * The PC a `mirror.start` asked to mirror to, if `token` is the one LinkService put in its
         * intent (in memory only, single use, two minutes). Mirror targets never come from extras.
         */
        fun takeMirror(token: String?): Pc? {
            val r = mirrorRequest ?: return null
            if (token == null || !MessageDigest.isEqual(r.token.toByteArray(), token.toByteArray())) return null
            mirrorRequest = null
            return r.pc.takeIf { SystemClock.elapsedRealtime() - r.at < 120_000 }
        }
    }

    /** A shared file, opened by the share screen. `size` is -1 when unknown. */
    class SharedFile(val name: String, val size: Long, val mime: String?, val open: () -> InputStream)

    private class PairTarget(val host: String, val port: Int, val name: String)

    private class Incoming(val file: PhoneFiles.Incoming, val size: Long) {
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256")
        var got = 0L
    }

    private lateinit var prefs: LinkPrefs
    private lateinit var names: Names
    private lateinit var sms: Sms
    private val main = Handler(Looper.getMainLooper())
    private val eventsThread = HandlerThread("link-events").apply { start() }
    private val events = Handler(eventsThread.looper)
    private val requests = Executors.newFixedThreadPool(4)
    private val sender = Executors.newSingleThreadExecutor()
    private val offers = Executors.newSingleThreadExecutor()

    private val wake = Object()
    @Volatile private var running = false
    private var loop: Thread? = null
    @Volatile private var pairRequest: PairTarget? = null
    @Volatile private var socket: Socket? = null
    @Volatile private var session: Session? = null
    @Volatile private var linkedSession: Session? = null
    @Volatile private var linkedHost: String? = null
    @Volatile private var blocked = false
    @Volatile private var quickRetry = false
    @Volatile private var sentCaps: List<String> = emptyList()
    @Volatile private var pendingAnswer: ((Boolean) -> Unit)? = null
    @Volatile private var pairingWith = ""
    @Volatile private var userCancelled = false

    private val wifiNetworks = ConcurrentHashMap.newKeySet<Network>()
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var discovery: Discovery? = null
    @Volatile private var found: Map<String, Pc> = emptyMap()
    private var status: PhoneStatus? = null

    private val incoming = ConcurrentHashMap<Int, Incoming>()
    private val cancelled = ConcurrentHashMap.newKeySet<Int>()
    private val offered = ConcurrentHashMap<Int, CompletableFuture<Boolean>>()
    private val nextXfer = AtomicInteger(1)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        prefs = LinkPrefs(this)
        names = Names(this)
        sms = Sms(this, names)
        watchWifi()
        discovery = Discovery(this, Discovery.LINK) { list ->
            found = list.associateBy { it.key }
            if (prefs.pcId in found && linkedSession == null) poke()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        foreground(LinkState.status)
        when (intent?.action) {
            ACTION_PAIR -> {
                val host = intent.getStringExtra(EXTRA_HOST)
                if (host != null) {
                    pairRequest = PairTarget(host, intent.getIntExtra(EXTRA_PORT, Link.DEFAULT_PORT), intent.getStringExtra(EXTRA_NAME) ?: host)
                    blocked = false
                    dropConnection()
                }
            }
            ACTION_PAIR_ANSWER -> pairAnswer(intent.getBooleanExtra(EXTRA_OK, false))
            ACTION_RETRY -> {
                blocked = false
                quickRetry = true
            }
            ACTION_REFRESH -> refreshCaps()
            ACTION_STOP_RING -> Ringer.stop()
        }
        ensureLoop()
        poke()
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        poke()
        dropConnection()
        networkCallback?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        main.post { discovery?.stop() }
        Ringer.stop()
        requests.shutdownNow()
        sender.shutdownNow()
        offers.shutdownNow()
        eventsThread.quitSafely()
        if (instance === this) instance = null
        if (!LinkPrefs(this).paired) LinkState.set(LinkStatus.Unpaired)
        super.onDestroy()
    }

    // ---- the connection loop ----

    private fun ensureLoop() {
        synchronized(this) {
            if (loop?.isAlive == true) return
            running = true
            loop = thread(name = "zlnk-loop") { runLoop() }
        }
    }

    private fun poke() = synchronized(wake) { wake.notifyAll() }

    private fun pause(ms: Long) {
        if (ms <= 0) return
        synchronized(wake) { wake.wait(ms) }
    }

    private fun dropConnection() {
        session?.close()
        try {
            socket?.close()
        } catch (_: IOException) {
        }
        pendingAnswer = null
        poke()
    }

    private fun runLoop() {
        var attempt = 0
        main.post { discovery?.start() }
        while (running) {
            val pairing = pairRequest
            if (pairing != null) {
                pairRequest = null
                runPairing(pairing)
                attempt = 0
                continue
            }
            val pcId = prefs.pcId
            if (pcId == null) {
                if (pairRequest == null) {
                    finishService()
                    return
                }
                continue
            }
            val pc = prefs.pcName
            if (blocked) {
                pause(60_000)
                continue
            }
            if (wifiNetworks.isEmpty()) {
                setStatus(LinkStatus.Waiting(pc, "Waiting for Wi-Fi"))
                pause(60_000)
                continue
            }
            val seen = found[pcId]
            val host = seen?.host ?: prefs.host
            val port = seen?.port ?: prefs.port
            if (host == null) {
                setStatus(LinkStatus.Waiting(pc, "Looking for $pc on this Wi-Fi…"))
                pause(15_000)
                continue
            }
            setStatus(LinkStatus.Waiting(pc, "Connecting…"))
            val started = SystemClock.elapsedRealtime()
            var problem: String? = null
            try {
                val s = Link.handshake(open(host, port), Identity.info(this), false, prefs::key, null, { _, _, _ -> })
                if (s.pcId != pcId) {
                    s.close()
                    throw IOException("A different PC answered at $host")
                }
                prefs.seen(s.pcName, host, port)
                if (!runSession(s, host)) {
                    forgotUs(s.pcName)
                    continue
                }
            } catch (e: NeedsPairing) {
                forgotUs(e.pcName)
                continue
            } catch (e: LinkRefused) {
                problem = e.reason
            } catch (e: Exception) {
                if (!running) break
                problem = friendly(e, pc, host, port)
            }
            if (!running || pairRequest != null) continue
            if (SystemClock.elapsedRealtime() - started > 15_000) attempt = 0
            if (quickRetry) {
                quickRetry = false
                attempt = 0
                pause(300)
                continue
            }
            val delay = BACKOFF_S[minOf(attempt, BACKOFF_S.size - 1)]
            attempt++
            setStatus(LinkStatus.Waiting(pc, (problem ?: "Disconnected") + ". Trying again in $delay s"))
            pause(delay * 1000L)
        }
    }

    private fun open(host: String, port: Int): Socket {
        val s = Link.open(host, port) { sock ->
            wifiNetworks.firstOrNull()?.let { n ->
                try {
                    n.bindSocket(sock)
                } catch (_: Exception) {
                }
            }
        }
        socket = s
        return s
    }

    private fun forgotUs(pc: String) {
        blocked = true
        setStatus(LinkStatus.Problem(pc, "This PC forgot this phone. Pair again.", repair = true))
    }

    private fun finishService() {
        running = false
        LinkState.set(LinkStatus.Unpaired)
        main.post {
            if (pairRequest == null && !LinkPrefs(this).paired) {
                discovery?.stop()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            } else {
                ensureLoop()
            }
        }
    }

    private fun forgotten() {
        blocked = false
        dropConnection()
    }

    private fun runPairing(target: PairTarget) {
        pairingWith = target.name
        userCancelled = false
        setStatus(LinkStatus.Pairing(target.name, null))
        try {
            val s = Link.handshake(
                open(target.host, target.port), Identity.info(this), true, prefs::key, pairer,
                { id, name, key -> prefs.paired(id, name, target.host, target.port, key) },
            )
            if (prefs.pcId != s.pcId) {
                // The PC already knew this phone and skipped pairing.
                prefs.key(s.pcId)?.let { prefs.paired(s.pcId, s.pcName, target.host, target.port, it) }
            }
            blocked = false
            LinkState.notice("Paired with ${s.pcName}")
            if (!runSession(s, target.host)) forgotUs(s.pcName)
        } catch (e: PairDeclined) {
            LinkState.notice(if (e.byPc) "${target.name} cancelled pairing" else "Pairing cancelled")
        } catch (e: LinkRefused) {
            LinkState.notice(e.reason)
        } catch (e: Exception) {
            if (userCancelled) {
                LinkState.notice("Pairing cancelled")
            } else if (running) {
                LinkState.notice("Couldn't pair: ${friendly(e, target.name, target.host, target.port)}")
            }
        } finally {
            cancelNotification(NOTIFY_PAIR)
            pendingAnswer = null
        }
        if (!prefs.paired) LinkState.set(LinkStatus.Unpaired)
    }

    private val pairer = object : Pairer {
        override fun ask(pcId: String, pcName: String, code: Int, answer: (Boolean) -> Unit) {
            pendingAnswer = answer
            pairingWith = pcName
            setStatus(LinkStatus.Pairing(pcName, code))
            if (!MainActivity.visible) pairNotification(pcName, code)
        }

        override fun cancel() {
            pendingAnswer = null
            cancelNotification(NOTIFY_PAIR)
        }
    }

    private fun pairAnswer(ok: Boolean) {
        val answer = pendingAnswer ?: return
        pendingAnswer = null
        cancelNotification(NOTIFY_PAIR)
        if (ok) setStatus(LinkStatus.Pairing(pairingWith, null))
        answer(ok)
    }

    // ---- a live session ----

    /** Runs until the link drops. False when the PC closed it at once without a frame (it forgot us). */
    private fun runSession(s: Session, host: String): Boolean {
        session = s
        val started = SystemClock.elapsedRealtime()
        val framesBefore = s.framesReceived
        try {
            sentCaps = caps(this)
            s.send(hello(sentCaps))
            linkedHost = host
            linkedSession = s
            setStatus(LinkStatus.Linked(s.pcName))
            events.post { startWatchers() }
            main.post { discovery?.stop() }
            s.run(::onMessage, ::onData)
        } catch (e: IOException) {
            Log.i(TAG, "link ended: ${e.message}")
        } finally {
            linkedSession = null
            session = null
            linkedHost = null
            events.post { stopWatchers() }
            abortTransfers()
            if (running) main.post { discovery?.start() }
        }
        return !(s.framesReceived == framesBefore && SystemClock.elapsedRealtime() - started < 10_000 && running && pairRequest == null)
    }

    private fun hello(caps: List<String>): JSONObject {
        val version = try {
            packageManager.getPackageInfo(packageName, 0).versionName
        } catch (_: Exception) {
            null
        }
        return JSONObject()
            .put("t", "hello")
            .put("name", Identity.deviceName(this))
            .put("model", Identity.model())
            .put("android", Build.VERSION.SDK_INT)
            .put("app", version ?: "")
            .put("caps", JSONArray(caps))
    }

    private fun refreshCaps() {
        val s = linkedSession ?: return
        if (caps(this) != sentCaps) {
            // A fresh hello on a fresh connection carries the new caps.
            quickRetry = true
            s.close()
        }
        updateNotification()
    }

    private fun startWatchers() {
        if (linkedSession == null) return
        sms.watch(events) { msg -> emitLater(JSONObject().put("t", "sms.new").put("msg", msg)) }
        status?.stop()
        status = PhoneStatus(this, events, names, ::emitLater, ::emitLater).also { it.start() }
        NotifListener.instance?.resetSent()
    }

    private fun stopWatchers() {
        sms.unwatch()
        status?.stop()
        status = null
    }

    private fun emitLater(msg: JSONObject) {
        val s = linkedSession ?: return
        try {
            sender.execute {
                try {
                    s.send(msg)
                } catch (_: IOException) {
                    s.close()
                }
            }
        } catch (_: Exception) {
        }
    }

    private fun onMessage(msg: JSONObject) {
        val s = linkedSession ?: return
        when (msg.optString("t")) {
            "file.accept" -> offered[msg.optInt("xfer")]?.complete(true)
            "file.reject" -> offered[msg.optInt("xfer")]?.complete(false)
            "file.end" -> endIncoming(s, msg.optInt("xfer"), msg.optString("sha256"))
            "xfer.cancel" -> cancelTransfer(msg.optInt("xfer"))
            "re", "hello", "status" -> {}
            "clip" -> {
                setClip(msg.optString("text"))
                if (msg.has("rid")) answer(s, msg)
            }
            else -> if (msg.has("rid")) answer(s, msg)
        }
    }

    private fun answer(s: Session, msg: JSONObject) {
        try {
            requests.execute { handle(s, msg) }
        } catch (_: Exception) {
        }
    }

    private fun handle(s: Session, msg: JSONObject) {
        val t = msg.optString("t")
        val re = JSONObject().put("t", "re").put("rid", msg.opt("rid"))
        var after: (() -> Unit)? = null
        try {
            when (t) {
                "sms.threads" -> re.put("threads", sms.threads(msg.optInt("limit", 50)))
                "sms.thread" -> re.put(
                    "msgs",
                    sms.thread(msg.getLong("threadId"), if (msg.isNull("before")) null else msg.getLong("before"), msg.optInt("limit", 50)),
                )
                "sms.send" -> {
                    val to = msg.getJSONArray("to")
                    sms.send((0 until to.length()).map { to.getString(it) }, msg.getString("body"))
                }
                "sms.read" -> sms.markRead(msg.getLong("threadId"))
                "calls.list" -> re.put("calls", CallHistory.list(this, names, msg.optInt("limit", 100)))
                "contacts.list" -> re.put("contacts", PhoneContacts.list(this))
                "contact.photo" -> re.put("jpeg", PhoneContacts.photo(this, msg.getLong("id")) ?: JSONObject.NULL)
                "wallpaper" -> re.put("jpeg", PhoneWallpaper.jpeg(this) ?: JSONObject.NULL)
                "notif.list" -> re.put("notifs", listener().list())
                "notif.dismiss" -> listener().dismiss(msg.getString("key"))
                "notif.action" -> listener().act(
                    msg.getString("key"), msg.getInt("action"), if (msg.isNull("text")) null else msg.optString("text"),
                )
                "photos.list" -> re.put("photos", PhotoLibrary.list(this, msg.optInt("offset", 0), msg.optInt("limit", 60)))
                "photo.view" -> re.put("jpeg", PhotoLibrary.view(this, msg.getString("uri"), msg.optInt("max", 1600)) ?: JSONObject.NULL)
                "files.list" -> re.put("entries", PhoneFiles.list(this, msg.optString("path", "")))
                "files.get" -> {
                    val xfer = msg.getInt("xfer")
                    val (size, input) = PhoneFiles.openForRead(this, msg.getString("path"))
                    re.put("size", if (size >= 0) size else JSONObject.NULL)
                    after = { stream(s, xfer, input) }
                }
                "files.put" -> {
                    val xfer = msg.getInt("xfer")
                    val file = PhoneFiles.create(this, if (msg.isNull("dir")) null else msg.optString("dir"), msg.getString("name"))
                    incoming[xfer] = Incoming(file, msg.optLong("size", -1))
                    re.put("path", file.path)
                }
                "files.delete" -> PhoneFiles.delete(this, msg.getString("path"))
                "call.dial" -> PhoneStatus.dial(this, msg.getString("number"))
                "call.answer" -> PhoneStatus.answer(this)
                "call.end" -> PhoneStatus.end(this)
                "ring" -> ring()
                "mirror.start" -> startMirror(msg)
                "clip" -> {}
                else -> throw IllegalArgumentException("Zazabor Link doesn't know “$t” (update the app)")
            }
            re.put("ok", true)
        } catch (e: Exception) {
            Log.w(TAG, "$t failed", e)
            re.put("ok", false).put("error", errorText(e))
            after = null
        }
        try {
            s.send(re)
            after?.invoke()
        } catch (_: IOException) {
        }
    }

    private fun errorText(e: Exception): String = when (e) {
        is NotAllowed -> e.message ?: "Not allowed on the phone"
        is SecurityException -> "Zazabor Link isn't allowed to do that on the phone"
        is org.json.JSONException -> "Bad request: ${e.message}"
        else -> e.message ?: e.javaClass.simpleName
    }

    private fun listener(): NotifListener =
        NotifListener.instance ?: throw NotAllowed("Allow notification access for Zazabor Link on the phone")

    // ---- transfers ----

    /** Sends a file as 2-frames, then `file.end` with its SHA-256. */
    private fun stream(s: Session, xfer: Int, input: InputStream) {
        val digest = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(Link.MAX_CHUNK)
        try {
            input.use {
                while (true) {
                    if (xfer in cancelled) return
                    var n = 0
                    while (n < buf.size) {
                        val r = it.read(buf, n, buf.size - n)
                        if (r < 0) break
                        n += r
                    }
                    if (n == 0) break
                    digest.update(buf, 0, n)
                    s.sendData(xfer, buf, 0, n)
                    if (n < buf.size) break
                }
            }
            s.send(JSONObject().put("t", "file.end").put("xfer", xfer).put("sha256", ZlnkCrypto.hex(digest.digest())))
        } catch (e: IOException) {
            Log.w(TAG, "transfer $xfer failed", e)
            if (s.isOpen) {
                try {
                    s.send(JSONObject().put("t", "xfer.cancel").put("xfer", xfer))
                } catch (_: IOException) {
                }
            }
        } finally {
            cancelled.remove(xfer)
        }
    }

    private fun onData(xfer: Int, data: ByteArray, offset: Int, length: Int) {
        val inc = incoming[xfer] ?: return
        try {
            inc.file.output.write(data, offset, length)
            inc.digest.update(data, offset, length)
            inc.got += length
            if (inc.size >= 0 && inc.got > inc.size) throw IOException("More data than announced")
        } catch (e: Exception) {
            incoming.remove(xfer)
            inc.file.abort()
            emitLater(JSONObject().put("t", "xfer.cancel").put("xfer", xfer))
        }
    }

    private fun endIncoming(s: Session, xfer: Int, sha256: String) {
        val inc = incoming.remove(xfer) ?: return
        val hash = ZlnkCrypto.hex(inc.digest.digest())
        val ok = hash.equals(sha256, ignoreCase = true) && (inc.size < 0 || inc.got == inc.size)
        if (ok) {
            try {
                inc.file.finish()
                return
            } catch (e: Exception) {
                Log.w(TAG, "couldn't save $xfer", e)
            }
        } else {
            inc.file.abort()
        }
        emitLater(JSONObject().put("t", "xfer.cancel").put("xfer", xfer))
    }

    private fun cancelTransfer(xfer: Int) {
        incoming.remove(xfer)?.file?.abort()
        offered[xfer]?.complete(false)
        cancelled += xfer
    }

    private fun abortTransfers() {
        for (inc in incoming.values) inc.file.abort()
        incoming.clear()
        for (f in offered.values) f.complete(false)
    }

    /** The share sheet's files (or its text as a .txt file), offered one at a time. */
    private fun offerShared(files: List<SharedFile>, text: String?) {
        var sent = 0
        for (f in files) {
            try {
                if (f.size >= 0) {
                    if (offer(f.name, f.size, f.mime, f.open)) sent++
                } else {
                    // Unknown length: copy it first so the offer can say how big it is.
                    val tmp = File.createTempFile("share", null, cacheDir)
                    try {
                        f.open().use { input -> tmp.outputStream().use { input.copyTo(it) } }
                        if (offer(f.name, tmp.length(), f.mime) { tmp.inputStream() }) sent++
                    } finally {
                        tmp.delete()
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "couldn't send ${f.name}", e)
                LinkState.notice("Couldn't send ${f.name}: ${e.message ?: e.javaClass.simpleName}")
            }
        }
        if (text != null && files.isEmpty()) {
            val bytes = text.toByteArray(Charsets.UTF_8)
            try {
                if (offer("Shared text.txt", bytes.size.toLong(), "text/plain") { bytes.inputStream() }) sent++
            } catch (e: Exception) {
                LinkState.notice("Couldn't send the text: ${e.message}")
            }
        }
        if (sent > 0) LinkState.notice(if (sent == 1) "Sent to the PC" else "Sent $sent files to the PC")
    }

    /** Offers one file and streams it if the PC accepts. False when it declined or went away. */
    private fun offer(name: String, size: Long, mime: String?, open: () -> InputStream): Boolean {
        val s = linkedSession ?: throw IOException("Not linked to a PC")
        val xfer = nextXfer.getAndAdd(2)
        val accepted = CompletableFuture<Boolean>()
        offered[xfer] = accepted
        try {
            s.send(
                JSONObject().put("t", "file.offer").put("xfer", xfer).put("name", name).put("size", size)
                    .put("mime", mime ?: PhoneFiles.mime(name) ?: "application/octet-stream"),
            )
            val ok = try {
                accepted.get(5, TimeUnit.MINUTES)
            } catch (_: Exception) {
                false
            }
            if (!ok) return false
        } finally {
            offered.remove(xfer)
        }
        stream(s, xfer, open())
        return s.isOpen
    }

    // ---- small requests ----

    private fun ring() {
        main.post {
            try {
                Ringer.start(this) { cancelNotification(NOTIFY_RING) }
                val stop = PendingIntent.getService(
                    this, 3, Intent(this, LinkService::class.java).setAction(ACTION_STOP_RING), PendingIntent.FLAG_IMMUTABLE,
                )
                notify(
                    NOTIFY_RING,
                    alert("Your PC is ringing this phone", "Tap to stop")
                        .setContentIntent(stop)
                        .setDeleteIntent(stop)
                        .addAction(Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_stop), "Stop", stop).build())
                        .build(),
                )
            } catch (e: Exception) {
                Log.w(TAG, "couldn't ring", e)
            }
        }
    }

    /**
     * `mirror.start`: the normal mirroring flow (it asks for screen capture), aimed at the linked
     * PC's address. The screen gets only a one-time token; the target stays here.
     */
    private fun startMirror(msg: JSONObject) {
        val host = linkedHost ?: throw IOException("Not linked")
        val pcId = prefs.pcId ?: throw IOException("Not paired")
        val port = msg.optInt("port", 0).takeIf { it in 1..65535 } ?: Zmir.DEFAULT_PORT
        val name = prefs.pcName
        val token = ZlnkCrypto.hex(ByteArray(16).also { java.security.SecureRandom().nextBytes(it) })
        mirrorRequest = MirrorRequest(token, Pc("link:$pcId", name, host, port), SystemClock.elapsedRealtime())
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_MIRROR_TOKEN, token)
        if (MainActivity.visible) {
            startActivity(intent)
            return
        }
        // Android doesn't let a background app open screens; a tap on this starts it.
        val open = PendingIntent.getActivity(this, 4, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        notify(NOTIFY_MIRROR, alert("Mirror this screen to $name?", "Tap to start screen mirroring").setContentIntent(open).setAutoCancel(true).build())
        try {
            startActivity(intent)
        } catch (_: Exception) {
        }
    }

    private fun setClip(text: String) {
        if (!prefs.clip || text.isEmpty()) return
        main.post {
            try {
                getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("From the PC", text))
            } catch (_: Exception) {
            }
        }
    }

    // ---- Wi-Fi ----

    private fun watchWifi() {
        val cm = getSystemService(ConnectivityManager::class.java)
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                wifiNetworks += network
                quickRetry = true
                poke()
            }

            override fun onLost(network: Network) {
                wifiNetworks -= network
                if (wifiNetworks.isEmpty()) dropConnection()
            }
        }
        cm.registerNetworkCallback(NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), cb)
        networkCallback = cb
    }

    // ---- notifications ----

    private fun channels() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_LINK) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_LINK, "Phone Link", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while this phone is linked to a PC"
                    setShowBadge(false)
                },
            )
        }
        if (manager.getNotificationChannel(CHANNEL_ALERTS) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ALERTS, "Pairing and requests", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Pairing codes, mirroring requests and ring my phone"
                },
            )
        }
    }

    private fun setStatus(s: LinkStatus) {
        LinkState.set(s)
        updateNotification()
    }

    private fun updateNotification() {
        if (!running && LinkState.status is LinkStatus.Unpaired) return
        notify(NOTIFICATION, linkNotification(LinkState.status))
    }

    private fun foreground(s: LinkStatus) {
        try {
            startForeground(NOTIFICATION, linkNotification(s), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } catch (e: Exception) {
            Log.w(TAG, "couldn't go foreground", e)
        }
    }

    private fun linkNotification(s: LinkStatus): Notification {
        channels()
        val (title, text) = when (s) {
            is LinkStatus.Linked -> "Linked to ${s.pc}" to "Texts, calls and notifications show on ${s.pc}"
            is LinkStatus.Waiting -> "Zazabor Link" to s.detail
            is LinkStatus.Pairing -> "Pairing with ${s.pc}…" to "Compare the code on both screens"
            is LinkStatus.Problem -> "Zazabor Link" to s.detail
            LinkStatus.Unpaired -> "Zazabor Link" to "Not linked"
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_LINK)
            .setSmallIcon(R.drawable.ic_link)
            .setContentTitle(title)
            .setContentText(text)
            .setColor(getColor(R.color.accent))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setContentIntent(open)
            .apply {
                if (s is LinkStatus.Linked && prefs.clip) {
                    val clip = PendingIntent.getActivity(
                        this@LinkService, 5, Intent(this@LinkService, ClipActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        PendingIntent.FLAG_IMMUTABLE,
                    )
                    addAction(Notification.Action.Builder(Icon.createWithResource(this@LinkService, R.drawable.ic_link), "Send clipboard", clip).build())
                }
            }
            .build()
    }

    private fun alert(title: String, text: String): Notification.Builder {
        channels()
        return Notification.Builder(this, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_link)
            .setContentTitle(title)
            .setContentText(text)
            .setColor(getColor(R.color.accent))
            .setCategory(Notification.CATEGORY_STATUS)
    }

    private fun pairNotification(pc: String, code: Int) {
        fun answer(ok: Boolean, request: Int) = PendingIntent.getService(
            this, request, Intent(this, LinkService::class.java).setAction(ACTION_PAIR_ANSWER).putExtra(EXTRA_OK, ok),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val open = PendingIntent.getActivity(
            this, 6, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE,
        )
        notify(
            NOTIFY_PAIR,
            alert("Pair with $pc?", "Does $pc show ${ZlnkCrypto.formatCode(code)}?")
                .setContentIntent(open)
                .setOngoing(true)
                .addAction(Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_link), "Pair", answer(true, 7)).build())
                .addAction(Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_stop), "Cancel", answer(false, 8)).build())
                .build(),
        )
    }

    private fun notify(id: Int, n: Notification) {
        try {
            getSystemService(NotificationManager::class.java).notify(id, n)
        } catch (_: Exception) {
        }
    }

    private fun cancelNotification(id: Int) {
        getSystemService(NotificationManager::class.java).cancel(id)
    }

    private fun friendly(e: Exception, pc: String, host: String, port: Int): String = when (e) {
        is ConnectException, is NoRouteToHostException -> "Can't reach $pc ($host:$port). Is Phone Link on in Zazabor Home?"
        is SocketTimeoutException -> "$pc didn't answer"
        is java.net.UnknownHostException -> "Unknown address $host"
        else -> e.message ?: e.javaClass.simpleName
    }
}
