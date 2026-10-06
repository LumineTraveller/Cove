import { NativeModules, Platform } from 'react-native';

export type MicrophoneNoiseMode = 'system' | 'rnnoise';

export interface MicrophoneNoiseStatus {
  mode: MicrophoneNoiseMode;
  effectiveMode: MicrophoneNoiseMode;
  rnnoiseReady: boolean;
  interceptorActive: boolean;
  processing: boolean;
  systemNoiseSuppressorEnabled: boolean;
  error?: string | null;
}

export interface MicrophoneNoiseOption {
  value: MicrophoneNoiseMode;
  label: string;
  disabled?: boolean;
}

interface CoveNativeNoiseModule {
  setMicrophoneNoiseMode(mode: string): Promise<string>;
  getMicrophoneNoiseStatus(): Promise<MicrophoneNoiseStatus>;
}

const CoveNative = NativeModules.CoveNative as
  | CoveNativeNoiseModule
  | undefined;

export const NOISE_MODES: ReadonlyArray<MicrophoneNoiseOption> = [
  { value: 'system', label: '系统降噪' },
  { value: 'rnnoise', label: 'RNNoise' },
];

/** 默认使用系统降噪；每次冷启动恢复默认，不持久化。 */
export const DEFAULT_NOISE_MODE: MicrophoneNoiseMode = 'system';

export function isMicrophoneNoiseMode(
  value: unknown,
): value is MicrophoneNoiseMode {
  return value === 'system' || value === 'rnnoise';
}

export function noiseModeLabel(mode: MicrophoneNoiseMode): string {
  return NOISE_MODES.find(option => option.value === mode)?.label ?? mode;
}

/** Android's native AudioSource accepts WebRTC legacy keys, not browser NS keys. */
export function createMicrophoneConstraints(mode: MicrophoneNoiseMode) {
  if (Platform.OS === 'android')
    return {
      googEchoCancellation: true,
      googNoiseSuppression: mode === 'system',
      googNoiseSuppression2: false,
      googAutoGainControl: false,
      googAutoGainControl2: false,
      googHighpassFilter: true,
    };
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 48_000,
  };
}

export function isRnnoiseSupported(): boolean {
  return Platform.OS === 'android' && !!CoveNative?.setMicrophoneNoiseMode;
}

export async function applyNoiseMode(
  mode: MicrophoneNoiseMode,
): Promise<MicrophoneNoiseStatus> {
  if (mode === 'rnnoise' && !isRnnoiseSupported())
    throw new Error('当前平台不支持 RNNoise');
  if (!CoveNative?.setMicrophoneNoiseMode) {
    return {
      mode: 'system',
      effectiveMode: 'system',
      rnnoiseReady: false,
      interceptorActive: false,
      processing: false,
      systemNoiseSuppressorEnabled: false,
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
      systemNoiseSuppressorEnabled: false,
    };
  }
  const status = await CoveNative.getMicrophoneNoiseStatus();
  return {
    mode: isMicrophoneNoiseMode(status.mode) ? status.mode : 'system',
    effectiveMode: isMicrophoneNoiseMode(status.effectiveMode)
      ? status.effectiveMode
      : 'system',
    rnnoiseReady: status.rnnoiseReady === true,
    interceptorActive: status.interceptorActive === true,
    processing: status.processing === true,
    systemNoiseSuppressorEnabled: status.systemNoiseSuppressorEnabled === true,
    error: typeof status.error === 'string' ? status.error : null,
  };
}
