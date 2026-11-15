package dev.soab.zazabor.cast

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Surface
import kotlin.concurrent.thread
import kotlin.math.abs
import kotlin.math.max

/** Hands an encoded packet on: kind, flags, presentation time (µs), bytes. */
typealias PacketSink = (Int, Int, Long, ByteArray) -> Unit

private const val TAG = "ZazaborCast"

/** The size the screen is encoded at: the long side at most 1920, the aspect kept, even sides. */
data class CaptureSize(val width: Int, val height: Int, val dpi: Int) {
    companion object {
        private const val MAX_SIDE = 1920

        fun of(screenWidth: Int, screenHeight: Int, dpi: Int): CaptureSize {
            val scale = minOf(1.0, MAX_SIDE.toDouble() / max(screenWidth, screenHeight))
            val w = (screenWidth * scale).toInt() and 1.inv()
            val h = (screenHeight * scale).toInt() and 1.inv()
            return CaptureSize(max(w, 2), max(h, 2), dpi)
        }
    }
}

/** H.264 from a Surface (the VirtualDisplay draws into it). */
class VideoEncoder(val requested: CaptureSize, private val sink: PacketSink) {
    private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    var width = requested.width
        private set
    var height = requested.height
        private set
    lateinit var surface: Surface
        private set

    @Volatile
    private var running = false
    private var drainer: Thread? = null

    fun start(): Surface {
        try {
            configure(width, height)
        } catch (e: Exception) {
            // Some encoders want sides in multiples of 16.
            Log.w(TAG, "encoder refused ${width}x$height, trying 16-aligned", e)
            codec.reset()
            width = width and 15.inv()
            height = height and 15.inv()
            configure(width, height)
        }
        surface = codec.createInputSurface()
        codec.start()
        running = true
        drainer = thread(name = "zmir-video", isDaemon = true) { drain() }
        return surface
    }

    private fun configure(w: Int, h: Int) {
        val pixels = w * h
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, if (pixels >= 1_400_000) 8_000_000 else 6_000_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, 60)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
            // A still screen keeps sending frames (10 a second), so the PC's clock keeps moving.
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000)
            setInteger(MediaFormat.KEY_PRIORITY, 0)
            setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
            if (Build.VERSION.SDK_INT >= 30 && lowLatencySupported()) {
                setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
            }
        }
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    }

    private fun lowLatencySupported(): Boolean = try {
        codec.codecInfo.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC)
            .isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency)
    } catch (_: Exception) {
        false
    }

    private fun drain() {
        val info = MediaCodec.BufferInfo()
        while (running) {
            val index = try {
                codec.dequeueOutputBuffer(info, 100_000)
            } catch (_: IllegalStateException) {
                break
            }
            if (index < 0) continue
            val buffer = codec.getOutputBuffer(index)
            if (buffer != null && info.size > 0) {
                val bytes = ByteArray(info.size)
                buffer.position(info.offset)
                buffer.get(bytes, 0, info.size)
                val flags = when {
                    info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0 -> Zmir.FLAG_CONFIG
                    info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0 -> Zmir.FLAG_KEY
                    else -> 0
                }
                sink(Zmir.VIDEO, flags, info.presentationTimeUs, bytes)
            }
            codec.releaseOutputBuffer(index, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
        }
    }

    fun requestKeyFrame() {
        try {
            codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
        } catch (_: Exception) {
        }
    }

    fun stop() {
        running = false
        drainer?.join(1000)
        try {
            codec.stop()
        } catch (_: Exception) {
        }
        codec.release()
        if (::surface.isInitialized) surface.release()
    }
}

/** What other apps play (AudioPlaybackCapture), as AAC-LC 48 kHz stereo. */
class AudioEncoder(private val record: AudioRecord, private val sink: PacketSink) {
    companion object {
        const val RATE = 48_000
        const val CHANNELS = 2
        private const val BYTES_PER_FRAME = 4 // 16-bit stereo
        private const val CHUNK = 1024 * BYTES_PER_FRAME

        /** Null when capture isn't possible (needs RECORD_AUDIO; some devices refuse). */
        @SuppressLint("MissingPermission")
        fun capture(projection: MediaProjection): AudioRecord? = try {
            val config = AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build()
            val format = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                .build()
            val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)
            val record = AudioRecord.Builder()
                .setAudioFormat(format)
                .setBufferSizeInBytes(max(min, CHUNK * 8))
                .setAudioPlaybackCaptureConfig(config)
                .build()
            if (record.state == AudioRecord.STATE_INITIALIZED) {
                record
            } else {
                record.release()
                null
            }
        } catch (e: Exception) {
            Log.w(TAG, "no audio capture", e)
            null
        }
    }

    private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)

    @Volatile
    private var running = false
    private var worker: Thread? = null

    fun start() {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, RATE, CHANNELS).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, CHUNK * 4)
        }
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
        record.startRecording()
        running = true
        worker = thread(name = "zmir-audio", isDaemon = true) { run() }
    }

    private fun run() {
        val pcm = ByteArray(CHUNK)
        val info = MediaCodec.BufferInfo()
        var anchorUs = -1L
        var frames = 0L
        while (running) {
            val n = record.read(pcm, 0, pcm.size)
            if (n < 0) break
            if (n == 0) continue
            // Time the first sample of this chunk on the same clock as the screen's frames
            // (System.nanoTime), counting samples so the timestamps stay smooth.
            val count = n / BYTES_PER_FRAME
            val now = System.nanoTime() / 1000 - count * 1_000_000L / RATE
            val expected = anchorUs + frames * 1_000_000L / RATE
            if (anchorUs < 0 || abs(expected - now) > 200_000) {
                anchorUs = now
                frames = 0
            }
            val pts = anchorUs + frames * 1_000_000L / RATE
            frames += count
            try {
                val index = codec.dequeueInputBuffer(20_000)
                if (index >= 0) {
                    val buffer = codec.getInputBuffer(index)!!
                    buffer.clear()
                    val len = minOf(n, buffer.remaining())
                    buffer.put(pcm, 0, len)
                    codec.queueInputBuffer(index, 0, len, pts, 0)
                }
                drain(info)
            } catch (_: IllegalStateException) {
                break
            }
        }
    }

    private fun drain(info: MediaCodec.BufferInfo) {
        while (true) {
            val index = codec.dequeueOutputBuffer(info, 0)
            if (index < 0) return
            val buffer = codec.getOutputBuffer(index)
            if (buffer != null && info.size > 0) {
                val bytes = ByteArray(info.size)
                buffer.position(info.offset)
                buffer.get(bytes, 0, info.size)
                val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                sink(Zmir.AUDIO, if (config) Zmir.FLAG_CONFIG else 0, info.presentationTimeUs, bytes)
            }
            codec.releaseOutputBuffer(index, false)
        }
    }

    fun stop() {
        running = false
        try {
            record.stop()
        } catch (_: Exception) {
        }
        worker?.join(1000)
        try {
            codec.stop()
        } catch (_: Exception) {
        }
        codec.release()
        record.release()
    }
}
