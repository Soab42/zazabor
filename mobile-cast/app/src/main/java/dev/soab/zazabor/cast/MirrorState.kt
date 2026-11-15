package dev.soab.zazabor.cast

import android.os.Handler
import android.os.Looper

/** What the mirroring service is doing, for the screen. */
sealed class MirrorStatus {
    data object Idle : MirrorStatus()
    data class Connecting(val pc: String) : MirrorStatus()
    data class Waiting(val pc: String) : MirrorStatus()
    data class Mirroring(val pc: String, val audio: Boolean) : MirrorStatus()
    data class Ended(val pc: String, val reason: String) : MirrorStatus()

    val active: Boolean get() = this is Connecting || this is Waiting || this is Mirroring
}

/** The service and the activity share one process; the service posts here, the screen listens. */
object MirrorState {
    private val main = Handler(Looper.getMainLooper())
    private val listeners = mutableSetOf<(MirrorStatus) -> Unit>()

    @Volatile
    var status: MirrorStatus = MirrorStatus.Idle
        private set

    fun set(status: MirrorStatus) {
        this.status = status
        main.post { listeners.toList().forEach { it(status) } }
    }

    /** Main thread only. */
    fun listen(listener: (MirrorStatus) -> Unit) {
        listeners += listener
        listener(status)
    }

    fun unlisten(listener: (MirrorStatus) -> Unit) {
        listeners -= listener
    }
}

/** A PC that can show this phone's screen. */
data class Pc(val key: String, val name: String, val host: String, val port: Int) {
    val address: String get() = if (port == Zmir.DEFAULT_PORT) host else "$host:$port"

    companion object {
        /** `ip`, `ip:port` or `host:port`; null when it can't be one. */
        fun parse(text: String): Pc? {
            val t = text.trim().removePrefix("http://").trimEnd('/')
            if (t.isEmpty() || t.any { it.isWhitespace() }) return null
            val colon = t.lastIndexOf(':')
            val (host, port) = if (colon > 0 && t.count { it == ':' } == 1) {
                t.substring(0, colon) to (t.substring(colon + 1).toIntOrNull() ?: return null)
            } else {
                t to Zmir.DEFAULT_PORT
            }
            if (host.isEmpty() || port !in 1..65535) return null
            val pc = Pc("address:$host:$port", host, host, port)
            return pc.copy(name = pc.address)
        }
    }
}
