import { useCallback } from 'react';

import type { Socket } from 'socket.io-client';
import { Device } from 'mediasoup-client';
import InCallManager from 'react-native-incall-manager';
import { MediaStream } from 'react-native-webrtc';
import type { VoiceMember } from '../../../types';

import { DisconnectGrace } from '../../connection/disconnectGrace';

import {
  Transport,
  Producer,
  Consumer,
  RemoteScreen,
  ApplicationAudioShare,
  CoveNative,
  ConnectionState,
} from '../mobileMediaSupport';

export interface UseVoiceTeardownDependencies {
  readonly stopScreenShare: () => void;
  readonly mediaGeneration: import('react').RefObject<number>;
  readonly joiningRef: import('react').RefObject<boolean>;
  readonly connectionGrace: import('react').RefObject<DisconnectGrace>;
  readonly socket: Socket<
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap,
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap
  >;
  readonly roomId: string;
  readonly audioProducer: import('react').RefObject<Producer | null>;
  readonly sendTransport: import('react').RefObject<Transport | null>;
  readonly recvTransport: import('react').RefObject<Transport | null>;
  readonly deviceRef: import('react').RefObject<Device | null>;
  readonly microphoneStream: import('react').RefObject<MediaStream | null>;
  readonly consumers: import('react').RefObject<
    Map<
      string,
      {
        consumer: Consumer;
        producerId: string;
        socketId: string;
        kind: string;
        stream: MediaStream;
        sourceType?: string;
      }
    >
  >;
  readonly consumerByProducer: import('react').RefObject<Map<string, string>>;
  readonly pendingProducers: import('react').RefObject<Set<string>>;
  readonly closedProducers: import('react').RefObject<Set<string>>;
  readonly applicationAudioVolumes: import('react').RefObject<
    Map<string, number>
  >;
  readonly setApplicationAudioShares: import('react').Dispatch<
    import('react').SetStateAction<ApplicationAudioShare[]>
  >;
  readonly pendingScreenAudioByPeer: import('react').RefObject<
    Map<string, string>
  >;
  readonly inVoiceRef: import('react').RefObject<boolean>;
  readonly selfMutedRef: import('react').RefObject<boolean>;
  readonly setInVoice: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly setJoining: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly setIsMuted: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly forceMutedRef: import('react').RefObject<boolean>;
  readonly setVoiceMembers: import('react').Dispatch<
    import('react').SetStateAction<VoiceMember[]>
  >;
  readonly setRemoteScreen: import('react').Dispatch<
    import('react').SetStateAction<RemoteScreen | null>
  >;
  readonly clearAvailableScreens: () => void;
  readonly watchingScreenPeerRef: import('react').RefObject<string | null>;
  readonly setIsWatchingScreen: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly setConnectionState: import('react').Dispatch<
    import('react').SetStateAction<ConnectionState>
  >;
  readonly setError: import('react').Dispatch<
    import('react').SetStateAction<string | null>
  >;
}

export function useVoiceTeardown(deps: UseVoiceTeardownDependencies) {
  const {
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
  } = deps;

  const teardown = useCallback(
    (notifyServer: boolean) => {
      stopScreenShare();
      mediaGeneration.current += 1;
      joiningRef.current = false;
      connectionGrace.current.clear();
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
    },
    [
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
    ],
  );

  const checkTransport = useCallback(
    (key: string, state: string) => {
      if (state === 'connected') connectionGrace.current.recover(key);
      if (state === 'failed' || state === 'disconnected') {
        setConnectionState('connecting');
        connectionGrace.current.fail(key, () => {
          teardown(true);
          setConnectionState('failed');
          setError(
            '媒体连接中断超过 7.5 秒，可直接重新加入语音，无需重连服务器',
          );
        });
      }
    },
    [connectionGrace, setConnectionState, setError, teardown],
  );
  return { teardown, checkTransport };
}
