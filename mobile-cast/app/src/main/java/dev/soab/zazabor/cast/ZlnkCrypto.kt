package dev.soab.zazabor.cast

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The ZLNK/1 crypto (docs/plans/phone-link.md §1): ECDH P-256 pairing, HKDF-SHA256 keys, the
 * six-digit comparison code and ChaCha20-Poly1305 with counter nonces. Plain JDK APIs, so the same
 * code runs on the phone and in the JVM unit tests.
 */
object ZlnkCrypto {
    const val TAG_BYTES = 16

    fun hkdf(ikm: ByteArray, salt: ByteArray, info: String, length: Int): ByteArray {
        val extract = Mac.getInstance("HmacSHA256")
        extract.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
        val prk = extract.doFinal(ikm)
        val expand = Mac.getInstance("HmacSHA256")
        expand.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var block = ByteArray(0)
        var filled = 0
        var i = 1
        while (filled < length) {
            expand.update(block)
            expand.update(info.toByteArray(Charsets.UTF_8))
            expand.update(i.toByte())
            block = expand.doFinal()
            val n = minOf(block.size, length - filled)
            System.arraycopy(block, 0, out, filled, n)
            filled += n
            i++
        }
        return out
    }

    fun linkKey(z: ByteArray, phoneNonce: ByteArray, pcNonce: ByteArray): ByteArray =
        hkdf(z, phoneNonce + pcNonce, "zlnk pair", 32)

    /** The number both screens show, 0..999999. */
    fun code(z: ByteArray, phoneNonce: ByteArray, pcNonce: ByteArray): Int {
        val b = hkdf(z, phoneNonce + pcNonce, "zlnk code", 4)
        val v = ((b[0].toLong() and 0xff) shl 24) or ((b[1].toLong() and 0xff) shl 16) or
            ((b[2].toLong() and 0xff) shl 8) or (b[3].toLong() and 0xff)
        return (v % 1_000_000).toInt()
    }

    /** `482 913`. */
    fun formatCode(code: Int): String {
        val s = "%06d".format(code)
        return s.substring(0, 3) + " " + s.substring(3)
    }

    /** (phone→PC key, PC→phone key). */
    fun sessionKeys(linkKey: ByteArray, phoneNonce: ByteArray, pcNonce: ByteArray): Pair<ByteArray, ByteArray> {
        val k = hkdf(linkKey, phoneNonce + pcNonce, "zlnk session", 64)
        return k.copyOfRange(0, 32) to k.copyOfRange(32, 64)
    }

    /** The phone's id on the wire: the first 32 hex digits of SHA-256(mirrorSecret as text). */
    fun phoneId(mirrorSecret: String): String =
        hex(MessageDigest.getInstance("SHA-256").digest(mirrorSecret.toByteArray(Charsets.UTF_8))).substring(0, 32)

    fun nonce(counter: Long): ByteArray {
        val n = ByteArray(12)
        for (i in 0 until 8) n[4 + i] = (counter ushr (56 - 8 * i)).toByte()
        return n
    }

    /** Android's Conscrypt names it "ChaCha20/Poly1305/NoPadding", the desktop JDK "ChaCha20-Poly1305". */
    fun chacha(): Cipher = try {
        Cipher.getInstance("ChaCha20/Poly1305/NoPadding")
    } catch (_: Exception) {
        Cipher.getInstance("ChaCha20-Poly1305")
    }

    fun seal(key: ByteArray, counter: Long, plain: ByteArray): ByteArray {
        val c = chacha()
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(nonce(counter)))
        return c.doFinal(plain)
    }

    /** Throws when the tag doesn't match. */
    fun open(key: ByteArray, counter: Long, sealed: ByteArray): ByteArray {
        val c = chacha()
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(nonce(counter)))
        return c.doFinal(sealed)
    }

    /** The hello's `commit`: SHA-256 of the phone's 65-byte public point. */
    fun commit(point: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(point)

    // ---- ECDH P-256 ----

    fun newKeyPair(): KeyPair = KeyPairGenerator.getInstance("EC").apply {
        initialize(ECGenParameterSpec("secp256r1"))
    }.generateKeyPair()

    /** The 65-byte uncompressed point `04 ‖ x ‖ y`. */
    fun encodePoint(key: ECPublicKey): ByteArray {
        val out = ByteArray(65)
        out[0] = 4
        fixed32(key.w.affineX).copyInto(out, 1)
        fixed32(key.w.affineY).copyInto(out, 33)
        return out
    }

    fun decodePoint(point: ByteArray, like: ECPublicKey): ECPublicKey {
        require(point.size == 65 && point[0] == 4.toByte()) { "Not an uncompressed P-256 point" }
        val x = BigInteger(1, point.copyOfRange(1, 33))
        val y = BigInteger(1, point.copyOfRange(33, 65))
        val spec = ECPublicKeySpec(ECPoint(x, y), like.params)
        return KeyFactory.getInstance("EC").generatePublic(spec) as ECPublicKey
    }

    /** The 32-byte shared secret `z`. */
    fun agree(own: KeyPair, theirPoint: ByteArray): ByteArray {
        val theirs = decodePoint(theirPoint, own.public as ECPublicKey)
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(own.private)
        ka.doPhase(theirs, true)
        return ka.generateSecret()
    }

    private fun fixed32(v: BigInteger): ByteArray {
        val b = v.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    fun unhex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(2 * it, 2 * it + 2).toInt(16).toByte() }

    fun sha256Hex(b: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(b))
}
