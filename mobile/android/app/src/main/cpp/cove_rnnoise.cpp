#include <jni.h>
#include <android/log.h>
#include <cstring>
#include "rnnoise.h"

#define TAG "CoveRnnoise"
#define LOGD(...) __android_log_print(ANDROID_LOG_DEBUG, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

// RNNoise: 48 kHz mono, 480-sample (10 ms) float frames, values scaled like int16.
static DenoiseState* g_state = nullptr;
static constexpr int kFrame = 480;
static constexpr int kMaxCarry = kFrame - 1;
static float g_carry[kMaxCarry];
static int g_carryLen = 0;
static float g_work[kFrame];
static float g_out[kFrame];

static inline short clamp16(float v) {
  if (v > 32767.f) return 32767;
  if (v < -32768.f) return -32768;
  return static_cast<short>(v);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_covemobile_RnnoiseEngine_nativeInit(JNIEnv*, jclass) {
  if (g_state) return JNI_TRUE;
  g_state = rnnoise_create(nullptr);
  g_carryLen = 0;
  if (!g_state) {
    LOGE("rnnoise_create failed");
    return JNI_FALSE;
  }
  LOGD("rnnoise ready frame_size=%d", rnnoise_get_frame_size());
  return JNI_TRUE;
}

extern "C" JNIEXPORT void JNICALL
Java_com_covemobile_RnnoiseEngine_nativeRelease(JNIEnv*, jclass) {
  if (g_state) {
    rnnoise_destroy(g_state);
    g_state = nullptr;
  }
  g_carryLen = 0;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_covemobile_RnnoiseEngine_nativeFrameSize(JNIEnv*, jclass) {
  return rnnoise_get_frame_size();
}

/**
 * Process mono PCM16 in place. Non-multiples of 480 samples are carried
 * across calls; the previous tail is joined with the next buffer before
 * processing so there is no gap in the state machine.
 */
extern "C" JNIEXPORT void JNICALL
Java_com_covemobile_RnnoiseEngine_nativeProcessPcm16(
    JNIEnv* env, jclass, jbyteArray pcm, jint length) {
  if (!g_state || length < 2) return;
  const jsize total = env->GetArrayLength(pcm);
  if (length > total) length = total;

  jbyte* bytes = env->GetByteArrayElements(pcm, nullptr);
  if (!bytes) return;

  auto* samples = reinterpret_cast<short*>(bytes);
  const int sampleCount = length / 2;
  int index = 0;

  while (g_carryLen + (sampleCount - index) >= kFrame) {
    const int fromCarry = g_carryLen < kFrame ? g_carryLen : kFrame;
    const int fromBuf = kFrame - fromCarry;

    for (int i = 0; i < fromCarry; ++i) g_work[i] = g_carry[i];
    for (int i = 0; i < fromBuf; ++i) {
      g_work[fromCarry + i] = static_cast<float>(samples[index + i]);
    }
    rnnoise_process_frame(g_state, g_out, g_work);

    // Only the samples that originated in this buffer can be written back.
    for (int i = 0; i < fromBuf; ++i) {
      samples[index + i] = clamp16(g_out[fromCarry + i]);
    }

    g_carryLen = 0;
    index += fromBuf;
  }

  // Preserve the unparsed tail for the next call.
  const int rest = sampleCount - index;
  if (rest > 0) {
    if (rest > kMaxCarry) {
      // Should not happen; drop to the newest samples rather than overflow.
      index += rest - kMaxCarry;
      g_carryLen = kMaxCarry;
    } else {
      g_carryLen = rest;
    }
    for (int i = 0; i < g_carryLen; ++i) {
      g_carry[i] = static_cast<float>(samples[index + i]);
    }
  }

  env->ReleaseByteArrayElements(pcm, bytes, 0);
}
