import assert from 'node:assert/strict';
import test from 'node:test';
import { createPeer, peers } from '../src/features/media/ms';
import { invalidateMediaSession } from '../src/features/media/mediaLifecycle';
import { bindTransportIceRestart, restartTransportIce } from '../src/features/media/transportIceRestart';

let fixtures = 0;
function fixture(t: any, operation?: () => Promise<any>, onRestart?: () => void) {
  const socket = { id: `ice-unit-${++fixtures}`, connected: true };
  const peer = createPeer(socket.id); peer.roomId = 'room';
  let rotations = 0;
  let at = 100_000;
  const transport = {
    id: `transport-${fixtures}`, closed: false, iceState: 'connected', dtlsState: 'connected',
    async restartIce() {
      rotations++;
      return operation ? operation() : { usernameFragment: `user-${rotations}`, password: 'test-only-ice-secret', iceLite: true };
    },
  };
  peer.sendTransport = transport as any;
  const capability = bindTransportIceRestart(peer, 'room', transport as any)!;
  const request = { transportId: transport.id, roomId: 'room', sessionId: capability.sessionId, sequence: 1 };
  const run = (sequence: number, changes: Record<string, unknown> = {}, caller = socket) =>
    restartTransportIce(caller, { ...request, sequence, ...changes }, () => at, onRestart);
  t.after(() => peers.delete(socket.id));
  return { socket, peer, transport, capability, request, run, rotations: () => rotations, setTime: (value: number) => { at = value; } };
}

test('restart sequences are contiguous and old replays never rotate again', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.run(2), { ok: false, code: 'INVALID_SEQUENCE' });
  const first = await f.run(1);
  assert.equal(first.ok, true);
  assert.deepEqual(await f.run(1), first);
  assert.equal((await f.run(2)).ok, true);
  assert.deepEqual(await f.run(1), { ok: false, code: 'STALE_SEQUENCE' });
  assert.equal(f.rotations(), 2);
});

test('three distinct rotations share a rolling 30s budget; duplicates do not spend it', async t => {
  const f = fixture(t);
  for (let sequence = 1; sequence <= 3; sequence++) {
    assert.equal((await f.run(sequence)).ok, true);
    assert.equal((await f.run(sequence)).ok, true);
  }
  assert.deepEqual(await f.run(4), { ok: false, code: 'RATE_LIMITED' });
  f.setTime(129_999);
  assert.deepEqual(await f.run(4), { ok: false, code: 'RATE_LIMITED' });
  f.setTime(130_000);
  assert.equal((await f.run(4)).ok, true);
  assert.equal(f.rotations(), 4);
});

test('a new recovered Socket can retrieve an in-flight ACK without another worker rotation', async t => {
  let release!: (parameters: any) => void;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
  const oldRequest = f.run(1);
  f.socket.connected = false;
  const recovered = { id: f.socket.id, connected: true };
  const recoveredRequest = f.run(1, {}, recovered);
  assert.equal(f.rotations(), 1);
  release({ usernameFragment: 'recovered-user', password: 'test-only-ice-secret', iceLite: true });
  assert.deepEqual(await oldRequest, { ok: false, code: 'NOT_CONNECTED' });
  const result = await recoveredRequest;
  assert.equal(result.ok, true);
  assert.deepEqual(await f.run(1, {}, recovered), result);
  assert.equal(f.rotations(), 1);
});

for (const [property, value, code] of [
  ['closed', true, 'TRANSPORT_CLOSED'],
  ['iceState', 'closed', 'TRANSPORT_CLOSED'],
  ['iceState', 'disconnected', 'ICE_DISCONNECTED'],
  ['dtlsState', 'failed', 'DTLS_FAILED'],
  ['dtlsState', 'closed', 'DTLS_CLOSED'],
] as const) test(`terminal ${property}=${value} rejects restart before and after the worker`, async t => {
  const f = fixture(t);
  (f.transport as any)[property] = value;
  assert.deepEqual(await f.run(1), { ok: false, code });
  assert.equal(f.rotations(), 0);
  let release!: (parameters: any) => void;
  const pending = fixture(t, () => new Promise(resolve => { release = resolve; }));
  const operation = pending.run(1);
  (pending.transport as any)[property] = value;
  release({ usernameFragment: 'late', password: 'test-only-ice-secret' });
  assert.deepEqual(await operation, { ok: false, code });
});

