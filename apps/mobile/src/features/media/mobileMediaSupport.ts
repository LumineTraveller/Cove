import { request } from '@cove/client-core';

import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import type { Socket } from 'socket.io-client';
import { types as MsTypes } from 'mediasoup-client';

import { MediaStream } from 'react-native-webrtc';

export type Transport = MsTypes.Transport;

export type Producer = MsTypes.Producer;

export type Consumer = MsTypes.Consumer;

export type RtpCapabilities = MsTypes.RtpCapabilities;

export interface RemoteScreen {
  socketId: string;
  consumerId: string;
  stream: MediaStream;
}

export interface AvailableScreen {
  socketId: string;
  videoProducerId: string;
  audioProducerId?: string;
}

export interface ApplicationAudioShare {
  producerId: string;
  socketId: string;
  label: string;
  volume: number;
}

export interface CoveNativeModule {
  startVoiceService(): void;
  stopVoiceService(): void;
  setSpeakerphoneEnabled(enabled: boolean): void;
  playPresenceTone(action: 'join' | 'leave'): void;
}

export const CoveNative = NativeModules.CoveNative as
  | CoveNativeModule
  | undefined;

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'failed';

export function emitAsync<T = void>(
  socket: Socket,
  event: string,
  data?: unknown,
): Promise<T> {
  return request<T>(socket, event, data, {
    timeoutMessage: event => `${event} 请求超时`,
  });
}

export async function requestMicrophonePermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    {
      title: '允许使用麦克风',
      message: 'Cove 需要麦克风权限才能加入朋友语音。',
      buttonPositive: '允许',
      buttonNegative: '取消',
    },
  );
  if (Number(Platform.Version) >= 33) {
    await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    ).catch(() => {});
  }
  return result === PermissionsAndroid.RESULTS.GRANTED;
}
