package dev.soab.zazabor.cast

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.ServerSocket
import java.net.Socket
import java.security.interfaces.ECPublicKey
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** The Link client against a fake PC doing its side of docs/plans/phone-link.md §1. */
class LinkHandshakeTest {
    private val phoneNonce = ByteArray(16) { (0xa0 + it).toByte() }
    private val pcNonce = ByteArray(16) { (0xc0 + it).toByte() }
    private val linkKey = ZlnkCrypto.unhex("6e14f476f50e5be385a1cf6b0878ce8d9afd9bf12530dc6d5d5007cba3f40e7f")
    private val me = PhoneInfo(ZlnkCrypto.phoneId("00112233445566778899aabbccddeeff"), "Test phone", "Test Model")
    private val server = ServerSocket(0)

    @After
    fun close() = server.close()

    /** The PC's view of one accepted connection. */
    private class Pc(val socket: Socket) {
        val input = DataInputStream(BufferedInputStream(socket.getInputStream()))
        val output = DataOutputStream(socket.getOutputStream())
        var send = 0L
        var recv = 0L
        lateinit var toPc: ByteArray
        lateinit var toPhone: ByteArray

        fun keys(linkKey: ByteArray, phoneNonce: ByteArray, pcNonce: ByteArray) {
            val (a, b) = ZlnkCrypto.sessionKeys(linkKey, phoneNonce, pcNonce)
            toPc = a
            toPhone = b
        }

        fun line(): JSONObject = JSONObject(Link.readLine(input)!!)
        fun answer(json: JSONObject) {
            Link.writeLine(output, json)
            output.flush()
        }

        fun rawFrame(): ByteArray {
            val n = input.readInt()
            return ByteArray(n).also { input.readFully(it) }
        }

        fun read(): JSONObject {
            val plain = ZlnkCrypto.open(toPc, recv++, rawFrame())
            assertEquals(1, plain[0].toInt())
            return JSONObject(String(plain, 1, plain.size - 1))
        }

        fun write(json: JSONObject) {
            val sealed = ZlnkCrypto.seal(toPhone, send++, byteArrayOf(1) + json.toString().toByteArray())
            output.writeInt(sealed.size)
            output.write(sealed)
            output.flush()
        }
    }

    private fun pc(body: (Pc) -> Unit): CompletableFuture<Unit> {
        val done = CompletableFuture<Unit>()
        thread(isDaemon = true) {
            try {
                server.accept().use { s ->
                    val pc = Pc(s)
                    assertEquals("ZLNK/1", Link.readLine(pc.input))
                    body(pc)
                }
                done.complete(Unit)
            } catch (e: Throwable) {
                done.completeExceptionally(e)
            }
        }
        return done
    }

    private fun connect(): Socket = Link.open("127.0.0.1", server.localPort)

    private val noPairer = object : Pairer {
        override fun ask(pcId: String, pcName: String, code: Int, answer: (Boolean) -> Unit) = fail("no pairing expected")
        override fun cancel() {}
    }

    @Test
    fun knownPhoneSealsTheVectorFramesAndAnswersRequests() {
        val pcSide = pc { pc ->
            val hello = pc.line()
            assertEquals(me.phoneId, hello.getString("phoneId"))
            assertFalse(hello.getBoolean("pair"))
            assertEquals(32, Link.unb64(hello.getString("commit")).size)
            assertArrayEquals(phoneNonce, Link.unb64(hello.getString("nonce")))
            pc.answer(JSONObject().put("ok", true).put("pcId", "pc1").put("name", "Desk").put("nonce", Link.b64(pcNonce)))
            pc.keys(linkKey, phoneNonce, pcNonce)
            // §6: the phone's first two frames, each {"t":"ping"}.
            assertEquals("7dd06ba0d697b88ef9c9f1432cd32fcc2e09f5579ab1dc3406712b94d5", ZlnkCrypto.hex(pc.rawFrame()))
            assertEquals("770de953a6cc1b95c88cd9914e8ec5a99b8890d52c0b62237318cfa09b", ZlnkCrypto.hex(pc.rawFrame()))
            pc.recv = 2
            assertEquals("hello", pc.read().getString("t"))
            pc.write(JSONObject().put("t", "sms.threads").put("rid", 7).put("limit", 5))
            val re = pc.read()
            assertEquals("re", re.getString("t"))
            assertEquals(7, re.getInt("rid"))
            assertTrue(re.getBoolean("ok"))
        }
        val session = Link.handshake(connect(), me, false, { if (it == "pc1") linkKey else null }, noPairer, { _, _, _ -> fail() }, phoneNonce)
        assertEquals("Desk", session.pcName)
        session.send(JSONObject().put("t", "ping"))
        session.send(JSONObject().put("t", "ping"))
        session.send(JSONObject().put("t", "hello").put("caps", listOf("sms")))
        val got = CompletableFuture<JSONObject>()
        thread(isDaemon = true) {
            try {
                session.run({ msg ->
                    got.complete(msg)
                    session.send(JSONObject().put("t", "re").put("rid", msg.getInt("rid")).put("ok", true).put("threads", listOf<Any>()))
                }, { _, _, _, _ -> })
            } catch (_: Exception) {
            }
        }
        assertEquals("sms.threads", got.get(5, TimeUnit.SECONDS).getString("t"))
        pcSide.get(5, TimeUnit.SECONDS)
        session.close()
    }

