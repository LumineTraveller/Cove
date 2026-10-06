import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { EventEmitter } from 'node:events';
import { io as connectSocket, type Socket } from 'socket.io-client';

// The production server uses better-sqlite3 and mediasoup. Keep this test
// independent of native ABI builds while exercising the real HTTP/socket
// handlers and their SQLite SQL.
class TestDatabase {
  private readonly db: DatabaseSync;
  constructor(private readonly filename: string) { this.db = new DatabaseSync(filename); }
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

const originalLoad = (Module as any)._load;
const fake = { peers: new Map<string, any>() };
let transportSequence = 0;
const fakeRouter = {
  rtpCapabilities: {},
  async createWebRtcTransport() {
    const producers: any[] = [];
    const transport = Object.assign(new EventEmitter(), {
      id: `transport-${++transportSequence}`, closed: false,
      iceParameters: {}, iceCandidates: [], dtlsParameters: {}, sctpParameters: {},
      async connect() {},
      close() { this.closed = true; producers.forEach(producer => producer.close()); },
      async produce(options: any) {
        const producer = Object.assign(new EventEmitter(), {
          id: `producer-${transportSequence}-${producers.length}`, closed: false,
          kind: options.kind, appData: options.appData, observer: new EventEmitter(),
          async pause() {}, async resume() {},
          close() { if (this.closed) return; this.closed = true; this.observer.emit('close'); },
        });
        producers.push(producer); return producer;
      },
    });
    return transport;
  },
};
(Module as any)._load = function(request: string, parent: unknown, isMain: boolean) {
  if (request === 'better-sqlite3') return TestDatabase;
  if (request === './ms' || request.endsWith('/media/ms')) {
    return {
      MS_IP: '127.0.0.1', MS_PORT: 40000, router: fakeRouter, webRtcServer: null,
      peers: fake.peers, createPeer: (id: string) => { const peer = { roomId: null, sendTransport: null, recvTransport: null, producers: new Map(), consumers: new Map() }; fake.peers.set(id, peer); return peer; },
      removePeer: (id: string) => fake.peers.delete(id), getRoomProducers: () => [], initMediasoup: async () => {}, closeMediasoup: () => {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let dataDir = '';
let base = '';
let serverAccessToken = '';
let startServer: (port?: number) => Promise<number>;
let stopServer: () => Promise<void>;
const bootstrapToken = 'integration-bootstrap-credential-123456789';
const clientProtocol = 2;
const originalDataDir = process.env.COVE_DATA_DIR;
const originalBootstrapToken = process.env.COVE_BOOTSTRAP_TOKEN;
const originalServerSecurityEnabled = process.env.COVE_SERVER_SECURITY_ENABLED;

type Account = { token: string; account: { id: string; email: string; username: string } };
const serverHeaders = (token = serverAccessToken) => ({
  authorization: `Bearer ${token}`,
  'x-cove-client-protocol': String(clientProtocol),
});
async function register(email: string, username: string): Promise<Account> {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json', ...serverHeaders() }, body: JSON.stringify({ email, password: 'password-123', username }) });
  assert.equal(response.status, 201);
  return response.json() as Promise<Account>;
}
async function login(email: string): Promise<Account> {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...serverHeaders() }, body: JSON.stringify({ email, password: 'password-123' }) });
  assert.equal(response.status, 200);
  return response.json() as Promise<Account>;
}
function socketFor(account: Account) {
  const socket = connectSocket(base, { autoConnect: false, reconnection: false, auth: { serverAccessToken, clientProtocol } });
  const register = new Promise<any>(resolve => socket.on('connect', () => socket.emit('user:register', { username: account.account.username, clientId: `client-${account.account.id}-1234`, authToken: account.token }, resolve)));
  socket.connect();
  return { socket, register };
}
function emit<T>(socket: Socket, event: string, data?: unknown) {
  return new Promise<T>((resolve, reject) => {
    const ack = (error: Error | null, result: T) => error ? reject(error) : resolve(result);
    if (data === undefined) socket.timeout(5_000).emit(event, ack);
    else socket.timeout(5_000).emit(event, data, ack);
  });
}

const sockets: Socket[] = [];
const legacyAvatar = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7#cove-crop=0.1,-0.2,1.3';
before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'cove-room-integration-'));
  // Start with a pre-normalization database/file to exercise the live upgrade.
  const legacyDb = new DatabaseSync(path.join(dataDir, 'cove.db'));
  legacyDb.exec('CREATE TABLE soundpacks (id TEXT PRIMARY KEY, name TEXT NOT NULL, filename TEXT NOT NULL, uploader TEXT NOT NULL, createdAt INTEGER NOT NULL)');
  legacyDb.prepare('INSERT INTO soundpacks (id, name, filename, uploader, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run('legacy-tone', 'Legacy Tone', 'legacy-tone.wav', 'Legacy', Date.now());
  legacyDb.exec('CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL, passwordSalt TEXT NOT NULL, username TEXT NOT NULL, avatarUrl TEXT, createdAt INTEGER NOT NULL)');
  legacyDb.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?)').run('legacy-avatar-user', 'legacy-avatar@example.com', 'unused', 'unused', 'Legacy Avatar', legacyAvatar, Date.now());
  legacyDb.exec('CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt INTEGER NOT NULL, ownerId TEXT, ownerName TEXT, avatarUrl TEXT, backgroundTop TEXT, backgroundBottom TEXT, backgroundTopDark TEXT, backgroundBottomDark TEXT)');
  legacyDb.prepare('INSERT INTO rooms (id, name, createdAt, avatarUrl) VALUES (?, ?, ?, ?)').run('legacy-avatar-room', 'Legacy Avatar', Date.now(), legacyAvatar);
  legacyDb.close();
  mkdirSync(path.join(dataDir, 'sounds'));
  execFileSync(require('ffmpeg-static') as string, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:a', 'pcm_s16le', path.join(dataDir, 'sounds', 'legacy-tone.wav'),
  ], { windowsHide: true });
  process.env.COVE_DATA_DIR = dataDir;
  process.env.COVE_BOOTSTRAP_TOKEN = bootstrapToken;
  process.env.COVE_SERVER_SECURITY_ENABLED = 'true';
  ({ startServer, stopServer } = await import('../src/index'));
  const port = await startServer(0);
  base = `http://127.0.0.1:${port}`;
  const status = await fetch(`${base}/api/security/status`);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    enabled: true,
    configured: false,
    bootstrapAvailable: true,
    tokenEpoch: 1,
    authorized: false,
    secureTransportRequired: false,
  });
  const bootstrap = await fetch(`${base}/api/security/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrapToken, password: 'server-password-123' }),
  });
  assert.equal(bootstrap.status, 201);
  serverAccessToken = (await bootstrap.json()).accessToken;
  assert.ok(serverAccessToken);
});

test('legacy account and room avatars migrate to files without losing GIF bytes or crop', async () => {
  const db = new DatabaseSync(path.join(dataDir, 'cove.db'));
  try {
    for (const table of ['accounts', 'rooms']) {
      const row = db.prepare(`SELECT avatarUrl FROM ${table} WHERE id = ?`).get(table === 'accounts' ? 'legacy-avatar-user' : 'legacy-avatar-room') as { avatarUrl: string };
      assert.match(row.avatarUrl, /^\/avatars\/[a-f0-9]{64}\.gif#cove-crop=0.1,-0.2,1.3$/);
      const bytes = await readFile(path.join(dataDir, row.avatarUrl.split('#')[0]));
      assert.equal(bytes.toString('base64'), legacyAvatar.split(',')[1].split('#')[0]);
    }
    const response = await fetch(`${base}/api/rooms/legacy-avatar-room`, { headers: serverHeaders() });
    const room = await response.json();
    assert.ok(room.avatarUrl.startsWith(`${base}/avatars/`));
    // A media element has no custom headers. Its own recipient access token
    // in the URL still satisfies the server's private-resource gate.
    const image = await fetch(room.avatarUrl);
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type')!, /image\/gif/);
    assert.match(image.headers.get('cache-control')!, /private.*no-store/);
    const noToken = new URL(room.avatarUrl); noToken.search = '';
    assert.equal((await fetch(noToken)).status, 426);
  } finally { db.close(); }
});

test('large avatar registration ACK is small, precedes presence and retries are idempotent', { timeout: 10_000 }, async () => {
  const account = await register('avatar-big@example.com', 'Big Avatar');
  const bytes = Buffer.concat([Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), Buffer.alloc(1024 * 1024)]);
  const inline = `data:image/gif;base64,${bytes.toString('base64')}#cove-crop=0.1,0.2,1.5`;
  const uploaded = await fetch(`${base}/api/auth/profile`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cove-account-token': account.token, ...serverHeaders() },
    body: JSON.stringify({ username: 'Big Avatar', avatarUrl: inline }),
  });
  assert.equal(uploaded.status, 200);
  const socket = connectSocket(base, { autoConnect: false, reconnection: false, transports: ['polling'], upgrade: false, auth: { serverAccessToken, clientProtocol } });
  sockets.push(socket);
  const order: string[] = [];
  const snapshots: any[] = [];
  socket.on('users:online', users => { order.push('presence'); snapshots.push(users); });
  const result = new Promise<any>(resolve => socket.on('connect', () => socket.emit('user:register', { authToken: account.token, platform: 'mobile' }, (response: any) => { order.push('ack'); resolve(response); })));
  socket.connect();
  const ack = await result;
  assert.equal(ack.ok, true);
  assert.equal(order[0], 'ack');
  assert.ok(JSON.stringify(ack).length < 1000);
  assert.ok(ack.profile.avatarUrl.startsWith(`${base}/avatars/`));
  assert.deepEqual(Buffer.from(await (await fetch(ack.profile.avatarUrl)).arrayBuffer()), bytes);
  await emit(socket, 'presence:get'); // Socket.IO ordering barrier.
  assert.ok(JSON.stringify(snapshots).length < 10_000);
  const snapshotCount = snapshots.length;
  const retry = await emit<any>(socket, 'user:register', { authToken: account.token, platform: 'mobile' });
  assert.deepEqual(retry, ack);
  await emit(socket, 'presence:get');
  assert.equal(snapshots.length, snapshotCount);
  const { room } = await emit<any>(socket, 'room:create', { name: 'Avatar Room', avatarUrl: inline });
  assert.ok(room.avatarUrl.startsWith(`${base}/avatars/`));
  assert.deepEqual(Buffer.from(await (await fetch(room.avatarUrl)).arrayBuffer()), bytes);
  assert.equal((await emit<any>(socket, 'room:join', room.id)).ok, true);
  const updated = await emit<any>(socket, 'room:update-settings', { roomId: room.id, avatarUrl: room.avatarUrl });
  assert.equal(updated.ok, true);
  assert.equal(updated.room.avatarUrl, room.avatarUrl);
  const profile = await emit<any>(socket, 'user:update-profile', { username: 'Big Avatar', avatarUrl: ack.profile.avatarUrl });
  assert.equal(profile.ok, true);
  const presence = await emit<any>(socket, 'presence:get');
  assert.ok(JSON.stringify(presence).length < 10_000);
});
after(async () => {
  sockets.forEach(socket => socket.disconnect());
  await stopServer();
  if (originalBootstrapToken === undefined) delete process.env.COVE_BOOTSTRAP_TOKEN;
  else process.env.COVE_BOOTSTRAP_TOKEN = originalBootstrapToken;
  if (originalServerSecurityEnabled === undefined) delete process.env.COVE_SERVER_SECURITY_ENABLED;
  else process.env.COVE_SERVER_SECURITY_ENABLED = originalServerSecurityEnabled;
  if (originalDataDir === undefined) delete process.env.COVE_DATA_DIR;
  else process.env.COVE_DATA_DIR = originalDataDir;
  (Module as any)._load = originalLoad;
  if (dataDir && path.dirname(dataDir) === path.resolve(tmpdir()) && path.basename(dataDir).startsWith('cove-room-integration-'))
    await rm(dataDir, { recursive: true, force: true });
});

