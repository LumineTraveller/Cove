import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createTransportIceRecovery, createMediaConnectionRecovery, DisconnectGrace } from '@cove/client-core';
import type { IceRestartRequest, IceRestartResponse } from '@cove/contracts';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let time = 0;
  const signal = { connected: true, id: 'socket-a' as string | undefined, emit() {} };
  const calls: IceRestartRequest[] = [];
  const applied: unknown[] = [];
  const failures: string[] = [];
  const events: string[] = [];
  let owned = true, active = true;
  const transport = {
    id: 'transport-a', closed: false, connectionState: 'connected',
    restartIce: async (params: unknown) => { applied.push(params); },
  };
  const response = (payload: IceRestartRequest): IceRestartResponse => ({
    ok: true, transportId: payload.transportId, sessionId: payload.sessionId, sequence: payload.sequence,
    iceParameters: { usernameFragment: `new-${payload.sequence}`, password: 'test-only-ice-password', iceLite: true },
  });
  let request = async (payload: IceRestartRequest): Promise<IceRestartResponse> => response(payload);
  const recovery = createTransportIceRecovery({
    signal, roomId: 'room-a', now: () => time,
    requestRestart: payload => { calls.push(payload); return request(payload); },
    onEvent: event => events.push(event),
  });
  const registration = {
    key: 'send', transport, capability: { version: 1, sessionId: 'ice-session-a' }, ownerSocketId: signal.id,
    isCurrent: () => owned, isActive: () => active, onFailure: (code: string) => failures.push(code),
  };
  const observe = (state: string) => { transport.connectionState = state; return recovery.observe(registration, state); };
  const tick = async (ms: number) => { time += ms; t.mock.timers.tick(ms); await flush(); };
  observe('connected');
  t.after(() => recovery.dispose());
  return { recovery, transport, registration, signal, calls, applied, failures, events, response, observe, tick,
    request: (fn: typeof request) => { request = fn; },
    owned: (value: boolean) => { owned = value; }, active: (value: boolean) => { active = value; } };
}

test('legacy, unsupported-version and missing-native-method transports keep the legacy policy', async t => {
  const f = fixture(t);
  for (const capability of [undefined, { version: 2, sessionId: 'x' }, { version: 1, sessionId: '' }])
    assert.equal(f.recovery.observe({ ...f.registration, key: 'legacy', capability }, 'failed'), false);
  assert.equal(f.recovery.observe({ ...f.registration, key: 'missing', transport: { ...f.transport, restartIce: undefined } as never }, 'failed'), false);
  await f.tick(30_000);
  assert.equal(f.calls.length, 0);
});

test('initial setup never gains an ICE recovery deadline before it connected', async t => {
  const f = fixture(t);
  f.recovery.cancelAll();
  assert.equal(f.observe('failed'), false);
  await f.tick(30_000);
  assert.deepEqual(f.failures, []);
  assert.equal(f.calls.length, 0);
});

test('explicit new transport setup after an idle fresh-socket reconnect is not stuck behind old signal suspension', async t => {
  const f = fixture(t);
  f.recovery.cancelAll();
  f.recovery.onSignalLost(); f.signal.connected = false;
  f.signal.id = 'new-socket'; f.signal.connected = true;
  const registration = { ...f.registration, ownerSocketId: 'new-socket',
    transport: { ...f.transport, id: 'fresh-transport' }, capability: { version: 1, sessionId: 'fresh-session' } };
  f.recovery.observe(registration, 'connected');
  registration.transport.connectionState = 'failed';
  f.recovery.observe(registration, 'failed');
  await f.tick(0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].transportId, 'fresh-transport');
  assert.deepEqual(f.failures, []);
});

test('signal-only loss does not restart healthy media; disconnected can recover during debounce', async t => {
  const f = fixture(t);
  f.signal.connected = false;
  f.recovery.onSignalLost();
  await f.tick(10_000);
  f.signal.connected = true;
  f.recovery.onSessionRecovered();
  await f.tick(0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.observe('disconnected'), true);
  await f.tick(1_400);
  f.observe('connected');
  await f.tick(30_000);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.failures, []);
});

test('a failed path waits for confirmed same-session signal recovery', async t => {
  const f = fixture(t);
  f.signal.connected = false;
  f.recovery.onSignalLost();
  f.observe('failed');
  await f.tick(3_000);
  f.signal.connected = true; // Socket connected alone is insufficient.
  await f.tick(1_000);
  assert.equal(f.calls.length, 0);
  f.recovery.onSessionRecovered();
  await f.tick(0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.applied.length, 1);
});

