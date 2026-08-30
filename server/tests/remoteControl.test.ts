import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteControlRegistry, sanitizeRemoteControlInput } from '../src/remoteControl';

test('remote control requires the sharer to accept a short-lived request', () => {
  const ids = ['request-1', 'session-1'];
  const registry = new RemoteControlRegistry(() => ids.shift()!);
  const created = registry.createRequest('room', 'viewer', 'sharer', 1000);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.expiresAt, 31_000);
  assert.equal(registry.respond(created.value.requestId, 'viewer', true, 2000).ok, false);
  const accepted = registry.respond(created.value.requestId, 'sharer', true, 2000);
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.value.session?.sessionId, 'session-1');
  assert.equal(registry.authorizeInput('session-1', 'viewer', 2100)?.sharerSocketId, 'sharer');
  assert.equal(registry.authorizeInput('session-1', 'intruder', 2100), null);
  assert.equal(registry.createRequest('room', 'sharer', 'other-sharer', 2200).ok, false);
  assert.equal(registry.createRequest('room', 'other-viewer', 'viewer', 2200).ok, false);
});

test('requests expire, rejection creates no session, and disconnect clears state', () => {
  const ids = ['expired', 'rejected', 'session-request', 'session'];
  const registry = new RemoteControlRegistry(() => ids.shift()!);
  const expired = registry.createRequest('room', 'viewer-a', 'sharer-a', 0);
  assert.equal(expired.ok && registry.respond(expired.value.requestId, 'sharer-a', true, 30_001).ok, false);
  const rejected = registry.createRequest('room', 'viewer-b', 'sharer-b', 40_000);
  assert.equal(rejected.ok, true);
  if (rejected.ok) assert.deepEqual(registry.respond(rejected.value.requestId, 'sharer-b', false, 40_001), {
    ok: true, value: { request: rejected.value, session: null },
  });
  const pending = registry.createRequest('room', 'viewer-c', 'sharer-c', 50_000);
  assert.equal(pending.ok, true);
  if (!pending.ok) return;
  const accepted = registry.respond(pending.value.requestId, 'sharer-c', true, 50_001);
  assert.equal(accepted.ok, true);
  const cleared = registry.clearSocket('viewer-c');
  assert.equal(cleared.sessions.length, 1);
  assert.equal(registry.authorizeInput('session', 'viewer-c', 50_002), null);
});

test('remote input accepts bounded normalized events and rejects unsafe values', () => {
  assert.deepEqual(sanitizeRemoteControlInput({ type: 'pointer', x: 0.25, y: 1 }), { type: 'pointer', x: 0.25, y: 1 });
  assert.deepEqual(sanitizeRemoteControlInput({ type: 'button', button: 'left', down: true, x: 0, y: 0.5 }), { type: 'button', button: 'left', down: true, x: 0, y: 0.5 });
  assert.deepEqual(sanitizeRemoteControlInput({ type: 'wheel', deltaX: 0, deltaY: -120, x: 0.5, y: 0.5 }), { type: 'wheel', deltaX: 0, deltaY: -120, x: 0.5, y: 0.5 });
  assert.deepEqual(sanitizeRemoteControlInput({ type: 'key', code: 'ControlLeft', down: true }), { type: 'key', code: 'ControlLeft', down: true });
  assert.equal(sanitizeRemoteControlInput({ type: 'pointer', x: -1, y: 0 }), null);
  assert.equal(sanitizeRemoteControlInput({ type: 'wheel', deltaX: 0, deltaY: 5000, x: 0.5, y: 0.5 }), null);
  assert.equal(sanitizeRemoteControlInput({ type: 'key', code: 'LaunchMalware', down: true }), null);
});

test('remote input is rate limited per active session', () => {
  const ids = ['request', 'session'];
  const registry = new RemoteControlRegistry(() => ids.shift()!);
  const request = registry.createRequest('room', 'viewer', 'sharer', 0);
  assert.equal(request.ok, true);
  if (!request.ok) return;
  assert.equal(registry.respond(request.value.requestId, 'sharer', true, 1).ok, true);
  for (let index = 0; index < 240; index += 1)
    assert.ok(registry.authorizeInput('session', 'viewer', 100));
  assert.equal(registry.authorizeInput('session', 'viewer', 100), null);
  assert.ok(registry.authorizeInput('session', 'viewer', 1100));
});
