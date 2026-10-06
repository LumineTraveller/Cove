import { useCallback } from 'react';

import type { Socket } from 'socket.io-client';

import { MediaStream, mediaDevices } from 'react-native-webrtc';

import { startVoiceAudioSession } from '../audio/voiceAudioSession';

import {
  applyNoiseMode,
  createMicrophoneConstraints,
  getNoiseStatus,
  type MicrophoneNoiseMode,
} from '../microphone/microphoneNoise';
import {
  DEFAULT_OUTPUT_ID,
  setAudioInputDevice,
  setAudioOutputDevice,
  type AudioDeviceList,
} from '../audio/audioDevices';
import {
  Transport,
  Producer,
  AvailableScreen,
  CoveNative,
  ConnectionState,
  emitAsync,
  requestMicrophonePermission,
} from '../mobileMediaSupport';

export interface UseVoiceJoinDependencies {
  readonly inVoiceRef: import('react').RefObject<boolean>;
  readonly joiningRef: import('react').RefObject<boolean>;
  readonly socket: Socket<
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap,
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap
  >;
  readonly mediaGeneration: import('react').RefObject<number>;
  readonly voiceSocketId: import('react').RefObject<string | undefined>;
  readonly setJoining: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly setConnectionState: import('react').Dispatch<
    import('react').SetStateAction<ConnectionState>
  >;
  readonly setError: import('react').Dispatch<
    import('react').SetStateAction<string | null>
  >;
  readonly noiseModeRef: import('react').RefObject<MicrophoneNoiseMode>;
  readonly microphoneStream: import('react').RefObject<MediaStream | null>;
  readonly setupDevice: () => Promise<void>;
  readonly sendTransport: import('react').RefObject<Transport | null>;
  readonly audioProducer: import('react').RefObject<Producer | null>;
  readonly forceMutedRef: import('react').RefObject<boolean>;
  readonly setNoiseMode: import('react').Dispatch<
    import('react').SetStateAction<MicrophoneNoiseMode>
  >;
  readonly setNoiseError: import('react').Dispatch<
    import('react').SetStateAction<string | null>
  >;
  readonly audioInputIdRef: import('react').RefObject<string>;
  readonly audioOutputIdRef: import('react').RefObject<string>;
  readonly refreshAudioDevices: () => Promise<AudioDeviceList | null>;
  readonly setInVoice: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly setIsMuted: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly roomId: string;
  readonly pendingScreenAudioByPeer: import('react').RefObject<
    Map<string, string>
  >;
  readonly storeAvailableScreen: (screen: AvailableScreen) => void;
  readonly consumeProducer: (
    producerId: string,
    peerId: string,
    kind: string,
    appData?: Record<string, unknown>,
  ) => Promise<boolean>;
  readonly teardown: (notifyServer: boolean) => void;
}

