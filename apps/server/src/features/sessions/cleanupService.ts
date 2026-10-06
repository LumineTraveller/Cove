import { Server } from 'socket.io';

import { removePeer } from '../media/ms';
import { type ClientPlatform } from './presence';

import { DisconnectGrace } from './disconnectGrace';

export interface CreateCleanupServiceDependencies {
  readonly disconnectGrace: DisconnectGrace;
  readonly stopRemoteControlForSocket: (socketId: string, reason: string) => void;
  readonly removeAnnotationMember: (socketId: string) => void;
  readonly voiceRooms: Map<string, Set<string>>;
  readonly handleVoiceLeave: (socketId: string, roomId: string) => void;
  readonly roomMembers: Map<string, Set<string>>;
  readonly broadcastRoomMembers: (roomId: string) => void;
  readonly userNames: Map<string, string>;
  readonly userAvatars: Map<string, string | null>;
  readonly userClientIds: Map<string, string>;
  readonly userPlatforms: Map<string, ClientPlatform>;
  readonly remoteControlCapabilities: Set<string>;
  readonly accountSockets: Map<string, string>;
  readonly broadcastOnlineUsers: () => void;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
}

export function createCleanupService(deps: CreateCleanupServiceDependencies) {
  function cleanupDisconnectedPeer(socketId: string) {
    deps.disconnectGrace.cancel(socketId);
    deps.stopRemoteControlForSocket(socketId, '成员连接已断开');
    deps.removeAnnotationMember(socketId);
    deps.voiceRooms.forEach((_, roomId) => deps.handleVoiceLeave(socketId, roomId));
    deps.roomMembers.forEach((members, roomId) => {
      if (!members.delete(socketId)) return;
      deps.broadcastRoomMembers(roomId);
    });
    deps.userNames.delete(socketId);
    deps.userAvatars.delete(socketId);
    deps.userClientIds.delete(socketId);
    deps.userPlatforms.delete(socketId);
    deps.remoteControlCapabilities.delete(socketId);
    for (const [accountId, accountSocketId] of deps.accountSockets) {
      if (accountSocketId === socketId) deps.accountSockets.delete(accountId);
    }
    deps.broadcastOnlineUsers();
    removePeer(socketId);
  }

  function replaceAccountSocket(accountId: string) {
    const previousSocketId = deps.accountSockets.get(accountId);
    if (!previousSocketId) return;
    const previousSocket = deps.io.sockets.sockets.get(previousSocketId);
    if (previousSocket) previousSocket.emit('account:session-replaced');
    cleanupDisconnectedPeer(previousSocketId);
    previousSocket?.disconnect(true);
    deps.accountSockets.delete(accountId);
  }
  return { cleanupDisconnectedPeer, replaceAccountSocket };
}
