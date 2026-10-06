import { createDatabase } from '../features/storage/database';
import { createSecurityServices } from '../features/security/securityStore';
import { createRepositories } from '../features/storage/repositories';
import { createAvatarService } from '../features/profiles/avatarService';
import { createSessionState } from '../features/sessions/sessionState';
import { createIdentityService } from '../features/sessions/identity';
import { createRoomService } from '../features/rooms/roomService';
import { createSoundpackService } from '../features/soundpacks/soundpackService';
import { createHttpSecurity } from '../features/security/httpSecurity';
import {clientUpgradePolicy, clientUpgradeError, isClientIdentitySupported, requestClientIdentity, requireClientVersion} from '../features/security/clientVersion';
import { createMediaService } from '../features/media/mediaService';
import { createVoiceService } from '../features/voice/voiceService';
import { createMembershipService } from '../features/rooms/membershipService';
import { createMuteService } from '../features/media/muteService';
import { createControlService } from '../features/remote-control/controlService';
import { createPresenceService } from '../features/sessions/presenceService';
import { createCleanupService } from '../features/sessions/cleanupService';
import { registerSecurityRoutes } from '../features/security/httpRoutes';
import { registerAccountsRoutes } from '../features/accounts/httpRoutes';
import { registerSoundpacksRoutes } from '../features/soundpacks/httpRoutes';
import { registerRoomsRoutes } from '../features/rooms/httpRoutes';
import { registerAccountsSocketHandlers } from '../features/accounts/socketHandlers';
import { registerRoomsSocketHandlers } from '../features/rooms/socketHandlers';
import { registerRemoteControlSocketHandlers } from '../features/remote-control/socketHandlers';
import { registerChatSocketHandlers } from '../features/chat/socketHandlers';
import { registerVoiceSocketHandlers } from '../features/voice/socketHandlers';
import { registerMediaSocketHandlers } from '../features/media/socketHandlers';
import { createAnnotationService } from '../features/annotations/annotationService';
import { registerAnnotationSocketHandlers } from '../features/annotations/socketHandlers';
import { registerSoundpacksSocketHandlers } from '../features/soundpacks/socketHandlers';
import express from 'express';
import { createServer } from 'http';
import { Server, type Socket } from 'socket.io';
import cors from 'cors';

import path from 'path';

import fs from 'fs';

import { initMediasoup, closeMediasoup, peers, createPeer } from '../features/media/ms';
import { createLobbyPresenceSnapshot } from '../features/sessions/presence';

import { normalizeSoundpack } from '../features/soundpacks/soundpackNormalization';

import { AccountAuthError } from '../features/accounts/accountAuth';

import {
  isClientProtocolSupported,
  isServerSecurityEnabled,
  isSecureSocket,
  ServerSecurityError,
} from '../features/security/serverSecurity';
import { DisconnectGrace, DISCONNECT_GRACE_MS } from '../features/sessions/disconnectGrace';

import { StoredMessage, MessageHistoryCursor, SoundpackRecord } from '../models';

