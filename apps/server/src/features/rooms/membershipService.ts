import type * as BetterSqlite3 from 'better-sqlite3';

import { Server, type Socket } from 'socket.io';

import { peers } from '../media/ms';
import { type ClientPlatform } from '../sessions/presence';

import { PrivateRoom, RoomMember } from '../../models';

export interface CreateMembershipServiceDependencies {
  readonly roomMembers: Map<string, Set<string>>;
  readonly stmtGetRoomPrivate: BetterSqlite3.Statement<unknown[], unknown>;
  readonly userClientIds: Map<string, string>;
  readonly publicUserId: (socketId: string) => string;
  readonly userNames: Map<string, string>;
  readonly userAvatars: Map<string, string | null>;
  readonly userPlatforms: Map<string, ClientPlatform>;
  readonly remoteControlCapabilities: Set<string>;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly socketAvatarPayload: <T>(socket: Socket, payload: T) => T;
  readonly publicUserIdForStableId: (stableId: string) => string;
  readonly stmtIsRoomMuted: BetterSqlite3.Statement<unknown[], unknown>;
}

export function createMembershipService(deps: CreateMembershipServiceDependencies) {
  function broadcastRoomMembers(roomId: string) {
    const members = deps.roomMembers.get(roomId) ?? new Set();
    const room = deps.stmtGetRoomPrivate.get(roomId) as PrivateRoom | undefined;
    if (!room) return;
    const list: RoomMember[] = [...members].map((id) => {
      const clientId = deps.userClientIds.get(id);
      const peer = peers.get(id);
      const producers = peer
        ? [...peer.producers.values()].filter((producer) => !producer.closed)
        : [];
      const hasProducerType = (type: string) =>
        producers.some((producer) => (producer.appData as Record<string, unknown>).type === type);
      return {
        socketId: id,
        userId: deps.publicUserId(id),
        username: deps.userNames.get(id) ?? id,
        avatarUrl: deps.userAvatars.get(id) ?? null,
        isOwner: !!clientId && clientId === room.ownerId,
        isMuted: !!clientId && isClientMuted(roomId, clientId),
        isSharingScreen: hasProducerType('screen'),
        isSharingApplicationAudio: hasProducerType('application-audio'),
        platform: deps.userPlatforms.get(id) ?? null,
        canReceiveRemoteControl: deps.remoteControlCapabilities.has(id),
      };
    });

    // room:state 对每个连接单独发送，isOwner 由服务端计算，不能由客户端声明。
    for (const socketId of members) {
      const clientId = deps.userClientIds.get(socketId);
      const target = deps.io.sockets.sockets.get(socketId);
      if (!target) continue;
      target.emit(
        'room:state',
        deps.socketAvatarPayload(target, {
          roomId,
          name: room.name,
          ownerName: room.ownerName,
          ownerUserId: room.ownerId ? deps.publicUserIdForStableId(room.ownerId) : null,
          isOwner: !!clientId && clientId === room.ownerId,
          maxMembers: room.maxMembers,
          hasPassword: !!room.passwordHash,
          avatarUrl: room.avatarUrl,
          backgroundTop: room.backgroundTop,
          backgroundBottom: room.backgroundBottom,
          backgroundTopDark: room.backgroundTopDark,
          backgroundBottomDark: room.backgroundBottomDark,
          members: list,
        }),
      );
    }
    // 保留旧事件兼容旧客户端；全局列表只用于大厅显示人数。
    const names = list.map((member) => member.username);
    deps.io.to(roomId).emit('room:members', names);
    deps.io.emit('room:members:global', { roomId, members: names });
  }

  function isClientMuted(roomId: string, clientId: string): boolean {
    return !!deps.stmtIsRoomMuted.get(roomId, clientId);
  }

  function isSocketMuted(roomId: string, socketId: string): boolean {
    const clientId = deps.userClientIds.get(socketId);
    return !!clientId && isClientMuted(roomId, clientId);
  }
  return { broadcastRoomMembers, isClientMuted, isSocketMuted };
}