test('server access gates sensitive REST and Socket.IO operations', { timeout: 15_000 }, async () => {
  const rooms = await fetch(`${base}/api/rooms`);
  assert.equal(rooms.status, 426);
  const legacyResponse = await rooms.json() as { code?: string; error?: string };
  assert.equal(legacyResponse.code, 'CLIENT_VERSION_TOO_OLD');
  assert.match(legacyResponse.error ?? '', /客户端版本过旧/);
  const legacyLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'legacy@example.com', password: 'password-123' }),
  });
  assert.equal(legacyLogin.status, 426);
  assert.equal((await legacyLogin.json()).code, 'CLIENT_VERSION_TOO_OLD');
  const status = await fetch(`${base}/api/security/status`, { headers: { authorization: `Bearer ${serverAccessToken}` } });
  assert.equal((await status.json()).authorized, true);
  const wrongPassword = await fetch(`${base}/api/security/access`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'not-the-server-password' }),
  });
  assert.equal(wrongPassword.status, 401);

  const denied = connectSocket(base, { autoConnect: false, reconnection: false });
  const deniedError = new Promise<any>(resolve => denied.once('connect_error', resolve));
  denied.connect();
  const error = await deniedError;
  assert.equal(error.data?.code, 'CLIENT_VERSION_TOO_OLD');
  denied.disconnect();
});

