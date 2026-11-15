package dev.soab.zazabor.cast

import android.app.Activity
import android.app.AlertDialog
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageInstaller
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.TypedValue
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Updates without a store. Each Zazabor Home release carries phone-apps.json (written by
 * scripts/release-phone-apps.sh) with each phone app's version, file, size and SHA-256. On open,
 * at most every few hours, the app reads it and offers a newer version; Update downloads the APK,
 * checks its SHA-256 and that it's this app, and hands it to Android's installer, which asks the
 * user and only installs an update signed with the same key as this copy.
 *
 * The same file is in mobile-cast/ (Zazabor Link) and mobile/ (Zazabor Wallet); only the package
 * differs. Keep them the same.
 */
object Updater {
    private const val BASE = "https://github.com/Soab42/zazabor-home/releases/latest/download/"
    private const val EVERY_MS = 6 * 60 * 60 * 1000L
    private val busy = AtomicBoolean(false)
    private val main = Handler(Looper.getMainLooper())

    class Release(val version: String, val code: Long, val file: String, val bytes: Long, val sha256: String, val notes: String)

    private fun prefs(context: Context): SharedPreferences = context.getSharedPreferences("updates", Context.MODE_PRIVATE)

    /** When the app opens: a waiting install first, then (every few hours) a quiet check. */
    fun maybeCheck(activity: Activity, app: String) {
        tidy(activity)
        if (resume(activity)) return
        if (System.currentTimeMillis() - prefs(activity).getLong("checked", 0) < EVERY_MS) return
        check(activity, app, manual = false)
    }

    /** Check for Updates: also says when there's nothing newer or GitHub can't be reached. */
    fun check(activity: Activity, app: String, manual: Boolean) {
        if (!busy.compareAndSet(false, true)) return
        Thread {
            val result = runCatching { fetch(app) }
            main.post {
                busy.set(false)
                if (activity.isFinishing || activity.isDestroyed) return@post
                result.onSuccess { release ->
                    prefs(activity).edit().putLong("checked", System.currentTimeMillis()).apply()
                    when {
                        release == null || release.code <= currentCode(activity) ->
                            if (manual) toast(activity, "${label(activity)} ${currentName(activity)} is up to date.")
                        !manual && prefs(activity).getLong("skipped", -1) == release.code -> {}
                        else -> offer(activity, release)
                    }
                }.onFailure {
                    if (manual) toast(activity, "Couldn't check for updates: ${it.message ?: "no connection"}")
                }
            }
        }.start()
    }

    private fun fetch(app: String): Release? {
        val json = JSONObject(read(BASE + "phone-apps.json").toString(Charsets.UTF_8))
        if (json.optString("kind") != "zazabor-phone-apps") throw IOException("that isn't Zazabor's list of updates")
        val a = json.optJSONObject("apps")?.optJSONObject(app) ?: return null
        return Release(a.getString("version"), a.getLong("code"), a.getString("file"), a.getLong("bytes"), a.getString("sha256"), a.optString("notes"))
    }

    private fun offer(activity: Activity, r: Release) {
        val message = buildString {
            append("You have ${currentName(activity)}. The update is ${sizeText(r.bytes)} and installs over this one; everything you've set up stays.")
            if (r.notes.isNotBlank()) append("\n\n").append(r.notes.trim())
        }
        AlertDialog.Builder(activity)
            .setTitle("${label(activity)} ${r.version} is available")
            .setMessage(message)
            .setPositiveButton("Update") { _, _ -> download(activity, r) }
            .setNegativeButton("Later", null)
            .setNeutralButton("Skip This Version") { _, _ -> prefs(activity).edit().putLong("skipped", r.code).apply() }
            .present()
    }

