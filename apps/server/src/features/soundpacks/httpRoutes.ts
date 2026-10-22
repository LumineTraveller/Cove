import type * as BetterSqlite3 from 'better-sqlite3';
import type { Response } from 'express';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { normalizeSoundpack } from './soundpackNormalization';
import { SoundpackProcessingError } from './soundpackWorkQueue';
import { SoundpackRecord, PublicSoundpack } from '../../models';
import { SoundpackAccessError, soundpackErrorResponse, type SoundpackAccess } from './soundpackAccess';

export interface RegisterSoundpacksRoutesDependencies {
  readonly app: import('express-serve-static-core').Express;
  readonly access: SoundpackAccess;
  readonly stmtGetSoundpacks: BetterSqlite3.Statement<unknown[], unknown>;
  readonly stmtGetSoundpack: BetterSqlite3.Statement<unknown[], unknown>;
  readonly toPublicSoundpack: (pack: SoundpackRecord, requesterSocketId: string, roomId: string) => PublicSoundpack;
  readonly SOUNDS_DIR: string;
  readonly stmtGetNextSoundpackOrder: BetterSqlite3.Statement<unknown[], unknown>;
  readonly stmtInsertSoundpack: BetterSqlite3.Statement<unknown[], unknown>;
  readonly broadcastSoundpackAdded: (pack: SoundpackRecord) => void;
  readonly processingSignal?: AbortSignal;
  readonly normalize?: typeof normalizeSoundpack;
}

const privateResponse = (res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.vary('Authorization');
  res.vary('X-Cove-Account-Token');
};

