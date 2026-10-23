package com.covemobile

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.FileProvider
import java.io.File
import java.io.InputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

internal class MobileUpdateException(val code: String, message: String) : IllegalStateException(message)

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

internal fun integralApkMetadata(value: Double, maximum: Long): Long {
  require(value.isFinite() && value >= 1 && value <= maximum.toDouble() && value % 1.0 == 0.0) { "Invalid APK number" }
  return value.toLong()
}

internal fun strictApkUrl(value: String): HttpUrl? = value.toHttpUrlOrNull()?.takeIf {
  it.scheme == "https" && it.username.isEmpty() && it.password.isEmpty() && it.fragment == null
}

internal fun approvedUpdateBase(value: String, approved: String): HttpUrl? {
  val base = strictApkUrl(value)?.takeIf { it.query == null } ?: return null
  val configured = strictApkUrl(approved)?.takeIf { it.query == null } ?: return null
  return base.takeIf { it.toString().trimEnd('/') == configured.toString().trimEnd('/') }
}

internal fun mobileApkDownloadUrl(source: String, serverURL: String, release: MobileApkRelease,
  approvedCloudBase: String = BuildConfig.COVE_UPDATE_DOWNLOAD_BASE_URL): HttpUrl? = when (source) {
  "github" -> "https://github.com/LumineTraveller/Cove/releases/download/${release.tag}/${release.filename}".toHttpUrlOrNull()
  "cloud" -> approvedUpdateBase(serverURL, approvedCloudBase)?.newBuilder()
    ?.addPathSegments("releases")?.addPathSegment(release.tag)?.addPathSegment(release.filename)?.build()
  else -> null
}

// The first URL is constructed locally, never accepted from a feed. Asset redirects
// stay on GitHub's HTTPS release hosts; a configured mirror stays on its own origin.
internal fun safeApkRedirect(initial: HttpUrl, previous: HttpUrl, location: String): HttpUrl? {
  val next = previous.resolve(location)?.let { strictApkUrl(it.toString()) } ?: return null
  return if (initial.host == "github.com") {
    next.takeIf { it.port == 443 && it.host in setOf("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com") }
  } else next.takeIf { it.host == initial.host && it.port == initial.port }
}

internal fun createMobileApkClient(): OkHttpClient = OkHttpClient.Builder()
  .connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
  .callTimeout(5, TimeUnit.MINUTES).followRedirects(false).followSslRedirects(false).build()

internal fun streamVerifiedApk(input: InputStream, output: File, release: MobileApkRelease,
  onProgress: (Long) -> Unit = {}, cancelled: () -> Boolean) {
  val digest = MessageDigest.getInstance("SHA-256")
  var received = 0L
  var lastProgress = 0L
  onProgress(0)
  output.outputStream().use { sink ->
    val buffer = ByteArray(64 * 1024)
    while (true) {
      check(!cancelled()) { "Download cancelled" }
      val count = input.read(buffer)
      if (count < 0) break
      check(!cancelled()) { "Download cancelled" }
      received += count
      check(received <= release.size) { "APK exceeds expected size" }
      digest.update(buffer, 0, count)
      sink.write(buffer, 0, count)
      val now = System.nanoTime()
      if (received == release.size || now - lastProgress >= TimeUnit.MILLISECONDS.toNanos(150)) {
        lastProgress = now
        onProgress(received)
      }
    }
    sink.flush()
    sink.fd.sync()
  }
  check(!cancelled()) { "Download cancelled" }
  check(received == release.size) { "APK size does not match update feed" }
  check(digest.digest().joinToString("") { "%02x".format(it) } == release.sha256) { "APK SHA-256 does not match update feed" }
}

internal fun fileMatchesApk(file: File, release: MobileApkRelease, cancelled: () -> Boolean = { false }): Boolean {
  if (!file.isFile || file.length() != release.size) return false
  val digest = MessageDigest.getInstance("SHA-256")
  file.inputStream().use { input ->
    val buffer = ByteArray(64 * 1024)
    while (true) {
      check(!cancelled()) { "Download cancelled" }
      val count = input.read(buffer)
      if (count < 0) break
      digest.update(buffer, 0, count)
    }
  }
  check(!cancelled()) { "Download cancelled" }
  return digest.digest().joinToString("") { "%02x".format(it) } == release.sha256
}

internal fun sameApkSigners(installed: List<ByteArray>, candidate: List<ByteArray>): Boolean {
  fun fingerprints(items: List<ByteArray>) = items.map { bytes ->
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
  }.toSet()
  return installed.isNotEmpty() && candidate.isNotEmpty() && fingerprints(installed) == fingerprints(candidate)
}

internal data class MobileApkIdentity(val packageName: String, val versionName: String?,
  val versionCode: Long, val minAndroidApi: Int, val signers: List<ByteArray>)

