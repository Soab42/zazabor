package dev.soab.zazabor.cast

import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.DataOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * The ZMIR connection to Zazabor (docs/plans/cast-receiver.md): `ZMIR/1`, a JSON hello, the PC's
 * answer, then media packets one way and `key` / `bye` lines the other.
 */
class Zmir(private val host: String, private val port: Int) : Closeable {
    companion object {
        const val DEFAULT_PORT = 47212
        const val VIDEO = 1
        const val AUDIO = 2
        const val FLAG_KEY = 1
        const val FLAG_CONFIG = 2

        /** More than this waiting to go out means the network can't keep up. */
        private const val MAX_QUEUED = 3 shl 20
        private const val ANSWER_TIMEOUT_MS = 65_000
    }

    private class Packet(val kind: Int, val flags: Int, val ptsUs: Long, val data: ByteArray)

    private val socket = Socket()
    private lateinit var input: InputStream
    private lateinit var output: DataOutputStream
    private val queue = ArrayDeque<Packet>()
    private val lock = Object()
    private var queued = 0
    /** Video is skipped until the next key frame after the queue overflowed. */
    private var needKey = false
    private val ended = AtomicBoolean(false)

    @Volatile
    var onLine: (String) -> Unit = {}

    /** Called once, with why the connection ended (null when this side closed it). */
    @Volatile
    var onEnded: (String?) -> Unit = {}

    /** The queue overflowed: the encoder should send a key frame soon. */
    @Volatile
    var onCongested: () -> Unit = {}

    fun connect() {
        socket.connect(InetSocketAddress(host, port), 5000)
        socket.tcpNoDelay = true
        socket.sendBufferSize = 1 shl 20
        input = socket.getInputStream()
        output = DataOutputStream(BufferedOutputStream(socket.getOutputStream(), 1 shl 16))
    }

    /** Says hello and waits for the PC's answer: null when allowed, else the PC's reason. */
    fun hello(hello: JSONObject): String? {
        output.write("ZMIR/1\n".toByteArray())
        output.write((hello.toString() + "\n").toByteArray())
        output.flush()
        socket.soTimeout = ANSWER_TIMEOUT_MS
        val line = readLine() ?: return "The PC closed the connection"
        socket.soTimeout = 0
        val answer = JSONObject(line)
        return if (answer.optBoolean("ok")) null else answer.optString("reason", "refused")
    }

    /** Starts sending queued packets and listening to the PC. */
    fun start() {
        thread(name = "zmir-send", isDaemon = true) {
            try {
                while (!ended.get()) {
                    val batch = take() ?: break
                    for (p in batch) {
                        output.writeByte(p.kind)
                        output.writeByte(p.flags)
                        output.writeLong(p.ptsUs)
                        output.writeInt(p.data.size)
                        output.write(p.data)
                    }
                    output.flush()
                }
            } catch (e: IOException) {
                end("Connection lost")
            }
        }
        thread(name = "zmir-read", isDaemon = true) {
            try {
                while (true) {
                    val line = readLine() ?: break
                    if (line.trim() == "bye") {
                        end("The PC stopped mirroring")
                        return@thread
                    }
                    onLine(line.trim())
                }
                end("The PC disconnected")
            } catch (e: IOException) {
                end("Connection lost")
            }
        }
    }

    /** Queues a packet; video is dropped up to the next key frame while the network is behind. */
    fun send(kind: Int, flags: Int, ptsUs: Long, data: ByteArray) {
        var congested = false
        synchronized(lock) {
            if (ended.get()) return
            if (kind == VIDEO && needKey) {
                if (flags and (FLAG_KEY or FLAG_CONFIG) == 0) return
                if (flags and FLAG_KEY != 0) needKey = false
            }
            if (queued + data.size > MAX_QUEUED) {
                // Keep codec configs and audio; drop the video that can't be shown now anyway.
                val keep = queue.filter { it.kind == AUDIO || it.flags and FLAG_CONFIG != 0 }
                queue.clear()
                queue.addAll(keep)
                queued = keep.sumOf { it.data.size }
                if (kind == VIDEO && flags and (FLAG_KEY or FLAG_CONFIG) == 0) {
                    needKey = true
                    congested = true
                }
            }
            if (!needKey || kind != VIDEO || flags != 0) {
                queue.addLast(Packet(kind, flags, ptsUs, data))
                queued += data.size
                lock.notifyAll()
            }
        }
        if (congested) onCongested()
    }

    private fun take(): List<Packet>? = synchronized(lock) {
        while (queue.isEmpty() && !ended.get()) lock.wait(500)
        if (ended.get()) return null
        val batch = ArrayList<Packet>(queue)
        queue.clear()
        queued = 0
        batch
    }

    private fun readLine(): String? {
        val bytes = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return null
            if (b == '\n'.code) break
            if (bytes.size() < 8192) bytes.write(b)
        }
        return bytes.toString("UTF-8")
    }

    private fun end(reason: String?) {
        if (!ended.compareAndSet(false, true)) return
        synchronized(lock) { lock.notifyAll() }
        try {
            socket.close()
        } catch (_: IOException) {
        }
        onEnded(reason)
    }

    /** Ends the connection from this side. */
    override fun close() = end(null)
}
