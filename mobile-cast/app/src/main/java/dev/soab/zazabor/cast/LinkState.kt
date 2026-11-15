package dev.soab.zazabor.cast

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import java.security.SecureRandom

/**
 * This phone's one identity, shared with mirroring: the Cast app's `mirrorSecret` (prefs
 * `cast.xml`, made the same way MirrorService makes it). The link only ever sends its hash.
 */
object Identity {
    @Synchronized
    fun secret(context: Context): String {
        val prefs = context.getSharedPreferences("cast", Context.MODE_PRIVATE)
        prefs.getString("mirrorSecret", null)?.let { return it }
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val secret = bytes.joinToString("") { "%02x".format(it) }
        prefs.edit().putString("mirrorSecret", secret).commit()
        return secret
    }

    fun phoneId(context: Context): String = ZlnkCrypto.phoneId(secret(context))

    fun deviceName(context: Context): String =
        Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() } ?: Build.MODEL

    /** "Google Pixel 7", "Xiaomi 23129RAA4G". */
    fun model(): String {
        val maker = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
        return if (Build.MODEL.startsWith(Build.MANUFACTURER, ignoreCase = true)) Build.MODEL else "$maker ${Build.MODEL}"
    }

    fun info(context: Context) = PhoneInfo(phoneId(context), deviceName(context), model())
}

/** The paired PC and link settings, in prefs `link.xml` (`key_<pcId>` holds the linkKey). */
class LinkPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("link", Context.MODE_PRIVATE)

    val pcId: String? get() = prefs.getString("pcId", null)?.takeIf { key(it) != null }
    val pcName: String get() = prefs.getString("pcName", null) ?: "PC"
    val host: String? get() = prefs.getString("host", null)
    val port: Int get() = prefs.getInt("port", Link.DEFAULT_PORT)
    val paired: Boolean get() = pcId != null

    var clip: Boolean
        get() = prefs.getBoolean("clip", false)
        set(v) {
            prefs.edit().putBoolean("clip", v).apply()
        }

    fun key(pcId: String): ByteArray? = prefs.getString("key_$pcId", null)?.let { ZlnkCrypto.unhex(it) }

    fun paired(pcId: String, name: String, host: String, port: Int, key: ByteArray) {
        prefs.edit()
            .putString("pcId", pcId)
            .putString("pcName", name)
            .putString("host", host)
            .putInt("port", port)
            .putString("key_$pcId", ZlnkCrypto.hex(key))
            .commit()
    }

    /** Where the paired PC was last reached (mDNS can move it). */
    fun seen(name: String, host: String, port: Int) {
        prefs.edit().putString("pcName", name).putString("host", host).putInt("port", port).apply()
    }

    fun forget() {
        val id = prefs.getString("pcId", null)
        prefs.edit().apply {
            remove("pcId")
            remove("pcName")
            remove("host")
            remove("port")
            if (id != null) remove("key_$id")
        }.commit()
    }
}

/** What the link is doing, for the main screen. */
sealed class LinkStatus {
    data object Unpaired : LinkStatus()
    data class Waiting(val pc: String, val detail: String) : LinkStatus()
    data class Pairing(val pc: String, val code: Int?) : LinkStatus()
    data class Linked(val pc: String) : LinkStatus()
    data class Problem(val pc: String, val detail: String, val repair: Boolean) : LinkStatus()
}

/** LinkService posts here; the screen listens (same process, like [MirrorState]). */
object LinkState {
    private val main = Handler(Looper.getMainLooper())
    private val listeners = mutableSetOf<(LinkStatus) -> Unit>()
    private val notices = mutableSetOf<(String) -> Unit>()

    @Volatile
    var status: LinkStatus = LinkStatus.Unpaired
        private set

    fun set(status: LinkStatus) {
        this.status = status
        main.post { listeners.toList().forEach { it(status) } }
    }

    /** A one-off message the screen shows as a toast (when it's open). */
    fun notice(text: String) {
        main.post { notices.toList().forEach { it(text) } }
    }

    fun listen(listener: (LinkStatus) -> Unit, onNotice: (String) -> Unit) {
        listeners += listener
        notices += onNotice
        listener(status)
    }

    fun unlisten(listener: (LinkStatus) -> Unit, onNotice: (String) -> Unit) {
        listeners -= listener
        notices -= onNotice
    }
}
