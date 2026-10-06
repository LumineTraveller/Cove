import type * as BetterSqlite3 from 'better-sqlite3';

import { Server, type Socket } from 'socket.io';

import path from 'path';

import fs from 'fs';

import { peers } from '../media/ms';

import {
  RoomSettingsError,
  parseRoomLimit,
  validateRoomPassword,
  hashRoomPassword,
  verifyRoomPassword,
  assertRoomCapacity,
} from './roomSettings';

import { Room, PrivateRoom, MessageHistoryCursor } from '../../models';

export interface RegisterRoomsSocketHandlersDependencies {
  readonly socket: Socket<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly userClientIds: Map<string, string>;
  readonly stmtGetRoomOwners: BetterSqlite3.Statement<unknown[], unknown>;
  readonly socketAvatarPayload: <T>(socket: Socket, payload: T) => T;
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
  readonly stmtGetRoomPrivate: BetterSqlite3.Statement<unknown[], unknown>;
  readonly userNames: Map<string, string>;
  readonly roomMembers: Map<string, Set<string>>;
  readonly passwordAttemptKey: (clientId: string, roomId: string) => string;
  readonly roomPasswordAttempts: Map<string, { count: number; until: number }>;
  readonly stmtClaimRoom: BetterSqlite3.Statement<unknown[], unknown>;
  readonly emitAvatarPayload: (event: string, payload: unknown, roomId?: string) => void;
  readonly stopRemoteControlForSocket: (socketId: string, reason: string) => void;
  readonly handleVoiceLeave: (socketId: string, roomId: string) => void;
  readonly broadcastRoomMembers: (roomId: string) => void;
  readonly broadcastVoiceList: (roomId: string) => void;
  readonly emitForcedMuteState: (socketId: string, roomId: string) => void;
  readonly isMessageHistoryCursor: (value: unknown) => value is MessageHistoryCursor;
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
  readonly isRoomOwner: (roomId: string | undefined, socketId: string | undefined) => boolean;
  readonly sanitizeRoomAvatar: (
    value: unknown,
    fallback?: string | null,
    _roomId?: string,
  ) => string | null;
  readonly sanitizeRoomColor: (value: unknown, fallback?: string | null) => string | null;
  readonly DEFAULT_ROOM_COLOR: string;
  readonly DEFAULT_ROOM_DARK_TOP: string;
  readonly DEFAULT_ROOM_DARK_BOTTOM: string;
  readonly stmtUpdateRoomSettings: BetterSqlite3.Statement<unknown[], unknown>;
  readonly stmtGetRoom: { get: (id: string) => Room | undefined };
  readonly stmtMuteMember: BetterSqlite3.Statement<unknown[], unknown>;
  readonly stmtUnmuteMember: BetterSqlite3.Statement<unknown[], unknown>;
  readonly pausePeerAudio: (socketId: string, paused: boolean) => void;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly publicUserId: (socketId: string) => string;
  readonly stopRemoteControlForRoom: (roomId: string, reason: string) => void;
  readonly endAnnotationsForRoom: (roomId: string) => void;
  readonly voiceRooms: Map<string, Set<string>>;
  readonly broadcastVoiceCounts: () => void;
  readonly deleteRoomData: BetterSqlite3.Transaction<(roomId: string) => void>;
  readonly CHAT_IMAGES_DIR: string;
}

