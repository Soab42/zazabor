package dev.soab.zazabor.cast

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/** Who this phone is in the handshake line. */
data class PhoneInfo(val phoneId: String, val name: String, val model: String)

/** The PC said no (`{"ok":false,"reason"}`). */
class LinkRefused(val reason: String) : IOException(reason)

/** The PC wants to pair but this connection didn't ask to (or the phone has no key for it). */
class NeedsPairing(val pcId: String, val pcName: String) : IOException("Pair again")

/** Someone pressed Cancel on the code comparison. */
class PairDeclined(val byPc: Boolean) : IOException(if (byPc) "The PC cancelled pairing" else "Pairing cancelled")

/** Shows the six-digit comparison to the user. */
interface Pairer {
    /** Shows the code; `answer` is called once with the user's choice (on any thread). */
    fun ask(pcId: String, pcName: String, code: Int, answer: (Boolean) -> Unit)

    /** Takes the prompt away (the PC answered first, or the connection dropped). */
    fun cancel()
}

/**
 * The phone's end of `ZLNK/1` (docs/plans/phone-link.md §1): the plaintext handshake, pairing by
 * numeric comparison, then sealed frames. Plain JDK + org.json so the JVM tests can drive it.
 */
object Link {
    const val DEFAULT_PORT = 47213
    const val KIND_JSON = 1
    const val KIND_DATA = 2
    const val MAX_BODY = (1 shl 20) + ZlnkCrypto.TAG_BYTES
    const val MAX_CHUNK = 256 * 1024
    private const val ANSWER_TIMEOUT_MS = 15_000
    private const val PAIR_TIMEOUT_S = 130L

    fun b64(b: ByteArray): String = Base64.getEncoder().encodeToString(b)
    fun unb64(s: String): ByteArray = Base64.getDecoder().decode(s)

    /** `prepare` runs before connecting (the phone binds the socket to the Wi-Fi network). */
    fun open(host: String, port: Int, timeoutMs: Int = 5000, prepare: (Socket) -> Unit = {}): Socket = Socket().apply {
        prepare(this)
        connect(InetSocketAddress(host, port), timeoutMs)
        tcpNoDelay = true
        keepAlive = true
    }