export function registerSoundpacksRoutes(deps: RegisterSoundpacksRoutesDependencies) {
  deps.app.get('/api/soundpacks', (req, res) => {
    privateResponse(res);
    try {
      const actor = deps.access.httpRoomActor(req, req.query.roomId);
      const packs = deps.stmtGetSoundpacks.all(actor.roomId) as SoundpackRecord[];
      res.json({ roomId: actor.roomId,
        soundpacks: packs.map((pack) => deps.toPublicSoundpack(pack, actor.socketId, actor.roomId)) });
    } catch (error) { soundpackErrorResponse(error, res); }
  });

  // Clients fetch this endpoint into a Blob (or supply native media request
  // headers). No account credential is embedded in a reusable media URL.
  deps.app.get('/api/soundpacks/:soundId/file', (req, res) => {
    privateResponse(res);
    try {
      const actor = deps.access.httpRoomActor(req, req.query.roomId);
      const variant = req.query.variant;
      if (variant !== 'playback' && variant !== 'original')
        throw new SoundpackAccessError(400, 'INVALID_REQUEST', '请指定语音包文件类型');
      const pack = deps.stmtGetSoundpack.get(req.params.soundId, actor.roomId) as SoundpackRecord | undefined;
      if (!pack || pack.roomId !== actor.roomId)
        throw new SoundpackAccessError(404, 'SOUNDPACK_NOT_FOUND', '语音包不存在');
      const filename = variant === 'original' ? pack.originalFilename ?? pack.filename : pack.filename;
      if (!filename || path.basename(filename) !== filename || /[\\/]/.test(filename))
        throw new SoundpackAccessError(404, 'SOUNDPACK_NOT_FOUND', '语音包文件不存在');
      if (variant === 'original') res.attachment(filename);
      res.sendFile(filename, {
        root: deps.SOUNDS_DIR, dotfiles: 'deny', cacheControl: false, acceptRanges: true,
      }, (error) => {
        if (!error) return;
        if (res.headersSent) { res.destroy(); return; }
        const status = (error as Error & { statusCode?: number }).statusCode;
        res.status(status && status >= 400 && status <= 599 ? status : 500).end();
      });
    } catch (error) { soundpackErrorResponse(error, res); }
  });

  deps.app.post('/api/soundpacks', async (req, res) => {
    privateResponse(res);
    let files: string[] = [];
    let committed = false;
    let responseClosed = false;
    const processing = new AbortController();
    const cancel = () => processing.abort();
    const responseClose = () => {
      if (!res.writableFinished) { responseClosed = true; cancel(); }
    };
    res.once('close', responseClose);
    req.once('aborted', cancel);
    deps.processingSignal?.addEventListener('abort', cancel, { once: true });
    if (deps.processingSignal?.aborted || req.aborted || res.destroyed) cancel();
    try {
      const body = req.body as { name?: unknown; data?: unknown; mimeType?: unknown; roomId?: unknown } | undefined;
      // Old socketId fields are ignored. Only the account token identifies
      // its live, registered room connection.
      const actor = deps.access.httpRoomActor(req, body?.roomId);
      if (
        typeof body?.name !== 'string' || !body.name.trim() || body.name.trim().length > 64 ||
        typeof body.data !== 'string' || !body.data || typeof body.mimeType !== 'string'
      )
        throw new SoundpackAccessError(400, 'INVALID_REQUEST', '请填写音频名称和文件');
      if (!body.mimeType.startsWith('audio/'))
        throw new SoundpackAccessError(400, 'INVALID_REQUEST', '只允许上传音频文件');
      const buf = Buffer.from(body.data, 'base64');
      if (buf.length === 0 || buf.length > 8 * 1024 * 1024)
        throw new SoundpackAccessError(400, 'INVALID_REQUEST', '音频文件应为 1 字节至 8MB');
      const subtype = body.mimeType.split('/')[1]?.split(';')[0]?.toLowerCase();
      const ext = subtype === 'mpeg' ? 'mp3' : subtype === 'x-wav' || subtype === 'wave' ? 'wav'
        : subtype && /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : 'audio';
      const id = randomUUID();
      const originalFilename = `${id}.${ext}`;
      const filename = `${id}.normalized.mp3`;
      const originalPath = path.join(deps.SOUNDS_DIR, originalFilename);
      const temporaryPath = path.join(deps.SOUNDS_DIR, `${id}.normalizing.mp3`);
      const playbackPath = path.join(deps.SOUNDS_DIR, filename);
      const originalFd = fs.openSync(originalPath, 'wx');
      files = [originalPath, temporaryPath, playbackPath];
      try { fs.writeFileSync(originalFd, buf); }
      finally { fs.closeSync(originalFd); }
      await (deps.normalize ?? normalizeSoundpack)(originalPath, temporaryPath, { signal: processing.signal });
      // Recheck after normalization: leaving, kicking, logout, takeover or
      // room deletion while it awaited must not commit a stale upload.
      deps.access.revalidateActor(actor);
      if (req.aborted || res.destroyed || responseClosed)
        throw new SoundpackAccessError(409, 'UPLOAD_CANCELLED', '上传已取消');
      fs.renameSync(temporaryPath, playbackPath);
      const nextOrder = (deps.stmtGetNextSoundpackOrder.get(actor.roomId) as { sortOrder: number }).sortOrder;
      const sp: SoundpackRecord = {
        id, roomId: actor.roomId, name: body.name.trim(), filename, originalFilename,
        normalizationVersion: 1, uploader: actor.username, uploaderId: actor.clientId,
        createdAt: Date.now(), sortOrder: nextOrder,
      };
      deps.stmtInsertSoundpack.run(
        sp.id, sp.name, sp.filename, sp.originalFilename, sp.uploader, sp.uploaderId,
        sp.createdAt, sp.sortOrder, sp.roomId,
      );
      committed = true;
      deps.broadcastSoundpackAdded(sp);
      res.json(deps.toPublicSoundpack(sp, actor.socketId, actor.roomId));
    } catch (error) {
      if (!committed) for (const file of files) {
        try { fs.rmSync(file, { force: true }); } catch { /* preserve original error */ }
      }
      if (res.destroyed || responseClosed) return;
      if (error instanceof SoundpackAccessError) { soundpackErrorResponse(error, res); return; }
      if (error instanceof SoundpackProcessingError) {
        const busy = error.code === 'SOUNDPACK_QUEUE_FULL' || error.code === 'SOUNDPACK_QUEUE_TIMEOUT';
        if (busy) res.setHeader('Retry-After', '2');
        res.status(busy ? 503 : error.code === 'SOUNDPACK_CANCELLED' ? 409 : 408)
          .json({ error: error.message, code: error.code });
        return;
      }
      const message = error instanceof Error ? error.message : '';
      if (message.startsWith('语音包') || message.includes('FFmpeg')) {
        res.status(400).json({ error: message, code: 'INVALID_AUDIO' });
        return;
      }
      soundpackErrorResponse(error, res);
    } finally {
      req.off('aborted', cancel);
      res.off('close', responseClose);
      deps.processingSignal?.removeEventListener('abort', cancel);
    }
  });
}
