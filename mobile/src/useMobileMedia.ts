import { useCallback, useEffect, useRef, useState } from 'react';
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import type { Socket } from 'socket.io-client';
import { Device, types as MsTypes } from 'mediasoup-client';
import InCallManager from 'react-native-incall-manager';
import {
  MediaStream,
  MediaStreamTrack,
  mediaDevices,
} from 'react-native-webrtc';
import type { VoiceMember } from './types';
import { startVoiceAudioSession } from './voiceAudioSession';

type Transport = MsTypes.Transport;
type Producer = MsTypes.Producer;
type Consumer = MsTypes.Consumer;
type RtpCapabilities = MsTypes.RtpCapabilities;

interface RemoteScreen {
  socketId: string;
  consumerId: string;
  stream: MediaStream;
}

interface AvailableScreen {
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

interface CoveNativeModule {
  startVoiceService(): void;
  stopVoiceService(): void;
  setSpeakerphoneEnabled(enabled: boolean): void;
  playPresenceTone(action: 'join' | 'leave'): void;
}

const CoveNative = NativeModules.CoveNative as CoveNativeModule | undefined;

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'failed';

function emitAsync<T = void>(socket: Socket, event: string, data?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 请求超时`)), 15_000);
    socket.emit(event, data, (response: T | { error: string }) => {
      clearTimeout(timer);
      if (response && typeof response === 'object' && 'error' in response) {
        reject(new Error(String(response.error)));
      } else {
        resolve(response as T);
      }
    });
  });
}

async function requestMicrophonePermission(): Promise<boolean> {
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
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => {});
  }
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export function useMobileMedia(socket: Socket, roomId: string) {
  const [inVoice, setInVoice] = useState(false);
  const [joining, setJoining] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isForceMuted, setIsForceMuted] = useState(false);
  const [voiceMembers, setVoiceMembers] = useState<VoiceMember[]>([]);
  const [remoteScreen, setRemoteScreen] = useState<RemoteScreen | null>(null);
  const [availableScreens, setAvailableScreens] = useState<AvailableScreen[]>([]);
  const [applicationAudioShares, setApplicationAudioShares] = useState<ApplicationAudioShare[]>([]);
  const [isWatchingScreen, setIsWatchingScreen] = useState(false);
  const [screenReceiveVolume, setScreenReceiveVolumeState] = useState(1);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [error, setError] = useState<string | null>(null);

  const deviceRef = useRef<Device | null>(null);
  const sendTransport = useRef<Transport | null>(null);
  const recvTransport = useRef<Transport | null>(null);
  const audioProducer = useRef<Producer | null>(null);
  const microphoneStream = useRef<MediaStream | null>(null);
  const consumers = useRef(new Map<string, {
    consumer: Consumer;
    producerId: string;
    socketId: string;
    kind: string;
    stream: MediaStream;
    sourceType?: string;
  }>());
  const consumerByProducer = useRef(new Map<string, string>());
  const pendingProducers = useRef(new Set<string>());
  const closedProducers = useRef(new Set<string>());
  const mediaGeneration = useRef(0);
  const applicationAudioVolumes = useRef(new Map<string, number>());
  const inVoiceRef = useRef(false);
  const selfMutedRef = useRef(false);
  const forceMutedRef = useRef(false);
  const availableScreensRef = useRef(new Map<string, AvailableScreen>());
  const pendingScreenAudioByPeer = useRef(new Map<string, string>());
  const watchingScreenPeerRef = useRef<string | null>(null);
  const screenReceiveVolumeRef = useRef(1);

  const publishAvailableScreens = useCallback(() => {
    setAvailableScreens([...availableScreensRef.current.values()]);
  }, []);

  const storeAvailableScreen = useCallback((screen: AvailableScreen) => {
    availableScreensRef.current.set(screen.socketId, screen);
    publishAvailableScreens();
  }, [publishAvailableScreens]);

  const removeAvailableScreen = useCallback((socketId: string, videoProducerId?: string) => {
    const current = availableScreensRef.current.get(socketId);
    if (!current || (videoProducerId && current.videoProducerId !== videoProducerId)) return;
    availableScreensRef.current.delete(socketId);
    publishAvailableScreens();
  }, [publishAvailableScreens]);

  const clearAvailableScreens = useCallback(() => {
    availableScreensRef.current.clear();
    publishAvailableScreens();
  }, [publishAvailableScreens]);

  const teardown = useCallback((notifyServer: boolean) => {
    mediaGeneration.current += 1;
    if (notifyServer && socket.connected) socket.emit('voice:leave', roomId);

    audioProducer.current?.close();
    audioProducer.current = null;
    sendTransport.current?.close();
    sendTransport.current = null;
    recvTransport.current?.close();
    recvTransport.current = null;
    deviceRef.current = null;

    microphoneStream.current?.release(true);
    microphoneStream.current = null;
    consumers.current.forEach(({ consumer, stream }) => {
      consumer.close();
      stream.release(false);
    });
    consumers.current.clear();
    consumerByProducer.current.clear();
    pendingProducers.current.clear();
    closedProducers.current.clear();
    applicationAudioVolumes.current.clear();
    setApplicationAudioShares([]);
    pendingScreenAudioByPeer.current.clear();

    if (inVoiceRef.current) {
      CoveNative?.setSpeakerphoneEnabled(false);
      InCallManager.setForceSpeakerphoneOn(null);
      InCallManager.stop();
    }
    inVoiceRef.current = false;
    selfMutedRef.current = false;
    setInVoice(false);
    setJoining(false);
    setIsMuted(forceMutedRef.current);
    setVoiceMembers([]);
    setRemoteScreen(null);
    clearAvailableScreens();
    watchingScreenPeerRef.current = null;
    setIsWatchingScreen(false);
    setConnectionState('idle');
    CoveNative?.stopVoiceService();
  }, [roomId, socket, clearAvailableScreens]);

  const setupDevice = useCallback(async () => {
    if (deviceRef.current && sendTransport.current && recvTransport.current) return;

    const capabilities = await emitAsync<RtpCapabilities>(socket, 'ms:capabilities');
    const device = await Device.factory();
    await device.load({ routerRtpCapabilities: capabilities });
    deviceRef.current = device;

    const sendParams = await emitAsync<Record<string, unknown>>(
      socket,
      'ms:create-transport',
      { direction: 'send' },
    );
    const outgoing = device.createSendTransport(sendParams as never);
    outgoing.on('connect', ({ dtlsParameters }, resolve, reject) => {
      emitAsync(socket, 'ms:connect-transport', {
        transportId: outgoing.id,
        dtlsParameters,
      }).then(resolve).catch(reject);
    });
    outgoing.on('produce', ({ kind, rtpParameters, appData }, resolve, reject) => {
      emitAsync<{ producerId: string }>(socket, 'ms:produce', {
        transportId: outgoing.id,
        kind,
        rtpParameters,
        appData,
      }).then(({ producerId }) => resolve({ id: producerId })).catch(reject);
    });
    outgoing.on('connectionstatechange', state => {
      if (state === 'connecting') setConnectionState('connecting');
      if (state === 'connected') setConnectionState('connected');
      if (state === 'failed' || state === 'disconnected') {
        setConnectionState('failed');
        setError('媒体发送通道已中断，请重新加入语音');
      }
    });
    sendTransport.current = outgoing;

    const recvParams = await emitAsync<Record<string, unknown>>(
      socket,
      'ms:create-transport',
      { direction: 'recv' },
    );
    const incoming = device.createRecvTransport(recvParams as never);
    incoming.on('connect', ({ dtlsParameters }, resolve, reject) => {
      emitAsync(socket, 'ms:connect-transport', {
        transportId: incoming.id,
        dtlsParameters,
      }).then(resolve).catch(reject);
    });
    incoming.on('connectionstatechange', state => {
      if (state === 'connecting') setConnectionState('connecting');
      if (state === 'connected') setConnectionState('connected');
      if (state === 'failed' || state === 'disconnected') {
        setConnectionState('failed');
        setError('媒体接收通道已中断，请重新加入语音');
      }
    });
    recvTransport.current = incoming;
  }, [socket]);

  const removeConsumer = useCallback((consumerId: string, notifyServer = false) => {
    const entry = consumers.current.get(consumerId);
    if (!entry) return;
    consumers.current.delete(consumerId);
    consumerByProducer.current.delete(entry.producerId);
    entry.consumer.close();
    if (notifyServer && socket.connected) socket.emit('ms:close-consumer', { consumerId });
    entry.stream.release(false);
    if (entry.sourceType === 'application-audio') {
      applicationAudioVolumes.current.delete(entry.producerId);
      setApplicationAudioShares(current => current.filter(share => share.producerId !== entry.producerId));
    }
    if (entry.kind === 'video') {
      setRemoteScreen(current => current?.consumerId === consumerId ? null : current);
    }
  }, [socket]);

  const consumeProducer = useCallback(async (
    producerId: string,
    peerId: string,
    kind: string,
    appData: Record<string, unknown> = {},
  ) => {
    const device = deviceRef.current;
    const incoming = recvTransport.current;
    const generation = mediaGeneration.current;
    if (!device || !incoming || !inVoiceRef.current || closedProducers.current.has(producerId)) return false;
    if (consumerByProducer.current.has(producerId) || pendingProducers.current.has(producerId)) return true;
    pendingProducers.current.add(producerId);
    let createdConsumer: Consumer | undefined;
    const isStale = () => generation !== mediaGeneration.current || !inVoiceRef.current || closedProducers.current.has(producerId);

    try {
      const params = await emitAsync<Record<string, unknown>>(socket, 'ms:consume', {
        producerId,
        rtpCapabilities: device.rtpCapabilities,
      });
      if (isStale()) {
        if (socket.connected && params.id) socket.emit('ms:close-consumer', { consumerId: params.id });
        return false;
      }
      const consumer = await incoming.consume(params as never);
      createdConsumer = consumer;
      if (isStale()) {
        consumer.close();
        if (socket.connected) socket.emit('ms:close-consumer', { consumerId: consumer.id });
        return false;
      }
      consumer.track.enabled = true;
      const stream = new MediaStream([
        consumer.track as unknown as MediaStreamTrack,
      ]);
      consumers.current.set(consumer.id, {
        consumer,
        producerId,
        socketId: peerId,
        kind,
        stream,
        sourceType: typeof appData.type === 'string' ? appData.type : undefined,
      });
      consumerByProducer.current.set(producerId, consumer.id);
      await emitAsync(socket, 'ms:resume-consumer', { consumerId: consumer.id });
      if (isStale()) { removeConsumer(consumer.id, true); return false; }

      if (kind === 'video') {
        setRemoteScreen({ socketId: peerId, consumerId: consumer.id, stream });
      }
      if (appData.type === 'screen-audio') {
        const adjustableTrack = consumer.track as unknown as { _setVolume?: (volume: number) => void };
        adjustableTrack._setVolume?.(screenReceiveVolumeRef.current);
      }
      if (kind === 'audio' && appData.type === 'application-audio') {
        const volume = applicationAudioVolumes.current.get(producerId) ?? 1;
        applicationAudioVolumes.current.set(producerId, volume);
        (consumer.track as unknown as MediaStreamTrack)._setVolume(volume);
        setApplicationAudioShares(current => [
          ...current.filter(share => share.producerId !== producerId),
          { producerId, socketId: peerId, label: typeof appData.label === 'string' ? appData.label : '应用', volume },
        ]);
      }
      consumer.on('trackended', () => removeConsumer(consumer.id));
      consumer.on('transportclose', () => removeConsumer(consumer.id));
      return true;
    } catch (cause) {
      if (createdConsumer) removeConsumer(createdConsumer.id, true);
      if (!isStale()) setError(cause instanceof Error ? cause.message : '无法接收媒体流');
      return false;
    } finally {
      if (generation === mediaGeneration.current) pendingProducers.current.delete(producerId);
    }
  }, [removeConsumer, socket]);

  const stopWatchingScreen = useCallback(() => {
    const peerId = watchingScreenPeerRef.current;
    if (!peerId) return;
    for (const [consumerId, entry] of [...consumers.current]) {
      if (entry.socketId === peerId && (entry.sourceType === 'screen' || entry.sourceType === 'screen-audio')) {
        removeConsumer(consumerId, true);
      }
    }
    watchingScreenPeerRef.current = null;
    setIsWatchingScreen(false);
    setRemoteScreen(null);
  }, [removeConsumer]);

  const watchScreen = useCallback(async (socketId?: string) => {
    const source = socketId
      ? availableScreensRef.current.get(socketId)
      : availableScreensRef.current.values().next().value as AvailableScreen | undefined;
    if (!source || watchingScreenPeerRef.current === source.socketId) return;
    if (watchingScreenPeerRef.current) stopWatchingScreen();
    watchingScreenPeerRef.current = source.socketId;
    setIsWatchingScreen(true);
    const videoOk = await consumeProducer(source.videoProducerId, source.socketId, 'video', { type: 'screen' });
    if (!videoOk) {
      watchingScreenPeerRef.current = null;
      setIsWatchingScreen(false);
      return;
    }
    const current = availableScreensRef.current.get(source.socketId);
    if (current?.audioProducerId) {
      await consumeProducer(current.audioProducerId, source.socketId, 'audio', { type: 'screen-audio' });
    }
  }, [consumeProducer, stopWatchingScreen]);

  const setScreenReceiveVolume = useCallback((volume: number) => {
    const normalized = Math.max(0, Math.min(1, volume));
    screenReceiveVolumeRef.current = normalized;
    setScreenReceiveVolumeState(normalized);
    for (const entry of consumers.current.values()) {
      if (entry.sourceType !== 'screen-audio') continue;
      const track = entry.consumer.track as unknown as { _setVolume?: (value: number) => void };
      track._setVolume?.(normalized);
    }
  }, []);

  const setApplicationAudioVolume = useCallback((producerId: string, value: number) => {
    if (!Number.isFinite(value)) return;
    const consumerId = consumerByProducer.current.get(producerId);
    const entry = consumerId ? consumers.current.get(consumerId) : undefined;
    if (entry?.sourceType !== 'application-audio') return;
    const volume = Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
    (entry.consumer.track as unknown as MediaStreamTrack)._setVolume(volume);
    applicationAudioVolumes.current.set(producerId, volume);
    setApplicationAudioShares(current => current.map(share => share.producerId === producerId ? { ...share, volume } : share));
  }, []);

  useEffect(() => {
    const onVoiceMembers = (members: VoiceMember[]) => setVoiceMembers(members);
    const onNewProducer = async ({
      producerId,
      peerId,
      kind,
      appData,
    }: { producerId: string; peerId: string; kind: string; appData: Record<string, unknown> }) => {
      if (!inVoiceRef.current) return;
      if (appData?.type === 'screen') {
        storeAvailableScreen({
          socketId: peerId,
          videoProducerId: producerId,
          audioProducerId: pendingScreenAudioByPeer.current.get(peerId),
        });
        return;
      }
      if (appData?.type === 'screen-audio') {
        pendingScreenAudioByPeer.current.set(peerId, producerId);
        const current = availableScreensRef.current.get(peerId);
        if (current) storeAvailableScreen({ ...current, audioProducerId: producerId });
        if (watchingScreenPeerRef.current === peerId) {
          await consumeProducer(producerId, peerId, kind, appData);
        }
        return;
      }
      await consumeProducer(producerId, peerId, kind, appData);
    };
    const onConsumerClosed = ({ consumerId }: { consumerId: string }) => removeConsumer(consumerId);
    const onProducerClosed = ({
      producerId,
      peerId,
      sourceType,
    }: { producerId: string; peerId: string; sourceType: string }) => {
      closedProducers.current.add(producerId);
      const consumerId = consumerByProducer.current.get(producerId);
      if (consumerId) removeConsumer(consumerId);
      if (sourceType === 'application-audio') return;
      if (sourceType === 'screen-audio') {
        if (pendingScreenAudioByPeer.current.get(peerId) === producerId)
          pendingScreenAudioByPeer.current.delete(peerId);
        const current = availableScreensRef.current.get(peerId);
        if (current?.audioProducerId === producerId) {
          storeAvailableScreen({ ...current, audioProducerId: undefined });
        }
        return;
      }
      if (sourceType !== 'screen') return;
      const currentScreen = availableScreensRef.current.get(peerId);
      if (currentScreen?.videoProducerId !== producerId) return;
      removeAvailableScreen(peerId, producerId);
      if (watchingScreenPeerRef.current === peerId) stopWatchingScreen();
    };
    const onVoicePresence = ({ action }: { action: 'join' | 'leave' }) => {
      if (inVoiceRef.current) CoveNative?.playPresenceTone(action);
    };
    const onUserLeft = ({ socketId }: { socketId: string }) => {
      for (const [consumerId, entry] of consumers.current) {
        if (entry.socketId === socketId) removeConsumer(consumerId);
      }
      pendingScreenAudioByPeer.current.delete(socketId);
      removeAvailableScreen(socketId);
      if (watchingScreenPeerRef.current === socketId) stopWatchingScreen();
    };
    const onForcedMute = ({ roomId: targetRoomId, muted }: { roomId: string; muted: boolean }) => {
      if (targetRoomId !== roomId) return;
      forceMutedRef.current = muted;
      setIsForceMuted(muted);
      if (muted) audioProducer.current?.pause();
      else if (!selfMutedRef.current) audioProducer.current?.resume();
      setIsMuted(muted || selfMutedRef.current);
    };
    const onDisconnect = () => {
      if (!inVoiceRef.current) return;
      teardown(false);
      setError('服务器连接已断开，请重连后再次加入语音');
    };

    socket.on('voice:members-updated', onVoiceMembers);
    socket.on('ms:new-producer', onNewProducer);
    socket.on('ms:consumer-closed', onConsumerClosed);
    socket.on('ms:producer-closed', onProducerClosed);
    socket.on('voice:presence', onVoicePresence);
    socket.on('voice:user-left', onUserLeft);
    socket.on('room:force-muted', onForcedMute);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('voice:members-updated', onVoiceMembers);
      socket.off('ms:new-producer', onNewProducer);
      socket.off('ms:consumer-closed', onConsumerClosed);
      socket.off('ms:producer-closed', onProducerClosed);
      socket.off('voice:presence', onVoicePresence);
      socket.off('voice:user-left', onUserLeft);
      socket.off('room:force-muted', onForcedMute);
      socket.off('disconnect', onDisconnect);
    };
  }, [consumeProducer, removeConsumer, roomId, socket, stopWatchingScreen, storeAvailableScreen, removeAvailableScreen, teardown]);

  useEffect(() => () => teardown(false), [teardown]);

  const joinVoice = useCallback(async () => {
    if (inVoiceRef.current || joining || !socket.connected) return;
    setJoining(true);
    setConnectionState('connecting');
    setError(null);

    try {
      if (!(await requestMicrophonePermission())) {
        throw new Error('未获得麦克风权限');
      }
      // Android 14+ 要求麦克风前台服务必须在可见 Activity 内启动。
      CoveNative?.startVoiceService();
      const stream = await mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: 48_000,
        },
        video: false,
      } as never);
      microphoneStream.current = stream;
      await setupDevice();
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('没有可用的麦克风音轨');

      const producer = await sendTransport.current!.produce({
        track: track as never,
        codecOptions: { opusStereo: false, opusDtx: true, opusFec: true },
        encodings: [{ maxBitrate: 32_000 }],
        appData: { type: 'mic', client: 'android' },
      });
      audioProducer.current = producer;
      if (forceMutedRef.current) producer.pause();

      startVoiceAudioSession();
      CoveNative?.setSpeakerphoneEnabled(true);
      inVoiceRef.current = true;
      setInVoice(true);
      setIsMuted(forceMutedRef.current);
      socket.emit('voice:join', roomId);

      const existing = await emitAsync<{
        producerId: string;
        peerId: string;
        kind: string;
        appData: Record<string, unknown>;
      }[]>(socket, 'ms:get-producers');
      for (const item of existing) {
        if (item.appData?.type === 'screen-audio') {
          pendingScreenAudioByPeer.current.set(item.peerId, item.producerId);
        }
      }
      for (const item of existing) {
        if (item.appData?.type === 'screen') {
          storeAvailableScreen({
            socketId: item.peerId,
            videoProducerId: item.producerId,
            audioProducerId: pendingScreenAudioByPeer.current.get(item.peerId),
          });
          continue;
        }
        if (item.appData?.type === 'screen-audio') continue;
        await consumeProducer(item.producerId, item.peerId, item.kind, item.appData);
      }
      setConnectionState('connected');
    } catch (cause) {
      teardown(false);
      setConnectionState('failed');
      setError(cause instanceof Error ? `加入语音失败：${cause.message}` : '加入语音失败');
    } finally {
      setJoining(false);
    }
  }, [consumeProducer, joining, roomId, setupDevice, socket, storeAvailableScreen, teardown]);

  const leaveVoice = useCallback(() => {
    teardown(true);
    setError(null);
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const producer = audioProducer.current;
    if (!producer || forceMutedRef.current) return;
    selfMutedRef.current = !selfMutedRef.current;
    if (selfMutedRef.current) producer.pause();
    else producer.resume();
    setIsMuted(selfMutedRef.current);
    socket.emit('voice:mute-state', { roomId, muted: selfMutedRef.current });
  }, [roomId, socket]);

  return {
    inVoice,
    joining,
    isMuted,
    isForceMuted,
    voiceMembers,
    remoteScreen,
    availableScreens,
    applicationAudioShares,
    setApplicationAudioVolume,
    watchingScreenPeerId: watchingScreenPeerRef.current,
    isWatchingScreen,
    screenReceiveVolume,
    connectionState,
    error,
    joinVoice,
    leaveVoice,
    toggleMute,
    watchScreen,
    stopWatchingScreen,
    setScreenReceiveVolume,
    clearError: () => setError(null),
  };
}
