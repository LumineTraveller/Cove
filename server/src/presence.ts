export type ClientPlatform = 'desktop' | 'mobile';

export interface OnlinePresenceUser {
  socketId: string;
  username: string;
  avatarUrl: string | null;
  platform: ClientPlatform | null;
}

export interface LobbyPresenceSnapshot {
  onlineUsers: OnlinePresenceUser[];
  roomMembers: Record<string, string[]>;
  voiceCounts: Record<string, number>;
}

export function sanitizeClientPlatform(value: unknown): ClientPlatform | null {
  return value === 'desktop' || value === 'mobile' ? value : null;
}

export function createLobbyPresenceSnapshot(
  userNames: ReadonlyMap<string, string>,
  userAvatars: ReadonlyMap<string, string | null>,
  roomMembers: ReadonlyMap<string, ReadonlySet<string>>,
  voiceRooms: ReadonlyMap<string, ReadonlySet<string>>,
  userPlatforms: ReadonlyMap<string, ClientPlatform> = new Map(),
): LobbyPresenceSnapshot {
  return {
    onlineUsers: [...userNames.entries()].map(([socketId, username]) => ({
      socketId,
      username,
      avatarUrl: userAvatars.get(socketId) ?? null,
      platform: userPlatforms.get(socketId) ?? null,
    })),
    roomMembers: Object.fromEntries(
      [...roomMembers.entries()].map(([roomId, members]) => [
        roomId,
        [...members].map(socketId => userNames.get(socketId) ?? socketId),
      ]),
    ),
    voiceCounts: Object.fromEntries(
      [...voiceRooms.entries()].map(([roomId, members]) => [roomId, members.size]),
    ),
  };
}