    private fun download(activity: Activity, r: Release) {
        val density = activity.resources.displayMetrics.density
        val bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply { max = 1000 }
        val status = TextView(activity).apply { text = "Starting…" }
        val box = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (22 * density).toInt()
            setPadding(pad, pad / 2, pad, 0)
            addView(bar)
            addView(status)
        }
        val cancelled = AtomicBoolean(false)
        val dialog = AlertDialog.Builder(activity)
            .setTitle("Downloading ${label(activity)} ${r.version}")
            .setView(box)
            .setCancelable(false)
            .setNegativeButton("Cancel") { _, _ -> cancelled.set(true) }
            .present()
        val file = File(activity.cacheDir, "update-${r.code}.apk")
        Thread {
            val result = runCatching {
                val connection = connect(BASE + r.file)
                val digest = MessageDigest.getInstance("SHA-256")
                var done = 0L
                try {
                    connection.inputStream.use { input ->
                        file.outputStream().use { out ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                if (cancelled.get()) throw IOException("cancelled")
                                val n = input.read(buf)
                                if (n < 0) break
                                out.write(buf, 0, n)
                                digest.update(buf, 0, n)
                                done += n
                                if (done > r.bytes) throw IOException("the download is bigger than it should be")
                                val got = done
                                main.post {
                                    bar.progress = (got * 1000 / maxOf(1L, r.bytes)).toInt()
                                    status.text = "${sizeText(got)} of ${sizeText(r.bytes)}"
                                }
                            }
                        }
                    }
                } finally {
                    connection.disconnect()
                }
                if (done != r.bytes || hex(digest.digest()) != r.sha256.lowercase(Locale.ROOT)) throw IOException("the download was damaged")
                val info = activity.packageManager.getPackageArchiveInfo(file.path, 0) ?: throw IOException("that isn't an app")
                if (info.packageName != activity.packageName) throw IOException("that isn't ${label(activity)}")
                file
            }
            main.post {
                if (dialog.isShowing) dialog.dismiss()
                result.onSuccess { install(activity, it) }.onFailure {
                    file.delete()
                    if (!cancelled.get() && !activity.isFinishing) {
                        AlertDialog.Builder(activity).setTitle("The update didn't download")
                            .setMessage("${it.message?.replaceFirstChar { c -> c.uppercase() } ?: "Something went wrong"}. Try again in a while.")
                            .setPositiveButton("OK", null).present()
                    }
                }
            }
        }.start()
    }

    /** Hands the checked APK to Android's installer, after the one-time "install unknown apps" permission. */
    private fun install(activity: Activity, file: File) {
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            prefs(activity).edit().putString("pending", file.path).apply()
            AlertDialog.Builder(activity)
                .setTitle("Allow ${label(activity)} to update itself")
                .setMessage("Android asks once. On the next screen turn on Allow from this source, then come back: the update installs from there.")
                .setPositiveButton("Open Settings") { _, _ ->
                    try {
                        activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
                    } catch (_: Exception) {
                        activity.startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS))
                    }
                }
                .setNegativeButton("Not Now", null)
                .present()
            return
        }
        prefs(activity).edit().remove("pending").apply()
        try {
            val installer = activity.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(activity.packageName)
                setSize(file.length())
            }
            val id = installer.createSession(params)
            installer.openSession(id).use { session ->
                session.openWrite("update.apk", 0, file.length()).use { out ->
                    file.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                val done = PendingIntent.getBroadcast(activity, id, Intent(activity, UpdateReceiver::class.java), flags)
                session.commit(done.intentSender)
            }
        } catch (e: Exception) {
            toast(activity, "Couldn't install the update: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    /** Back from the permission screen with a checked download waiting: installs it. */
    private fun resume(activity: Activity): Boolean {
        val path = prefs(activity).getString("pending", null) ?: return false
        val file = File(path)
        if (!file.exists()) {
            prefs(activity).edit().remove("pending").apply()
            return false
        }
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) return false
        install(activity, file)
        return true
    }

    /** Downloads of versions already installed. */
    private fun tidy(activity: Activity) {
        val current = currentCode(activity)
        activity.cacheDir.listFiles { f -> f.name.startsWith("update-") && f.name.endsWith(".apk") }?.forEach { f ->
            val code = f.name.removePrefix("update-").removeSuffix(".apk").toLongOrNull() ?: 0
            if (code <= current) f.delete()
        }
    }

    private fun read(url: String): ByteArray {
        val connection = connect(url)
        try {
            return connection.inputStream.use { it.readBytes() }
        } finally {
            connection.disconnect()
        }
    }

    /** GitHub's release links redirect (to its file host); each hop stays on https. */
    private fun connect(start: String): HttpURLConnection {
        var url = URL(start)
        repeat(6) {
            val c = url.openConnection() as HttpURLConnection
            c.connectTimeout = 15_000
            c.readTimeout = 30_000
            c.instanceFollowRedirects = false
            c.setRequestProperty("User-Agent", "Zazabor")
            val code = c.responseCode
            if (code in 300..399) {
                val next = URL(url, c.getHeaderField("Location") ?: throw IOException("GitHub sent nowhere to go"))
                c.disconnect()
                if (next.protocol != "https") throw IOException("the download isn't secure")
                url = next
                return@repeat
            }
            if (code != 200) {
                c.disconnect()
                throw IOException(if (code == 404) "there's no update list yet" else "GitHub answered $code")
            }
            return c
        }
        throw IOException("too many redirects")
    }

    private fun currentCode(context: Context): Long {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
    }

    private fun currentName(context: Context): String =
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "?"

    private fun label(context: Context): String = context.applicationInfo.loadLabel(context.packageManager).toString()

    private fun sizeText(bytes: Long): String =
        if (bytes >= 1_048_576) String.format(Locale.ROOT, "%.1f MB", bytes / 1_048_576.0) else "${maxOf(1L, bytes / 1024)} KB"

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    /**
     * Shows a dialog on a rounded card of the theme's dialog colour. Link's dialog theme leaves the
     * window transparent (its own dialogs set the card the same way), which put the text straight
     * over the screen behind; this works whatever the app's theme.
     */
    private fun AlertDialog.Builder.present(): AlertDialog {
        val dialog = show()
        val value = TypedValue()
        val resolved = dialog.context.theme.resolveAttribute(android.R.attr.colorBackground, value, true)
        val color = if (resolved && value.type >= TypedValue.TYPE_FIRST_COLOR_INT && value.type <= TypedValue.TYPE_LAST_COLOR_INT) value.data else 0xFF1E1F24.toInt()
        dialog.window?.setBackgroundDrawable(GradientDrawable().apply {
            setColor(color)
            cornerRadius = 24 * dialog.context.resources.displayMetrics.density
        })
        return dialog
    }

    private fun toast(context: Context, text: String) = Toast.makeText(context, text, Toast.LENGTH_LONG).show()
}

/** The installer's answer: shows Android's Install screen, or says why it didn't install. */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
                } ?: return
                context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            PackageInstaller.STATUS_SUCCESS, PackageInstaller.STATUS_FAILURE_ABORTED -> {}
            else -> {
                val why = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "error $status"
                Toast.makeText(context, "The update didn't install: $why", Toast.LENGTH_LONG).show()
            }
        }
    }
}
