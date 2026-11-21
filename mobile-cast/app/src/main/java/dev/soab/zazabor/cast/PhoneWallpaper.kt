package dev.soab.zazabor.cast

import android.app.WallpaperManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.drawable.BitmapDrawable
import android.util.Base64
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The phone's home-screen wallpaper, for the Phone section on the PC to wear (`wallpaper`).
 * Android 14+ shares the picture only with apps that have All files access. Without it, or with a
 * live wallpaper that has no still picture, the phone paints a backdrop from the wallpaper's
 * colours instead (Android shares those with every app), so the PC always wears the phone's look.
 */
object PhoneWallpaper {
    /** Longest side of the picture sent: plenty for a blurred backdrop and a small card. */
    private const val MAX_SIDE = 960

    /** A JPEG as base64, or null when the phone won't share one. */
    fun jpeg(context: Context): String? {
        val picture = picture(context) ?: fromColours(context) ?: return null
        val out = ByteArrayOutputStream()
        picture.compress(Bitmap.CompressFormat.JPEG, 82, out)
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    /** A portrait gradient in the wallpaper's own colours, with soft glows for depth. */
    private fun fromColours(context: Context): Bitmap? {
        val colours = try {
            WallpaperManager.getInstance(context).getWallpaperColors(WallpaperManager.FLAG_SYSTEM)
        } catch (_: RuntimeException) {
            null
        } ?: return null
        val primary = colours.primaryColor.toArgb()
        val secondary = colours.secondaryColor?.toArgb() ?: shade(primary, 0.55f)
        val tertiary = colours.tertiaryColor?.toArgb() ?: shade(secondary, 0.7f)
        val metrics = context.resources.displayMetrics
        val w = 540
        val h = (w * max(metrics.heightPixels, metrics.widthPixels).toFloat() / minOf(metrics.heightPixels, metrics.widthPixels).coerceAtLeast(1)).roundToInt().coerceIn(w, 1200)
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.shader = LinearGradient(0f, 0f, w * 0.4f, h.toFloat(), intArrayOf(primary, secondary, shade(tertiary, 0.6f)), null, Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, w.toFloat(), h.toFloat(), paint)
        fun glow(x: Float, y: Float, r: Float, colour: Int, alpha: Int) {
            paint.shader = RadialGradient(x, y, r, Color.argb(alpha, Color.red(colour), Color.green(colour), Color.blue(colour)), Color.TRANSPARENT, Shader.TileMode.CLAMP)
            canvas.drawCircle(x, y, r, paint)
        }
        glow(w * 0.85f, h * 0.18f, w * 0.75f, tertiary, 170)
        glow(w * 0.1f, h * 0.62f, w * 0.8f, primary, 150)
        glow(w * 0.7f, h * 0.95f, w * 0.7f, secondary, 160)
        return bitmap
    }

    private fun shade(colour: Int, f: Float) = Color.rgb(
        (Color.red(colour) * f).roundToInt(), (Color.green(colour) * f).roundToInt(), (Color.blue(colour) * f).roundToInt(),
    )

    /** The wallpaper itself, scaled down, or null when Android won't share it. */
    private fun picture(context: Context): Bitmap? {
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
        return if (scale < 1f) {
            Bitmap.createScaledBitmap(source, (source.width * scale).roundToInt(), (source.height * scale).roundToInt(), true)
        } else {
            source
        }
    }
}
