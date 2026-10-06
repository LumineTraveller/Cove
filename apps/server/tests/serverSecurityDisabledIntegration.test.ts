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

test('disabled password mode still enforces the 2.0.0 minimum on REST and Socket.IO', { timeout: 15_000 }, async () => {
  const originalLoad = (Module as any)._load;
  const originalDataDir = process.env.COVE_DATA_DIR;
  const originalEnabled = process.env.COVE_SERVER_SECURITY_ENABLED;
  const originalBootstrap = process.env.COVE_BOOTSTRAP_TOKEN;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cove-security-disabled-'));
  let stopServer: (() => Promise<void>) | undefined;
  let socket: ReturnType<typeof connectSocket> | undefined;

  (Module as any)._load = function(request: string, parent: unknown, isMain: boolean) {
    if (request === 'better-sqlite3') return TestDatabase;
    if (request === './ms' || request.endsWith('/media/ms')) {
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
        initMediasoup: async () => {}, closeMediasoup: () => {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  process.env.COVE_DATA_DIR = dataDir;
  process.env.COVE_SERVER_SECURITY_ENABLED = 'false';
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
      serverVersion: '2.0.0',
      clientPlatform: null,
      releaseVersion: '2.0.0',
      minimumClientVersion: '2.0.0',
      requiredClientProtocol: 3,
      upgradeRequired: true,
      downloadUrl: 'https://github.com/LumineTraveller/Cove/releases/tag/v2.0.0',
    });
    await assert.rejects(access(path.join(dataDir, 'bootstrap-token.txt')));

    const legacyRooms = await fetch(`${base}/api/rooms`);
    assert.equal(legacyRooms.status, 426);
    assert.equal((await legacyRooms.json()).code, 'CLIENT_VERSION_TOO_OLD');
    const versionHeaders = {'x-cove-client-version':'2.0.0','x-cove-client-platform':'desktop','x-cove-client-protocol':'3'};
    const rooms = await fetch(`${base}/api/rooms`, {headers:versionHeaders});
    assert.equal(rooms.status, 200);
    const mobileHeaders = {'x-cove-client-version':'0.8.0','x-cove-client-platform':'mobile','x-cove-client-protocol':'3'};
    assert.equal((await fetch(`${base}/api/rooms`, {headers:mobileHeaders})).status,200);
    const mobilePolicy = await fetch(`${base}/api/version`, {headers:mobileHeaders}).then(r=>r.json());
    assert.equal(mobilePolicy.minimumClientVersion,'0.8.0');
    assert.equal(mobilePolicy.clientPlatform,'mobile');
    assert.equal(mobilePolicy.upgradeRequired,false);
    for (const headers of [
      {...mobileHeaders,'x-cove-client-version':'0.7.0'},
      {...mobileHeaders,'x-cove-client-protocol':'2'},
      {...versionHeaders,'x-cove-client-version':'1.5.4'},
      {...versionHeaders,'x-cove-client-platform':'unknown'},
    ]) assert.equal((await fetch(`${base}/api/rooms`,{headers})).status,426);

    const registration = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { ...versionHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'legacy@example.com', password: 'password-123', username: 'Legacy' }),
    });
    assert.equal(registration.status, 201);

    const disabledBootstrap = await fetch(`${base}/api/security/bootstrap`, {
      method: 'POST',
      headers: { ...versionHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: 'unused', password: 'server-password-123' }),
    });
    assert.equal(disabledBootstrap.status, 404);
    assert.equal((await disabledBootstrap.json()).code, 'SERVER_SECURITY_DISABLED');

    const legacy = connectSocket(base, {autoConnect:false,reconnection:false,auth:{clientProtocol:2}});
    const legacyError = await new Promise<any>((resolve,reject)=> {
      legacy.once('connect',()=>reject(new Error('Legacy socket connected')));
      legacy.once('connect_error',resolve);
      legacy.connect();
    });
    legacy.disconnect();
    assert.equal(legacyError.data.code,'CLIENT_VERSION_TOO_OLD');
    assert.equal(legacyError.data.minimumClientVersion,'2.0.0');
    socket = connectSocket(base, { reconnection: false,auth:{clientVersion:'2.0.0',clientPlatform:'desktop',clientProtocol:3} });
    await new Promise<void>((resolve, reject) => {
      socket!.once('connect', () => resolve());
      socket!.once('connect_error', reject);
    });
    assert.equal(socket.connected, true);
    socket.disconnect();
    socket = connectSocket(base, {autoConnect:false,reconnection:false,auth:{clientVersion:'0.8.0',clientPlatform:'mobile',clientProtocol:3}});
    await new Promise<void>((resolve,reject)=>{socket!.once('connect',resolve);socket!.once('connect_error',reject);socket!.connect();});
    assert.equal(socket.connected,true);
    for (const auth of [
      {clientVersion:'0.7.0',clientPlatform:'mobile',clientProtocol:3},
      {clientVersion:'0.8.0',clientPlatform:'mobile',clientProtocol:2},
      {clientVersion:'1.5.4',clientPlatform:'mobile',clientProtocol:2},
      {clientVersion:'2.0.0',clientProtocol:3},
    ]) {
      const denied = connectSocket(base,{autoConnect:false,reconnection:false,auth});
      try {
        const error = await new Promise<any>((resolve,reject)=>{denied.once('connect',()=>reject(new Error('Unsupported client connected')));denied.once('connect_error',resolve);denied.connect();});
        assert.equal(error.data.code,'CLIENT_VERSION_TOO_OLD');
        assert.equal(error.data.requiredClientProtocol,3);
        assert.match(error.message,/https:\/\/github\.com\/LumineTraveller\/Cove\/releases\/tag\//);
      } finally {denied.disconnect();}
    }
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
