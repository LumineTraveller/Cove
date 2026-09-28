package com.covemobile

import android.app.Application
import android.media.AudioAttributes
import android.media.AudioFormat
import com.covemobile.audio.AudioRouteRuntime
import com.covemobile.audio.MicrophoneNoiseRuntime
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
    // System mode uses WebRTC software NS. Keep hardware NS off to avoid
    // stacking it with RNNoise; retain hardware echo cancellation.
    val audioDeviceModule = JavaAudioDeviceModule.builder(this)
      .setAudioAttributes(audioAttributes)
      .setUseHardwareAcousticEchoCanceler(true)
      .setUseHardwareNoiseSuppressor(false)
      .setInputSampleRate(48_000)
      .setUseStereoInput(false)
      .setAudioFormat(AudioFormat.ENCODING_PCM_16BIT)
      .setAudioRecordStateCallback(object : JavaAudioDeviceModule.AudioRecordStateCallback {
        override fun onWebRtcAudioRecordStart() {
          MicrophoneNoiseRuntime.onAudioRecordStarted()
        }

        override fun onWebRtcAudioRecordStop() {
          MicrophoneNoiseRuntime.onAudioRecordStopped()
        }
      })
      .createAudioDeviceModule()
    WebRTCModuleOptions.getInstance().audioDeviceModule = audioDeviceModule
    WebRTCModuleOptions.getInstance().enableMediaProjectionService = true

    AudioRouteRuntime.bind(this, audioDeviceModule)

    loadReactNative(this)
  }
}
