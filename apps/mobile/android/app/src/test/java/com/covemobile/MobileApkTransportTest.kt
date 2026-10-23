package com.covemobile

import java.io.File
import java.io.IOException
import java.security.MessageDigest
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import okio.Source
import okio.Timeout
import okio.buffer
import org.junit.Assert.*
import org.junit.Test

// Transport fixtures execute the production HTTP/stream/redirect paths without
// public network access, trust-store changes, credentials, or Android installs.
class MobileApkTransportTest {
  private val bytes = "synthetic APK transport payload".toByteArray()
  private val release = MobileApkRelease("0.9.0", 17, 24, "com.cove.mobile", "mobile-v0.9.0", "Cove-Mobile-0.9.0.apk", bytes.size.toLong(), MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
  private val initial = mobileApkDownloadUrl("github", "", release)!!

  private fun response(request: Request, code: Int = 200, body: ResponseBody = bytes.toResponseBody(), headers: Map<String, String> = emptyMap()): Response =
    Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("test fixture").body(body)
      .apply { headers.forEach { (key, value) -> header(key, value) } }.build()

  private fun client(handler: (Request) -> Response) = createMobileApkClient().newBuilder().addInterceptor(Interceptor { handler(it.request()) }).build()

  @Test fun redirectsAndSuccessfulTransferUseOnlyPinnedHttpsHostsAndNoRange() {
    val requests = mutableListOf<Request>()
    val client = client { request ->
      requests.add(request)
      if (requests.size == 1) response(request, 302, ByteArray(0).toResponseBody(), mapOf("Location" to "https://release-assets.githubusercontent.com/asset?signature=fixture"))
      else response(request)
    }
    val file = File.createTempFile("cove-http-success", ".part")
    try {
      downloadMobileApk(client, MobileApkDownload("success", release, initial), file) { }
      assertTrue(fileMatchesApk(file, release))
      assertEquals(listOf("github.com", "release-assets.githubusercontent.com"), requests.map { it.url.host })
      assertTrue(requests.all { it.header("Range") == null && it.header("Accept-Encoding") == "identity" })
    } finally { file.delete() }
  }

  @Test fun httpFailuresPartialBodiesEncodingAndIntegrityErrorsDeleteStagingAndCanRetry() {
    val badBodies = listOf<(Request) -> Response>(
      { response(it, 503) }, { response(it, 206) },
      { response(it, headers = mapOf("Content-Range" to "bytes 0-1/30")) },
      { response(it, headers = mapOf("Content-Encoding" to "gzip")) },
      { response(it, body = bytes.copyOf(bytes.size - 1).toResponseBody()) },
      { response(it, body = (bytes + 0).toResponseBody()) },
      { response(it, body = ByteArray(bytes.size).toResponseBody()) },
    )
    val file = File.createTempFile("cove-http-failure", ".part")
    try {
      for ((index, failure) in badBodies.withIndex()) {
        file.writeText("old interrupted bytes")
        assertThrows(Exception::class.java) { downloadMobileApk(client(failure), MobileApkDownload("failure-$index", release, initial), file) { } }
        assertFalse(file.exists())
        downloadMobileApk(client { response(it) }, MobileApkDownload("retry-$index", release, initial), file) { }
        assertTrue(fileMatchesApk(file, release))
      }
    } finally { file.delete() }
  }

  @Test fun interruptedOrCancelledReadCannotLeaveAnInstallablePartialFile() {
    val file = File.createTempFile("cove-http-interrupt", ".part")
    val source = object : Source {
      var count = 0
      override fun read(sink: Buffer, byteCount: Long): Long {
        if (count++ == 0) { sink.write(bytes, 0, 3); return 3 }
        throw IOException("fixture disconnect")
      }
      override fun timeout() = Timeout.NONE
      override fun close() { }
    }.buffer()
    val body = object : ResponseBody() {
      override fun contentType() = null
      override fun contentLength() = release.size
      override fun source() = source
    }
    try {
      assertThrows(IOException::class.java) { downloadMobileApk(client { response(it, body = body) }, MobileApkDownload("disconnect", release, initial), file) { } }
      assertFalse(file.exists())
      val job = MobileApkDownload("cancelled-read", release, initial)
      assertThrows(MobileUpdateException::class.java) {
        downloadMobileApk(client { response(it) }, job, file) { received -> if (received > 0) job.cancel() }
      }
      assertFalse(file.exists())
    } finally { file.delete() }
  }

  @Test fun redirectLoopsMissingLocationsAndHostDowngradesStopBeforeUntrustedTraffic() {
    for (location in listOf("http://github.com/asset", "https://attacker.test/asset", "https://github.com:444/asset", "https://user:secret@github.com/asset", "https://github.com/loop", "")) {
      var count = 0
      val client = client { request -> count++; response(request, 302, ByteArray(0).toResponseBody(), if (location.isEmpty()) emptyMap() else mapOf("Location" to location)) }
      val file = File.createTempFile("cove-http-redirect", ".part")
      try {
        assertThrows(IllegalStateException::class.java) { downloadMobileApk(client, MobileApkDownload("redirect", release, initial), file) { } }
        assertEquals(if (location == "https://github.com/loop") 6 else 1, count)
        assertFalse(file.exists())
      } finally { file.delete() }
    }
  }

  @Test fun feedReadsAreBoundedAndRedirectsCannotChangeOriginOrTls() {
    val url = "https://raw.githubusercontent.com/LumineTraveller/Cove/main/mobile/update.json".toHttpUrl()
    assertEquals("{}", readMobileUpdateFeed(client { response(it, body = "{}".toResponseBody()) }, url))
    assertThrows(IllegalStateException::class.java) { readMobileUpdateFeed(client { response(it, body = ByteArray(256 * 1024 + 1).toResponseBody()) }, url) }
    for (target in listOf("https://other.test/feed", "http://raw.githubusercontent.com/feed", "https://raw.githubusercontent.com:444/feed", "https://user:password@raw.githubusercontent.com/feed")) {
      var count = 0
      assertThrows(IllegalStateException::class.java) { readMobileUpdateFeed(client { count++; response(it, 302, "".toResponseBody(), mapOf("Location" to target)) }, url) }
      assertEquals(1, count)
    }
  }
}
