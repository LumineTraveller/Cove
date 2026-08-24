package com.covemobile

import android.app.Application
import android.media.AudioAttributes
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.oney.WebRTCModule.WebRTCModuleOptions
import org.webrtc.audio.JavaAudioDeviceModule

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          add(CoveNativePackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()

    // 在 WebRTC 模块初始化前启用适合语音通话的原生音频属性。
    val audioAttributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    WebRTCModuleOptions.getInstance().audioDeviceModule =
      JavaAudioDeviceModule.builder(this)
        .setAudioAttributes(audioAttributes)
        // 优先使用 Android 的硬件 AEC/NS；不支持时 WebRTC 会回退到软件处理。
        .setUseHardwareAcousticEchoCanceler(true)
        .setUseHardwareNoiseSuppressor(true)
        .createAudioDeviceModule()

    loadReactNative(this)
  }
}
