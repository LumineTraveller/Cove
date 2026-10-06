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
  createPlaybackAudio(): Promise<PlaybackAudioInfo>;
  releasePlaybackAudio(sessionId: string): Promise<void>;
}
const native = NativeModules.CoveScreen as ScreenModule | undefined;

export async function createPlaybackAudio() {
  if (!canShareScreenAudio || !native)
    throw new Error('此设备暂不支持共享播放音频');
  const info = await native.createPlaybackAudio();
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
