import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { request } from '@cove/client-core';
import type { AnnotationAck, AnnotationState } from '@cove/contracts';

/** Read only the sharing policy used by remote control. Mobile has no drawing session. */
export function useRemoteControlPolicy(
  socket: Socket,
  roomId: string,
  sharerSocketId: string,
  sessionId: string | null,
  active: boolean,
) {
  const scope = `${roomId}:${sharerSocketId}:${sessionId}`;
  const [policy, setPolicy] = useState({ scope: '', allowed: false });
  useEffect(() => {
    let current = true;
    let revision = -1;
    let connection = 0;
    const accept = (state?: AnnotationState) => {
      if (
        !current ||
        !state ||
        state.roomId !== roomId ||
        state.sharerSocketId !== sharerSocketId ||
        state.sessionId !== sessionId ||
        state.revision < revision
      )
        return;
      revision = state.revision;
      setPolicy({ scope, allowed: state.remoteControlAllowed === true });
    };
    const disconnect = () => {
      connection++;
      revision = -1;
      setPolicy({ scope, allowed: false });
    };
    const load = async () => {
      disconnect();
      const generation = connection;
      try {
        const result = await request<AnnotationAck>(
          socket,
          'annotation:get',
          { target: { roomId, sharerSocketId, sessionId } },
          { timeoutMs: 5000 },
        );
        if (generation === connection && result?.ok) accept(result.state);
      } catch {
        /* A missing policy keeps remote input disabled. */
      }
    };
    if (active && sessionId && sharerSocketId) {
      socket.on('annotation:state', accept);
      socket.on('disconnect', disconnect);
      socket.on('connect', load);
      if (socket.connected) void load();
    }
    return () => {
      current = false;
      socket.off('annotation:state', accept);
      socket.off('disconnect', disconnect);
      socket.off('connect', load);
    };
  }, [socket, roomId, sharerSocketId, sessionId, active, scope]);
  return active && policy.scope === scope && policy.allowed;
}
