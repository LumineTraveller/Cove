package com.covemobile

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File
import java.io.InputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

internal data class MobileApkRelease(
  val versionName: String, val versionCode: Long, val minAndroidApi: Int,
  val packageName: String, val tag: String, val filename: String,
  val size: Long, val sha256: String,
) {
  init {
    require(Regex("(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)").matches(versionName)) { "Invalid APK version" }
    require(versionCode in 1..2100000000L && minAndroidApi in 24..100) { "Invalid APK platform version" }
    require(packageName == "com.cove.mobile") { "Unexpected APK package" }
    require(tag == "mobile-v$versionName" || Regex("v\\d+\\.\\d+\\.\\d+").matches(tag)) { "Invalid APK tag" }
    require(filename == "Cove-Mobile-$versionName.apk") { "Invalid APK filename" }
    require(size in 1..1024L * 1024 * 1024 && Regex("[a-f0-9]{64}").matches(sha256)) { "Invalid APK integrity metadata" }
  }
}

internal fun strictApkUrl(value: String): HttpUrl? = value.toHttpUrlOrNull()?.takeIf {
  it.scheme == "https" && it.username.isEmpty() && it.password.isEmpty() && it.fragment == null
}

internal fun mobileApkDownloadUrl(source: String, serverURL: String, release: MobileApkRelease,
  approvedCloudBase: String = BuildConfig.COVE_UPDATE_DOWNLOAD_BASE_URL): HttpUrl? = when (source) {
  "github" -> "https://github.com/LumineTraveller/Cove/releases/download/${release.tag}/${release.filename}".toHttpUrlOrNull()
  "cloud" -> mobileUpdateFeedUrl("cloud", serverURL)?.toHttpUrlOrNull()?.let {
    val base = strictApkUrl(serverURL) ?: return@let null
    val approved = strictApkUrl(approvedCloudBase) ?: return@let null
    if (base.toString().trimEnd('/') != approved.toString().trimEnd('/')) return@let null
    base.newBuilder().addPathSegments("releases").addPathSegment(release.tag).addPathSegment(release.filename).build()
  }
  else -> null
}

// Cloud downloads stay on the configured origin. GitHub's release asset redirects
// may only go to GitHub's HTTPS asset hosts; never to HTTP or an arbitrary host.
internal fun safeApkRedirect(initial: HttpUrl, previous: HttpUrl, location: String): HttpUrl? {
  val next = previous.resolve(location)?.let { strictApkUrl(it.toString()) } ?: return null
  return if (initial.host == "github.com") {
    next.takeIf { it.port == 443 && it.host in setOf("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com") }
  } else next.takeIf { it.host == initial.host && it.port == initial.port }
}

internal fun createMobileApkClient(): OkHttpClient = OkHttpClient.Builder()
  .connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
  .callTimeout(5, TimeUnit.MINUTES).followRedirects(false).followSslRedirects(false).build()

internal fun streamVerifiedApk(input: InputStream, output: File, release: MobileApkRelease, cancelled: () -> Boolean) {
  val digest = MessageDigest.getInstance("SHA-256")
  var received = 0L
  output.outputStream().use { sink ->
    val buffer = ByteArray(64 * 1024)
    while (true) {
      check(!cancelled()) { "Download cancelled" }
      val count = input.read(buffer)
      if (count < 0) break
      received += count
      check(received <= release.size) { "APK exceeds expected size" }
      digest.update(buffer, 0, count)
      sink.write(buffer, 0, count)
    }
  }
  check(!cancelled()) { "Download cancelled" }
  check(received == release.size) { "APK size does not match update feed" }
  check(digest.digest().joinToString("") { "%02x".format(it) } == release.sha256) { "APK SHA-256 does not match update feed" }
}

internal fun fileMatchesApk(file: File, release: MobileApkRelease): Boolean {
  if (!file.isFile || file.length() != release.size) return false
  val digest = MessageDigest.getInstance("SHA-256")
  file.inputStream().use { input ->
    val buffer = ByteArray(64 * 1024)
    while (true) {
      val count = input.read(buffer)
      if (count < 0) break
      digest.update(buffer, 0, count)
    }
  }
  return digest.digest().joinToString("") { "%02x".format(it) } == release.sha256
}

internal fun sameApkSigners(installed: List<ByteArray>, candidate: List<ByteArray>): Boolean {
  fun fingerprints(items: List<ByteArray>) = items.map { bytes ->
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
  }.toSet()
  return installed.isNotEmpty() && candidate.isNotEmpty() && fingerprints(installed) == fingerprints(candidate)
}

internal class MobileApkUpdater(private val context: Context) {
  private val client = createMobileApkClient()
  private val generation = AtomicInteger()
  @Volatile private var activeCall: Call? = null
  @Volatile private var verified: Pair<File, MobileApkRelease>? = null
  companion object { private val busy = AtomicBoolean(false) }

