import type { ProcessedMicrophone } from './microphoneProcessing';
import { microphoneEchoWarning } from './microphoneEcho';

export type MicrophoneNoiseMode = 'system' | 'rnnoise';

export interface MicrophoneCandidate {
  raw: MediaStream;
  processed: ProcessedMicrophone;
  mode: MicrophoneNoiseMode;
  warning: string | null;
}

/** Transactional acquisition: the caller keeps its old producer until this succeeds. */
export async function acquireMicrophoneCandidate(
  requestedMode: MicrophoneNoiseMode,
  acquire: (mode: MicrophoneNoiseMode) => Promise<MediaStream>,
  process: (raw: MediaStream, mode: MicrophoneNoiseMode) => Promise<ProcessedMicrophone>,
): Promise<MicrophoneCandidate> {
  async function attempt(mode: MicrophoneNoiseMode): Promise<MicrophoneCandidate> {
    const raw = await acquire(mode);
    let processed: ProcessedMicrophone | undefined;
    try {
      if (mode === 'rnnoise' && raw.getAudioTracks()[0]?.getSettings().noiseSuppression === true)
        throw new Error('设备未关闭系统降噪，已取消双重降噪');
      processed = await process(raw, mode);
      if (processed.stream.getAudioTracks()[0]?.readyState !== 'live') throw new Error('麦克风音轨不可用');
      return { raw, processed, mode, warning: microphoneEchoWarning(raw) };
    } catch (error) {
      processed?.stream.getTracks().forEach((track) => track.stop());
      if (processed?.stream !== raw) raw.getTracks().forEach((track) => track.stop());
      await processed?.context?.close().catch(() => {});
      throw error;
    }
  }
  try {
    return await attempt(requestedMode);
  } catch (error) {
    if (requestedMode === 'system') throw error;
    const fallback = await attempt('system');
    fallback.warning = [`RNNoise 未启用，已回退到系统降噪：${error instanceof Error ? error.message : String(error)}`, fallback.warning].filter(Boolean).join('；');
    return fallback;
  }
}