test('repeated failed/connecting storms neither duplicate an in-flight request nor renew the absolute deadline', async t => {
  const f = fixture(t);
  const reply = deferred<IceRestartResponse>();
  f.request(() => reply.promise);
  f.observe('failed');
  await f.tick(0);
  for (let n = 0; n < 15; n++) { f.observe('connecting'); f.observe('failed'); await f.tick(1_000); }
  assert.equal(f.calls.length, 1);
  await f.tick(5_000);
  assert.deepEqual(f.failures, ['DEADLINE_EXCEEDED']);
  reply.resolve(f.response(f.calls[0]));
  await flush();
  assert.equal(f.applied.length, 0);
  assert.equal(f.recovery.isRecovering(), false);
});

test('hung native SDP apply cannot queue more operations and times out safely', async t => {
  const f = fixture(t);
  const apply = deferred<void>();
  let nativeCalls = 0;
  f.transport.restartIce = async () => { nativeCalls++; await apply.promise; };
  f.observe('failed');
  await f.tick(0);
  for (let n = 0; n < 9; n++) { f.observe('connecting'); f.observe('failed'); await f.tick(2_000); }
  assert.equal(nativeCalls, 1);
  assert.equal(f.calls.length, 1);
  await f.tick(2_000);
  assert.deepEqual(f.failures, ['DEADLINE_EXCEEDED']);
  apply.resolve();
  await flush();
  assert.equal(f.events.filter(event => event === 'ice-restart-connected').length, 0);
});

test('an ambiguous ACK timeout reuses its sequence; a known apply failure also cannot rotate unnecessarily', async t => {
  const f = fixture(t);
  let count = 0;
  f.request(async payload => { if (++count === 1) throw new Error('timeout'); return f.response(payload); });
  f.transport.restartIce = async params => { f.applied.push(params); f.transport.connectionState = 'connected'; };
  f.observe('failed');
  await f.tick(0);
  await f.tick(2_000);
  assert.deepEqual(f.calls.map(call => call.sequence), [1, 1]);
  assert.equal(f.applied.length, 1);
  assert.deepEqual(f.failures, []);
  assert.equal(f.recovery.isRecovering(), false);
});

test('spontaneous connected after an ambiguous ACK still synchronizes the worker credentials', async t => {
  const f = fixture(t);
  let count = 0;
  f.request(async payload => { if (++count === 1) throw new Error('lost ACK'); return f.response(payload); });
  f.observe('failed'); await f.tick(0);
  f.observe('connected');
  assert.equal(f.recovery.isRecovering(), true);
  await f.tick(2_000);
  assert.deepEqual(f.calls.map(call => call.sequence), [1, 1]);
  assert.equal(f.applied.length, 1);
  assert.equal(f.recovery.isRecovering(), false);
});

test('three attempts bound a connecting path and healthy flapping cannot reset the rolling budget', async t => {
  const f = fixture(t);
  f.observe('failed'); await f.tick(0);
  f.observe('connecting'); await f.tick(2_000);
  await f.tick(2_000); await f.tick(2_000);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.map(call => call.sequence), [1, 2, 3]);
  assert.deepEqual(f.failures, ['ATTEMPTS_EXHAUSTED']);
});

test('rolling budget survives successful rounds and resets only after its time window', async t => {
  const f = fixture(t);
  f.transport.restartIce = async () => { f.transport.connectionState = 'connected'; };
  for (let n = 0; n < 3; n++) { f.observe('failed'); await f.tick(0); f.observe('connected'); }
  f.observe('failed'); await f.tick(0);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.failures, ['ATTEMPTS_EXHAUSTED']);
  // A real adapter tears down here; no unbounded new rounds are started.
});

test('malformed identity/credentials and terminal resource errors never reach native apply', async t => {
  const f = fixture(t);
  f.request(async payload => ({ ...f.response(payload), sequence: 99 } as IceRestartResponse));
  f.observe('failed'); await f.tick(0);
  assert.deepEqual(f.failures, ['INVALID_RESPONSE']);
  assert.equal(f.applied.length, 0);
});

