import type * as BetterSqlite3 from 'better-sqlite3';

import { Server, type Socket } from 'socket.io';

import { sanitizeClientPlatform, type ClientPlatform } from '../sessions/presence';

import { Room } from '../../models';

export interface RegisterAccountsSocketHandlersDependencies {
  readonly socket: Socket<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
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
  readonly accountSockets: Map<string, string>;
  readonly userNames: Map<string, string>;
  readonly socketAvatarPayload: <T>(socket: Socket, payload: T) => T;
  readonly userAvatars: Map<string, string | null>;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly cleanupDisconnectedPeer: (socketId: string) => void;
  readonly migrateLegacyIdentity: BetterSqlite3.Transaction<
    (legacyId: string, accountId: string) => void
  >;
  readonly stmtMigrateLegacyOwnersByName: BetterSqlite3.Statement<unknown[], unknown>;
  readonly emitAvatarPayload: (event: string, payload: unknown, roomId?: string) => void;
  readonly stmtGetRooms: { all: () => Room[] };
  readonly sanitizeProfileAvatar: (value: unknown) => string | null;
  readonly userClientIds: Map<string, string>;
  readonly userPlatforms: Map<string, ClientPlatform>;
  readonly remoteControlCapabilities: Set<string>;
  readonly stmtUpdateOwnerName: BetterSqlite3.Statement<unknown[], unknown>;
  readonly refreshProfileViews: () => void;
  readonly voiceCounts: () => { [k: string]: number };
}

