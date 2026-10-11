import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { RemoteControlLifecycle, type RemoteControlSession } from '../src/features/remote-control/remoteControlSession';

const input = { type: 'key' as const, code: 'KeyA', down: true };
const session = (role: RemoteControlSession['role'], id = 'session-one'): RemoteControlSession =>
  ({ roomId: 'room', role, sessionId: id });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(engine?: EventEmitter & { transport: { writable: boolean }; writeBuffer: unknown[] }) {
  const events = new EventEmitter();
  const sent: { event: string; args: any[] }[] = [];
  const active: (string | null)[] = [];
  const injected: { sessionId: string; input: unknown }[] = [];
  const sessions: (RemoteControlSession | null)[] = [];
  const notices: string[] = [];
  let enable: (id: string) => Promise<boolean> = async () => true;
  let accept: () => Promise<boolean> = async () => true;
  let activationFailure = '本机远程输入组件不可用，控制已终止';
  let emergency: ((reason?: string) => void) | null = null;
  let onEmit: ((event: string, ...args: any[]) => void) | null = null;
  const socket = {
    connected: true,
    io: engine ? { engine } : undefined,
    on: (event: string, listener: (...args: any[]) => void) => events.on(event, listener),
    off: (event: string, listener: (...args: any[]) => void) => events.off(event, listener),
    emit: (event: string, ...args: any[]) => { sent.push({ event, args }); onEmit?.(event, ...args); },
  };
  const lifecycle = new RemoteControlLifecycle({ roomId: 'room', socket,
    bridge: {
      setActive: id => {
        active.push(id);
        if (!id) return Promise.resolve({ ok: true });
        return enable(id).then(ok => ok ? { ok: true } : { ok: false, reason: activationFailure });
      },
      sendInput: (sessionId, input) => { injected.push({ sessionId, input }); return accept(); },
      onEmergencyStop: listener => { emergency = listener; return () => { emergency = null; }; },
    },
    onSession: state => sessions.push(state), onNotice: reason => notices.push(reason),
  });
  return { events, socket, sent, active, injected, sessions, notices, lifecycle,
    setOnEmit: (fn: typeof onEmit) => { onEmit = fn; },
    setEnable: (fn: typeof enable) => { enable = fn; },
    setActivationFailure: (reason: string) => { activationFailure = reason; },
    setAccept: (fn: typeof accept) => { accept = fn; },
    emergency: (reason?: string) => emergency?.(reason),
    disconnect() { socket.connected = false; events.emit('disconnect'); },
    async start(role: RemoteControlSession['role'], id?: string) {
      assert.equal(lifecycle.expectStart(role), true);
      events.emit('remote-control:started', session(role, id));
      await flush();
    },
  };
}

test('connected transport backpressure retains one newest move and drains a stopped-motion tail', async () => {
  const engine = Object.assign(new EventEmitter(), { transport: { writable: false }, writeBuffer: [] as unknown[] });
  const h = harness(engine);
  await h.start('controller');
  for (let i = 0; i < 100; i++) h.lifecycle.send({ type: 'pointer', x: i / 100, y: 0.5 });
  assert.equal(h.sent.length, 0, 'old positions must not enter the reliable transport buffer');
  assert.equal(engine.listenerCount('drain'), 1);
  engine.transport.writable = true;
  engine.emit('drain');
  await flush();
  assert.deepEqual(h.sent.map(item => item.args[0].input), [{ type: 'pointer', x: 0.99, y: 0.5 }]);
  assert.equal(engine.listenerCount('drain'), 0);
  engine.emit('drain');
  await flush();
  assert.equal(h.sent.length, 1, 'a tail is delivered exactly once without further input');
  h.lifecycle.dispose();
});

