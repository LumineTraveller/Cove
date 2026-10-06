import type * as BetterSqlite3 from 'better-sqlite3';

import path from 'path';

import fs from 'fs';

import { normalizeSoundpack } from './soundpackNormalization';

import { SoundpackRecord, PublicSoundpack } from '../../models';

export interface RegisterSoundpacksRoutesDependencies {
  readonly app: import('express-serve-static-core').Express;
  readonly stmtGetSoundpacks: BetterSqlite3.Statement<unknown[], unknown>;
  readonly toPublicSoundpack: (
    pack: SoundpackRecord,
    requesterSocketId?: string,
    roomId?: string,
  ) => PublicSoundpack;
  readonly userClientIds: Map<string, string>;
  readonly userNames: Map<string, string>;
  readonly SOUNDS_DIR: string;
  readonly stmtGetNextSoundpackOrder: BetterSqlite3.Statement<unknown[], unknown>;
  readonly stmtInsertSoundpack: BetterSqlite3.Statement<unknown[], unknown>;
  readonly broadcastSoundpackAdded: (pack: SoundpackRecord) => void;
}

export function registerSoundpacksRoutes(deps: RegisterSoundpacksRoutesDependencies) {
  deps.app.get('/api/soundpacks', (req, res) => {
    const requesterSocketId =
      typeof req.query.socketId === 'string' ? req.query.socketId : undefined;
    const roomId = typeof req.query.roomId === 'string' ? req.query.roomId : undefined;
    const packs = deps.stmtGetSoundpacks.all() as SoundpackRecord[];
    res.json(packs.map((pack) => deps.toPublicSoundpack(pack, requesterSocketId, roomId)));
  });

  deps.app.post('/api/soundpacks', async (req, res) => {
    const { name, data, mimeType, socketId, roomId } = req.body as {
      name?: string;
      data?: string;
      mimeType?: string;
      socketId?: string;
      roomId?: string;
    };
    if (!name?.trim() || !data || !mimeType) {
      res.status(400).json({ error: 'name, data, mimeType 均为必填' });
      return;
    }
    if (!mimeType.startsWith('audio/')) {
      res.status(400).json({ error: '只允许上传音频文件' });
      return;
    }
    const uploaderId = socketId ? deps.userClientIds.get(socketId) : undefined;
    const uploader = socketId ? deps.userNames.get(socketId) : undefined;
    if (!socketId || !uploaderId || !uploader) {
      res.status(401).json({ error: '请先连接并注册用户' });
      return;
    }
    // base64 → Buffer，限制 8MB
    const buf = Buffer.from(data, 'base64');
    if (buf.length > 8 * 1024 * 1024) {
      res.status(400).json({ error: '文件过大，最大支持 8MB' });
      return;
    }
    const subtype = mimeType.split('/')[1]?.split(';')[0]?.toLowerCase();
    const ext =
      subtype === 'mpeg'
        ? 'mp3'
        : subtype === 'x-wav' || subtype === 'wave'
        ? 'wav'
        : subtype && /^[a-z0-9]{1,8}$/.test(subtype)
        ? subtype
        : 'audio';
    const id = Math.random().toString(36).slice(2, 9);
    const originalFilename = `${id}.${ext}`;
    const filename = `${id}.normalized.mp3`;
    const originalPath = path.join(deps.SOUNDS_DIR, originalFilename);
    const temporaryPath = path.join(deps.SOUNDS_DIR, `${id}.normalizing.mp3`);
    const playbackPath = path.join(deps.SOUNDS_DIR, filename);
    let sp: SoundpackRecord;
    try {
      fs.writeFileSync(originalPath, buf, { flag: 'wx' });
      await normalizeSoundpack(originalPath, temporaryPath);
      fs.renameSync(temporaryPath, playbackPath);
      const nextOrder = (deps.stmtGetNextSoundpackOrder.get() as { sortOrder: number }).sortOrder;
      sp = {
        id,
        name: name.trim(),
        filename,
        originalFilename,
        normalizationVersion: 1,
        uploader,
        uploaderId,
        createdAt: Date.now(),
        sortOrder: nextOrder,
      };
      deps.stmtInsertSoundpack.run(
        sp.id,
        sp.name,
        sp.filename,
        sp.originalFilename,
        sp.uploader,
        sp.uploaderId,
        sp.createdAt,
        sp.sortOrder,
      );
    } catch (error) {
      for (const file of [temporaryPath, playbackPath, originalPath]) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* report the original failure */
        }
      }
      const message = error instanceof Error ? error.message : '语音包处理失败';
      console.warn('[soundpack] 上传处理失败', error);
      res
        .status(message.startsWith('语音包') || message.includes('FFmpeg') ? 400 : 500)
        .json({ error: message });
      return;
    }
    deps.broadcastSoundpackAdded(sp);
    res.json(deps.toPublicSoundpack(sp, socketId, roomId));
  });
  return {};
}
