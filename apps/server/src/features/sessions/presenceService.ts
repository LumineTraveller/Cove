import { createLobbyPresenceSnapshot, type ClientPlatform } from './presence';

export interface CreatePresenceServiceDependencies {
  readonly emitAvatarPayload: (event: string, payload: unknown, roomId?: string) => void;
  readonly userNames: Map<string, string>;
  readonly userAvatars: Map<string, string | null>;
  readonly roomMembers: Map<string, Set<string>>;
  readonly voiceRooms: Map<string, Set<string>>;
  readonly userPlatforms: Map<string, ClientPlatform>;
  readonly publicUserId: (socketId: string) => string;
}

export function createPresenceService(deps: CreatePresenceServiceDependencies) {
  function broadcastOnlineUsers() {
    deps.emitAvatarPayload(
      'users:online',
      createLobbyPresenceSnapshot(
        deps.userNames,
        deps.userAvatars,
        deps.roomMembers,
        deps.voiceRooms,
        deps.userPlatforms,
        publicUserIdsBySocket(),
      ).onlineUsers,
    );
  }

  function publicUserIdsBySocket() {
    return new Map(
      [...deps.userNames.keys()].map((socketId) => [socketId, deps.publicUserId(socketId)]),
    );
  }
  return { broadcastOnlineUsers, publicUserIdsBySocket };
}
