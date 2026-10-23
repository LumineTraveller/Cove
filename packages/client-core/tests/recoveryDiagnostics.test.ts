import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryDiagnostics, normalizeRecoveryDiagnostics } from '../src/recoveryDiagnostics';

test('one recovery correlates phases, attempts, elapsed time and safe fallback', () => {
  let at = 100;
  const journal = createRecoveryDiagnostics({ now: () => at });
  journal.record('ice-restart-begin', { key: 'recv', reason: 'STATE_DISCONNECTED' });
  at += 1500; journal.record('ice-restart-request', { key: 'recv', attempt: 1 });
  at += 2500; journal.record('ice-restart-retry', { key: 'recv', attempt: 1, reason: 'REQUEST_OR_APPLY_FAILED' });
  at += 2000; journal.record('ice-restart-request', { key: 'recv', attempt: 2 });
  at += 100; journal.record('ice-restart-failed', { key: 'recv', reason: 'SESSION_EXPIRED' });
  journal.record('ice-restart-fallback', { key: 'recv', reason: 'SESSION_EXPIRED' });
  const events = journal.snapshot().events;
  assert.equal(new Set(events.map(item => item.recoveryId)).size, 1);
  assert.deepEqual(events.map(item => item.stage), ['begin', 'request', 'retry', 'request', 'failed', 'fallback']);
  assert.equal(events.at(-1)?.elapsedMs, 6100);
  assert.equal(events.at(-1)?.channel, 'receive');
  at += 100; journal.record('ice-restart-begin', { key: 'recv' });
  assert.notEqual(journal.snapshot().events.at(-1)?.recoveryId, events[0].recoveryId);
});

test('signal outcomes and concurrent transport rounds stay distinguishable', () => {
  const journal = createRecoveryDiagnostics();
  journal.record('signal-disconnected', 'transport close');
  journal.record('ice-restart-begin', { key: 'send' });
  journal.record('signal-timeout-media-retained');
  journal.record('ice-restart-connected', { key: 'send' });
  const events = journal.snapshot().events;
  assert.equal(events[0].reason, 'TRANSPORT_CLOSE');
  assert.equal(events[0].recoveryId, events[2].recoveryId);
  assert.equal(events[1].recoveryId, events[3].recoveryId);
  assert.notEqual(events[0].recoveryId, events[1].recoveryId);
});

test('no normal connect/cleanup noise; storms and retention are bounded', () => {
  const journal = createRecoveryDiagnostics({ capacity: 8 });
  journal.record('signal-connected');
  journal.record('ice-restart-cancelled', { key: 'send' });
  assert.equal(journal.snapshot().events.length, 0);
  journal.record('ice-restart-begin', { key: 'screen' });
  for (let index = 0; index < 10000; index++) journal.record('ice-restart-signal-wait', { key: 'screen' });
  assert.equal(journal.snapshot().events.length, 2);
  journal.record('ice-restart-cancelled', { key: 'screen' });
  for (let index = 0; index < 20; index++) {
    journal.record('signal-disconnected', 'transport error'); journal.record('signal-connected');
  }
  const result = journal.snapshot();
  assert.equal(result.events.length, 8); assert.ok(result.dropped > 0);
  result.events.length = 0;
  assert.equal(journal.snapshot().events.length, 8, 'exports cannot mutate retained state');
});

test('record and export discard credentials, content, arbitrary keys and reasons', () => {
  const secret = 'private-token-SDP-password-user';
  const journal = createRecoveryDiagnostics();
  journal.record(secret, { key: 'send', reason: secret });
  journal.record('ice-restart-begin', { key: secret, reason: secret });
  journal.record('ice-restart-begin', { key: 'send', reason: secret, token: secret, sdp: secret, roomId: secret });
  const raw = { ...journal.snapshot(), token: secret, events: [
    ...journal.snapshot().events.map(event => ({ ...event, password: secret, reason: secret, attempt: 999 })),
    { recoveryId: secret, channel: 'send', stage: 'request' },
    { recoveryId: { toString: () => 'r1', token: secret }, channel: 'send', stage: 'request' },
  ] };
  const exported = normalizeRecoveryDiagnostics(raw);
  assert.equal(exported.events.length, 1);
  assert.equal(exported.events[0].reason, 'OTHER');
  assert.equal(exported.events[0].attempt, undefined);
  assert.ok(!JSON.stringify(exported).includes(secret));
  assert.ok(!JSON.stringify(exported).includes('password'));
});

test('clock reversal cannot produce negative or non-finite event timing', () => {
  let at = 100;
  const journal = createRecoveryDiagnostics({ now: () => at });
  journal.record('signal-disconnected'); at = 50; journal.record('signal-connected');
  assert.equal(journal.snapshot().events.at(-1)?.elapsedMs, 0);
  assert.ok(journal.snapshot().events.every(event => Number.isFinite(event.atMs)));
});

test('retained healthy media remains associated with later signal connection and explicit leave', () => {
  let at = 0;
  const journal = createRecoveryDiagnostics({ now: () => at });
  journal.record('signal-disconnected', 'transport close');
  at = 7500; journal.record('signal-timeout-media-retained');
  at = 10000; journal.record('signal-connected');
  journal.record('recovered-session-left');
  const events = journal.snapshot().events;
  assert.deepEqual(events.map(event => event.stage), ['begin', 'retained', 'connected', 'cancelled']);
  assert.equal(new Set(events.map(event => event.recoveryId)).size, 1);
  assert.equal(events.at(-1)?.elapsedMs, 10000);
});

test('ACK wait and native apply have separate stages and controlled failure reasons', () => {
  const journal = createRecoveryDiagnostics();
  journal.record('ice-restart-begin', { key: 'send' });
  journal.record('ice-restart-request', { key: 'send', attempt: 1 });
  journal.record('ice-restart-retry', { key: 'send', attempt: 1, reason: 'REQUEST_FAILED' });
  journal.record('ice-restart-request', { key: 'send', attempt: 2 });
  journal.record('ice-restart-applying', { key: 'send', attempt: 2 });
  journal.record('ice-restart-retry', { key: 'send', attempt: 2, reason: 'APPLY_FAILED' });
  journal.record('ice-restart-failed', { key: 'send', reason: 'DEADLINE_EXCEEDED' });
  const events = journal.snapshot().events;
  assert.deepEqual(events.filter(event => event.stage === 'retry').map(event => event.reason), ['REQUEST_FAILED', 'APPLY_FAILED']);
  assert.equal(events.at(-1)?.attempt, 2);
  assert.equal(events[4].stage, 'applying');
});

test('owner teardown ends every active legacy and signal round once, without inventing idle recovery', () => {
  const journal = createRecoveryDiagnostics();
  journal.cancelActive();
  assert.equal(journal.snapshot().events.length, 0);
  journal.record('signal-disconnected', 'transport close');
  for (const key of ['send', 'recv', 'screen']) journal.record('legacy-transport-failed', { key });
  journal.cancelActive();
  const ended = journal.snapshot().events;
  assert.equal(ended.filter(event => event.stage === 'cancelled').length, 4);
  assert.ok(ended.filter(event => event.stage === 'cancelled').every(event => event.reason === 'OWNER_TEARDOWN'));
  journal.cancelActive();
  journal.record('legacy-transport-connected', { key: 'send' });
  journal.record('signal-connected');
  assert.deepEqual(journal.snapshot().events, ended);
  journal.record('legacy-transport-failed', { key: 'send' });
  assert.notEqual(journal.snapshot().events.at(-1)?.recoveryId, ended.find(event => event.channel === 'send')?.recoveryId);
});
