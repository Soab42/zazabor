package dev.soab.zazabor.cast

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.SystemClock
import android.telecom.TelecomManager
import android.telephony.PhoneStateListener
import android.telephony.SignalStrength
import android.telephony.TelephonyCallback
import android.telephony.TelephonyDisplayInfo
import android.telephony.TelephonyManager
import android.annotation.TargetApi
import org.json.JSONObject

/**
 * Battery, signal, network, carrier and Wi-Fi for the `status` message (sent on change, at most
 * every 5 s), and the phone's call state for `call.state`. Everything is optional: what the app
 * isn't allowed to read is null.
 */
class PhoneStatus(
    private val context: Context,
    private val handler: Handler,
    private val names: Names,
    private val onStatus: (JSONObject) -> Unit,
    private val onCall: (JSONObject) -> Unit,
) {
    private val telephony = context.getSystemService(TelephonyManager::class.java)
    private var battery = -1
    private var charging = false
    private var signal: Int? = null
    /** TelephonyDisplayInfo's override type (5G NSA shows as LTE otherwise); 0 = none. */
    private var override = 0
    private var lastSent: JSONObject? = null
    private var lastSentAt = 0L
    private val sendNow = Runnable { flush() }
    private var unwatch: (() -> Unit)? = null
    private var receivers = ArrayList<BroadcastReceiver>()

    private var callState = TelephonyManager.CALL_STATE_IDLE
    private var callNumber: String? = null
    private var sentState: String? = null
    private var sentNumber: String? = null

    fun start() {
        val batteryReceiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
                val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
                battery = if (level >= 0 && scale > 0) level * 100 / scale else -1
                val plugged = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
                charging = plugged == BatteryManager.BATTERY_STATUS_CHARGING || plugged == BatteryManager.BATTERY_STATUS_FULL
                changed()
            }
        }
        context.registerReceiver(batteryReceiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED), null, handler)
        receivers += batteryReceiver

        val phoneState = granted(Manifest.permission.READ_PHONE_STATE)
        val onSignal = { level: Int ->
            signal = level.coerceIn(0, 4)
            changed()
        }
        val onOverride = { type: Int ->
            override = type
            changed()
        }
        val onCallState = { state: Int -> handler.post { callChanged(state, null) }; Unit }
        unwatch = telephony?.let { tm ->
            try {
                if (Build.VERSION.SDK_INT >= 31) {
                    Telephony31.watch(context, tm, phoneState, onSignal, onOverride, onCallState)
                } else {
                    TelephonyLegacy.watch(context, tm, phoneState, onSignal, onCallState)
                }
            } catch (_: Exception) {
                null
            }
        }

        if (phoneState) {
            // The callback carries no number; this broadcast does when the call log is readable.
            val phoneState = object : BroadcastReceiver() {
                override fun onReceive(c: Context, intent: Intent) {
                    @Suppress("DEPRECATION")
                    val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER) ?: return
                    val state = when (intent.getStringExtra(TelephonyManager.EXTRA_STATE)) {
                        TelephonyManager.EXTRA_STATE_RINGING -> TelephonyManager.CALL_STATE_RINGING
                        TelephonyManager.EXTRA_STATE_OFFHOOK -> TelephonyManager.CALL_STATE_OFFHOOK
                        else -> TelephonyManager.CALL_STATE_IDLE
                    }
                    callChanged(state, number)
                }
            }
            context.registerReceiver(phoneState, IntentFilter(TelephonyManager.ACTION_PHONE_STATE_CHANGED), null, handler)
            receivers += phoneState
        }
        changed()
    }

    fun stop() {
        handler.removeCallbacks(sendNow)
        try {
            unwatch?.invoke()
        } catch (_: Exception) {
        }
        unwatch = null
        for (r in receivers) {
            try {
                context.unregisterReceiver(r)
            } catch (_: Exception) {
            }
        }
        receivers.clear()
        lastSent = null
    }

    private fun granted(permission: String) = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    /** The current status, whether or not it changed. */
    fun current(): JSONObject = JSONObject()
        .put("battery", if (battery >= 0) battery else JSONObject.NULL)
        .put("charging", charging)
        .put("signal", signal ?: JSONObject.NULL)
        .put("network", network() ?: JSONObject.NULL)
        .put("carrier", telephony?.networkOperatorName?.takeIf { it.isNotBlank() } ?: JSONObject.NULL)
        .put("wifi", ssid() ?: JSONObject.NULL)

    private fun changed() {
        handler.post {
            val now = SystemClock.elapsedRealtime()
            val wait = 5000 - (now - lastSentAt)
            handler.removeCallbacks(sendNow)
            if (wait <= 0) flush() else handler.postDelayed(sendNow, wait)
        }
    }

    private fun flush() {
        val status = current()
        if (status.toString() == lastSent?.toString()) return
        lastSent = status
        lastSentAt = SystemClock.elapsedRealtime()
        onStatus(JSONObject(status.toString()).put("t", "status"))
    }

    private fun network(): String? {
        when (override) {
            TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_NR_NSA,
            TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_NR_ADVANCED -> return "5G"
            TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_LTE_ADVANCED_PRO,
            TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_LTE_CA -> return "LTE+"
        }
        if (!granted(Manifest.permission.READ_PHONE_STATE)) return null
        @SuppressLint("MissingPermission") // checked just above
        val type = try {
            telephony?.dataNetworkType ?: return null
        } catch (_: Exception) {
            return null
        }
        return when (type) {
            TelephonyManager.NETWORK_TYPE_NR -> "5G"
            TelephonyManager.NETWORK_TYPE_LTE, TelephonyManager.NETWORK_TYPE_IWLAN -> "LTE"
            TelephonyManager.NETWORK_TYPE_HSPAP, TelephonyManager.NETWORK_TYPE_HSPA, TelephonyManager.NETWORK_TYPE_HSDPA,
            TelephonyManager.NETWORK_TYPE_HSUPA, TelephonyManager.NETWORK_TYPE_UMTS, TelephonyManager.NETWORK_TYPE_TD_SCDMA,
            TelephonyManager.NETWORK_TYPE_EVDO_0, TelephonyManager.NETWORK_TYPE_EVDO_A, TelephonyManager.NETWORK_TYPE_EVDO_B,
            TelephonyManager.NETWORK_TYPE_EHRPD -> "3G"
            TelephonyManager.NETWORK_TYPE_EDGE, TelephonyManager.NETWORK_TYPE_GPRS, TelephonyManager.NETWORK_TYPE_CDMA,
            TelephonyManager.NETWORK_TYPE_1xRTT, TelephonyManager.NETWORK_TYPE_GSM, TelephonyManager.NETWORK_TYPE_IDEN -> "2G"
            else -> null
        }
    }

    /** Null unless the system shares it (Android hides the SSID without location access). */
    private fun ssid(): String? = try {
        @Suppress("DEPRECATION")
        context.applicationContext.getSystemService(WifiManager::class.java)?.connectionInfo?.ssid
            ?.removeSurrounding("\"")?.takeIf { it.isNotBlank() && it != WifiManager.UNKNOWN_SSID && it != "<unknown ssid>" }
    } catch (_: Exception) {
        null
    }

    // ---- calls ----

    private fun callChanged(state: Int, number: String?) {
        if (number != null) callNumber = number
        val previous = callState
        callState = state
        val name = when (state) {
            TelephonyManager.CALL_STATE_RINGING -> "ringing"
            TelephonyManager.CALL_STATE_OFFHOOK ->
                if (previous == TelephonyManager.CALL_STATE_RINGING || sentState == "ringing" || sentState == "active") "active" else "dialing"
            else -> if (sentState == null || sentState == "ended") return else "ended"
        }
        if (name == sentState && callNumber == sentNumber) return
        sentState = name
        sentNumber = callNumber
        val n = callNumber
        onCall(
            JSONObject()
                .put("t", "call.state")
                .put("state", name)
                .put("number", n ?: JSONObject.NULL)
                .put("name", names.of(n) ?: JSONObject.NULL)
                .put("at", System.currentTimeMillis()),
        )
        if (state == TelephonyManager.CALL_STATE_IDLE) {
            callNumber = null
            sentNumber = null
        }
    }

    // The callers check each permission with require() first.
    @SuppressLint("MissingPermission")
    companion object {
        /** `call.dial` / `call.answer` / `call.end` through Telecom (the audio stays on the phone). */
        fun dial(context: Context, number: String) {
            context.require(Manifest.permission.CALL_PHONE, "placing calls")
            if (number.isBlank()) throw IllegalArgumentException("No number")
            context.getSystemService(TelecomManager::class.java)
                .placeCall(android.net.Uri.fromParts("tel", number, null), android.os.Bundle())
        }

        fun answer(context: Context) {
            context.require(Manifest.permission.ANSWER_PHONE_CALLS, "answering calls")
            @Suppress("DEPRECATION")
            context.getSystemService(TelecomManager::class.java).acceptRingingCall()
        }

        fun end(context: Context) {
            context.require(Manifest.permission.ANSWER_PHONE_CALLS, "ending calls")
            @Suppress("DEPRECATION")
            if (!context.getSystemService(TelecomManager::class.java).endCall()) throw IllegalStateException("No call to end")
        }
    }
}

