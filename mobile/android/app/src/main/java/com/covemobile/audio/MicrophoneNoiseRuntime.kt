package com.covemobile.audio

import android.media.AudioFormat
import android.media.AudioRecord
import com.oney.WebRTCModule.CoveScreenRuntime
import com.covemobile.RnnoiseEngine
import org.webrtc.Logging
import java.nio.ByteBuffer

/** Runs on WebRTC's OWN capture thread before PCM is sent to native WebRTC. */
object MicrophoneNoiseRuntime {
  enum class Mode(val wire: String) { SYSTEM("system"), RNNOISE("rnnoise") }
  private var mode = Mode.SYSTEM
  private var captureActive = false
  private var hookActive = false
  private var processing = false
  private var muted = false
  private var error: String? = null

  @Synchronized fun onAudioRecordStarted() {
    captureActive = true
    hookActive = false
    processing = false
    muted = false
    if (mode == Mode.RNNOISE && !RnnoiseEngine.reset()) error = "RNNoise 模型初始化失败"
  }
  @Synchronized fun onAudioRecordStopped() {
    captureActive = false
    hookActive = false
    processing = false
    RnnoiseEngine.release()
  }
  @Synchronized fun setMode(value: String?): Mode {
    val next = Mode.entries.find { it.wire == value } ?: throw IllegalArgumentException("未知降噪模式")
    // Validate before committing: failed switches retain the previous mode.
    if (next == Mode.RNNOISE && !RnnoiseEngine.reset()) throw IllegalStateException("RNNoise 模型不可用")
    if (next == Mode.SYSTEM) RnnoiseEngine.release()
    mode = next
    processing = false
    muted = false
    error = null
    return mode
  }
  @Synchronized fun status(): Map<String, Any?> = mapOf(
    "mode" to mode.wire,
    "effectiveMode" to mode.wire,
    "rnnoiseReady" to RnnoiseEngine.isReady(),
    // Legacy key: pre-send hook observed, NOT a replacement capture thread.
    "interceptorActive" to hookActive,
    "processing" to processing,
    "systemNoiseSuppressorEnabled" to (captureActive && mode == Mode.SYSTEM),
    "error" to error,
  )
  @JvmStatic @Synchronized
  fun processRecordedBuffer(record: AudioRecord, buffer: ByteBuffer, sampleRate: Int, channels: Int, format: Int, microphoneMuted: Boolean) {
    // Playback audio is music/game sound, not a second microphone. Never run RNNoise on it.
    if (CoveScreenRuntime.isPlaybackRecord(record)) return
    hookActive = true
    if (mode != Mode.RNNOISE || error != null) return
    try {
      check(sampleRate == 48_000 && channels == 1 && format == AudioFormat.ENCODING_PCM_16BIT) {
        "RNNoise 需要 48 kHz 单声道 PCM16，实际为 $sampleRate Hz / $channels 声道 / 格式 $format"
      }
      if (microphoneMuted) {
        // WebRTC already zeroed this buffer. Don't leak queued voice into it.
        if (!muted) check(RnnoiseEngine.reset()) { "RNNoise 重置失败" }
        muted = true
        processing = false
        return
      }
      muted = false
      check(RnnoiseEngine.processPcm16(buffer)) { "RNNoise 音频缓冲区处理失败" }
      processing = true
    } catch (failure: Exception) {
      error = failure.message ?: "RNNoise 处理失败"
      processing = false
      Logging.e("CoveAudio", error!!)
      // JS observes this fault and replaces ONLY the microphone source with
      // system NS. Never stop capture or remove the user from voice here.
    }
  }
}