internal fun requireCompatibleApkIdentity(installed: MobileApkIdentity, apk: MobileApkIdentity,
  release: MobileApkRelease, androidApi: Int) {
  check(installed.packageName == release.packageName && apk.packageName == release.packageName) { "APK package does not match this app" }
  check(apk.versionName == release.versionName && apk.versionCode == release.versionCode && apk.versionCode > installed.versionCode) { "APK version is invalid or not an upgrade" }
  check(apk.minAndroidApi == release.minAndroidApi && release.minAndroidApi <= androidApi) { "APK Android requirement does not match" }
  // Key rotation requires an explicit migration policy; never trust a signer from a feed.
  check(sameApkSigners(installed.signers, apk.signers)) { "APK signing identity does not match the installed app" }
}

internal fun requireApkStorage(availableBytes: Long, releaseSize: Long) {
  if (availableBytes < releaseSize + 8L * 1024 * 1024)
    throw MobileUpdateException("APK_STORAGE", "存储空间不足，请至少腾出安装包大小加 8 MB 的空间后重试。")
}

internal fun clearInterruptedApkDownloads(directory: File) {
  directory.listFiles()?.filter { it.isFile && Regex("[a-f0-9]{64}\\.part").matches(it.name) }
    ?.forEach { check(it.delete()) { "Cannot clear interrupted download" } }
}

internal class MobileApkInstall(val intent: Intent, private val complete: () -> Unit) : AutoCloseable {
  private val closed = AtomicBoolean(false)
  override fun close() { if (closed.compareAndSet(false, true)) complete() }
}

/** One immutable request owns its call and cancellation flag, including while queued. */
internal class MobileApkDownload(val requestId: String, val release: MobileApkRelease, val initial: HttpUrl) {
  private val cancelled = AtomicBoolean(false)
  @Volatile private var call: Call? = null
  init { require(Regex("[A-Za-z0-9_-]{1,96}").matches(requestId)) { "Invalid download request ID" } }
  fun isCancelled() = cancelled.get()
  fun checkActive() { if (isCancelled()) throw MobileUpdateException("APK_CANCELLED", "下载已取消，可点击重试。") }
  fun attach(next: Call) { call = next; if (isCancelled()) next.cancel() }
  fun cancel() { cancelled.set(true); call?.cancel() }
}

internal fun downloadMobileApk(client: OkHttpClient, job: MobileApkDownload, partial: File, onProgress: (Long) -> Unit) {
  var url = job.initial
  var redirects = 0
  try {
    while (true) {
      job.checkActive()
      val call = client.newCall(Request.Builder().url(url).header("User-Agent", "Cove-Mobile-Updater")
        .header("Accept-Encoding", "identity").build())
      job.attach(call)
      call.execute().use { response ->
        if (response.code in setOf(301, 302, 303, 307, 308)) {
          check(redirects++ < 5) { "Too many APK redirects" }
          url = safeApkRedirect(job.initial, url, response.header("Location") ?: error("Missing redirect location")) ?: error("Unsafe APK redirect")
        } else {
          check(response.code == 200) { "APK download HTTP ${response.code}" }
          check(response.header("Content-Range") == null) { "Unexpected partial APK response" }
          check(response.header("Content-Encoding").let { it == null || it.equals("identity", true) }) { "Unexpected APK content encoding" }
          val body = response.body ?: error("Empty APK response")
          check(body.contentLength() < 0 || body.contentLength() == job.release.size) { "APK response size does not match" }
          body.byteStream().use { streamVerifiedApk(it, partial, job.release, onProgress, job::isCancelled) }
          job.checkActive()
          return
        }
      }
    }
  } catch (error: Exception) {
    partial.delete()
    job.checkActive()
    throw error
  }
}

internal class MobileApkUpdater(private val context: Context) {
  private val client = createMobileApkClient()
  private var active: MobileApkDownload? = null
  private data class Verified(val requestId: String, val file: File, val release: MobileApkRelease)
  private var verified: Verified? = null
  private var installation: MobileApkInstall? = null
  companion object { private val busy = AtomicBoolean(false) }

  @Synchronized fun prepareDownload(requestId: String, source: String, serverURL: String, release: MobileApkRelease): MobileApkDownload {
    check(installation == null) { "An APK installation is being prepared" }
    check(active?.isCancelled() != false) { "Another APK operation is running" }
    val initial = mobileApkDownloadUrl(source, serverURL, release) ?: error("Invalid HTTPS APK source")
    val job = MobileApkDownload(requestId, release, initial)
    active = job
    verified = null
    return job
  }

  @Synchronized private fun remember(file: File, job: MobileApkDownload) {
    job.checkActive()
    check(active === job) { "Download is no longer current" }
    verified = Verified(job.requestId, file, job.release)
  }

  @Suppress("DEPRECATION")
  private fun signingFlags() = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

