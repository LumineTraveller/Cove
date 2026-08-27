package com.covemobile

import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.io.ByteArrayOutputStream
import okhttp3.OkHttpClient
import okhttp3.Request

// Deliberately NOT OkHttpClientProvider: server certificate exceptions never affect updates.
internal fun createMobileUpdateClient(): OkHttpClient = OkHttpClient.Builder()
  .connectTimeout(5, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS)
  .callTimeout(15, TimeUnit.SECONDS).followSslRedirects(false).build()

internal fun mobileUpdateFeedUrl(source: String): String? = when (source) {
  "github" -> "https://raw.githubusercontent.com/LumineTraveller/Cove/main/mobile/update.json"
  "gitee" -> "https://gitee.com/LumineTraveller/Cove/raw/main/mobile/update.json"
  else -> null
}

class MobileUpdateModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newFixedThreadPool(2)
  private val client = createMobileUpdateClient()

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
    } catch (error: Exception) { promise.reject("VERSION_READ", "无法读取已安装 APK 版本", error) }
  }

  @ReactMethod fun fetchUpdateFeed(source: String, promise: Promise) {
    val url = mobileUpdateFeedUrl(source)
    if (url == null) { promise.reject("UPDATE_SOURCE", "未知更新源"); return }
    executor.execute {
      try {
        val request = Request.Builder().url(url).header("Cache-Control", "no-cache")
          .header("User-Agent", "Cove-Mobile-Updater").build()
        client.newCall(request).execute().use { response ->
          check(response.isSuccessful) { "HTTP ${response.code}" }
          val body = requireNotNull(response.body)
          check(body.contentLength() <= 256 * 1024) { "更新清单过大" }
          val bytes = body.byteStream().use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              check(output.size() + count <= 256 * 1024) { "更新清单过大" }
              output.write(buffer, 0, count)
            }
            output.toByteArray()
          }
          check(bytes.size <= 256 * 1024) { "更新清单过大" }
          promise.resolve(String(bytes, Charsets.UTF_8))
        }
      } catch (error: Exception) { promise.reject("UPDATE_FETCH", "${source} 更新检查失败：${error.message}", error) }
    }
  }

  override fun invalidate() {
    client.dispatcher.cancelAll()
    client.connectionPool.evictAll()
    executor.shutdownNow()
    super.invalidate()
  }
}
