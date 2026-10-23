import { useAvailableScreens } from './screen/useAvailableScreens';
import { useMediaConnectionRecovery } from './voice/useMediaConnectionRecovery';
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
import { createRecoveryDiagnostics, request, screenAudioMatchesPublication, screenPublicationMetadata, type TransportIceRecovery } from '@cove/client-core';

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

export function useMobileMedia(
  socket: Socket,
  roomId: string,
  roomReady = true,
) {
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
  // Voice/watch operations may reuse transports; only resource teardown
  // invalidates the transport owner's generation.
  const transportGeneration = useRef(0);
  const joiningRef = useRef(false);
  const mediaSocketId = useRef<string | undefined>(undefined);
  const voiceAudioSessionActive = useRef(false);
  const watchingGeneration = useRef<number | null>(null);
  const [screenWatchingBusy, setScreenWatchingBusy] = useState(false);
  const cancelPendingWatch = useCallback(() => {
    watchingGeneration.current = null;
    setScreenWatchingBusy(false);
  }, []);
  const connectionGrace = useRef(new DisconnectGrace());
  const iceRecovery = useRef<TransportIceRecovery | null>(null);
  const recoveryDiagnostics = useRef(createRecoveryDiagnostics());
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
  const screenShare = useMobileScreenShare(socket, deviceRef, inVoiceRef, iceRecovery);
  const stopScreenShare = screenShare.stopScreenShare;
  const { storeAvailableScreen, removeAvailableScreen, clearAvailableScreens } =
    useAvailableScreens({
      setAvailableScreens,
      availableScreensRef,
    });
  const { teardown } = useVoiceTeardown({
    stopScreenShare,
    mediaGeneration,
    transportGeneration,
    joiningRef,
    connectionGrace,
    iceRecovery,
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
    voiceAudioSessionActive,
    cancelPendingWatch,
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
  });
  const { checkTransport } = useMediaConnectionRecovery({
    socket, roomId, connectionGrace, iceRecovery, recoveryDiagnostics, mediaSocketId, inVoiceRef, joiningRef, watchingScreenPeerRef, watchingGeneration, mediaGeneration,
    sendTransport, recvTransport, teardown, setConnectionState, setError,
  });
  const { setupDevice, removeConsumer, consumeProducer } = useMediaTransports({
    deviceRef,
    sendTransport,
    recvTransport,
    mediaGeneration,
    transportGeneration,
    socket,
    checkTransport,
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
  const retireIdleWatchTransports = useCallback(() => {
    const recovering = iceRecovery.current?.isRecovering() === true;
    cancelPendingWatch();
    // A stopped viewer must not hand an in-flight ICE credential rotation
    // to a later manual watch. Voice still owns the shared transports.
    if (recovering && !inVoiceRef.current && !joiningRef.current)
      teardown(true, { preserveAvailableScreens: true });
  }, [cancelPendingWatch, teardown]);
  const {
    stopWatchingScreen,
    watchScreen: consumeScreen,
    captureWatchGuard,
    screenPublicationAvailable,
    screenPublicationClosed,
  } = useScreenViewing({
    watchingScreenPeerRef,
    consumers,
    removeConsumer,
    setIsWatchingScreen,
    setRemoteScreen,
    availableScreensRef,
    consumeProducer,
    onBeforeStop: retireIdleWatchTransports,
  });
  const stopWatchingScreenExplicitly = useCallback(() => {
    stopWatchingScreen();
  }, [stopWatchingScreen]);
  const watchScreen = useCallback(
    async (socketId?: string) => {
      if (!roomReady || !socket.connected || watchingGeneration.current === mediaGeneration.current) return;
      const generation = mediaGeneration.current;
      mediaSocketId.current = socket.id;
      watchingGeneration.current = generation;
      setScreenWatchingBusy(true);
      try {
        // Creating RTP transports does not open a microphone or screen capture.
        await setupDevice();
        if (generation !== mediaGeneration.current || !socket.connected) return;
        await consumeScreen(socketId);
      } catch (cause) {
        if (generation === mediaGeneration.current)
          setError(cause instanceof Error ? cause.message : '无法观看共享屏幕');
      } finally {
        if (watchingGeneration.current === generation) {
          watchingGeneration.current = null;
          setScreenWatchingBusy(false);
        }
      }
    },
    [consumeScreen, roomReady, setupDevice, socket],
  );

  useEffect(() => {
    if (!roomReady || !socket.connected) return;
    let current = true;
    const generation = mediaGeneration.current;
    socket.emit(
      'ms:get-producers',
      (
        existing?: {
          producerId: string;
          peerId: string;
          kind: string;
          appData?: Record<string, unknown>;
        }[],
      ) => {
        if (
          !current ||
          generation !== mediaGeneration.current ||
          !Array.isArray(existing)
        )
          return;
        for (const item of existing) {
          if (item.appData?.type === 'screen-audio')
            pendingScreenAudioByPeer.current.set(item.peerId, item.producerId);
        }
        for (const item of existing) {
          if (item.appData?.type === 'screen')
            storeAvailableScreen({
              socketId: item.peerId,
              videoProducerId: item.producerId,
              audioProducerId: pendingScreenAudioByPeer.current.get(
                item.peerId,
              ),
              ...screenPublicationMetadata(item.appData),
            });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [roomReady, socket, storeAvailableScreen]);
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
      if (appData?.type === 'screen') {
        const metadata = screenPublicationMetadata(appData);
        const source = {
          socketId: peerId,
          videoProducerId: producerId,
          audioProducerId: metadata.shareSessionId ? undefined : pendingScreenAudioByPeer.current.get(peerId),
          ...metadata,
        };
        storeAvailableScreen(source);
        screenPublicationAvailable(source);
        return;
      }
      if (appData?.type === 'screen-audio') {
        const current = availableScreensRef.current.get(peerId);
        if (!screenAudioMatchesPublication(current, appData)) return;
        pendingScreenAudioByPeer.current.set(peerId, producerId);
        if (current)
          storeAvailableScreen({ ...current, audioProducerId: producerId });
        if (watchingScreenPeerRef.current === peerId) {
          await consumeProducer(
            producerId,
            peerId,
            kind,
            appData,
            captureWatchGuard(peerId),
          );
        }
        return;
      }
      if (!inVoiceRef.current) return;
      await consumeProducer(producerId, peerId, kind, appData);
    };
    const onConsumerClosed = ({ consumerId }: { consumerId: string }) =>
      removeConsumer(consumerId);
    const onProducerClosed = ({
      producerId,
      peerId,
      sourceType,
      shareSessionId,
      replacing,
    }: {
      producerId: string;
      peerId: string;
      sourceType: string;
      shareSessionId?: string;
      replacing?: boolean;
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
      if (watchingScreenPeerRef.current === peerId)
        screenPublicationClosed({ peerId, producerId, shareSessionId, replacing });
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
    socket.on('voice:members-updated', onVoiceMembers);
    socket.on('ms:new-producer', onNewProducer);
    socket.on('ms:consumer-closed', onConsumerClosed);
    socket.on('ms:producer-closed', onProducerClosed);
    socket.on('voice:presence', onVoicePresence);
    socket.on('voice:user-left', onUserLeft);
    socket.on('room:force-muted', onForcedMute);
    return () => {
      socket.off('voice:members-updated', onVoiceMembers);
      socket.off('ms:new-producer', onNewProducer);
      socket.off('ms:consumer-closed', onConsumerClosed);
      socket.off('ms:producer-closed', onProducerClosed);
      socket.off('voice:presence', onVoicePresence);
      socket.off('voice:user-left', onUserLeft);
      socket.off('room:force-muted', onForcedMute);
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
    screenPublicationAvailable,
    screenPublicationClosed,
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
    mediaSocketId,
    voiceAudioSessionActive,
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

  const collectScreenStats = screenShare.collectScreenStats;
  const collectScreenEncodingDiagnostics =
    screenShare.collectScreenEncodingDiagnostics;
  const isSharingScreen = screenShare.sharingScreen;
  const collectDiagnostics = useCallback(async () => {
    const getStats = async (transport: Transport | null) => {
      try {
        return (await transport?.getStats()) ?? new Map();
      } catch {
        return new Map();
      }
    };
    const [send, receive, screenSend, server] = await Promise.all([
      getStats(sendTransport.current),
      getStats(recvTransport.current),
      collectScreenStats().catch(() => new Map()),
      socket.connected
        ? request(
            socket,
            'ms:media-diagnostics',
            {},
            { timeoutMs: 4000 },
          ).catch(() => ({ unavailable: true }))
        : Promise.resolve({ unavailable: true }),
    ]);
    return {
      stage: {
        inVoice,
        watching: isWatchingScreen,
        sharing: isSharingScreen,
      },
      stats: { send, receive, screenSend },
      screenEncoder: collectScreenEncodingDiagnostics(),
      recovery: recoveryDiagnostics.current.snapshot(),
      server,
    };
  }, [
    inVoice,
    isWatchingScreen,
    isSharingScreen,
    collectScreenStats,
    collectScreenEncodingDiagnostics,
    socket,
  ]);

  return {
    collectDiagnostics,
    screenWatchingBusy,
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
    stopWatchingScreen: stopWatchingScreenExplicitly,
    setScreenReceiveVolume,
    clearError: () => setError(null),
  };
}

export type { ApplicationAudioShare } from './mobileMediaSupport';
