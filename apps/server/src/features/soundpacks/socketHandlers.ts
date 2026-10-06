import type * as BetterSqlite3 from 'better-sqlite3';

import { Server, type Socket } from 'socket.io';

import path from 'path';

import fs from 'fs';

import { soundpackVoiceAudience } from './soundpackAudience';

import { Message, SoundpackRecord } from '../../models';

export interface RegisterSoundpacksSocketHandlersDependencies {
  readonly socket: Socket<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly stmtGetSoundpack: BetterSqlite3.Statement<unknown[], unknown>;
  readonly roomMembers: Map<string, Set<string>>;
  readonly voiceRooms: Map<string, Set<string>>;
  readonly userNames: Map<string, string>;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly publicUserId: (socketId: string) => string;
  readonly userClientIds: Map<string, string>;
  readonly isRoomOwner: (roomId: string | undefined, socketId: string | undefined) => boolean;
  readonly stmtDeleteSoundpack: BetterSqlite3.Statement<unknown[], unknown>;
  readonly SOUNDS_DIR: string;
  readonly stmtRenameSoundpack: BetterSqlite3.Statement<unknown[], unknown>;
  readonly stmtGetSoundpacks: BetterSqlite3.Statement<unknown[], unknown>;
  readonly reorderSoundpacks: BetterSqlite3.Transaction<(orderedIds: string[]) => void>;
}

export function registerSoundpacksSocketHandlers(
  deps: RegisterSoundpacksSocketHandlersDependencies,
) {
  // ── 语音包 ────────────────────────────────────────────────────────────────

  deps.socket.on(
    'soundpack:play',
    (
      { soundId, roomId }: { soundId: string; roomId: string },
      cb?: (result: { ok: boolean; error?: string }) => void,
    ) => {
      const pack = deps.stmtGetSoundpack.get(soundId) as SoundpackRecord | undefined;
      if (!pack) {
        cb?.({ ok: false, error: '语音包不存在' });
        return;
      }
      const audience = soundpackVoiceAudience(
        deps.roomMembers.get(roomId),
        deps.voiceRooms.get(roomId),
        deps.socket.id,
      );
      if (!audience) {
        cb?.({ ok: false, error: '请先加入语音再播放语音包' });
        return;
      }
      const playedBy = deps.userNames.get(deps.socket.id) ?? deps.socket.id;
      // 包括发送者在内，只有当前仍在语音中的成员会收到音频播放事件。
      // 发送者也等待此权威事件再播放，避免频道成员通过篡改客户端绕过限制。
      for (const targetSocketId of audience)
        deps.io.to(targetSocketId).emit('soundpack:play', {
          soundId,
          filename: pack.filename,
          playedBy,
          playedByUserId: deps.publicUserId(deps.socket.id),
          soundName: pack.name,
        });

      const msg: Message = {
        id: Math.random().toString(36).slice(2, 9),
        roomId,
        author: playedBy,
        authorUserId: deps.publicUserId(deps.socket.id),
        contentUserId: deps.publicUserId(deps.socket.id),
        contentUsername: playedBy,
        content: `${playedBy} 播放了「${pack.name}」`,
        type: 'soundpack',
        timestamp: Date.now(),
      };
      // 语音包播放记录只对当前在线成员可见，离开频道后不再恢复。
      deps.io.to(roomId).emit('message:new', msg);
      cb?.({ ok: true });
    },
  );

  deps.socket.on(
    'soundpack:delete',
    (
      { soundId, roomId }: { soundId?: string; roomId?: string },
      cb?: (result: { ok: boolean; error?: string }) => void,
    ) => {
      const pack = soundId
        ? (deps.stmtGetSoundpack.get(soundId) as SoundpackRecord | undefined)
        : undefined;
      const actorClientId = deps.userClientIds.get(deps.socket.id);
      const actorName = deps.userNames.get(deps.socket.id);
      if (!pack) {
        cb?.({ ok: false, error: '语音包不存在或已被删除' });
        return;
      }
      const ownsPack =
        !!actorClientId &&
        (pack.uploaderId ? pack.uploaderId === actorClientId : pack.uploader === actorName);
      if (!ownsPack && !deps.isRoomOwner(roomId, deps.socket.id)) {
        cb?.({ ok: false, error: '只能由上传者或当前房主删除语音包' });
        return;
      }

      deps.stmtDeleteSoundpack.run(pack.id);
      for (const safeFilename of new Set(
        [pack.filename, pack.originalFilename]
          .filter((name): name is string => !!name)
          .map((name) => path.basename(name)),
      )) {
        try {
          fs.rmSync(path.join(deps.SOUNDS_DIR, safeFilename), { force: true });
        } catch (error) {
          console.warn(`[soundpack] 删除文件失败 ${safeFilename}:`, error);
        }
      }
      deps.io.emit('soundpack:deleted', { soundId: pack.id });
      cb?.({ ok: true });
    },
  );

  deps.socket.on(
    'soundpack:rename',
    (
      { soundId, roomId, name }: { soundId?: string; roomId?: string; name?: string },
      cb?: (result: { ok: boolean; error?: string; name?: string }) => void,
    ) => {
      const pack = soundId
        ? (deps.stmtGetSoundpack.get(soundId) as SoundpackRecord | undefined)
        : undefined;
      const nextName = name?.trim().slice(0, 64);
      const actorClientId = deps.userClientIds.get(deps.socket.id);
      const actorName = deps.userNames.get(deps.socket.id);
      if (!pack) {
        cb?.({ ok: false, error: '语音包不存在或已被删除' });
        return;
      }
      if (!nextName) {
        cb?.({ ok: false, error: '名称不能为空' });
        return;
      }
      const ownsPack =
        !!actorClientId &&
        (pack.uploaderId ? pack.uploaderId === actorClientId : pack.uploader === actorName);
      if (!ownsPack && !deps.isRoomOwner(roomId, deps.socket.id)) {
        cb?.({ ok: false, error: '只能由上传者或当前房主修改名称' });
        return;
      }

      deps.stmtRenameSoundpack.run(nextName, pack.id);
      deps.io.emit('soundpack:renamed', { soundId: pack.id, name: nextName });
      cb?.({ ok: true, name: nextName });
    },
  );

  deps.socket.on(
    'soundpack:reorder',
    (
      { orderedIds, roomId }: { orderedIds?: string[]; roomId?: string },
      cb?: (result: { ok: boolean; error?: string }) => void,
    ) => {
      if (!roomId || !deps.roomMembers.get(roomId)?.has(deps.socket.id)) {
        cb?.({ ok: false, error: '请先进入房间' });
        return;
      }
      if (!Array.isArray(orderedIds) || orderedIds.length > 500) {
        cb?.({ ok: false, error: '无效的语音包顺序' });
        return;
      }

      const currentIds = (deps.stmtGetSoundpacks.all() as SoundpackRecord[]).map((pack) => pack.id);
      const uniqueIds = new Set(orderedIds);
      if (
        orderedIds.length !== currentIds.length ||
        uniqueIds.size !== currentIds.length ||
        currentIds.some((id) => !uniqueIds.has(id))
      ) {
        cb?.({ ok: false, error: '语音包列表已变化，请刷新后重试' });
        return;
      }

      deps.reorderSoundpacks(orderedIds);
      deps.io.emit('soundpack:reordered', { orderedIds });
      cb?.({ ok: true });
    },
  );
  return {};
}
