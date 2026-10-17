import type * as BetterSqlite3 from 'better-sqlite3';
import type { Server, Socket } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { soundpackVoiceAudience } from './soundpackAudience';
import { Message, SoundpackRecord } from '../../models';
import { SoundpackAccessError, type SoundpackAccess, type SoundpackActor } from './soundpackAccess';

export interface RegisterSoundpacksSocketHandlersDependencies {
  readonly socket: Socket;
  readonly stmtGetSoundpack: BetterSqlite3.Statement<unknown[], unknown>;
  readonly roomMembers: Map<string, Set<string>>;
  readonly voiceRooms: Map<string, Set<string>>;
  readonly io: Server;
  readonly publicUserId: (socketId: string) => string;
  readonly isRoomOwner: (roomId: string | undefined, socketId: string | undefined) => boolean;
  readonly stmtDeleteSoundpack: BetterSqlite3.Statement<unknown[], unknown>;
  readonly SOUNDS_DIR: string;
  readonly stmtRenameSoundpack: BetterSqlite3.Statement<unknown[], unknown>;
  readonly stmtGetSoundpacks: BetterSqlite3.Statement<unknown[], unknown>;
  readonly reorderSoundpacks: BetterSqlite3.Transaction<(roomId: string, orderedIds: string[]) => void>;
  readonly access: SoundpackAccess;
  readonly broadcastSoundpackEvent: (roomId: string, event: string, payload: unknown) => void;
}

interface SoundpackRequest { roomId?: unknown; soundId?: unknown; name?: unknown; orderedIds?: unknown }
type Acknowledge = (result: { ok: boolean; error?: string; code?: string; name?: string }) => void;

export function registerSoundpacksSocketHandlers(deps: RegisterSoundpacksSocketHandlersDependencies) {
  const onRoomEvent = (event: string, handle: (actor: SoundpackActor, request: SoundpackRequest, cb?: Acknowledge) => void) => {
    deps.socket.on(event, (value: unknown, cb?: Acknowledge) => {
      try {
        const request = value && typeof value === 'object' ? value as SoundpackRequest : {};
        const actor = deps.access.socketRoomActor(deps.socket, request.roomId);
        handle(actor, request, typeof cb === 'function' ? cb : undefined);
      } catch (error) {
        if (typeof cb === 'function') cb(error instanceof SoundpackAccessError
          ? { ok: false, error: error.message, code: error.code }
          : { ok: false, error: '语音包操作失败', code: 'SOUNDPACK_UNAVAILABLE' });
      }
    });
  };
  const roomPack = (actor: SoundpackActor, soundId: unknown): SoundpackRecord => {
    const pack = typeof soundId === 'string' && soundId.length <= 128
      ? deps.stmtGetSoundpack.get(soundId, actor.roomId) as SoundpackRecord | undefined : undefined;
    if (!pack || pack.roomId !== actor.roomId)
      throw new SoundpackAccessError(404, 'SOUNDPACK_NOT_FOUND', '语音包不存在');
    return pack;
  };
  const requireManagement = (actor: SoundpackActor, pack: SoundpackRecord) => {
    if (pack.uploaderId !== actor.clientId && !deps.isRoomOwner(actor.roomId, actor.socketId))
      throw new SoundpackAccessError(403, 'FORBIDDEN', '只能由上传者或当前房主管理语音包');
  };

  onRoomEvent('soundpack:play', (actor, request, cb) => {
    const pack = roomPack(actor, request.soundId);
    const audience = soundpackVoiceAudience(
      deps.roomMembers.get(actor.roomId), deps.voiceRooms.get(actor.roomId), actor.socketId,
    );
    if (!audience)
      throw new SoundpackAccessError(403, 'VOICE_REQUIRED', '请先加入语音再播放语音包');
    const playedBy = actor.username;
    for (const socketId of audience) {
      const target = deps.io.sockets.sockets.get(socketId);
      if (!target) continue;
      try { deps.access.socketRoomActor(target, actor.roomId); }
      catch { continue; }
      target.emit('soundpack:play', {
        roomId: actor.roomId, soundId: pack.id, filename: pack.filename, playedBy,
        playedByUserId: deps.publicUserId(actor.socketId), soundName: pack.name,
      });
    }
    const msg: Message = {
      id: randomUUID(), roomId: actor.roomId, author: playedBy,
      authorUserId: deps.publicUserId(actor.socketId), contentUserId: deps.publicUserId(actor.socketId),
      contentUsername: playedBy, content: `${playedBy} 播放了「${pack.name}」`,
      type: 'soundpack', timestamp: Date.now(),
    };
    deps.broadcastSoundpackEvent(actor.roomId, 'message:new', msg);
    cb?.({ ok: true });
  });

  onRoomEvent('soundpack:delete', (actor, request, cb) => {
    const pack = roomPack(actor, request.soundId);
    requireManagement(actor, pack);
    const result = deps.stmtDeleteSoundpack.run(pack.id, actor.roomId);
    if (result.changes !== 1)
      throw new SoundpackAccessError(404, 'SOUNDPACK_NOT_FOUND', '语音包不存在');
    for (const filename of new Set([pack.filename, pack.originalFilename])) {
      if (!filename || path.basename(filename) !== filename || /[\\/]/.test(filename)) continue;
      try { fs.rmSync(path.join(deps.SOUNDS_DIR, filename), { force: true }); }
      catch { console.warn('[soundpack] 无法清理已删除语音包文件'); }
    }
    deps.broadcastSoundpackEvent(actor.roomId, 'soundpack:deleted', { roomId: actor.roomId, soundId: pack.id });
    cb?.({ ok: true });
  });

  onRoomEvent('soundpack:rename', (actor, request, cb) => {
    const pack = roomPack(actor, request.soundId);
    requireManagement(actor, pack);
    const name = typeof request.name === 'string' ? request.name.trim() : '';
    if (!name || name.length > 64)
      throw new SoundpackAccessError(400, 'INVALID_REQUEST', '名称应为 1–64 个字符');
    const result = deps.stmtRenameSoundpack.run(name, pack.id, actor.roomId);
    if (result.changes !== 1)
      throw new SoundpackAccessError(404, 'SOUNDPACK_NOT_FOUND', '语音包不存在');
    deps.broadcastSoundpackEvent(actor.roomId, 'soundpack:renamed', { roomId: actor.roomId, soundId: pack.id, name });
    cb?.({ ok: true, name });
  });

  onRoomEvent('soundpack:reorder', (actor, request, cb) => {
    const orderedIds = request.orderedIds;
    if (!Array.isArray(orderedIds) || orderedIds.length > 500 || !orderedIds.every((id) => typeof id === 'string'))
      throw new SoundpackAccessError(400, 'INVALID_REQUEST', '无效的语音包顺序');
    const currentIds = (deps.stmtGetSoundpacks.all(actor.roomId) as SoundpackRecord[]).map((pack) => pack.id);
    const uniqueIds = new Set(orderedIds);
    if (orderedIds.length !== currentIds.length || uniqueIds.size !== currentIds.length || currentIds.some((id) => !uniqueIds.has(id)))
      throw new SoundpackAccessError(409, 'SOUNDPACK_LIST_CHANGED', '语音包列表已变化，请刷新后重试');
    deps.reorderSoundpacks(actor.roomId, orderedIds);
    deps.broadcastSoundpackEvent(actor.roomId, 'soundpack:reordered', { roomId: actor.roomId, orderedIds });
    cb?.({ ok: true });
  });
}
