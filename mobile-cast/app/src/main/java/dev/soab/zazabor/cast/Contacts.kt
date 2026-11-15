package dev.soab.zazabor.cast

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Phone
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/** Contacts with phone numbers (docs/plans/phone-link.md `Contact`) and their photos. */
object PhoneContacts {
    fun list(context: Context): JSONArray {
        context.require(Manifest.permission.READ_CONTACTS, "contacts")
        val byId = LinkedHashMap<Long, JSONObject>()
        val columns = arrayOf(Phone.CONTACT_ID, Phone.DISPLAY_NAME, Phone.NUMBER, Phone.TYPE, Phone.LABEL, Phone.STARRED, Phone.PHOTO_ID)
        context.contentResolver.query(Phone.CONTENT_URI, columns, null, null, "${Phone.DISPLAY_NAME} COLLATE NOCASE ASC")?.use {
            while (it.moveToNext()) {
                val id = it.long(Phone.CONTACT_ID)
                val number = it.str(Phone.NUMBER)?.takeIf { n -> n.isNotBlank() } ?: continue
                val contact = byId.getOrPut(id) {
                    JSONObject()
                        .put("id", id)
                        .put("name", it.str(Phone.DISPLAY_NAME) ?: number)
                        .put("numbers", JSONArray())
                        .put("starred", it.int(Phone.STARRED) != 0)
                        .put("hasPhoto", it.long(Phone.PHOTO_ID) != 0L)
                }
                val numbers = contact.getJSONArray("numbers")
                val bare = number.filter { c -> c.isDigit() || c == '+' }
                if ((0 until numbers.length()).any { i -> numbers.getJSONObject(i).getString("number").filter { c -> c.isDigit() || c == '+' } == bare }) continue
                val label = Phone.getTypeLabel(context.resources, it.int(Phone.TYPE), it.str(Phone.LABEL)).toString()
                numbers.put(JSONObject().put("number", number).put("label", label))
            }
        }
        return JSONArray(byId.values)
    }

    /** A 96 px JPEG, base64, or null. */
    fun photo(context: Context, id: Long): String? {
        context.require(Manifest.permission.READ_CONTACTS, "contacts")
        val uri = ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI, id)
        val bitmap = ContactsContract.Contacts.openContactPhotoInputStream(context.contentResolver, uri, false)?.use {
            BitmapFactory.decodeStream(it)
        } ?: return null
        return jpeg(bitmap, 96)
    }
}

/** Scales to fit `size` (cropping to a square when `square`) and encodes as base64 JPEG. */
fun jpeg(bitmap: Bitmap, size: Int, quality: Int = 80): String {
    val scale = size.toFloat() / maxOf(bitmap.width, bitmap.height)
    val scaled = if (scale < 1f) {
        Bitmap.createScaledBitmap(bitmap, maxOf(1, (bitmap.width * scale).toInt()), maxOf(1, (bitmap.height * scale).toInt()), true)
    } else {
        bitmap
    }
    val out = ByteArrayOutputStream()
    scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
    return Link.b64(out.toByteArray())
}
