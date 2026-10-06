import type * as BetterSqlite3 from 'better-sqlite3';
import express from 'express';

import { Server } from 'socket.io';

import path from 'path';

import fs from 'fs';
import { randomUUID } from 'crypto';

import { RoomSettingsError } from './roomSettings';

import { Room, Message, MessageHistoryCursor } from '../../models';

export interface RegisterRoomsRoutesDependencies {
  readonly app: import('express-serve-static-core').Express;
  readonly requestAvatarPayload: <T>(req: express.Request, payload: T) => T;
  readonly stmtGetRooms: { all: () => Room[] };
  readonly createRoomForSocket: (
    socketId: unknown,
    data: {
      name?: unknown;
      maxMembers?: unknown;
      password?: unknown;
      avatarUrl?: unknown;
      backgroundTop?: unknown;
      backgroundBottom?: unknown;
      backgroundTopDark?: unknown;
      backgroundBottomDark?: unknown;
    } | null,
  ) => Promise<{
    id: `${string}-${string}-${string}-${string}-${string}`;
    name: string;
    createdAt: number;
    ownerName: string;
    ownerUserId: string;
    maxMembers: number | null;
    hasPassword: boolean;
    avatarUrl: string | null;
    backgroundTop: string | null;
    backgroundBottom: string | null;
    backgroundTopDark: string | null;
    backgroundBottomDark: string | null;
  }>;
  readonly roomError: (error: unknown) => { ok: false; error: string; code: string };
  readonly stmtGetRoom: { get: (id: string) => Room | undefined };
  readonly getMessageHistory: (
    roomId: string,
    before?: MessageHistoryCursor,
  ) => {
    messages: {
      authorUserId: string | null;
      type: 'chat' | 'soundpack' | 'image' | 'system';
      id: string;
      roomId: string;
      author: string;
      content: string;
      timestamp: number;
    }[];
    hasMore: boolean;
    cursor: { timestamp: number; id: string } | null;
  };
  readonly CHAT_IMAGE_TYPES: Map<string, string>;
  readonly userClientIds: Map<string, string>;
  readonly roomMembers: Map<string, Set<string>>;
  readonly validChatImage: (buffer: Buffer, mimeType: string) => boolean;
  readonly CHAT_IMAGES_DIR: string;
  readonly userNames: Map<string, string>;
  readonly publicUserId: (socketId: string) => string;
  readonly stmtInsertMsg: BetterSqlite3.Statement<unknown[], unknown>;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
}

export function registerRoomsRoutes(deps: RegisterRoomsRoutesDependencies) {
  deps.app.get('/api/rooms', (req, res) => {
    res.json(deps.requestAvatarPayload(req, deps.stmtGetRooms.all()));
  });

  deps.app.post('/api/rooms', async (req, res) => {
    try {
      res.json(
        deps.requestAvatarPayload(
          req,
          await deps.createRoomForSocket(req.body?.socketId, req.body),
        ),
      );
    } catch (error) {
      res
        .status(error instanceof RoomSettingsError && error.code === 'NOT_REGISTERED' ? 401 : 400)
        .json(deps.roomError(error));
    }
  });

  deps.app.get('/api/rooms/:id', (req, res) => {
    const room = deps.stmtGetRoom.get(req.params.id) as Room | undefined;
    if (!room) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(deps.requestAvatarPayload(req, room));
  });

  deps.app.get('/api/rooms/:id/messages', (req, res) => {
    const room = deps.stmtGetRoom.get(req.params.id);
    if (!room) {
      res.status(404).json({ error: '房间不存在' });
      return;
    }
    // Private rooms must use the authenticated, joined Socket.IO history endpoint.
    if (room.hasPassword) {
      res.status(403).json({ error: '请进入房间后读取聊天记录' });
      return;
    }
    // Keep the legacy array response shape while avoiding an unbounded query.
    res.json(deps.getMessageHistory(req.params.id).messages);
  });

  deps.app.post('/api/rooms/:id/images', (req, res) => {
    const roomId = req.params.id;
    const { data, mimeType, socketId } = req.body as {
      data?: string;
      mimeType?: string;
      socketId?: string;
    };
    const extension = mimeType ? deps.CHAT_IMAGE_TYPES.get(mimeType) : undefined;
    if (!data || !mimeType || !extension) {
      res.status(400).json({ error: '仅支持 PNG、JPEG、WebP 或 GIF 图片' });
      return;
    }
    if (
      !socketId ||
      !deps.userClientIds.has(socketId) ||
      !deps.roomMembers.get(roomId)?.has(socketId)
    ) {
      res.status(403).json({ error: '请先进入该房间' });
      return;
    }
    const buffer = Buffer.from(data, 'base64');
    if (!buffer.length || buffer.length > 10 * 1024 * 1024) {
      res.status(400).json({ error: '图片大小必须在 10MB 以内' });
      return;
    }
    if (!deps.validChatImage(buffer, mimeType)) {
      res.status(400).json({ error: '图片内容与文件类型不匹配' });
      return;
    }

    const filename = `${randomUUID()}.${extension}`;
    const roomDirectory = path.join(deps.CHAT_IMAGES_DIR, roomId);
    try {
      fs.mkdirSync(roomDirectory, { recursive: true });
      fs.writeFileSync(path.join(roomDirectory, filename), buffer, { flag: 'wx' });
    } catch {
      res.status(500).json({ error: '图片保存失败' });
      return;
    }

    const msg: Message = {
      id: Math.random().toString(36).slice(2, 9),
      roomId,
      author: deps.userNames.get(socketId) ?? 'Unknown',
      authorUserId: deps.publicUserId(socketId),
      content: `/chat-images/${roomId}/${filename}`,
      type: 'image',
      timestamp: Date.now(),
    };
    try {
      deps.stmtInsertMsg.run(
        msg.id,
        msg.roomId,
        msg.author,
        deps.userClientIds.get(socketId) ?? null,
        msg.content,
        msg.type,
        msg.timestamp,
      );
      deps.io.to(roomId).emit('message:new', msg);
      res.json(msg);
    } catch {
      fs.rmSync(path.join(roomDirectory, filename), { force: true });
      res.status(500).json({ error: '图片消息保存失败' });
    }
  });
  return {};
}
