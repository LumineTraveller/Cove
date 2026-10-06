package com.covemobile

import java.io.ByteArrayInputStream
import java.io.File
import java.security.MessageDigest
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class MobileApkUpdaterTest {
  private val bytes = "synthetic APK payload".toByteArray()
  private val release = MobileApkRelease("0.8.0", 13, 24, "com.cove.mobile", "mobile-v0.8.0", "Cove-Mobile-0.8.0.apk", bytes.size.toLong(), MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })

  @Test fun githubAndCloudSourcesRejectUnsafeRedirects() {
    val github = mobileApkDownloadUrl("github", "", release)!!
    assertEquals("github.com", github.host)
    assertNotNull(safeApkRedirect(github, github, "https://release-assets.githubusercontent.com/asset?signature=test"))
    assertNull(safeApkRedirect(github, github, "http://release-assets.githubusercontent.com/asset"))
    assertNull(safeApkRedirect(github, github, "https://evil.test/asset"))
    assertNull(safeApkRedirect(github, github, "https://user:password@github.com/asset"))
    assertNull(safeApkRedirect(github, github, "https://github.com:444/asset"))
    val cloud = mobileApkDownloadUrl("cloud", "https://download.test/cove/", release, "https://download.test/cove")!!
    assertEquals("/cove/releases/mobile-v0.8.0/Cove-Mobile-0.8.0.apk", cloud.encodedPath)
    assertNotNull(safeApkRedirect(cloud, cloud, "/other.apk"))
    assertNull(safeApkRedirect(cloud, cloud, "https://other.test/asset"))
    assertNull(mobileApkDownloadUrl("cloud", "http://download.test", release))
    assertNull(mobileApkDownloadUrl("cloud", "https://download.test/cove/", release, ""))
    assertNull(mobileApkDownloadUrl("cloud", "https://evil.test", release, "https://download.test/cove"))
    assertNull(mobileApkDownloadUrl("cloud", "https://download.test/other", release, "https://download.test/cove"))
    assertNull(mobileApkDownloadUrl("arbitrary", "https://evil.test", release))
  }

  @Test fun exactIntegrityRejectsTruncationExtraBytesWrongHashAndCancellation() {
    val file = File.createTempFile("cove-apk-test", ".part")
    try {
      streamVerifiedApk(ByteArrayInputStream(bytes), file, release) { false }
      assertTrue(fileMatchesApk(file, release))
      for (input in listOf(bytes.copyOf(bytes.size - 1), bytes + 0)) {
        assertThrows(IllegalStateException::class.java) { streamVerifiedApk(ByteArrayInputStream(input), file, release) { false } }
      }
      assertThrows(IllegalStateException::class.java) { streamVerifiedApk(ByteArrayInputStream(bytes), file, release.copy(sha256 = "a".repeat(64))) { false } }
      assertThrows(IllegalStateException::class.java) { streamVerifiedApk(ByteArrayInputStream(bytes), file, release) { true } }
      file.writeBytes(bytes + 0)
      assertFalse(fileMatchesApk(file, release))
    } finally { file.delete() }
  }

  @Test fun signaturesMustHaveTheSameNonemptyIdentitySet() {
    assertTrue(sameApkSigners(listOf(bytes), listOf(bytes.copyOf())))
    assertFalse(sameApkSigners(listOf(bytes), listOf("wrong".toByteArray())))
    assertFalse(sameApkSigners(emptyList(), emptyList()))
    assertFalse(sameApkSigners(listOf(bytes), listOf(bytes, "extra".toByteArray())))
  }

  @Test fun downloaderNeverInheritsCertificateExceptionsOrAutomaticRedirects() {
    val client = createMobileApkClient()
    assertFalse(client.followRedirects)
    assertFalse(client.followSslRedirects)
    assertEquals(300000, client.callTimeoutMillis)
    assertNull(strictApkUrl("http://download.test/a.apk"))
    assertNull(strictApkUrl("https://user:password@download.test/a.apk"))
    assertNotNull(strictApkUrl("https://download.test/a.apk?signature=synthetic"))
  }

  @Test fun untrustedMetadataCannotChooseAnotherPackageOrPath() {
    assertThrows(IllegalArgumentException::class.java) { release.copy(packageName = "other.app") }
    assertThrows(IllegalArgumentException::class.java) { release.copy(filename = "../malware.apk") }
    assertThrows(IllegalArgumentException::class.java) { release.copy(versionName = "0.8.0-rc") }
    assertThrows(IllegalArgumentException::class.java) { release.copy(size = 0) }
  }
}