  @Suppress("DEPRECATION")
  private fun identity(info: PackageInfo) = MobileApkIdentity(info.packageName, info.versionName,
    if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong(),
    info.applicationInfo?.minSdkVersion ?: -1,
    if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners?.map { it.toByteArray() } ?: emptyList()
    else info.signatures?.map { it.toByteArray() } ?: emptyList())

  @Suppress("DEPRECATION")
  private fun verifyIdentity(file: File, release: MobileApkRelease) {
    try {
      val manager = context.packageManager
      val apk = manager.getPackageArchiveInfo(file.absolutePath, signingFlags()) ?: error("Cannot inspect APK")
      val installed = manager.getPackageInfo(context.packageName, signingFlags())
      requireCompatibleApkIdentity(identity(installed), identity(apk), release, Build.VERSION.SDK_INT)
    } catch (error: Exception) {
      throw MobileUpdateException("APK_IDENTITY", "安装包的应用身份、版本或签名不兼容，已拒绝安装。请重新检查官方更新。")
    }
  }

  // A dedicated serial executor lets a cancelled request clean up before its
  // replacement starts. Partial files and Range requests are never reused.
  fun download(job: MobileApkDownload, progress: (String, Long) -> Unit): File {
    val ownsOperation = busy.compareAndSet(false, true)
    var partial: File? = null
    try {
      check(ownsOperation) { "Another APK operation is running" }
      job.checkActive()
      val root = File(context.filesDir, "updates").apply { check(mkdirs() || isDirectory) }
      RandomAccessFile(File(root, "download.lock"), "rw").channel.use { channel ->
        val lock = channel.tryLock() ?: error("Another APK operation is running")
        lock.use {
          job.checkActive()
          val directory = File(root, "verified").apply { check(mkdirs() || isDirectory) }
          val staging = File(root, "staging").apply { check(mkdirs() || isDirectory) }
          val release = job.release
          val file = File(directory, "${release.sha256}.apk")
          clearInterruptedApkDownloads(staging)
          clearInterruptedApkDownloads(root)
          progress("verifying", 0)
          if (fileMatchesApk(file, release, job::isCancelled)) {
            verifyIdentity(file, release)
            remember(file, job)
            progress("verifying", release.size)
            return file
          }
          // Reclaim only this updater's APK cache, never user documents.
          directory.listFiles()?.filter { it.isFile && Regex("[a-f0-9]{64}\\.apk").matches(it.name) }?.forEach { check(it.delete()) { "Cannot clear APK cache" } }
          requireApkStorage(root.usableSpace, release.size)
          val destination = File(staging, "${release.sha256}.part")
          partial = destination
          progress("downloading", 0)
          downloadMobileApk(client, job, destination) { progress("downloading", it) }
          progress("verifying", release.size)
          verifyIdentity(destination, release)
          job.checkActive()
          check(destination.renameTo(file)) { "Cannot store verified APK" }
          remember(file, job)
          return file
        }
      }
    } catch (error: Exception) {
      job.checkActive()
      if (error is IOException && context.filesDir.usableSpace < 8L * 1024 * 1024)
        throw MobileUpdateException("APK_STORAGE", "下载时存储空间不足，请腾出空间后重试。")
      throw error
    } finally {
      partial?.delete()
      synchronized(this) { if (active === job) active = null }
      if (ownsOperation) busy.set(false)
    }
  }

  @Synchronized fun cancel(requestId: String) {
    active?.takeIf { it.requestId == requestId }?.cancel()
    if (verified?.requestId == requestId) verified = null
  }

  @Synchronized fun cancelAll() { active?.cancel(); verified = null; installation?.close() }
  @Synchronized fun cancelActive() { active?.cancel() }

  @Suppress("DEPRECATION")
  fun prepareInstall(sha256: String): MobileApkInstall {
    check(busy.compareAndSet(false, true)) { "Another APK operation is running" }
    try {
      val item = synchronized(this) { verified } ?: error("Download and verify the APK before installing")
      val (file, release) = item.file to item.release
      check(sha256 == release.sha256 && fileMatchesApk(file, release)) { "Verified APK is no longer available" }
      verifyIdentity(file, release)
      if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls())
        throw MobileUpdateException("INSTALL_PERMISSION_REQUIRED", "请在系统设置中允许 Cove 安装更新，然后返回点击安装。")
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
      val intent = Intent(Intent.ACTION_INSTALL_PACKAGE).setData(uri)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      intent.clipData = ClipData.newRawUri("Cove verified update", uri)
      lateinit var prepared: MobileApkInstall
      prepared = MobileApkInstall(intent) {
        synchronized(this) { if (installation === prepared) installation = null }
        busy.set(false)
      }
      synchronized(this) { installation = prepared }
      return prepared
    } catch (error: Exception) { busy.set(false); throw error }
  }
}
