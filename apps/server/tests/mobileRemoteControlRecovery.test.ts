import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connectSocket, type Socket as ClientSocket } from 'socket.io-client';
import { registerAccountsSocketHandlers } from '../src/features/accounts/socketHandlers';
import { registerRemoteControlSocketHandlers } from '../src/features/remote-control/socketHandlers';
import { createControlService } from '../src/features/remote-control/controlService';
import { RemoteControlRegistry } from '../src/features/remote-control/remoteControl';

const event = (socket: ClientSocket, name: string) =>
  new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, listener);
      reject(new Error(`timeout: ${name}`));
    }, 4000);
    const listener = (payload: any) => {
      clearTimeout(timer);
      socket.off(name, listener);
      resolve(payload);
    };
    socket.on(name, listener);
  });

test(
  'real Socket.IO recovery revokes mobile controller authorization and requires fresh capability registration',
  { timeout: 15000 },
  async (t) => {
    const http = createServer();
    const io = new Server(http, {
      connectionStateRecovery: { maxDisconnectionDuration: 5000, skipMiddlewares: false },
    });
    const registry = new RemoteControlRegistry();
    const control = createControlService({ io, remoteControls: registry });
    const members = new Set<string>();
    const receiverCapabilities = new Set<string>();
    const userNames = new Map<string, string>();
    const userAvatars = new Map<string, string | null>();
    const userClientIds = new Map<string, string>();
    const userPlatforms = new Map<string, any>();
    const accountSockets = new Map<string, string>();
    const expiryTimers: ReturnType<typeof setTimeout>[] = [];
    const originalTimeout = global.setTimeout;
    t.mock.method(global, 'setTimeout', ((callback: any, milliseconds: any, ...args: any[]) => {
      const timer = originalTimeout(callback, milliseconds, ...args);
      if (milliseconds === 30050) expiryTimers.push(timer);
      return timer;
    }) as typeof setTimeout);
    io.on('connection', (socket) => {
      socket.join('room');
      members.add(socket.id);
      registerAccountsSocketHandlers({
        socket,
        io,
        accounts: {
          accountForToken: (token: unknown) =>
            typeof token === 'string' && token.startsWith('synthetic-')
              ? { id: token, username: token, avatarUrl: null }
              : null,
        },
        accountSockets,
        userNames,
        userAvatars,
        userClientIds,
        userPlatforms,
        remoteControlCapabilities: receiverCapabilities,
        socketAvatarPayload: (_: any, payload: any) => payload,
        cleanupDisconnectedPeer: () => {},
        migrateLegacyIdentity: () => {},
        stmtMigrateLegacyOwnersByName: { run: () => ({ changes: 0 }) },
        stmtUpdateOwnerName: { run: () => ({ changes: 0 }) },
        stmtGetRooms: { all: () => [] },
        emitAvatarPayload: () => {},
        sanitizeProfileAvatar: () => null,
        refreshProfileViews: () => {},
        voiceCounts: () => ({}),
      } as any);
      registerRemoteControlSocketHandlers({
        socket,
        io,
        remoteControls: registry,
        roomMembers: new Map([['room', members]]),
        remoteControlCapabilities: receiverCapabilities,
        isSharingScreen: (id) => receiverCapabilities.has(id),
        isRemoteControlAllowed: () => true,
        userNames,
        publicUserId: (id) => id,
        emitRemoteRequestCancelled: control.emitRemoteRequestCancelled,
        emitRemoteControlStopped: control.emitRemoteControlStopped,
      });
      socket.on('disconnect', () =>
        control.stopRemoteControlForSocket(socket.id, 'synthetic disconnect'),
      );
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const desktop = connectSocket(base, {
      autoConnect: false,
      reconnection: false,
      transports: ['websocket'],
    });
    const mobile = connectSocket(base, {
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 80,
      reconnectionDelayMax: 80,
      randomizationFactor: 0,
      transports: ['websocket'],
    });
    try {
      let connected = event(desktop, 'connect');
      desktop.connect();
      await connected;
      connected = event(mobile, 'connect');
      mobile.connect();
      await connected;
      const desktopRegistration = {
        authToken: 'synthetic-desktop',
        platform: 'desktop',
        remoteControlSupported: true,
      };
      const mobileRegistration = {
        authToken: 'synthetic-mobile',
        platform: 'mobile',
        remoteControlSupported: false,
        remoteControlControllerSupported: true,
      };
      assert.equal(
        (await desktop.timeout(2000).emitWithAck('user:register', desktopRegistration)).ok,
        true,
      );
      assert.equal(
        (await mobile.timeout(2000).emitWithAck('user:register', mobileRegistration)).ok,
        true,
      );
      assert.equal(receiverCapabilities.has(mobile.id!), false);
      assert.equal(receiverCapabilities.has(desktop.id!), true);
      assert.equal(io.sockets.sockets.get(mobile.id!)!.data.remoteControlControllerSupported, true);

      const requested = event(desktop, 'remote-control:requested');
      const ack = await mobile
        .timeout(2000)
        .emitWithAck('remote-control:request', { roomId: 'room', sharerSocketId: desktop.id });
      assert.equal(ack.ok, true);
      assert.equal((await requested).requestId, ack.requestId);
      const started = event(mobile, 'remote-control:started');
      assert.equal(
        (
          await desktop
            .timeout(2000)
            .emitWithAck('remote-control:respond', { requestId: ack.requestId, accepted: true })
        ).ok,
        true,
      );
      const session = await started;
      assert.equal(session.role, 'controller');
      assert.equal(session.requestId, ack.requestId);
      const input = event(desktop, 'remote-control:input');
      mobile.emit('remote-control:input', {
        sessionId: session.sessionId,
        input: { type: 'pointer', x: 0.5, y: 0 },
      });
      assert.deepEqual((await input).input, { type: 'pointer', x: 0.5, y: 0 });

      // A real server packet records Socket.IO's recovery offset. Closing Engine.IO
      // is a transport interruption, unlike an explicit namespace logout.
      const checkpoint = event(mobile, 'synthetic:checkpoint');
      io.to(mobile.id!).emit('synthetic:checkpoint', {});
      await checkpoint;
      const originalId = mobile.id!;
      const stopped = event(desktop, 'remote-control:stopped');
      connected = event(mobile, 'connect');
      mobile.io.engine.close();
      assert.equal((await stopped).sessionId, session.sessionId);
      await connected;
      assert.equal(mobile.recovered, true);
      assert.equal(mobile.id, originalId);
      assert.equal(
        io.sockets.sockets.get(mobile.id!)!.data.remoteControlControllerSupported,
        false,
      );
      assert.equal(registry.authorizeInput(session.sessionId, mobile.id!), null);
      assert.equal(
        (
          await mobile
            .timeout(2000)
            .emitWithAck('remote-control:request', { roomId: 'room', sharerSocketId: desktop.id })
        ).ok,
        false,
      );
      assert.equal(
        (await mobile.timeout(2000).emitWithAck('user:register', mobileRegistration)).ok,
        true,
      );
      assert.equal(io.sockets.sockets.get(mobile.id!)!.data.remoteControlControllerSupported, true);
      assert.equal(receiverCapabilities.has(mobile.id!), false);
      const retry = await mobile
        .timeout(2000)
        .emitWithAck('remote-control:request', { roomId: 'room', sharerSocketId: desktop.id });
      assert.equal(retry.ok, true);
      assert.equal(
        (
          await mobile
            .timeout(2000)
            .emitWithAck('remote-control:cancel', { requestId: retry.requestId })
        ).ok,
        true,
      );
    } finally {
      mobile.disconnect();
      desktop.disconnect();
      for (const timer of expiryTimers) clearTimeout(timer);
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  },
);
