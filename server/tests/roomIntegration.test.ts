import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Module from 'node:module';
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
(Module as any)._load = function(request: string, parent: unknown, isMain: boolean) {
  if (request === 'better-sqlite3') return TestDatabase;
  if (request === './ms' || request.endsWith('/src/ms')) {
    return {
      MS_IP: '127.0.0.1', MS_PORT: 40000, router: null, webRtcServer: null,
      peers: fake.peers, createPeer: (id: string) => { const peer = { roomId: null, sendTransport: null, recvTransport: null, producers: new Map(), consumers: new Map() }; fake.peers.set(id, peer); return peer; },
      removePeer: (id: string) => fake.peers.delete(id), getRoomProducers: () => [], initMediasoup: async () => {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let dataDir = '';
let base = '';
let startServer: (port?: number) => Promise<number>;
let stopServer: () => Promise<void>;

type Account = { token: string; account: { id: string; email: string; username: string } };
async function register(email: string, username: string): Promise<Account> {
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password-123', username }) });
  assert.equal(response.status, 201);
  return response.json() as Promise<Account>;
}
async function login(email: string): Promise<Account> {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password-123' }) });
  assert.equal(response.status, 200);
  return response.json() as Promise<Account>;
}
function socketFor(account: Account) {
  const socket = connectSocket(base, { autoConnect: false, reconnection: false });
  const register = new Promise<any>(resolve => socket.on('connect', () => socket.emit('user:register', { username: account.account.username, clientId: `client-${account.account.id}-1234`, authToken: account.token }, resolve)));
  socket.connect();
  return { socket, register };
}
function emit<T>(socket: Socket, event: string, data: unknown) {
  return new Promise<T>((resolve, reject) => socket.timeout(5_000).emit(event, data, (error: Error | null, result: T) => error ? reject(error) : resolve(result)));
}

const sockets: Socket[] = [];
before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'cove-room-integration-'));
  process.env.COVE_DATA_DIR = dataDir;
  ({ startServer, stopServer } = await import('../src/index'));
  const port = await startServer(0);
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  sockets.forEach(socket => socket.disconnect());
  await stopServer();
  (Module as any)._load = originalLoad;
  if (dataDir && path.dirname(dataDir) === path.resolve(tmpdir()) && path.basename(dataDir).startsWith('cove-room-integration-'))
    await rm(dataDir, { recursive: true, force: true });
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
  assert.equal((await emit<any>(ownerSocket.socket, 'room:join', { roomId: created.room.id })).ok, true);
  assert.equal((await emit<any>(aSocket.socket, 'room:history', { roomId: created.room.id })).code, 'FORBIDDEN');
  const historyResponse = await fetch(`${base}/api/rooms/${created.room.id}/messages`);
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
  const list = await (await fetch(`${base}/api/rooms`)).json() as any[];
  assert.equal(list.some(room => 'passwordHash' in room || 'passwordSalt' in room), false);
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
