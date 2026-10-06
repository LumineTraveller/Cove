import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { io as connectSocket } from 'socket.io-client';
import { ensureServerAccess as desktopAccess, clearServerAccessToken as clearDesktop } from '../../desktop/src/features/connection/serverSecurity';
import { ensureServerAccess as mobileAccess, clearServerAccessToken as clearMobile } from '../../mobile/src/features/connection/serverSecurity';

class TestDatabase {
  private readonly db: DatabaseSync;
  constructor(filename: string) { this.db = new DatabaseSync(filename); }
  exec(sql: string) { return this.db.exec(sql); }
  pragma(sql: string) { return this.db.exec(`PRAGMA ${sql}`); }
  prepare(sql: string) { return this.db.prepare(sql); }
  transaction<T extends (...args: any[]) => any>(fn: T) {
    return (...args: Parameters<T>) => {
      this.db.exec('BEGIN');
      try { const value = fn(...args); this.db.exec('COMMIT'); return value; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    };
  }
  close() { this.db.close(); }
}

test('default gate rejects unauthenticated REST and sockets; real desktop and mobile flows unlock it', { timeout: 15_000 }, async () => {
  const originalLoad = (Module as any)._load;
  const keys = ['COVE_DATA_DIR', 'COVE_DOWNLOAD_DIR', 'COVE_SERVER_SECURITY_ENABLED', 'COVE_BOOTSTRAP_TOKEN', 'COVE_BOOTSTRAP_TOKEN_FILE'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cove-security-default-'));
  // These public fixture strings apply only to the temporary server below.
  const bootstrap = 'cove-bootstrap-test-fixture-not-a-real-secret';
  const password = 'cove-server-test-fixture-password';
  const sockets: ReturnType<typeof connectSocket>[] = [];
  let stopServer: (() => Promise<void>) | undefined;
  let base = '';
  (Module as any)._load = function(request: string, parent: unknown, isMain: boolean) {
    if (request === 'better-sqlite3') return TestDatabase;
    if (request === './ms' || request.endsWith('/media/ms')) {
      const peers = new Map<string, any>();
      return {
        MS_IP: '127.0.0.1', MS_PORT: 40000, router: null, webRtcServer: null, peers,
        createPeer: (id: string) => {
          const peer = { roomId: null, sendTransport: null, recvTransport: null, producers: new Map(), consumers: new Map() };
          peers.set(id, peer); return peer;
        },
        removePeer: (id: string) => peers.delete(id), getRoomProducers: () => [],
        initMediasoup: async () => {}, closeMediasoup: () => {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.COVE_DATA_DIR = dataDir;
  process.env.COVE_DOWNLOAD_DIR = path.join(dataDir, 'downloads');
  delete process.env.COVE_SERVER_SECURITY_ENABLED;
  delete process.env.COVE_BOOTSTRAP_TOKEN_FILE;
  process.env.COVE_BOOTSTRAP_TOKEN = bootstrap;
  const headers = { 'x-cove-client-protocol': '2' };
  const deniedSocket = async (auth: object, expected: string) => {
    const socket = connectSocket(base, { autoConnect: false, reconnection: false, auth });
    sockets.push(socket);
    const code = await new Promise<string>((resolve, reject) => {
      socket.once('connect', () => reject(new Error('Unauthenticated socket connected')));
      socket.once('connect_error', error => resolve((error as any).data?.code));
      socket.connect();
    });
    assert.equal(code, expected); socket.disconnect();
  };
  try {
    const server = await import('../src/index'); stopServer = server.stopServer;
    const port = await server.startServer(0); base = `http://127.0.0.1:${port}`;
    const status = await fetch(base + '/api/security/status').then(r => r.json());
    assert.equal(status.enabled, true); assert.equal(status.configured, false);
    assert.equal(status.bootstrapAvailable, true);
    await assert.rejects(access(path.join(dataDir, 'bootstrap-token.txt')));
    assert.equal((await fetch(base + '/api/rooms', { headers })).status, 503);
    const uninitializedRegistration = await fetch(base + '/api/auth/register', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'fixture@example.test', password: 'account-test-password', username: 'Fixture' }),
    });
    assert.equal(uninitializedRegistration.status, 503);
    assert.equal((await uninitializedRegistration.json()).code, 'SERVER_NOT_INITIALIZED');
    await deniedSocket({ clientProtocol: 2 }, 'SERVER_NOT_INITIALIZED');
    await assert.rejects(desktopAccess({ serverURL: base, password }), { code: 'BOOTSTRAP_REQUIRED' });

    const desktopGrant = await desktopAccess({ serverURL: base, password, bootstrapToken: bootstrap });
    assert.ok(desktopGrant?.accessToken);
    assert.equal((await fetch(base + '/api/rooms', { headers })).status, 401);
    const unauthorizedLogin = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'fixture@example.test', password: 'account-test-password' }),
    });
    assert.equal(unauthorizedLogin.status, 401);
    assert.equal((await unauthorizedLogin.json()).code, 'SERVER_ACCESS_REQUIRED');
    const wrong = await fetch(base + '/api/security/access', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong-test-password' }),
    });
    assert.equal(wrong.status, 401); assert.equal((await wrong.json()).code, 'INVALID_PASSWORD');
    const mobileGrant = await mobileAccess({ serverURL: base, password });
    assert.ok(mobileGrant?.accessToken);
    for (const grant of [desktopGrant, mobileGrant]) {
      const rooms = await fetch(base + '/api/rooms', { headers: { ...headers, authorization: `Bearer ${grant!.accessToken}` } });
      assert.equal(rooms.status, 200);
    }
    await deniedSocket({}, 'CLIENT_VERSION_TOO_OLD');
    await deniedSocket({ clientProtocol: 2 }, 'SERVER_ACCESS_REQUIRED');
    const socket = connectSocket(base, { autoConnect: false, reconnection: false, auth: { clientProtocol: 2, serverAccessToken: mobileGrant!.accessToken } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    assert.equal(socket.connected, true);
    // No autogenerated bootstrap file or real user profile was touched.
    await assert.rejects(access(path.join(dataDir, 'bootstrap-token.txt')));
  } finally {
    sockets.forEach(socket => socket.disconnect());
    if (stopServer) await stopServer();
    if (base) { clearDesktop(base); clearMobile(base); }
    (Module as any)._load = originalLoad;
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('cove-security-default-'));
    await rm(dataDir, { recursive: true, force: true });
  }
});
