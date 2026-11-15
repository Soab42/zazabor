package dev.soab.zazabor.cast

import android.app.WallpaperManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.util.Base64
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The phone's home-screen wallpaper, for the Phone section on the PC to wear (`wallpaper`).
 * Android shares it only with apps that have All files access (the Files permission); without it,
 * or with a live wallpaper that has no still picture, there's none and the PC keeps its own look.
 */
object PhoneWallpaper {
    /** Longest side of the picture sent: plenty for a blurred backdrop and a small card. */
    private const val MAX_SIDE = 960

    /** A JPEG as base64, or null when the phone won't share one. */
    fun jpeg(context: Context): String? {
        val drawable = try {
            WallpaperManager.getInstance(context).drawable
        } catch (_: SecurityException) {
            null
        } catch (_: RuntimeException) {
            null
        } ?: return null
        val source = (drawable as? BitmapDrawable)?.bitmap ?: run {
            val w = drawable.intrinsicWidth.takeIf { it > 0 } ?: return null
            val h = drawable.intrinsicHeight.takeIf { it > 0 } ?: return null
            Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { bitmap ->
                drawable.setBounds(0, 0, w, h)
                drawable.draw(Canvas(bitmap))
            }
        }
        val scale = MAX_SIDE.toFloat() / max(source.width, source.height)
        val picture = if (scale < 1f) {
            Bitmap.createScaledBitmap(source, (source.width * scale).roundToInt(), (source.height * scale).roundToInt(), true)
        } else {
            source
        }
        val out = ByteArrayOutputStream()
        picture.compress(Bitmap.CompressFormat.JPEG, 82, out)
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
}