export function registerRoomsSocketHandlers(deps: RegisterRoomsSocketHandlersDependencies) {
  deps.socket.on(
    'rooms:get',
    (cb?: (result: { ok: true; rooms: Array<Room & { isOwner: boolean }> }) => void) => {
      const clientId = deps.userClientIds.get(deps.socket.id);
      const owners = new Map(
        (deps.stmtGetRoomOwners.all() as { id: string; ownerId: string | null }[]).map((row) => [
          row.id,
          row.ownerId,
        ]),
      );
      cb?.(
        deps.socketAvatarPayload(deps.socket, {
          ok: true,
          rooms: deps.stmtGetRooms
            .all()
            .map((room) => ({ ...room, isOwner: !!clientId && owners.get(room.id) === clientId })),
        }),
      );
    },
  );

  deps.socket.on('room:create', async (data, cb) => {
    try {
      cb?.(
        deps.socketAvatarPayload(deps.socket, {
          room: await deps.createRoomForSocket(deps.socket.id, data),
        }),
      );
    } catch (error) {
      cb?.(deps.roomError(error));
    }
  });

  let joinAttempt = 0;

  let joinPending = false;

  let settingsPending = false;

  deps.socket.on(
    'room:join',
    async (data: string | { roomId?: unknown; password?: unknown }, cb) => {
      if (joinPending) {
        cb?.(deps.roomError(new RoomSettingsError('RATE_LIMITED', '正在加入，请稍候')));
        return;
      }
      const attempt = ++joinAttempt;
      joinPending = true;
      try {
        const roomId = typeof data === 'string' ? data : data?.roomId;
        if (typeof roomId !== 'string') throw new RoomSettingsError('ROOM_NOT_FOUND', '房间不存在');
        const initialRoom = deps.stmtGetRoomPrivate.get(roomId) as PrivateRoom | undefined;
        const clientId = deps.userClientIds.get(deps.socket.id);
        if (!clientId || !deps.userNames.has(deps.socket.id))
          throw new RoomSettingsError('NOT_REGISTERED', '请先登录');
        if (!initialRoom) throw new RoomSettingsError('ROOM_NOT_FOUND', '房间不存在');
        const wasMember = deps.roomMembers.get(roomId)?.has(deps.socket.id);
        assertRoomCapacity(
          deps.roomMembers.get(roomId) ?? new Set(),
          deps.socket.id,
          initialRoom.maxMembers,
        );
        let verifiedPassword = false;
        if (!wasMember && initialRoom.ownerId !== clientId && initialRoom.passwordHash) {
          const password = typeof data === 'string' ? undefined : data.password;
          if (password === undefined || password === '')
            throw new RoomSettingsError('PASSWORD_REQUIRED', '请输入房间密码');
          const key = deps.passwordAttemptKey(clientId, roomId);
          if (
            !initialRoom.passwordSalt ||
            !(await verifyRoomPassword(
              password,
              initialRoom.passwordHash,
              initialRoom.passwordSalt,
            ))
          )
            throw new RoomSettingsError('INVALID_PASSWORD', '房间密码错误');
          deps.roomPasswordAttempts.delete(key);
          verifiedPassword = true;
        }
        if (
          !deps.socket.connected ||
          attempt !== joinAttempt ||
          deps.userClientIds.get(deps.socket.id) !== clientId
        )
          throw new RoomSettingsError('NOT_REGISTERED', '连接或入房请求已失效');
        const room = deps.stmtGetRoomPrivate.get(roomId) as PrivateRoom | undefined;
        if (!room) throw new RoomSettingsError('ROOM_NOT_FOUND', '房间已被删除');
        if (
          verifiedPassword &&
          (room.passwordHash !== initialRoom.passwordHash ||
            room.passwordSalt !== initialRoom.passwordSalt)
        )
          throw new RoomSettingsError('PASSWORD_REQUIRED', '房间密码已更新，请重新输入');
        // Final capacity check and reservation are synchronous, even after password hashing.
        const members = deps.roomMembers.get(roomId) ?? new Set<string>();
        assertRoomCapacity(members, deps.socket.id, room.maxMembers);
        if (!room.ownerId) {
          deps.stmtClaimRoom.run(clientId, deps.userNames.get(deps.socket.id), roomId);
          deps.emitAvatarPayload('rooms:updated', deps.stmtGetRooms.all());
        }
        const previousRoom = peers.get(deps.socket.id)?.roomId;
        if (previousRoom && previousRoom !== roomId) {
          deps.stopRemoteControlForSocket(deps.socket.id, '成员已切换房间');
          deps.handleVoiceLeave(deps.socket.id, previousRoom);
          deps.roomMembers.get(previousRoom)?.delete(deps.socket.id);
          deps.socket.leave(previousRoom);
          deps.broadcastRoomMembers(previousRoom);
        }
        deps.socket.join(roomId);
        members.add(deps.socket.id);
        deps.roomMembers.set(roomId, members);
        const peer = peers.get(deps.socket.id);
        if (peer) peer.roomId = roomId;
        deps.broadcastRoomMembers(roomId);
        deps.broadcastVoiceList(roomId);
        deps.emitForcedMuteState(deps.socket.id, roomId);
        cb?.({ ok: true });
      } catch (error) {
        cb?.(deps.roomError(error));
      } finally {
        joinPending = false;
      }
    },
  );

  deps.socket.on('room:history', (data: { roomId?: unknown; before?: unknown }, cb) => {
    const roomId = data?.roomId;
    if (typeof roomId !== 'string' || !deps.roomMembers.get(roomId)?.has(deps.socket.id)) {
      cb?.(deps.roomError(new RoomSettingsError('FORBIDDEN', '请先进入房间')));
      return;
    }
    if (
      data?.before !== undefined &&
      data.before !== null &&
      !deps.isMessageHistoryCursor(data.before)
    ) {
      cb?.(deps.roomError(new RoomSettingsError('INVALID_SETTINGS', '历史记录游标无效')));
      return;
    }
    const page = deps.getMessageHistory(
      roomId,
      deps.isMessageHistoryCursor(data?.before) ? data.before : undefined,
    );
    cb?.({ ok: true, ...page });
  });

  deps.socket.on(
    'room:update-settings',
    async (
      data: {
        roomId?: unknown;
        name?: unknown;
        maxMembers?: unknown;
        password?: unknown;
        avatarUrl?: unknown;
        backgroundTop?: unknown;
        backgroundBottom?: unknown;
        backgroundTopDark?: unknown;
        backgroundBottomDark?: unknown;
      },
      cb,
    ) => {
      if (settingsPending) {
        cb?.(deps.roomError(new RoomSettingsError('RATE_LIMITED', '正在保存，请稍候')));
        return;
      }
      settingsPending = true;
      try {
        const roomId = data?.roomId;
        if (typeof roomId !== 'string' || !deps.isRoomOwner(roomId, deps.socket.id))
          throw new RoomSettingsError('FORBIDDEN', '只有房主可以修改房间设置');
        const current = deps.stmtGetRoomPrivate.get(roomId) as PrivateRoom | undefined;
        if (!current) throw new RoomSettingsError('ROOM_NOT_FOUND', '房间不存在');
        const name =
          data.name === undefined
            ? current.name
            : (() => {
                if (
                  typeof data.name !== 'string' ||
                  !data.name.trim() ||
                  data.name.trim().length > 80
                )
                  throw new RoomSettingsError('INVALID_SETTINGS', '房间名称应为 1–80 个字符');
                return data.name.trim();
              })();
        const password = validateRoomPassword(data.password);
        const requestedLimit =
          data.maxMembers === undefined ? undefined : parseRoomLimit(data.maxMembers);
        const secret = password === undefined ? undefined : await hashRoomPassword(password);
        const avatarUrl =
          data.avatarUrl === undefined
            ? current.avatarUrl
            : deps.sanitizeRoomAvatar(data.avatarUrl, null, roomId);
        const backgroundTop =
          data.backgroundTop === undefined
            ? current.backgroundTop
            : deps.sanitizeRoomColor(data.backgroundTop, deps.DEFAULT_ROOM_COLOR);
        const backgroundBottom =
          data.backgroundBottom === undefined
            ? current.backgroundBottom
            : deps.sanitizeRoomColor(data.backgroundBottom, deps.DEFAULT_ROOM_COLOR);
        const backgroundTopDark =
          data.backgroundTopDark === undefined
            ? current.backgroundTopDark
            : deps.sanitizeRoomColor(data.backgroundTopDark, deps.DEFAULT_ROOM_DARK_TOP);
        const backgroundBottomDark =
          data.backgroundBottomDark === undefined
            ? current.backgroundBottomDark
            : deps.sanitizeRoomColor(data.backgroundBottomDark, deps.DEFAULT_ROOM_DARK_BOTTOM);
        if (!deps.socket.connected || !deps.isRoomOwner(roomId, deps.socket.id))
          throw new RoomSettingsError('FORBIDDEN', '房主身份已失效');
        deps.stmtUpdateRoomSettings.run(
          name,
          requestedLimit === undefined ? current.maxMembers : requestedLimit,
          secret ? secret.passwordHash : current.passwordHash,
          secret ? secret.passwordSalt : current.passwordSalt,
          avatarUrl,
          backgroundTop,
          backgroundBottom,
          backgroundTopDark,
          backgroundBottomDark,
          roomId,
        );
        deps.broadcastRoomMembers(roomId);
        deps.emitAvatarPayload('rooms:updated', deps.stmtGetRooms.all());
        cb?.(
          deps.socketAvatarPayload(deps.socket, { ok: true, room: deps.stmtGetRoom.get(roomId) }),
        );
      } catch (error) {
        cb?.(deps.roomError(error));
      } finally {
        settingsPending = false;
      }
    },
  );

  deps.socket.on('room:leave', (roomId: string) => {
    joinAttempt += 1;
    deps.stopRemoteControlForSocket(deps.socket.id, '成员已离开频道');
    deps.handleVoiceLeave(deps.socket.id, roomId);
    deps.roomMembers.get(roomId)?.delete(deps.socket.id);
    deps.socket.leave(roomId);
    deps.broadcastRoomMembers(roomId);
    const peer = peers.get(deps.socket.id);
    if (peer?.roomId === roomId) peer.roomId = null;
  });

  // ── 房主操作 ─────────────────────────────────────────────────────────────

  deps.socket.on(
    'room:set-muted',
    (
      { roomId, targetSocketId, muted }: { roomId: string; targetSocketId: string; muted: boolean },
      cb?: (result: { ok: boolean; error?: string }) => void,
    ) => {
      const room = deps.stmtGetRoomPrivate.get(roomId) as PrivateRoom | undefined;
      const actorClientId = deps.userClientIds.get(deps.socket.id);
      const targetClientId = deps.userClientIds.get(targetSocketId);
      const targetName = deps.userNames.get(targetSocketId);
      const members = deps.roomMembers.get(roomId);

      if (!room || !actorClientId || room.ownerId !== actorClientId) {
        cb?.({ ok: false, error: '只有房主可以禁言成员' });
        return;
      }
      if (
        !members?.has(deps.socket.id) ||
        !members.has(targetSocketId) ||
        !targetClientId ||
        !targetName
      ) {
        cb?.({ ok: false, error: '目标成员不在房间中' });
        return;
      }
      if (targetClientId === room.ownerId) {
        cb?.({ ok: false, error: '不能禁言房主' });
        return;
      }

      if (muted) deps.stmtMuteMember.run(roomId, targetClientId, targetName, Date.now());
      else deps.stmtUnmuteMember.run(roomId, targetClientId);

      // 同一客户端重连或开了多个窗口时，对它在该房间的所有连接同时生效。
      for (const memberSocketId of members) {
        if (deps.userClientIds.get(memberSocketId) !== targetClientId) continue;
        deps.pausePeerAudio(memberSocketId, muted);
        deps.emitForcedMuteState(memberSocketId, roomId);
      }
      deps.broadcastRoomMembers(roomId);
      deps.broadcastVoiceList(roomId);
      cb?.({ ok: true });
    },
  );

  deps.socket.on(
    'room:kick',
    (
      { roomId, targetSocketId }: { roomId: string; targetSocketId: string },
      cb?: (result: { ok: boolean; error?: string }) => void,
    ) => {
      const room = deps.stmtGetRoomPrivate.get(roomId) as PrivateRoom | undefined;
      const actorClientId = deps.userClientIds.get(deps.socket.id);
      const targetClientId = deps.userClientIds.get(targetSocketId);
      const targetName = deps.userNames.get(targetSocketId);
      const members = deps.roomMembers.get(roomId);

      if (!room || !actorClientId || room.ownerId !== actorClientId) {
        cb?.({ ok: false, error: '只有房主可以移除成员' });
        return;
      }
      if (
        !members?.has(deps.socket.id) ||
        !members.has(targetSocketId) ||
        !targetClientId ||
        !targetName
      ) {
        cb?.({ ok: false, error: '目标成员不在房间中' });
        return;
      }
      if (targetClientId === room.ownerId || targetSocketId === deps.socket.id) {
        cb?.({ ok: false, error: '不能移除房主' });
        return;
      }

      deps.handleVoiceLeave(targetSocketId, roomId);
      deps.stopRemoteControlForSocket(targetSocketId, '成员已被移出频道');
      members.delete(targetSocketId);
      const targetSocket = deps.io.sockets.sockets.get(targetSocketId);
      targetSocket?.leave(roomId);
      const peer = peers.get(targetSocketId);
      if (peer?.roomId === roomId) peer.roomId = null;
      deps.io.to(targetSocketId).emit('room:kicked', {
        roomId,
        by: deps.userNames.get(deps.socket.id) ?? '房主',
        byUserId: deps.publicUserId(deps.socket.id),
      });
      deps.broadcastRoomMembers(roomId);
      cb?.({ ok: true });
    },
  );

  deps.socket.on(
    'room:delete',
    ({ roomId }: { roomId: string }, cb?: (result: { ok: boolean; error?: string }) => void) => {
      const room = deps.stmtGetRoomPrivate.get(roomId) as PrivateRoom | undefined;
      const actorClientId = deps.userClientIds.get(deps.socket.id);
      if (!room || !actorClientId || room.ownerId !== actorClientId) {
        cb?.({ ok: false, error: '只有房主可以删除房间' });
        return;
      }

      const members = [...(deps.roomMembers.get(roomId) ?? new Set<string>())];
      deps.stopRemoteControlForRoom(roomId, '频道已被删除');
      deps.endAnnotationsForRoom(roomId);
      deps.io.to(roomId).emit('room:deleted', { roomId });
      for (const memberSocketId of members) {
        deps.handleVoiceLeave(memberSocketId, roomId);
        const peer = peers.get(memberSocketId);
        if (peer?.roomId === roomId) peer.roomId = null;
        deps.io.sockets.sockets.get(memberSocketId)?.leave(roomId);
      }
      deps.roomMembers.delete(roomId);
      deps.voiceRooms.delete(roomId);
      deps.broadcastVoiceCounts();
      deps.deleteRoomData(roomId);
      fs.rmSync(path.join(deps.CHAT_IMAGES_DIR, roomId), { recursive: true, force: true });
      deps.emitAvatarPayload('rooms:updated', deps.stmtGetRooms.all());
      deps.io.emit('room:members:global', { roomId, members: [] });
      cb?.({ ok: true });
    },
  );
  return { joinAttempt, joinPending, settingsPending };
}
