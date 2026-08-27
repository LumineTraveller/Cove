export const DEFAULT_AUDIO_DEVICE_ID = 'default';

export const AUDIO_INPUT_DEVICE_KEY = 'cove:audio-input-device';
export const AUDIO_OUTPUT_DEVICE_KEY = 'cove:audio-output-device';

export interface AudioDeviceOption {
  deviceId: string;
  label: string;
}

export function loadAudioDeviceId(key: string): string {
  try {
    return localStorage.getItem(key) || DEFAULT_AUDIO_DEVICE_ID;
  } catch {
    return DEFAULT_AUDIO_DEVICE_ID;
  }
}

export function saveAudioDeviceId(key: string, deviceId: string): void {
  try {
    localStorage.setItem(key, deviceId || DEFAULT_AUDIO_DEVICE_ID);
  } catch {
    // 本地存储不可用时仍允许本次会话切换设备。
  }
}

export function createMicrophoneConstraints(deviceId: string): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 48_000,
    ...(deviceId && deviceId !== DEFAULT_AUDIO_DEVICE_ID
      ? { deviceId: { exact: deviceId } }
      : {}),
  };
}

export function toAudioDeviceOptions(devices: MediaDeviceInfo[], kind: MediaDeviceKind): AudioDeviceOption[] {
  let index = 0;
  const fallback = kind === 'audioinput' ? '麦克风' : '扬声器';
  return devices
    .filter(device => device.kind === kind && device.deviceId !== DEFAULT_AUDIO_DEVICE_ID)
    .map(device => {
      index += 1;
      return {
        deviceId: device.deviceId,
        label: device.label || `${fallback} ${index}`,
      };
    });
}

type SinkElement = HTMLMediaElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

type SinkAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

export function resolvedSinkId(deviceId: string): string {
  return deviceId === DEFAULT_AUDIO_DEVICE_ID ? '' : deviceId;
}

export async function applyAudioElementOutput(
  element: HTMLMediaElement,
  deviceId: string,
): Promise<boolean> {
  const sinkElement = element as SinkElement;
  if (typeof sinkElement.setSinkId !== 'function') return false;
  await sinkElement.setSinkId(resolvedSinkId(deviceId));
  return true;
}

export async function applyAudioContextOutput(
  context: AudioContext,
  deviceId: string,
): Promise<boolean> {
  const sinkContext = context as SinkAudioContext;
  if (typeof sinkContext.setSinkId !== 'function') return false;
  await sinkContext.setSinkId(resolvedSinkId(deviceId));
  return true;
}

export function isMemberVoiceAudio(kind: string, sourceType?: string): boolean {
  return kind === 'audio' && sourceType !== 'screen-audio' && sourceType !== 'application-audio';
}

/** Only the gain path is audible; Chromium also needs a muted element to activate remote playout. */
export function createVoiceAudioOutput(
  context: AudioContext,
  stream: MediaStream,
  volume: number,
  activationElement: HTMLAudioElement = new Audio(),
) {
  const source = context.createMediaStreamSource(stream);
  const gain = context.createGain();
  // Electron 29 的远端 WebRTC 流需要媒体元素激活才能进入 Web Audio。
  // 双重静音仅作用于这个元素，不影响原始 track；它绝不能形成第二条可听路径。
  activationElement.muted = true;
  activationElement.volume = 0;
  activationElement.srcObject = stream;
  gain.gain.value = Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 1;
  try {
    source.connect(gain).connect(context.destination);
  } catch (error) {
    source.disconnect();
    gain.disconnect();
    activationElement.srcObject = null;
    throw error;
  }
  let closed = false;
  return {
    source,
    gain,
    async resume() {
      if (!closed) await Promise.all([context.resume(), activationElement.play()]);
    },
    close() {
      if (closed) return;
      closed = true;
      activationElement.pause();
      activationElement.srcObject = null;
      source.disconnect();
      gain.disconnect();
    },
  };
}
