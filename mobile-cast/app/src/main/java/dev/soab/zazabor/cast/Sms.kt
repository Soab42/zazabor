package dev.soab.zazabor.cast

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.database.ContentObserver
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.provider.ContactsContract
import android.telephony.SmsManager
import org.json.JSONArray
import org.json.JSONObject

/** A permission the request needs isn't granted; the message goes to the PC as the error. */
class NotAllowed(message: String) : Exception(message)

fun Context.require(permission: String, what: String) {
    if (checkSelfPermission(permission) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
        throw NotAllowed("Allow $what in Zazabor Link on the phone")
    }
}

fun Cursor.str(column: String): String? = getColumnIndex(column).takeIf { it >= 0 }?.let { getString(it) }
fun Cursor.long(column: String): Long = getColumnIndex(column).takeIf { it >= 0 }?.let { getLong(it) } ?: 0L
fun Cursor.int(column: String): Int = getColumnIndex(column).takeIf { it >= 0 }?.let { getInt(it) } ?: 0

/** Contact names for phone numbers (PhoneLookup), cached; null without READ_CONTACTS. */
class Names(private val context: Context) {
    private val cache = HashMap<String, String?>()

    @Synchronized
    fun of(number: String?): String? {
        if (number.isNullOrBlank()) return null
        if (context.checkSelfPermission(Manifest.permission.READ_CONTACTS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return null
        cache[number]?.let { return it }
        if (cache.containsKey(number)) return null
        if (cache.size > 2000) cache.clear()
        val name = try {
            val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
            context.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) it.getString(0) else null
            }
        } catch (_: Exception) {
            null
        }
        cache[number] = name
        return name
    }
}

/**
 * Texts from the Telephony provider (docs/plans/phone-link.md `Thread`, `Msg`). SMS ids are the
 * provider's `_id`; MMS ids are negated so the two never collide.
 */
class Sms(private val context: Context, private val names: Names) {
    private val cr = context.contentResolver
    private val smsUri = Uri.parse("content://sms")
    private val mmsUri = Uri.parse("content://mms")

    fun threads(limit: Int): JSONArray {
        context.require(Manifest.permission.READ_SMS, "reading texts")
        val unread = HashMap<Long, Int>()
        cr.query(smsUri, arrayOf("thread_id"), "read = 0 AND type = 1", null, null)?.use {
            while (it.moveToNext()) unread.merge(it.getLong(0), 1, Int::plus)
        }
        val out = JSONArray()
        val viaConversations = try {
            conversations(limit, unread, out)
            true
        } catch (_: Exception) {
            false
        }
        if (!viaConversations || out.length() == 0) {
            val fallback = JSONArray()
            threadsFromSms(limit, unread, fallback)
            return fallback
        }
        return out
    }

    private fun conversations(limit: Int, unread: Map<Long, Int>, out: JSONArray) {
        val addresses = HashMap<Long, String>()
        cr.query(Uri.parse("content://mms-sms/canonical-addresses"), arrayOf("_id", "address"), null, null, null)?.use {
            while (it.moveToNext()) addresses[it.getLong(0)] = it.getString(1) ?: ""
        }
        val uri = Uri.parse("content://mms-sms/conversations?simple=true")
        val cursor = cr.query(uri, arrayOf("_id", "date", "message_count", "recipient_ids", "snippet"), null, null, "date DESC")
            ?: throw IllegalStateException("no conversations")
        cursor.use {
            while (it.moveToNext() && out.length() < limit) {
                val id = it.long("_id")
                val count = it.int("message_count")
                if (count == 0) continue
                val numbers = (it.str("recipient_ids") ?: "").split(' ').mapNotNull { r -> r.toLongOrNull()?.let(addresses::get) }
                    .filter { n -> n.isNotBlank() }
                out.put(thread(id, numbers, it.str("snippet") ?: "", it.long("date"), unread[id] ?: 0, count))
            }
        }
    }

