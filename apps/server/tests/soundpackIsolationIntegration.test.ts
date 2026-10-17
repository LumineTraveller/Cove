import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { ServerResponse } from 'node:http';
import { io as connectSocket, type Socket } from 'socket.io-client';

// Runtime Node provides SQLite; this repository's Node typings predate it.
interface FixtureDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): { all(...values: any[]): any[]; get(...values: any[]): any; run(...values: any[]): { changes: number | bigint } };
  close(): void;
}
const { DatabaseSync }: { DatabaseSync: new (filename: string) => FixtureDatabase } = require('node:sqlite');

class TestDatabase {
  static readonly open = new Set<TestDatabase>();
  private readonly db: FixtureDatabase;
  constructor(filename: string) { this.db = new DatabaseSync(filename); TestDatabase.open.add(this); }
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
  close() {
    if (!TestDatabase.open.delete(this)) return;
    this.db.close();
  }
}

type Account = { token: string; account: { id: string; email: string; username: string } };
type Actor = { account: Account; socket: Socket };
type Pack = { id: string; roomId: string; name: string; filename: string; originalFilename: string; uploader: string; canDelete: boolean };
type Captured = { event: string; payload: any };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function emit<T = any>(socket: Socket, event: string, data?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const ack = (error: Error | null, result: T) => error ? reject(error) : resolve(result);
    if (data === undefined) socket.timeout(5_000).emit(event, ack);
    else socket.timeout(5_000).emit(event, data, ack);
  });
}
async function denied(response: Response) {
  const body = await response.text();
  assert.ok([400, 401, 403, 404, 410].includes(response.status), `expected access denial, got ${response.status}: ${body}`);
  return body;
}

