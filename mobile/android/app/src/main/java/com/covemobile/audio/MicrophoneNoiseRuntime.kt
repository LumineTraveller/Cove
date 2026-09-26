package com.covemobile.audio

import com.covemobile.RnnoiseEngine
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * Runtime switch between RNNoise (default) and the system noise suppressor.
 * Mirrors the desktop MicrophoneNoiseMode contract.
 */
object MicrophoneNoiseRuntime {
  enum class Mode(val wire: String) {
    RNNOISE("rnnoise"),
    SYSTEM("system"),
    ;

    companion object {
      fun fromWire(value: String?): Mode =
        entries.firstOrNull { it.wire == value } ?: RNNOISE
    }
  }

  @Volatile
  private var mode: Mode = Mode.RNNOISE

  @Volatile
  private var adm: JavaAudioDeviceModule? = null

  @Volatile
  private var interceptorAttached = false

  fun currentMode(): Mode = mode

  fun bind(adm: JavaAudioDeviceModule, interceptorOk: Boolean) {
    this.adm = adm
    this.interceptorAttached = interceptorOk
    applyMode()
  }

  private fun interceptorUsable(): Boolean =
    interceptorAttached && RnnoiseAudioInterceptor.isAttached()

  fun setMode(value: String?): Mode {
    mode = Mode.fromWire(value)
    applyMode()
    return mode
  }

  fun status(): Map<String, Any?> {
    val processing = interceptorUsable() && RnnoiseEngine.enabled && mode == Mode.RNNOISE
    return mapOf(
      "mode" to mode.wire,
      // 请求了 RNNoise 但拦截器未就绪时，实际在跑的是系统降噪。
      "effectiveMode" to if (processing) Mode.RNNOISE.wire else Mode.SYSTEM.wire,
      "rnnoiseReady" to RnnoiseEngine.isReady(),
      "interceptorActive" to interceptorUsable(),
      "processing" to processing,
    )
  }

  private fun applyMode() {
    val deviceModule = adm
    val useRnnoise = mode == Mode.RNNOISE && interceptorUsable() && RnnoiseEngine.isReady()
    if (useRnnoise) {
      // Model NS must not stack on RNNoise — double suppression damages speech.
      RnnoiseEngine.enabled = true
      RnnoiseAudioInterceptor.setProcessingEnabled(true)
      try {
        deviceModule?.setNoiseSuppressorEnabled(false)
      } catch (_: Throwable) {
      }
    } else {
      RnnoiseEngine.enabled = false
      RnnoiseAudioInterceptor.setProcessingEnabled(false)
      try {
        deviceModule?.setNoiseSuppressorEnabled(true)
      } catch (_: Throwable) {
      }
    }
  }
}