/** Signal, the 5G override and call state through TelephonyCallback (Android 12+). */
@TargetApi(31)
private object Telephony31 {
    @SuppressLint("MissingPermission") // the call-state callback is only registered with READ_PHONE_STATE
    fun watch(
        context: Context, tm: TelephonyManager, phoneState: Boolean,
        onSignal: (Int) -> Unit, onOverride: (Int) -> Unit, onCall: (Int) -> Unit,
    ): () -> Unit {
        val callbacks = ArrayList<TelephonyCallback>()
        callbacks += object : TelephonyCallback(), TelephonyCallback.SignalStrengthsListener {
            override fun onSignalStrengthsChanged(strength: SignalStrength) = onSignal(strength.level)
        }
        if (phoneState) {
            callbacks += object : TelephonyCallback(), TelephonyCallback.DisplayInfoListener, TelephonyCallback.CallStateListener {
                override fun onDisplayInfoChanged(info: TelephonyDisplayInfo) = onOverride(info.overrideNetworkType)
                override fun onCallStateChanged(state: Int) = onCall(state)
            }
        }
        val registered = callbacks.filter {
            try {
                tm.registerTelephonyCallback(context.mainExecutor, it)
                true
            } catch (_: Exception) {
                false
            }
        }
        return { registered.forEach { tm.unregisterTelephonyCallback(it) } }
    }
}

/** The same through PhoneStateListener on Android 10 and 11 (no 5G override there). */
@Suppress("DEPRECATION")
private object TelephonyLegacy {
    fun watch(context: Context, tm: TelephonyManager, phoneState: Boolean, onSignal: (Int) -> Unit, onCall: (Int) -> Unit): () -> Unit {
        val listener = object : PhoneStateListener(context.mainExecutor) {
            override fun onSignalStrengthsChanged(strength: SignalStrength) = onSignal(strength.level)
            override fun onCallStateChanged(state: Int, phoneNumber: String?) = onCall(state)
        }
        var events = PhoneStateListener.LISTEN_SIGNAL_STRENGTHS
        if (phoneState) events = events or PhoneStateListener.LISTEN_CALL_STATE
        tm.listen(listener, events)
        return { tm.listen(listener, PhoneStateListener.LISTEN_NONE) }
    }
}