test('old and newly uploaded soundpacks play normalized copies while keeping original downloads', { timeout: 15_000 }, async () => {
  const legacyOriginal = await readFile(path.join(dataDir, 'sounds', 'legacy-tone.wav'));
  let legacy: any;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}/api/soundpacks`, { headers: serverHeaders() });
    assert.equal(response.status, 200);
    legacy = (await response.json() as any[]).find(pack => pack.id === 'legacy-tone');
    if (legacy?.filename === 'legacy-tone.normalized.mp3') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(legacy?.filename, 'legacy-tone.normalized.mp3');
  assert.equal(legacy.originalFilename, 'legacy-tone.wav');
  assert.deepEqual(await readFile(path.join(dataDir, 'sounds', 'legacy-tone.wav')), legacyOriginal);
  assert.ok((await readFile(path.join(dataDir, 'sounds', legacy.filename))).length > 0);

  const account = await register('soundpack@example.com', 'Soundpack Uploader');
  const connected = socketFor(account); sockets.push(connected.socket);
  assert.equal((await connected.register).ok, true);
  const upload = await fetch(`${base}/api/soundpacks`, {
    method: 'POST',
    headers: { ...serverHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Fresh Tone', mimeType: 'audio/wav', socketId: connected.socket.id,
      data: legacyOriginal.toString('base64'),
    }),
  });
  assert.equal(upload.status, 200);
  const fresh = await upload.json() as { id: string; filename: string; originalFilename: string };
  assert.match(fresh.filename, /\.normalized\.mp3$/);
  assert.match(fresh.originalFilename, /\.wav$/);
  const originalDownload = await fetch(`${base}/sounds/${fresh.originalFilename}`, { headers: serverHeaders() });
  assert.equal(originalDownload.status, 200);
  assert.deepEqual(Buffer.from(await originalDownload.arrayBuffer()), legacyOriginal);
  const playbackDownload = await fetch(`${base}/sounds/${fresh.filename}`, { headers: serverHeaders() });
  assert.equal(playbackDownload.status, 200);
  assert.ok((await playbackDownload.arrayBuffer()).byteLength > 0);
  assert.equal((await emit<any>(connected.socket, 'soundpack:delete', { soundId: fresh.id })).ok, true);
  assert.equal(existsSync(path.join(dataDir, 'sounds', fresh.originalFilename)), false);
  assert.equal(existsSync(path.join(dataDir, 'sounds', fresh.filename)), false);
});

test('room join enforces password/capacity, preserves current members and restricts settings/history', { timeout: 15_000 }, async () => {
  const owner = await register('owner@example.com', 'Owner');
  const guestA = await register('guest-a@example.com', 'Guest A');
  const guestB = await register('guest-b@example.com', 'Guest B');
  const ownerSocket = socketFor(owner); const aSocket = socketFor(guestA); const bSocket = socketFor(guestB);
  sockets.push(ownerSocket.socket, aSocket.socket, bSocket.socket);
  assert.equal((await ownerSocket.register).ok, true); assert.equal((await aSocket.register).ok, true); assert.equal((await bSocket.register).ok, true);
  const created = await emit<any>(ownerSocket.socket, 'room:create', { name: 'Private', maxMembers: 2, password: '  secret  ' });
  assert.equal(created.room.maxMembers, 2); assert.equal(created.room.hasPassword, true);
  assert.match(created.room.ownerUserId, /^[a-f0-9]{24}$/);
  assert.equal('ownerId' in created.room, false);
  assert.equal((await emit<any>(ownerSocket.socket, 'room:join', { roomId: created.room.id })).ok, true);
  ownerSocket.socket.emit('message:send', { roomId: created.room.id, content: 'remark identity check' });
  const ownerHistory = await emit<any>(ownerSocket.socket, 'room:history', { roomId: created.room.id });
  assert.equal(ownerHistory.messages[0].authorUserId, created.room.ownerUserId);
  assert.equal('authorId' in ownerHistory.messages[0], false);
  assert.equal((await emit<any>(aSocket.socket, 'room:history', { roomId: created.room.id })).code, 'FORBIDDEN');
  const historyResponse = await fetch(`${base}/api/rooms/${created.room.id}/messages`, { headers: serverHeaders() });
  assert.equal(historyResponse.status, 403);
  assert.equal((await emit<any>(aSocket.socket, 'room:join', { roomId: created.room.id, password: 'wrong' })).code, 'INVALID_PASSWORD');
  const concurrentJoins = await Promise.all([
    emit<any>(aSocket.socket, 'room:join', { roomId: created.room.id, password: '  secret  ' }),
    emit<any>(bSocket.socket, 'room:join', { roomId: created.room.id, password: '  secret  ' }),
  ]);
  assert.equal(concurrentJoins.filter(result => result.ok).length, 1);
  assert.equal(concurrentJoins.filter(result => result.code === 'ROOM_FULL').length, 1);
  assert.equal((await emit<any>(ownerSocket.socket, 'room:update-settings', { roomId: created.room.id, maxMembers: 1 })).ok, true);
  const currentMemberSocket = concurrentJoins[0].ok ? aSocket.socket : bSocket.socket;
  assert.equal((await emit<any>(currentMemberSocket, 'room:join', { roomId: created.room.id, password: '  secret  ' })).ok, true);
  assert.equal((await emit<any>(currentMemberSocket, 'room:update-settings', { roomId: created.room.id, maxMembers: null })).code, 'FORBIDDEN');
  assert.equal((await emit<any>(ownerSocket.socket, 'room:update-settings', { roomId: created.room.id, maxMembers: 2, password: 'new secret' })).ok, true);
  assert.equal((await emit<any>(currentMemberSocket, 'room:join', { roomId: created.room.id })).ok, true);
  currentMemberSocket.emit('room:leave', created.room.id);
  assert.equal((await emit<any>(currentMemberSocket, 'room:history', { roomId: created.room.id })).code, 'FORBIDDEN');
  assert.equal((await emit<any>(currentMemberSocket, 'room:join', { roomId: created.room.id, password: '  secret  ' })).code, 'INVALID_PASSWORD');
  assert.equal((await emit<any>(currentMemberSocket, 'room:join', { roomId: created.room.id, password: 'new secret' })).ok, true);
  const cleared = await emit<any>(ownerSocket.socket, 'room:update-settings', { roomId: created.room.id, maxMembers: null, password: null });
  assert.equal(cleared.room.hasPassword, false);
  assert.equal(cleared.room.maxMembers, null);
  assert.equal('passwordHash' in cleared.room, false);
  const list = await (await fetch(`${base}/api/rooms`, { headers: serverHeaders() })).json() as any[];
  assert.equal(list.some(room => 'passwordHash' in room || 'passwordSalt' in room), false);
  assert.equal(list.find(room => room.id === created.room.id)?.ownerUserId, created.room.ownerUserId);
  assert.equal(list.some(room => 'ownerId' in room), false);
});

test('successful REST login replaces the old socket and revokes its token', { timeout: 15_000 }, async () => {
  const account = await register('replace@example.com', 'Replace');
  const old = socketFor(account); sockets.push(old.socket);
  assert.equal((await old.register).ok, true);
  const duplicate = socketFor(account); sockets.push(duplicate.socket);
  assert.equal((await duplicate.register).code, 'SESSION_IN_USE');
  duplicate.socket.disconnect();
  const replaced = new Promise<void>(resolve => old.socket.once('account:session-replaced', () => resolve()));
  const next = await login('replace@example.com');
  await replaced;
  const stale = socketFor(account); sockets.push(stale.socket);
  assert.equal((await stale.register).error, '登录已失效，请重新登录');
  stale.socket.disconnect();
  assert.notEqual(next.token, account.token);
});

test('REST takeover clears a disconnected voice grace peer and frees room capacity', { timeout: 15_000 }, async () => {
  const owner = await register('grace-owner@example.com', 'Grace Owner');
  const guest = await register('grace-guest@example.com', 'Grace Guest');
  const ownerSocket = socketFor(owner); const guestSocket = socketFor(guest);
  sockets.push(ownerSocket.socket, guestSocket.socket);
  assert.equal((await ownerSocket.register).ok, true);
  assert.equal((await guestSocket.register).ok, true);
  const created = await emit<any>(ownerSocket.socket, 'room:create', { name: 'Grace Room', maxMembers: 1 });
  assert.equal((await emit<any>(ownerSocket.socket, 'room:join', created.room.id)).ok, true);
  ownerSocket.socket.emit('voice:join', created.room.id);
  const oldSocketId = ownerSocket.socket.id!;
  ownerSocket.socket.io.engine.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fake.peers.has(oldSocketId), true);
  assert.equal((await emit<any>(guestSocket.socket, 'room:join', created.room.id)).code, 'ROOM_FULL');

  const next = await login('grace-owner@example.com');
  assert.equal(fake.peers.has(oldSocketId), false);
  assert.equal((await emit<any>(guestSocket.socket, 'room:join', created.room.id)).ok, true);
  const stale = socketFor(owner); sockets.push(stale.socket);
  assert.equal((await stale.register).error, '登录已失效，请重新登录');
  stale.socket.disconnect();
  assert.notEqual(next.token, owner.token);
});

test('server password rotation disconnects active sockets and rejects the old access token', { timeout: 15_000 }, async () => {
  const account = await register('rotate-server@example.com', 'Rotate Server');
  const active = socketFor(account);
  sockets.push(active.socket);
  assert.equal((await active.register).ok, true);

  const oldAccessToken = serverAccessToken;
  const accessInvalid = new Promise<any>(resolve => active.socket.once('server:access-invalid', resolve));
  const disconnected = new Promise<void>(resolve => active.socket.once('disconnect', () => resolve()));
  const response = await fetch(`${base}/api/security/rotate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...serverHeaders(oldAccessToken) },
    body: JSON.stringify({ currentPassword: 'server-password-123', newPassword: 'rotated-server-123' }),
  });
  assert.equal(response.status, 200);
  serverAccessToken = (await response.json()).accessToken;
  assert.deepEqual(await accessInvalid, {
    code: 'SERVER_ACCESS_INVALID',
    message: '服务器访问令牌已失效，请重新验证服务器密码',
  });
  await disconnected;

  const staleRooms = await fetch(`${base}/api/rooms`, { headers: serverHeaders(oldAccessToken) });
  assert.equal(staleRooms.status, 401);
  assert.ok(serverAccessToken);
});

