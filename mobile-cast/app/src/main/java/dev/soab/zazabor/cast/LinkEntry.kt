package dev.soab.zazabor.cast

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.widget.Toast
import org.json.JSONObject

/** "Send to PC" in the share sheet: offers the shared files (or text) to the linked PC. */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uris = streams(intent)
        val text = if (uris.isEmpty()) intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() else null
        when {
            !LinkService.linked -> toast("Not linked to a PC. Open Zazabor Link to pair.")
            uris.isEmpty() && text.isNullOrEmpty() -> toast("Nothing to send")
            else -> {
                // Open the files now: the sharing app's permission ends with this screen.
                val files = uris.mapNotNull { open(it) }
                if (LinkService.share(files, text)) {
                    toast("Sending to ${LinkService.pcName ?: "the PC"}…")
                } else {
                    files.forEach { runCatching { it.open().close() } }
                    toast("Not linked to a PC")
                }
            }
        }
        finish()
    }

    private fun streams(intent: Intent): List<Uri> = when (intent.action) {
        Intent.ACTION_SEND -> listOfNotNull(
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM),
        )
        Intent.ACTION_SEND_MULTIPLE ->
            (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()
        else -> emptyList()
    }

    private fun open(uri: Uri): LinkService.SharedFile? = try {
        var name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
        var size = -1L
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use {
            if (it.moveToFirst()) {
                it.getString(0)?.let { n -> name = n }
                if (!it.isNull(1)) size = it.getLong(1)
            }
        }
        val fd = contentResolver.openFileDescriptor(uri, "r") ?: throw IllegalStateException("Couldn't open $uri")
        if (size < 0) size = fd.statSize
        val mime = contentResolver.getType(uri)
        LinkService.SharedFile(name, size, mime) { ParcelFileDescriptor.AutoCloseInputStream(fd) }
    } catch (e: Exception) {
        toast("Couldn't open a file: ${e.message}")
        null
    }

    private fun toast(text: String) = Toast.makeText(applicationContext, text, Toast.LENGTH_SHORT).show()
}

/**
 * The link notification's "Send clipboard": Android only lets the app on screen read the
 * clipboard, so this invisible screen takes focus for a moment, reads it and sends it.
 */
class ClipActivity : Activity() {
    private var done = false

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || done) return
        done = true
        val text = getSystemService(ClipboardManager::class.java).primaryClip
            ?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()
        val message = when {
            !LinkPrefs(this).clip -> "Clipboard sharing is off"
            !LinkService.linked -> "Not linked to a PC"
            text.isNullOrEmpty() -> "The clipboard is empty"
            else -> {
                LinkService.emit(JSONObject().put("t", "clip").put("text", text))
                "Clipboard sent to ${LinkService.pcName ?: "the PC"}"
            }
        }
        Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()
        finish()
    }
}

/** Starts the link after a reboot or an app update while a PC is paired. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> LinkService.start(context)
        }
    }
}
