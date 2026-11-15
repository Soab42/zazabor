package dev.soab.zazabor.cast

import android.Manifest
import android.content.Context
import android.provider.CallLog.Calls
import org.json.JSONArray
import org.json.JSONObject

/** The phone's call history (docs/plans/phone-link.md `Call`). */
object CallHistory {
    fun list(context: Context, names: Names, limit: Int): JSONArray {
        context.require(Manifest.permission.READ_CALL_LOG, "the call history")
        val out = JSONArray()
        val columns = arrayOf(Calls._ID, Calls.NUMBER, Calls.CACHED_NAME, Calls.DATE, Calls.DURATION, Calls.TYPE)
        context.contentResolver.query(Calls.CONTENT_URI, columns, null, null, "${Calls.DATE} DESC")?.use {
            while (it.moveToNext() && out.length() < limit) {
                val number = it.str(Calls.NUMBER) ?: ""
                val name = it.str(Calls.CACHED_NAME)?.takeIf { n -> n.isNotBlank() } ?: names.of(number)
                out.put(
                    JSONObject()
                        .put("id", it.long(Calls._ID))
                        .put("number", number)
                        .put("name", name ?: JSONObject.NULL)
                        .put("at", it.long(Calls.DATE))
                        .put("duration", it.long(Calls.DURATION))
                        .put(
                            "kind",
                            when (it.int(Calls.TYPE)) {
                                Calls.INCOMING_TYPE, Calls.ANSWERED_EXTERNALLY_TYPE -> "in"
                                Calls.OUTGOING_TYPE -> "out"
                                Calls.MISSED_TYPE -> "missed"
                                Calls.REJECTED_TYPE -> "rejected"
                                Calls.BLOCKED_TYPE -> "blocked"
                                Calls.VOICEMAIL_TYPE -> "voicemail"
                                else -> "in"
                            },
                        ),
                )
            }
        }
        return out
    }
}
