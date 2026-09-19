import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { io as connectSocket } from 'socket.io-client';

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

test('default mode keeps legacy REST and Socket.IO clients working', { timeout: 15_000 }, async () => {
  const originalLoad = (Module as any)._load;
  const originalDataDir = process.env.COVE_DATA_DIR;
  const originalEnabled = process.env.COVE_SERVER_SECURITY_ENABLED;
  const originalBootstrap = process.env.COVE_BOOTSTRAP_TOKEN;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cove-security-disabled-'));
  let stopServer: (() => Promise<void>) | undefined;
  let socket: ReturnType<typeof connectSocket> | undefined;

  (Module as any)._load = function(request: string, parent: unknown, isMain: boolean) {
    if (request === 'better-sqlite3') return TestDatabase;
    if (request === './ms' || request.endsWith('/src/ms')) {
      const peers = new Map<string, any>();
      return {
        MS_IP: '127.0.0.1', MS_PORT: 40000, router: null, webRtcServer: null,
        peers,
        createPeer: (id: string) => {
          const peer = { roomId: null, sendTransport: null, recvTransport: null, producers: new Map(), consumers: new Map() };
          peers.set(id, peer);
          return peer;
        },
        removePeer: (id: string) => peers.delete(id),
        getRoomProducers: () => [],
        initMediasoup: async () => {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  process.env.COVE_DATA_DIR = dataDir;
  delete process.env.COVE_SERVER_SECURITY_ENABLED;
  delete process.env.COVE_BOOTSTRAP_TOKEN;

  try {
    const server = await import('../src/index');
    stopServer = server.stopServer;
    const port = await server.startServer(0);
    const base = `http://127.0.0.1:${port}`;

    const statusResponse = await fetch(`${base}/api/security/status`);
    assert.equal(statusResponse.status, 200);
    assert.deepEqual(await statusResponse.json(), {
      enabled: false,
      configured: false,
      bootstrapAvailable: false,
      tokenEpoch: 1,
      authorized: false,
      secureTransportRequired: false,
    });
    await assert.rejects(access(path.join(dataDir, 'bootstrap-token.txt')));

    const rooms = await fetch(`${base}/api/rooms`);
    assert.equal(rooms.status, 200);

    const registration = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'legacy@example.com', password: 'password-123', username: 'Legacy' }),
    });
    assert.equal(registration.status, 201);

    const disabledBootstrap = await fetch(`${base}/api/security/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: 'unused', password: 'server-password-123' }),
    });
    assert.equal(disabledBootstrap.status, 404);
    assert.equal((await disabledBootstrap.json()).code, 'SERVER_SECURITY_DISABLED');

    socket = connectSocket(base, { reconnection: false });
    await new Promise<void>((resolve, reject) => {
      socket!.once('connect', () => resolve());
      socket!.once('connect_error', reject);
    });
    assert.equal(socket.connected, true);
  } finally {
    socket?.disconnect();
    if (stopServer) await stopServer();
    (Module as any)._load = originalLoad;
    if (originalDataDir === undefined) delete process.env.COVE_DATA_DIR;
    else process.env.COVE_DATA_DIR = originalDataDir;
    if (originalEnabled === undefined) delete process.env.COVE_SERVER_SECURITY_ENABLED;
    else process.env.COVE_SERVER_SECURITY_ENABLED = originalEnabled;
    if (originalBootstrap === undefined) delete process.env.COVE_BOOTSTRAP_TOKEN;
    else process.env.COVE_BOOTSTRAP_TOKEN = originalBootstrap;
    await rm(dataDir, { recursive: true, force: true });
  }
});
