package com.covemobile

/**
 * JNI bridge to the bundled RNNoise implementation (48 kHz mono PCM16).
 * Native side carries leftover samples across calls so arbitrary buffer
 * sizes do not reset the model state.
 */
object RnnoiseEngine {
  @Volatile
  private var ready = false

  @Volatile
  var enabled = true

  fun init(): Boolean {
    synchronized(this) {
      if (ready) return true
      ready = try {
        System.loadLibrary("cove_rnnoise")
        nativeInit()
      } catch (error: Throwable) {
        false
      }
      return ready
    }
  }

  fun release() {
    synchronized(this) {
      if (!ready) return
      nativeRelease()
      ready = false
    }
  }

  fun isReady(): Boolean = ready

  fun processPcm16(bytes: ByteArray, length: Int) {
    if (!ready || !enabled || length <= 0) return
    nativeProcessPcm16(bytes, length)
  }

  private external fun nativeInit(): Boolean
  private external fun nativeRelease()
  private external fun nativeFrameSize(): Int
  private external fun nativeProcessPcm16(pcm: ByteArray, length: Int)
}
