package com.covemobile.audio

import android.media.AudioRecord
import android.os.Build
import android.os.Process
import android.os.SystemClock
import com.covemobile.RnnoiseEngine
import org.webrtc.Logging
import org.webrtc.audio.JavaAudioDeviceModule
import java.lang.reflect.Field
import java.lang.reflect.Method
import java.nio.ByteBuffer

/**
 * Takes over the JavaAudioDeviceModule capture loop so RNNoise can run on PCM
 * before it reaches native WebRTC.
 *
 * JavaAudioDeviceModule's own AudioRecordThread hands buffers to native and
 * only afterwards delivers a copy to SamplesReadyCallback — too late to edit.
 * We therefore stop that thread once recording is live and run an equivalent
 * loop that denoises in place, then calls the same nativeDataIsRecorded entry.
 *
 * If reflection or hijacking fails, callers fall back to system noise
 * suppression and this class becomes a no-op.
 */
object RnnoiseAudioInterceptor {
  private const val TAG = "CoveRnnoiseAdm"

  @Volatile
  private var attached = false
  @Volatile
  private var hijacked = false
  @Volatile
  private var running = false
  @Volatile
  private var fallbackMode = false

  private var worker: Thread? = null

  private lateinit var audioInput: Any
  private lateinit var byteBufferField: Field
  private lateinit var audioRecordField: Field
  private lateinit var nativeAudioRecordField: Field
  private lateinit var nativeDataIsRecorded: Method
  private lateinit var audioThreadField: Field
  private lateinit var microphoneMuteField: Field

  @Synchronized
  fun attach(adm: JavaAudioDeviceModule): Boolean {
    if (attached) return !fallbackMode
    return try {
      val inputField = JavaAudioDeviceModule::class.java.getDeclaredField("audioInput")
      inputField.isAccessible = true
      audioInput = inputField.get(adm) ?: return fail("audioInput is null")

      val inputClass = audioInput.javaClass
      byteBufferField = inputClass.getDeclaredField("byteBuffer").apply { isAccessible = true }
      audioRecordField = inputClass.getDeclaredField("audioRecord").apply { isAccessible = true }
      nativeAudioRecordField = inputClass.getDeclaredField("nativeAudioRecord").apply { isAccessible = true }
      microphoneMuteField = inputClass.getDeclaredField("microphoneMute").apply { isAccessible = true }
      audioThreadField = inputClass.getDeclaredField("audioThread").apply { isAccessible = true }
      nativeDataIsRecorded = inputClass.getDeclaredMethod(
        "nativeDataIsRecorded",
        Long::class.javaPrimitiveType,
        Int::class.javaPrimitiveType,
        Long::class.javaPrimitiveType,
      ).apply { isAccessible = true }

      if (!RnnoiseEngine.init()) return fail("rnnoise native init failed")

      attached = true
      fallbackMode = false
      running = true
      worker = Thread({ supervise() }, "cove-rnnoise-audio").apply {
        priority = Thread.MAX_PRIORITY - 1
        start()
      }
      Logging.d(TAG, "RNNoise interceptor attached")
      true
    } catch (error: Throwable) {
      fail(error.message ?: error.javaClass.simpleName)
    }
  }

  /** Disable processing and restore the system NS path. */
  @Synchronized
  fun detach() {
    running = false
    worker?.interrupt()
    worker = null
    attached = false
    hijacked = false
    RnnoiseEngine.enabled = false
    RnnoiseEngine.release()
    Logging.d(TAG, "RNNoise interceptor detached")
  }

  /** True while the hijack is healthy (even if processing is temporarily off). */
  fun isAttached(): Boolean = attached && !fallbackMode

  fun isActive(): Boolean = isAttached() && RnnoiseEngine.enabled

  fun setProcessingEnabled(enabled: Boolean) {
    RnnoiseEngine.enabled = enabled
    if (!enabled) {
      // Let the stock thread own the buffer again if we never successfully hijacked.
      Logging.d(TAG, "RNNoise processing disabled")
    } else {
      Logging.d(TAG, "RNNoise processing enabled")
    }
  }