    /**
     * Runs the handshake on a connected socket and returns the sealed session. With `wantPair`
     * (or when the PC asks for it) the `pairer` shows the code; `onPaired` stores the new linkKey
     * once both sides said `pair.ok`. The caller sends `hello` next.
     */
    fun handshake(
        socket: Socket,
        me: PhoneInfo,
        wantPair: Boolean,
        keyFor: (String) -> ByteArray?,
        pairer: Pairer?,
        onPaired: (pcId: String, pcName: String, linkKey: ByteArray) -> Unit,
        phoneNonce: ByteArray = ByteArray(16).also { SecureRandom().nextBytes(it) },
    ): Session {
        socket.soTimeout = ANSWER_TIMEOUT_MS
        // A fresh key pair per connection, committed to in the hello before the PC's key is seen
        // (§1 "Commitment"), so nobody posing as the phone can grind keys for a matching code.
        val pair = ZlnkCrypto.newKeyPair()
        val pub = ZlnkCrypto.encodePoint(pair.public as java.security.interfaces.ECPublicKey)
        val input = DataInputStream(BufferedInputStream(socket.getInputStream(), 1 shl 16))
        val output = DataOutputStream(BufferedOutputStream(socket.getOutputStream(), 1 shl 16))
        output.write("ZLNK/1\n".toByteArray())
        writeLine(
            output,
            JSONObject()
                .put("phoneId", me.phoneId)
                .put("name", me.name)
                .put("model", me.model)
                .put("nonce", b64(phoneNonce))
                .put("commit", b64(ZlnkCrypto.commit(pub)))
                .put("pair", wantPair),
        )
        output.flush()
        val answer = JSONObject(readLine(input) ?: throw EOFException("The PC closed the connection"))
        if (!answer.optBoolean("ok")) {
            // A PC that forgot this phone says so, so the phone stops retrying and asks its user.
            if (answer.optBoolean("unknown") && answer.has("pcId")) {
                throw NeedsPairing(answer.getString("pcId"), answer.optString("name", "PC").ifBlank { "PC" })
            }
            throw LinkRefused(answer.optString("reason", "The PC refused the link"))
        }
        val pcId = answer.getString("pcId")
        val pcName = answer.optString("name", "PC").ifBlank { "PC" }
        val pcNonce = unb64(answer.getString("nonce"))
        if (pcNonce.size != 16) throw IOException("Bad nonce from the PC")

        if (!answer.optBoolean("pair")) {
            val key = keyFor(pcId) ?: throw NeedsPairing(pcId, pcName)
            socket.soTimeout = 0
            return Session.of(socket, input, output, key, phoneNonce, pcNonce, pcId, pcName)
        }
        if (!wantPair || pairer == null) throw NeedsPairing(pcId, pcName)

        writeLine(output, JSONObject().put("pub", b64(pub)))
        output.flush()
        val z = ZlnkCrypto.agree(pair, unb64(answer.getString("pub")))
        val linkKey = ZlnkCrypto.linkKey(z, phoneNonce, pcNonce)
        val code = ZlnkCrypto.code(z, phoneNonce, pcNonce)
        val session = Session.of(socket, input, output, linkKey, phoneNonce, pcNonce, pcId, pcName)

        class Mine(val ok: Boolean)
        class Theirs(val ok: Boolean)
        val events = LinkedBlockingQueue<Any>()
        socket.soTimeout = (PAIR_TIMEOUT_S * 1000).toInt()
        thread(name = "zlnk-pair-read", isDaemon = true) {
            try {
                // A PC that rejects our `pub` (bad commitment) answers a plaintext refusal line;
                // a sealed frame starts with its length, whose first byte is 0.
                input.mark(1)
                val first = input.read()
                input.reset()
                if (first == '{'.code) {
                    val refusal = JSONObject(readLine(input) ?: "{}")
                    throw LinkRefused(refusal.optString("reason", "The PC refused pairing"))
                }
                val m = session.readMessage()
                events.put(Theirs(m.optString("t") == "pair.ok"))
            } catch (e: Exception) {
                events.put(e)
            }
        }
        val answered = AtomicBoolean(false)
        pairer.ask(pcId, pcName, code) { ok -> if (answered.compareAndSet(false, true)) events.put(Mine(ok)) }
        var mine: Boolean? = null
        var theirs: Boolean? = null
        try {
            while (mine == null || theirs == null) {
                when (val e = events.poll(PAIR_TIMEOUT_S, TimeUnit.SECONDS) ?: throw IOException("Pairing timed out")) {
                    is Mine -> {
                        mine = e.ok
                        session.send(JSONObject().put("t", if (e.ok) "pair.ok" else "pair.no"))
                        if (!e.ok) throw PairDeclined(byPc = false)
                    }
                    is Theirs -> {
                        theirs = e.ok
                        if (!e.ok) throw PairDeclined(byPc = true)
                    }
                    is LinkRefused -> throw e
                    is IOException -> throw if (e is EOFException) PairDeclined(byPc = true) else e
                    is Exception -> throw IOException("Pairing failed: the codes didn't match", e)
                }
            }
        } catch (e: Exception) {
            answered.set(true)
            pairer.cancel()
            session.close()
            throw e
        }
        socket.soTimeout = 0
        onPaired(pcId, pcName, linkKey)
        return session
    }

    fun writeLine(out: OutputStream, json: JSONObject) {
        out.write((json.toString() + "\n").toByteArray(Charsets.UTF_8))
    }

    fun readLine(input: InputStream): String? {
        val bytes = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return if (bytes.size() == 0) null else bytes.toString("UTF-8")
            if (b == '\n'.code) break
            if (bytes.size() >= 1 shl 16) throw IOException("Line too long")
            bytes.write(b)
        }
        return bytes.toString("UTF-8")
    }
}

/**
 * The sealed half of a link: length-prefixed ChaCha20-Poly1305 frames, a counter per direction,
 * a ping after 10 s of quiet and a close after 30 s without hearing from the PC.
 */