    /** For providers without `conversations?simple=true`: newest SMS per thread. */
    private fun threadsFromSms(limit: Int, unread: Map<Long, Int>, out: JSONArray) {
        val seen = LinkedHashMap<Long, JSONObject>()
        val counts = HashMap<Long, Int>()
        cr.query(smsUri, arrayOf("thread_id", "address", "body", "date"), null, null, "date DESC")?.use {
            while (it.moveToNext()) {
                val id = it.getLong(0)
                counts.merge(id, 1, Int::plus)
                if (id !in seen && seen.size < limit) {
                    seen[id] = thread(id, listOfNotNull(it.getString(1)), it.getString(2) ?: "", it.getLong(3), unread[id] ?: 0, 0)
                }
            }
        }
        for ((id, t) in seen) out.put(t.put("count", counts[id] ?: 0))
    }

    private fun thread(id: Long, numbers: List<String>, snippet: String, at: Long, unread: Int, count: Int): JSONObject {
        val name = numbers.map { names.of(it) ?: it }.takeIf { it.isNotEmpty() && numbers.any { n -> names.of(n) != null } }?.joinToString(", ")
        return JSONObject()
            .put("threadId", id)
            .put("addresses", JSONArray(numbers))
            .put("name", name ?: JSONObject.NULL)
            .put("snippet", snippet)
            .put("at", at)
            .put("unread", unread)
            .put("count", count)
    }

    /** Newest last. */
    fun thread(threadId: Long, before: Long?, limit: Int): JSONArray {
        context.require(Manifest.permission.READ_SMS, "reading texts")
        val msgs = ArrayList<JSONObject>()
        val sel = if (before != null) "thread_id = ? AND date < ?" else "thread_id = ?"
        val args = if (before != null) arrayOf(threadId.toString(), before.toString()) else arrayOf(threadId.toString())
        cr.query(smsUri, SMS_COLUMNS, sel, args, "date DESC")?.use {
            while (it.moveToNext() && msgs.size < limit) msgs += smsRow(it)
        }
        try {
            val mmsArgs = if (before != null) arrayOf(threadId.toString(), (before / 1000).toString()) else arrayOf(threadId.toString())
            cr.query(mmsUri, MMS_COLUMNS, if (before != null) "thread_id = ? AND date < ?" else "thread_id = ?", mmsArgs, "date DESC")?.use {
                var n = 0
                while (it.moveToNext() && n++ < limit) mmsRow(it)?.let(msgs::add)
            }
        } catch (_: Exception) {
        }
        msgs.sortBy { it.getLong("at") }
        val out = JSONArray()
        msgs.takeLast(limit).forEach(out::put)
        return out
    }

    private fun smsRow(c: Cursor): JSONObject {
        val type = c.int("type")
        val status = c.int("status")
        return JSONObject()
            .put("id", c.long("_id"))
            .put("threadId", c.long("thread_id"))
            .put("address", c.str("address") ?: "")
            .put("body", c.str("body") ?: "")
            .put("at", c.long("date"))
            .put("out", type != 1)
            .put(
                "status",
                when (type) {
                    1 -> "received"
                    4, 6 -> "pending"
                    5 -> "failed"
                    else -> when {
                        status >= 128 -> "failed"
                        status >= 32 -> "pending"
                        else -> "sent"
                    }
                },
            )
            .put("mms", false)
    }

    private fun mmsRow(c: Cursor): JSONObject? {
        val id = c.long("_id")
        val box = c.int("msg_box")
        val text = StringBuilder()
        cr.query(Uri.parse("content://mms/part"), arrayOf("ct", "text"), "mid = ?", arrayOf(id.toString()), null)?.use {
            while (it.moveToNext()) {
                if (it.getString(0) == "text/plain") {
                    if (text.isNotEmpty()) text.append('\n')
                    text.append(it.getString(1) ?: "")
                }
            }
        }
        var address = ""
        // 137 = from, 151 = to.
        cr.query(Uri.parse("content://mms/$id/addr"), arrayOf("address", "type"), null, null, null)?.use {
            while (it.moveToNext()) {
                val a = it.getString(0) ?: continue
                if (a == "insert-address-token") continue
                if ((box == 1 && it.getInt(1) == 137) || (box != 1 && it.getInt(1) == 151)) {
                    address = a
                    break
                }
            }
        }
        return JSONObject()
            .put("id", -id)
            .put("threadId", c.long("thread_id"))
            .put("address", address)
            .put("body", if (text.isEmpty()) "(media)" else text.toString())
            .put("at", c.long("date") * 1000)
            .put("out", box != 1)
            .put("status", when (box) { 1 -> "received"; 4 -> "pending"; 5 -> "failed"; else -> "sent" })
            .put("mms", true)
    }

