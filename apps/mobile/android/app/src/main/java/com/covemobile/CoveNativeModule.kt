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
import java.net.InetAddress
import java.util.concurrent.Executors
import com.covemobile.audio.AudioRouteRuntime
import com.covemobile.audio.MicrophoneNoiseRuntime
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise

class CoveNativeModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val mainHandler = Handler(Looper.getMainLooper())
  private val dnsExecutor = Executors.newCachedThreadPool()
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
  fun resolveServerAddresses(hostname: String, promise: Promise) {
    val value = hostname.trim().removePrefix("[").removeSuffix("]")
    if (value.isEmpty() || value.length > 253 || value.any { it.isWhitespace() || it == '/' || it == '\\' }) {
      promise.resolve(Arguments.createArray())
      return
    }
    dnsExecutor.execute {
      try {
        // Promise callbacks accept a WritableNativeArray, not a Kotlin List.
        promise.resolve(Arguments.fromList(InetAddress.getAllByName(value).mapNotNull { it.hostAddress }))
      } catch (_: Exception) {
        promise.resolve(Arguments.createArray())
      }
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
        AudioRouteRuntime.setOutput("out-speaker")
        applySpeakerphoneRoute()
        // InCallManager 和 WebRTC 可能在音轨建立后再次选择通话设备。
        // 做两次短延迟恢复，避免路由被异步切回听筒。
        mainHandler.postDelayed(reapplySpeakerphone, 250)
        mainHandler.postDelayed(reapplySpeakerphone, 1_000)
      } else {
        unregisterAudioDeviceCallback()
        AudioRouteRuntime.setOutput(null)
        releaseSpeakerphoneRoute()
      }
    }
  }

  @ReactMethod
  fun setMicrophoneNoiseMode(mode: String, promise: Promise) {
    try {
      val applied = MicrophoneNoiseRuntime.setMode(mode)
      promise.resolve(applied.wire)
    } catch (error: Exception) {
      promise.reject("NOISE_MODE", error.message, error)
    }
  }

  @ReactMethod
  fun getMicrophoneNoiseStatus(promise: Promise) {
    try {
      val status = MicrophoneNoiseRuntime.status()
      val map = Arguments.createMap()
      map.putString("mode", status["mode"] as? String ?: "system")
      map.putString("effectiveMode", status["effectiveMode"] as? String ?: "system")
      map.putBoolean("rnnoiseReady", status["rnnoiseReady"] as? Boolean ?: false)
      map.putBoolean("interceptorActive", status["interceptorActive"] as? Boolean ?: false)
      map.putBoolean("processing", status["processing"] as? Boolean ?: false)
      map.putBoolean("systemNoiseSuppressorEnabled", status["systemNoiseSuppressorEnabled"] as? Boolean ?: false)
      map.putString("error", status["error"] as? String)
      promise.resolve(map)
    } catch (error: Exception) {
      promise.reject("NOISE_STATUS", error.message, error)
    }
  }

  @ReactMethod
  fun listAudioDevices(promise: Promise) {
    try {
      val result = Arguments.createMap()
      val inputs = Arguments.createArray()
      for (device in AudioRouteRuntime.listInputs()) {
        val map = Arguments.createMap()
        map.putString("id", device.id)
        map.putString("label", device.label)
        map.putBoolean("isDefault", device.isDefault)
        inputs.pushMap(map)
      }
      val outputs = Arguments.createArray()
      for (device in AudioRouteRuntime.listOutputs()) {
        val map = Arguments.createMap()
        map.putString("id", device.id)
        map.putString("label", device.label)
        map.putBoolean("isDefault", device.isDefault)
        outputs.pushMap(map)
      }
      result.putArray("inputs", inputs)
      result.putArray("outputs", outputs)
      result.putString("inputId", AudioRouteRuntime.selectedInputId())
      result.putString("outputId", AudioRouteRuntime.selectedOutputId() ?: "")
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("AUDIO_DEVICES", error.message, error)
    }
  }

  @ReactMethod
  fun setAudioInputDevice(deviceId: String, promise: Promise) {
    mainHandler.post {
      try {
        val ok = AudioRouteRuntime.setInput(deviceId)
        if (ok) promise.resolve(AudioRouteRuntime.selectedInputId())
        else promise.reject("AUDIO_INPUT", "无法切换到所选麦克风")
      } catch (error: Exception) {
        promise.reject("AUDIO_INPUT", error.message, error)
      }
    }
  }

  @ReactMethod
  fun setAudioOutputDevice(deviceId: String, promise: Promise) {
    mainHandler.post {
      try {
        val ok = AudioRouteRuntime.setOutput(deviceId)
        if (ok) promise.resolve(AudioRouteRuntime.selectedOutputId() ?: "")
        else promise.reject("AUDIO_OUTPUT", "无法切换到所选输出设备")
      } catch (error: Exception) {
        promise.reject("AUDIO_OUTPUT", error.message, error)
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
    dnsExecutor.shutdownNow()
    super.invalidate()
  }
}
