import { request } from '@cove/client-core';
import { types as MsTypes } from 'mediasoup-client';
import { Socket } from 'socket.io-client';

export type Transport = MsTypes.Transport;

export type Producer = MsTypes.Producer;

export type Consumer = MsTypes.Consumer;

export type RtpCapabilities = MsTypes.RtpCapabilities;

export type Fps = 30 | 60;

export interface MediaStats {
  role: 'sender' | 'receiver' | 'idle';
  rtt: number | null;
  fps: number | null;
  trackFps: number | null;
  captureFps: number | null;
  encodeFps: number | null;
  sendFps: number | null;
  receiveFps: number | null;
  decodeFps: number | null;
  loss: number | null;
  remoteLoss: number | null;
  bitrate: number | null;
  targetBitrate: number | null;
  availableBitrate: number | null;
  retransmitBitrate: number | null;
  jitter: number | null;
  width: number | null;
  height: number | null;
  trackWidth: number | null;
  trackHeight: number | null;
  droppedFrames: number | null;
  encodeTimeMs: number | null;
  decodeTimeMs: number | null;
  averageQp: number | null;
  nackPerSecond: number | null;
  pliPerSecond: number | null;
  firPerSecond: number | null;
  qualityLimitation: string | null;
  qualityLimitationCpuSeconds: number | null;
  qualityLimitationBandwidthSeconds: number | null;
  protocol: string | null;
  codec: string | null;
  encoderImplementation: string | null;
  decoderImplementation: string | null;
  powerEfficientEncoder: boolean | null;
  powerEfficientDecoder: boolean | null;
  displaySurface: string | null;
  serverIngressBitrate: number | null;
  serverEgressBitrate: number | null;
  serverScore: number | null;
}

export const EMPTY_STATS: MediaStats = {
  role: 'idle',
  rtt: null,
  fps: null,
  trackFps: null,
  captureFps: null,
  encodeFps: null,
  sendFps: null,
  receiveFps: null,
  decodeFps: null,
  loss: null,
  remoteLoss: null,
  bitrate: null,
  targetBitrate: null,
  availableBitrate: null,
  retransmitBitrate: null,
  jitter: null,
  width: null,
  height: null,
  trackWidth: null,
  trackHeight: null,
  droppedFrames: null,
  encodeTimeMs: null,
  decodeTimeMs: null,
  averageQp: null,
  nackPerSecond: null,
  pliPerSecond: null,
  firPerSecond: null,
  qualityLimitation: null,
  qualityLimitationCpuSeconds: null,
  qualityLimitationBandwidthSeconds: null,
  protocol: null,
  codec: null,
  encoderImplementation: null,
  decoderImplementation: null,
  powerEfficientEncoder: null,
  powerEfficientDecoder: null,
  displaySurface: null,
  serverIngressBitrate: null,
  serverEgressBitrate: null,
  serverScore: null,
};

export interface ServerRtpDiagnostic {
  bitrateKbps: number | null;
  score: number | null;
}

export interface ServerMediaDiagnostics {
  role: 'sender' | 'receiver' | 'idle';
  transports: {
    send?: { rtpRecvBitrateKbps: number | null } | null;
    receive?: { rtpSendBitrateKbps: number | null } | null;
  };
  producers: { stats: ServerRtpDiagnostic[]; score: { score?: number }[] }[];
  consumers: {
    stats: ServerRtpDiagnostic[];
    score: { score?: number; producerScore?: number };
  }[];
}

export function emitAsync<T = void>(socket: Socket, event: string, data?: unknown): Promise<T> {
  return request<T>(socket, event, data, { timeoutMessage: (event) => `${event} 超时` });
}

export function isMissingSsrcError(error: unknown): boolean {
  return /no a=ssrc lines found/i.test(error instanceof Error ? error.message : String(error));
}

export function waitForMediaTrackWarmup(track: MediaStreamTrack): Promise<void> {
  if (track.readyState === 'ended') return Promise.reject(new Error('媒体轨道在发布前已经结束'));
  return new Promise((resolve) => {
    // Two frames are enough for Chromium to attach the capture source to the
    // sender. The timeout also covers background/throttled Electron windows.
    if (typeof requestAnimationFrame === 'function') {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(finish, 250);
      requestAnimationFrame(() => requestAnimationFrame(finish));
    } else {
      setTimeout(resolve, 80);
    }
  });
}

export async function produceWithSsrcRetry<T>(produce: () => Promise<T>): Promise<T> {
  try {
    return await produce();
  } catch (error) {
    if (!isMissingSsrcError(error)) throw error;
    // mediasoup-client parses the local SDP immediately after createOffer().
    // A newly-created display/audio track can need one renderer turn before
    // that SDP contains its SSRC. Retry only this known transient failure.
    await new Promise((resolve) => setTimeout(resolve, 120));
    return produce();
  }
}

export interface RemoteScreen {
  socketId: string;
  stream: MediaStream;
}

export interface AvailableScreen {
  socketId: string;
  videoProducerId: string;
  audioProducerId?: string;
}

export interface RemoteApplicationAudio {
  socketId: string;
  producerId: string;
  label: string;
}

export const MEMBER_VOLUME_KEY = 'cove_member_volumes_v1';

export const SCREEN_RECEIVE_VOLUME_KEY = 'cove_screen_receive_volume_v1';

export const SCREEN_SHARE_VOLUME_KEY = 'cove_screen_share_volume_v1';

export const APPLICATION_AUDIO_SHARE_VOLUME_KEY = 'cove_application_audio_share_volume_v1';

export const APPLICATION_AUDIO_RECEIVE_VOLUME_KEY = 'cove_application_audio_receive_volume_v1';

export const MICROPHONE_VOLUME_KEY = 'cove_microphone_volume_v1';

export const MASTER_OUTPUT_VOLUME_KEY = 'cove_master_output_volume_v1';

export function loadNumber(key: string, fallback: number, maximum = 1) {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return fallback;
    const value = Number(stored);
    return Number.isFinite(value) ? Math.max(0, Math.min(maximum, value)) : fallback;
  } catch {
    return fallback;
  }
}

export function loadMemberVolumes(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(MEMBER_VOLUME_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) =>
        typeof value === 'number' && Number.isFinite(value)
          ? [[key, Math.max(0, Math.min(2, value))]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

export function loadVolumeMap(key: string, maximum = 1): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([entryKey, value]) =>
        typeof value === 'number' && Number.isFinite(value)
          ? [[entryKey, Math.max(0, Math.min(maximum, value))]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}
