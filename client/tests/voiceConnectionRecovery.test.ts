import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceConnectionRecovery, type VoiceConnectionState } from '../src/voiceConnectionRecovery';
import { DisconnectGrace, DISCONNECT_GRACE_MS } from '../src/utils/disconnectGrace';
import { DisconnectGrace as ServerGrace } from '../../server/src/disconnectGrace';

function fixture() {
  const state: VoiceConnectionState = {
    connected: true, recovered: false, socketId: 'voice-socket', voiceSocketId: 'voice-socket',
    active: true, joining: false, sendState: 'connected', recvState: 'connected',
  };
  const grace = new DisconnectGrace();
  const resets: string[] = [];
  const errors: string[] = [];
  const events: string[] = [];
  let leaves = 0;
  const resetVoice = (reason: string) => {
    resets.push(reason);
    state.active = false;
    state.joining = false;
    state.sendState = null;
    state.recvState = null;
    grace.clear();
  };
  const recovery = createVoiceConnectionRecovery({
    grace, readState: () => state, resetVoice,
    leaveRecoveredVoice: () => { leaves += 1; },
    onError: message => errors.push(message),
    onEvent: event => events.push(event),
  });
  const disconnect = (reason = 'transport close') => {
    state.connected = false;
    state.socketId = undefined;
    recovery.onDisconnect(reason);
  };
  const connect = (id = 'voice-socket', recovered = true) => {
    state.connected = true;
    state.socketId = id;
    state.recovered = recovered;
    recovery.onConnect();
  };
  return { state, grace, resets, errors, events, recovery, resetVoice, disconnect, connect, leaves: () => leaves };
}

test('server recovery before its deadline preserves live voice even when the client connect event arrives after 5s', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const serverGrace = new ServerGrace();
  let serverPeerAlive = true;
  f.disconnect('ping timeout');
  serverGrace.fail('voice-socket', () => { serverPeerAlive = false; });
  t.mock.timers.tick(1_090);
  serverGrace.recover('voice-socket');
  // Restoring the server socket does not guarantee that the client's reconnect
  // packet/listeners have already run. WebRTC continues independently meanwhile.
  t.mock.timers.tick(DISCONNECT_GRACE_MS - 1_090);
  assert.equal(serverPeerAlive, true);
  assert.deepEqual(f.resets, []);
  assert.equal(f.state.active, true);
  assert.deepEqual(f.errors, []);
  t.mock.timers.tick(700);
  f.connect();
  t.mock.timers.tick(DISCONNECT_GRACE_MS);
  assert.deepEqual(f.resets, []);
  assert.equal(f.leaves(), 0);
  f.recovery.dispose();
});

test('recovery within 5s cancels the signalling deadline', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.disconnect();
  t.mock.timers.tick(1_000);
  f.connect();
  t.mock.timers.tick(10_000);
  assert.deepEqual(f.resets, []);
  assert.equal(f.leaves(), 0);
});

test('a voice room with no remote audio yet may retain its connected microphone', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.state.recvState = 'new';
  f.disconnect();
  t.mock.timers.tick(DISCONNECT_GRACE_MS);
  assert.equal(f.state.active, true);
  assert.deepEqual(f.resets, []);
  f.recovery.dispose();
});

test('an unfinished voice join still times out instead of waiting indefinitely', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  Object.assign(f.state, { active: false, joining: true, sendState: 'new', recvState: 'new' });
  f.disconnect();
  t.mock.timers.tick(DISCONNECT_GRACE_MS);
  assert.deepEqual(f.resets, ['signal-timeout']);
  assert.equal(f.errors.length, 1);
});

test('retaining live voice does not cancel the independent media failure deadline', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.disconnect();
  t.mock.timers.tick(DISCONNECT_GRACE_MS);
  assert.deepEqual(f.resets, []);
  f.state.recvState = 'disconnected';
  f.grace.fail('recv', () => f.resetVoice('media-recv-timeout'));
  t.mock.timers.tick(1_000);
  f.connect();
  t.mock.timers.tick(DISCONNECT_GRACE_MS - 1_000);
  assert.deepEqual(f.resets, ['media-recv-timeout']);
});

test('a fresh server session cannot reuse the previous session media', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.disconnect();
  t.mock.timers.tick(DISCONNECT_GRACE_MS);
  f.connect('new-socket', false);
  assert.deepEqual(f.resets, ['session-not-recovered']);
  assert.equal(f.state.active, false);
});

test('explicit logout or server kick closes media immediately', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const reason of ['io client disconnect', 'io server disconnect']) {
    const f = fixture();
    f.disconnect(reason);
    assert.deepEqual(f.resets, [reason]);
    t.mock.timers.tick(10_000);
    assert.equal(f.resets.length, 1);
  }
});

test('leaving voice during an outage is not undone by later recovery', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.disconnect();
  t.mock.timers.tick(1_000);
  f.resetVoice('user-leave');
  t.mock.timers.tick(DISCONNECT_GRACE_MS);
  f.connect();
  assert.deepEqual(f.resets, ['user-leave']);
  assert.equal(f.state.active, false);
  assert.equal(f.leaves(), 1);
});

test('room effect disposal cancels a pending signalling timeout', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.disconnect();
  f.recovery.dispose();
  t.mock.timers.tick(DISCONNECT_GRACE_MS);
  assert.deepEqual(f.resets, []);
});