test('key/button/wheel edges preserve earlier movement during transport blockage', async () => {
  const engine = Object.assign(new EventEmitter(), { transport: { writable: false }, writeBuffer: [] as unknown[] });
  const h = harness(engine);
  await h.start('controller');
  h.lifecycle.send({ type: 'pointer', x: 0.1, y: 0.1 });
  h.lifecycle.send({ type: 'pointer', x: 0.2, y: 0.2 });
  h.lifecycle.send({ type: 'button', button: 'left', down: true, x: 0.2, y: 0.2 });
  h.lifecycle.send({ type: 'pointer', x: 0.3, y: 0.3 });
  h.lifecycle.send({ type: 'wheel', deltaX: 0, deltaY: 120, x: 0.3, y: 0.3 });
  h.lifecycle.send({ type: 'key', code: 'ShiftLeft', down: true });
  h.lifecycle.send({ type: 'pointer', x: 0.4, y: 0.4 });
  h.lifecycle.send({ type: 'button', button: 'left', down: false, x: 0.4, y: 0.4 });
  h.lifecycle.send({ type: 'key', code: 'ShiftLeft', down: false });
  const inputs = h.sent.map(item => item.args[0].input);
  assert.deepEqual(inputs.map(input => input.type), ['pointer', 'button', 'pointer', 'wheel', 'key', 'pointer', 'button', 'key']);
  assert.deepEqual(inputs.filter(input => input.type === 'pointer').map(input => input.x), [0.2, 0.3, 0.4]);
  assert.deepEqual(inputs.filter(input => input.type === 'button' || input.type === 'key').map(input => input.down),
    [true, true, false, false]);
  h.lifecycle.dispose();
});

test('a writable transport with buffered packets also waits; revocation removes pending moves and listeners', async () => {
  const engine = Object.assign(new EventEmitter(), { transport: { writable: true }, writeBuffer: [{}] as unknown[] });
  const h = harness(engine);
  await h.start('controller');
  h.lifecycle.send({ type: 'pointer', x: 0.6, y: 0.6 });
  assert.equal(h.sent.length, 0);
  engine.writeBuffer = [];
  engine.emit('upgrade');
  h.disconnect(); // wins over the queued upgrade microtask
  await flush();
  engine.emit('drain');
  await flush();
  assert.equal(h.sent.length, 0);
  assert.equal(engine.listenerCount('drain'), 0);
  assert.equal(engine.listenerCount('upgrade'), 0);
  h.socket.connected = true;
  h.events.emit('connect');
  await h.start('controller', 'session-two');
  h.lifecycle.send({ type: 'pointer', x: 0.7, y: 0.7 });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].args[0].sessionId, 'session-two');
  h.lifecycle.dispose();
});

test('revocation during a forced movement barrier prevents its subsequent button edge', async () => {
  const engine = Object.assign(new EventEmitter(), { transport: { writable: false }, writeBuffer: [] as unknown[] });
  const h = harness(engine);
  await h.start('controller');
  h.lifecycle.send({ type: 'pointer', x: 0.2, y: 0.2 });
  h.setOnEmit(event => { if (event === 'remote-control:input') h.lifecycle.stop(false); });
  h.lifecycle.send({ type: 'button', button: 'left', down: true, x: 0.2, y: 0.2 });
  assert.deepEqual(h.sent.map(item => item.args[0].input.type), ['pointer']);
  assert.equal(h.sessions.at(-1), null);
  assert.equal(engine.listenerCount('drain'), 0);
  h.lifecycle.dispose();
});

test('disconnect immediately revokes native control and replay cannot restore the session', async () => {
  const h = harness();
  await h.start('sharer');
  h.events.emit('remote-control:input', { sessionId: 'session-one', input });
  assert.equal(h.injected.length, 1);
  h.disconnect();
  assert.deepEqual(h.active, ['session-one', null]);
  assert.equal(h.sessions.at(-1), null);
  // Socket.IO sets connected=true, replays recovered packets, then emits connect.
  h.socket.connected = true;
  h.events.emit('remote-control:started', session('sharer'));
  h.events.emit('remote-control:input', { sessionId: 'session-one', input });
  h.events.emit('connect');
  h.events.emit('remote-control:started', session('sharer'));
  h.events.emit('remote-control:input', { sessionId: 'session-one', input });
  await flush();
  assert.equal(h.injected.length, 1);
  assert.deepEqual(h.active, ['session-one', null]);
  await h.start('sharer', 'session-two');
  assert.equal(h.sessions.at(-1)?.sessionId, 'session-two');
  h.lifecycle.dispose();
});

