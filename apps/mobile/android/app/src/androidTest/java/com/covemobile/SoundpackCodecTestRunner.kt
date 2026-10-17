package com.covemobile

import android.app.Instrumentation
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Bundle
import android.os.SystemClock
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import kotlin.math.abs
import kotlin.math.sin

/** No test library or permission: every byte is generated in the isolated debug app's cache. */
class SoundpackCodecTestRunner : Instrumentation() {
  override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }

  override fun onStart() {
    val result = Bundle()
    var directory: File? = null
    try {
      check(targetContext.packageName == "com.cove.mobile.refactor") { "Codec tests require the isolated debug package" }
      directory = File(targetContext.cacheDir, "soundpack-codec-test-${UUID.randomUUID()}").apply { check(mkdirs()) }
      val rate = 48000
      val pcm = ByteBuffer.allocate(rate * 2).order(ByteOrder.LITTLE_ENDIAN).apply {
        for (frame in 0 until rate) putShort((sin(2 * Math.PI * 440 * frame / rate) * 12000).toInt().toShort())
      }.array()
      val wav = File(directory, "synthetic.wav").apply { writeBytes(soundpackWav(pcm, rate, 1)) }
      check(abs(soundpackDuration(wav) - 1) <= 0.005) { "WAV duration differs" }
      val trimmed = trimSoundpack(wav, 0.125, 0.625) { false }
      check(abs(trimmed.duration - 0.5) <= 1.0 / rate) { "WAV trim duration differs: ${trimmed.duration}" }
      val header = ByteBuffer.wrap(trimmed.bytes).order(ByteOrder.LITTLE_ENDIAN)
      check(header.getInt(24) == rate && header.getShort(22).toInt() == 1) { "WAV format differs" }
      check(trimmed.bytes.copyOfRange(44, trimmed.bytes.size).contentEquals(pcm.copyOfRange(12000, 60000))) { "WAV trim samples differ" }

      var cancelled = false
      try { trimSoundpack(wav, 0.1, 0.8) { true } }
      catch (error: IllegalStateException) { cancelled = error.message?.contains("cancelled") == true }
      check(cancelled) { "Codec cancellation was ignored" }
      check(abs(trimSoundpack(wav, 0.25, 0.75) { false }.duration - 0.5) <= 1.0 / rate) { "Codec did not recover after cancellation" }

      val compressed = File(directory, "synthetic.m4a")
      encodeSyntheticAac(compressed, 2)
      check(compressed.length() in 1..MAX_SOUNDPACK_BYTES.toLong()) { "AAC fixture size differs" }
      check(abs(soundpackDuration(compressed) - 2) < 0.1) { "AAC duration differs" }
      val aacTrim = trimSoundpack(compressed, 0.25, 0.75) { false }
      check(abs(aacTrim.duration - 0.5) <= 0.005) { "AAC trim duration differs: ${aacTrim.duration}" }
      val samples = ByteBuffer.wrap(aacTrim.bytes).order(ByteOrder.LITTLE_ENDIAN)
      check(samples.getShort(22).toInt() == 2 && samples.getInt(24) == rate) { "AAC decode format differs" }
      var energy = 0.0
      for (offset in 44 until aacTrim.bytes.size step 2) energy += abs(samples.getShort(offset).toInt())
      check(energy / ((aacTrim.bytes.size - 44) / 2) > 2000) { "AAC trim unexpectedly contains silence" }

      val longCompressed = File(directory, "synthetic-long.m4a")
      encodeSyntheticAac(longCompressed, 50)
      check(longCompressed.length() < MAX_SOUNDPACK_BYTES) { "Long compressed fixture is unexpectedly large" }
      var oversized = false
      try { trimSoundpack(longCompressed, 0.0, 49.0) { false } }
      catch (error: IllegalStateException) { oversized = error.message?.contains("8 MB") == true }
      check(oversized) { "Decoded output limit was ignored" }
      result.putString("stream", "PASS: WAV exact samples/range, AAC stereo trim/energy, cancellation recovery, decoded 8 MB cap; 4 native codec cases.\n")
      result.putInt("passed", 4)
      finish(0, result)
    } catch (error: Throwable) {
      result.putString("stream", "FAIL: ${error.javaClass.simpleName}: ${error.message}\n${error.stackTraceToString()}\n")
      result.putInt("failed", 1)
      finish(-1, result)
    } finally {
      // Only this exact, freshly created synthetic directory is eligible for cleanup.
      directory?.listFiles()?.forEach { it.delete() }; directory?.delete()
    }
  }

  private fun encodeSyntheticAac(file: File, seconds: Int) {
    val rate = 48000
    val channels = 2
    val format = MediaFormat.createAudioFormat("audio/mp4a-latm", rate, channels).apply {
      setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      setInteger(MediaFormat.KEY_BIT_RATE, 64000)
      setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
    }
    val codec = MediaCodec.createEncoderByType("audio/mp4a-latm")
    val muxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    var codecStarted = false
    var muxerStarted = false
    try {
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE); codec.start(); codecStarted = true
      val totalFrames = rate * seconds
      var frame = 0
      var inputEnded = false
      var outputEnded = false
      var track = -1
      val info = MediaCodec.BufferInfo()
      val deadline = SystemClock.elapsedRealtime() + 60000
      while (!outputEnded) {
        check(SystemClock.elapsedRealtime() < deadline) { "Synthetic AAC encoding timed out" }
        if (!inputEnded) {
          val input = codec.dequeueInputBuffer(10000)
          if (input >= 0) {
            val buffer = codec.getInputBuffer(input)!!.apply { clear(); order(ByteOrder.LITTLE_ENDIAN) }
            if (frame == totalFrames) {
              codec.queueInputBuffer(input, 0, 0, frame * 1000000L / rate, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputEnded = true
            } else {
              val count = (buffer.remaining() / (channels * 2)).coerceAtMost(totalFrames - frame)
              val time = frame * 1000000L / rate
              for (index in 0 until count) {
                val sample = (sin(2 * Math.PI * 440 * (frame + index) / rate) * 12000).toInt().toShort()
                repeat(channels) { buffer.putShort(sample) }
              }
              codec.queueInputBuffer(input, 0, count * channels * 2, time, 0); frame += count
            }
          }
        }
        val output = codec.dequeueOutputBuffer(info, 10000)
        if (output == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          track = muxer.addTrack(codec.outputFormat); muxer.start(); muxerStarted = true
        } else if (output >= 0) {
          try {
            if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
              check(muxerStarted) { "AAC muxer has no output format" }
              val buffer = codec.getOutputBuffer(output)!!
              buffer.position(info.offset); buffer.limit(info.offset + info.size)
              muxer.writeSampleData(track, buffer, info)
            }
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputEnded = true
          } finally { codec.releaseOutputBuffer(output, false) }
        }
      }
    } finally {
      if (codecStarted) try { codec.stop() } catch (_: Exception) { }
      codec.release()
      if (muxerStarted) try { muxer.stop() } catch (_: Exception) { }
      muxer.release()
    }
  }
}
