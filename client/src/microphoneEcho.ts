import { createMicrophoneConstraints } from './audioDevices';

type NoiseMode = 'system' | 'rnnoise';
type Capture = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

export function microphoneEchoMode(stream: MediaStream): boolean | string | undefined {
  // Current Chromium exposes string modes; older lib.dom only knows boolean.
  return stream.getAudioTracks()[0]?.getSettings().echoCancellation;
}

export function microphoneEchoWarning(stream: MediaStream): string | null {
  return microphoneEchoMode(stream) === 'all' ? null
    : '当前设备未启用全系统回声消除，其他应用或扬声器声音可能回传；建议使用耳机。';
}

function unsupportedAllMode(error: unknown): boolean {
  const reason = error as { name?: string; constraint?: string } | null;
  // Do not hide a device-id failure, denied permission, or a busy device by
  // retrying capture under different processing constraints.
  return reason?.name === 'TypeError' ||
    (reason?.name === 'OverconstrainedError' && reason.constraint === 'echoCancellation');
}

/** AEC must run on the capture BEFORE RNNoise; never use desktop audio as mic output. */
export async function requestEchoCancelledMicrophone(
  deviceId: string,
  mode: NoiseMode,
  capture: Capture = (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  timeoutMs = 10_000,
): Promise<MediaStream> {
  const deadline = Date.now() + timeoutMs;
  const stop = (stream: MediaStream) => stream.getTracks().forEach((track) => track.stop());

  async function attempt(scope: 'all' | 'browser'): Promise<MediaStream> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('麦克风采集超时，请检查设备与权限');
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = Promise.resolve().then(() => capture({ audio: createMicrophoneConstraints(deviceId, mode, scope) }));
    try {
      const stream = await Promise.race([
        pending.then((value) => {
          if (expired) stop(value);
          return value;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error('麦克风采集超时，请检查设备与权限'));
          }, remaining);
        }),
      ]);
      const echo = microphoneEchoMode(stream);
      if (stream.getAudioTracks()[0]?.readyState !== 'live' || echo === false) {
        stop(stream);
        throw new Error('麦克风未提供启用回声消除的有效音轨');
      }
      if (scope === 'all' && echo !== 'all') {
        // Old engines may ignore unknown string constraints. Stop this track
        // and explicitly request native AEC instead of claiming full coverage.
        stop(stream);
        throw Object.assign(new Error('全系统回声消除不可用'), {
          name: 'OverconstrainedError', constraint: 'echoCancellation',
        });
      }
      console.info('[mic] 回声消除采集模式', { requested: scope, actual: echo, noiseMode: mode });
      return stream;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  try {
    return await attempt('all');
  } catch (error) {
    if (!unsupportedAllMode(error)) throw error;
    // Compatibility fallback is reported by microphoneEchoWarning in the
    // candidate, and still requires native AEC. RNNoise cannot replace AEC.
    return attempt('browser');
  }
}
