import { useCallback, useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Socket } from 'socket.io-client';
import { createMediaConnectionRecovery, shouldRetainMediaOnSignalTimeout } from '@cove/client-core';
import type { DisconnectGrace } from '../../connection/disconnectGrace';
import type { ConnectionState, Transport } from '../mobileMediaSupport';

interface MediaConnectionRecoveryDependencies {
  socket: Socket;
  roomId: string;
  connectionGrace: RefObject<DisconnectGrace>;
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
  socket, roomId, connectionGrace, mediaSocketId, inVoiceRef, joiningRef, watchingScreenPeerRef, watchingGeneration, mediaGeneration,
  sendTransport, recvTransport, teardown, setConnectionState, setError,
}: MediaConnectionRecoveryDependencies) {
  useEffect(() => {
    const recovery = createMediaConnectionRecovery({
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
      resetMedia: () => teardown(false),
      leaveRecoveredSession: () => { socket.emit('voice:leave', roomId); },
      onSignalLost: () => setConnectionState('connecting'),
      onRecovered: state => { if (state.established) setConnectionState('connected'); },
      onSignalTimeout: () => setError('服务器连接中断超过 7.5 秒，连接恢复后可直接加入语音'),
    });
    socket.on('disconnect', recovery.onDisconnect);
    socket.on('connect', recovery.onConnect);
    return () => {
      socket.off('disconnect', recovery.onDisconnect);
      socket.off('connect', recovery.onConnect);
      recovery.dispose();
    };
  }, [socket, roomId, connectionGrace, mediaSocketId, inVoiceRef, joiningRef,
    watchingScreenPeerRef, watchingGeneration, mediaGeneration,
    sendTransport, recvTransport, teardown, setConnectionState, setError]);

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
  return { checkTransport };
}
