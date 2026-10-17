package com.covemobile

import okhttp3.Authenticator
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Test

/** Host-only access checks: no Android audio, file picker, device, or network execution. */
class SoundpackDownloadAccessTest {
  private val base = "https://synthetic.test/cove/"
  private val original = "https://synthetic.test/cove/api/soundpacks/sound-1/file?roomId=room-1&variant=original"
  private val headers = mapOf(
    "Authorization" to "Bearer synthetic-server-grant",
    "X-Cove-Account-Token" to "synthetic-account-token",
    "X-Cove-Client-Protocol" to "3",
    "X-Cove-Client-Version" to "0.3.3-test.1",
    "X-Cove-Client-Platform" to "mobile",
  )
  private fun url(value: String = original, server: String = base, room: String = "room-1",
    sound: String = "sound-1", variant: String = "original") =
    soundpackDownloadUrl(value, server, room, sound, variant)

  @Test fun protectedEndpointPreservesExactOriginBasePathAndScope() {
    assertNotNull(url())
    assertNotNull(url(original.replace("https://synthetic.test", "https://synthetic.test:443")))
    assertNotNull(url(original.replace("variant=original", "variant=playback"), variant = "playback"))
    assertNotNull(url("http://10.0.2.2:3301/api/soundpacks/sound-1/file?variant=original&roomId=room-1",
      server = "http://10.0.2.2:3301"))
    assertNotNull(url(original.replace("sound-1", "sound%20one"), sound = "sound one"))
    assertNotNull(url(original.replace("room-1", "room%20one"), room = "room one"))
  }

  @Test fun rejectsOtherOriginsUserInfoFragmentsAndUnprotectedPaths() {
    for (value in listOf(
      original.replace("synthetic.test", "other.test"), original.replace("https:", "http:"),
      original.replace("synthetic.test", "synthetic.test:444"),
      original.replace("synthetic.test", "user:synthetic@synthetic.test"),
      original.replace("synthetic.test", "@synthetic.test"), "$original#fragment",
      original.replace("/cove/", "/"), original.replace("/api/soundpacks/sound-1/file", "/sounds/sound-1.mp3"),
      original.replace("/file?", "/file/extra?"), original.replace("/file?", "/file/?"),
      original.replace("/sound-1/", "/sound-1%2Fchild/"),
      original.replace("/sound-1/", "/sound-1%5Cchild/"),
      original.replace("/sound-1/", "/other/../sound-1/"),
      original.replace("/sound-1/", "/other/%2e%2e/sound-1/"),
      " $original", "$original\n", original.replace("/cove/", "/cove\\"),
    )) assertNull(value, url(value))
  }

  @Test fun rejectsInvalidConfiguredServerAndScope() {
    for (server in listOf("", "file:///cove/", "$base?access_token=synthetic", "$base#fragment",
      "https://user:synthetic@synthetic.test/cove/", "https://@synthetic.test/cove/")) {
      assertNull(server, url(server = server))
    }
    for (room in listOf("", " room-1", "room-1\r", "r".repeat(513))) assertNull(url(room = room))
    for (sound in listOf("", ".", "..", "a/b", "a\\b", "a\n", "s".repeat(513))) assertNull(url(sound = sound))
    assertNull(url(variant = "unknown"))
    assertNull(url(room = "room-2"))
    assertNull(url(sound = "sound-2"))
    assertNull(url(variant = "playback"))
  }

  @Test fun onlyRoomAndVariantQueriesAreAllowedExactlyOnce() {
    for (value in listOf(original.substringBefore('?'), "$original&roomId=room-1", "$original&variant=original",
      "$original&access_token=synthetic", "$original&accountToken=synthetic", "$original&socketId=synthetic",
      "$original&extra=", original.replace("roomId=room-1&", ""), original.replace("&variant=original", ""),
      original.replace("roomId=room-1", "roomId="), original.replace("variant=original", "variant="),
      original.replace("roomId=room-1", "roomId=room-2"))) assertNull(value, url(value))
  }

