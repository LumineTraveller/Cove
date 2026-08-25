export interface OnlinePresenceUser {
  socketId: string;
  username: string;
  avatarUrl: string | null;
}

export interface LobbyPresenceSnapshot {
  onlineUsers: OnlinePresenceUser[];
  roomMembers: Record<string, string[]>;
  voiceCounts: Record<string, number>;
}

export function createLobbyPresenceSnapshot(
  userNames: ReadonlyMap<string, string>,
  userAvatars: ReadonlyMap<string, string | null>,
  roomMembers: ReadonlyMap<string, ReadonlySet<string>>,
  voiceRooms: ReadonlyMap<string, ReadonlySet<string>>,
): LobbyPresenceSnapshot {
  return {
    onlineUsers: [...userNames.entries()].map(([socketId, username]) => ({
      socketId,
      username,
      avatarUrl: userAvatars.get(socketId) ?? null,
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
