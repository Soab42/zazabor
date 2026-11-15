package dev.soab.zazabor.cast

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.storage.StorageManager
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream

/**
 * The phone's storage for the PC's file browser (docs/plans/phone-link.md `Entry`). Browsing
 * needs all-files access; without it the PC can still send files into Download/Zazabor and read
 * photos by their content:// uri.
 */
object PhoneFiles {
    const val DEFAULT_RELATIVE = "Download/Zazabor"

    fun allAccess(context: Context): Boolean = if (Build.VERSION.SDK_INT >= 30) {
        Environment.isExternalStorageManager()
    } else {
        context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    }

    private fun requireAccess(context: Context) {
        if (!allAccess(context)) throw NotAllowed("Allow all-files access in Zazabor Link on the phone to browse its files")
    }

    /** (label, directory) for internal storage and each mounted card. */
    fun roots(context: Context): List<Pair<String, File>> {
        val storage = context.getSystemService(StorageManager::class.java)
        val out = ArrayList<Pair<String, File>>()
        for (volume in storage.storageVolumes) {
            if (volume.state != Environment.MEDIA_MOUNTED && volume.state != Environment.MEDIA_MOUNTED_READ_ONLY) continue
            val dir: File = when {
                Build.VERSION.SDK_INT >= 30 -> volume.directory
                volume.isPrimary -> @Suppress("DEPRECATION") Environment.getExternalStorageDirectory()
                else -> null
            } ?: continue
            out.add(volume.getDescription(context) to dir)
        }
        if (out.isEmpty()) {
            @Suppress("DEPRECATION")
            val primary = Environment.getExternalStorageDirectory()
            out.add("Internal storage" to primary)
        }
        return out
    }

    fun defaultDir(): File =
        @Suppress("DEPRECATION")
        File(Environment.getExternalStorageDirectory(), DEFAULT_RELATIVE)

    /** A path inside one of the storage roots, or an error. */
    fun resolve(context: Context, path: String): File {
        val file = File(path).canonicalFile
        val inside = roots(context).any { (_, root) ->
            val r = root.canonicalPath
            file.path == r || file.path.startsWith("$r/")
        }
        if (!inside) throw IllegalArgumentException("$path isn't on the phone's storage")
        return file
    }

    fun list(context: Context, path: String): JSONArray {
        requireAccess(context)
        val out = JSONArray()
        if (path.isEmpty()) {
            for ((label, dir) in roots(context)) {
                out.put(JSONObject().put("name", label).put("path", dir.path).put("dir", true).put("size", 0).put("at", dir.lastModified()).put("mime", JSONObject.NULL))
            }
            return out
        }
        val dir = resolve(context, path)
        if (!dir.isDirectory) throw IllegalArgumentException("${dir.name} isn't a folder")
        val children = dir.listFiles() ?: throw IllegalStateException("Couldn't open ${dir.name}")
        children.sortWith(compareBy<File>({ !it.isDirectory }, { it.name.lowercase() }))
        for (f in children) {
            out.put(
                JSONObject()
                    .put("name", f.name)
                    .put("path", f.path)
                    .put("dir", f.isDirectory)
                    .put("size", if (f.isDirectory) 0 else f.length())
                    .put("at", f.lastModified())
                    .put("mime", if (f.isDirectory) JSONObject.NULL else (mime(f.name) ?: JSONObject.NULL)),
            )
        }
        return out
    }

    fun mime(name: String): String? {
        val ext = name.substringAfterLast('.', "").lowercase()
        if (ext.isEmpty()) return null
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
    }

    fun delete(context: Context, path: String) {
        requireAccess(context)
        val file = resolve(context, path)
        if (roots(context).any { it.second.canonicalPath == file.path }) throw IllegalArgumentException("Can't delete a storage root")
        if (!file.exists()) return
        val ok = if (file.isDirectory) file.deleteRecursively() else file.delete()
        if (!ok) throw IllegalStateException("Couldn't delete ${file.name}")
    }