test('controller sends no offline input and an explicit fresh request is required after reconnect', async () => {
  const h = harness();
  await h.start('controller');
  h.lifecycle.send(input);
  h.disconnect();
  h.lifecycle.send(input);
  h.socket.connected = true;
  h.events.emit('connect');
  h.lifecycle.send(input);
  assert.equal(h.sent.filter(item => item.event === 'remote-control:input').length, 1);
  assert.equal(h.active.length, 0);
  h.lifecycle.dispose();
});

test('stop during helper startup wins over a late ready response and discards subsequent input', async () => {
  const h = harness();
  const ready = deferred<boolean>();
  h.setEnable(() => ready.promise);
  await h.start('sharer');
  h.events.emit('remote-control:input', { sessionId: 'session-one', input });
  assert.equal(h.injected.length, 1, 'startup input is handed to the bounded native ready queue');
  h.lifecycle.stop();
  ready.resolve(true);
  await flush();
  h.events.emit('remote-control:input', { sessionId: 'session-one', input });
  assert.equal(h.injected.length, 1);
  assert.deepEqual(h.active, ['session-one', null]);
  assert.ok(h.sessions.every(state => state === null));
  h.lifecycle.dispose();
});

test('an old activation or input failure cannot terminate a newer session', async () => {
  const h = harness();
  const ready = deferred<boolean>();
  const accepted = deferred<boolean>();
  h.setEnable(id => id === 'session-one' ? ready.promise : Promise.resolve(true));
  h.setAccept(() => accepted.promise);
  await h.start('sharer');
  h.events.emit('remote-control:input', { sessionId: 'session-one', input });
  h.lifecycle.stop();
  await h.start('sharer', 'session-two');
  ready.resolve(false);
  accepted.resolve(false);
  await flush();
  assert.equal(h.sessions.at(-1)?.sessionId, 'session-two');
  assert.deepEqual(h.active, ['session-one', null, 'session-two']);
  h.lifecycle.dispose();
});

test('cancellation, foreign rooms and foreign input cannot authorize native control', async () => {
  const h = harness();
  h.lifecycle.expectStart('sharer');
  h.lifecycle.cancelExpectedStart();
  h.events.emit('remote-control:started', session('sharer'));
  assert.equal(h.active.length, 0);
  h.lifecycle.expectStart('sharer');
  h.events.emit('remote-control:started', { ...session('sharer'), roomId: 'elsewhere' });
  assert.equal(h.active.length, 0);
  h.events.emit('remote-control:started', session('sharer', 'session-two'));
  await flush();
  h.events.emit('remote-control:input', { sessionId: 'session-one', input });
  h.events.emit('remote-control:stopped', { sessionId: 'session-one' });
  assert.equal(h.injected.length, 0);
  assert.equal(h.sessions.at(-1)?.sessionId, 'session-two');
  h.lifecycle.dispose();
});

test('input rejection and emergency stop both revoke the helper and report the cause', async () => {
  const h = harness();
  await h.start('sharer');
  h.setAccept(async () => false);
  h.events.emit('remote-control:input', { sessionId: 'session-one', input });
  await flush();
  assert.deepEqual(h.active, ['session-one', null]);
  assert.match(h.notices.at(-1)!, /远程输入不可用/);
  await h.start('sharer', 'session-two');
  h.emergency('helper failure');
  assert.equal(h.active.at(-1), null);
  assert.equal(h.notices.at(-1), 'helper failure');
  h.lifecycle.dispose();
  assert.equal(h.events.eventNames().length, 0);
  h.emergency('ignored');
  assert.equal(h.notices.at(-1), 'helper failure');
});

test('an activation failure surfaces the reason reported by the main process', async () => {
  const h = harness();
  h.setEnable(async () => false);
  h.setActivationFailure('紧急停止快捷键已被其他程序占用');
  await h.start('sharer');
  // 授权失败时必须同时撤销本地组件（active 追加 null），不能留下半开的控制通道。
  assert.deepEqual(h.active, ['session-one', null]);
  assert.equal(h.sessions.at(-1), null);
  assert.equal(h.notices.at(-1), '紧急停止快捷键已被其他程序占用');
  h.lifecycle.dispose();
});
