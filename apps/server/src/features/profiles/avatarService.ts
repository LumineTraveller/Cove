import type * as BetterSqlite3 from 'better-sqlite3';
import express from 'express';

import { Server, type Socket } from 'socket.io';

import path from 'path';

import fs from 'fs';

import { createAvatarStorage, mapAvatarUrls, avatarOrigin } from './avatarStorage';

export interface CreateAvatarServiceDependencies {
  readonly dataDir: string;
  readonly db: BetterSqlite3.Database;
  readonly serverSecurityEnabled: boolean;
  readonly requestServerAccessToken: (
    req: express.Request,
    allowQueryToken?: boolean,
  ) => string | null;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
}

export function createAvatarService(deps: CreateAvatarServiceDependencies) {
  const SOUNDS_DIR = path.join(deps.dataDir, 'sounds');

  fs.mkdirSync(SOUNDS_DIR, { recursive: true });

  const avatarStorage = createAvatarStorage(deps.dataDir);

  function migrateAvatars(): void {
    for (const table of ['accounts', 'rooms']) {
      const rows = deps.db
        .prepare(`SELECT id, avatarUrl FROM ${table} WHERE avatarUrl IS NOT NULL`)
        .all() as { id: string; avatarUrl: string }[];
      const update = deps.db.prepare(`UPDATE ${table} SET avatarUrl = ? WHERE id = ?`);
      let count = 0;
      for (const row of rows) {
        let source = row.avatarUrl;
        // Recover files written by the previous room-avatar migration, whose
        // HTTP handler mistakenly attempted to open a file named "avatar".
        if (table === 'rooms' && source === `/api/rooms/${row.id}/avatar`) {
          for (const ext of ['png', 'jpg', 'webp', 'gif']) {
            const filename = path.join(deps.dataDir, 'room-avatars', `room-${row.id}.${ext}`);
            if (!fs.existsSync(filename)) continue;
            source = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs
              .readFileSync(filename)
              .toString('base64')}`;
            break;
          }
        }
        const saved = avatarStorage.save(source);
        if (saved && saved !== row.avatarUrl) {
          update.run(saved, row.id);
          count++;
        } else if (!saved) console.warn(`[avatar] unable to migrate ${table}/${row.id}`);
      }
      console.log(`[avatar] migrated ${table}: ${count}`);
    }
  }

  function socketAvatarPayload<T>(socket: Socket, payload: T): T {
    return mapAvatarUrls(
      payload,
      avatarOrigin(socket.handshake.headers, socket.handshake.secure),
      deps.serverSecurityEnabled ? socket.handshake.auth.serverAccessToken : undefined,
    );
  }

  function requestAvatarPayload<T>(req: express.Request, payload: T): T {
    return mapAvatarUrls(
      payload,
      avatarOrigin(req.headers, req.protocol === 'https'),
      deps.serverSecurityEnabled ? deps.requestServerAccessToken(req) ?? undefined : undefined,
    );
  }

  function emitAvatarPayload(event: string, payload: unknown, roomId?: string): void {
    for (const socket of deps.io.sockets.sockets.values()) {
      if (!roomId || socket.rooms.has(roomId))
        socket.emit(event, socketAvatarPayload(socket, payload));
    }
  }
  return {
    SOUNDS_DIR,
    avatarStorage,
    migrateAvatars,
    socketAvatarPayload,
    requestAvatarPayload,
    emitAvatarPayload,
  };
}
