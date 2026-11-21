package dev.soab.zazabor.cast

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Size
import org.json.JSONArray
import org.json.JSONObject

/** Recent photos and videos from MediaStore (docs/plans/phone-link.md `Photo`), newest first. */
object PhotoLibrary {
    private const val THUMB = 360
    /** `photo.view` answers must fit one link frame (1 MiB) as base64, with room for the JSON. */
    private const val VIEW_LIMIT = 900_000

    /**
     * One picture (or a video's frame) at up to [max] px on its longest side, for the PC's photo
     * viewer and slideshow. Only MediaStore pictures: the PC can't name any other content.
     */
    fun view(context: Context, uri: String, max: Int): String? {
        if (!allowed(context)) throw NotAllowed("Allow photos and videos in Zazabor Link on the phone")
        val parsed = android.net.Uri.parse(uri)
        if (parsed.scheme != "content" || parsed.authority != MediaStore.AUTHORITY) throw IllegalArgumentException("Not a photo")
        val side = max.coerceIn(256, 2048)
        val bitmap = context.contentResolver.loadThumbnail(parsed, Size(side, side), null)
        // Lower the quality, then the size, until it fits a frame.
        for ((scale, quality) in listOf(1f to 88, 1f to 80, 1f to 70, 0.8f to 72, 0.62f to 72, 0.5f to 65)) {
            val longest = (maxOf(bitmap.width, bitmap.height) * scale).toInt()
            val data = jpeg(bitmap, longest, quality)
            if (data.length <= VIEW_LIMIT) return data
        }
        return null
    }

    fun allowed(context: Context): Boolean {
        val wanted = if (Build.VERSION.SDK_INT >= 33) {
            listOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        } else {
            listOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        return wanted.any { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
    }

    fun list(context: Context, offset: Int, limit: Int): JSONArray {
        if (!allowed(context)) throw NotAllowed("Allow photos and videos in Zazabor Link on the phone")
        val cr = context.contentResolver
        val files = MediaStore.Files.getContentUri("external")
        val columns = arrayOf(
            MediaStore.Files.FileColumns._ID,
            MediaStore.Files.FileColumns.DISPLAY_NAME,
            MediaStore.Files.FileColumns.DATE_ADDED,
            MediaStore.MediaColumns.DATE_TAKEN,
            MediaStore.Files.FileColumns.SIZE,
            MediaStore.Files.FileColumns.MIME_TYPE,
            MediaStore.Files.FileColumns.WIDTH,
            MediaStore.Files.FileColumns.HEIGHT,
            MediaStore.Files.FileColumns.MEDIA_TYPE,
            MediaStore.MediaColumns.DURATION,
        )
        val selection = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (?, ?)"
        val args = arrayOf(
            MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE.toString(),
            MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO.toString(),
        )
        val sort = "${MediaStore.Files.FileColumns.DATE_ADDED} DESC"
        val cursor = if (Build.VERSION.SDK_INT >= 30) {
            cr.query(
                files, columns,
                Bundle().apply {
                    putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection)
                    putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args)
                    putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, sort)
                    putInt(ContentResolver.QUERY_ARG_LIMIT, limit)
                    putInt(ContentResolver.QUERY_ARG_OFFSET, offset)
                },
                null,
            )
        } else {
            cr.query(files, columns, selection, args, "$sort LIMIT $limit OFFSET $offset")
        }
        val out = JSONArray()
        cursor?.use {
            while (it.moveToNext() && out.length() < limit) {
                val id = it.long(MediaStore.Files.FileColumns._ID)
                val video = it.int(MediaStore.Files.FileColumns.MEDIA_TYPE) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
                val base = if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                val uri = ContentUris.withAppendedId(base, id)
                val taken = it.long(MediaStore.MediaColumns.DATE_TAKEN)
                val thumb = try {
                    // 360 px: sharp on the PC's grid tiles, even on a HiDPI screen.
                    jpeg(cr.loadThumbnail(uri, Size(THUMB, THUMB), null), THUMB, 78)
                } catch (_: Exception) {
                    null
                }
                out.put(
                    JSONObject()
                        .put("id", id)
                        .put("uri", uri.toString())
                        .put("name", it.str(MediaStore.Files.FileColumns.DISPLAY_NAME) ?: "")
                        .put("at", if (taken > 0) taken else it.long(MediaStore.Files.FileColumns.DATE_ADDED) * 1000)
                        .put("size", it.long(MediaStore.Files.FileColumns.SIZE))
                        .put("mime", it.str(MediaStore.Files.FileColumns.MIME_TYPE) ?: if (video) "video/*" else "image/*")
                        .put("width", it.int(MediaStore.Files.FileColumns.WIDTH))
                        .put("height", it.int(MediaStore.Files.FileColumns.HEIGHT))
                        .put("video", video)
                        // Whole seconds, like Call.duration.
                        .put("duration", if (video) (it.long(MediaStore.MediaColumns.DURATION) + 500) / 1000 else JSONObject.NULL)
                        .put("thumb", thumb ?: JSONObject.NULL),
                )
            }
        }
        return out
    }
}
