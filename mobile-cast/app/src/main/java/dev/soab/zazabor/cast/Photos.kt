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
                    jpeg(cr.loadThumbnail(uri, Size(256, 256), null), 256, 75)
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