  @Synchronized private fun remember(file: File, release: MobileApkRelease, currentGeneration: Int) {
    check(generation.get() == currentGeneration) { "Download cancelled" }
    verified = file to release
  }

  @Suppress("DEPRECATION")
  private fun signingFlags() = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

  @Suppress("DEPRECATION")
  private fun signers(info: PackageInfo): List<ByteArray> = if (Build.VERSION.SDK_INT >= 28) {
    info.signingInfo?.apkContentsSigners?.map { it.toByteArray() } ?: emptyList()
  } else info.signatures?.map { it.toByteArray() } ?: emptyList()

  @Suppress("DEPRECATION")
  private fun verifyIdentity(file: File, release: MobileApkRelease) {
    val manager = context.packageManager
    val apk = manager.getPackageArchiveInfo(file.absolutePath, signingFlags()) ?: error("Cannot inspect APK")
    val installed = manager.getPackageInfo(context.packageName, signingFlags())
    val code = if (Build.VERSION.SDK_INT >= 28) apk.longVersionCode else apk.versionCode.toLong()
    val installedCode = if (Build.VERSION.SDK_INT >= 28) installed.longVersionCode else installed.versionCode.toLong()
    check(context.packageName == release.packageName && apk.packageName == release.packageName) { "APK package does not match this app" }
    check(apk.versionName == release.versionName && code == release.versionCode && code > installedCode) { "APK version is invalid or not an upgrade" }
    check(apk.applicationInfo?.minSdkVersion == release.minAndroidApi && release.minAndroidApi <= Build.VERSION.SDK_INT) { "APK Android requirement does not match" }
    check(sameApkSigners(signers(installed), signers(apk))) { "APK signing identity does not match the installed app" }
  }

  fun download(source: String, serverURL: String, release: MobileApkRelease): File {
    val directory = File(context.filesDir, "updates").apply { check(mkdirs() || isDirectory) }
    check(busy.compareAndSet(false, true)) { "Another APK operation is running" }
    verified = null
    val currentGeneration = generation.get()
    val cancelled = { generation.get() != currentGeneration }
    val file = File(directory, "${release.sha256}.apk")
    val partial = File(directory, "${release.sha256}.part")
    try {
      RandomAccessFile(File(directory, "download.lock"), "rw").channel.use { channel ->
        val lock = channel.tryLock() ?: error("Another APK operation is running")
        lock.use {
          val initial = mobileApkDownloadUrl(source, serverURL, release) ?: error("Invalid HTTPS APK source")
          if (fileMatchesApk(file, release)) {
            verifyIdentity(file, release)
            check(!cancelled()) { "Download cancelled" }
            remember(file, release, currentGeneration)
            return file
          }
          if (file.exists()) check(file.delete()) { "Cannot replace invalid APK cache" }
          var url = initial
          var redirects = 0
          while (true) {
            check(!cancelled()) { "Download cancelled" }
            val call = client.newCall(Request.Builder().url(url).header("User-Agent", "Cove-Mobile-Updater").header("Accept-Encoding", "identity").build())
            activeCall = call
            call.execute().use { response ->
              if (response.code in setOf(301, 302, 303, 307, 308)) {
                check(redirects++ < 5) { "Too many APK redirects" }
                url = safeApkRedirect(initial, url, response.header("Location") ?: error("Missing redirect location")) ?: error("Unsafe APK redirect")
              } else {
                check(response.isSuccessful) { "APK download HTTP ${response.code}" }
                val body = response.body ?: error("Empty APK response")
                check(body.contentLength() < 0 || body.contentLength() == release.size) { "APK response size does not match" }
                body.byteStream().use { streamVerifiedApk(it, partial, release, cancelled) }
                verifyIdentity(partial, release)
                check(!cancelled()) { "Download cancelled" }
                check(partial.renameTo(file)) { "Cannot store verified APK" }
                remember(file, release, currentGeneration)
                return file
              }
            }
          }
        }
      }
    } finally {
      partial.delete()
      activeCall = null
      busy.set(false)
    }
  }

  @Synchronized fun cancel() {
    generation.incrementAndGet()
    verified = null
    activeCall?.cancel()
  }

  fun install(sha256: String) {
    check(busy.compareAndSet(false, true)) { "Another APK operation is running" }
    try {
      val (file, release) = verified ?: error("Download and verify the APK before installing")
      check(sha256 == release.sha256 && fileMatchesApk(file, release)) { "Verified APK is no longer available" }
      verifyIdentity(file, release)
      if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls())
        error("INSTALL_PERMISSION_REQUIRED")
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
      val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      context.startActivity(intent)
    } finally { busy.set(false) }
  }

  fun openInstallSettings() {
    check(Build.VERSION.SDK_INT >= 26) { "Install permission settings are unavailable" }
    context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }
}