    /** A file (or content:// uri) to send to the PC: its size and stream. */
    fun openForRead(context: Context, path: String): Pair<Long, InputStream> {
        if (path.startsWith("content://")) {
            val uri = Uri.parse(path)
            val size = context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use {
                if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else -1L
            } ?: -1L
            val stream = context.contentResolver.openInputStream(uri) ?: throw IllegalStateException("Couldn't open $path")
            return size to stream
        }
        requireAccess(context)
        val file = resolve(context, path)
        if (!file.isFile) throw IllegalArgumentException("${file.name} isn't a file")
        return file.length() to file.inputStream()
    }

    /** Where a file from the PC is being written; [finish] makes it visible, [abort] drops it. */
    interface Incoming {
        val path: String
        val output: OutputStream
        fun finish()
        fun abort()
    }

    /**
     * Starts a file from the PC. `dir` empty means Download/Zazabor. Other folders need all-files
     * access; Download/Zazabor works without it through MediaStore.
     */
    fun create(context: Context, dir: String?, name: String): Incoming {
        val clean = name.substringAfterLast('/').trim().ifEmpty { "file" }.take(200)
        // The PC names its default folder relative to internal storage ("Download/Zazabor", or
        // "Download/Zazabor/Trip" for a dropped folder); a browsed folder comes as a full path.
        @Suppress("DEPRECATION")
        val full = when {
            dir.isNullOrEmpty() -> defaultDir()
            dir.startsWith("/") -> File(dir)
            else -> File(Environment.getExternalStorageDirectory(), dir)
        }.canonicalFile
        val base = defaultDir().canonicalFile
        // Under Download/Zazabor: the sub-folder ("" for the folder itself), else null.
        val sub = when {
            full.path == base.path -> ""
            full.path.startsWith(base.path + "/") -> full.path.removePrefix(base.path + "/")
            else -> null
        }
        val toDefault = sub != null
        if (allAccess(context)) {
            val folder = if (toDefault) full else resolve(context, full.path)
            if (!folder.exists() && !folder.mkdirs()) throw IllegalStateException("Couldn't make ${folder.path}")
            if (!folder.isDirectory) throw IllegalArgumentException("${folder.name} isn't a folder")
            val target = unique(folder, clean)
            val part = File(folder, ".${target.name}.zlpart")
            val out = FileOutputStream(part)
            return object : Incoming {
                override val path = target.path
                override val output: OutputStream = out
                override fun finish() {
                    out.close()
                    if (!part.renameTo(target)) throw IllegalStateException("Couldn't save ${target.name}")
                }

                override fun abort() {
                    try {
                        out.close()
                    } catch (_: Exception) {
                    }
                    part.delete()
                }
            }
        }
        if (!toDefault || Build.VERSION.SDK_INT < 29) {
            throw NotAllowed("Allow all-files access in Zazabor Link on the phone to save files there")
        }
        val cr = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, clean)
            put(MediaStore.MediaColumns.RELATIVE_PATH, if (sub.isNullOrEmpty()) "$DEFAULT_RELATIVE/" else "$DEFAULT_RELATIVE/$sub/")
            mime(clean)?.let { put(MediaStore.MediaColumns.MIME_TYPE, it) }
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("Couldn't save $clean")
        val finalName = cr.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: clean
        val out = cr.openOutputStream(uri) ?: throw IllegalStateException("Couldn't save $clean")
        return object : Incoming {
            override val path = File(full, finalName).path
            override val output: OutputStream = out
            override fun finish() {
                out.close()
                cr.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
            }

            override fun abort() {
                try {
                    out.close()
                } catch (_: Exception) {
                }
                cr.delete(uri, null, null)
            }
        }
    }

    /** `name`, or `name (2).ext`, … when taken. */
    private fun unique(folder: File, name: String): File {
        var f = File(folder, name)
        if (!f.exists()) return f
        val dot = name.lastIndexOf('.').takeIf { it > 0 } ?: name.length
        val stem = name.substring(0, dot)
        val ext = name.substring(dot)
        var n = 2
        while (f.exists()) f = File(folder, "$stem ($n)$ext").also { n++ }
        return f
    }
}
