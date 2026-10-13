package com.covemobile

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

internal const val MAX_SOUNDPACK_BYTES = 8 * 1024 * 1024
internal const val MAX_SOUNDPACK_SELECTIONS = 20

/** The resource token may be in the query, but may never be sent to another origin. */
internal fun soundpackDownloadUrl(value: String, serverURL: String): HttpUrl? {
  val base = serverURL.trim().toHttpUrlOrNull() ?: return null
  val url = value.toHttpUrlOrNull() ?: return null
  if (base.scheme !in setOf("http", "https") || base.username.isNotEmpty() || base.password.isNotEmpty()
    || base.query != null || base.fragment != null || url.username.isNotEmpty() || url.password.isNotEmpty()
    || url.fragment != null || url.scheme != base.scheme || url.host != base.host || url.port != base.port) return null
  val prefix = base.encodedPath.trimEnd('/') + "/sounds/"
  if (!url.encodedPath.startsWith(prefix)) return null
  val filename = url.encodedPath.removePrefix(prefix)
  if (filename.isEmpty() || filename.contains('/') || filename.contains('\\')
    || url.pathSegments.last().contains('/') || url.pathSegments.last().contains('\\')
    || url.pathSegments.last() in setOf(".", "..")) return null
  return url
}

internal fun safeSoundpackFilename(value: String): String = value
  .replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_")
  .trim().trim('.').take(120).ifBlank { "Cove-soundpack.audio" }

internal fun soundpackTextDocument(text: String, fileName: String): Pair<String, ByteArray> {
  require(text.length <= 1024 * 1024) { "Text exceeds 1 MB" }
  val bytes = text.toByteArray(Charsets.UTF_8)
  val filename = safeSoundpackFilename(fileName)
  require(bytes.isNotEmpty() && bytes.size <= 1024 * 1024
    && Regex(".+\\.(json|txt)", RegexOption.IGNORE_CASE).matches(filename)) { "Choose a JSON or TXT filename and text up to 1 MB" }
  return filename to bytes
}

internal fun copySoundpackBytes(input: InputStream, output: OutputStream, cancelled: () -> Boolean): Int {
  var total = 0
  val buffer = ByteArray(32 * 1024)
  while (true) {
    check(!cancelled()) { "Soundpack operation cancelled" }
    val count = input.read(buffer)
    if (count < 0) break
    check(total + count <= MAX_SOUNDPACK_BYTES) { "Audio exceeds 8 MB" }
    output.write(buffer, 0, count)
    total += count
  }
  check(!cancelled()) { "Soundpack operation cancelled" }
  check(total > 0) { "Audio file is empty" }
  return total
}

/** PCM output matches the desktop's 16-bit mono/stereo WAV encoding. */
internal fun soundpackWav(pcm: ByteArray, sampleRate: Int, channels: Int): ByteArray {
  require(sampleRate in 1..384000 && channels in 1..2) { "Unsupported audio format" }
  require(pcm.isNotEmpty() && pcm.size % (channels * 2) == 0) { "Invalid PCM frames" }
  require(pcm.size + 44 <= MAX_SOUNDPACK_BYTES) { "Trimmed audio exceeds 8 MB" }
  return ByteArrayOutputStream(pcm.size + 44).apply {
    write(ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
      put("RIFF".toByteArray()); putInt(36 + pcm.size); put("WAVEfmt ".toByteArray())
      putInt(16); putShort(1); putShort(channels.toShort()); putInt(sampleRate)
      putInt(sampleRate * channels * 2); putShort((channels * 2).toShort()); putShort(16)
      put("data".toByteArray()); putInt(pcm.size)
    }.array())
    write(pcm)
  }.toByteArray()
}

internal fun validateSoundpackRange(start: Double, end: Double, duration: Double): Pair<Double, Double> {
  require(start.isFinite() && end.isFinite() && duration.isFinite() && duration > 0) { "Invalid audio duration" }
  val finalEnd = if (end <= 0) duration else end
  require(start >= 0 && start < finalEnd && finalEnd <= duration + 0.05) { "Invalid trim range" }
  return start to finalEnd.coerceAtMost(duration)
}
