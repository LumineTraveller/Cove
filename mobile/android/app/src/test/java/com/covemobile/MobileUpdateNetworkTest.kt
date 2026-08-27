package com.covemobile

import org.junit.Assert.*
import org.junit.Test

class MobileUpdateNetworkTest {
  @Test fun updatesUseBoundedStrictTlsAndFixedSources() {
    val client = createMobileUpdateClient()
    assertEquals(5000, client.connectTimeoutMillis)
    assertEquals(10000, client.readTimeoutMillis)
    assertEquals(15000, client.callTimeoutMillis)
    assertFalse(client.followSslRedirects)
    assertEquals("https://raw.githubusercontent.com/LumineTraveller/Cove/main/mobile/update.json", mobileUpdateFeedUrl("github"))
    assertEquals("https://gitee.com/LumineTraveller/Cove/raw/main/mobile/update.json", mobileUpdateFeedUrl("gitee"))
    assertNull(mobileUpdateFeedUrl("https://example.test/malware.json"))
  }
}
