import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { RemoteControlRegistry } from '../src/features/remote-control/remoteControl';
import { createControlService } from '../src/features/remote-control/controlService';
import { registerRemoteControlSocketHandlers } from '../src/features/remote-control/socketHandlers';
import { clearRemoteRequestExpirations } from '../src/features/remote-control/requestExpiration';

function fixture(t: TestContext) {
  const timers = new Map<object, () => void>();
  t.mock.method(globalThis, 'setTimeout', (callback: () => void) => {
    const timer = {}; timers.set(timer, callback); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer: object) => timers.delete(timer));
  const registry = new RemoteControlRegistry();
  t.after(() => clearRemoteRequestExpirations(registry));
  const events: string[] = [];
  const io = { to: () => ({ emit: (event: string) => events.push(event) }) } as any;
  const controls = createControlService({ io, remoteControls: registry });
  let allowed = true, sharing = true;
  const handlers = new Map<string, Map<string, (...args: any[]) => void>>();
  for (const id of ['controller', 'sharer']) {
    const list = new Map<string, (...args: any[]) => void>(); handlers.set(id, list);
    registerRemoteControlSocketHandlers({ socket: { id, on: (event: string, fn: any) => list.set(event, fn) } as any,
      io, remoteControls: registry, roomMembers: new Map([['room', new Set(['controller', 'sharer'])]]),
      remoteControlCapabilities: new Set(['controller', 'sharer']), isSharingScreen: () => sharing,
      isRemoteControlAllowed: () => allowed, userNames: new Map(), publicUserId: id => id, ...controls });
  }
  function emit(id: string, event: string, data: unknown) {
    let result: any; handlers.get(id)!.get(event)!(data, (value: unknown) => { result = value; }); return result;
  }
  function request() {
    const result = emit('controller', 'remote-control:request', { roomId: 'room', sharerSocketId: 'sharer' });
    assert.equal(result.ok, true); assert.equal(timers.size, 1); return result.requestId as string;
  }
  return { timers, registry, controls, events, emit, request,
    setAllowed: (value: boolean) => { allowed = value; }, setSharing: (value: boolean) => { sharing = value; } };
}

for (const accepted of [true, false]) test(`settling a remote request (accepted=${accepted}) releases its expiration timer`, t => {
  const f = fixture(t); const requestId = f.request();
  assert.equal(f.emit('sharer', 'remote-control:respond', { requestId, accepted }).ok, true);
  assert.equal(f.timers.size, 0);
});

test('cancel, participant revoke and room revoke release expiration timers', t => {
  const f = fixture(t);
  let requestId = f.request();
  assert.equal(f.emit('controller', 'remote-control:cancel', { requestId }).ok, true);
  assert.equal(f.timers.size, 0);
  f.request(); f.controls.stopRemoteControlForSocket('sharer', 'synthetic revoke');
  assert.equal(f.timers.size, 0);
  f.request(); f.controls.stopRemoteControlForRoom('room', 'synthetic room revoke');
  assert.equal(f.timers.size, 0);
});

test('an unauthorized response cannot cancel another pending request timer', t => {
  const f = fixture(t); const requestId = f.request();
  assert.equal(f.emit('controller', 'remote-control:respond', { requestId, accepted: true }).ok, false);
  assert.equal(f.timers.size, 1);
  f.controls.stopRemoteControlForSocket('controller', 'cleanup');
});

test('runtime shutdown clears pending expiration resources without granting or responding', t => {
  const f = fixture(t); const requestId = f.request();
  clearRemoteRequestExpirations(f.registry);
  assert.equal(f.timers.size, 0);
  assert.ok(f.registry.getRequest(requestId));
  assert.deepEqual(f.events, ['remote-control:requested']);
});

test('a still-pending request expires once at its original deadline', t => {
  let at = 1000;
  t.mock.method(Date, 'now', () => at);
  const f = fixture(t); const requestId = f.request();
  at += 30050;
  const callback = [...f.timers.values()][0]; callback();
  assert.equal(f.timers.size, 0);
  assert.equal(f.registry.getRequest(requestId), undefined);
  assert.equal(f.events.filter(event => event === 'remote-control:request-cancelled').length, 1);
});

for (const changed of ['permission', 'sharing']) test(`expired response after ${changed} changes releases the not-yet-fired timer`, t => {
  let at = 1000;
  t.mock.method(Date, 'now', () => at);
  const f = fixture(t); const requestId = f.request();
  if (changed === 'permission') f.setAllowed(false); else f.setSharing(false);
  at += 30000;
  assert.equal(f.emit('sharer', 'remote-control:respond', { requestId, accepted: true }).ok, false);
  assert.equal(f.registry.getRequest(requestId), undefined);
  assert.equal(f.timers.size, 0);
});
