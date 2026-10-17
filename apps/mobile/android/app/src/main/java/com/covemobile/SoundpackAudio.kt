package com.covemobile

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.os.SystemClock
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteOrder

internal fun soundpackDuration(file: File): Double {
  val retriever = MediaMetadataRetriever()
  try {
    retriever.setDataSource(file.absolutePath)
    val millis = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull()
    if (millis != null && millis > 0) return millis / 1000
  } finally { retriever.release() }
  val extractor = MediaExtractor()
  try {
    extractor.setDataSource(file.absolutePath)
    for (index in 0 until extractor.trackCount) {
      val format = extractor.getTrackFormat(index)
      if (format.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
        && format.containsKey(MediaFormat.KEY_DURATION)) return format.getLong(MediaFormat.KEY_DURATION) / 1000000.0
    }
  } finally { extractor.release() }
  error("Android cannot read the duration of this audio file")
}

internal data class SoundpackTrim(val bytes: ByteArray, val duration: Double)

/** Decode only user-selected cache files. No recorder, storage or media permission is used. */
internal fun trimSoundpack(file: File, start: Double, end: Double, cancelled: () -> Boolean): SoundpackTrim {
  val extractor = MediaExtractor()
  var decoder: MediaCodec? = null
  var started = false
  try {
    extractor.setDataSource(file.absolutePath)
    val track = (0 until extractor.trackCount).firstOrNull {
      extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
    } ?: error("The selected file has no audio track")
    extractor.selectTrack(track)
    val source = extractor.getTrackFormat(track)
    val mime = source.getString(MediaFormat.KEY_MIME) ?: error("Unknown audio format")
    // Do not relabel raw WAV input (e.g. float PCM) as 16-bit encoded samples.
    if (mime != "audio/raw") source.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
    val codec = MediaCodec.createDecoderByType(mime).also { decoder = it }
    codec.configure(source, null, null, 0)
    codec.start(); started = true
    val startUs = (start * 1000000).toLong()
    val endUs = (end * 1000000).toLong()
    extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
    var sampleRate = source.getInteger(MediaFormat.KEY_SAMPLE_RATE)
    var channelCount = source.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
    var pcmEncoding = if (source.containsKey(MediaFormat.KEY_PCM_ENCODING)) source.getInteger(MediaFormat.KEY_PCM_ENCODING) else AudioFormat.ENCODING_PCM_16BIT
    check(sampleRate in 1..384000 && channelCount in 1..32
      && pcmEncoding in setOf(AudioFormat.ENCODING_PCM_16BIT, AudioFormat.ENCODING_PCM_FLOAT)) { "Unsupported Android PCM format" }
    var inputEnded = false
    var outputEnded = false
    var collectedFrames = 0L
    val output = ByteArrayOutputStream()
    val info = MediaCodec.BufferInfo()
    val deadline = SystemClock.elapsedRealtime() + 30000
    while (!outputEnded) {
      check(!cancelled()) { "Soundpack operation cancelled" }
      check(SystemClock.elapsedRealtime() < deadline) { "Audio decoding timed out" }
      if (!inputEnded) {
        val slot = codec.dequeueInputBuffer(10000)
        if (slot >= 0) {
          val buffer = codec.getInputBuffer(slot) ?: error("Audio decoder has no input buffer")
          val count = extractor.readSampleData(buffer, 0)
          if (count < 0 || extractor.sampleTime >= endUs + 1000000) {
            codec.queueInputBuffer(slot, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputEnded = true
          } else {
            codec.queueInputBuffer(slot, 0, count, extractor.sampleTime, 0); extractor.advance()
          }
        }
      }
      val slot = codec.dequeueOutputBuffer(info, 10000)
      when {
        slot == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          val format = codec.outputFormat
          val newRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
          val newChannels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
          check(output.size() == 0 || newRate == sampleRate && newChannels == channelCount) { "Audio format changed during decoding" }
          sampleRate = newRate; channelCount = newChannels
          pcmEncoding = if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) format.getInteger(MediaFormat.KEY_PCM_ENCODING) else AudioFormat.ENCODING_PCM_16BIT
          check(sampleRate in 1..384000 && channelCount in 1..32
            && pcmEncoding in setOf(AudioFormat.ENCODING_PCM_16BIT, AudioFormat.ENCODING_PCM_FLOAT)) { "Unsupported Android PCM format" }
        }
        slot >= 0 -> {
          try {
            if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
              val buffer = codec.getOutputBuffer(slot) ?: error("Audio decoder has no output buffer")
              buffer.position(info.offset); buffer.limit(info.offset + info.size); buffer.order(ByteOrder.LITTLE_ENDIAN)
              val bytesPerSample = if (pcmEncoding == AudioFormat.ENCODING_PCM_FLOAT) 4 else 2
              val frames = info.size / (bytesPerSample * channelCount)
              val first = kotlin.math.ceil((startUs - info.presentationTimeUs) * sampleRate / 1000000.0).toInt().coerceIn(0, frames)
              val last = kotlin.math.ceil((endUs - info.presentationTimeUs) * sampleRate / 1000000.0).toInt().coerceIn(0, frames)
              val savedChannels = channelCount.coerceAtMost(2)
              check(output.size().toLong() + (last - first).coerceAtLeast(0).toLong() * savedChannels * 2 + 44 <= MAX_SOUNDPACK_BYTES) { "Trimmed audio exceeds 8 MB" }
              for (frame in first until last) {
                for (channel in 0 until savedChannels) {
                  val offset = info.offset + (frame * channelCount + channel) * bytesPerSample
                  val sample = if (pcmEncoding == AudioFormat.ENCODING_PCM_FLOAT) {
                    val value = buffer.getFloat(offset).let { if (it.isFinite()) it.coerceIn(-1f, 1f) else 0f }
                    (value * if (value < 0) 32768 else 32767).toInt()
                  } else buffer.getShort(offset).toInt()
                  output.write(sample and 255); output.write((sample ushr 8) and 255)
                }
              }
              collectedFrames += (last - first).coerceAtLeast(0)
              if (info.presentationTimeUs + frames * 1000000L / sampleRate >= endUs) outputEnded = true
            }
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputEnded = true
          } finally { codec.releaseOutputBuffer(slot, false) }
        }
      }
    }
    check(!cancelled()) { "Soundpack operation cancelled" }
    check(collectedFrames > 0) { "The selected trim contains no audio" }
    return SoundpackTrim(soundpackWav(output.toByteArray(), sampleRate, channelCount.coerceAtMost(2)), collectedFrames.toDouble() / sampleRate)
  } finally {
    if (started) try { decoder?.stop() } catch (_: Exception) { }
    decoder?.release(); extractor.release()
  }
}
