package com.covemobile

import java.nio.ByteBuffer

/** Serialize reset/release/processing so a mode switch cannot free a live model. */
object RnnoiseEngine {
  @Volatile private var ready = false
  private var loaded = false
  @Synchronized fun init(): Boolean = if (ready) true else reset()
  @Synchronized fun reset(): Boolean {
    ready = try {
      if (!loaded) {
        System.loadLibrary("cove_rnnoise")
        loaded = true
      }
      nativeReset()
    } catch (_: LinkageError) { false }
    return ready
  }
  @Synchronized fun release() {
    if (loaded) nativeRelease()
    ready = false
  }
  fun isReady(): Boolean = ready
  @Synchronized fun processPcm16(buffer: ByteBuffer): Boolean {
    if (!ready || !buffer.isDirect || buffer.capacity() <= 0 || buffer.capacity() % 2 != 0) return false
    return nativeProcessPcm16(buffer, buffer.capacity())
  }
  private external fun nativeReset(): Boolean
  private external fun nativeRelease()
  private external fun nativeProcessPcm16(pcm: ByteBuffer, length: Int): Boolean
}