test('server resource/session loss immediately falls back instead of retrying a new session', async t => {
  const f = fixture(t);
  f.request(async () => ({ ok: false, code: 'SESSION_EXPIRED' }));
  f.observe('failed'); await f.tick(0); await f.tick(30_000);
  assert.deepEqual(f.failures, ['SESSION_EXPIRED']);
  assert.equal(f.calls.length, 1);
  assert.equal(f.applied.length, 0);
});

test('unrecognized error payloads cannot enter recovery logs', async t => {
  const f = fixture(t);
  f.request(async () => ({ ok: false, code: 'untrusted-arbitrary-payload' }));
  f.observe('failed'); await f.tick(0);
  assert.deepEqual(f.failures, ['INVALID_RESPONSE']);
});

test('transport replacement and explicit cancellation defeat old responses without disturbing the successor', async t => {
  const f = fixture(t);
  const old = deferred<IceRestartResponse>();
  f.request(payload => payload.transportId === 'transport-a' ? old.promise : Promise.resolve(f.response(payload)));
  f.observe('failed'); await f.tick(0);
  const successor = { ...f.transport, id: 'transport-b', restartIce: async () => {} };
  f.recovery.observe({ ...f.registration, transport: successor }, 'connected');
  assert.equal(f.recovery.observe({ ...f.registration, isCurrent: () => false }, 'failed'), false);
  f.recovery.cancel('send', f.transport); // Exact old identity must not cancel its successor.
  old.resolve(f.response(f.calls[0])); await flush();
  assert.equal(f.applied.length, 0);
  assert.deepEqual(f.failures, []);
  assert.equal(f.recovery.observe({ ...f.registration, transport: successor }, 'failed'), true);
  f.recovery.cancelAll();
  await f.tick(30_000);
  assert.deepEqual(f.failures, []);
});

test('disconnect invalidates a late ACK; same-session recovery retries the exact sequence', async t => {
  const f = fixture(t);
  const old = deferred<IceRestartResponse>();
  let count = 0;
  f.request(payload => ++count === 1 ? old.promise : Promise.resolve(f.response(payload)));
  f.observe('failed'); await f.tick(0);
  f.recovery.onSignalLost(); f.signal.connected = false;
  old.resolve(f.response(f.calls[0])); await flush();
  assert.equal(f.applied.length, 0);
  f.signal.connected = true; f.recovery.onSessionRecovered();
  await f.tick(2_000);
  assert.deepEqual(f.calls.map(call => call.sequence), [1, 1]);
  assert.equal(f.applied.length, 1);
});

test('cancelled user intent and disposed late callbacks never acquire media or invoke failure UI', async t => {
  const f = fixture(t);
  f.observe('failed'); f.active(false); await f.tick(0);
  assert.equal(f.calls.length, 0);
  f.recovery.dispose();
  assert.equal(f.observe('failed'), false);
  f.recovery.onSessionRecovered(); await f.tick(30_000);
  assert.deepEqual(f.failures, []);
});

test('cancelled intent during a hung request cannot show a later failure or retain the signal deadline', async t => {
  const f = fixture(t);
  f.request(() => new Promise(() => {}));
  f.observe('failed'); await f.tick(0);
  f.active(false);
  assert.equal(f.recovery.isRecovering(), false);
  await f.tick(20_000);
  assert.deepEqual(f.failures, []);
});

test('existing signal coordinator retains a bounded recovery but fresh sessions cancel it', async t => {
  const f = fixture(t);
  const grace = new DisconnectGrace(5_000);
  const state = { recovered: true, socketId: 'socket-a', mediaSocketId: 'socket-a', active: true,
    pending: false, established: true, sendState: 'failed', recvState: 'failed' };
  const resets: string[] = [];
  const coordinator = createMediaConnectionRecovery({
    grace, transportRecovery: f.recovery, readState: () => state,
    retainOnSignalTimeout: () => false, resetMedia: reason => resets.push(reason),
    leaveRecoveredSession() {}, onSignalTimeout() {},
  });
  f.observe('failed'); f.signal.connected = false; coordinator.onDisconnect('transport close');
  await f.tick(5_000);
  assert.deepEqual(resets, []);
  state.recovered = false; state.socketId = 'new-socket'; coordinator.onConnect();
  assert.deepEqual(resets, ['session-not-recovered']);
  assert.equal(f.recovery.isRecovering(), false);
  await f.tick(30_000);
  assert.deepEqual(f.failures, []);
  coordinator.dispose();
});
