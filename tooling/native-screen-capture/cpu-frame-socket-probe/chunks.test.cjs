'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { configuration, sendIpcChunks, Pool, stamp } = require('./protocol.cjs');
const { sanitizeRenderer } = require('./run.cjs');

// Exercise the exact self-contained sandbox receiver without launching Electron,
// constructing VideoFrame, touching GPU, starting a pacer, or opening a socket.
function harness() {
  const listeners = new Map(), sent = [], timers = new Map(); let now = 0, timerId = 0;
  const ipcRenderer = {
    on: (name, callback) => listeners.set(name, callback),
    once: (name, callback) => listeners.set(name, (...args) => { listeners.delete(name); callback(...args); }),
    removeListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
    send: (name, value) => sent.push({ name, value }),
  };
  const context = { require: name => { assert.equal(name, 'electron'); return { ipcRenderer }; },
    ArrayBuffer, Uint8Array, DataView, structuredClone, performance: { now: () => now },
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, due: now + ms }); return id; },
    clearTimeout: id => timers.delete(id), document: { visibilityState: 'hidden', hasFocus: () => false },
    VideoFrame: function () { throw new Error('test_must_not_construct_videoframe'); } };
  const source = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
  const Receiver = vm.runInNewContext(source + '\nChunkReceiver;', context, { filename: 'actual-sandbox-preload.cjs' });
  return { Receiver, timers, sent, listeners,
    emit: (type, ...values) => listeners.get('cove:cpu-frame-probe:' + type)?.({}, ...values),
    advance: ms => {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.callback(); }
    },
  };
}
function parts(width = 1728, chunkBytes = 49152, slot = 0, serial = 9) {
  const pool = new Pool(width, 1080), source = pool.slots[slot].buffer;
  stamp(source, width, 1080, serial);
  const messages = [];
  const count = sendIpcChunks({ slot, serial, width, height: 1080, timestamp: serial * 8333 }, source, chunkBytes,
    (metadata, buffer) => messages.push({ metadata, buffer }));
  return { pool, source, messages, count };
}
function receiver(setup, width = 1728, chunkBytes = 49152, onTimeout = () => {}) {
  return new setup.Receiver(width, 1080, chunkBytes, 1500, onTimeout);
}

test('chunk mode and only 48 KiB or exact full-frame controls are bounded and argument order independent', () => {
  assert.deepEqual(configuration(['--mode', 'ipc-inline-chunks']).modes, ['ipc-inline-chunks']);
  assert.equal(configuration(['--chunk-bytes', 'frame', '--width', '1920']).chunkBytes, 3110400);
  assert.equal(configuration(['--chunk-bytes', '2799360']).chunkBytes, 2799360);
  for (const value of ['0', '49151', '65536', 'NaN', '3110400', '']) assert.throws(() => configuration(['--chunk-bytes', value]));
});

test('split sends exact independent ArrayBuffers and actual preload reassembles the complete stamped NV12 bytes', () => {
  for (const [width, chunkBytes, expectedCount, tail] of [[1728, 49152, 57, 46848], [1920, 49152, 64, 13824], [1728, 2799360, 1, 2799360]]) {
    const setup = harness(), input = parts(width, chunkBytes), assembly = receiver(setup, width, chunkBytes);
    try {
      assert.equal(input.count, expectedCount); assert.equal(input.messages.at(-1).buffer.byteLength, tail);
      assert.equal(new Set(input.messages.map(part => part.buffer)).size, expectedCount);
      let complete;
      for (const { metadata, buffer } of input.messages) {
        assert.notEqual(buffer, input.source); assert.equal(buffer instanceof ArrayBuffer, true);
        assert.equal(buffer.byteLength, metadata.partBytes);
        complete = assembly.push(metadata, buffer);
      }
      assert.deepEqual(Buffer.from(complete.buffer), Buffer.from(input.source));
      assert.equal(assembly.state().processingSlots, 1); assert.equal(assembly.state().timers, 0);
      assert.throws(() => assembly.push(input.messages[0].metadata, input.messages[0].buffer), /replay_or_order/);
      assembly.release(0, 8); assert.equal(assembly.state().processingSlots, 1);
      assembly.release(0, 9); assert.equal(assembly.state().processingSlots, 0);
      assert.throws(() => assembly.push(input.messages[0].metadata, input.messages[0].buffer), /replay_or_order/);
    } finally { assembly.stop(); input.pool.stop(); }
    assert.equal(setup.timers.size, 0); assert.equal(assembly.state().retainedBytes, 0);
  }
});

test('three interleaved assemblies stay within three frames; a processing slot remains owned until final frame release', () => {
  const setup = harness(), assembly = receiver(setup), inputs = [0, 1, 2].map(slot => parts(1728, 49152, slot, slot + 1));
  try {
    for (let part = 0; part < 57; ++part) for (const input of inputs) assembly.push(input.messages[part].metadata, input.messages[part].buffer);
    assert.equal(assembly.state().maxSlots, 3); assert.equal(assembly.state().maxRetainedBytes, 3 * 2799360);
    assert.equal(assembly.state().processingSlots, 3);
    assert.throws(() => assembly.push({ ...inputs[0].messages[0].metadata, serial: 10, timestamp: 83330 }, inputs[0].messages[0].buffer), /replay_or_order/);
    assert.throws(() => assembly.push({ ...inputs[0].messages[0].metadata, slot: 3 }, inputs[0].messages[0].buffer), /invalid_ipc_chunk/);
  } finally { assembly.stop(); for (const input of inputs) input.pool.stop(); }
  assert.equal(assembly.state().processingSlots, 0); assert.equal(setup.timers.size, 0);
});