test('mobile screen transport is isolated from voice and closes independently', { timeout: 10_000 }, async () => {
  const account = await register('mobile-sharer@example.com', 'Mobile Sharer');
  const client = socketFor(account); sockets.push(client.socket);
  assert.equal((await client.register).ok, true);
  const { room } = await emit<any>(client.socket, 'room:create', { name: 'Mobile Share' });
  assert.equal((await emit<any>(client.socket, 'room:join', room.id)).ok, true);
  const peer = fake.peers.get(client.socket.id);
  assert.deepEqual(await emit<any>(client.socket, 'ms:screen-sharing-capabilities', {}), { dedicatedTransport: true });
  // Legacy mobile joins voice AFTER setting up its mic. Keep that path working.
  const voice = await emit<any>(client.socket, 'ms:create-transport', { direction: 'send' });
  const mic = await emit<any>(client.socket, 'ms:produce', { transportId: voice.id, kind: 'audio', rtpParameters: {}, appData: { type: 'mic' } });
  assert.ok(mic.producerId);
  const micProducer = peer.producers.get(mic.producerId);
  const voiceTransport = peer.sendTransport;
  const rejected = await emit<any>(client.socket, 'ms:create-transport', { direction: 'send', purpose: 'screen' });
  assert.match(rejected.error, /加入语音/);
  assert.equal((await emit<any>(client.socket, 'voice:join', room.id)).ok, true);
  const share = await emit<any>(client.socket, 'ms:create-transport', { direction: 'send', purpose: 'screen' });
  assert.equal(share.purpose, 'screen');
  assert.equal(peer.sendTransport, voiceTransport);
  assert.equal(voiceTransport.closed, false);
  assert.equal(micProducer.closed, false);
  const invalid = await emit<any>(client.socket, 'ms:produce', { transportId: share.id, kind: 'audio', rtpParameters: {}, appData: { type: 'mic' } });
  assert.match(invalid.error, /仅用于屏幕/);
  const video = await emit<any>(client.socket, 'ms:produce', { transportId: share.id, kind: 'video', rtpParameters: {}, appData: { type: 'screen' } });
  const playback = await emit<any>(client.socket, 'ms:produce', { transportId: share.id, kind: 'audio', rtpParameters: {}, appData: { type: 'screen-audio' } });
  assert.ok(video.producerId); assert.ok(playback.producerId);
  client.socket.emit('ms:close-screen-transport', { transportId: voice.id });
  // Ack barrier confirms the preceding no-op request was processed.
  await emit<any>(client.socket, 'ms:screen-sharing-capabilities', {});
  assert.equal(peer.screenSendTransport.closed, false);
  client.socket.emit('ms:close-screen-transport', { transportId: share.id });
  await emit<any>(client.socket, 'ms:screen-sharing-capabilities', {});
  assert.equal(peer.screenSendTransport, null);
  assert.equal(peer.producers.has(video.producerId), false);
  assert.equal(peer.producers.has(playback.producerId), false);
  assert.equal(micProducer.closed, false);
  const next = await emit<any>(client.socket, 'ms:create-transport', { direction: 'send', purpose: 'screen' });
  const nextTransport = peer.screenSendTransport;
  client.socket.emit('voice:leave', room.id);
  await emit<any>(client.socket, 'ms:screen-sharing-capabilities', {});
  assert.equal(nextTransport.closed, true);
  assert.equal(peer.screenSendTransport, null);
  assert.ok(next.id);
});

