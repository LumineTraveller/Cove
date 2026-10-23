import { useCallback, useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Socket } from 'socket.io-client';
import { createMediaConnectionRecovery, createTransportIceRecovery, shouldRetainMediaOnSignalTimeout,
  type TransportIceRecovery, type IceRecoveryRegistration } from '@cove/client-core';
import type { DisconnectGrace } from '../../connection/disconnectGrace';
import type { ConnectionState, Transport } from '../mobileMediaSupport';

interface MediaConnectionRecoveryDependencies {
  socket: Socket;
  roomId: string;
  connectionGrace: RefObject<DisconnectGrace>;
  iceRecovery: RefObject<TransportIceRecovery | null>;
  recoveryDiagnostics?: RefObject<import('@cove/client-core').RecoveryDiagnostics>;
  mediaSocketId: RefObject<string | undefined>;
  inVoiceRef: RefObject<boolean>;
  joiningRef: RefObject<boolean>;
  watchingScreenPeerRef: RefObject<string | null>;
  watchingGeneration: RefObject<number | null>;
  mediaGeneration: RefObject<number>;
  sendTransport: RefObject<Transport | null>;
  recvTransport: RefObject<Transport | null>;
  teardown: (notifyServer: boolean) => void;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

/** Socket and media deadlines are independent of native/RTP resource cleanup. */
export function useMediaConnectionRecovery({
  socket, roomId, connectionGrace, iceRecovery, recoveryDiagnostics, mediaSocketId, inVoiceRef, joiningRef, watchingScreenPeerRef, watchingGeneration, mediaGeneration,
  sendTransport, recvTransport, teardown, setConnectionState, setError,
}: MediaConnectionRecoveryDependencies) {
  useEffect(() => {
    const transportRecovery: TransportIceRecovery = createTransportIceRecovery({
      roomId, signal: socket,
      onEvent: (event, detail) => {
        recoveryDiagnostics?.current.record(event, detail);
        if (event === 'ice-restart-connected' && !transportRecovery.isRecovering() &&
            socket.connected && (inVoiceRef.current || watchingScreenPeerRef.current !== null))
          setConnectionState('connected');
      },
    });
    iceRecovery.current = transportRecovery;
    const recovery = createMediaConnectionRecovery({
      transportRecovery,
      grace: connectionGrace.current,
      readState: () => ({
        recovered: socket.recovered,
        socketId: socket.id,
        mediaSocketId: mediaSocketId.current,
        active: inVoiceRef.current || recvTransport.current !== null,
        pending: joiningRef.current || watchingGeneration.current === mediaGeneration.current,
        established: inVoiceRef.current || watchingScreenPeerRef.current !== null,
        sendState: sendTransport.current?.connectionState ?? null,
        recvState: recvTransport.current?.connectionState ?? null,
      }),
      retainOnSignalTimeout: shouldRetainMediaOnSignalTimeout,
      onEvent: (event, reason) => recoveryDiagnostics?.current.record(event, reason),
      resetMedia: () => teardown(false),
      leaveRecoveredSession: () => { socket.emit('voice:leave', roomId); },
      onSignalLost: () => setConnectionState('connecting'),
      onRecovered: state => {
        if (state.established)
          setConnectionState(transportRecovery.isRecovering() ? 'connecting' : 'connected');
      },
      onSignalTimeout: () => setError('服务器连接中断超过 7.5 秒，连接恢复后可直接加入语音'),
    });
    socket.on('disconnect', recovery.onDisconnect);
    socket.on('connect', recovery.onConnect);
    return () => {
      socket.off('disconnect', recovery.onDisconnect);
      socket.off('connect', recovery.onConnect);
      recovery.dispose();
      transportRecovery.dispose();
      if (iceRecovery.current === transportRecovery) iceRecovery.current = null;
    };
  }, [socket, roomId, connectionGrace, iceRecovery, recoveryDiagnostics, mediaSocketId, inVoiceRef, joiningRef,
    watchingScreenPeerRef, watchingGeneration, mediaGeneration,
    sendTransport, recvTransport, teardown, setConnectionState, setError]);

  const checkTransport = useCallback(
    (key: string, state: string,
      context?: Pick<IceRecoveryRegistration, 'transport' | 'capability' | 'ownerSocketId' | 'isCurrent'>) => {
      const transportRecovery = iceRecovery.current;
      if (context && transportRecovery?.observe({
        ...context, key,
        isActive: () => inVoiceRef.current || watchingScreenPeerRef.current !== null,
        onFailure: () => {
          teardown(true);
          setConnectionState('failed');
          setError('媒体连接恢复失败，可重新加入语音。');
        },
      }, state)) {
        connectionGrace.current.recover(key);
        if (state === 'connected')
          setConnectionState(transportRecovery.isRecovering() ? 'connecting' : 'connected');
        else if (state === 'failed' || state === 'disconnected' || state === 'connecting')
          setConnectionState('connecting');
        return;
      }
      if (state === 'connecting') setConnectionState('connecting');
      if (state === 'connected') {
        connectionGrace.current.recover(key);
        recoveryDiagnostics?.current.record('legacy-transport-connected', { key });
        setConnectionState(transportRecovery?.isRecovering() ? 'connecting' : 'connected');
      }
      if (state === 'failed' || state === 'disconnected') {
        recoveryDiagnostics?.current.record('legacy-transport-failed', { key,
          reason: state === 'failed' ? 'STATE_FAILED' : 'STATE_DISCONNECTED' });
        setConnectionState('connecting');
        connectionGrace.current.fail(key, () => {
          recoveryDiagnostics?.current.record('legacy-transport-fallback', { key, reason: 'MEDIA_TIMEOUT' });
          teardown(true);
          setConnectionState('failed');
          setError(
            '媒体连接中断超过 7.5 秒，可直接重新加入语音，无需重连服务器',
          );
        });
      }
    },
    [connectionGrace, iceRecovery, recoveryDiagnostics, inVoiceRef, watchingScreenPeerRef, setConnectionState, setError, teardown],
  );
  return { checkTransport };
}
