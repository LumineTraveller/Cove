import type { Request, Response } from 'express';
import type { Server, Socket } from 'socket.io';
import type { PublicAccount } from '../accounts/accountAuth';

export class SoundpackAccessError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'SoundpackAccessError';
  }
}

export interface SoundpackActor {
  readonly roomId: string;
  readonly socketId: string;
  readonly accountId: string;
  readonly accountToken: string;
  readonly clientId: string;
  readonly username: string;
}

interface SoundpackAccessDependencies {
  readonly accounts: { accountForToken(token: unknown): PublicAccount | null };
  readonly accountSockets: Map<string, string>;
  readonly userClientIds: Map<string, string>;
  readonly roomMembers: Map<string, Set<string>>;
  readonly io: Pick<Server, 'sockets'>;
  readonly roomExists: (roomId: string) => boolean;
  readonly hasServerAccess: (socket: Socket) => boolean;
}

export function createSoundpackAccess(deps: SoundpackAccessDependencies) {
  const requireActor = (token: unknown, roomValue: unknown, expectedSocketId?: string): SoundpackActor => {
    if (typeof token !== 'string' || !token)
      throw new SoundpackAccessError(401, 'ACCOUNT_AUTH_REQUIRED', '请先登录账号');
    const account = deps.accounts.accountForToken(token);
    if (!account)
      throw new SoundpackAccessError(401, 'ACCOUNT_SESSION_INVALID', '登录已失效，请重新登录');
    if (typeof roomValue !== 'string' || !roomValue || roomValue.length > 128)
      throw new SoundpackAccessError(400, 'ROOM_REQUIRED', '请指定当前房间');
    const socketId = deps.accountSockets.get(account.id);
    const socket = socketId ? deps.io.sockets.sockets.get(socketId) : undefined;
    const clientId = `account:${account.id}`;
    if (
      !socketId || !socket?.connected ||
      (expectedSocketId !== undefined && socketId !== expectedSocketId) ||
      socket.data.accountId !== account.id || socket.data.authToken !== token ||
      deps.userClientIds.get(socketId) !== clientId
    )
      throw new SoundpackAccessError(401, 'ACCOUNT_SESSION_INVALID', '登录连接已失效，请重新连接');
    if (!deps.hasServerAccess(socket))
      throw new SoundpackAccessError(401, 'SERVER_ACCESS_INVALID', '请重新验证服务器访问密码');
    if (
      !deps.roomExists(roomValue) ||
      !deps.roomMembers.get(roomValue)?.has(socketId) || !socket.rooms.has(roomValue)
    )
      throw new SoundpackAccessError(403, 'ROOM_ACCESS_DENIED', '请先进入该房间');
    return { roomId: roomValue, socketId, accountId: account.id, accountToken: token, clientId, username: account.username };
  };

  const httpRoomActor = (req: Pick<Request, 'get'>, roomId: unknown) =>
    requireActor(req.get('x-cove-account-token'), roomId);
  const socketRoomActor = (socket: Socket, roomId: unknown) =>
    requireActor(socket.data.authToken, roomId, socket.id);
  const revalidateActor = (actor: SoundpackActor) =>
    requireActor(actor.accountToken, actor.roomId, actor.socketId);

  return { httpRoomActor, socketRoomActor, revalidateActor };
}

export type SoundpackAccess = ReturnType<typeof createSoundpackAccess>;

export function soundpackErrorResponse(error: unknown, res: Pick<Response, 'status'>) {
  if (error instanceof SoundpackAccessError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: '语音包服务暂时不可用', code: 'SOUNDPACK_UNAVAILABLE' });
}
