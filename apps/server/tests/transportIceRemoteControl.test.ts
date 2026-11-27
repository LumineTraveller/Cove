import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createPeer, getRoomProducers, peers } from '../src/features/media/ms';
import { invalidateMediaSession } from '../src/features/media/mediaLifecycle';
import { bindTransportIceRestart } from '../src/features/media/transportIceRestart';
import { registerMediaSocketHandlers, type RegisterMediaSocketHandlersDependencies } from '../src/features/media/socketHandlers';
import { RemoteControlRegistry, type RemoteControlInput } from '../src/features/remote-control/remoteControl';
import { createControlService } from '../src/features/remote-control/controlService';
import { registerRemoteControlSocketHandlers } from '../src/features/remote-control/socketHandlers';

let fixtureId = 0;
function fixture(t: any, recovering: 'controller' | 'sharer' = 'controller', operation?: () => Promise<any>) {
  const id = ++fixtureId;
  const controllerId = `ice-controller-${id}`;
  const sharerId = `ice-sharer-${id}`;
  const handlers = new Map<string, (...args: any[]) => any>();
  const controllerHandlers = new Map<string, (...args: any[]) => any>();
  const socket = { id: recovering === 'controller' ? controllerId : sharerId, connected: true,
    on: (event: string, fn: any) => handlers.set(event, fn) };
  const controller = { id: controllerId, connected: true,
    on: (event: string, fn: any) => controllerHandlers.set(event, fn) };
  const events: Array<{ to: string; event: string; payload: any }> = [];
  const sharerConnection = Object.assign(new EventEmitter(), { transport: { writable: true } });
  const io = {
    sockets: { sockets: new Map([[sharerId, { conn: sharerConnection }]]) },
    to: (to: string) => ({ emit: (event: string, payload: any) => { events.push({ to, event, payload }); } }),
  };
  const remoteControls = new RemoteControlRegistry();
  const controls = createControlService({ io: io as any, remoteControls });
  let revocations = 0;
  let rotations = 0;
  const peer = createPeer(socket.id); peer.roomId = 'room';
  const transport = { id: `ice-transport-${id}`, closed: false, iceState: 'connected', dtlsState: 'connected',
    async restartIce() {
      rotations++;
      // Real registry revocation must finish before any native rotation starts.
      assert.equal(revocations, rotations);
      return operation ? operation() : { usernameFragment: 'synthetic-user', password: 'synthetic-secret', iceLite: true };
    } };
  peer.sendTransport = transport as any;
  const capability = bindTransportIceRestart(peer, 'room', transport as any)!;
  const request = { transportId: transport.id, roomId: 'room', sessionId: capability.sessionId, sequence: 1 };
  registerMediaSocketHandlers({ socket, io,
    stopRemoteControlForSocket(socketId: string, reason: string) {
      revocations++;
      controls.stopRemoteControlForSocket(socketId, reason);
    },
  } as unknown as RegisterMediaSocketHandlersDependencies);
  const remoteHandlers = { io: io as any, remoteControls,
    roomMembers: new Map([['room', new Set([controllerId, sharerId])]]),
    remoteControlCapabilities: new Set([controllerId, sharerId]),
    isSharingScreen: () => true, isRemoteControlAllowed: () => true,
    userNames: new Map(), publicUserId: (value: string) => value, ...controls };
  registerRemoteControlSocketHandlers({ socket: controller as any, ...remoteHandlers });
  if (recovering === 'sharer') registerRemoteControlSocketHandlers({ socket: socket as any, ...remoteHandlers });
  function pendingRequest() {
    const created = remoteControls.createRequest('room', controllerId, sharerId);
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error('Synthetic request could not be created');
    return created.value;
  }
  function grant() {
    const created = pendingRequest();
    const responded = remoteControls.respond(created.requestId, sharerId, true);
    assert.equal(responded.ok, true);
    if (!responded.ok || !responded.value.session) throw new Error('Synthetic grant could not be created');
    return responded.value.session;
  }
  const inputEvents = () => events.filter(item => item.event === 'remote-control:input');
  const stopped = () => events.filter(item => item.event === 'remote-control:stopped');
  function input(sessionId: string, value: RemoteControlInput = { type: 'pointer', x: 0.5, y: 0.5 }) {
    controllerHandlers.get('remote-control:input')!({ sessionId, input: value });
  }
  async function restart(sequence: number, changes: Record<string, unknown> = {}) {
    let result: any;
    await handlers.get('ms:restart-ice')!({ ...request, sequence, ...changes }, (value: any) => { result = value; });
    return result;
  }
  t.after(() => peers.delete(socket.id));
  return { socket, peer, transport, request, remoteControls, events, handlers,
    pendingRequest, grant, input, inputEvents, stopped, restart, sharerConnection,
    rotations: () => rotations, revocations: () => revocations };
}

