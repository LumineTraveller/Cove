import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { io as connectSocket, type Socket } from 'socket.io-client';
import * as desktopAccess from '../../desktop/src/features/connection/serverSecurity';
import { createStartupLoginCheck } from '../../desktop/src/features/accounts/startupLogin';
import * as mobileAccess from '../../mobile/src/features/connection/serverSecurity';
import { createCoveSocket } from '../../mobile/src/features/connection/socket';

class TestDatabase {
  private readonly db: DatabaseSync;
  constructor(filename: string) { this.db = new DatabaseSync(filename); }
  exec(sql: string) { return this.db.exec(sql); }
  pragma(sql: string) { return this.db.exec(`PRAGMA ${sql}`); }
  prepare(sql: string) { return this.db.prepare(sql); }
  transaction<T extends (...args: any[]) => any>(fn: T) {
    return (...args: Parameters<T>) => {
      this.db.exec('BEGIN');
      try { const result = fn(...args); this.db.exec('COMMIT'); return result; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    };
  }
  close() { this.db.close(); }
}

const emit = (socket: Socket, event: string, data?: unknown): Promise<any> => new Promise((resolve, reject) => {
  const ack = (error: Error | null, value: unknown) => error ? reject(error) : resolve(value);
  if (data === undefined) socket.timeout(3_000).emit(event, ack);
  else socket.timeout(3_000).emit(event, data, ack);
});

test('expiry keeps desktop/mobile online and recoverable, but login and auto-login require the server password', { timeout: 20_000 }, async () => {
  const keys = ['COVE_DATA_DIR', 'COVE_DOWNLOAD_DIR', 'COVE_SERVER_SECURITY_ENABLED', 'COVE_BOOTSTRAP_TOKEN', 'COVE_BOOTSTRAP_TOKEN_FILE'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const globals = ['window', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cove-access-session-'));
  const originalLoad = (Module as any)._load;
  const sockets: Socket[] = [];
  const peers = new Map<string, any>();
  const password = 'public-server-password-fixture';
  const bootstrap = 'public-bootstrap-fixture';
  const identity = { clientProtocol: 3, clientVersion: '2.1.2', clientPlatform: 'desktop' };
  const headers = { 'x-cove-client-protocol': '3', 'x-cove-client-version': '2.1.2', 'x-cove-client-platform': 'desktop' };
  let now = Date.now();
  let base = '';
  let stopServer: (() => Promise<void>) | undefined;
  let security: ReturnType<typeof import('../src/features/security/serverSecurity').createServerSecurityStore> | undefined;
  (Module as any)._load = function(request: string, parent: any, isMain: boolean) {
    if (request === 'better-sqlite3') return TestDatabase;
    if (request === './ms' || request.endsWith('/media/ms')) return {
      MS_IP: '127.0.0.1', MS_PORT: 40000, router: null, webRtcServer: null, peers,
      createPeer(id: string) {
        const peer = { roomId: null, sendTransport: null, recvTransport: null, producers: new Map(), consumers: new Map() };
        peers.set(id, peer); return peer;
      },
      removePeer: (id: string) => peers.delete(id), getRoomProducers: () => [],
      initMediasoup: async () => {}, closeMediasoup: () => {},
    };
    const loaded = originalLoad.call(this, request, parent, isMain);
    if (request === './serverSecurity' && /[/\\]securityStore\.ts$/.test(parent?.filename ?? '')) return {
      ...loaded,
      createServerSecurityStore(db: any, options: any) {
        security = loaded.createServerSecurityStore(db, { ...options, now: () => now, tokenLifetimeMs: 2_000 });
        return security;
      },
    };
    return loaded;
  };
  process.env.COVE_DATA_DIR = dataDir;
  process.env.COVE_DOWNLOAD_DIR = path.join(dataDir, 'downloads');
  process.env.COVE_SERVER_SECURITY_ENABLED = '1';
  process.env.COVE_BOOTSTRAP_TOKEN = bootstrap;
  delete process.env.COVE_BOOTSTRAP_TOKEN_FILE;
  try {
    const server = await import('../src/index');
    stopServer = server.stopServer;
    base = `http://127.0.0.1:${await server.startServer(0)}`;
    // Anchor the short fixture deadline after module loading, so this also
    // exercises the production idle-expiry timer without changing system time.
    now = Date.now();
    const grant = await desktopAccess.bootstrapServer(base, bootstrap, password);
    mobileAccess.setServerAccessToken(base, grant);
    const bearerHeaders = { ...headers, authorization: `Bearer ${grant.accessToken}` };
    const accounts = [];
    for (const name of ['desktop', 'mobile']) {
      const response = await fetch(base + '/api/auth/register', {
        method: 'POST', headers: { ...bearerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ email: `${name}@example.test`, username: name, password: 'public-account-fixture' }),
      });
      assert.equal(response.status, 201);
      accounts.push(await response.json());
    }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { protocol: 'http:', hostname: '127.0.0.1', origin: base } } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => key === 'cove_server_url' ? base : null } });
    const desktop = await import('../../desktop/src/features/connection/socket');
    const mobile = createCoveSocket(base);
    sockets.push(desktop.socket, mobile);
    for (const [index, socket] of sockets.entries()) {
      const connected = once(socket, 'connect'); socket.connect(); await connected;
      assert.equal((await emit(socket, 'user:register', { authToken: accounts[index].token, platform: index ? 'mobile' : 'desktop' })).ok, true);
    }
    const pendingLogin = connectSocket(base, { autoConnect: false, reconnection: false, auth: { ...identity, serverAccessToken: grant.accessToken } });
    sockets.push(pendingLogin);
    const pendingConnected = once(pendingLogin, 'connect'); pendingLogin.connect(); await pendingConnected;
    const { room } = await emit(desktop.socket, 'room:create', { name: 'Expiry fixture' });
    assert.equal((await emit(desktop.socket, 'room:join', { roomId: room.id })).ok, true);
    const notices: unknown[] = [];
    sockets.forEach(socket => socket.on('server:access-invalid', notice => notices.push(notice)));
    now = grant.expiresAt;
    await new Promise(resolve => setTimeout(resolve, Math.max(1, grant.expiresAt - Date.now() + 30)));
    assert.deepEqual(notices, [], 'an idle connected user must not be kicked at the deadline');
    for (const [index, socket] of [desktop.socket, mobile].entries()) {
      assert.equal(socket.connected, true);
      await emit(socket, 'presence:get');
      const access = index ? mobileAccess : desktopAccess;
      assert.equal(access.getServerAccessToken(base), null, 'expired grant cannot admit another connection');
      assert.equal((await access.serverFetch(base, '/api/rooms')).status, 200);
      assert.equal(new URL(access.authorizedResourceURL(base, '/avatars/fixture.png')).searchParams.get('access_token'), grant.accessToken);
    }
    assert.equal(desktopAccess.serverSocketAuth(base).serverAccessToken, null);
    desktop.applyServerAccessToSocket(base);
    assert.equal((desktop.socket.auth as any).serverAccessToken, grant.accessToken, 'registration retry must preserve the admitted grant');
    const pendingInvalid = once(pendingLogin, 'server:access-invalid');
    const pendingDisconnected = once(pendingLogin, 'disconnect');
    pendingLogin.emit('user:register', { authToken: accounts[0].token, platform: 'desktop' });
    assert.equal((await pendingInvalid)[0].code, 'SERVER_ACCESS_INVALID', 'a socket opened before expiry cannot start a new login afterwards');
    await pendingDisconnected;
    const status = await desktopAccess.readServerSecurityStatus(base);
    assert.equal(status.authorized, false);
    await assert.rejects(desktopAccess.ensureServerAccess({ serverURL: base, password: '' }), { code: 'SERVER_ACCESS_REQUIRED' });
    const startup = createStartupLoginCheck({ restore: async () => false, status: desktopAccess.readServerSecurityStatus, reject: async () => {} });
    assert.equal(await startup({ serverUrl: base, email: accounts[0].account.email, accountId: accounts[0].account.id, token: accounts[0].token }), 'server-required');
    for (const url of ['/api/auth/login', '/api/AUTH/LOGIN/', '/api/auth/register']) {
      const response = await fetch(base + url, { method: 'POST', headers: { ...bearerHeaders, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 401, url);
      assert.equal((await response.json()).code, 'SERVER_ACCESS_REQUIRED');
    }
    const fresh = connectSocket(base, { autoConnect: false, reconnection: false, auth: { ...identity, serverAccessToken: grant.accessToken } });
    sockets.push(fresh);
    const denied = once(fresh, 'connect_error'); fresh.connect();
    assert.equal((await denied)[0].data.code, 'SERVER_ACCESS_REQUIRED');
    fresh.disconnect();

    // A brief transport outage recovers the already-admitted logical session.
    const id = desktop.socket.id;
    const recovered = once(desktop.socket, 'connect');
    desktop.socket.io.engine.close();
    await recovered;
    assert.equal(desktop.socket.recovered, true);
    assert.equal(desktop.socket.id, id);
    assert.equal((await emit(desktop.socket, 'user:register', { authToken: accounts[0].token, platform: 'desktop' })).ok, true);
    assert.equal(peers.get(id!)?.roomId, room.id);
    assert.equal((await desktopAccess.serverFetch(base, '/api/rooms')).status, 200);
    const mobileId = mobile.id;
    const mobileRecovered = once(mobile, 'connect');
    mobile.io.engine.close();
    await mobileRecovered;
    assert.equal(mobile.recovered, true);
    assert.equal(mobile.id, mobileId);
    assert.equal((await mobileAccess.serverFetch(base, '/api/rooms')).status, 200);

    desktop.socket.disconnect(); mobile.disconnect();
    // Explicit disconnect is asynchronous at the server; wait for its cleanup.
    let response!: Response;
    for (let attempt = 0; attempt < 50; attempt++) {
      response = await fetch(base + '/api/rooms', { headers: bearerHeaders });
      if (response.status === 401) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(response.status, 401, 'no active connection may authorize an expired grant');
    const reloginDenied = once(desktop.socket, 'connect_error');
    desktop.socket.connect();
    assert.equal((await reloginDenied)[0].data.code, 'SERVER_ACCESS_REQUIRED');
    desktop.socket.disconnect();
    const nextGrant = await mobileAccess.unlockServer(base, password);
    const next = createCoveSocket(base); sockets.push(next);
    const connected = once(next, 'connect'); next.connect(); await connected;
    assert.equal((await emit(next, 'user:register', { authToken: accounts[1].token, platform: 'mobile' })).ok, true);
    assert.notEqual(nextGrant.accessToken, grant.accessToken);
    const revoked = once(next, 'server:access-invalid');
    const disconnected = once(next, 'disconnect');
    security!.revokeAll();
    assert.equal((await revoked)[0].code, 'SERVER_ACCESS_INVALID');
    await disconnected;
    assert.equal((await mobileAccess.serverFetch(base, '/api/rooms')).status, 401);
  } finally {
    sockets.forEach(socket => socket.disconnect());
    if (stopServer) await stopServer();
    if (base) { desktopAccess.clearServerAccessToken(base); mobileAccess.clearServerAccessToken(base); }
    (Module as any)._load = originalLoad;
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('cove-access-session-'));
    await rm(dataDir, { recursive: true, force: true });
  }
});