test('controller leaving voice terminates the remote control session and notifies the sharer', { timeout: 10_000 }, async () => {
  const sharerAccount = await register('rc-sharer@example.com', 'RC Sharer');
  const controllerAccount = await register('rc-controller@example.com', 'RC Controller');
  // 远程控制要求双方都是支持远控的桌面客户端注册。
  const desktopSocket = (account: Account) => {
    const socket = connectSocket(base, { autoConnect: false, reconnection: false, auth: { serverAccessToken, clientProtocol } });
    const register = new Promise<any>(resolve => socket.on('connect', () => socket.emit('user:register', {
      username: account.account.username,
      clientId: `client-${account.account.id}-rc`,
      authToken: account.token,
      platform: 'desktop',
      remoteControlSupported: true,
    }, resolve)));
    socket.connect();
    sockets.push(socket);
    return { socket, register };
  };
  const sharer = desktopSocket(sharerAccount);
  const controller = desktopSocket(controllerAccount);
  assert.equal((await sharer.register).ok, true);
  assert.equal((await controller.register).ok, true);

  const created = await emit<any>(sharer.socket, 'room:create', { name: 'RC Room' });
  const roomId = created.room.id;
  assert.equal((await emit<any>(sharer.socket, 'room:join', { roomId })).ok, true);
  assert.equal((await emit<any>(controller.socket, 'room:join', { roomId })).ok, true);

  // 注入假的屏幕共享 producer，让共享者满足 isSharingScreen。
  const sharerPeer = fake.peers.get(sharer.socket.id);
  assert.ok(sharerPeer);
  sharerPeer.roomId = roomId;
  sharerPeer.producers.set('screen-1', { id: 'screen-1', closed: false, appData: { type: 'screen' }, close() {} });

  const request = await emit<any>(controller.socket, 'remote-control:request', { roomId, sharerSocketId: sharer.socket.id });
  assert.equal(request.ok, true);

  const stopped = new Promise<any>(resolve => sharer.socket.once('remote-control:stopped', resolve));
  const respond = await emit<any>(sharer.socket, 'remote-control:respond', { requestId: request.requestId, accepted: true });
  assert.equal(respond.ok, true);

  // 控制者直接退出语音（不离开频道）：会话必须终止并通知被控方。
  controller.socket.emit('voice:leave', roomId);
  const stoppedPayload = await stopped;
  assert.equal(typeof stoppedPayload.sessionId, 'string');
  assert.match(stoppedPayload.reason, /退出语音/);
});