    @Test
    fun pairingByNumericComparison() {
        val pcCode = AtomicInteger(-1)
        var pcLinkKey = ByteArray(0)
        val pcSide = pc { pc ->
            val hello = pc.line()
            assertTrue(hello.getBoolean("pair"))
            val nonce = Link.unb64(hello.getString("nonce"))
            val keys = ZlnkCrypto.newKeyPair()
            pc.answer(
                JSONObject().put("ok", true).put("pair", true).put("pcId", "pc2").put("name", "Laptop")
                    .put("nonce", Link.b64(pcNonce)).put("pub", Link.b64(ZlnkCrypto.encodePoint(keys.public as ECPublicKey))),
            )
            val phonePub = Link.unb64(pc.line().getString("pub"))
            // §1 Commitment: the revealed key must hash to the hello's commit.
            assertArrayEquals(Link.unb64(hello.getString("commit")), ZlnkCrypto.commit(phonePub))
            val z = ZlnkCrypto.agree(keys, phonePub)
            pcLinkKey = ZlnkCrypto.linkKey(z, nonce, pcNonce)
            pcCode.set(ZlnkCrypto.code(z, nonce, pcNonce))
            pc.keys(pcLinkKey, nonce, pcNonce)
            pc.write(JSONObject().put("t", "pair.ok"))
            assertEquals("pair.ok", pc.read().getString("t"))
            assertEquals("hello", pc.read().getString("t"))
        }
        val shown = AtomicInteger(-2)
        var stored: ByteArray? = null
        val pairer = object : Pairer {
            override fun ask(pcId: String, pcName: String, code: Int, answer: (Boolean) -> Unit) {
                assertEquals("Laptop", pcName)
                shown.set(code)
                thread { answer(true) }
            }

            override fun cancel() {}
        }
        val session = Link.handshake(connect(), me, true, { null }, pairer, { id, _, key ->
            assertEquals("pc2", id)
            stored = key
        })
        session.send(JSONObject().put("t", "hello"))
        pcSide.get(5, TimeUnit.SECONDS)
        assertEquals(pcCode.get(), shown.get())
        assertArrayEquals(pcLinkKey, stored)
        session.close()
    }

    @Test
    fun pcCancelsPairing() {
        val pcSide = pc { pc ->
            val nonce = Link.unb64(pc.line().getString("nonce"))
            val keys = ZlnkCrypto.newKeyPair()
            pc.answer(
                JSONObject().put("ok", true).put("pair", true).put("pcId", "pc3").put("name", "PC")
                    .put("nonce", Link.b64(pcNonce)).put("pub", Link.b64(ZlnkCrypto.encodePoint(keys.public as ECPublicKey))),
            )
            val z = ZlnkCrypto.agree(keys, Link.unb64(pc.line().getString("pub")))
            pc.keys(ZlnkCrypto.linkKey(z, nonce, pcNonce), nonce, pcNonce)
            pc.write(JSONObject().put("t", "pair.no"))
            Thread.sleep(200)
        }
        val cancelled = AtomicBoolean(false)
        val pairer = object : Pairer {
            override fun ask(pcId: String, pcName: String, code: Int, answer: (Boolean) -> Unit) {}
            override fun cancel() = cancelled.set(true)
        }
        try {
            Link.handshake(connect(), me, true, { null }, pairer, { _, _, _ -> fail("must not store a key") })
            fail("pairing should fail")
        } catch (e: PairDeclined) {
            assertTrue(e.byPc)
        }
        assertTrue(cancelled.get())
        pcSide.get(5, TimeUnit.SECONDS)
    }

    @Test
    fun commitmentRefusalAfterPub() {
        val pcSide = pc { pc ->
            pc.line()
            val keys = ZlnkCrypto.newKeyPair()
            pc.answer(
                JSONObject().put("ok", true).put("pair", true).put("pcId", "pc5").put("name", "PC")
                    .put("nonce", Link.b64(pcNonce)).put("pub", Link.b64(ZlnkCrypto.encodePoint(keys.public as ECPublicKey))),
            )
            pc.line()
            pc.answer(JSONObject().put("ok", false).put("reason", "The phone's key didn't match its commitment"))
        }
        val cancelled = AtomicBoolean(false)
        val pairer = object : Pairer {
            override fun ask(pcId: String, pcName: String, code: Int, answer: (Boolean) -> Unit) {}
            override fun cancel() = cancelled.set(true)
        }
        try {
            Link.handshake(connect(), me, true, { null }, pairer, { _, _, _ -> fail("must not store a key") })
            fail("pairing should fail")
        } catch (e: LinkRefused) {
            assertEquals("The phone's key didn't match its commitment", e.reason)
        }
        assertTrue(cancelled.get())
        pcSide.get(5, TimeUnit.SECONDS)
    }

    @Test
    fun refusedAndUnknownPhone() {
        val refused = pc { pc ->
            pc.line()
            pc.answer(JSONObject().put("ok", false).put("reason", "Phone Link is off"))
        }
        try {
            Link.handshake(connect(), me, false, { linkKey }, noPairer, { _, _, _ -> })
            fail()
        } catch (e: LinkRefused) {
            assertEquals("Phone Link is off", e.reason)
        }
        refused.get(5, TimeUnit.SECONDS)

        // A PC that forgot this phone asks to pair; a background reconnect must not prompt.
        val forgot = pc { pc ->
            pc.line()
            pc.answer(JSONObject().put("ok", true).put("pair", true).put("pcId", "pc4").put("name", "PC").put("nonce", Link.b64(pcNonce)).put("pub", "AA=="))
        }
        try {
            Link.handshake(connect(), me, false, { linkKey }, noPairer, { _, _, _ -> })
            fail()
        } catch (e: NeedsPairing) {
            assertEquals("pc4", e.pcId)
        }
        forgot.get(5, TimeUnit.SECONDS)
    }
}