export function registerAccountsSocketHandlers(deps: RegisterAccountsSocketHandlersDependencies) {
  deps.socket.on(
    'user:register',
    (
      registration:
        | string
        | {
            username?: string;
            clientId?: string;
            authToken?: string;
            avatarUrl?: unknown;
            platform?: unknown;
            remoteControlSupported?: unknown;
          },
      cb?: (result: {
        ok: boolean;
        error?: string;
        code?: string;
        profile?: { username: string; avatarUrl: string | null };
      }) => void,
    ) => {
      const startedAt = Date.now();
      const account =
        typeof registration === 'string'
          ? null
          : deps.accounts.accountForToken(registration?.authToken);
      if (typeof registration === 'string' || !registration?.authToken) {
        cb?.({ ok: false, error: '请升级客户端并先登录账号', code: 'ACCOUNT_AUTH_REQUIRED' });
        return;
      }
      if (!account) {
        cb?.({ ok: false, error: '登录已失效，请重新登录', code: 'ACCOUNT_SESSION_INVALID' });
        return;
      }
      const boundAccountId = deps.socket.data.accountId as string | undefined;
      if (boundAccountId && boundAccountId !== account?.id) {
        cb?.({
          ok: false,
          error: '此连接已绑定其他账号，请重新连接',
          code: 'ACCOUNT_SWITCH_FORBIDDEN',
        });
        return;
      }
      // A lost/delayed acknowledgement may trigger the same request again. Do
      // not amplify congestion by repeating all room and presence broadcasts.
      if (
        boundAccountId === account.id &&
        deps.accountSockets.get(account.id) === deps.socket.id &&
        deps.socket.data.authToken === registration.authToken &&
        deps.userNames.has(deps.socket.id)
      ) {
        cb?.(
          deps.socketAvatarPayload(deps.socket, {
            ok: true,
            profile: {
              username: deps.userNames.get(deps.socket.id)!,
              avatarUrl: deps.userAvatars.get(deps.socket.id) ?? null,
            },
          }),
        );
        console.log(
          `[registration] socket=${deps.socket.id} reused=true ackMs=${Date.now() - startedAt}`,
        );
        return;
      }
      const submittedName =
        account?.username ??
        (typeof registration === 'string' ? registration : registration?.username);
      const username = typeof submittedName === 'string' ? submittedName.trim() : '';
      const submittedClientId = typeof registration === 'string' ? '' : registration?.clientId;
      const suppliedClientId =
        typeof submittedClientId === 'string' ? submittedClientId.trim() : '';
      if (!username) {
        cb?.({ ok: false, error: '用户名不能为空' });
        return;
      }
      if (account) {
        const previousSocketId = deps.accountSockets.get(account.id);
        if (previousSocketId && previousSocketId !== deps.socket.id) {
          const previousSocket = deps.io.sockets.sockets.get(previousSocketId);
          // A second live connection with the same current token is usually an
          // automatic reconnect racing the first one. Keep the owner stable;
          // only a fresh REST login is allowed to replace it.
          if (
            previousSocket?.connected &&
            previousSocket.data.authToken === (registration as { authToken?: string }).authToken
          ) {
            cb?.({
              ok: false,
              error: '账号已在其他设备使用，请先退出另一端',
              code: 'SESSION_IN_USE',
            });
            return;
          }
          // A disconnected grace socket may no longer be in Socket.IO's map.
          // Remove its state before accepting the new connection.
          deps.cleanupDisconnectedPeer(previousSocketId);
          previousSocket?.disconnect(true);
        }
        deps.accountSockets.set(account.id, deps.socket.id);
      }

      // 旧客户端没有 clientId 时仍可聊天，但它的身份只在本次连接内有效。
      const clientId = account
        ? `account:${account.id}`
        : suppliedClientId &&
          !suppliedClientId.startsWith('account:') &&
          suppliedClientId.length >= 16 &&
          suppliedClientId.length <= 128
        ? suppliedClientId
        : `socket:${deps.socket.id}`;
      if (
        account &&
        suppliedClientId &&
        !suppliedClientId.startsWith('account:') &&
        suppliedClientId.length >= 16 &&
        suppliedClientId.length <= 128
      )
        deps.migrateLegacyIdentity(suppliedClientId, clientId);
      if (account) {
        const migratedOwners = deps.stmtMigrateLegacyOwnersByName.run(
          clientId,
          username.slice(0, 64),
          username.slice(0, 64),
        );
        if (migratedOwners.changes > 0)
          deps.emitAvatarPayload('rooms:updated', deps.stmtGetRooms.all());
      }
      deps.userNames.set(deps.socket.id, username.slice(0, 64));
      deps.userAvatars.set(
        deps.socket.id,
        deps.sanitizeProfileAvatar(
          account?.avatarUrl ?? (typeof registration === 'string' ? null : registration.avatarUrl),
        ),
      );
      deps.userClientIds.set(deps.socket.id, clientId);
      deps.socket.data.authToken =
        account && typeof registration !== 'string' ? registration.authToken : undefined;
      deps.socket.data.accountId = account?.id;
      const platform = sanitizeClientPlatform(
        typeof registration === 'string' ? null : registration.platform,
      );
      if (platform) deps.userPlatforms.set(deps.socket.id, platform);
      else deps.userPlatforms.delete(deps.socket.id);
      if (
        platform === 'desktop' &&
        typeof registration !== 'string' &&
        registration.remoteControlSupported === true
      )
        deps.remoteControlCapabilities.add(deps.socket.id);
      else deps.remoteControlCapabilities.delete(deps.socket.id);

      // 同一设备更改用户名后，同步更新它所拥有房间的公开房主名。
      const updated = deps.stmtUpdateOwnerName.run(
        username.slice(0, 64),
        clientId,
        username.slice(0, 64),
      );
      const acknowledgement = deps.socketAvatarPayload(deps.socket, {
        ok: true,
        profile: {
          username: deps.userNames.get(deps.socket.id) ?? username.slice(0, 64),
          avatarUrl: deps.userAvatars.get(deps.socket.id) ?? null,
        },
      });
      cb?.(acknowledgement);
      console.log(
        `[registration] socket=${deps.socket.id} reused=false ackMs=${
          Date.now() - startedAt
        } ackBytes=${Buffer.byteLength(JSON.stringify(acknowledgement))}`,
      );
      if (updated.changes > 0) deps.emitAvatarPayload('rooms:updated', deps.stmtGetRooms.all());
      deps.refreshProfileViews();
      deps.socket.emit('voice:counts', deps.voiceCounts());
    },
  );

  deps.socket.on(
    'user:update-profile',
    (
      update: { username?: string; avatarUrl?: unknown },
      cb?: (result: { ok: boolean; error?: string }) => void,
    ) => {
      const username = update?.username?.trim().slice(0, 64);
      const clientId = deps.userClientIds.get(deps.socket.id);
      if (!username || !clientId) {
        cb?.({ ok: false, error: '用户尚未注册' });
        return;
      }
      const avatarUrl = deps.sanitizeProfileAvatar(update.avatarUrl);
      if (update.avatarUrl != null && update.avatarUrl !== '' && !avatarUrl) {
        cb?.({ ok: false, error: '头像格式不受支持或文件过大' });
        return;
      }
      deps.userNames.set(deps.socket.id, username);
      deps.userAvatars.set(deps.socket.id, avatarUrl);
      if (clientId.startsWith('account:'))
        deps.accounts.updateProfile(clientId.slice('account:'.length), username, avatarUrl);
      const updated = deps.stmtUpdateOwnerName.run(username, clientId, username);
      if (updated.changes > 0) deps.emitAvatarPayload('rooms:updated', deps.stmtGetRooms.all());
      deps.refreshProfileViews();
      cb?.({ ok: true });
    },
  );
  return {};
}
