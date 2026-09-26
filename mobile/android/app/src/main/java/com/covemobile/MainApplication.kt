package com.covemobile

import android.app.Application
import android.media.AudioAttributes
import com.covemobile.audio.AudioRouteRuntime
import com.covemobile.audio.MicrophoneNoiseRuntime
import com.covemobile.audio.RnnoiseAudioInterceptor
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
    ServerCertificateNetwork.install()

    // 在 WebRTC 模块初始化前启用适合语音通话的原生音频属性。
    val audioAttributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    // 保留硬件 NS 实例，便于在 RNNoise / 系统降噪之间运行时切换；
    // RNNoise 模式会关掉系统 NS，避免双重降噪损伤语音。
    val audioDeviceModule = JavaAudioDeviceModule.builder(this)
      .setAudioAttributes(audioAttributes)
      .setUseHardwareAcousticEchoCanceler(true)
      .setUseHardwareNoiseSuppressor(true)
      .createAudioDeviceModule()
    WebRTCModuleOptions.getInstance().audioDeviceModule = audioDeviceModule

    val interceptorAttached = RnnoiseAudioInterceptor.attach(audioDeviceModule)
    MicrophoneNoiseRuntime.bind(audioDeviceModule, interceptorAttached)
    AudioRouteRuntime.bind(this, audioDeviceModule)

    loadReactNative(this)
  }
}
