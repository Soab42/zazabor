package dev.soab.zazabor.cast

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.net.Inet4Address
import java.util.ArrayDeque

/**
 * Finds PCs running Zazabor on this Wi-Fi (TXT `name` and `id`): the Cast receiver
 * (`_zazabor-mirror._tcp`, the default) or Phone Link (`_zazabor-link._tcp`).
 */
class Discovery(
    context: Context,
    private val type: String = MIRROR,
    private val onChange: (List<Pc>) -> Unit,
) {
    companion object {
        const val MIRROR = "_zazabor-mirror._tcp"
        const val LINK = "_zazabor-link._tcp"
    }

    private val nsd = context.getSystemService(NsdManager::class.java)
    private val wifi = context.applicationContext.getSystemService(WifiManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    /** By service name. */
    private val found = LinkedHashMap<String, Pc>()
    private val toResolve = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var listener: NsdManager.DiscoveryListener? = null
    private var multicast: WifiManager.MulticastLock? = null

    fun start() {
        if (listener != null) return
        multicast = wifi?.createMulticastLock("zazabor-cast")?.apply {
            setReferenceCounted(false)
            acquire()
        }
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                main.post { if (listener === this) listener = null }
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                main.post {
                    toResolve.addLast(info)
                    resolveNext()
                }
            }

            override fun onServiceLost(info: NsdServiceInfo) {
                main.post {
                    if (found.remove(info.serviceName) != null) publish()
                }
            }
        }
        listener = l
        try {
            nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, l)
        } catch (_: Exception) {
            listener = null
        }
    }

    fun stop() {
        listener?.let {
            try {
                nsd.stopServiceDiscovery(it)
            } catch (_: Exception) {
            }
        }
        listener = null
        toResolve.clear()
        multicast?.release()
        multicast = null
    }

    @Suppress("DEPRECATION")
    private fun resolveNext() {
        if (resolving) return
        val info = toResolve.pollFirst() ?: return
        resolving = true
        try {
            nsd.resolveService(info, object : NsdManager.ResolveListener {
                override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                    main.post {
                        resolving = false
                        resolveNext()
                    }
                }

                override fun onServiceResolved(info: NsdServiceInfo) {
                    main.post {
                        resolving = false
                        add(info)
                        resolveNext()
                    }
                }
            })
        } catch (_: Exception) {
            resolving = false
        }
    }

    @Suppress("DEPRECATION")
    private fun add(info: NsdServiceInfo) {
        val addresses = if (Build.VERSION.SDK_INT >= 34) info.hostAddresses else listOfNotNull(info.host)
        val host = (addresses.firstOrNull { it is Inet4Address } ?: addresses.firstOrNull())?.hostAddress ?: return
        val text = { key: String -> info.attributes[key]?.let { String(it, Charsets.UTF_8) }?.takeIf { it.isNotBlank() } }
        val name = text("name") ?: info.serviceName
        val id = text("id") ?: info.serviceName
        found[info.serviceName] = Pc(id, name, host, info.port)
        publish()
    }

    private fun publish() {
        onChange(found.values.distinctBy { it.key })
    }
}
