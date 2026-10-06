import type * as BetterSqlite3 from 'better-sqlite3';
import express from 'express';

import { Server } from 'socket.io';

import { Room } from '../../models';

export interface RegisterAccountsRoutesDependencies {
  readonly app: import('express-serve-static-core').Express;
  readonly requestAvatarPayload: <T>(req: express.Request, payload: T) => T;
  readonly accounts: {
    register(
      emailValue: string,
      password: string,
      usernameValue: string,
    ): Promise<{ account: import('./accountAuth').PublicAccount; token: string }>;
    login(
      emailValue: string,
      password: string,
    ): Promise<{ account: import('./accountAuth').PublicAccount; token: string }>;
    accountForToken(token: unknown): import('./accountAuth').PublicAccount | null;
    logout(token: unknown): void;
    updateProfile(accountId: string, username: string, avatarUrl: string | null): void;
  };
  readonly authResponse: (error: unknown, res: express.Response) => void;
  readonly replaceAccountSocket: (accountId: string) => void;
  readonly accountTokenForRequest: (req: express.Request, bodyToken?: unknown) => string;
  readonly sanitizeProfileAvatar: (value: unknown) => string | null;
  readonly accountSockets: Map<string, string>;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly userNames: Map<string, string>;
  readonly userAvatars: Map<string, string | null>;
  readonly stmtUpdateOwnerName: BetterSqlite3.Statement<unknown[], unknown>;
  readonly emitAvatarPayload: (event: string, payload: unknown, roomId?: string) => void;
  readonly stmtGetRooms: { all: () => Room[] };
  readonly broadcastOnlineUsers: () => void;
  readonly roomMembers: Map<string, Set<string>>;
  readonly broadcastRoomMembers: (roomId: string) => void;
  readonly broadcastVoiceList: (roomId: string) => void;
}

export function registerAccountsRoutes(deps: RegisterAccountsRoutesDependencies) {
  deps.app.post('/api/auth/register', async (req, res) => {
    const { email, password, username } = req.body as {
      email?: unknown;
      password?: unknown;
      username?: unknown;
    };
    if (typeof email !== 'string' || typeof password !== 'string' || typeof username !== 'string') {
      res.status(400).json({ error: '请填写邮箱、密码和用户名' });
      return;
    }
    try {
      res
        .status(201)
        .json(
          deps.requestAvatarPayload(req, await deps.accounts.register(email, password, username)),
        );
    } catch (error) {
      deps.authResponse(error, res);
    }
  });

  deps.app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body as { email?: unknown; password?: unknown };
    if (typeof email !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: '请填写邮箱和密码' });
      return;
    }
    try {
      const result = await deps.accounts.login(email, password);
      deps.replaceAccountSocket(result.account.id);
      res.json(deps.requestAvatarPayload(req, result));
    } catch (error) {
      deps.authResponse(error, res);
    }
  });

  deps.app.post('/api/auth/profile', (req, res) => {
    const body = req.body as
      | { token?: unknown; username?: unknown; avatarUrl?: unknown }
      | undefined;
    const token = deps.accountTokenForRequest(req, body?.token);
    const account = deps.accounts.accountForToken(token);
    if (!account) {
      res.status(401).json({ error: '登录已失效，请重新登录' });
      return;
    }
    if (
      typeof body?.username !== 'string' ||
      !body.username.trim() ||
      body.username.trim().length > 64
    ) {
      res.status(400).json({ error: '用户名不能为空' });
      return;
    }
    const username = body.username.trim().slice(0, 64);
    const requestedAvatar = body.avatarUrl;
    const avatarUrl =
      requestedAvatar === undefined
        ? account.avatarUrl
        : deps.sanitizeProfileAvatar(requestedAvatar);
    if (
      requestedAvatar !== undefined &&
      requestedAvatar !== null &&
      requestedAvatar !== '' &&
      avatarUrl === null
    ) {
      res.status(400).json({ error: '头像格式不受支持或文件过大' });
      return;
    }
    deps.accounts.updateProfile(account.id, username, avatarUrl);
    const socketId = deps.accountSockets.get(account.id);
    const activeSocket = socketId ? deps.io.sockets.sockets.get(socketId) : undefined;
    if (socketId && activeSocket?.connected) {
      deps.userNames.set(socketId, username);
      deps.userAvatars.set(socketId, avatarUrl);
      const updated = deps.stmtUpdateOwnerName.run(username, `account:${account.id}`, username);
      if (updated.changes > 0) deps.emitAvatarPayload('rooms:updated', deps.stmtGetRooms.all());
      deps.broadcastOnlineUsers();
      for (const [roomId, members] of deps.roomMembers) {
        if (!members.has(socketId)) continue;
        deps.broadcastRoomMembers(roomId);
        deps.broadcastVoiceList(roomId);
      }
    }
    res.json({ ok: true });
  });

  deps.app.post('/api/auth/logout', (req, res) => {
    deps.accounts.logout(deps.accountTokenForRequest(req, req.body?.token));
    res.status(204).end();
  });
  return {};
}