  @Test fun requestUsesOnlyValidatedAuthMetadataAndIdentityEncoding() {
    val request = soundpackDownloadRequest(original, base, "room-1", "sound-1", "original", headers)!!
    assertEquals("GET", request.method)
    assertEquals(original, request.url.toString())
    assertEquals("identity", request.header("Accept-Encoding"))
    assertEquals(headers.size + 1, request.headers.size)
    headers.forEach { (key, value) -> assertEquals(value, request.header(key)) }
    assertNull(request.header("Cookie"))
    assertFalse(request.url.toString().contains("synthetic-account-token"))
    assertFalse(request.url.toString().contains("synthetic-server-grant"))
    assertNull(soundpackDownloadRequest(original, base, "room-2", "sound-1", "original", headers))
    assertNull(soundpackDownloadRequest(original, base, "room-1", "sound-1", "original", emptyMap()))
  }

  @Test fun disabledServerSecurityStillRequiresAccountAndClientMetadata() {
    assertNotNull(soundpackDownloadHeaders(headers - "Authorization"))
    for (key in headers.keys - "Authorization") assertNull(key, soundpackDownloadHeaders(headers - key))
    val lowercase = headers.mapKeys { (key, _) -> key.lowercase() }
    assertEquals(headers, soundpackDownloadHeaders(lowercase))
  }

  @Test fun rejectsUnknownOrDuplicateHeadersIncludingCookieAndHost() {
    for (key in listOf("Cookie", "Host", "Proxy-Authorization", "Accept-Encoding", "X-Custom", " Authorization")) {
      assertNull(key, soundpackDownloadHeaders(headers + (key to "synthetic")))
    }
    assertNull(soundpackDownloadHeaders(headers + ("authorization" to "Bearer synthetic")))
  }

  @Test fun rejectsEmptyOversizedWhitespaceAndControlHeaderValues() {
    for (key in headers.keys) {
      for (value in listOf("", " ", "synthetic\rInjected: synthetic", "synthetic\nInjected: synthetic",
        "synthetic\u0000", "synthetic\u007f", "synthetic\u0080", " synthetic", "synthetic ", "a".repeat(4097))) {
        assertNull("$key rejects unsafe value", soundpackDownloadHeaders(headers + (key to value)))
      }
    }
    assertNull(soundpackDownloadHeaders(headers + ("X-Cove-Account-Token" to "synthetic token")))
  }

  @Test fun validatesBearerAndExplicitMobileProtocolVersionMetadata() {
    for (value in listOf("Basic synthetic", "Bearer", "Bearer ", "Bearer synthetic token", "bearer synthetic")) {
      assertNull(value, soundpackDownloadHeaders(headers + ("Authorization" to value)))
    }
    for (value in listOf("0", "-1", "3.0", "3x", "9999999")) {
      assertNull(value, soundpackDownloadHeaders(headers + ("X-Cove-Client-Protocol" to value)))
    }
    for (value in listOf("unknown", "3", "v0.3.3", "0.3.3 extra", "1.2.")) {
      assertNull(value, soundpackDownloadHeaders(headers + ("X-Cove-Client-Version" to value)))
    }
    assertNull(soundpackDownloadHeaders(headers + ("X-Cove-Client-Platform" to "desktop")))
  }

  @Test fun clientCannotRedirectAttachCookiesOrInvokeAuthenticators() {
    val client = soundpackDownloadClient(OkHttpClient.Builder()
      .followRedirects(true).followSslRedirects(true).build())
    assertFalse(client.followRedirects)
    assertFalse(client.followSslRedirects)
    assertSame(CookieJar.NO_COOKIES, client.cookieJar)
    assertSame(Authenticator.NONE, client.authenticator)
    assertSame(Authenticator.NONE, client.proxyAuthenticator)
    assertEquals(10000, client.connectTimeoutMillis)
    assertEquals(30000, client.readTimeoutMillis)
    assertEquals(60000, client.callTimeoutMillis)
  }
}