test('soundpack HTTP, files, mutations and broadcasts enforce current account and room membership', { timeout: 60_000 }, async t => {
  const keys = ['COVE_DATA_DIR', 'COVE_DOWNLOAD_DIR', 'COVE_SERVER_SECURITY_ENABLED', 'COVE_BOOTSTRAP_TOKEN', 'COVE_BOOTSTRAP_TOKEN_FILE'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cove-soundpack-isolation-'));
  const soundsDir = path.join(dataDir, 'sounds');
  const originalLoad = (Module as any)._load;
  const peers = new Map<string, any>();
  const sockets: Socket[] = [];
  const captures = new Map<Socket, Captured[]>();
  const normalizedSources: string[] = [];
  const legacyEntered = deferred();
  const legacyRelease = deferred();
  let uploadGate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; completed?: ReturnType<typeof deferred> } | undefined;
  let stopServer: (() => Promise<void>) | undefined;
  let base = '';
  let serverToken = '';
  const roomA = 'fixture-room-a';
  let roomB = '';
  const bytes = Buffer.from('FICTIONAL AUDIO FIXTURE 0123456789');
  const bootstrap = 'soundpack-test-bootstrap-public-fixture';
  const headers = (account?: Account) => ({
    authorization: `Bearer ${serverToken}`,
    'x-cove-client-protocol': '3',
    'x-cove-client-version': '2.0.0',
    'x-cove-client-platform': 'desktop',
    ...(account ? { 'x-cove-account-token': account.token } : {}),
  });
  const api = (url: string, account?: Account, init: RequestInit = {}) => fetch(base + url, {
    ...init, headers: { ...headers(account), ...(init.headers as Record<string, string> | undefined) },
  });
  const inspect = <T>(fn: (db: FixtureDatabase) => T): T => {
    const db = new DatabaseSync(path.join(dataDir, 'cove.db'));
    try { return fn(db); } finally { db.close(); }
  };
  const barrier = async (...actors: Actor[]) => {
    for (const actor of actors) if (actor.socket.connected) await emit(actor.socket, 'presence:get');
  };
  const resetEvents = () => { for (const events of captures.values()) events.length = 0; };
  const events = (actor: Actor, event?: string) => (captures.get(actor.socket) ?? []).filter(item => !event || item.event === event);
  const connect = async (account: Account): Promise<Actor> => {
    const socket = connectSocket(base, {
      autoConnect: false, reconnection: false,
      auth: { serverAccessToken: serverToken, clientProtocol: 3, clientVersion: '2.0.0', clientPlatform: 'desktop' },
    });
    sockets.push(socket);
    const captured: Captured[] = []; captures.set(socket, captured);
    for (const event of ['soundpack:added', 'soundpack:deleted', 'soundpack:renamed', 'soundpack:reordered', 'soundpack:normalized', 'soundpack:play']) {
      socket.on(event, payload => captured.push({ event, payload }));
    }
    await bounded(new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect();
    }), 'socket connect');
    assert.equal((await emit(socket, 'user:register', { authToken: account.token, platform: 'desktop' })).ok, true);
    return { account, socket };
  };
  const register = async (suffix: string) => {
    const response = await api('/api/auth/register', undefined, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${suffix}@example.test`, username: `Fixture ${suffix}`, password: 'account-fixture-password' }),
    });
    assert.equal(response.status, 201);
    return response.json() as Promise<Account>;
  };
  const join = async (actor: Actor, roomId: string) => assert.equal((await emit(actor.socket, 'room:join', { roomId })).ok, true);
  const list = async (actor: Actor, roomId: string) => {
    const response = await api(`/api/soundpacks?roomId=${encodeURIComponent(roomId)}`, actor.account);
    assert.equal(response.status, 200);
    const payload = await response.json() as { roomId: string; soundpacks: Pack[] };
    assert.equal(Array.isArray(payload), false, 'room scope must be a verified response envelope');
    assert.equal(payload.roomId, roomId);
    assert.ok(Array.isArray(payload.soundpacks));
    assert.ok(payload.soundpacks.every(pack => pack.roomId === roomId));
    return payload.soundpacks;
  };
  const post = (actor: Actor, roomId?: string, extra: object = {}) => api('/api/soundpacks', actor.account, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Fixture sound', mimeType: 'audio/wav', data: bytes.toString('base64'), ...(roomId ? { roomId } : {}), ...extra }),
  });
  const upload = async (actor: Actor, roomId: string, extra: object = {}) => {
    const response = await post(actor, roomId, extra);
    assert.equal(response.status, 200, await response.clone().text());
    const pack = await response.json() as Pack;
    assert.equal(pack.roomId, roomId);
    assert.equal(pack.uploader, actor.account.account.username);
    return pack;
  };
  const file = (pack: Pack, roomId: string, variant = 'playback') => `/api/soundpacks/${encodeURIComponent(pack.id)}/file?roomId=${encodeURIComponent(roomId)}&variant=${variant}`;

  (Module as any)._load = function(request: string, parent: unknown, isMain: boolean) {
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
    if (request.endsWith('/soundpackNormalization')) return {
      async normalizeSoundpack(source: string, destination: string) {
        let completed: ReturnType<typeof deferred> | undefined;
        normalizedSources.push(source);
        if (path.basename(source) === 'scoped-legacy.wav') {
          legacyEntered.resolve(); await legacyRelease.promise;
        } else if (uploadGate) {
          const gate = uploadGate; uploadGate = undefined;
          completed = gate.completed;
          gate.entered.resolve(); await gate.release.promise;
        }
        await copyFile(source, destination);
        completed?.resolve();
      },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.COVE_DATA_DIR = dataDir;
  process.env.COVE_DOWNLOAD_DIR = path.join(dataDir, 'downloads');
  process.env.COVE_SERVER_SECURITY_ENABLED = 'true';
  process.env.COVE_BOOTSTRAP_TOKEN = bootstrap;
  delete process.env.COVE_BOOTSTRAP_TOKEN_FILE;
  try {
    await mkdir(soundsDir);
    const seed = new DatabaseSync(path.join(dataDir, 'cove.db'));
    seed.exec('CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt INTEGER NOT NULL)');
    seed.prepare('INSERT INTO rooms VALUES (?, ?, ?)').run(roomA, 'Fixture Room A', 1);
    seed.exec('CREATE TABLE soundpacks (id TEXT PRIMARY KEY, name TEXT NOT NULL, filename TEXT NOT NULL, uploader TEXT NOT NULL, createdAt INTEGER NOT NULL, roomId TEXT)');
    seed.prepare('INSERT INTO soundpacks VALUES (?, ?, ?, ?, ?, ?)').run('unassigned-legacy', 'Quarantined fixture', 'unassigned-legacy.wav', 'Legacy fixture', 1, null);
    seed.prepare('INSERT INTO soundpacks VALUES (?, ?, ?, ?, ?, ?)').run('scoped-legacy', 'Scoped legacy fixture', 'scoped-legacy.wav', 'Legacy fixture', 2, roomA);
    seed.close();
    await writeFile(path.join(soundsDir, 'unassigned-legacy.wav'), bytes);
    await writeFile(path.join(soundsDir, 'scoped-legacy.wav'), bytes);
    // CommonJS require preserves the import-before-stub ordering of this fixture.
    const server = require('../src/index'); stopServer = server.stopServer;
    base = `http://127.0.0.1:${await server.startServer(0)}`;
    const unlocked = await api('/api/security/bootstrap', undefined, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: bootstrap, password: 'server-fixture-password' }),
    });
    assert.equal(unlocked.status, 201);
    serverToken = (await unlocked.json()).accessToken;
    const a = await connect(await register('owner-a'));
    const b = await connect(await register('owner-b'));
    const c = await connect(await register('member-a'));
    await join(a, roomA); await join(c, roomA);
    roomB = (await emit(b.socket, 'room:create', { name: 'Fixture Room B' })).room.id;
    await join(b, roomB);

    await t.test('legacy normalization is room scoped and never assigns historical global packs', async () => {
      await bounded(legacyEntered.promise, 'scoped legacy normalization');
      resetEvents();
      const normalizedA = bounded(new Promise<void>(resolve => a.socket.once('soundpack:normalized', () => resolve())), 'owner normalization event');
      const normalizedC = bounded(new Promise<void>(resolve => c.socket.once('soundpack:normalized', () => resolve())), 'member normalization event');
      legacyRelease.resolve();
      await Promise.all([normalizedA, normalizedC]);
      await barrier(a, b, c);
      assert.equal(events(b).length, 0);
      assert.ok(events(a, 'soundpack:normalized').every(item => item.payload.roomId === roomA));
      assert.ok(events(c, 'soundpack:normalized').every(item => item.payload.roomId === roomA));
      assert.equal(normalizedSources.some(source => path.basename(source) === 'unassigned-legacy.wav'), false);
      assert.equal(inspect(db => db.prepare('SELECT roomId FROM soundpacks WHERE id = ?').get('unassigned-legacy')!.roomId), null);
      assert.deepEqual((await list(a, roomA)).map(pack => pack.id), ['scoped-legacy']);
      assert.deepEqual(await list(b, roomB), []);
    });

    const packA = await upload(a, roomA, { name: 'A sound', socketId: b.socket.id });
    const secondA = await upload(a, roomA, { name: 'A second sound' });
    const packC = await upload(c, roomA, { name: 'Member A sound' });
    const packB = await upload(b, roomB, { name: 'B sound' });

    await t.test('lists require an account and explicit joined room; client socket ids grant no authority', async () => {
      assert.ok((await list(a, roomA)).some(pack => pack.id === packA.id));
      assert.equal((await list(a, roomA)).some(pack => pack.id === packB.id || pack.id === 'unassigned-legacy'), false);
      assert.deepEqual((await list(b, roomB)).map(pack => pack.id), [packB.id]);
      await denied(await api('/api/soundpacks', a.account));
      await denied(await api(`/api/soundpacks?roomId=${roomA}`));
      await denied(await api(`/api/soundpacks?roomId=${roomA}&socketId=${a.socket.id}`, b.account));
      const noServer = await fetch(base + `/api/soundpacks?roomId=${roomA}`, { headers: { ...headers(a.account), authorization: '' } });
      await denied(noServer);
      await denied(await api(`/api/soundpacks?roomId=${roomA}`, undefined, { headers: { 'x-cove-account-token': 'fictional-invalid-token' } }));
      const realUploader = inspect(db => db.prepare('SELECT uploaderId FROM soundpacks WHERE id = ?').get(packA.id)!.uploaderId);
      assert.equal(realUploader, `account:${a.account.account.id}`, 'body socketId must not impersonate the uploader');
    });

    await t.test('upload rejects missing scope and foreign rooms without leaving files or broadcasts', async () => {
      const before = (await readdir(soundsDir)).sort(); resetEvents();
      await denied(await post(a));
      await denied(await post(b, roomA, { socketId: a.socket.id }));
      await denied(await api('/api/soundpacks', undefined, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'No account', roomId: roomA, socketId: a.socket.id, mimeType: 'audio/wav', data: bytes.toString('base64') }) }));
      await barrier(a, b, c);
      assert.deepEqual((await readdir(soundsDir)).sort(), before);
      assert.equal(events(a).length + events(b).length + events(c).length, 0);
    });

    await t.test('original and playback downloads enforce scope, account and Range; old static URLs stay closed', async () => {
      for (const variant of ['playback', 'original']) {
        const response = await api(file(packA, roomA, variant), a.account);
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
        assert.match(response.headers.get('cache-control') ?? '', /no-store/);
        const head = await api(file(packA, roomA, variant), a.account, { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(head.headers.get('content-length'), String(bytes.length));
        assert.equal((await head.arrayBuffer()).byteLength, 0);
        const range = await api(file(packA, roomA, variant), c.account, { headers: { range: 'bytes=2-6' } });
        assert.equal(range.status, 206);
        assert.equal(range.headers.get('content-range'), `bytes 2-6/${bytes.length}`);
        assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(2, 7));
        await denied(await api(file(packA, roomB, variant), b.account));
        await denied(await api(file(packA, roomA, variant), b.account));
        await denied(await api(file(packA, roomA, variant)));
        await denied(await api(file(packA, roomA, variant), b.account, { method: 'HEAD' }));
        await denied(await api(file(packA, roomA, variant), b.account, { headers: { range: 'bytes=0-1' } }));
        await denied(await api(file(packA, roomA, variant), undefined, { method: 'HEAD' }));
        await denied(await api(file(packA, roomA, variant), undefined, { headers: { range: 'bytes=0-1' } }));
      }
      await denied(await api(`/api/soundpacks/${packA.id}/file?variant=original`, a.account));
      await denied(await api(file(packA, roomA, 'not-a-variant'), a.account));
      await denied(await api(file(packA, roomA) + `&account_token=${encodeURIComponent(a.account.token)}`));
      for (const filename of [packA.filename, packA.originalFilename, 'unassigned-legacy.wav']) {
        const response = await api(`/sounds/${encodeURIComponent(filename)}?access_token=${serverToken}&client_protocol=3`, a.account);
        await denied(response);
      }
      await denied(await api(`/api/soundpacks/unassigned-legacy/file?roomId=${roomA}&variant=original`, a.account));
    });

    await t.test('foreign sound ids cannot be renamed, deleted, reordered or played by another room owner', async () => {
      const original = inspect(db => ({ ...db.prepare('SELECT * FROM soundpacks WHERE id = ?').get(packB.id) }));
      resetEvents();
      for (const [event, payload] of [
        ['soundpack:rename', { soundId: packB.id, roomId: roomA, name: 'Wrong-room rename' }],
        ['soundpack:delete', { soundId: packB.id, roomId: roomA }],
        ['soundpack:reorder', { roomId: roomA, orderedIds: [packB.id] }],
        ['soundpack:play', { soundId: packB.id, roomId: roomA }],
      ] as const) assert.equal((await emit(a.socket, event, payload)).ok, false, event);
      assert.equal((await emit(c.socket, 'soundpack:delete', { soundId: packA.id, roomId: roomA })).ok, false);
      assert.equal((await emit(a.socket, 'soundpack:delete', { soundId: packA.id })).ok, false);
      await barrier(a, b, c);
      assert.deepEqual(inspect(db => ({ ...db.prepare('SELECT * FROM soundpacks WHERE id = ?').get(packB.id) })), original);
      assert.equal(events(a).length + events(b).length + events(c).length, 0);
    });

    await t.test('valid mutations and playback include roomId and reach only current room or voice members', async () => {
      resetEvents();
      const added = await upload(a, roomA, { name: 'Broadcast fixture' });
      assert.equal((await emit(a.socket, 'soundpack:rename', { soundId: added.id, roomId: roomA, name: 'Renamed fixture' })).ok, true);
      const ids = (await list(a, roomA)).map(pack => pack.id).reverse();
      assert.equal((await emit(c.socket, 'soundpack:reorder', { roomId: roomA, orderedIds: ids })).ok, true);
      assert.deepEqual((await list(a, roomA)).map(pack => pack.id), ids);
      assert.equal((await emit(a.socket, 'soundpack:delete', { soundId: packC.id, roomId: roomA })).ok, true, 'actual room owner may delete another uploader\'s pack');
      assert.equal(existsSync(path.join(soundsDir, packC.filename)), false);
      assert.equal(existsSync(path.join(soundsDir, packC.originalFilename)), false);
      await barrier(a, b, c);
      for (const event of ['soundpack:added', 'soundpack:renamed', 'soundpack:reordered', 'soundpack:deleted']) {
        assert.ok(events(a, event).length > 0, event);
        assert.ok(events(c, event).length > 0, event);
        assert.ok(events(a, event).every(item => item.payload.roomId === roomA));
        assert.ok(events(c, event).every(item => item.payload.roomId === roomA));
      }
      assert.equal(events(b).length, 0);
      assert.equal((await emit(a.socket, 'voice:join', roomA)).ok, true);
      assert.equal((await emit(b.socket, 'voice:join', roomB)).ok, true);
      assert.equal((await emit(c.socket, 'soundpack:play', { soundId: packA.id, roomId: roomA })).ok, false, 'channel-only member cannot play');
      resetEvents();
      assert.equal((await emit(a.socket, 'soundpack:play', { soundId: packB.id, roomId: roomA })).ok, false, 'voice membership must not allow a foreign pack');
      assert.equal((await emit(a.socket, 'soundpack:play', { soundId: packA.id, roomId: roomA })).ok, true);
      await barrier(a, b, c);
      assert.equal(events(a, 'soundpack:play').length, 1);
      assert.equal(events(a, 'soundpack:play')[0].payload.roomId, roomA);
      assert.equal(events(c, 'soundpack:play').length, 0);
      assert.equal(events(b).length, 0);
      assert.equal((await emit(c.socket, 'voice:join', roomA)).ok, true);
      resetEvents();
      assert.equal((await emit(a.socket, 'soundpack:play', { soundId: secondA.id, roomId: roomA })).ok, true);
      await barrier(a, b, c);
      assert.equal(events(a, 'soundpack:play').length, 1);
      assert.equal(events(c, 'soundpack:play').length, 1);
      assert.equal(events(c, 'soundpack:play')[0].payload.roomId, roomA);
      assert.equal(events(b).length, 0);
    });

    await t.test('leaving during asynchronous normalization cancels upload and cleans every partial file', async () => {
      const entered = deferred(); const release = deferred();
      uploadGate = { entered, release };
      const before = (await readdir(soundsDir)).sort(); resetEvents();
      const pending = post(c, roomA, { name: 'Cancelled fixture' });
      try {
        await bounded(entered.promise, 'upload normalization gate');
        c.socket.emit('room:leave', roomA);
        await barrier(c);
      } finally { release.resolve(); }
      await denied(await pending);
      await barrier(a, b, c);
      assert.deepEqual((await readdir(soundsDir)).sort(), before);
      assert.equal(inspect(db => db.prepare('SELECT COUNT(*) AS count FROM soundpacks WHERE name = ?').get('Cancelled fixture')!.count), 0);
      assert.equal(events(a, 'soundpack:added').length + events(b, 'soundpack:added').length + events(c, 'soundpack:added').length, 0);
      await denied(await api(file(packA, roomA), c.account));
      assert.equal((await emit(c.socket, 'soundpack:delete', { soundId: packA.id, roomId: roomA })).ok, false);
      await join(c, roomA);
      assert.equal((await api(file(packA, roomA), c.account)).status, 200);
    });

    await t.test('aborting a fully received upload closes its response and cleans files before any commit', async () => {
      const entered = deferred(); const release = deferred(); const completed = deferred(); const closed = deferred();
      uploadGate = { entered, release, completed };
      const originalEmit = ServerResponse.prototype.emit;
      let requestWasAborted: boolean | undefined;
      // Observe the real HTTP response close rather than sleeping after abort().
      // The request body has already reached the normalizer, so req.aborted can
      // remain false and must not be the only cancellation guard.
      (ServerResponse.prototype as any).emit = function(event: string, ...args: any[]) {
        if (event === 'close' && this.req?.url === '/api/soundpacks' && !this.writableFinished) {
          requestWasAborted = this.req.aborted; closed.resolve();
        }
        return (originalEmit as any).call(this, event, ...args);
      };
      const controller = new AbortController();
      const before = (await readdir(soundsDir)).sort(); resetEvents();
      const pending = api('/api/soundpacks', c.account, {
        method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Aborted fixture', roomId: roomA, mimeType: 'audio/wav', data: bytes.toString('base64') }),
      }).then(response => ({ response, error: undefined }), error => ({ response: undefined, error }));
      try {
        await bounded(entered.promise, 'abort upload body was fully received');
        controller.abort();
        const result = await bounded(pending, 'client upload abort');
        assert.equal(result.error?.name, 'AbortError');
        await bounded(closed.promise, 'server observed response close');
        assert.equal(requestWasAborted, false, 'test must exercise response cancellation after the body was received');
      } finally {
        release.resolve();
        ServerResponse.prototype.emit = originalEmit;
      }
      await bounded(completed.promise, 'aborted normalization finished');
      await barrier(a, b, c);
      assert.deepEqual((await readdir(soundsDir)).sort(), before);
      assert.equal(inspect(db => db.prepare('SELECT COUNT(*) AS count FROM soundpacks WHERE name = ?').get('Aborted fixture')!.count), 0);
      assert.equal(events(a, 'soundpack:added').length + events(b, 'soundpack:added').length + events(c, 'soundpack:added').length, 0);
    });

    await t.test('revoked accounts lose HTTP, socket and broadcast access even while the socket remains mapped', async () => {
      const revokedUpload = await upload(c, roomA, { name: 'Revoked uploader fixture' });
      const entered = deferred(); const release = deferred();
      uploadGate = { entered, release };
      const before = (await readdir(soundsDir)).sort();
      const pending = post(c, roomA, { name: 'Revoked pending fixture' });
      try {
        await bounded(entered.promise, 'revoked pending upload started');
        const response = await api('/api/auth/logout', c.account, { method: 'POST' });
        assert.equal(response.status, 204);
      } finally { release.resolve(); }
      await denied(await pending);
      assert.deepEqual((await readdir(soundsDir)).sort(), before);
      assert.equal(inspect(db => db.prepare('SELECT COUNT(*) AS count FROM soundpacks WHERE name = ?').get('Revoked pending fixture')!.count), 0);
      assert.equal(c.socket.connected, true, 'fixture exercises a still-mapped logged-out socket');
      await denied(await api(`/api/soundpacks?roomId=${roomA}`, c.account));
      await denied(await api(file(packA, roomA), c.account));
      await denied(await post(c, roomA));
      assert.equal((await emit(c.socket, 'soundpack:delete', { roomId: roomA, soundId: revokedUpload.id })).ok, false);
      assert.equal((await emit(c.socket, 'soundpack:rename', { roomId: roomA, soundId: revokedUpload.id, name: 'Revoked rename' })).ok, false);
      assert.equal((await emit(c.socket, 'soundpack:play', { roomId: roomA, soundId: packA.id })).ok, false);
      resetEvents();
      await upload(a, roomA, { name: 'After revocation fixture' });
      assert.equal((await emit(a.socket, 'soundpack:play', { roomId: roomA, soundId: packA.id })).ok, true);
      await barrier(a, b, c);
      assert.equal(events(c).length, 0);
      assert.equal(events(b).length, 0);
    });

    await t.test('expired account sessions are rechecked for files, HEAD, Range, mutations and broadcasts', async () => {
      const expired = await connect(await register('expiring-member'));
      await join(expired, roomA);
      assert.equal((await emit(expired.socket, 'voice:join', roomA)).ok, true);
      const owned = await upload(expired, roomA, { name: 'Expiring uploader fixture' });
      inspect(db => db.prepare('UPDATE account_sessions SET expiresAt = ? WHERE accountId = ?').run(Date.now() - 1, expired.account.account.id));
      assert.equal(expired.socket.connected, true);
      await denied(await api(`/api/soundpacks?roomId=${roomA}`, expired.account));
      for (const init of [{}, { method: 'HEAD' }, { headers: { range: 'bytes=0-1' } }])
        await denied(await api(file(packA, roomA), expired.account, init));
      await denied(await post(expired, roomA));
      assert.equal((await emit(expired.socket, 'soundpack:rename', { roomId: roomA, soundId: owned.id, name: 'Expired rename' })).ok, false);
      assert.equal((await emit(expired.socket, 'soundpack:delete', { roomId: roomA, soundId: owned.id })).ok, false);
      assert.equal((await emit(expired.socket, 'soundpack:play', { roomId: roomA, soundId: packA.id })).ok, false);
      assert.equal((await emit(expired.socket, 'soundpack:reorder', { roomId: roomA, orderedIds: (await list(a, roomA)).map(pack => pack.id) })).ok, false);
      resetEvents();
      await upload(a, roomA, { name: 'After account expiry fixture' });
      assert.equal((await emit(a.socket, 'soundpack:play', { roomId: roomA, soundId: packA.id })).ok, true);
      await barrier(a, b, expired);
      assert.equal(events(expired).length, 0);
      assert.equal(events(b).length, 0);
    });

    await t.test('kicking a member and deleting a room immediately revoke file access', async () => {
      const d = await connect(await register('kick-member'));
      await join(d, roomA);
      assert.equal((await api(file(packA, roomA), d.account)).status, 200);
      assert.equal((await emit(a.socket, 'room:kick', { roomId: roomA, targetSocketId: d.socket.id })).ok, true);
      await barrier(d);
      await denied(await api(file(packA, roomA), d.account));
      assert.equal((await emit(d.socket, 'soundpack:play', { roomId: roomA, soundId: packA.id })).ok, false);
      assert.equal((await emit(b.socket, 'room:delete', { roomId: roomB })).ok, true);
      await denied(await api(file(packB, roomB), b.account));
      await denied(await api(`/api/soundpacks?roomId=${roomB}`, b.account));
      assert.ok((await list(a, roomA)).some(pack => pack.id === packA.id));
    });

    await t.test('expiry of an existing fourteen-day server grant closes soundpack HTTP and socket access', async () => {
      const grant = inspect(db => db.prepare('SELECT createdAt, expiresAt FROM server_access_sessions').get()!);
      assert.equal(Number(grant.expiresAt) - Number(grant.createdAt), 14 * 24 * 60 * 60 * 1000);
      inspect(db => db.prepare('UPDATE server_access_sessions SET expiresAt = ?').run(Date.now() - 1));
      await denied(await api(`/api/soundpacks?roomId=${roomA}`, a.account));
      for (const init of [{}, { method: 'HEAD' }, { headers: { range: 'bytes=0-1' } }])
        await denied(await api(file(packA, roomA), a.account, init));
      resetEvents();
      const invalid = bounded(new Promise<any>(resolve => a.socket.once('server:access-invalid', resolve)), 'server access invalid notice');
      const disconnected = bounded(new Promise<void>(resolve => a.socket.once('disconnect', () => resolve())), 'server access disconnect');
      a.socket.emit('soundpack:play', { roomId: roomA, soundId: packA.id });
      assert.equal((await invalid).code, 'SERVER_ACCESS_INVALID');
      await disconnected;
      assert.equal(events(a, 'soundpack:play').length, 0);
    });
  } finally {
    legacyRelease.resolve(); uploadGate?.release.resolve();
    sockets.forEach(socket => socket.disconnect());
    if (stopServer) await stopServer();
    for (const opened of TestDatabase.open) opened.close();
    (Module as any)._load = originalLoad;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('cove-soundpack-isolation-'));
    await rm(dataDir, { recursive: true, force: true });
  }
});