export function useVoiceJoin(deps: UseVoiceJoinDependencies) {
  const {
    inVoiceRef,
    joiningRef,
    socket,
    mediaGeneration,
    voiceSocketId,
    setJoining,
    setConnectionState,
    setError,
    noiseModeRef,
    microphoneStream,
    setupDevice,
    sendTransport,
    audioProducer,
    forceMutedRef,
    setNoiseMode,
    setNoiseError,
    audioInputIdRef,
    audioOutputIdRef,
    refreshAudioDevices,
    setInVoice,
    setIsMuted,
    roomId,
    pendingScreenAudioByPeer,
    storeAvailableScreen,
    consumeProducer,
    teardown,
  } = deps;

  const joinVoice = useCallback(async () => {
    if (inVoiceRef.current || joiningRef.current || !socket.connected) return;
    const generation = ++mediaGeneration.current;
    const ensureCurrent = () => {
      if (generation !== mediaGeneration.current)
        throw new Error('语音加入已取消');
    };
    voiceSocketId.current = socket.id;
    joiningRef.current = true;
    setJoining(true);
    setConnectionState('connecting');
    setError(null);

    try {
      if (!(await requestMicrophonePermission())) {
        throw new Error('未获得麦克风权限');
      }
      ensureCurrent();
      // Android 14+ 要求麦克风前台服务必须在可见 Activity 内启动。
      CoveNative?.startVoiceService();
      const requestedNoise = noiseModeRef.current;
      let appliedNoise;
      try {
        appliedNoise = await applyNoiseMode(requestedNoise);
      } catch {
        // 原生切换失败时退回系统降噪，不能把未降噪的音轨当成功发出。
        appliedNoise = await applyNoiseMode('system').catch(() => ({
          mode: 'system' as MicrophoneNoiseMode,
          effectiveMode: 'system' as MicrophoneNoiseMode,
          rnnoiseReady: false,
          interceptorActive: false,
          processing: false,
          systemNoiseSuppressorEnabled: false,
        }));
      }
      ensureCurrent();
      const stream = await mediaDevices.getUserMedia({
        audio: createMicrophoneConstraints(appliedNoise.mode),
        video: false,
      } as never);
      if (generation !== mediaGeneration.current) {
        stream.release(true);
        ensureCurrent();
      }
      microphoneStream.current = stream;
      await setupDevice();
      ensureCurrent();
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('没有可用的麦克风音轨');

      const producer = await sendTransport.current!.produce({
        track: track as never,
        streamId: `mic-${socket.id}`,
        codecOptions: { opusStereo: false, opusDtx: true, opusFec: true },
        appData: { type: 'mic', client: 'android' },
      });
      if (generation !== mediaGeneration.current) {
        producer.close();
        ensureCurrent();
      }
      audioProducer.current = producer;
      if (forceMutedRef.current) producer.pause();

      appliedNoise = await getNoiseStatus();
      noiseModeRef.current = appliedNoise.effectiveMode;
      setNoiseMode(appliedNoise.effectiveMode);
      setNoiseError(
        appliedNoise.error ??
          (requestedNoise !== appliedNoise.effectiveMode
            ? 'RNNoise 未能启用，已使用系统降噪'
            : null),
      );

      startVoiceAudioSession();
      try {
        if (audioInputIdRef.current && audioInputIdRef.current !== 'default') {
          await setAudioInputDevice(audioInputIdRef.current);
        }
        await setAudioOutputDevice(
          audioOutputIdRef.current || DEFAULT_OUTPUT_ID,
        );
      } catch {
        // 路由失败不阻断入会；系统会按默认设备出声。
      }
      void refreshAudioDevices();
      inVoiceRef.current = true;
      setInVoice(true);
      setIsMuted(forceMutedRef.current);
      socket.emit('voice:join', roomId);

      const existing = await emitAsync<
        {
          producerId: string;
          peerId: string;
          kind: string;
          appData: Record<string, unknown>;
        }[]
      >(socket, 'ms:get-producers');
      ensureCurrent();
      for (const item of existing) {
        if (item.appData?.type === 'screen-audio') {
          pendingScreenAudioByPeer.current.set(item.peerId, item.producerId);
        }
      }
      for (const item of existing) {
        if (item.appData?.type === 'screen') {
          ensureCurrent();
          storeAvailableScreen({
            socketId: item.peerId,
            videoProducerId: item.producerId,
            audioProducerId: pendingScreenAudioByPeer.current.get(item.peerId),
          });
          continue;
        }
        if (item.appData?.type === 'screen-audio') continue;
        ensureCurrent();
        await consumeProducer(
          item.producerId,
          item.peerId,
          item.kind,
          item.appData,
        );
      }
      ensureCurrent();
      setConnectionState('connected');
    } catch (cause) {
      if (generation !== mediaGeneration.current) return;
      teardown(true);
      setConnectionState('failed');
      setError(
        cause instanceof Error
          ? `加入语音失败：${cause.message}`
          : '加入语音失败',
      );
    } finally {
      if (generation === mediaGeneration.current) {
        joiningRef.current = false;
        setJoining(false);
      }
    }
  }, [
    audioInputIdRef,
    audioOutputIdRef,
    audioProducer,
    consumeProducer,
    forceMutedRef,
    inVoiceRef,
    joiningRef,
    mediaGeneration,
    microphoneStream,
    noiseModeRef,
    pendingScreenAudioByPeer,
    refreshAudioDevices,
    roomId,
    sendTransport,
    setConnectionState,
    setError,
    setInVoice,
    setIsMuted,
    setJoining,
    setNoiseError,
    setNoiseMode,
    setupDevice,
    socket,
    storeAvailableScreen,
    teardown,
    voiceSocketId,
  ]);
  return { joinVoice };
}