test('a publisher can change smoothing and an active remote grant overrides it for existing and late viewers', t => {
  const f = fixture(t, 'sharer');
  const screen = { id: 'published-screen', kind: 'video', closed: false, appData: { type: 'screen' } };
  f.peer.producers.set(screen.id, screen as any);
  const send = (event: string, data: unknown) => {
    let result: any;
    f.handlers.get(event)!(data, (reply: unknown) => { result = reply; });
    return result;
  };
  const policies = () => f.events.filter(item => item.event === 'screen:playback-policy');
  assert.ok(send('screen:set-smooth-playback', { producerId: 'foreign', enabled: true }).error);
  assert.ok(send('screen:set-smooth-playback', { producerId: screen.id, enabled: 'true' }).error);
  assert.deepEqual(policies(), []);

  assert.equal(send('screen:set-smooth-playback', { producerId: screen.id, enabled: true }).ok, true);
  const state = (remoteControlActive: boolean) => ({
    peerId: f.socket.id, producerId: screen.id, smoothPlayback: true, remoteControlActive,
  });
  assert.deepEqual(policies().at(-1), { to: 'room', event: 'screen:playback-policy', payload: state(false) });
  const { requestId } = f.pendingRequest();
  assert.equal(send('remote-control:respond', { requestId, accepted: true }).ok, true);
  const started = f.events.find(item => item.event === 'remote-control:started')!;
  assert.deepEqual(policies().at(-1)?.payload, state(true));
  assert.ok(f.events.indexOf(policies().at(-1)!) < f.events.indexOf(started));
  assert.deepEqual(getRoomProducers('room', 'late-viewer').find(item => item.producerId === screen.id)?.appData,
    { type: 'screen', smoothPlayback: true, remoteControlActive: true });

  assert.equal(send('remote-control:stop', { sessionId: started.payload.sessionId }).ok, true);
  assert.deepEqual(policies().at(-1)?.payload, state(false));
});

test('the relay coalesces blocked positions, preserves edges and discards a revoked tail', async t => {
  const f = fixture(t);
  const session = f.grant();
  const input = (value: RemoteControlInput) => f.input(session.sessionId, value);
  const move = (x: number) => input({ type: 'pointer', x, y: .5 });
  const delivered = () => f.inputEvents().map(event => event.payload.input);
  const connection = f.sharerConnection;
  connection.transport.writable = false;
  move(.1);
  move(.2);
  assert.deepEqual(delivered(), []);
  assert.equal(connection.listenerCount('drain'), 1);
  assert.equal(connection.listenerCount('upgrade'), 1);
  connection.transport.writable = true;
  connection.emit('drain');
  await Promise.resolve();
  assert.deepEqual(delivered(), [{ type: 'pointer', x: .2, y: .5 }]);
  assert.equal(connection.listenerCount('drain'), 0);
  assert.equal(connection.listenerCount('upgrade'), 0);

  connection.transport.writable = false;
  move(.3);
  move(.4);
  input({ type: 'button', x: .4, y: .5, button: 'left', down: true });
  input({ type: 'button', x: .4, y: .5, button: 'left', down: false });
  assert.deepEqual(delivered().slice(1), [
    { type: 'pointer', x: .4, y: .5 },
    { type: 'button', x: .4, y: .5, button: 'left', down: true },
    { type: 'button', x: .4, y: .5, button: 'left', down: false },
  ]);
  move(.6);
  assert.equal((await f.restart(1)).ok, true);
  connection.transport.writable = true;
  connection.emit('upgrade');
  await Promise.resolve();
  assert.equal(delivered().length, 4);
  assert.equal(connection.listenerCount('drain'), 0);
  assert.equal(connection.listenerCount('upgrade'), 0);
});

for (const recovering of ['controller', 'sharer'] as const) {
  test(`an accepted ${recovering} ICE restart revokes the real grant before rotating and rejects old inputs`, async t => {
    const f = fixture(t, recovering);
    const original = f.grant();
    f.input(original.sessionId, { type: 'key', code: 'KeyA', down: true });
    assert.equal(f.inputEvents().length, 1);
    assert.equal((await f.restart(1)).ok, true);
    assert.equal(f.revocations(), 1);
    assert.equal(f.rotations(), 1);
    assert.deepEqual(f.stopped().map(item => item.to).sort(),
      [original.controllerSocketId, original.sharerSocketId].sort());
    assert.ok(f.stopped().every(item => item.payload.sessionId === original.sessionId && item.payload.reason === '媒体连接正在恢复'));
    f.input(original.sessionId);
    f.input(original.sessionId, { type: 'key', code: 'KeyA', down: false });
    assert.equal(f.inputEvents().length, 1, 'neither old pointer nor release edges may use a revoked grant');
    assert.equal(f.remoteControls.authorizeInput(original.sessionId, original.controllerSocketId), null);

    const manual = f.grant();
    const cached = await f.restart(1);
    assert.equal(cached.ok, true);
    f.input(manual.sessionId);
    assert.equal(f.inputEvents().length, 2, 'lost-ACK replay must preserve a later manual grant');
    assert.equal(f.revocations(), 1);
    assert.equal(f.rotations(), 1);
    assert.equal((await f.restart(2)).ok, true);
    f.input(manual.sessionId);
    assert.equal(f.inputEvents().length, 2);
    assert.equal(f.revocations(), 2);
    assert.equal(f.stopped().length, 4);
  });
}

