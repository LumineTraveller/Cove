package com.covemobile

import java.net.ProtocolException
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Connection
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer
import org.junit.Assert.*
import org.junit.Test

/** Simulated network responses only: the dummy Call is never executed. */
class SoundpackRedirectGuardTest {
  private class TrackingBody : ResponseBody() {
    var closed = false
    private val input = object : ForwardingSource(Buffer().writeUtf8("synthetic audio")) {
      override fun close() { closed = true; super.close() }
    }.buffer()
    override fun contentType(): MediaType? = null
    override fun contentLength() = -1L
    override fun source(): BufferedSource = input
  }

  private class FakeChain(val input: Request, val output: Response) : Interceptor.Chain {
    var calls = 0
    override fun request(): Request = input
    override fun proceed(request: Request): Response {
      assertSame(input, request)
      calls++
      return output
    }
    override fun connection(): Connection? = null
    override fun call(): Call = OkHttpClient().newCall(input)
    override fun connectTimeoutMillis() = 10000
    override fun readTimeoutMillis() = 30000
    override fun writeTimeoutMillis() = 10000
    override fun withConnectTimeout(timeout: Int, unit: TimeUnit): Interceptor.Chain = this
    override fun withReadTimeout(timeout: Int, unit: TimeUnit): Interceptor.Chain = this
    override fun withWriteTimeout(timeout: Int, unit: TimeUnit): Interceptor.Chain = this
  }

  private fun chain(code: Int, token: Boolean = true, location: String? = null): Pair<FakeChain, TrackingBody> {
    val request = Request.Builder().url("https://synthetic.test/cove/api/soundpacks/sound/file?roomId=room&variant=playback")
      .apply { if (token) header("x-cove-account-token", "synthetic-token") }.build()
    val body = TrackingBody()
    val response = Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("Synthetic")
      .body(body).apply { if (location != null) header("Location", location) }.build()
    return FakeChain(request, response) to body
  }

  @Test fun rejectsSameOriginAndCrossOriginRedirectsBeforeAnySecondRequestAndClosesBody() {
    for (code in listOf(300, 301, 302, 303, 304, 307, 308, 399)) {
      for (location in listOf("/cove/other", "https://other.test/collect")) {
        val (chain, body) = chain(code, location = location)
        val error = assertThrows(ProtocolException::class.java) { SoundpackRedirectGuard().intercept(chain) }
        assertFalse(error.message!!.contains("synthetic-token"))
        assertTrue(body.closed)
        assertEquals(1, chain.calls)
      }
    }
  }

  @Test fun rejectsProtectedRedirectWithoutLocationAndEvenWithEmptyTokenHeader() {
    val (chain, body) = chain(302)
    assertThrows(ProtocolException::class.java) { SoundpackRedirectGuard().intercept(chain) }
    assertTrue(body.closed)
    val empty = chain.input.newBuilder().header("X-Cove-Account-Token", "").build()
    val second = FakeChain(empty, chain.output.newBuilder().request(empty).body(TrackingBody()).build())
    assertThrows(ProtocolException::class.java) { SoundpackRedirectGuard().intercept(second) }
    assertEquals(1, second.calls)
  }

  @Test fun responsesWithoutAccountHeaderKeepExistingBehaviorIncludingRedirects() {
    for (code in listOf(200, 302, 307, 401, 500)) {
      val (chain, body) = chain(code, token = false, location = "https://other.test/legacy")
      assertSame(chain.output, SoundpackRedirectGuard().intercept(chain))
      assertFalse(body.closed)
      assertEquals(1, chain.calls)
      chain.output.close()
    }
  }

  @Test fun protectedNonRedirectResponsePassesThroughWithoutClosingBody() {
    for (code in listOf(200, 204, 206, 400, 401, 403, 404, 500)) {
      val (chain, body) = chain(code)
      assertSame(chain.output, SoundpackRedirectGuard().intercept(chain))
      assertFalse(body.closed)
      assertEquals(1, chain.calls)
      chain.output.close()
    }
  }

  @Test fun sharedClientRegistersGuardAsNetworkInterceptor() {
    val client = ServerCertificateNetwork.createClient(OkHttpClient())
    assertTrue(client.networkInterceptors.any { it is SoundpackRedirectGuard })
    assertFalse(client.interceptors.any { it is SoundpackRedirectGuard })
    // General unauthenticated traffic retains the base client's redirect setting.
    assertTrue(client.followRedirects)
    assertTrue(client.followSslRedirects)
  }
}
