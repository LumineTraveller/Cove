import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import { MediaStream } from 'react-native-webrtc';

export const canShareScreenAudio =
  Platform.OS === 'android' && Number(Platform.Version) >= 29;
export const canShareMobileScreen = Platform.OS === 'android';

type StreamInfo = Extract<
  NonNullable<ConstructorParameters<typeof MediaStream>[0]>,
  { streamId: string }
>;
interface PlaybackAudioInfo extends StreamInfo {
  sessionId: string;
}
interface ScreenModule {
  getScreenEncoderCapabilities(): Promise<ScreenEncoderCapabilities>;
  prepareScreenVideo(): Promise<{ sessionId: string }>;
  waitForScreenTransportClosed(sessionId: string): Promise<void>;
  releaseScreenVideo(sessionId: string): Promise<void>;
  createPlaybackAudio(sessionId: string): Promise<PlaybackAudioInfo>;
  releasePlaybackAudio(sessionId: string): Promise<void>;
}
const native = NativeModules.CoveScreen as ScreenModule | undefined;

export interface ScreenEncoderCapabilities {
  h264Hardware: boolean;
  h264HardwareProfiles: string[];
  codecs: string[];
}
export interface ScreenEncoderError {
  sessionId: string;
  attemptId: number;
  codec: string;
  stage: 'create' | 'init' | 'encode';
  reason: 'unavailable' | 'exception' | 'status';
  code?: string;
}
export interface ScreenEncoderReady {
  sessionId: string;
  attemptId: number;
  codec: string;
  implementation: string;
  hardwareAccelerated: boolean;
  width: number;
  height: number;
  targetFps: number;
  encoderMaxFramerate?: number;
}
export interface ScreenEncodingDiagnostics {
  sequence: number;
  selectedCodec?: string;
  selectionReason:
    | 'hardware-h264'
    | 'hardware-unavailable'
    | 'hardware-profile-incompatible'
    | 'capability-unavailable'
    | 'fallback';
  hardwareProbe: boolean | null;
  attempts: {
    codec: string;
    outcome: 'selected' | 'failed';
    reason?: 'negotiation' | 'native-create' | 'native-init' | 'native-encode';
    code?: string;
  }[];
  ready?: Omit<ScreenEncoderReady, 'sessionId' | 'attemptId'>;
}

export function getScreenEncoderCapabilities() {
  if (!native?.getScreenEncoderCapabilities)
    return Promise.reject(new Error('此版本缺少屏幕编码能力检查'));
  return native.getScreenEncoderCapabilities();
}
export function prepareScreenVideo() {
  if (!native?.prepareScreenVideo)
    return Promise.reject(new Error('此版本缺少独立屏幕编码通道'));
  return native.prepareScreenVideo();
}
export function waitForScreenTransportClosed(sessionId: string) {
  return native?.waitForScreenTransportClosed(sessionId) ?? Promise.resolve();
}
export function releaseScreenVideo(sessionId: string) {
  return native?.releaseScreenVideo(sessionId) ?? Promise.resolve();
}
export async function createPlaybackAudio(sessionId: string) {
  if (!canShareScreenAudio || !native)
    throw new Error('此设备暂不支持共享播放音频');
  const info = await native.createPlaybackAudio(sessionId);
  return { stream: new MediaStream(info), sessionId: info.sessionId };
}
export function releasePlaybackAudio(sessionId: string) {
  return native?.releasePlaybackAudio(sessionId) ?? Promise.resolve();
}
export function onScreenAudioError(
  callback: (event: { sessionId: string; message: string }) => void,
) {
  return DeviceEventEmitter.addListener('CoveScreenAudioError', callback);
}
export function onScreenEncoderError(
  callback: (event: ScreenEncoderError) => void,
) {
  return DeviceEventEmitter.addListener('CoveScreenEncoderError', callback);
}
export function onScreenEncoderReady(
  callback: (event: ScreenEncoderReady) => void,
) {
  return DeviceEventEmitter.addListener('CoveScreenEncoderReady', callback);
}
