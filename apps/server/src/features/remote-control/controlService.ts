import { Server } from 'socket.io';

import {
  RemoteControlRegistry,
  type RemoteControlRequest,
  type RemoteControlSession,
} from './remoteControl';

export interface CreateControlServiceDependencies {
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly remoteControls: RemoteControlRegistry;
}

export function createControlService(deps: CreateControlServiceDependencies) {
  function emitRemoteControlStopped(session: RemoteControlSession, reason: string) {
    const payload = { sessionId: session.sessionId, reason };
    deps.io.to(session.controllerSocketId).emit('remote-control:stopped', payload);
    deps.io.to(session.sharerSocketId).emit('remote-control:stopped', payload);
  }

  function emitRemoteRequestCancelled(request: RemoteControlRequest, reason: string) {
    deps.io.to(request.controllerSocketId).emit('remote-control:request-result', {
      requestId: request.requestId,
      accepted: false,
      error: reason,
    });
    deps.io.to(request.sharerSocketId).emit('remote-control:request-cancelled', {
      requestId: request.requestId,
      reason,
    });
  }

  function stopRemoteControlForSocket(socketId: string, reason: string) {
    const cleared = deps.remoteControls.clearSocket(socketId);
    cleared.requests.forEach((request) => emitRemoteRequestCancelled(request, reason));
    cleared.sessions.forEach((session) => emitRemoteControlStopped(session, reason));
  }

  function stopRemoteControlForRoom(roomId: string, reason: string) {
    const cleared = deps.remoteControls.clearRoom(roomId);
    cleared.requests.forEach((request) => emitRemoteRequestCancelled(request, reason));
    cleared.sessions.forEach((session) => emitRemoteControlStopped(session, reason));
  }
  return {
    emitRemoteControlStopped,
    emitRemoteRequestCancelled,
    stopRemoteControlForSocket,
    stopRemoteControlForRoom,
  };
}
