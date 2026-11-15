package dev.soab.zazabor.cast

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.DataInputStream
import java.io.DataOutputStream
import java.security.interfaces.ECPublicKey

/** docs/plans/phone-link.md §6: the values the PC side must reproduce too. */
class ZlnkVectorsTest {
    private val z = ByteArray(32) { it.toByte() }
    private val phoneNonce = ByteArray(16) { (0xa0 + it).toByte() }
    private val pcNonce = ByteArray(16) { (0xc0 + it).toByte() }
    private val linkKeyHex = "6e14f476f50e5be385a1cf6b0878ce8d9afd9bf12530dc6d5d5007cba3f40e7f"
    private val toPcHex = "fe57135bfb34b1a6bca23d6af4898fc4700898352d76f91b830b8cfbbc86bd33"
    private val toPhoneHex = "693b278d4bfe7d55f4f02a017d9f7d2053a42e25bdc02eba072d0b9d731a29e3"
    private val ping = ZlnkCrypto.unhex("017b2274223a2270696e67227d")
    private val sealed0 = "7dd06ba0d697b88ef9c9f1432cd32fcc2e09f5579ab1dc3406712b94d5"
    private val sealed1 = "770de953a6cc1b95c88cd9914e8ec5a99b8890d52c0b62237318cfa09b"

    @Test
    fun linkKey() {
        assertEquals(linkKeyHex, ZlnkCrypto.hex(ZlnkCrypto.linkKey(z, phoneNonce, pcNonce)))
    }

    @Test
    fun code() {
        assertEquals(910268, ZlnkCrypto.code(z, phoneNonce, pcNonce))
        assertEquals("910 268", ZlnkCrypto.formatCode(910268))
        assertEquals("004 020", ZlnkCrypto.formatCode(4020))
    }

    @Test
    fun sessionKeys() {
        val (toPc, toPhone) = ZlnkCrypto.sessionKeys(ZlnkCrypto.unhex(linkKeyHex), phoneNonce, pcNonce)
        assertEquals(toPcHex, ZlnkCrypto.hex(toPc))
        assertEquals(toPhoneHex, ZlnkCrypto.hex(toPhone))
    }

    @Test
    fun sealedFrames() {
        val key = ZlnkCrypto.unhex(toPcHex)
        assertEquals(sealed0, ZlnkCrypto.hex(ZlnkCrypto.seal(key, 0, ping)))
        assertEquals(sealed1, ZlnkCrypto.hex(ZlnkCrypto.seal(key, 1, ping)))
        assertArrayEquals(ping, ZlnkCrypto.open(key, 1, ZlnkCrypto.unhex(sealed1)))
    }

    /** The same two frames as they leave a [Session], with their length prefix. */
    @Test
    fun sessionWritesTheVectorFrames() {
        val out = ByteArrayOutputStream()
        val session = Session(
            Closeable {}, DataInputStream(ByteArrayInputStream(ByteArray(0))), DataOutputStream(out),
            ZlnkCrypto.unhex(toPcHex), ZlnkCrypto.unhex(toPhoneHex), "pc", "PC",
        )
        session.send(JSONObject().put("t", "ping"))
        session.send(JSONObject().put("t", "ping"))
        assertEquals("0000001d$sealed0" + "0000001d$sealed1", ZlnkCrypto.hex(out.toByteArray()))
    }

    @Test
    fun phoneId() {
        assertEquals("5947d7c33d783f94b3b4c1a96ebc8991", ZlnkCrypto.phoneId("00112233445566778899aabbccddeeff"))
    }

    @Test
    fun ecdhAgrees() {
        val a = ZlnkCrypto.newKeyPair()
        val b = ZlnkCrypto.newKeyPair()
        val pa = ZlnkCrypto.encodePoint(a.public as ECPublicKey)
        val pb = ZlnkCrypto.encodePoint(b.public as ECPublicKey)
        assertEquals(65, pa.size)
        assertArrayEquals(ZlnkCrypto.agree(a, pb), ZlnkCrypto.agree(b, pa))
        assertEquals(32, ZlnkCrypto.agree(a, pb).size)
    }
}
