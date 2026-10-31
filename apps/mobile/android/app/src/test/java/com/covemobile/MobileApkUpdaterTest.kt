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
    for (value in listOf(1.5, Double.NaN, Double.POSITIVE_INFINITY, 0.0, 2100000001.0)) {
      assertThrows(IllegalArgumentException::class.java) { integralApkMetadata(value, 2100000000L) }
    }
    assertEquals(2100000000L, integralApkMetadata(2100000000.0, 2100000000L))
  }

  @Test fun archiveIdentityMustMatchFeedInstalledPackageVersionAndSigner() {
    val apk = MobileApkIdentity("com.cove.mobile", release.versionName, release.versionCode, release.minAndroidApi, listOf(bytes))
    val installed = apk.copy(versionName = "0.7.9", versionCode = release.versionCode - 1)
    requireCompatibleApkIdentity(installed, apk, release, 36)
    for (invalid in listOf(apk.copy(packageName = "com.cove.mobile.refactor"), apk.copy(versionName = "0.8.1"),
      apk.copy(versionCode = release.versionCode + 1), apk.copy(minAndroidApi = 25),
      apk.copy(signers = emptyList()), apk.copy(signers = listOf("different certificate".toByteArray())))) {
      assertThrows(IllegalStateException::class.java) { requireCompatibleApkIdentity(installed, invalid, release, 36) }
    }
    assertThrows(IllegalStateException::class.java) { requireCompatibleApkIdentity(installed.copy(packageName = "com.cove.mobile.refactor"), apk, release, 36) }
    assertThrows(IllegalStateException::class.java) { requireCompatibleApkIdentity(apk, apk, release, 36) }
    assertThrows(IllegalStateException::class.java) { requireCompatibleApkIdentity(apk.copy(versionCode = release.versionCode + 1), apk, release, 36) }
    assertThrows(IllegalStateException::class.java) { requireCompatibleApkIdentity(installed, apk, release, 23) }
  }

  @Test fun progressReportsActualWrittenBytesAndNeverDeclaresVerificationSuccess() {
    val file = File.createTempFile("cove-apk-progress", ".part")
    val progress = mutableListOf<Long>()
    try {
      streamVerifiedApk(ByteArrayInputStream(bytes), file, release, { received ->
        assertEquals(file.length(), received)
        progress.add(received)
      }) { false }
      assertEquals(0L, progress.first())
      assertEquals(release.size, progress.last())
      assertTrue(progress.zipWithNext().all { it.first <= it.second })
      file.writeBytes(bytes.copyOf().apply { this[0] = (this[0] + 1).toByte() })
      assertFalse(fileMatchesApk(file, release))
      assertThrows(IllegalStateException::class.java) { fileMatchesApk(file, release) { true } }
    } finally { file.delete() }
  }

  @Test fun cancelledRequestCannotCancelItsReplacementOrAttachANewCall() {
    val url = mobileApkDownloadUrl("github", "", release)!!
    val old = MobileApkDownload("old-request", release, url)
    val current = MobileApkDownload("new-request", release, url)
    val oldCall = createMobileApkClient().newCall(okhttp3.Request.Builder().url(url).build())
    val newCall = createMobileApkClient().newCall(okhttp3.Request.Builder().url(url).build())
    old.cancel()
    old.attach(oldCall)
    current.attach(newCall)
    assertTrue(oldCall.isCanceled())
    assertFalse(newCall.isCanceled())
    assertThrows(MobileUpdateException::class.java) { old.checkActive() }
    current.checkActive()
    assertThrows(IllegalArgumentException::class.java) { MobileApkDownload("../invalid", release, url) }
  }

  @Test fun insufficientStorageIsAnExplicitRetryableFailure() {
    val error = assertThrows(MobileUpdateException::class.java) { requireApkStorage(release.size + 8L * 1024 * 1024 - 1, release.size) }
    assertEquals("APK_STORAGE", error.code)
    requireApkStorage(release.size + 8L * 1024 * 1024, release.size)
  }

  @Test fun restartCleanupRemovesOnlyOwnedPartialDownloadsAndRetainsCompletedApks() {
    val directory = java.nio.file.Files.createTempDirectory("cove-restart-cleanup").toFile()
    try {
      val partial = File(directory, "${release.sha256}.part").apply { writeBytes(bytes.copyOf(3)) }
      val apk = File(directory, "${release.sha256}.apk").apply { writeBytes(bytes) }
      val unrelated = File(directory, "unrelated.part").apply { writeText("not an updater artifact") }
      clearInterruptedApkDownloads(directory)
      assertFalse(partial.exists())
      assertTrue(fileMatchesApk(apk, release))
      assertTrue(unrelated.exists())
    } finally {
      directory.listFiles()?.forEach { it.delete() }
      directory.delete()
    }
  }
}
