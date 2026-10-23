package com.covemobile

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.common.LifecycleState
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.io.ByteArrayOutputStream
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

// Deliberately NOT OkHttpClientProvider: chat-server TLS exceptions never affect updates.
internal fun createMobileUpdateClient(): OkHttpClient = OkHttpClient.Builder()
  .connectTimeout(5, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS)
  .callTimeout(15, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()

internal fun mobileUpdateFeedUrl(source: String, serverURL: String,
  approvedCloudBase: String = BuildConfig.COVE_UPDATE_DOWNLOAD_BASE_URL): String? = when (source) {
  "github" -> "https://raw.githubusercontent.com/LumineTraveller/Cove/main/mobile/update.json"
  "cloud" -> approvedUpdateBase(serverURL, approvedCloudBase)?.newBuilder()
    ?.addPathSegments("releases/mobile/update.json")?.build()?.toString()
  else -> null
}

internal fun safeUpdateFeedRedirect(initial: HttpUrl, previous: HttpUrl, location: String): HttpUrl? =
  previous.resolve(location)?.let { strictApkUrl(it.toString()) }
    ?.takeIf { it.host == initial.host && it.port == initial.port }

internal fun readMobileUpdateFeed(client: OkHttpClient, initial: HttpUrl): String {
  var url = initial
  var redirects = 0
  while (true) {
    val request = Request.Builder().url(url).header("Cache-Control", "no-cache")
      .header("User-Agent", "Cove-Mobile-Updater").build()
    client.newCall(request).execute().use { response ->
      if (response.code in setOf(301, 302, 303, 307, 308)) {
        check(redirects++ < 5) { "Too many feed redirects" }
        url = safeUpdateFeedRedirect(initial, url, response.header("Location") ?: error("Missing feed redirect")) ?: error("Unsafe feed redirect")
      } else {
        check(response.code == 200) { "HTTP ${response.code}" }
        val body = requireNotNull(response.body)
        check(body.contentLength() <= 256 * 1024) { "Update feed too large" }
        val bytes = body.byteStream().use { input ->
          val output = ByteArrayOutputStream()
          val buffer = ByteArray(8192)
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            check(output.size() + count <= 256 * 1024) { "Update feed too large" }
            output.write(buffer, 0, count)
          }
          output.toByteArray()
        }
        return String(bytes, Charsets.UTF_8)
      }
    }
  }
}

class MobileUpdateModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val executor = Executors.newFixedThreadPool(2)
  private val downloadExecutor = Executors.newSingleThreadExecutor()
  private val client = createMobileUpdateClient()
  private val apkUpdater = MobileApkUpdater(context)
  @Volatile private var invalidated = false

  init { context.addLifecycleEventListener(this) }
  override fun getName() = "CoveMobileUpdate"

  @Suppress("DEPRECATION")
  @ReactMethod fun getInstalledVersion(promise: Promise) {
    try {
      val info = reactApplicationContext.packageManager.getPackageInfo(reactApplicationContext.packageName, 0)
      val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
      promise.resolve(Arguments.createMap().apply {
        putString("versionName", info.versionName)
        putDouble("versionCode", code.toDouble())
        putInt("androidApi", Build.VERSION.SDK_INT)
      })
    } catch (error: Exception) { promise.reject("VERSION_READ", "无法读取已安装 APK 版本。", error) }
  }

  @ReactMethod fun fetchUpdateFeed(source: String, serverURL: String, promise: Promise) {
    val url = mobileUpdateFeedUrl(source, serverURL)?.toHttpUrlOrNull()
    if (url == null) { promise.reject("UPDATE_SOURCE", "更新来源不在允许的官方 HTTPS 地址中。"); return }
    executor.execute {
      try { promise.resolve(readMobileUpdateFeed(client, url)) }
      catch (error: Exception) { promise.reject("UPDATE_FETCH", "更新检查失败，请检查网络连接后重试。", error) }
    }
  }

  // NativeEventEmitter bookkeeping methods; there is no timer or synthetic progress.
  @ReactMethod fun addListener(eventName: String) { }
  @ReactMethod fun removeListeners(count: Double) { }

  @ReactMethod fun downloadApk(source: String, serverURL: String, release: ReadableMap, requestId: String, promise: Promise) {
    try {
      val expected = MobileApkRelease(
        release.getString("versionName") ?: "", integralApkMetadata(release.getDouble("versionCode"), 2100000000L),
        integralApkMetadata(release.getDouble("minAndroidApi"), 100).toInt(), release.getString("packageName") ?: "",
        release.getString("tag") ?: "", release.getString("filename") ?: "",
        integralApkMetadata(release.getDouble("size"), 1024L * 1024 * 1024), release.getString("sha256") ?: "",
      )
      if (reactApplicationContext.packageName != expected.packageName)
        throw MobileUpdateException("APK_IDENTITY", "此独立测试包与正式 Cove 的应用身份不同，不能安装正式更新；请使用对应测试候选。")
      val job = apkUpdater.prepareDownload(requestId, source, serverURL, expected)
      downloadExecutor.execute {
        try {
          if (reactApplicationContext.lifecycleState != LifecycleState.RESUMED) {
            apkUpdater.cancel(requestId)
            job.checkActive()
          }
          apkUpdater.download(job) { phase, received ->
            if (!invalidated && !job.isCancelled() && reactApplicationContext.hasActiveReactInstance()) {
              val event = Arguments.createMap().apply {
                putString("requestId", requestId)
                putString("sha256", expected.sha256)
                putString("phase", phase)
                putDouble("receivedBytes", received.toDouble())
                putDouble("totalBytes", expected.size.toDouble())
              }
              reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("CoveMobileApkProgress", event)
            }
          }
          promise.resolve(expected.sha256)
        } catch (error: Exception) {
          promise.reject((error as? MobileUpdateException)?.code ?: "APK_DOWNLOAD",
            (error as? MobileUpdateException)?.message ?: "下载中断或安装包校验未通过。请检查网络及存储空间，然后重试。", error)
        }
      }
    } catch (error: Exception) {
      promise.reject((error as? MobileUpdateException)?.code ?: "APK_METADATA",
        (error as? MobileUpdateException)?.message ?: "无法开始下载：更新来源、安装包信息无效或已有下载正在进行。", error)
    }
  }

  @ReactMethod fun cancelDownload(requestId: String, promise: Promise) { apkUpdater.cancel(requestId); promise.resolve(null) }

  private fun startUserActivity(intent: Intent, promise: Promise, installation: MobileApkInstall? = null) {
    try {
      UiThreadUtil.runOnUiThread {
        try {
          val activity = reactApplicationContext.currentActivity
          check(!invalidated && reactApplicationContext.lifecycleState == LifecycleState.RESUMED && activity != null && !activity.isFinishing && !activity.isDestroyed) { "App is not in foreground" }
          activity.startActivity(intent)
          promise.resolve(null)
        } catch (error: Exception) { promise.reject("APK_INSTALL", "无法打开系统安装界面。请返回 Cove 前台后重试。", error) }
        finally { installation?.close() }
      }
    } catch (error: Exception) {
      installation?.close()
      promise.reject("APK_INSTALL", "无法打开系统安装界面，请返回 Cove 后重试。", error)
    }
  }

  @ReactMethod fun installApk(sha256: String, promise: Promise) {
    downloadExecutor.execute {
      try {
        val installation = apkUpdater.prepareInstall(sha256)
        startUserActivity(installation.intent, promise, installation)
      }
      catch (error: Exception) {
        promise.reject((error as? MobileUpdateException)?.code ?: "APK_INSTALL",
          (error as? MobileUpdateException)?.message ?: "安装包已失效或身份校验未通过，请重新下载并校验。", error)
      }
    }
  }

  @ReactMethod fun openInstallSettings(promise: Promise) {
    if (Build.VERSION.SDK_INT < 26) { promise.reject("INSTALL_SETTINGS", "此 Android 版本没有单独的应用安装权限设置。"); return }
    startUserActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${reactApplicationContext.packageName}")), promise)
  }

  override fun onHostResume() { }
  override fun onHostPause() { apkUpdater.cancelActive() }
  override fun onHostDestroy() { apkUpdater.cancelActive() }

  override fun invalidate() {
    invalidated = true
    reactApplicationContext.removeLifecycleEventListener(this)
    apkUpdater.cancelAll()
    client.dispatcher.cancelAll()
    client.connectionPool.evictAll()
    downloadExecutor.shutdownNow()
    executor.shutdownNow()
    super.invalidate()
  }
}