class Session(
    private val closer: Closeable,
    private val input: DataInputStream,
    private val output: DataOutputStream,
    private val sendKey: ByteArray,
    private val recvKey: ByteArray,
    val pcId: String,
    val pcName: String,
) : Closeable {
    companion object {
        const val PING_AFTER_MS = 10_000L
        const val DEAD_AFTER_MS = 30_000L

        fun of(
            socket: Socket, input: DataInputStream, output: DataOutputStream, linkKey: ByteArray,
            phoneNonce: ByteArray, pcNonce: ByteArray, pcId: String, pcName: String,
        ): Session {
            val (toPc, toPhone) = ZlnkCrypto.sessionKeys(linkKey, phoneNonce, pcNonce)
            return Session(socket, input, output, toPc, toPhone, pcId, pcName)
        }
    }

    private val writeLock = Object()
    private var sendCounter = 0L
    private var recvCounter = 0L
    private val closed = AtomicBoolean(false)
    @Volatile private var lastSent = System.currentTimeMillis()
    @Volatile private var lastReceived = System.currentTimeMillis()

    /** Frames received after the handshake (a PC that can't open `hello` sends none). */
    @Volatile var framesReceived = 0L
        private set

    val isOpen: Boolean get() = !closed.get()

    fun send(msg: JSONObject) {
        val body = msg.toString().toByteArray(Charsets.UTF_8)
        val plain = ByteArray(1 + body.size)
        plain[0] = Link.KIND_JSON.toByte()
        body.copyInto(plain, 1)
        write(plain)
    }

    fun sendData(xfer: Int, data: ByteArray, offset: Int, length: Int) {
        require(length <= Link.MAX_CHUNK)
        val plain = ByteArray(5 + length)
        plain[0] = Link.KIND_DATA.toByte()
        plain[1] = (xfer ushr 24).toByte()
        plain[2] = (xfer ushr 16).toByte()
        plain[3] = (xfer ushr 8).toByte()
        plain[4] = xfer.toByte()
        System.arraycopy(data, offset, plain, 5, length)
        write(plain)
    }

    private fun write(plain: ByteArray) {
        synchronized(writeLock) {
            if (closed.get()) throw IOException("The link is closed")
            val sealed = ZlnkCrypto.seal(sendKey, sendCounter++, plain)
            output.writeInt(sealed.size)
            output.write(sealed)
            output.flush()
            lastSent = System.currentTimeMillis()
        }
    }

    /** One opened frame's plaintext. Throws on a bad tag or a closed socket. */
    fun readFrame(): ByteArray {
        val length = input.readInt()
        if (length < ZlnkCrypto.TAG_BYTES || length > Link.MAX_BODY) throw IOException("Bad frame length $length")
        val sealed = ByteArray(length)
        input.readFully(sealed)
        val plain = ZlnkCrypto.open(recvKey, recvCounter++, sealed)
        if (plain.isEmpty()) throw IOException("Empty frame")
        lastReceived = System.currentTimeMillis()
        framesReceived++
        return plain
    }

    /** Reads the next JSON message (used while pairing, before [run]). */
    fun readMessage(): JSONObject {
        val plain = readFrame()
        if (plain[0].toInt() != Link.KIND_JSON) throw IOException("Expected a message")
        return JSONObject(String(plain, 1, plain.size - 1, Charsets.UTF_8))
    }

    /**
     * Reads frames until the link ends: messages (other than `ping`) go to `onMessage`, file data
     * to `onData(xfer, bytes, offset, length)`. Returns normally on a clean close.
     */
    fun run(onMessage: (JSONObject) -> Unit, onData: (Int, ByteArray, Int, Int) -> Unit) {
        lastReceived = System.currentTimeMillis()
        val ticker = thread(name = "zlnk-ping", isDaemon = true) {
            try {
                while (!closed.get()) {
                    Thread.sleep(1000)
                    val now = System.currentTimeMillis()
                    if (now - lastReceived > DEAD_AFTER_MS) {
                        close()
                        break
                    }
                    if (now - lastSent > PING_AFTER_MS) {
                        try {
                            send(JSONObject().put("t", "ping"))
                        } catch (_: IOException) {
                            close()
                        }
                    }
                }
            } catch (_: InterruptedException) {
            }
        }
        try {
            while (!closed.get()) {
                val plain = readFrame()
                when (plain[0].toInt()) {
                    Link.KIND_JSON -> {
                        val msg = JSONObject(String(plain, 1, plain.size - 1, Charsets.UTF_8))
                        if (msg.optString("t") != "ping") onMessage(msg)
                    }
                    Link.KIND_DATA -> {
                        if (plain.size < 5) throw IOException("Short data frame")
                        val xfer = ((plain[1].toInt() and 0xff) shl 24) or ((plain[2].toInt() and 0xff) shl 16) or
                            ((plain[3].toInt() and 0xff) shl 8) or (plain[4].toInt() and 0xff)
                        onData(xfer, plain, 5, plain.size - 5)
                    }
                }
            }
        } catch (e: IOException) {
            if (!closed.get()) throw e
        } finally {
            close()
            ticker.interrupt()
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        try {
            closer.close()
        } catch (_: IOException) {
        }
    }
}
