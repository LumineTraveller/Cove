package com.covemobile

import org.junit.Assert.*
import org.junit.Test

class MobileUpdateNetworkTest {
  @Test fun updatesUseBoundedStrictTlsAndSelectedServer() {
    val client = createMobileUpdateClient()
    assertEquals(5000, client.connectTimeoutMillis)
    assertEquals(10000, client.readTimeoutMillis)
    assertEquals(15000, client.callTimeoutMillis)
    assertFalse(client.followSslRedirects)
    assertEquals("https://raw.githubusercontent.com/LumineTraveller/Cove/main/mobile/update.json", mobileUpdateFeedUrl("github", ""))
    assertEquals("https://server.example.test/cove/releases/mobile/update.json", mobileUpdateFeedUrl("cloud", "https://server.example.test/cove/"))
    assertNull(mobileUpdateFeedUrl("cloud", "http://server.example.test"))
    assertNull(mobileUpdateFeedUrl("cloud", "https://user:secret@server.example.test"))
    assertNull(mobileUpdateFeedUrl("gitee", "https://server.example.test"))
    assertNull(mobileUpdateFeedUrl("https://example.test/malware.json", ""))
  }
}
