package dev.soab.zazabor.cast

import android.app.Notification
import android.app.NotificationManager
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Mirrors the phone's notifications to the PC (`notif.*`): posts and removals as they happen,
 * the current list, dismiss, and actions (replies go through the action's RemoteInput). Skips this
 * app's own notifications, group summaries, media players and other ongoing status noise.
 */
class NotifListener : NotificationListenerService() {
    companion object {
        @Volatile
        var instance: NotifListener? = null
            private set

        fun enabled(context: Context): Boolean =
            context.getSystemService(NotificationManager::class.java)
                .isNotificationListenerAccessGranted(ComponentName(context, NotifListener::class.java))

        private const val ICON_PX = 48
    }

    private val icons = HashMap<String, String?>()
    private val labels = HashMap<String, String>()
    /** What was last sent per key, so repeated identical updates (progress ticks) are skipped. */
    private val sent = HashMap<String, String>()

    override fun onListenerConnected() {
        instance = this
    }

    override fun onListenerDisconnected() {
        if (instance === this) instance = null
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (!wanted(sbn) || !LinkService.linked) return
        val n = describe(sbn)
        val fingerprint = n.toString()
        synchronized(sent) {
            if (sent[sbn.key] == fingerprint) return
            sent[sbn.key] = fingerprint
        }
        LinkService.emit(JSONObject().put("t", "notif.posted").put("n", n))
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        val was = synchronized(sent) { sent.remove(sbn.key) != null }
        if (was || wanted(sbn)) LinkService.emit(JSONObject().put("t", "notif.removed").put("key", sbn.key))
    }

    /** Called when a new link starts, so updates aren't swallowed as duplicates. */
    fun resetSent() = synchronized(sent) { sent.clear() }

    private fun wanted(sbn: StatusBarNotification): Boolean {
        if (sbn.packageName == packageName) return false
        val n = sbn.notification
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return false
        if (n.flags and Notification.FLAG_LOCAL_ONLY != 0) return false
        if (n.extras.containsKey(Notification.EXTRA_MEDIA_SESSION)) return false
        if (n.category == Notification.CATEGORY_TRANSPORT) return false
        val ongoing = n.flags and Notification.FLAG_ONGOING_EVENT != 0 || n.flags and Notification.FLAG_FOREGROUND_SERVICE != 0
        if (ongoing && n.category != Notification.CATEGORY_CALL) return false
        val title = n.extras.getCharSequence(Notification.EXTRA_TITLE)
        val text = n.extras.getCharSequence(Notification.EXTRA_TEXT)
        return !(title.isNullOrBlank() && text.isNullOrBlank())
    }

    fun list(): JSONArray {
        val out = JSONArray()
        val active = try {
            activeNotifications
        } catch (_: Exception) {
            null
        } ?: return out
        for (sbn in active.sortedByDescending { it.postTime }) {
            if (!wanted(sbn)) continue
            val n = describe(sbn)
            synchronized(sent) { sent[sbn.key] = n.toString() }
            out.put(n)
        }
        return out
    }

    fun dismiss(key: String) {
        cancelNotification(key)
    }

    fun act(key: String, index: Int, text: String?) {
        val sbn = activeNotifications?.firstOrNull { it.key == key } ?: throw IllegalArgumentException("That notification is gone")
        val action = sbn.notification.actions?.getOrNull(index) ?: throw IllegalArgumentException("No such action")
        val inputs = action.remoteInputs?.takeIf { it.isNotEmpty() }
        if (inputs != null && text != null) {
            val intent = Intent().addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
            val results = Bundle()
            for (input in inputs) results.putCharSequence(input.resultKey, text)
            RemoteInput.addResultsToIntent(inputs, intent, results)
            action.actionIntent.send(this, 0, intent)
        } else {
            action.actionIntent.send()
        }
    }

    private fun describe(sbn: StatusBarNotification): JSONObject {
        val n = sbn.notification
        val extras = n.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
            ?: extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString() ?: ""
        val text = (messagingText(extras) ?: extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
            ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString() ?: ""
        val app = appInfo(sbn)
        val actions = JSONArray()
        for (a in n.actions ?: emptyArray()) {
            val reply = a.remoteInputs?.any { it.allowFreeFormInput } == true
            actions.put(JSONObject().put("title", a.title?.toString() ?: "").put("reply", reply))
        }
        return JSONObject()
            .put("key", sbn.key)
            .put("app", sbn.packageName)
            .put("appName", label(sbn.packageName, app))
            .put("title", title)
            .put("text", text)
            .put("at", sbn.postTime)
            .put("icon", icon(sbn, app) ?: JSONObject.NULL)
            .put("actions", actions)
            .put("clearable", sbn.isClearable)
    }

    /** The last few lines of a MessagingStyle conversation, "Name: text". */
    private fun messagingText(extras: Bundle): String? {
        @Suppress("DEPRECATION")
        val messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES) ?: return null
        val lines = messages.takeLast(5).mapNotNull { m ->
            val b = m as? Bundle ?: return@mapNotNull null
            val text = b.getCharSequence("text") ?: return@mapNotNull null
            val sender = b.getCharSequence("sender")
            if (sender.isNullOrBlank()) text.toString() else "$sender: $text"
        }
        return lines.takeIf { it.isNotEmpty() }?.joinToString("\n")
    }

    private fun appInfo(sbn: StatusBarNotification): ApplicationInfo? {
        val extras = sbn.notification.extras
        val fromExtras = if (Build.VERSION.SDK_INT >= 33) {
            extras.getParcelable("android.appInfo", ApplicationInfo::class.java)
        } else {
            @Suppress("DEPRECATION") extras.getParcelable("android.appInfo")
        }
        return fromExtras ?: try {
            packageManager.getApplicationInfo(sbn.packageName, 0)
        } catch (_: Exception) {
            null
        }
    }

    private fun label(pkg: String, app: ApplicationInfo?): String = synchronized(labels) {
        labels.getOrPut(pkg) { app?.let { packageManager.getApplicationLabel(it).toString() } ?: pkg }
    }

    /** The sender's picture when there is one, else the app's icon: 48 px PNG, base64. */
    private fun icon(sbn: StatusBarNotification, app: ApplicationInfo?): String? {
        try {
            sbn.notification.getLargeIcon()?.loadDrawable(this)?.let { return png(it) }
        } catch (_: Exception) {
        }
        return synchronized(icons) {
            icons.getOrPut(sbn.packageName) {
                try {
                    app?.let { png(packageManager.getApplicationIcon(it)) }
                } catch (_: Exception) {
                    null
                }
            }
        }
    }

    private fun png(drawable: Drawable): String {
        val bitmap = Bitmap.createBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        if (drawable is BitmapDrawable && drawable.bitmap != null) {
            canvas.drawBitmap(Bitmap.createScaledBitmap(drawable.bitmap, ICON_PX, ICON_PX, true), 0f, 0f, null)
        } else {
            drawable.setBounds(0, 0, ICON_PX, ICON_PX)
            drawable.draw(canvas)
        }
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        return Link.b64(out.toByteArray())
    }
}
