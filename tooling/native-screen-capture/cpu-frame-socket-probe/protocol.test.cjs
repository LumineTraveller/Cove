'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { MAGIC, Pool, configuration, fillPattern, stamp, writeHeader, readAck, summary } = require('./protocol.cjs');
const { createTransport } = require('./transport.cjs');
const { cpuDifference, sanitizeRenderer, bounded } = require('./run.cjs');

test('only bounded 1080p NV12 configurations are accepted', () => {
  assert.deepEqual(configuration([]), { width: 1728, height: 1080, seconds: 8, warmup: 2, modes: ['ipc', 'ws'], pacer: 'native', wsFraming: 'fragmented', window: 'hidden', chunkBytes: 49152 });
  assert.deepEqual(configuration(['--width', '1920', '--seconds', '30', '--mode', 'ws-first']).modes, ['ws', 'ipc']);
  assert.equal(configuration(['--pacer', 'node', '--ws-framing', 'single-copy', '--window', 'shown']).wsFraming, 'single-copy');
  for (const args of [['--width', '1918'], ['--seconds', '1'], ['--seconds', '31'], ['--warmup', '0'], ['--unknown', 'x'], ['--mode', 'arbitrary'], ['--width'], ['--pacer', 'spin'], ['--ws-framing', 'compressed'], ['--window', 'offscreen']])
    assert.throws(() => configuration(args));
});
test('ordinary three-buffer pool requires exact ACK AND send flush before reuse', () => {
  const pool = new Pool(1728, 1080);
  const slots = [pool.take(1), pool.take(2), pool.take(3)];
  assert.equal(pool.take(4), null); assert.equal(pool.maxInFlight, 3);
  assert.equal(pool.ack(0, 1), true); assert.equal(pool.inFlight, 3);
  assert.equal(pool.ack(0, 1), false); assert.equal(pool.flush(0, 0), false);
  assert.equal(pool.flush(0, 1), true); assert.equal(pool.inFlight, 2);
  assert.equal(pool.flush(0, 1), false);
  const next = pool.take(4); assert.equal(next, slots[0]);
  assert.equal(pool.ack(0, 1), false); assert.equal(pool.flush(0, 1), false); assert.equal(pool.inFlight, 3);
  assert.equal(pool.flush(0, 4), true); assert.equal(pool.inFlight, 3);
  assert.equal(pool.ack(0, 4), true); assert.equal(pool.inFlight, 2);
  pool.stop(); assert.equal(pool.take(5), null); assert.equal(pool.ack(1, 2), false);
  assert.equal(pool.slots.every(slot => !slot.buffer && !slot.header && !slot.payload), true);
});
test('pool has three actual ArrayBuffers and zero-copy Node views; content is independently known', () => {
  const pool = new Pool(1920, 1080), slot = pool.take(123);
  assert.equal(new Set(pool.slots.map(value => value.buffer)).size, 3);
  assert.equal(slot.payload.buffer, slot.buffer);
  stamp(slot.buffer, 1920, 1080, 123);
  const view = new DataView(slot.buffer);
  assert.equal(view.getUint32(0, true), 123); assert.equal(view.getUint32(1920 * 1080 - 4, true), 123);
  const bytes = new Uint8Array(slot.buffer);
  const expected = [[480, 270, 36, 80, 176], [1440, 270, 84, 104, 156], [480, 810, 142, 128, 136], [1440, 810, 190, 152, 116]];
  for (const [x, y, luma, u, v] of expected) {
    assert.equal(bytes[y * 1920 + x], luma);
    assert.equal(bytes[1920 * 1080 + y / 2 * 1920 + x], u);
    assert.equal(bytes[1920 * 1080 + y / 2 * 1920 + x + 1], v);
  }
  assert.throws(() => fillPattern(new ArrayBuffer(1), 1920, 1080)); pool.stop();
});
test('fixed 32-byte frame header and strict 24-byte bounded ACK', () => {
  const header = writeHeader(Buffer.alloc(32), { slot: 2, serial: 24, width: 1728, height: 1080, timestamp: 1000, sendEpochMs: 0 });
  assert.equal(header.readUInt32LE(0), MAGIC); assert.equal(header.readUInt16LE(6), 2);
  assert.equal(header.readUInt32LE(8), 24); assert.equal(header.readUInt32LE(16), 2799360);
  const ack = Buffer.alloc(24); ack.writeUInt32LE(MAGIC); ack.writeUInt32LE(2, 4); ack.writeUInt32LE(24, 8); ack.writeUInt32LE(7, 12); ack.writeDoubleLE(.5, 16);
  assert.deepEqual(readAck(ack), { slot: 2, serial: 24, flags: 7, constructMs: .5 });
  assert.equal(readAck(ack.subarray(0, 23)), null);
  ack.writeDoubleLE(NaN, 16); assert.equal(readAck(ack), null);
  ack.writeDoubleLE(.5, 16); ack.writeUInt32LE(0, 12); assert.equal(readAck(ack), null);
});
test('CPU summary refuses an unstable process set and report sanitizer excludes arbitrary fields', () => {
  const before = { at: 0, main: { user: 10, system: 20 }, processes: [{ pid: 1, type: 'Browser', seconds: 1 }] };
  const after = { at: 1000, main: { user: 1010, system: 2020 }, processes: [{ pid: 1, type: 'Browser', seconds: 1.5 }] };
  assert.equal(cpuDifference(before, after).totalCPUSeconds, .5);
  after.processes[0].pid = 2; assert.equal(cpuDifference(before, after).totalCPUSeconds, null);
  assert.equal(summary([1, 2, 3]).mean, 2);
  const report = Object.fromEntries(['received', 'constructed', 'detached', 'closed', 'validated', 'acked', 'rejected', 'pixelErrors', 'sequenceErrors',
    'maxPending', 'pendingAfterCleanup', 'framesAfterCleanup'].map(name => [name, 0]));
  Object.assign(report, { arbitrary: 'excluded', resourcesDisposed: true, socketReferenceRetained: false, helloTimerActive: false });
  assert.equal(sanitizeRenderer(report).arbitrary, undefined); report.acked = -1; assert.throws(() => sanitizeRenderer(report));
});
async function fixture(framing = 'fragmented') {
  const errors = [], acks = [];
  const transport = await createTransport({ onAck: value => acks.push(value), onError: code => errors.push(code), framing });
  const credentials = transport.credentials();
  return { transport, credentials, errors, acks };
}
function connect(credentials, options = {}) {
  const ws = new WebSocket('ws://127.0.0.1:' + credentials.port + (options.path || credentials.path), {
    origin: options.origin || 'null', perMessageDeflate: options.perMessageDeflate ?? true, ...options });
  ws.on('error', () => {}); return ws;
}
async function authenticate(fixture) {
  const ws = connect(fixture.credentials), opening = once(ws, 'open');
  await bounded(opening, 1000, 'test_open_timeout');
  const hello = once(ws, 'message');
  const token = Buffer.from(fixture.credentials.token, 'base64'), auth = Buffer.alloc(33); auth[0] = 1; token.copy(auth, 1); token.fill(0);
  ws.send(auth, () => auth.fill(0));
  const [proof, binary] = await bounded(hello, 1000, 'test_hello_timeout');
  assert.equal(binary, true); assert.equal(proof.length, 33); assert.equal(proof[0], 2);
  const expected = Buffer.from(fixture.credentials.proof, 'base64');
  assert.equal(proof.subarray(1).equals(expected), true); proof.fill(0); expected.fill(0);
  return ws;
}
test('loopback authorization uses independent proof and one-time credentials, retires listener; fragments reconstruct one message', async () => {
  const state = await fixture(); let ws;
  try {
    assert.throws(() => state.transport.credentials());
    ws = await authenticate(state);
    assert.equal(ws.extensions, ''); // Client advertises deflate; server refuses it.
    assert.equal(state.transport.state().authenticated, true); assert.equal(state.transport.state().listenerOpen, false);
    const pool = new Pool(1728, 1080), slot = pool.take(42);
    stamp(slot.buffer, 1728, 1080, 42); writeHeader(slot.header, { slot: 0, serial: 42, width: 1728, height: 1080, timestamp: 8333, sendEpochMs: 0 });
    const receiving = once(ws, 'message'); let flushed = false;
    state.transport.send(slot, () => { flushed = true; });
    const [frame, binary] = await bounded(receiving, 1000, 'test_frame_timeout');
    assert.equal(binary, true); assert.equal(frame.length, 32 + 2799360); assert.equal(frame.readUInt32LE(32), 42);
    assert.equal(frame.readUInt32LE(32 + 1728 * 1080 - 4), 42); assert.equal(flushed, true);
    const ack = Buffer.alloc(24); ack.writeUInt32LE(MAGIC); ack.writeUInt32LE(42, 8); ack.writeUInt32LE(7, 12); ack.writeDoubleLE(.1, 16); ws.send(ack);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(state.acks.length, 1); assert.equal(state.acks[0].serial, 42); assert.deepEqual(state.errors, []); pool.stop();
  } finally { ws?.terminate(); await state.transport.stop(); }
  assert.deepEqual(state.transport.state(), { authenticated: true, stopped: true, listenerOpen: false, socketCount: 0, websocketCount: 0, authTimerActive: false });
});
test('wrong Origin and path are rejected before authentication without pixels', async () => {
  for (const options of [{ origin: 'https://invalid.example' }, { path: '/wrong' }]) {
    const state = await fixture(), ws = connect(state.credentials, options);
    try { await bounded(once(ws, 'close'), 1000, 'test_reject_timeout').catch(() => {}); assert.equal(state.transport.state().authenticated, false); }
    finally { ws.terminate(); await state.transport.stop(); }
  }
});
test('bad client token fails closed and disposes pending auth timer/listener', async () => {
  const state = await fixture(), ws = connect(state.credentials);
  try {
    await bounded(once(ws, 'open'), 1000, 'test_open_timeout');
    const closed = once(ws, 'close'); ws.send(Buffer.alloc(33));
    await bounded(closed, 1000, 'test_close_timeout');
    assert.equal(state.errors.includes('loopback_auth_failed'), true); assert.equal(state.transport.state().authenticated, false);
  } finally { ws.terminate(); await state.transport.stop(); }
  assert.equal(state.transport.state().authTimerActive, false); assert.equal(state.transport.state().socketCount, 0);
});
test('maxPayload 128 rejects oversized inbound messages after authentication', async () => {
  const state = await fixture(); let ws;
  try {
    ws = await authenticate(state); const closed = once(ws, 'close'); ws.send(Buffer.alloc(129));
    await bounded(closed, 1000, 'test_close_timeout'); assert.equal(state.errors.length > 0, true);
  } finally { ws?.terminate(); await state.transport.stop(); }
});
test('unauthenticated reserved client receives no proof or frame and times out', async () => {
  const state = await fixture(), ws = connect(state.credentials); let messages = 0;
  ws.on('message', () => messages++);
  try {
    await bounded(once(ws, 'open'), 1000, 'test_open_timeout');
    await bounded(once(ws, 'close'), 2300, 'test_auth_expiry_timeout');
    assert.equal(messages, 0); assert.equal(state.transport.state().authenticated, false);
    assert.equal(state.errors.includes('loopback_auth_timeout'), true);
  } finally { ws.terminate(); await state.transport.stop(); }
  assert.equal(state.transport.state().authTimerActive, false);
});
test('stop while awaiting auth clears timer and actual sockets; repeated stop awaits same cleanup', async () => {
  const state = await fixture(), ws = connect(state.credentials);
  try {
    await bounded(once(ws, 'open'), 1000, 'test_open_timeout');
    assert.equal(state.transport.state().authTimerActive, true);
    const first = state.transport.stop(), second = state.transport.stop(); assert.equal(first, second);
    await first;
    assert.equal(state.transport.state().socketCount, 0); assert.equal(state.transport.state().websocketCount, 0);
    assert.equal(state.transport.state().authTimerActive, false); assert.equal(state.transport.state().listenerOpen, false);
  } finally { ws.terminate(); await state.transport.stop(); }
});
test('outer-cork and explicit full-copy controls preserve one actual NV12 message with bounded telemetry', async () => {
  for (const framing of ['fragmented-cork', 'single-copy']) {
    const state = await fixture(framing); let ws;
    const pool = new Pool(1728, 1080), slot = pool.take(77);
    try {
      ws = await authenticate(state);
      stamp(slot.buffer, 1728, 1080, 77); writeHeader(slot.header, { slot: 0, serial: 77, width: 1728, height: 1080, timestamp: 8333 });
      const reading = once(ws, 'message'); let flushed = false; state.transport.send(slot, () => { flushed = true; });
      const [message, binary] = await bounded(reading, 1000, 'test_control_timeout');
      assert.equal(binary, true); assert.equal(message.length, slot.payload.length + 32); assert.equal(message.readUInt32LE(32), 77); assert.equal(flushed, true);
      const diag = state.transport.diagnostics();
      assert.equal(diag.tcpNoDelayRequested, true); assert.equal(diag.tcpNoDelayNativeResult, 0); assert.equal(diag.dataMessages, 1);
      assert.equal(diag.fullFrameCopies, framing === 'single-copy' ? 1 : 0);
      assert.equal(diag.fullFrameCopyBytes, framing === 'single-copy' ? slot.payload.length + 32 : 0);
      assert.equal(diag.postSendBufferedBytes.count, 1); assert.deepEqual(state.errors, []);
    } finally { pool.stop(); ws?.terminate(); await state.transport.stop(); }
  }
});
