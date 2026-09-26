import { NativeModules, Platform } from 'react-native';

export type MicrophoneNoiseMode = 'system' | 'rnnoise';

export interface MicrophoneNoiseStatus {
  mode: MicrophoneNoiseMode;
  effectiveMode: MicrophoneNoiseMode;
  rnnoiseReady: boolean;
  interceptorActive: boolean;
  processing: boolean;
}

interface CoveNativeNoiseModule {
  setMicrophoneNoiseMode(mode: string): Promise<string>;
  getMicrophoneNoiseStatus(): Promise<MicrophoneNoiseStatus>;
}

const CoveNative = NativeModules.CoveNative as CoveNativeNoiseModule | undefined;

export const NOISE_MODES: ReadonlyArray<{ value: MicrophoneNoiseMode; label: string }> = [
  { value: 'rnnoise', label: 'RNNoise（改进）' },
  { value: 'system', label: '系统降噪' },
];

/** 默认使用改进版 RNNoise；每次冷启动恢复默认，不持久化。 */
export const DEFAULT_NOISE_MODE: MicrophoneNoiseMode = 'rnnoise';

export function isMicrophoneNoiseMode(value: unknown): value is MicrophoneNoiseMode {
  return value === 'system' || value === 'rnnoise';
}

export function noiseModeLabel(mode: MicrophoneNoiseMode): string {
  return NOISE_MODES.find((option) => option.value === mode)?.label ?? mode;
}

/** 采集约束：RNNoise 模式必须尽量关掉系统 NS，避免双重降噪。 */
export function createMicrophoneConstraints(mode: MicrophoneNoiseMode) {
  return {
    echoCancellation: true,
    noiseSuppression: mode === 'system',
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 48_000,
  };
}

export function isRnnoiseSupported(): boolean {
  return Platform.OS === 'android' && !!CoveNative?.setMicrophoneNoiseMode;
}

export async function applyNoiseMode(mode: MicrophoneNoiseMode): Promise<MicrophoneNoiseStatus> {
  if (!CoveNative?.setMicrophoneNoiseMode) {
    return {
      mode,
      effectiveMode: 'system',
      rnnoiseReady: false,
      interceptorActive: false,
      processing: false,
    };
  }
  await CoveNative.setMicrophoneNoiseMode(mode);
  return getNoiseStatus();
}

export async function getNoiseStatus(): Promise<MicrophoneNoiseStatus> {
  if (!CoveNative?.getMicrophoneNoiseStatus) {
    return {
      mode: DEFAULT_NOISE_MODE,
      effectiveMode: 'system',
      rnnoiseReady: false,
      interceptorActive: false,
      processing: false,
    };
  }
  const status = await CoveNative.getMicrophoneNoiseStatus();
  return {
    mode: isMicrophoneNoiseMode(status.mode) ? status.mode : DEFAULT_NOISE_MODE,
    effectiveMode: isMicrophoneNoiseMode(status.effectiveMode) ? status.effectiveMode : 'system',
    rnnoiseReady: status.rnnoiseReady === true,
    interceptorActive: status.interceptorActive === true,
    processing: status.processing === true,
  };
}