test('ICE restart clears a pending remote-control request without allowing its late approval', async t => {
  const f = fixture(t);
  const request = f.pendingRequest();
  assert.equal((await f.restart(1)).ok, true);
  assert.equal(f.remoteControls.getRequest(request.requestId), undefined);
  assert.equal(f.remoteControls.respond(request.requestId, request.sharerSocketId, true).ok, false);
  const cancelled = f.events.filter(item => ['remote-control:request-result', 'remote-control:request-cancelled'].includes(item.event));
  assert.equal(cancelled.length, 2);
  assert.ok(cancelled.every(item => item.payload.requestId === request.requestId));
  assert.equal(f.revocations(), 1);
});

test('malformed, foreign and terminal restart requests have no revocation side effects', async t => {
  const cases: Array<{ changes?: Record<string, unknown>; mutate?: (f: ReturnType<typeof fixture>) => void; code: string }> = [
    { changes: { sequence: 0 }, code: 'BAD_REQUEST' },
    { changes: { sequence: 2 }, code: 'INVALID_SEQUENCE' },
    { changes: { transportId: 'foreign-transport' }, code: 'TRANSPORT_NOT_FOUND' },
    { changes: { roomId: 'foreign-room' }, code: 'SESSION_MISMATCH' },
    { changes: { sessionId: '00000000-0000-0000-0000-000000000000' }, code: 'SESSION_MISMATCH' },
    { mutate: f => { f.socket.connected = false; }, code: 'NOT_CONNECTED' },
    { mutate: f => { invalidateMediaSession(f.peer); }, code: 'SESSION_EXPIRED' },
    { mutate: f => { f.transport.closed = true; }, code: 'TRANSPORT_CLOSED' },
    { mutate: f => { f.transport.iceState = 'disconnected'; }, code: 'ICE_DISCONNECTED' },
    { mutate: f => { f.transport.dtlsState = 'failed'; }, code: 'DTLS_FAILED' },
  ];
  for (const { changes, mutate, code } of cases) {
    const f = fixture(t);
    const manual = f.grant();
    mutate?.(f);
    assert.deepEqual(await f.restart(1, changes), { ok: false, code });
    assert.equal(f.revocations(), 0, code);
    assert.equal(f.rotations(), 0, code);
    f.input(manual.sessionId);
    assert.equal(f.inputEvents().length, 1, code);
    assert.equal(f.stopped().length, 0, code);
  }
});

test('pending restart duplicates and BUSY requests cannot revoke a subsequent manual grant', async t => {
  let release!: (value: any) => void;
  const f = fixture(t, 'controller', () => new Promise(resolve => { release = resolve; }));
  const original = f.grant();
  const first = f.restart(1);
  assert.equal(f.revocations(), 1);
  const manual = f.grant();
  const duplicate = f.restart(1);
  assert.deepEqual(await f.restart(2), { ok: false, code: 'BUSY' });
  f.input(original.sessionId);
  f.input(manual.sessionId);
  assert.equal(f.inputEvents().length, 1);
  release({ usernameFragment: 'synthetic-user', password: 'synthetic-secret', iceLite: true });
  assert.deepEqual(await first, await duplicate);
  f.input(manual.sessionId);
  assert.equal(f.inputEvents().length, 2);
  assert.equal(f.revocations(), 1);
  assert.equal(f.rotations(), 1);
});

test('stale or rate-limited restart requests cannot revoke a later manual grant', async t => {
  const f = fixture(t);
  for (let sequence = 1; sequence <= 3; sequence++) assert.equal((await f.restart(sequence)).ok, true);
  const manual = f.grant();
  assert.deepEqual(await f.restart(1), { ok: false, code: 'STALE_SEQUENCE' });
  assert.deepEqual(await f.restart(4), { ok: false, code: 'RATE_LIMITED' });
  f.input(manual.sessionId);
  assert.equal(f.inputEvents().length, 1);
  assert.equal(f.revocations(), 3);
  assert.equal(f.rotations(), 3);
});