test('room and peer-object replacement invalidate a pending restart, even when transport references survive', async t => {
  for (const change of ['room', 'peer-object']) {
    let release!: (parameters: any) => void;
    const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
    const operation = f.run(1);
    if (change === 'room') f.peer.roomId = 'room-next';
    else {
      const next = createPeer(f.socket.id);
      next.roomId = 'room'; next.sendTransport = f.transport as any;
    }
    release({ usernameFragment: 'late', password: 'test-only-ice-secret' });
    assert.deepEqual(await operation, { ok: false, code: 'SESSION_EXPIRED' });
  }
});

test('a birth binding is immutable and never grants another peer transport ownership', async t => {
  const f = fixture(t);
  const foreign = fixture(t);
  assert.deepEqual(await foreign.run(1, { transportId: f.transport.id, sessionId: f.capability.sessionId }),
    { ok: false, code: 'TRANSPORT_NOT_FOUND' });
  invalidateMediaSession(f.peer);
  assert.deepEqual(bindTransportIceRestart(f.peer, 'room', f.transport as any), f.capability);
  assert.deepEqual(await f.run(1), { ok: false, code: 'SESSION_EXPIRED' });
});

test('worker rejection is contained, cached per sequence and can be retried using the next sequence', async t => {
  const f = fixture(t, async () => { throw new Error('native worker failed'); });
  assert.deepEqual(await f.run(1), { ok: false, code: 'RESTART_FAILED' });
  assert.deepEqual(await f.run(1), { ok: false, code: 'RESTART_FAILED' });
  assert.equal(f.rotations(), 1);
  assert.deepEqual(await f.run(2), { ok: false, code: 'RESTART_FAILED' });
  assert.equal(f.rotations(), 2);
});

test('a throwing revocation callback fails closed and caches the failure without rotating', async t => {
  let revocations = 0;
  const f = fixture(t, undefined, () => { revocations++; throw new Error('revocation failed'); });
  assert.deepEqual(await f.run(1), { ok: false, code: 'RESTART_FAILED' });
  assert.deepEqual(await f.run(1), { ok: false, code: 'RESTART_FAILED' });
  assert.equal(revocations, 1);
  assert.equal(f.rotations(), 0);
  assert.deepEqual(await f.run(2), { ok: false, code: 'RESTART_FAILED' });
  assert.equal(revocations, 2);
  assert.equal(f.rotations(), 0);
});

test('the latest promise exists before revocation callbacks can synchronously reenter', async t => {
  let duplicate: ReturnType<typeof restartTransportIce> | undefined;
  let revocations = 0;
  const f = fixture(t, undefined, () => { revocations++; duplicate = f.run(1); });
  const first = f.run(1);
  assert.ok(duplicate);
  assert.deepEqual(await duplicate, await first);
  assert.equal((await first).ok, true);
  assert.equal(revocations, 1);
  assert.equal(f.rotations(), 1);
});

test('synchronous leave or disconnect during revocation cannot rotate a stale transport', async t => {
  for (const transition of ['leave', 'disconnect']) {
    const f = fixture(t, undefined, () => {
      if (transition === 'leave') invalidateMediaSession(f.peer);
      else f.socket.connected = false;
    });
    assert.deepEqual(await f.run(1), { ok: false, code: transition === 'leave' ? 'SESSION_EXPIRED' : 'NOT_CONNECTED' });
    assert.equal(f.rotations(), 0);
  }
});

test('unadvertised methods, malformed identities and missing resources never call the worker', async t => {
  const f = fixture(t);
  const unbound = { id: 'unbound', closed: false, restartIce: f.transport.restartIce };
  f.peer.recvTransport = unbound as any;
  assert.deepEqual(await f.run(1, { transportId: 'unbound' }), { ok: false, code: 'UNSUPPORTED' });
  for (const data of [null, [], {}, { ...f.request, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...f.request, sessionId: '' }, { ...f.request, transportId: '' }])
    assert.deepEqual(await restartTransportIce(f.socket, data), { ok: false, code: 'BAD_REQUEST' });
  assert.deepEqual(await f.run(1, { sessionId: '00000000-0000-0000-0000-000000000000' }), { ok: false, code: 'SESSION_MISMATCH' });
  peers.delete(f.socket.id);
  assert.deepEqual(await f.run(1), { ok: false, code: 'TRANSPORT_NOT_FOUND' });
  assert.equal(f.rotations(), 0);
});
