#include <jni.h>
#include "rnnoise_pcm_processor.h"

// Serialized by RnnoiseEngine. No per-frame array copies or thread takeover.
static RnnoisePcmProcessor processor;
extern "C" JNIEXPORT jboolean JNICALL
Java_com_covemobile_RnnoiseEngine_nativeReset(JNIEnv*, jobject) {
  return processor.reset() ? JNI_TRUE : JNI_FALSE;
}
extern "C" JNIEXPORT void JNICALL
Java_com_covemobile_RnnoiseEngine_nativeRelease(JNIEnv*, jobject) { processor.release(); }
extern "C" JNIEXPORT jboolean JNICALL
Java_com_covemobile_RnnoiseEngine_nativeProcessPcm16(JNIEnv* env, jobject, jobject pcm, jint length) {
  if (!pcm || length <= 0 || length % 2 != 0) return JNI_FALSE;
  const jlong capacity = env->GetDirectBufferCapacity(pcm);
  auto* samples = static_cast<std::int16_t*>(env->GetDirectBufferAddress(pcm));
  if (!samples || capacity < length) return JNI_FALSE;
  return processor.process(samples, length / 2) ? JNI_TRUE : JNI_FALSE;
}
