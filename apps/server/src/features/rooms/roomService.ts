import type * as BetterSqlite3 from 'better-sqlite3';

import { Server } from 'socket.io';

import { randomUUID } from 'crypto';

import {
  RoomSettingsError,
  parseRoomLimit,
  validateRoomPassword,
  hashRoomPassword,
} from './roomSettings';

import { Room, PrivateRoom } from '../../models';

export interface CreateRoomServiceDependencies {
  readonly roomMembers: Map<string, Set<string>>;
  readonly stmtGetRoomPrivate: BetterSqlite3.Statement<unknown[], unknown>;
  readonly userClientIds: Map<string, string>;
  readonly avatarStorage: {
    directory: string;
    save: (value: unknown) => string | null;
    reference: (value: string) => string | null;
  };
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly userNames: Map<string, string>;
  readonly publicUserId: (socketId: string) => string;
  readonly stmtInsertRoom: BetterSqlite3.Statement<unknown[], unknown>;
  readonly emitAvatarPayload: (event: string, payload: unknown, roomId?: string) => void;
  readonly stmtGetRooms: { all: () => Room[] };
}

export function createRoomService(deps: CreateRoomServiceDependencies) {
  function isRoomOwner(roomId: string | undefined, socketId: string | undefined): boolean {
    if (!roomId || !socketId || !deps.roomMembers.get(roomId)?.has(socketId)) return false;
    const room = deps.stmtGetRoomPrivate.get(roomId) as PrivateRoom | undefined;
    const clientId = deps.userClientIds.get(socketId);
    return !!room?.ownerId && !!clientId && room.ownerId === clientId;
  }

  function roomError(error: unknown) {
    return error instanceof RoomSettingsError
      ? { ok: false as const, error: error.message, code: error.code }
      : { ok: false as const, error: '房间操作失败，请重试', code: 'INVALID_SETTINGS' };
  }

  const ROOM_COLOR_RE = /^#[0-9a-f]{6}$/i;

  const DEFAULT_ROOM_COLOR = '#FFFFFF';

  const DEFAULT_ROOM_DARK_TOP = '#111827';

  const DEFAULT_ROOM_DARK_BOTTOM = '#0B1220';

  function sanitizeRoomColor(value: unknown, fallback: string | null = null): string | null {
    if (value == null || value === '') return fallback;
    if (typeof value !== 'string' || !ROOM_COLOR_RE.test(value.trim()))
      throw new RoomSettingsError('INVALID_SETTINGS', '房间背景颜色必须是六位 HEX 颜色代码');
    return value.trim().toUpperCase();
  }

  function sanitizeRoomAvatar(
    value: unknown,
    fallback: string | null = null,
    _roomId?: string,
  ): string | null {
    if (value == null || value === '') return fallback;
    const saved = deps.avatarStorage.save(value);
    if (!saved) throw new RoomSettingsError('INVALID_SETTINGS', '房间头像格式不受支持或文件过大');
    return saved;
  }

  function sanitizeProfileAvatar(value: unknown): string | null {
    if (value == null || value === '') return null;
    return deps.avatarStorage.save(value);
  }

  const roomCreationPending = new Set<string>();

  async function createRoomForSocket(
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
  ) {
    if (
      typeof socketId !== 'string' ||
      !deps.io.sockets.sockets.get(socketId)?.connected ||
      !deps.userClientIds.has(socketId)
    )
      throw new RoomSettingsError('NOT_REGISTERED', '请先连接并登录');
    if (roomCreationPending.has(socketId))
      throw new RoomSettingsError('RATE_LIMITED', '正在创建，请稍候');
    if (typeof data?.name !== 'string' || !data.name.trim() || data.name.trim().length > 80)
      throw new RoomSettingsError('INVALID_SETTINGS', '房间名称应为 1–80 个字符');
    const name = data.name.trim();
    const maxMembers = parseRoomLimit(data.maxMembers);
    const password = validateRoomPassword(data.password);
    const ownerId = deps.userClientIds.get(socketId)!;
    roomCreationPending.add(socketId);
    try {
      const secret = await hashRoomPassword(password);
      if (
        !deps.io.sockets.sockets.get(socketId)?.connected ||
        deps.userClientIds.get(socketId) !== ownerId
      )
        throw new RoomSettingsError('NOT_REGISTERED', '登录连接已失效，请重试');
      const newRoomId = randomUUID();
      const room = {
        id: newRoomId,
        name,
        createdAt: Date.now(),
        ownerName: deps.userNames.get(socketId) ?? '',
        ownerUserId: deps.publicUserId(socketId),
        maxMembers,
        hasPassword: secret.passwordHash !== null,
        avatarUrl: sanitizeRoomAvatar(data?.avatarUrl, null, newRoomId),
        backgroundTop: sanitizeRoomColor(data?.backgroundTop, DEFAULT_ROOM_COLOR),
        backgroundBottom: sanitizeRoomColor(data?.backgroundBottom, DEFAULT_ROOM_COLOR),
        backgroundTopDark: sanitizeRoomColor(data?.backgroundTopDark, DEFAULT_ROOM_DARK_TOP),
        backgroundBottomDark: sanitizeRoomColor(
          data?.backgroundBottomDark,
          DEFAULT_ROOM_DARK_BOTTOM,
        ),
      };
      deps.stmtInsertRoom.run(
        room.id,
        room.name,
        room.createdAt,
        ownerId,
        room.ownerName,
        maxMembers,
        secret.passwordHash,
        secret.passwordSalt,
        room.avatarUrl,
        room.backgroundTop,
        room.backgroundBottom,
        room.backgroundTopDark,
        room.backgroundBottomDark,
      );
      deps.emitAvatarPayload('rooms:updated', deps.stmtGetRooms.all());
      return room;
    } finally {
      roomCreationPending.delete(socketId);
    }
  }

  const roomPasswordAttempts = new Map<string, { count: number; until: number }>();

  function passwordAttemptKey(clientId: string, roomId: string) {
    const now = Date.now();
    for (const [key, value] of roomPasswordAttempts)
      if (value.until <= now) roomPasswordAttempts.delete(key);
    const key = `${clientId}:${roomId}`;
    if ((roomPasswordAttempts.get(key)?.count ?? 0) >= 5)
      throw new RoomSettingsError('RATE_LIMITED', '密码尝试过于频繁，请一分钟后再试');
    if (roomPasswordAttempts.size >= 10_000 && !roomPasswordAttempts.has(key))
      throw new RoomSettingsError('RATE_LIMITED', '请求过多，请稍后再试');
    const current = roomPasswordAttempts.get(key) ?? { count: 0, until: now + 60_000 };
    current.count += 1;
    roomPasswordAttempts.set(key, current);
    return key;
  }
  return {
    isRoomOwner,
    roomError,
    ROOM_COLOR_RE,
    DEFAULT_ROOM_COLOR,
    DEFAULT_ROOM_DARK_TOP,
    DEFAULT_ROOM_DARK_BOTTOM,
    sanitizeRoomColor,
    sanitizeRoomAvatar,
    sanitizeProfileAvatar,
    roomCreationPending,
    createRoomForSocket,
    roomPasswordAttempts,
    passwordAttemptKey,
  };
}
