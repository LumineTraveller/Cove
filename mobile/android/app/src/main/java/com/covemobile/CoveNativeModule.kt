package com.covemobile

import android.content.Intent
import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise

class CoveNativeModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val mainHandler = Handler(Looper.getMainLooper())
  private val audioManager = reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var speakerphoneRequested = false
  private var audioDeviceCallbackRegistered = false
  private val reapplySpeakerphone = Runnable {
    if (speakerphoneRequested) applySpeakerphoneRoute()
  }
  private val audioDeviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
      scheduleSpeakerphoneRoute()
    }

    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
      scheduleSpeakerphoneRoute()
    }
  }

  override fun getName(): String = "CoveNative"

  @ReactMethod
  fun configureServerCertificate(serverURL: String, enabled: Boolean, promise: Promise) {
    try {
      ServerCertificateNetwork.configure(serverURL, enabled)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("CERTIFICATE_POLICY", error.message, error)
    }
  }

  @ReactMethod
  fun startVoiceService() {
    val intent = Intent(reactContext, VoiceKeepAliveService::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      reactContext.startForegroundService(intent)
    } else {
      reactContext.startService(intent)
    }
  }

  @ReactMethod
  fun stopVoiceService() {
    setSpeakerphoneEnabled(false)
    reactContext.stopService(Intent(reactContext, VoiceKeepAliveService::class.java))
  }

  @ReactMethod
  fun setSpeakerphoneEnabled(enabled: Boolean) {
    mainHandler.post {
      speakerphoneRequested = enabled
      mainHandler.removeCallbacks(reapplySpeakerphone)
      if (enabled) {
        registerAudioDeviceCallback()
        applySpeakerphoneRoute()
        // InCallManager 和 WebRTC 可能在音轨建立后再次选择通话设备。
        // 做两次短延迟恢复，避免路由被异步切回听筒。
        mainHandler.postDelayed(reapplySpeakerphone, 250)
        mainHandler.postDelayed(reapplySpeakerphone, 1_000)
      } else {
        unregisterAudioDeviceCallback()
        releaseSpeakerphoneRoute()
      }
    }
  }

  @ReactMethod
  fun playPresenceTone(action: String) {
    Handler(Looper.getMainLooper()).post {
      val tone = ToneGenerator(AudioManager.STREAM_MUSIC, 55)
      val toneType = if (action == "join") ToneGenerator.TONE_PROP_ACK else ToneGenerator.TONE_PROP_NACK
      tone.startTone(toneType, 180)
      Handler(Looper.getMainLooper()).postDelayed({ tone.release() }, 260)
    }
  }

  private fun scheduleSpeakerphoneRoute() {
    if (!speakerphoneRequested) return
    mainHandler.removeCallbacks(reapplySpeakerphone)
    mainHandler.postDelayed(reapplySpeakerphone, 120)
  }

  private fun registerAudioDeviceCallback() {
    if (audioDeviceCallbackRegistered) return
    audioManager.registerAudioDeviceCallback(audioDeviceCallback, mainHandler)
    audioDeviceCallbackRegistered = true
  }

  private fun unregisterAudioDeviceCallback() {
    if (!audioDeviceCallbackRegistered) return
    audioManager.unregisterAudioDeviceCallback(audioDeviceCallback)
    audioDeviceCallbackRegistered = false
  }

  private fun applySpeakerphoneRoute() {
    audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val speaker = audioManager.availableCommunicationDevices.firstOrNull {
        it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
      }
      if (speaker != null && audioManager.communicationDevice?.id != speaker.id) {
        val routed = audioManager.setCommunicationDevice(speaker)
        if (!routed) setLegacySpeakerphone(true)
      }
    } else {
      setLegacySpeakerphone(true)
    }
  }

  private fun releaseSpeakerphoneRoute() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audioManager.clearCommunicationDevice()
    } else {
      setLegacySpeakerphone(false)
    }
  }

  @Suppress("DEPRECATION")
  private fun setLegacySpeakerphone(enabled: Boolean) {
    audioManager.isSpeakerphoneOn = enabled
  }

  override fun invalidate() {
    speakerphoneRequested = false
    mainHandler.removeCallbacks(reapplySpeakerphone)
    unregisterAudioDeviceCallback()
    releaseSpeakerphoneRoute()
    super.invalidate()
  }
}
