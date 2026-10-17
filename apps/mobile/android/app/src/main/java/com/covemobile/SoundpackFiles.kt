package com.covemobile

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import okhttp3.Authenticator
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

internal const val MAX_SOUNDPACK_BYTES = 8 * 1024 * 1024
internal const val MAX_SOUNDPACK_SELECTIONS = 20

/** Only the current room's protected endpoint may receive account/server headers. */
internal fun soundpackDownloadUrl(value: String, serverURL: String, roomId: String,
  soundId: String, variant: String): HttpUrl? {
  if (value != value.trim() || value.any { it <= ' ' || it == '\u007f' || it == '\\' }
    || roomId.isEmpty() || roomId.length > 512 || roomId != roomId.trim() || roomId.any { it.isISOControl() }
    || soundId.isEmpty() || soundId.length > 512 || soundId in setOf(".", "..")
    || soundId.any { it.isISOControl() || it == '/' || it == '\\' }
    || variant !in setOf("playback", "original")) return null
  val baseValue = serverURL.trim()
  val base = baseValue.toHttpUrlOrNull() ?: return null
  val url = value.toHttpUrlOrNull() ?: return null
  val rawBase = try { URI(baseValue) } catch (_: Exception) { return null }
  val raw = try { URI(value) } catch (_: Exception) { return null }
  if (base.scheme !in setOf("http", "https") || base.username.isNotEmpty() || base.password.isNotEmpty()
    || base.query != null || base.fragment != null || url.username.isNotEmpty() || url.password.isNotEmpty()
    || rawBase.rawUserInfo != null || raw.rawUserInfo != null
    || url.fragment != null || url.scheme != base.scheme || url.host != base.host || url.port != base.port) return null
  val expected = base.newBuilder().encodedPath(base.encodedPath.trimEnd('/') + "/api/soundpacks/")
    .addPathSegment(soundId).addPathSegment("file").build()
  // Reject normalized traversal, encoded path aliases, old public files and other APIs.
  if (raw.rawPath != url.encodedPath || url.encodedPath != expected.encodedPath
    || url.querySize != 2 || url.queryParameterNames != setOf("roomId", "variant")
    || url.queryParameter("roomId") != roomId || url.queryParameter("variant") != variant) return null
  return url
}

internal fun soundpackDownloadHeaders(values: Map<String, String>): Map<String, String>? {
  val allowed = mapOf("authorization" to "Authorization", "x-cove-account-token" to "X-Cove-Account-Token",
    "x-cove-client-protocol" to "X-Cove-Client-Protocol", "x-cove-client-version" to "X-Cove-Client-Version",
    "x-cove-client-platform" to "X-Cove-Client-Platform")
  val result = linkedMapOf<String, String>()
  for ((key, value) in values) {
    val name = allowed[key.lowercase()] ?: return null
    if (result.containsKey(name) || value.isEmpty() || value.length > 4096
      || value.any { it < ' ' || it > '~' } || value != value.trim()) return null
    result[name] = value
  }
  val account = result["X-Cove-Account-Token"] ?: return null
  if (account.any { it == ' ' }) return null
  val protocol = result["X-Cove-Client-Protocol"] ?: return null
  val version = result["X-Cove-Client-Version"] ?: return null
  if (!Regex("[1-9][0-9]{0,5}").matches(protocol)
    || version.length > 128 || !Regex("[0-9]+(?:\\.[0-9]+){1,3}(?:[-+][A-Za-z0-9._+-]+)?").matches(version)
    || result["X-Cove-Client-Platform"] != "mobile") return null
  result["Authorization"]?.let {
    if (!it.startsWith("Bearer ") || it.length <= 7 || it.substring(7).any { character -> character == ' ' }) return null
  }
  return result
}

internal fun soundpackDownloadRequest(value: String, serverURL: String, roomId: String,
  soundId: String, variant: String, values: Map<String, String>): Request? {
  val url = soundpackDownloadUrl(value, serverURL, roomId, soundId, variant) ?: return null
  val headers = soundpackDownloadHeaders(values) ?: return null
  return Request.Builder().url(url).header("Accept-Encoding", "identity").apply {
    for ((name, header) in headers) header(name, header)
  }.build()
}

internal fun soundpackDownloadClient(client: OkHttpClient): OkHttpClient = client.newBuilder()
  .connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
  .cookieJar(CookieJar.NO_COOKIES).authenticator(Authenticator.NONE).proxyAuthenticator(Authenticator.NONE)
  .callTimeout(60, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()

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