test('actual preload receiver rejects malformed metadata, backing views, wrong sizes, duplicate and out-of-order parts', () => {
  const input = parts(), first = input.messages[0], second = input.messages[1];
  const malformed = [
    { part: 1, offset: 49152 }, { slot: -1 }, { slot: 3 }, { serial: 0 }, { serial: 0x100000000 },
    { width: 1920 }, { height: 1079 }, { timestamp: 0 }, { timestamp: 0x100000000 },
    { chunkBytes: 65536 }, { frameBytes: 2799359 }, { partCount: 58 }, { part: .5 }, { offset: -1 },
    { offset: 1 }, { partBytes: 49151 }, { part: 57, offset: 57 * 49152 },
  ];
  try {
    for (const change of malformed) {
      const setup = harness(), assembly = receiver(setup);
      try { assert.throws(() => assembly.push({ ...first.metadata, ...change }, first.buffer)); }
      finally { assembly.stop(); assert.equal(setup.timers.size, 0); }
    }
    for (const buffer of [new Uint8Array(first.buffer), new ArrayBuffer(49151), new ArrayBuffer(49153)]) {
      const setup = harness(), assembly = receiver(setup);
      try { assert.throws(() => assembly.push(first.metadata, buffer)); } finally { assembly.stop(); }
    }
    for (const next of [first, input.messages[2], { metadata: { ...second.metadata, serial: 10 }, buffer: second.buffer },
      { metadata: { ...second.metadata, timestamp: 10 }, buffer: second.buffer },
      { metadata: input.messages.at(-1).metadata, buffer: new ArrayBuffer(49152) }]) {
      const setup = harness(), assembly = receiver(setup);
      try { assembly.push(first.metadata, first.buffer); assert.throws(() => assembly.push(next.metadata, next.buffer)); }
      finally { assembly.stop(); assert.equal(assembly.state().retainedBytes, 0); assert.equal(setup.timers.size, 0); }
    }
  } finally { input.pool.stop(); }
});

test('missing final part has a fixed first-part deadline; stop disposes partial buffers and timers', () => {
  const setup = harness(), input = parts(), faults = [];
  let assembly;
  assembly = receiver(setup, 1728, 49152, code => { faults.push(code); assembly.stop(); });
  try {
    assembly.push(input.messages[0].metadata, input.messages[0].buffer);
    setup.advance(1400); assembly.push(input.messages[1].metadata, input.messages[1].buffer);
    assert.equal(setup.timers.size, 1); setup.advance(100);
    assert.deepEqual(faults, ['ipc_chunk_deadline']); assert.equal(assembly.state().retainedBytes, 0);
    assert.equal(assembly.state().partials, 0); assert.equal(setup.timers.size, 0);
    assert.throws(() => assembly.push(input.messages[2].metadata, input.messages[2].buffer));
    assembly.stop();
  } finally { assembly.stop(); input.pool.stop(); }
});

test('actual preload invalid chunk and deadline fault stop and detach input without constructing a VideoFrame', async () => {
  for (const failure of ['metadata', 'deadline', 'stop']) {
    const setup = harness(), input = parts();
    try {
      setup.emit('init', { mode: 'ipc-inline-chunks', width: 1728, height: 1080, chunkBytes: 49152, reassemblyDeadlineMs: 1500 });
      const first = input.messages[0]; setup.emit('chunk', first.metadata, first.buffer); assert.equal(first.buffer.byteLength, 0);
      if (failure === 'metadata') setup.emit('chunk', { ...input.messages[1].metadata, offset: 0 }, input.messages[1].buffer);
      else if (failure === 'deadline') setup.advance(1500);
      else setup.emit('stop');
      await new Promise(resolve => setImmediate(resolve));
      const report = setup.sent.find(event => event.name.endsWith(':stopped'))?.value;
      assert.ok(report); assert.equal(report.constructed, 0); assert.equal(report.resourcesDisposed, true);
      const sanitized = sanitizeRenderer(report); assert.equal(sanitized.resourcesDisposed, true);
      assert.equal(sanitized.ipcChunks.retainedBytes, 0); assert.equal(sanitized.ipcChunks.timers, 0);
      assert.equal(setup.listeners.has('cove:cpu-frame-probe:chunk'), false); assert.equal(setup.timers.size, 0);
      if (failure !== 'stop') assert.equal(setup.sent.some(event => event.name.endsWith(':fault')), true);
      assert.equal(setup.sent.some(event => event.name.endsWith(':ack')), false);
    } finally { input.pool.stop(); }
  }
});

test('synchronous chunk send failure leaves main credit owned without flush or final ACK', () => {
  const pool = new Pool(1728, 1080), slot = pool.take(1); let calls = 0;
  try {
    assert.throws(() => sendIpcChunks({ slot: 0, serial: 1, width: 1728, height: 1080, timestamp: 8333 }, slot.buffer, 49152,
      () => { if (++calls === 2) throw new Error('send_failed'); }), /send_failed/);
    assert.equal(calls, 2); assert.equal(slot.buffer.byteLength, 2799360);
    assert.equal(slot.flushed, false); assert.equal(slot.acked, false); assert.equal(pool.inFlight, 1);
  } finally { pool.stop(); }
});
