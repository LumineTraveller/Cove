import type * as BetterSqlite3 from 'better-sqlite3';

import { Room, StoredRoom } from '../../models';

export interface CreateRepositoriesDependencies {
  readonly db: BetterSqlite3.Database;
  readonly toPublicRoom: ({ ownerId, ...room }: StoredRoom) => Room;
}

export function createRepositories(deps: CreateRepositoriesDependencies) {
  const publicRoomColumns =
    'id, name, createdAt, ownerName, ownerId, maxMembers, (passwordHash IS NOT NULL) AS hasPassword, avatarUrl, backgroundTop, backgroundBottom, backgroundTopDark, backgroundBottomDark';

  const roomListQuery = deps.db.prepare(
    `SELECT ${publicRoomColumns} FROM rooms ORDER BY createdAt ASC`,
  );

  const roomQuery = deps.db.prepare(`SELECT ${publicRoomColumns} FROM rooms WHERE id = ?`);

  const stmtGetRooms = {
    all: () => roomListQuery.all().map((row) => deps.toPublicRoom(row as StoredRoom)),
  };

  const stmtGetRoom = {
    get: (id: string) => {
      const row = roomQuery.get(id) as StoredRoom | undefined;
      return row ? deps.toPublicRoom(row) : undefined;
    },
  };

  const stmtGetRoomPrivate = deps.db.prepare(
    'SELECT id, name, createdAt, ownerId, ownerName, maxMembers, passwordHash, passwordSalt, avatarUrl, backgroundTop, backgroundBottom, backgroundTopDark, backgroundBottomDark FROM rooms WHERE id = ?',
  );

  const stmtGetRoomOwners = deps.db.prepare('SELECT id, ownerId FROM rooms');

  const stmtInsertRoom = deps.db.prepare(
    'INSERT INTO rooms (id, name, createdAt, ownerId, ownerName, maxMembers, passwordHash, passwordSalt, avatarUrl, backgroundTop, backgroundBottom, backgroundTopDark, backgroundBottomDark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );

  const stmtUpdateRoomSettings = deps.db.prepare(
    'UPDATE rooms SET name = ?, maxMembers = ?, passwordHash = ?, passwordSalt = ?, avatarUrl = ?, backgroundTop = ?, backgroundBottom = ?, backgroundTopDark = ?, backgroundBottomDark = ? WHERE id = ?',
  );

  const stmtClaimRoom = deps.db.prepare(
    'UPDATE rooms SET ownerId = ?, ownerName = ? WHERE id = ? AND ownerId IS NULL',
  );

  const stmtUpdateOwnerName = deps.db.prepare(
    'UPDATE rooms SET ownerName = ? WHERE ownerId = ? AND ownerName IS NOT ?',
  );

  const stmtMigrateLegacyOwnersByName = deps.db.prepare(
    "UPDATE rooms SET ownerId = ?, ownerName = ? WHERE ownerName = ? AND ownerId IS NOT NULL AND ownerId NOT LIKE 'account:%'",
  );

  const stmtDeleteRoom = deps.db.prepare('DELETE FROM rooms WHERE id = ?');

  const stmtDeleteRoomMessages = deps.db.prepare('DELETE FROM messages WHERE roomId = ?');

  const stmtDeleteRoomMutes = deps.db.prepare('DELETE FROM room_mutes WHERE roomId = ?');

  const CHAT_HISTORY_PAGE_SIZE = 50;

  const stmtGetLatestMessagesPage = deps.db.prepare(`
  SELECT id, roomId, author, authorId, content, type, timestamp FROM messages
  WHERE roomId = ? AND type NOT IN ('system', 'soundpack')
  ORDER BY timestamp DESC, id DESC
  LIMIT ?
`);

  const stmtGetOlderMessagesPage = deps.db.prepare(`
  SELECT id, roomId, author, authorId, content, type, timestamp FROM messages
  WHERE roomId = ?
    AND type NOT IN ('system', 'soundpack')
    AND (timestamp < ? OR (timestamp = ? AND id < ?))
  ORDER BY timestamp DESC, id DESC
  LIMIT ?
`);

  const stmtInsertMsg = deps.db.prepare(
    'INSERT INTO messages (id, roomId, author, authorId, content, type, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  const stmtIsRoomMuted = deps.db.prepare(
    'SELECT 1 FROM room_mutes WHERE roomId = ? AND clientId = ?',
  );

  const stmtMuteMember = deps.db.prepare(
    'INSERT OR REPLACE INTO room_mutes (roomId, clientId, username, createdAt) VALUES (?, ?, ?, ?)',
  );

  const stmtUnmuteMember = deps.db.prepare(
    'DELETE FROM room_mutes WHERE roomId = ? AND clientId = ?',
  );

  const stmtGetSoundpacks = deps.db.prepare(
    'SELECT * FROM soundpacks ORDER BY sortOrder ASC, createdAt DESC',
  );

  const stmtGetSoundpack = deps.db.prepare('SELECT * FROM soundpacks WHERE id = ?');

  const stmtGetNextSoundpackOrder = deps.db.prepare(
    'SELECT COALESCE(MIN(sortOrder), 0) - 1 AS sortOrder FROM soundpacks',
  );

  const stmtInsertSoundpack = deps.db.prepare(
    'INSERT INTO soundpacks (id, name, filename, originalFilename, normalizationVersion, uploader, uploaderId, createdAt, sortOrder) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)',
  );

  const stmtGetLegacySoundpacks = deps.db.prepare(
    'SELECT * FROM soundpacks WHERE normalizationVersion = 0 ORDER BY createdAt ASC',
  );

  const stmtMarkSoundpackNormalized = deps.db.prepare(
    'UPDATE soundpacks SET filename = ?, originalFilename = ?, normalizationVersion = 1 WHERE id = ? AND filename = ? AND normalizationVersion = 0',
  );

  const stmtUpdateSoundpackOrder = deps.db.prepare(
    'UPDATE soundpacks SET sortOrder = ? WHERE id = ?',
  );

  const stmtRenameSoundpack = deps.db.prepare('UPDATE soundpacks SET name = ? WHERE id = ?');

  const stmtDeleteSoundpack = deps.db.prepare('DELETE FROM soundpacks WHERE id = ?');

  const migrateLegacyIdentity = deps.db.transaction((legacyId: string, accountId: string) => {
    deps.db.prepare('UPDATE rooms SET ownerId = ? WHERE ownerId = ?').run(accountId, legacyId);
    deps.db
      .prepare('UPDATE soundpacks SET uploaderId = ? WHERE uploaderId = ?')
      .run(accountId, legacyId);
    deps.db
      .prepare(
        `INSERT OR IGNORE INTO room_mutes (roomId, clientId, username, createdAt)
    SELECT roomId, ?, username, createdAt FROM room_mutes WHERE clientId = ?`,
      )
      .run(accountId, legacyId);
    deps.db.prepare('DELETE FROM room_mutes WHERE clientId = ?').run(legacyId);
  });

  const reorderSoundpacks = deps.db.transaction((orderedIds: string[]) => {
    orderedIds.forEach((id, index) => stmtUpdateSoundpackOrder.run(index, id));
  });

  const deleteRoomData = deps.db.transaction((roomId: string) => {
    stmtDeleteRoomMessages.run(roomId);
    stmtDeleteRoomMutes.run(roomId);
    stmtDeleteRoom.run(roomId);
  });
  return {
    publicRoomColumns,
    roomListQuery,
    roomQuery,
    stmtGetRooms,
    stmtGetRoom,
    stmtGetRoomPrivate,
    stmtGetRoomOwners,
    stmtInsertRoom,
    stmtUpdateRoomSettings,
    stmtClaimRoom,
    stmtUpdateOwnerName,
    stmtMigrateLegacyOwnersByName,
    stmtDeleteRoom,
    stmtDeleteRoomMessages,
    stmtDeleteRoomMutes,
    CHAT_HISTORY_PAGE_SIZE,
    stmtGetLatestMessagesPage,
    stmtGetOlderMessagesPage,
    stmtInsertMsg,
    stmtIsRoomMuted,
    stmtMuteMember,
    stmtUnmuteMember,
    stmtGetSoundpacks,
    stmtGetSoundpack,
    stmtGetNextSoundpackOrder,
    stmtInsertSoundpack,
    stmtGetLegacySoundpacks,
    stmtMarkSoundpackNormalized,
    stmtUpdateSoundpackOrder,
    stmtRenameSoundpack,
    stmtDeleteSoundpack,
    migrateLegacyIdentity,
    reorderSoundpacks,
    deleteRoomData,
  };
}
