import { useAvailableScreens } from './screen/useAvailableScreens';
import { useVoiceTeardown } from './voice/useVoiceTeardown';
import { useMediaTransports } from './transport/useMediaTransports';
import { useScreenViewing } from './screen/useScreenViewing';
import { useVolumeControls } from './audio/useVolumeControls';
import { useAudioDevices } from './audio/useAudioDevices';
import { useVoiceJoin } from './voice/useVoiceJoin';
import { useMicrophoneControls } from './microphone/useMicrophoneControls';
import {
  Transport,
  Producer,
  Consumer,
  RemoteScreen,
  AvailableScreen,
  ApplicationAudioShare,
  CoveNative,
  ConnectionState,
} from './mobileMediaSupport';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Socket } from 'socket.io-client';
import { Device } from 'mediasoup-client';

import { MediaStream } from 'react-native-webrtc';
import type { VoiceMember } from '../../types';

import { DisconnectGrace } from '../connection/disconnectGrace';
import { useMobileScreenShare } from './screen/useMobileScreenShare';
import {
  DEFAULT_NOISE_MODE,
  getNoiseStatus,
  type MicrophoneNoiseMode,
} from './microphone/microphoneNoise';
import {
  DEFAULT_OUTPUT_ID,
  type AudioDeviceOption,
} from './audio/audioDevices';