    fun send(to: List<String>, body: String) {
        context.require(Manifest.permission.SEND_SMS, "sending texts")
        if (to.isEmpty() || body.isEmpty()) throw IllegalArgumentException("Nothing to send")
        @Suppress("DEPRECATION")
        val sms = if (Build.VERSION.SDK_INT >= 31) context.getSystemService(SmsManager::class.java) else SmsManager.getDefault()
        for (number in to) {
            val parts = sms.divideMessage(body)
            if (parts.size > 1) {
                sms.sendMultipartTextMessage(number, null, parts, null, null)
            } else {
                sms.sendTextMessage(number, null, body, null, null)
            }
        }
    }

    /** Only the default SMS app may write; otherwise this quietly does nothing. */
    fun markRead(threadId: Long) {
        try {
            cr.update(smsUri, ContentValues().apply { put("read", 1) }, "thread_id = ? AND read = 0", arrayOf(threadId.toString()))
        } catch (_: Exception) {
        }
    }

    // ---- watching for new texts ----

    private var observer: ContentObserver? = null
    private var lastSms = 0L
    private var lastMms = 0L
    /** Outgoing SMS still queued: their row changes when they're sent or fail. */
    private val pending = HashMap<Long, String>()

    fun watch(handler: Handler, onMsg: (JSONObject) -> Unit) {
        if (observer != null) return
        if (context.checkSelfPermission(Manifest.permission.READ_SMS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return
        lastSms = maxId(smsUri)
        lastMms = maxId(mmsUri)
        val check = Runnable { scan(onMsg) }
        val o = object : ContentObserver(handler) {
            override fun onChange(selfChange: Boolean) {
                handler.removeCallbacks(check)
                handler.postDelayed(check, 400)
            }
        }
        cr.registerContentObserver(smsUri, true, o)
        try {
            cr.registerContentObserver(mmsUri, true, o)
        } catch (_: Exception) {
        }
        observer = o
    }

    fun unwatch() {
        observer?.let { cr.unregisterContentObserver(it) }
        observer = null
        pending.clear()
    }

    private fun maxId(uri: Uri): Long = try {
        cr.query(uri, arrayOf("_id"), null, null, "_id DESC")?.use { if (it.moveToFirst()) it.getLong(0) else 0L } ?: 0L
    } catch (_: Exception) {
        0L
    }

    private fun scan(onMsg: (JSONObject) -> Unit) {
        try {
            val ids = pending.keys.joinToString(",")
            val sel = if (ids.isEmpty()) "_id > ?" else "_id > ? OR _id IN ($ids)"
            cr.query(smsUri, SMS_COLUMNS, sel, arrayOf(lastSms.toString()), "_id ASC")?.use {
                while (it.moveToNext()) {
                    val id = it.long("_id")
                    val msg = smsRow(it)
                    val status = msg.getString("status")
                    if (id <= lastSms && pending[id] == status) continue
                    lastSms = maxOf(lastSms, id)
                    if (status == "pending") pending[id] = status else pending.remove(id)
                    onMsg(msg)
                }
            }
            cr.query(mmsUri, MMS_COLUMNS, "_id > ?", arrayOf(lastMms.toString()), "_id ASC")?.use {
                while (it.moveToNext()) {
                    lastMms = maxOf(lastMms, it.long("_id"))
                    mmsRow(it)?.let(onMsg)
                }
            }
        } catch (_: Exception) {
        }
    }

    companion object {
        private val SMS_COLUMNS = arrayOf("_id", "thread_id", "address", "body", "date", "type", "status")
        private val MMS_COLUMNS = arrayOf("_id", "thread_id", "date", "msg_box")
    }
}