  private fun fail(reason: String): Boolean {
    fallbackMode = true
    attached = false
    Logging.w(TAG, "RNNoise interceptor unavailable: $reason")
    return false
  }

  private fun supervise() {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
    while (running) {
      try {
        val record = audioRecordField.get(audioInput) as? AudioRecord
        val buffer = byteBufferField.get(audioInput) as? ByteBuffer
        val nativePtr = nativeAudioRecordField.getLong(audioInput)

        if (record == null || buffer == null || nativePtr == 0L) {
          // 采集会话已结束；下一次录音是新的 AudioRecordThread，需要重新劫持。
          hijacked = false
          Thread.sleep(10)
          continue
        }
        if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
          Thread.sleep(10)
          continue
        }

        if (record.sampleRate != 48000) {
          // RNNoise 固定 48 kHz 单声道；其他采样率上模型结果不可信。
          fail("unsupported sample rate ${record.sampleRate}")
          return
        }

        if (!hijacked) {
          if (!stopStockThread()) {
            fail("stock capture thread would not stop")
            return
          }
          hijacked = true
          Logging.d(TAG, "took over WebRtcAudioRecord loop")
        }

        runCaptureLoop(record, buffer, nativePtr)
        // runCaptureLoop 退出后当前会话结束，下次进入时重新劫持。
        hijacked = false
      } catch (_: InterruptedException) {
        break
      } catch (error: Throwable) {
        Logging.w(TAG, "supervise error: ${error.message}")
        Thread.sleep(20)
      }
    }
  }

  /** @return true when the stock capture thread has stopped (or was never running). */
  private fun stopStockThread(): Boolean {
    val thread = audioThreadField.get(audioInput) as? Thread ?: return true
    if (!thread.isAlive) return true
    return try {
      val keepAlive = thread.javaClass.getDeclaredField("keepAlive")
      keepAlive.isAccessible = true
      keepAlive.setBoolean(thread, false)
      thread.interrupt()
      thread.join(400)
      !thread.isAlive
    } catch (error: Throwable) {
      Logging.w(TAG, "stopStockThread: ${error.message}")
      !thread.isAlive
    }
  }

  private fun runCaptureLoop(record: AudioRecord, buffer: ByteBuffer, nativePtr: Long) {
    val capacity = buffer.capacity()
    val scratch = ByteArray(capacity)
    while (running) {
      val currentRecord = audioRecordField.get(audioInput) as? AudioRecord ?: break
      val currentBuffer = byteBufferField.get(audioInput) as? ByteBuffer ?: break
      val currentNative = nativeAudioRecordField.getLong(audioInput)
      if (currentNative == 0L) break
      if (currentRecord.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
        Thread.sleep(5)
        continue
      }

      // Read into a heap scratch first so RNNoise can edit, then mirror into
      // the ByteBuffer the native side already has a pointer to.
      val read = currentRecord.read(scratch, 0, capacity)
      if (read != capacity) {
        // Stock WebRtcAudioRecord only forwards full buffers.
        if (read < 0) {
          Logging.w(TAG, "AudioRecord.read=$read")
          break
        }
        continue
      }

      val muted = try {
        microphoneMuteField.getBoolean(audioInput)
      } catch (_: Throwable) {
        false
      }

      if (muted) {
        scratch.fill(0)
      } else if (RnnoiseEngine.enabled) {
        RnnoiseEngine.processPcm16(scratch, read)
      }

      currentBuffer.clear()
      currentBuffer.put(scratch, 0, read)
      currentBuffer.position(read)

      var timestampNs = 0L
      if (Build.VERSION.SDK_INT >= 24) {
        try {
          val ts = android.media.AudioTimestamp()
          if (currentRecord.getTimestamp(ts, 0) == 0) timestampNs = ts.nanoTime
        } catch (_: Throwable) {
        }
      }
      if (timestampNs == 0L) timestampNs = SystemClock.elapsedRealtimeNanos()

      nativeDataIsRecorded.invoke(audioInput, currentNative, read, timestampNs)
    }
  }
}