export function useMobileMedia(socket: Socket, roomId: string) {
  const [inVoice, setInVoice] = useState(false);
  const [joining, setJoining] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isForceMuted, setIsForceMuted] = useState(false);
  const [voiceMembers, setVoiceMembers] = useState<VoiceMember[]>([]);
  const [remoteScreen, setRemoteScreen] = useState<RemoteScreen | null>(null);
  const [availableScreens, setAvailableScreens] = useState<AvailableScreen[]>(
    [],
  );
  const [applicationAudioShares, setApplicationAudioShares] = useState<
    ApplicationAudioShare[]
  >([]);
  const [memberVolumes, setMemberVolumes] = useState<Record<string, number>>(
    {},
  );
  const [isWatchingScreen, setIsWatchingScreen] = useState(false);
  const [screenReceiveVolume, setScreenReceiveVolumeState] = useState(1);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [noiseMode, setNoiseMode] =
    useState<MicrophoneNoiseMode>(DEFAULT_NOISE_MODE);
  const [noiseSwitching, setNoiseSwitching] = useState(false);
  const [noiseError, setNoiseError] = useState<string | null>(null);
  const [audioInputs, setAudioInputs] = useState<AudioDeviceOption[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<AudioDeviceOption[]>([]);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState('default');
  const [selectedAudioOutputId, setSelectedAudioOutputId] =
    useState(DEFAULT_OUTPUT_ID);
  const [audioDeviceSwitching, setAudioDeviceSwitching] = useState(false);
  const [audioDeviceError, setAudioDeviceError] = useState<string | null>(null);

  const deviceRef = useRef<Device | null>(null);
  const sendTransport = useRef<Transport | null>(null);
  const recvTransport = useRef<Transport | null>(null);
  const audioProducer = useRef<Producer | null>(null);
  const microphoneStream = useRef<MediaStream | null>(null);
  const consumers = useRef(
    new Map<
      string,
      {
        consumer: Consumer;
        producerId: string;
        socketId: string;
        kind: string;
        stream: MediaStream;
        sourceType?: string;
      }
    >(),
  );
  const consumerByProducer = useRef(new Map<string, string>());
  const pendingProducers = useRef(new Set<string>());
  const closedProducers = useRef(new Set<string>());
  const mediaGeneration = useRef(0);
  const joiningRef = useRef(false);
  const voiceSocketId = useRef<string | undefined>(undefined);
  const connectionGrace = useRef(new DisconnectGrace());
  const applicationAudioVolumes = useRef(new Map<string, number>());
  const memberVolumesRef = useRef(new Map<string, number>());
  const inVoiceRef = useRef(false);
  const selfMutedRef = useRef(false);
  const forceMutedRef = useRef(false);
  const noiseModeRef = useRef<MicrophoneNoiseMode>(DEFAULT_NOISE_MODE);
  const noiseBusyRef = useRef(false);
  const audioInputIdRef = useRef('default');
  const audioOutputIdRef = useRef(DEFAULT_OUTPUT_ID);
  const audioDeviceBusyRef = useRef(false);
  const availableScreensRef = useRef(new Map<string, AvailableScreen>());
  const pendingScreenAudioByPeer = useRef(new Map<string, string>());
  const watchingScreenPeerRef = useRef<string | null>(null);
  const screenReceiveVolumeRef = useRef(1);
  const screenShare = useMobileScreenShare(socket, deviceRef, inVoiceRef);
  const stopScreenShare = screenShare.stopScreenShare;
  const { storeAvailableScreen, removeAvailableScreen, clearAvailableScreens } =
    useAvailableScreens({
      setAvailableScreens,
      availableScreensRef,
    });
  const { teardown, checkTransport } = useVoiceTeardown({
    stopScreenShare,
    mediaGeneration,
    joiningRef,
    connectionGrace,
    socket,
    roomId,
    audioProducer,
    sendTransport,
    recvTransport,
    deviceRef,
    microphoneStream,
    consumers,
    consumerByProducer,
    pendingProducers,
    closedProducers,
    applicationAudioVolumes,
    setApplicationAudioShares,
    pendingScreenAudioByPeer,
    inVoiceRef,
    selfMutedRef,
    setInVoice,
    setJoining,
    setIsMuted,
    forceMutedRef,
    setVoiceMembers,
    setRemoteScreen,
    clearAvailableScreens,
    watchingScreenPeerRef,
    setIsWatchingScreen,
    setConnectionState,
    setError,
  });
  const { setupDevice, removeConsumer, consumeProducer } = useMediaTransports({
    deviceRef,
    sendTransport,
    recvTransport,
    mediaGeneration,
    socket,
    checkTransport,
    setConnectionState,
    consumers,
    consumerByProducer,
    applicationAudioVolumes,
    setApplicationAudioShares,
    setRemoteScreen,
    inVoiceRef,
    closedProducers,
    pendingProducers,
    screenReceiveVolumeRef,
    memberVolumesRef,
    setError,
  });
  const { stopWatchingScreen, watchScreen, captureWatchGuard } = useScreenViewing({
    watchingScreenPeerRef,
    consumers,
    removeConsumer,
    setIsWatchingScreen,
    setRemoteScreen,
    availableScreensRef,
    consumeProducer,
  });
  const { setScreenReceiveVolume, setApplicationAudioVolume, setMemberVolume } =
    useVolumeControls({
      screenReceiveVolumeRef,
      setScreenReceiveVolumeState,
      consumers,
      consumerByProducer,
      applicationAudioVolumes,
      setApplicationAudioShares,
      memberVolumesRef,
      setMemberVolumes,
    });

  useEffect(() => {
    const onVoiceMembers = (members: VoiceMember[]) => setVoiceMembers(members);
    const onNewProducer = async ({
      producerId,
      peerId,
      kind,
      appData,
    }: {
      producerId: string;
      peerId: string;
      kind: string;
      appData: Record<string, unknown>;
    }) => {
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
        if (current)
          storeAvailableScreen({ ...current, audioProducerId: producerId });
        if (watchingScreenPeerRef.current === peerId) {
          await consumeProducer(producerId, peerId, kind, appData, captureWatchGuard(peerId));
        }
        return;
      }
      await consumeProducer(producerId, peerId, kind, appData);
    };
    const onConsumerClosed = ({ consumerId }: { consumerId: string }) =>
      removeConsumer(consumerId);
    const onProducerClosed = ({
      producerId,
      peerId,
      sourceType,
    }: {
      producerId: string;
      peerId: string;
      sourceType: string;
    }) => {
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
    const onForcedMute = ({
      roomId: targetRoomId,
      muted,
    }: {
      roomId: string;
      muted: boolean;
    }) => {
      if (targetRoomId !== roomId) return;
      forceMutedRef.current = muted;
      setIsForceMuted(muted);
      if (muted) audioProducer.current?.pause();
      else if (!selfMutedRef.current) audioProducer.current?.resume();
      setIsMuted(muted || selfMutedRef.current);
    };
    const onDisconnect = (reason: string) => {
      if (
        reason === 'io client disconnect' ||
        reason === 'io server disconnect'
      ) {
        teardown(false);
        return;
      }
      if (!inVoiceRef.current && !joiningRef.current) return;
      setConnectionState('connecting');
      connectionGrace.current.fail('signal', () => {
        teardown(false);
        setError('服务器连接中断超过 7.5 秒，连接恢复后可直接加入语音');
      });
    };
    const onConnect = () => {
      connectionGrace.current.recover('signal');
      if (voiceSocketId.current !== socket.id || !socket.recovered) {
        if (inVoiceRef.current || joiningRef.current) teardown(false);
      } else if (!inVoiceRef.current && !joiningRef.current) {
        socket.emit('voice:leave', roomId);
      } else if (inVoiceRef.current) {
        setConnectionState('connected');
      }
    };

    socket.on('voice:members-updated', onVoiceMembers);
    socket.on('ms:new-producer', onNewProducer);
    socket.on('ms:consumer-closed', onConsumerClosed);
    socket.on('ms:producer-closed', onProducerClosed);
    socket.on('voice:presence', onVoicePresence);
    socket.on('voice:user-left', onUserLeft);
    socket.on('room:force-muted', onForcedMute);
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);
    return () => {
      socket.off('voice:members-updated', onVoiceMembers);
      socket.off('ms:new-producer', onNewProducer);
      socket.off('ms:consumer-closed', onConsumerClosed);
      socket.off('ms:producer-closed', onProducerClosed);
      socket.off('voice:presence', onVoicePresence);
      socket.off('voice:user-left', onUserLeft);
      socket.off('room:force-muted', onForcedMute);
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
    };
  }, [
    consumeProducer,
    captureWatchGuard,
    removeConsumer,
    roomId,
    socket,
    stopWatchingScreen,
    storeAvailableScreen,
    removeAvailableScreen,
    teardown,
  ]);

  useEffect(() => () => teardown(false), [teardown]);
  const { refreshAudioDevices, selectAudioInput, selectAudioOutput } =
    useAudioDevices({
      setAudioInputs,
      setAudioOutputs,
      audioInputIdRef,
      audioOutputIdRef,
      setSelectedAudioInputId,
      setSelectedAudioOutputId,
      setAudioDeviceError,
      audioDeviceBusyRef,
      setAudioDeviceSwitching,
    });
  const { joinVoice } = useVoiceJoin({
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
  });
  const { selectNoiseMode } = useMicrophoneControls({
    audioProducer,
    mediaGeneration,
    noiseModeRef,
    microphoneStream,
    selfMutedRef,
    forceMutedRef,
    setNoiseMode,
    setNoiseError,
    noiseBusyRef,
    joiningRef,
    setNoiseSwitching,
  });

  useEffect(() => {
    if (!inVoice || noiseMode !== 'rnnoise') return;
    let cancelled = false;
    const generation = mediaGeneration.current;
    const timer = setInterval(() => {
      void getNoiseStatus()
        .then(async status => {
          if (
            cancelled ||
            generation !== mediaGeneration.current ||
            !status.error ||
            noiseBusyRef.current
          )
            return;
          await selectNoiseMode('system');
          if (generation === mediaGeneration.current) {
            setNoiseError(
              noiseModeRef.current === 'system'
                ? `RNNoise 异常，已回退系统降噪：${status.error}`
                : `RNNoise 异常，回退失败，请切换系统降噪：${status.error}`,
            );
          }
        })
        .catch(() => {
          /* Status query failures must not disconnect voice. */
        });
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [inVoice, noiseMode, selectNoiseMode]);

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
    ...screenShare,
    inVoice,
    joining,
    isMuted,
    isForceMuted,
    voiceMembers,
    remoteScreen,
    availableScreens,
    applicationAudioShares,
    setApplicationAudioVolume,
    memberVolumes,
    setMemberVolume,
    watchingScreenPeerId: watchingScreenPeerRef.current,
    isWatchingScreen,
    screenReceiveVolume,
    connectionState,
    error,
    noiseMode,
    noiseSwitching,
    noiseError,
    selectNoiseMode,
    audioInputs,
    audioOutputs,
    selectedAudioInputId,
    selectedAudioOutputId,
    audioDeviceSwitching,
    audioDeviceError,
    refreshAudioDevices,
    selectAudioInput,
    selectAudioOutput,
    joinVoice,
    leaveVoice,
    toggleMute,
    watchScreen,
    stopWatchingScreen,
    setScreenReceiveVolume,
    clearError: () => setError(null),
  };
}

export type { ApplicationAudioShare } from './mobileMediaSupport';