export function createServerRuntime() {
  const app = express();

  const httpServer = createServer(app);

  app.use(cors({ origin: '*' }));

  app.use(express.json({ limit: '15mb' }));
  // These probes and release files stay public so an unsupported client can
  // learn how to update before either password or account authentication.
  app.get('/api/version', (req, res) => {
    const identity = requestClientIdentity(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json(clientUpgradePolicy(identity.version, identity.platform, identity.protocol));
  });
  app.use('/api', (req, res, next) => {
    if (req.path === '/security/status' && req.method === 'GET') { next(); return; }
    requireClientVersion(req, res, next);
  });

  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    // Uploads may contain an 8 MiB GIF. Outbound avatars use file URLs instead.
    maxHttpBufferSize: 16 * 1024 * 1024,
    // Keep packet offsets slightly longer than the 5s peer deadline. Otherwise
    // a quiet client's last offset may expire before its recovery window ends.
    connectionStateRecovery: {
      maxDisconnectionDuration: DISCONNECT_GRACE_MS * 2,
      skipMiddlewares: false,
    },
  });

  const disconnectGrace = new DisconnectGrace();

  const serverSecurityEnabled = isServerSecurityEnabled();

  const SERVER_ACCESS_INVALID_NOTICE = {
    code: 'SERVER_ACCESS_INVALID',
    message: '服务器访问令牌已失效，请重新验证服务器密码',
  } as const;

  function disconnectForInvalidServerAccess(targetSocket: Socket): void {
    if (targetSocket.data.serverAccessInvalidated) return;
    targetSocket.data.serverAccessInvalidated = true;
    // Stop room broadcasts immediately. The short flush window below is only
    // for delivering the recovery notice, not for retaining room membership.
    for (const room of [...targetSocket.rooms]) {
      if (room !== targetSocket.id) void targetSocket.leave(room);
    }
    targetSocket.emit('server:access-invalid', SERVER_ACCESS_INVALID_NOTICE);
    // The database-backed middleware already rejects further packets. Yield one
    // turn so Socket.IO can flush the reason before the server closes the socket.
    setImmediate(() => {
      if (targetSocket.connected) targetSocket.disconnect(true);
    });
  }

  const recoveryCheckpoint = setInterval(() => io.emit('session:checkpoint'), 2_000);

  recoveryCheckpoint.unref();

  httpServer.on('close', () => {
    clearInterval(recoveryCheckpoint);
    disconnectGrace.clear();
  });
  const { dataDir, releaseFilesDir, db } = createDatabase({});
  const { serverSecurity, accounts } = createSecurityServices({
    get dataDir() {
      return dataDir;
    },
    get db() {
      return db;
    },
    get serverSecurityEnabled() {
      return serverSecurityEnabled;
    },
    get io() {
      return io;
    },
    get disconnectForInvalidServerAccess() {
      return disconnectForInvalidServerAccess;
    },
  });
  const {
    stmtGetRooms,
    stmtGetRoom,
    stmtGetRoomPrivate,
    stmtGetRoomOwners,
    stmtInsertRoom,
    stmtUpdateRoomSettings,
    stmtClaimRoom,
    stmtUpdateOwnerName,
    stmtMigrateLegacyOwnersByName,
    CHAT_HISTORY_PAGE_SIZE,
    stmtGetLatestMessagesPage,
    stmtGetOlderMessagesPage,
    stmtInsertMsg,
    stmtIsRoomMuted,
    stmtMuteMember,
    stmtUnmuteMember,
    stmtGetSoundpacks,
    stmtGetSoundpack,
    stmtGetNextSoundpackOrder,
    stmtInsertSoundpack,
    stmtGetLegacySoundpacks,
    stmtMarkSoundpackNormalized,
    stmtRenameSoundpack,
    stmtDeleteSoundpack,
    migrateLegacyIdentity,
    reorderSoundpacks,
    deleteRoomData,
  } = createRepositories({
    get db() {
      return db;
    },
    get toPublicRoom() {
      return toPublicRoom;
    },
  });

  function isMessageHistoryCursor(value: unknown): value is MessageHistoryCursor {
    if (!value || typeof value !== 'object') return false;
    const cursor = value as Record<string, unknown>;
    return (
      Number.isSafeInteger(cursor.timestamp) &&
      typeof cursor.id === 'string' &&
      cursor.id.length > 0
    );
  }

  function getMessageHistory(roomId: string, before?: MessageHistoryCursor) {
    const rows = (
      before
        ? stmtGetOlderMessagesPage.all(
            roomId,
            before.timestamp,
            before.timestamp,
            before.id,
            CHAT_HISTORY_PAGE_SIZE + 1,
          )
        : stmtGetLatestMessagesPage.all(roomId, CHAT_HISTORY_PAGE_SIZE + 1)
    ) as StoredMessage[];
    const hasMore = rows.length > CHAT_HISTORY_PAGE_SIZE;
    const messages = rows
      .slice(0, CHAT_HISTORY_PAGE_SIZE)
      .reverse()
      .map(({ authorId, ...message }) => ({
        ...message,
        authorUserId: authorId ? publicUserIdForStableId(authorId) : null,
      }));
    const oldest = messages[0];
    return {
      messages,
      hasMore,
      cursor: oldest ? { timestamp: oldest.timestamp, id: oldest.id } : null,
    };
  }
  const {
    SOUNDS_DIR,
    avatarStorage,
    migrateAvatars,
    socketAvatarPayload,
    requestAvatarPayload,
    emitAvatarPayload,
  } = createAvatarService({
    get dataDir() {
      return dataDir;
    },
    get db() {
      return db;
    },
    get serverSecurityEnabled() {
      return serverSecurityEnabled;
    },
    get requestServerAccessToken() {
      return requestServerAccessToken;
    },
    get io() {
      return io;
    },
  });

  let legacyNormalizationPromise: Promise<void> | null = null;

  let legacyNormalizationStopped = false;

  async function normalizeLegacySoundpacks(): Promise<void> {
    for (const pack of stmtGetLegacySoundpacks.all() as SoundpackRecord[]) {
      if (legacyNormalizationStopped) break;
      const originalFilename = path.basename(pack.filename);
      const source = path.join(SOUNDS_DIR, originalFilename);
      const filename = `${pack.id}.normalized.mp3`;
      const destination = path.join(SOUNDS_DIR, filename);
      const temporary = path.join(SOUNDS_DIR, `${pack.id}.normalizing.mp3`);
      if (!fs.existsSync(source)) {
        console.warn(`[soundpack] 跳过缺失的原文件 ${pack.id}`);
        continue;
      }
      try {
        await normalizeSoundpack(source, temporary);
        // Deletion may happen while FFmpeg is running. Leave the old file in
        // place and only switch the database after the new file is complete.
        const current = stmtGetSoundpack.get(pack.id) as SoundpackRecord | undefined;
        if (legacyNormalizationStopped || !current || current.filename !== pack.filename) continue;
        fs.renameSync(temporary, destination);
        stmtMarkSoundpackNormalized.run(filename, originalFilename, pack.id, pack.filename);
        io.emit('soundpack:normalized', { soundId: pack.id, filename, originalFilename });
      } catch (error) {
        console.warn(`[soundpack] 旧语音包 ${pack.id} 标准化失败，继续使用原文件`, error);
      } finally {
        try {
          fs.rmSync(temporary, { force: true });
        } catch {
          /* retry on next start */
        }
      }
    }
  }

  const CHAT_IMAGES_DIR = path.join(dataDir, 'chat-images');

  fs.mkdirSync(CHAT_IMAGES_DIR, { recursive: true });
  const {
    userNames,
    userAvatars,
    userClientIds,
    accountSockets,
    userPlatforms,
    remoteControlCapabilities,
    remoteControls,
    voiceRooms,
    roomMembers,
    selfMutedVoiceMembers,
  } = createSessionState({});
  const { publicUserId, publicUserIdForStableId, toPublicRoom } = createIdentityService({
    get userClientIds() {
      return userClientIds;
    },
  });
  const {
    isRoomOwner,
    roomError,
    DEFAULT_ROOM_COLOR,
    DEFAULT_ROOM_DARK_TOP,
    DEFAULT_ROOM_DARK_BOTTOM,
    sanitizeRoomColor,
    sanitizeRoomAvatar,
    sanitizeProfileAvatar,
    createRoomForSocket,
    roomPasswordAttempts,
    passwordAttemptKey,
  } = createRoomService({
    get roomMembers() {
      return roomMembers;
    },
    get stmtGetRoomPrivate() {
      return stmtGetRoomPrivate;
    },
    get userClientIds() {
      return userClientIds;
    },
    get avatarStorage() {
      return avatarStorage;
    },
    get io() {
      return io;
    },
    get userNames() {
      return userNames;
    },
    get publicUserId() {
      return publicUserId;
    },
    get stmtInsertRoom() {
      return stmtInsertRoom;
    },
    get emitAvatarPayload() {
      return emitAvatarPayload;
    },
    get stmtGetRooms() {
      return stmtGetRooms;
    },
  });
  const { toPublicSoundpack, broadcastSoundpackAdded } = createSoundpackService({
    get userClientIds() {
      return userClientIds;
    },
    get userNames() {
      return userNames;
    },
    get isRoomOwner() {
      return isRoomOwner;
    },
    get publicUserIdForStableId() {
      return publicUserIdForStableId;
    },
    get io() {
      return io;
    },
  });
  const {
    securityDenied,
    outdatedClient,
    requireSecureTransport,
    requireServerSecurityEnabled,
    requestServerAccessToken,
    requireServerAccess,
  } = createHttpSecurity({
    get serverSecurityEnabled() {
      return serverSecurityEnabled;
    },
    get serverSecurity() {
      return serverSecurity;
    },
  });
  registerSecurityRoutes({
    get app() {
      return app;
    },
    get serverSecurityEnabled() {
      return serverSecurityEnabled;
    },
    get securityDenied() {
      return securityDenied;
    },
    get serverSecurity() {
      return serverSecurity;
    },
    get requireServerSecurityEnabled() {
      return requireServerSecurityEnabled;
    },
    get requireSecureTransport() {
      return requireSecureTransport;
    },
    get requireServerAccess() {
      return requireServerAccess;
    },
  });

  const requirePrivateStaticAccess = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!serverSecurityEnabled) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    requireServerAccess(req, res, next, true);
  };

  app.use(
    '/sounds',
    requirePrivateStaticAccess,
    express.static(SOUNDS_DIR, { cacheControl: false }),
  );

  app.use(
    '/chat-images',
    requirePrivateStaticAccess,
    express.static(CHAT_IMAGES_DIR, {
      fallthrough: false,
      cacheControl: false,
    }),
  );

  app.use(
    '/avatars',
    requirePrivateStaticAccess,
    express.static(avatarStorage.directory, {
      fallthrough: false,
      index: false,
      maxAge: serverSecurityEnabled ? 0 : '1y',
      immutable: !serverSecurityEnabled,
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    }),
  );

  app.use(
    '/downloads',
    express.static(path.join(releaseFilesDir, 'downloads'), {
      fallthrough: false,
      index: false,
    }),
  );

  app.use(
    '/releases',
    express.static(path.join(releaseFilesDir, 'releases'), {
      fallthrough: false,
      index: false,
    }),
  );

  app.use('/api', requireServerAccess);

  const distPath = path.join(__dirname, '../../../desktop/dist');

  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const authResponse = (error: unknown, res: express.Response) => {
    if (error instanceof AccountAuthError) res.status(error.status).json({ error: error.message });
    else {
      console.error('[auth]', error);
      res.status(500).json({ error: '账号服务暂时不可用' });
    }
  };

  function accountTokenForRequest(req: express.Request, bodyToken?: unknown): string {
    const headerToken = req.get('x-cove-account-token');
    if (headerToken) return headerToken;
    return typeof bodyToken === 'string' ? bodyToken : '';
  }
  registerAccountsRoutes({
    get app() {
      return app;
    },
    get requestAvatarPayload() {
      return requestAvatarPayload;
    },
    get accounts() {
      return accounts;
    },
    get authResponse() {
      return authResponse;
    },
    get replaceAccountSocket() {
      return replaceAccountSocket;
    },
    get accountTokenForRequest() {
      return accountTokenForRequest;
    },
    get sanitizeProfileAvatar() {
      return sanitizeProfileAvatar;
    },
    get accountSockets() {
      return accountSockets;
    },
    get io() {
      return io;
    },
    get userNames() {
      return userNames;
    },
    get userAvatars() {
      return userAvatars;
    },
    get stmtUpdateOwnerName() {
      return stmtUpdateOwnerName;
    },
    get emitAvatarPayload() {
      return emitAvatarPayload;
    },
    get stmtGetRooms() {
      return stmtGetRooms;
    },
    get broadcastOnlineUsers() {
      return broadcastOnlineUsers;
    },
    get roomMembers() {
      return roomMembers;
    },
    get broadcastRoomMembers() {
      return broadcastRoomMembers;
    },
    get broadcastVoiceList() {
      return broadcastVoiceList;
    },
  });
  registerSoundpacksRoutes({
    get app() {
      return app;
    },
    get stmtGetSoundpacks() {
      return stmtGetSoundpacks;
    },
    get toPublicSoundpack() {
      return toPublicSoundpack;
    },
    get userClientIds() {
      return userClientIds;
    },
    get userNames() {
      return userNames;
    },
    get SOUNDS_DIR() {
      return SOUNDS_DIR;
    },
    get stmtGetNextSoundpackOrder() {
      return stmtGetNextSoundpackOrder;
    },
    get stmtInsertSoundpack() {
      return stmtInsertSoundpack;
    },
    get broadcastSoundpackAdded() {
      return broadcastSoundpackAdded;
    },
  });
  registerRoomsRoutes({
    get app() {
      return app;
    },
    get requestAvatarPayload() {
      return requestAvatarPayload;
    },
    get stmtGetRooms() {
      return stmtGetRooms;
    },
    get createRoomForSocket() {
      return createRoomForSocket;
    },
    get roomError() {
      return roomError;
    },
    get stmtGetRoom() {
      return stmtGetRoom;
    },
    get getMessageHistory() {
      return getMessageHistory;
    },
    get CHAT_IMAGE_TYPES() {
      return CHAT_IMAGE_TYPES;
    },
    get userClientIds() {
      return userClientIds;
    },
    get roomMembers() {
      return roomMembers;
    },
    get validChatImage() {
      return validChatImage;
    },
    get CHAT_IMAGES_DIR() {
      return CHAT_IMAGES_DIR;
    },
    get userNames() {
      return userNames;
    },
    get publicUserId() {
      return publicUserId;
    },
    get stmtInsertMsg() {
      return stmtInsertMsg;
    },
    get io() {
      return io;
    },
  });

  const CHAT_IMAGE_TYPES = new Map([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
  ]);

  function validChatImage(buffer: Buffer, mimeType: string): boolean {
    if (mimeType === 'image/png')
      return buffer
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (mimeType === 'image/jpeg')
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (mimeType === 'image/webp')
      return (
        buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP'
      );
    if (mimeType === 'image/gif')
      return ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString());
    return false;
  }
  const {
    onDemandMediaType,
    findProducerOwner,
    mediaDiagnosticsForPeer,
    syncOnDemandProducer,
    closePeerConsumer,
  } = createMediaService({
    get isSocketMuted() {
      return isSocketMuted;
    },
    get io() {
      return io;
    },
  });
  let removeAnnotationMember = (_socketId: string, _roomId?: string) => {};
  const {
    currentVoiceList,
    broadcastVoiceList,
    voiceCounts,
    broadcastVoiceCounts,
    announceVoicePresence,
    handleVoiceLeave,
  } = createVoiceService({
    get voiceRooms() {
      return voiceRooms;
    },
    get publicUserId() {
      return publicUserId;
    },
    get userNames() {
      return userNames;
    },
    get userAvatars() {
      return userAvatars;
    },
    get isSocketMuted() {
      return isSocketMuted;
    },
    get selfMutedVoiceMembers() {
      return selfMutedVoiceMembers;
    },
    get emitAvatarPayload() {
      return emitAvatarPayload;
    },
    get io() {
      return io;
    },
    get stopRemoteControlForSocket() {
      return stopRemoteControlForSocket;
    },
    get closePeerConsumer() {
      return closePeerConsumer;
    },
    get broadcastRoomMembers() {
      return broadcastRoomMembers;
    },
    get removeAnnotationMember() {
      return removeAnnotationMember;
    },
  });
  const { broadcastRoomMembers, isSocketMuted } = createMembershipService({
    get roomMembers() {
      return roomMembers;
    },
    get stmtGetRoomPrivate() {
      return stmtGetRoomPrivate;
    },
    get userClientIds() {
      return userClientIds;
    },
    get publicUserId() {
      return publicUserId;
    },
    get userNames() {
      return userNames;
    },
    get userAvatars() {
      return userAvatars;
    },
    get userPlatforms() {
      return userPlatforms;
    },
    get remoteControlCapabilities() {
      return remoteControlCapabilities;
    },
    get io() {
      return io;
    },
    get socketAvatarPayload() {
      return socketAvatarPayload;
    },
    get publicUserIdForStableId() {
      return publicUserIdForStableId;
    },
    get stmtIsRoomMuted() {
      return stmtIsRoomMuted;
    },
  });
  const { emitForcedMuteState, pausePeerAudio, pausePeerMicrophone, isSharingScreen } =
    createMuteService({
      get io() {
        return io;
      },
      get isSocketMuted() {
        return isSocketMuted;
      },
      get syncOnDemandProducer() {
        return syncOnDemandProducer;
      },
      get selfMutedVoiceMembers() {
        return selfMutedVoiceMembers;
      },
    });
  const {
    emitRemoteControlStopped,
    emitRemoteRequestCancelled,
    stopRemoteControlForSocket,
    stopRemoteControlForRoom,
  } = createControlService({
    get io() {
      return io;
    },
    get remoteControls() {
      return remoteControls;
    },
  });
  const annotations = createAnnotationService({
    get io() {
      return io;
    },
    get roomMembers() {
      return roomMembers;
    },
    get userNames() {
      return userNames;
    },
    currentScreenSessionId(roomId, sharerSocketId) {
      const peer = peers.get(sharerSocketId);
      if (peer?.roomId !== roomId) return null;
      for (const producer of peer.producers.values()) {
        if (
          !producer.closed &&
          (producer.appData as Record<string, unknown>).type === 'screen'
        )
          return producer.id;
      }
      return null;
    },
    get stopRemoteControlForSocket() {
      return stopRemoteControlForSocket;
    },
  });
  removeAnnotationMember = annotations.removeMember;
  const { broadcastOnlineUsers, publicUserIdsBySocket } = createPresenceService({
    get emitAvatarPayload() {
      return emitAvatarPayload;
    },
    get userNames() {
      return userNames;
    },
    get userAvatars() {
      return userAvatars;
    },
    get roomMembers() {
      return roomMembers;
    },
    get voiceRooms() {
      return voiceRooms;
    },
    get userPlatforms() {
      return userPlatforms;
    },
    get publicUserId() {
      return publicUserId;
    },
  });
  const { cleanupDisconnectedPeer, replaceAccountSocket } = createCleanupService({
    get disconnectGrace() {
      return disconnectGrace;
    },
    get stopRemoteControlForSocket() {
      return stopRemoteControlForSocket;
    },
    get voiceRooms() {
      return voiceRooms;
    },
    get handleVoiceLeave() {
      return handleVoiceLeave;
    },
    get removeAnnotationMember() {
      return removeAnnotationMember;
    },
    get roomMembers() {
      return roomMembers;
    },
    get broadcastRoomMembers() {
      return broadcastRoomMembers;
    },
    get userNames() {
      return userNames;
    },
    get userAvatars() {
      return userAvatars;
    },
    get userClientIds() {
      return userClientIds;
    },
    get userPlatforms() {
      return userPlatforms;
    },
    get remoteControlCapabilities() {
      return remoteControlCapabilities;
    },
    get accountSockets() {
      return accountSockets;
    },
    get broadcastOnlineUsers() {
      return broadcastOnlineUsers;
    },
    get io() {
      return io;
    },
  });

  io.use((socket, next) => {
    const identity = socket.handshake.auth as {clientVersion?: unknown; clientPlatform?: unknown; clientProtocol?: unknown} | undefined;
    if (!isClientIdentitySupported(identity?.clientVersion, identity?.clientPlatform, identity?.clientProtocol)) {
      const upgrade = clientUpgradeError(identity?.clientVersion, identity?.clientPlatform, identity?.clientProtocol);
      const transportError = new Error(upgrade.error) as Error & {data?: typeof upgrade};
      transportError.data = upgrade;
      next(transportError);
      return;
    }
    socket.data.clientVersion = identity?.clientVersion;
    socket.data.clientPlatform = identity?.clientPlatform;
    socket.data.clientProtocol = identity?.clientProtocol;
    if (!serverSecurityEnabled) {
      next();
      return;
    }
    const deny = (error: ServerSecurityError) => {
      const transportError = new Error(error.message) as Error & { data?: { code: string } };
      transportError.data = { code: error.code };
      next(transportError);
    };
    const auth = socket.handshake.auth as
      | { serverAccessToken?: unknown; serverToken?: unknown; clientProtocol?: unknown }
      | undefined;
    if (!isClientProtocolSupported(auth?.clientProtocol)) {
      deny(outdatedClient());
      return;
    }
    if (!isSecureSocket(socket)) {
      deny(
        new ServerSecurityError(
          426,
          'INSECURE_TRANSPORT',
          '公网连接必须使用 HTTPS/WSS，请改用安全的服务器地址',
        ),
      );
      return;
    }
    const serverAccessToken = auth?.serverAccessToken ?? auth?.serverToken;
    if (!serverSecurity.status().configured) {
      deny(
        new ServerSecurityError(
          503,
          'SERVER_NOT_INITIALIZED',
          '服务器尚未初始化，请先设置服务器访问密码',
        ),
      );
      return;
    }
    const access = serverSecurity.accessForToken(serverAccessToken);
    if (!access) {
      deny(
        new ServerSecurityError(
          401,
          'SERVER_ACCESS_REQUIRED',
          '需要先验证服务器访问密码，请升级客户端或先完成服务器初始化',
        ),
      );
      return;
    }
    socket.data.serverAccessToken = serverAccessToken;
    socket.data.serverAccessEpoch = access.epoch;
    socket.data.serverAccessExpiresAt = access.expiresAt;
    next();
  });

  const recoveryAdapter = io.of('/').adapter;

  const restoreSession = recoveryAdapter.restoreSession.bind(recoveryAdapter);

  recoveryAdapter.restoreSession = async (pid, offset) => {
    const session = await restoreSession(pid, offset);
    if (session) {
      const data = session.data as { authToken?: string; serverAccessToken?: string; clientVersion?: unknown; clientPlatform?: unknown; clientProtocol?: unknown };
      const token = data?.authToken;
      const serverAccessToken = data?.serverAccessToken;
      if (
        !peers.has(session.sid) ||
        !isClientIdentitySupported(data.clientVersion, data.clientPlatform, data.clientProtocol) ||
        (serverSecurityEnabled && !serverSecurity.accessForToken(serverAccessToken)) ||
        (token && !accounts.accountForToken(token))
      ) {
        // Socket.IO falls back to a fresh connection if snapshot restoration throws.
        throw new Error('Recovery session no longer valid');
      }
      const allowedRooms = session.rooms.filter(
        (roomId) => roomId === session.sid || roomMembers.get(roomId)?.has(session.sid),
      );
      if (allowedRooms.length !== session.rooms.length) {
        // Preserve the kick/delete notification so the client leaves its room UI,
        // but never replay chat/media data or restore access to a revoked room.
        session.rooms = allowedRooms;
        session.missedPackets = session.missedPackets.filter(
          (packet) => packet[0] === 'room:kicked' || packet[0] === 'room:deleted',
        );
      }
    }
    return session;
  };

  io.on('connection', (socket) => {
    console.log(`[+] ${socket.id} recovered=${socket.recovered}`);
    // Handshake authentication alone would leave a long-lived socket usable
    // after its bearer expires or after the server password is rotated. Check
    // the database-backed session before every client packet as well, then
    // force a reconnect so the client can obtain a fresh grant.
    if (serverSecurityEnabled) {
      socket.use((_packet, next) => {
        if (serverSecurity.accessForToken(socket.data.serverAccessToken)) {
          next();
          return;
        }
        const error = new Error(SERVER_ACCESS_INVALID_NOTICE.message) as Error & {
          data?: { code: string };
        };
        error.data = { code: SERVER_ACCESS_INVALID_NOTICE.code };
        next(error);
        disconnectForInvalidServerAccess(socket);
      });
      const accessExpiryTimer = setTimeout(() => {
        if (!serverSecurity.accessForToken(socket.data.serverAccessToken))
          disconnectForInvalidServerAccess(socket);
      }, Math.max(1, Number(socket.data.serverAccessExpiresAt ?? Date.now()) - Date.now() + 1));
      accessExpiryTimer.unref();
      socket.once('disconnect', () => clearTimeout(accessExpiryTimer));
    }
    disconnectGrace.recover(socket.id);
    if (!peers.has(socket.id)) createPeer(socket.id);
    // A kick/deletion during the outage must not restore stale room access.
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id && !roomMembers.get(roomId)?.has(socket.id)) socket.leave(roomId);
    }
    socket.emit('session:checkpoint');

    const refreshProfileViews = () => {
      broadcastOnlineUsers();
      for (const [roomId, members] of roomMembers) {
        if (!members.has(socket.id)) continue;
        broadcastRoomMembers(roomId);
        broadcastVoiceList(roomId);
      }
    };
    registerAccountsSocketHandlers({
      get socket() {
        return socket;
      },
      get accounts() {
        return accounts;
      },
      get accountSockets() {
        return accountSockets;
      },
      get userNames() {
        return userNames;
      },
      get socketAvatarPayload() {
        return socketAvatarPayload;
      },
      get userAvatars() {
        return userAvatars;
      },
      get io() {
        return io;
      },
      get cleanupDisconnectedPeer() {
        return cleanupDisconnectedPeer;
      },
      get migrateLegacyIdentity() {
        return migrateLegacyIdentity;
      },
      get stmtMigrateLegacyOwnersByName() {
        return stmtMigrateLegacyOwnersByName;
      },
      get emitAvatarPayload() {
        return emitAvatarPayload;
      },
      get stmtGetRooms() {
        return stmtGetRooms;
      },
      get sanitizeProfileAvatar() {
        return sanitizeProfileAvatar;
      },
      get userClientIds() {
        return userClientIds;
      },
      get userPlatforms() {
        return userPlatforms;
      },
      get remoteControlCapabilities() {
        return remoteControlCapabilities;
      },
      get stmtUpdateOwnerName() {
        return stmtUpdateOwnerName;
      },
      get refreshProfileViews() {
        return refreshProfileViews;
      },
      get voiceCounts() {
        return voiceCounts;
      },
    });

    socket.on(
      'presence:get',
      (cb?: (result: ReturnType<typeof createLobbyPresenceSnapshot> & { ok: true }) => void) => {
        if (!userNames.has(socket.id)) return;
        cb?.(
          socketAvatarPayload(socket, {
            ok: true,
            ...createLobbyPresenceSnapshot(
              userNames,
              userAvatars,
              roomMembers,
              voiceRooms,
              userPlatforms,
              publicUserIdsBySocket(),
            ),
          }),
        );
      },
    );
    const {} = registerRoomsSocketHandlers({
      get socket() {
        return socket;
      },
      get userClientIds() {
        return userClientIds;
      },
      get stmtGetRoomOwners() {
        return stmtGetRoomOwners;
      },
      get socketAvatarPayload() {
        return socketAvatarPayload;
      },
      get stmtGetRooms() {
        return stmtGetRooms;
      },
      get createRoomForSocket() {
        return createRoomForSocket;
      },
      get roomError() {
        return roomError;
      },
      get stmtGetRoomPrivate() {
        return stmtGetRoomPrivate;
      },
      get userNames() {
        return userNames;
      },
      get roomMembers() {
        return roomMembers;
      },
      get passwordAttemptKey() {
        return passwordAttemptKey;
      },
      get roomPasswordAttempts() {
        return roomPasswordAttempts;
      },
      get stmtClaimRoom() {
        return stmtClaimRoom;
      },
      get emitAvatarPayload() {
        return emitAvatarPayload;
      },
      get stopRemoteControlForSocket() {
        return stopRemoteControlForSocket;
      },
      get handleVoiceLeave() {
        return handleVoiceLeave;
      },
      get broadcastRoomMembers() {
        return broadcastRoomMembers;
      },
      get broadcastVoiceList() {
        return broadcastVoiceList;
      },
      get emitForcedMuteState() {
        return emitForcedMuteState;
      },
      get isMessageHistoryCursor() {
        return isMessageHistoryCursor;
      },
      get getMessageHistory() {
        return getMessageHistory;
      },
      get isRoomOwner() {
        return isRoomOwner;
      },
      get sanitizeRoomAvatar() {
        return sanitizeRoomAvatar;
      },
      get sanitizeRoomColor() {
        return sanitizeRoomColor;
      },
      get DEFAULT_ROOM_COLOR() {
        return DEFAULT_ROOM_COLOR;
      },
      get DEFAULT_ROOM_DARK_TOP() {
        return DEFAULT_ROOM_DARK_TOP;
      },
      get DEFAULT_ROOM_DARK_BOTTOM() {
        return DEFAULT_ROOM_DARK_BOTTOM;
      },
      get stmtUpdateRoomSettings() {
        return stmtUpdateRoomSettings;
      },
      get stmtGetRoom() {
        return stmtGetRoom;
      },
      get stmtMuteMember() {
        return stmtMuteMember;
      },
      get stmtUnmuteMember() {
        return stmtUnmuteMember;
      },
      get pausePeerAudio() {
        return pausePeerAudio;
      },
      get io() {
        return io;
      },
      get publicUserId() {
        return publicUserId;
      },
      get stopRemoteControlForRoom() {
        return stopRemoteControlForRoom;
      },
      get endAnnotationsForRoom() {
        return annotations.endForRoom;
      },
      get voiceRooms() {
        return voiceRooms;
      },
      get broadcastVoiceCounts() {
        return broadcastVoiceCounts;
      },
      get deleteRoomData() {
        return deleteRoomData;
      },
      get CHAT_IMAGES_DIR() {
        return CHAT_IMAGES_DIR;
      },
    });
    registerRemoteControlSocketHandlers({
      get socket() {
        return socket;
      },
      get roomMembers() {
        return roomMembers;
      },
      get remoteControlCapabilities() {
        return remoteControlCapabilities;
      },
      get isSharingScreen() {
        return isSharingScreen;
      },
      get isRemoteControlAllowed() {
        return annotations.remoteControlAllowed;
      },
      get remoteControls() {
        return remoteControls;
      },
      get io() {
        return io;
      },
      get userNames() {
        return userNames;
      },
      get publicUserId() {
        return publicUserId;
      },
      get emitRemoteRequestCancelled() {
        return emitRemoteRequestCancelled;
      },
      get emitRemoteControlStopped() {
        return emitRemoteControlStopped;
      },
    });
    registerChatSocketHandlers({
      get socket() {
        return socket;
      },
      get stmtGetRoom() {
        return stmtGetRoom;
      },
      get roomMembers() {
        return roomMembers;
      },
      get userNames() {
        return userNames;
      },
      get publicUserId() {
        return publicUserId;
      },
      get stmtInsertMsg() {
        return stmtInsertMsg;
      },
      get userClientIds() {
        return userClientIds;
      },
      get io() {
        return io;
      },
    });
    registerVoiceSocketHandlers({
      get socket() {
        return socket;
      },
      get stmtGetRoom() {
        return stmtGetRoom;
      },
      get roomMembers() {
        return roomMembers;
      },
      get voiceRooms() {
        return voiceRooms;
      },
      get socketAvatarPayload() {
        return socketAvatarPayload;
      },
      get currentVoiceList() {
        return currentVoiceList;
      },
      get selfMutedVoiceMembers() {
        return selfMutedVoiceMembers;
      },
      get publicUserId() {
        return publicUserId;
      },
      get userNames() {
        return userNames;
      },
      get userAvatars() {
        return userAvatars;
      },
      get emitAvatarPayload() {
        return emitAvatarPayload;
      },
      get io() {
        return io;
      },
      get announceVoicePresence() {
        return announceVoicePresence;
      },
      get broadcastVoiceList() {
        return broadcastVoiceList;
      },
      get broadcastVoiceCounts() {
        return broadcastVoiceCounts;
      },
      get handleVoiceLeave() {
        return handleVoiceLeave;
      },
      get isSocketMuted() {
        return isSocketMuted;
      },
      get pausePeerMicrophone() {
        return pausePeerMicrophone;
      },
    });
    registerMediaSocketHandlers({
      get socket() {
        return socket;
      },
      get mediaDiagnosticsForPeer() {
        return mediaDiagnosticsForPeer;
      },
      get voiceRooms() {
        return voiceRooms;
      },
      get onDemandMediaType() {
        return onDemandMediaType;
      },
      get broadcastRoomMembers() {
        return broadcastRoomMembers;
      },
      get io() {
        return io;
      },
      get isSharingScreen() {
        return isSharingScreen;
      },
      get stopRemoteControlForSocket() {
        return stopRemoteControlForSocket;
      },
      get isSocketMuted() {
        return isSocketMuted;
      },
      get syncOnDemandProducer() {
        return syncOnDemandProducer;
      },
      get findProducerOwner() {
        return findProducerOwner;
      },
      get closePeerConsumer() {
        return closePeerConsumer;
      },
      get endAnnotationSessionForSocket() {
        return annotations.endForSocket;
      },
    });
    registerAnnotationSocketHandlers({
      get socket() {
        return socket;
      },
      get annotations() {
        return annotations;
      },
    });
    registerSoundpacksSocketHandlers({
      get socket() {
        return socket;
      },
      get stmtGetSoundpack() {
        return stmtGetSoundpack;
      },
      get roomMembers() {
        return roomMembers;
      },
      get voiceRooms() {
        return voiceRooms;
      },
      get userNames() {
        return userNames;
      },
      get io() {
        return io;
      },
      get publicUserId() {
        return publicUserId;
      },
      get userClientIds() {
        return userClientIds;
      },
      get isRoomOwner() {
        return isRoomOwner;
      },
      get stmtDeleteSoundpack() {
        return stmtDeleteSoundpack;
      },
      get SOUNDS_DIR() {
        return SOUNDS_DIR;
      },
      get stmtRenameSoundpack() {
        return stmtRenameSoundpack;
      },
      get stmtGetSoundpacks() {
        return stmtGetSoundpacks;
      },
      get reorderSoundpacks() {
        return reorderSoundpacks;
      },
    });

    // ── Disconnect ────────────────────────────────────────────────────────────

    socket.on('disconnect', (reason) => {
      console.log(`[-] ${socket.id} reason=${reason}`);
      stopRemoteControlForSocket(socket.id, '成员连接已断开');
      const cleanup = () => cleanupDisconnectedPeer(socket.id);
      if (
        reason === 'transport close' ||
        reason === 'transport error' ||
        reason === 'ping timeout'
      ) {
        disconnectGrace.fail(socket.id, cleanup);
      } else {
        cleanup();
      }
    });
  });

  async function startServer(port = 3001): Promise<number> {
    try {
      await initMediasoup();
      migrateAvatars();
      return await new Promise<number>((resolve, reject) => {
        // 显式绑定 0.0.0.0（所有 IPv4 接口），确保 frp 用 127.0.0.1 也能连上。
        // 不指定 host 时 Windows 默认只绑 IPv6(::)，导致 frp 拨 127.0.0.1 被拒绝。
        httpServer
          .listen(port, '0.0.0.0', () => {
            const address = httpServer.address();
            legacyNormalizationPromise = normalizeLegacySoundpacks().catch((error) => {
              console.warn('[soundpack] 旧语音包后台标准化中断，原文件保持可用', error);
            });
            resolve(address && typeof address !== 'string' ? address.port : port);
          })
          .on('error', reject);
      });
    } catch (error) {
      await stopServer();
      throw error;
    }
  }

  async function stopServer(): Promise<void> {
    legacyNormalizationStopped = true;
    clearInterval(recoveryCheckpoint);
    disconnectGrace.clear();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    closeMediasoup();
    try {
      await legacyNormalizationPromise;
    } finally {
      db.close();
    }
  }
  return { startServer, stopServer };
}
