import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNativeCpuFrameDelivery,
  type NativeCpuFrameDeliveryOptions,
  type NativeCpuFrameFailure,
  type NativeCpuFrameTimingStage,
  type NativeCpuScreenFrame,
  type NativeCpuDeliveryScheduling,
} from '../electron/native-screen-cpu-delivery';

interface Timer { due: number; callback(): void; unref(): void; }
interface Immediate { callback(): void; }

function fixture(context: TestContext, deliveryScheduling?: NativeCpuDeliveryScheduling) {
  let time = 0;
  let unrefs = 0;
  const timers = new Map<Timer, Timer>();
  const allTimers: Timer[] = [];
  const immediates = new Set<Immediate>();
  const allImmediates: Immediate[] = [];
  const cancelledImmediates: Immediate[] = [];
  context.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay: number) => {
    const timer: Timer = { due: time + delay, callback, unref() { unrefs++; } };
    timers.set(timer, timer); allTimers.push(timer); return timer;
  }) as unknown as typeof setTimeout);
  context.mock.method(globalThis, 'clearTimeout', ((timer: Timer) => { timers.delete(timer); }) as unknown as typeof clearTimeout);
  const source = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const handle = Buffer.alloc(8, 1);
  const events: string[] = [];
  const reads: { handle: Buffer; expectedBytes: number }[] = [];
  const imported: NativeCpuScreenFrame[] = [];
  const sent: { metadata: NativeCpuScreenFrame; data: ArrayBuffer }[] = [];
  const credits: NativeCpuScreenFrame[] = [];
  const failures: NativeCpuFrameFailure[] = [];
  const timings: { stage: NativeCpuFrameTimingStage; durationMs: number }[] = [];
  const hooks = {
    read: (_handle: Buffer, _expectedBytes: number, _metadata: NativeCpuScreenFrame): ArrayBuffer => Uint8Array.from(source).buffer,
    imported: (_metadata: NativeCpuScreenFrame): boolean => true,
    send: (_metadata: NativeCpuScreenFrame, _data: ArrayBuffer): void => {},
    released: (_metadata: NativeCpuScreenFrame): boolean => true,
    timing: (_stage: NativeCpuFrameTimingStage, _durationMs: number): void => {},
  };
  const options: NativeCpuFrameDeliveryOptions = {
    requestId: 'request-1', sessionId: 'session-1', width: 4, height: 2, colorSpace: 'bt709-limited',
    deliveryScheduling,
    scheduler: {
      setImmediate(callback) {
        const immediate = { callback }; immediates.add(immediate); allImmediates.push(immediate);
        return immediate as unknown as ReturnType<typeof setImmediate>;
      },
      clearImmediate(handle) {
        const immediate = handle as unknown as Immediate;
        immediates.delete(immediate); cancelledImmediates.push(immediate);
      },
    },
    now: () => time,
    readFrame(value, expectedBytes, metadata) {
      events.push('read'); reads.push({ handle: value, expectedBytes });
      return hooks.read(value, expectedBytes, metadata);
    },
    onImported(metadata) { events.push('imported'); imported.push(metadata); return hooks.imported(metadata); },
    send(metadata, data) { events.push('send'); sent.push({ metadata, data }); hooks.send(metadata, data); },
    onReleased(metadata) { events.push('released'); credits.push(metadata); return hooks.released(metadata); },
    onFailure(code) { events.push(code); failures.push(code); },
    onTiming(stage, durationMs) { timings.push({ stage, durationMs }); hooks.timing(stage, durationMs); },
  };
  const delivery = createNativeCpuFrameDelivery(options);
  context.after(() => delivery.stop());
  const frame = (patch: Partial<NativeCpuScreenFrame> = {}): NativeCpuScreenFrame => ({
    requestId: 'request-1', sessionId: 'session-1', slot: 0, serial: 1,
    width: 4, height: 2, timestamp: 1_000, refresh: false, pixelFormat: 'nv12', storage: 'cpu', colorSpace: 'bt709-limited', ...patch,
  });
  return { delivery, options, frame, hooks, source, handle, events, reads, imported, sent, credits,
    failures, timings, timers, allTimers, immediates, allImmediates, cancelledImmediates,
    get unrefs() { return unrefs; },
    runImmediate() {
      const immediate = immediates.values().next().value as Immediate | undefined;
      assert.ok(immediate, 'a delivery immediate must be pending');
      immediates.delete(immediate); immediate.callback();
    },
    at(value: number) { time = value; },
    advance(milliseconds: number) {
      const until = time + milliseconds;
      while (true) {
        const next = [...timers.values()].filter(timer => timer.due <= until).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        time = next.due; timers.delete(next); next.callback();
      }
      time = until;
    },
  };
}

test('an independent exact NV12 copy is imported before send and credited only after final ack', context => {
  const f = fixture(context);
  f.hooks.read = () => { f.at(2); return Uint8Array.from(f.source).buffer; };
  f.hooks.imported = () => { f.at(3); return true; };
  f.hooks.send = () => { f.at(6); };
  const original = f.frame();
  f.delivery.deliver(original, f.handle);
  assert.deepEqual(f.events, ['read', 'imported', 'send']);
  assert.deepEqual(f.reads, [{ handle: f.handle, expectedBytes: 12 }]);
  assert.equal(f.unrefs, 1);
  assert.equal(f.timers.size, 1);
  assert.deepEqual(f.delivery.snapshot(), { inFlight: 1, stopped: false, frames: 1, released: 0, expectedBytes: 12 });
  assert.equal(f.sent[0].data.byteLength, 12);
  assert.deepEqual([...new Uint8Array(f.sent[0].data)], [...f.source]);
  f.source.fill(99);
  assert.equal(new Uint8Array(f.sent[0].data)[0], 1);
  new Uint8Array(f.sent[0].data).fill(55);
  assert.equal(f.source[0], 99);
  original.serial = 100;
  assert.equal(f.sent[0].metadata.serial, 1);
  assert.equal(Object.isFrozen(f.sent[0].metadata), true);
  f.at(10);
  assert.equal(f.delivery.acknowledge(f.sent[0].metadata), true);
  assert.equal(f.delivery.acknowledge(f.sent[0].metadata), false);
  assert.equal(f.credits.length, 1);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.timings, [
    { stage: 'import', durationMs: 2 }, { stage: 'transfer', durationMs: 3 }, { stage: 'reference', durationMs: 10 },
  ]);
  assert.deepEqual(f.delivery.snapshot(), { inFlight: 0, stopped: false, frames: 1, released: 1, expectedBytes: 12 });
});

test('three slots stay bounded and an acknowledged slot can be reused with a newer serial', context => {
  const f = fixture(context);
  for (let slot = 0; slot < 3; slot++) f.delivery.deliver(f.frame({ slot, serial: slot + 1, timestamp: (slot + 1) * 1000 }), f.handle);
  assert.equal(f.delivery.snapshot().inFlight, 3);
  assert.equal(f.timers.size, 3);
  assert.equal(f.delivery.acknowledge(f.sent[0].metadata), true);
  f.delivery.deliver(f.frame({ serial: 4, timestamp: 4000 }), f.handle);
  assert.equal(f.delivery.snapshot().inFlight, 3);
  assert.equal(f.timers.size, 3);
  f.delivery.deliver(f.frame({ serial: 5, timestamp: 5000 }), f.handle);
  assert.deepEqual(f.failures, ['cpu_frame_failed']);
  assert.equal(f.reads.length, 4);
  assert.equal(f.delivery.snapshot().inFlight, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.credits.length, 1);
});

test('the reader receives the exact validated lease metadata for each slot and reuse', context => {
  const f = fixture(context);
  const received: NativeCpuScreenFrame[] = [];
  f.hooks.read = (handle, expectedBytes, metadata) => {
    assert.equal(handle, f.handle);
    assert.equal(expectedBytes, 12);
    assert.equal(Object.isFrozen(metadata), true);
    received.push(metadata);
    return new ArrayBuffer(expectedBytes);
  };
  const first = f.frame({ slot: 2, serial: 14, timestamp: 2024, refresh: true });
  const second = f.frame({ slot: 0, serial: 15, timestamp: 2030 });
  f.delivery.deliver(first, f.handle);
  f.delivery.deliver(second, f.handle);
  assert.deepEqual(received, [first, second]);
  assert.notEqual(received[0], first);
  first.slot = 1; first.timestamp = 100;
  assert.equal(received[0].slot, 2);
  assert.equal(received[0].timestamp, 2024);
  assert.equal(f.delivery.acknowledge(received[0]), true);
  const reused = f.frame({ slot: 2, serial: 16, timestamp: 2036 });
  f.delivery.deliver(reused, f.handle);
  assert.deepEqual(received[2], reused);
  for (let index = 0; index < received.length; index++) {
    assert.equal(received[index], f.imported[index]);
    assert.equal(received[index], f.sent[index].metadata);
  }
  assert.equal(f.delivery.acknowledge(received[1]), true);
  assert.equal(f.delivery.acknowledge(received[2]), true);
  assert.equal(f.delivery.snapshot().inFlight, 0);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.failures, []);
});

test('an existing two-argument reader remains compatible', context => {
  const f = fixture(context);
  let reads = 0;
  const delivery = createNativeCpuFrameDelivery({ ...f.options, readFrame(handle, expectedBytes) {
    reads++;
    assert.equal(handle, f.handle);
    assert.equal(expectedBytes, 12);
    return new ArrayBuffer(expectedBytes);
  } });
  context.after(() => delivery.stop());
  delivery.deliver(f.frame(), f.handle);
  assert.equal(reads, 1);
  assert.equal(delivery.acknowledge(f.sent[0].metadata), true);
  assert.equal(delivery.snapshot().inFlight, 0);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.failures, []);
});

test('BT601 session snapshots its matrix and rejects changed metadata before reading', context => {
  const f = fixture(context);
  const delivery = createNativeCpuFrameDelivery({ ...f.options, colorSpace: 'bt601-limited' });
  context.after(() => delivery.stop());
  const first = f.frame({ colorSpace: 'bt601-limited' });
  delivery.deliver(first, f.handle);
  first.colorSpace = 'bt709-limited';
  assert.equal(f.sent[0].metadata.colorSpace, 'bt601-limited');
  assert.equal(delivery.acknowledge(first), false);
  assert.equal(delivery.acknowledge(f.sent[0].metadata), true);
  delivery.deliver(f.frame({ serial: 2, timestamp: 2000 }), f.handle);
  assert.equal(f.reads.length, 1); assert.deepEqual(f.failures, ['cpu_frame_failed']);
  assert.equal(f.credits.length, 1); assert.equal(f.timers.size, 0);
});

test('constructor enforces even safe geometry and the 16 MiB stream bound', context => {
  const f = fixture(context);
  for (const [width, height] of [[0, 2], [-2, 2], [3, 2], [2, 3], [2.5, 2], [NaN, 2],
    [Infinity, 2], [Number.MAX_SAFE_INTEGER + 1, 2], [4096, 2732]]) {
    assert.throws(() => createNativeCpuFrameDelivery({ ...f.options, width, height }), RangeError);
  }
  const maximum = createNativeCpuFrameDelivery({ ...f.options, width: 4096, height: 2730 });
  assert.equal(maximum.snapshot().expectedBytes, 16_773_120);
  maximum.stop();
  assert.throws(() => createNativeCpuFrameDelivery({ ...f.options, requestId: '' }), TypeError);
  assert.throws(() => createNativeCpuFrameDelivery({ ...f.options, sessionId: '' }), TypeError);
});

const invalidFrames: [string, Record<string, unknown>][] = [
  ['request', { requestId: 'different' }], ['session', { sessionId: 'old-session' }],
  ['negative slot', { slot: -1 }], ['fourth slot', { slot: 3 }], ['fractional slot', { slot: 0.5 }],
  ['zero serial', { serial: 0 }], ['unsafe serial', { serial: Number.MAX_SAFE_INTEGER + 1 }],
  ['zero timestamp', { timestamp: 0 }], ['unsafe timestamp', { timestamp: Infinity }],
  ['width', { width: 6 }], ['height', { height: 4 }], ['refresh', { refresh: 1 }],
  ['pixel format', { pixelFormat: 'bgra' }], ['storage', { storage: 'gpu' }], ['absent storage', { storage: undefined }],
  ['changed color space', { colorSpace: 'bt601-limited' }], ['absent color space', { colorSpace: undefined }],
];
for (const [label, patch] of invalidFrames) {
  test(`invalid delivery ${label} fails without reading or giving credit`, context => {
    const f = fixture(context);
    f.delivery.deliver(f.frame(patch as Partial<NativeCpuScreenFrame>), f.handle);
    assert.deepEqual(f.failures, ['cpu_frame_failed']);
    assert.equal(f.reads.length, 0);
    assert.equal(f.credits.length, 0);
    assert.equal(f.timers.size, 0);
  });
}

test('serial and timestamp must both advance even after the previous frame was acknowledged', context => {
  const f = fixture(context);
  f.delivery.deliver(f.frame(), f.handle);
  f.delivery.acknowledge(f.sent[0].metadata);
  f.delivery.deliver(f.frame({ slot: 1, serial: 2 }), f.handle);
  assert.deepEqual(f.failures, ['cpu_frame_failed']);
  assert.equal(f.reads.length, 1);
});

test('stale, cross-session, forged and malformed acks never release a lease', context => {
  const f = fixture(context);
  f.delivery.deliver(f.frame(), f.handle);
  for (const patch of [...invalidFrames.map(([, patch]) => patch), { serial: 2 }, { timestamp: 1001 },
    { slot: 1 }, { refresh: true }]) {
    assert.equal(f.delivery.acknowledge({ ...f.sent[0].metadata, ...patch }), false);
  }
  for (const value of [null, undefined, false, 1, 'frame', [], { get requestId() { throw Error('getter'); } }])
    assert.equal(f.delivery.acknowledge(value), false);
  assert.equal(f.credits.length, 0);
  assert.equal(f.delivery.snapshot().inFlight, 1);
  assert.deepEqual(f.failures, []);
  assert.equal(f.delivery.acknowledge(f.sent[0].metadata), true);
  f.delivery.stop();
  const next = createNativeCpuFrameDelivery({ ...f.options, sessionId: 'session-2' });
  next.deliver(f.frame({ sessionId: 'session-2' }), f.handle);
  assert.equal(next.acknowledge(f.sent[0].metadata), false);
  assert.equal(next.snapshot().inFlight, 1);
  next.stop();
});

test('acks before send are rejected while an immediate transport ack is accepted once', context => {
  const f = fixture(context);
  f.hooks.imported = metadata => { assert.equal(f.delivery.acknowledge(metadata), false); return true; };
  f.hooks.send = metadata => { assert.equal(f.delivery.acknowledge(metadata), true); };
  f.hooks.released = metadata => { assert.equal(f.delivery.acknowledge(metadata), false); return true; };
  f.delivery.deliver(f.frame(), f.handle);
  assert.equal(f.credits.length, 1);
  assert.equal(f.delivery.snapshot().inFlight, 0);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.failures, []);
});

for (const stage of ['read', 'import timing', 'imported', 'send', 'released'] as const) {
  test(`a synchronous stop during ${stage} prevents subsequent work and clears resources`, context => {
    const f = fixture(context);
    if (stage === 'read') f.hooks.read = () => { f.delivery.stop(); return new ArrayBuffer(12); };
    if (stage === 'import timing') f.hooks.timing = value => { if (value === 'import') f.delivery.stop(); };
    if (stage === 'imported') f.hooks.imported = () => { f.delivery.stop(); return false; };
    if (stage === 'send') f.hooks.send = () => f.delivery.stop();
    if (stage === 'released') f.hooks.released = () => { f.delivery.stop(); return true; };
    f.delivery.deliver(f.frame(), f.handle);
    if (stage === 'released') assert.equal(f.delivery.acknowledge(f.sent[0].metadata), true);
    const eventCount = f.events.length, timingCount = f.timings.length;
    f.delivery.stop(); f.delivery.stop();
    f.delivery.deliver(f.frame({ serial: 2, timestamp: 2000 }), f.handle);
    assert.equal(f.delivery.acknowledge(f.frame()), false);
    f.advance(2000);
    assert.equal(f.events.length, eventCount);
    assert.equal(f.timings.length, timingCount);
    assert.equal(f.sent.length, stage === 'send' || stage === 'released' ? 1 : 0);
    assert.equal(f.credits.length, stage === 'released' ? 1 : 0);
    assert.equal(f.delivery.snapshot().inFlight, 0);
    assert.equal(f.delivery.snapshot().stopped, true);
    assert.equal(f.timers.size, 0);
    assert.deepEqual(f.failures, []);
  });
}

for (const stage of ['read', 'imported false', 'imported throw', 'send', 'released false', 'released throw'] as const) {
  test(`${stage} failure reports once, clears all leases and never gives another credit`, context => {
    const f = fixture(context);
    f.delivery.deliver(f.frame(), f.handle);
    if (stage === 'read') f.hooks.read = () => { throw Error('private read error'); };
    if (stage === 'imported false') f.hooks.imported = () => false;
    if (stage === 'imported throw') f.hooks.imported = () => { throw Error('private import error'); };
    if (stage === 'send') f.hooks.send = () => { throw Error('private transport error'); };
    if (stage === 'released false') f.hooks.released = () => false;
    if (stage === 'released throw') f.hooks.released = () => { throw Error('private release error'); };
    f.delivery.deliver(f.frame({ slot: 1, serial: 2, timestamp: 2000 }), f.handle);
    if (stage.startsWith('released')) assert.equal(f.delivery.acknowledge(f.sent[1].metadata), false);
    assert.deepEqual(f.failures, ['cpu_frame_failed']);
    assert.equal(f.delivery.snapshot().inFlight, 0);
    assert.equal(f.timers.size, 0);
    const credits = f.credits.length;
    assert.equal(f.delivery.acknowledge(f.sent[0].metadata), false);
    f.delivery.deliver(f.frame({ slot: 2, serial: 3, timestamp: 3000 }), f.handle);
    f.advance(2000);
    assert.equal(f.credits.length, credits);
    assert.deepEqual(f.failures, ['cpu_frame_failed']);
  });
}

for (const data of [new ArrayBuffer(11), new ArrayBuffer(13), new Uint8Array(12), new SharedArrayBuffer(12), null]) {
  test(`the native reader must return an exact owned ArrayBuffer (${Object.prototype.toString.call(data)})`, context => {
    const f = fixture(context);
    f.hooks.read = () => data as ArrayBuffer;
    f.delivery.deliver(f.frame(), f.handle);
    assert.deepEqual(f.failures, ['cpu_frame_failed']);
    assert.equal(f.imported.length, 0);
    assert.equal(f.sent.length, 0);
    assert.equal(f.timers.size, 0);
  });
}

test('bad handle shapes never reach the native reader', context => {
  const f = fixture(context);
  f.delivery.deliver(f.frame(), Buffer.alloc(7));
  assert.equal(f.reads.length, 0);
  assert.deepEqual(f.failures, ['cpu_frame_failed']);
});

test('all leases share a total 1500 ms ack limit and timeout clears every timer without credit', context => {
  const f = fixture(context);
  for (let slot = 0; slot < 3; slot++) f.delivery.deliver(f.frame({ slot, serial: slot + 1, timestamp: (slot + 1) * 1000 }), f.handle);
  assert.equal(f.unrefs, 3);
  f.advance(1499);
  assert.deepEqual(f.failures, []);
  f.advance(1);
  assert.deepEqual(f.failures, ['cpu_ack_timeout']);
  assert.equal(f.credits.length, 0);
  assert.equal(f.delivery.snapshot().inFlight, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.delivery.acknowledge(f.sent[0].metadata), false);
  f.advance(10000);
  assert.deepEqual(f.failures, ['cpu_ack_timeout']);
});

test('copy and imported work consume the same deadline instead of starting a fresh ack timer', context => {
  const f = fixture(context);
  f.hooks.read = () => { f.at(1499); return new ArrayBuffer(12); };
  f.hooks.imported = () => { f.at(1500); return true; };
  f.delivery.deliver(f.frame(), f.handle);
  assert.deepEqual(f.events, ['read', 'imported', 'cpu_ack_timeout']);
  assert.equal(f.sent.length, 0);
  assert.equal(f.timers.size, 0);
});

test('an overdue ack fails even when the event loop has not dispatched the timer', context => {
  const f = fixture(context);
  f.delivery.deliver(f.frame(), f.handle);
  f.at(1500);
  assert.equal(f.delivery.acknowledge(f.sent[0].metadata), false);
  assert.deepEqual(f.failures, ['cpu_ack_timeout']);
  assert.equal(f.credits.length, 0);
  assert.equal(f.timers.size, 0);
});

test('a delayed old timer cannot expire a newer lease reusing the same slot', context => {
  const f = fixture(context);
  f.delivery.deliver(f.frame(), f.handle);
  const oldTimer = f.allTimers[0];
  assert.equal(f.delivery.acknowledge(f.sent[0].metadata), true);
  f.at(100);
  f.delivery.deliver(f.frame({ serial: 2, timestamp: 2000 }), f.handle);
  oldTimer.callback();
  assert.deepEqual(f.failures, []);
  assert.equal(f.delivery.snapshot().inFlight, 1);
  assert.equal(f.delivery.acknowledge(f.sent[0].metadata), false);
  assert.equal(f.delivery.acknowledge(f.sent[1].metadata), true);
  assert.equal(f.timers.size, 0);
});

test('an unknown ack accessor cannot credit after synchronously stopping the session', context => {
  const f = fixture(context);
  f.delivery.deliver(f.frame(), f.handle);
  let serialReads = 0;
  const ack = { ...f.sent[0].metadata, get serial() {
    if (++serialReads === 2) f.delivery.stop();
    return 1;
  } };
  assert.equal(f.delivery.acknowledge(ack), false);
  assert.equal(f.credits.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.delivery.snapshot().inFlight, 0);
  assert.deepEqual(f.failures, []);
});

test('a clock callback cannot credit after synchronously stopping the session', context => {
  const f = fixture(context);
  let stopOnClock = false;
  const delivery = createNativeCpuFrameDelivery({ ...f.options, now: () => {
    if (stopOnClock) delivery.stop();
    return 0;
  } });
  delivery.deliver(f.frame(), f.handle);
  stopOnClock = true;
  assert.equal(delivery.acknowledge(f.sent[0].metadata), false);
  assert.equal(f.credits.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(delivery.snapshot().inFlight, 0);
  assert.deepEqual(f.failures, []);
});

test('delivery scheduling is explicit and immediate remains the default', context => {
  const f = fixture(context);
  f.delivery.deliver(f.frame(), f.handle);
  assert.equal(f.sent.length, 1);
  assert.equal(f.allImmediates.length, 0);
  const explicit = createNativeCpuFrameDelivery({ ...f.options, deliveryScheduling: 'immediate' });
  explicit.deliver(f.frame(), f.handle);
  assert.equal(f.sent.length, 2);
  assert.equal(f.allImmediates.length, 0);
  explicit.stop();
  assert.throws(() => createNativeCpuFrameDelivery({ ...f.options, deliveryScheduling: 'other' as any }), TypeError);
});

test('yield snapshots three leases and sends exactly one FIFO frame per scheduled turn', context => {
  const f = fixture(context, 'yield');
  const observedHandles: Buffer[] = [];
  f.hooks.read = handle => { observedHandles.push(Buffer.from(handle)); return new ArrayBuffer(12); };
  const originals = Array.from({ length: 3 }, (_, slot) => f.frame({ slot, serial: slot + 1, timestamp: (slot + 1) * 1000 }));
  for (const metadata of originals) f.delivery.deliver(metadata, f.handle);
  assert.equal(f.reads.length, 0);
  assert.equal(f.imported.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.delivery.snapshot().inFlight, 3);
  assert.equal(f.timers.size, 3);
  assert.equal(f.immediates.size, 1);
  assert.equal(f.delivery.acknowledge(originals[0]), false);
  originals[0].slot = 2; originals[0].serial = 99; originals[0].timestamp = 99;
  f.handle.fill(0);
  f.at(7); f.runImmediate();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].metadata.slot, 0);
  assert.equal(f.sent[0].metadata.serial, 1);
  assert.equal(Object.isFrozen(f.sent[0].metadata), true);
  assert.deepEqual([...observedHandles[0]], Array(8).fill(1));
  assert.deepEqual([...f.reads[0].handle], Array(8).fill(0));
  assert.equal(f.timings[0].durationMs, 7);
  assert.equal(f.immediates.size, 1);
  assert.equal(f.delivery.acknowledge(originals[1]), false);
  assert.equal(f.delivery.acknowledge(f.sent[0].metadata), true);
  // A poll/IPC turn can free and enqueue a slot between the first and second sends.
  f.delivery.deliver(f.frame({ slot: 0, serial: 4, timestamp: 4000 }), Buffer.alloc(8, 4));
  assert.equal(f.delivery.snapshot().inFlight, 3);
  for (const expectedSerial of [2, 3, 4]) {
    const before = f.sent.length;
    f.runImmediate();
    assert.equal(f.sent.length, before + 1);
    assert.equal(f.sent.at(-1)!.metadata.serial, expectedSerial);
    assert.equal(f.delivery.acknowledge(f.sent.at(-1)!.metadata), true);
  }
  assert.equal(f.immediates.size, 0);
  assert.equal(f.delivery.snapshot().inFlight, 0);
  assert.equal(f.delivery.snapshot().released, 4);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.failures, []);
});

function captureQueuedHandles(context: TestContext, source: Buffer): Buffer[] {
  const copies: Buffer[] = [];
  const originalFrom = Buffer.from;
  context.mock.method(Buffer, 'from', ((...args: unknown[]) => {
    const copy = Reflect.apply(originalFrom, Buffer, args) as Buffer;
    if (args[0] === source) copies.push(copy);
    return copy;
  }) as typeof Buffer.from);
  return copies;
}

for (const failure of ['stop', 'invalid frame', 'timeout', 'scheduler failure'] as const) {
  test(`yield ${failure} cancels pending work, erases handles and rejects late callbacks`, context => {
    const f = fixture(context, 'yield');
    const copies = captureQueuedHandles(context, f.handle);
    for (let slot = 0; slot < 3; slot++) f.delivery.deliver(f.frame({ slot, serial: slot + 1, timestamp: (slot + 1) * 1000 }), f.handle);
    assert.equal(copies.length, 3);
    assert.ok(copies.every(copy => copy.every(byte => byte === 1)));
    const late = f.allImmediates[0];
    if (failure === 'stop') f.delivery.stop();
    if (failure === 'invalid frame') f.delivery.deliver(f.frame({ serial: 4, timestamp: 4000 }), f.handle);
    if (failure === 'timeout') f.advance(1500);
    if (failure === 'scheduler failure') {
      f.options.scheduler!.setImmediate = () => { throw Error('schedule failure'); };
      f.runImmediate();
    }
    assert.equal(f.immediates.size, 0);
    assert.ok(copies.every(copy => copy.every(byte => byte === 0)));
    assert.equal(f.delivery.snapshot().inFlight, 0);
    assert.equal(f.timers.size, 0);
    const reads = f.reads.length, sends = f.sent.length;
    late.callback(); late.callback();
    f.allTimers.forEach(timer => timer.callback());
    assert.equal(f.reads.length, reads);
    assert.equal(f.sent.length, sends);
    assert.equal(f.credits.length, 0);
    assert.deepEqual(f.failures, failure === 'stop' ? [] : [failure === 'timeout' ? 'cpu_ack_timeout' : 'cpu_frame_failed']);
    if (failure !== 'scheduler failure') assert.equal(f.cancelledImmediates.length, 1);
  });
}

test('yield checks its original deadline before reading even if no timer has fired', context => {
  const f = fixture(context, 'yield');
  const copies = captureQueuedHandles(context, f.handle);
  f.delivery.deliver(f.frame(), f.handle);
  f.at(1500); f.runImmediate();
  assert.equal(f.reads.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.timers.size, 0);
  assert.ok(copies[0].every(byte => byte === 0));
  assert.deepEqual(f.failures, ['cpu_ack_timeout']);
});

test('yield retains the original deadline across queue, copy, import and final ack', context => {
  const f = fixture(context, 'yield');
  f.delivery.deliver(f.frame(), f.handle);
  f.at(1400);
  f.hooks.read = () => { f.at(1450); return new ArrayBuffer(12); };
  f.hooks.imported = () => { f.at(1499); return true; };
  f.runImmediate();
  assert.equal(f.sent.length, 1);
  f.at(1500);
  assert.equal(f.delivery.acknowledge(f.sent[0].metadata), false);
  assert.deepEqual(f.failures, ['cpu_ack_timeout']);
  assert.equal(f.credits.length, 0);
  assert.equal(f.timers.size, 0);
});

test('yield accepts a synchronous final ack and defers reentrant delivery until another turn', context => {
  const f = fixture(context, 'yield');
  f.hooks.send = metadata => {
    assert.equal(f.delivery.acknowledge(metadata), true);
    assert.equal(f.delivery.acknowledge(metadata), false);
  };
  f.hooks.released = metadata => {
    assert.equal(f.delivery.acknowledge(metadata), false);
    if (metadata.serial === 1) f.delivery.deliver(f.frame({ serial: 2, timestamp: 2000 }), f.handle);
    return true;
  };
  f.delivery.deliver(f.frame(), f.handle);
  f.runImmediate();
  assert.equal(f.sent.length, 1);
  assert.equal(f.credits.length, 1);
  assert.equal(f.immediates.size, 1);
  assert.equal(f.delivery.snapshot().inFlight, 1);
  // A duplicate old callback cannot steal the newly scheduled lease.
  f.allImmediates[0].callback();
  assert.equal(f.sent.length, 1);
  f.runImmediate();
  assert.equal(f.sent.length, 2);
  assert.equal(f.credits.length, 2);
  assert.equal(f.immediates.size, 0);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.failures, []);
});

for (const stage of ['read', 'imported', 'send'] as const) {
  test(`yield stop during ${stage} clears the remaining queue without reading another mapping`, context => {
    const f = fixture(context, 'yield');
    const copies = captureQueuedHandles(context, f.handle);
    for (let slot = 0; slot < 3; slot++) f.delivery.deliver(f.frame({ slot, serial: slot + 1, timestamp: (slot + 1) * 1000 }), f.handle);
    if (stage === 'read') f.hooks.read = () => { f.delivery.stop(); return new ArrayBuffer(12); };
    if (stage === 'imported') f.hooks.imported = () => { f.delivery.stop(); return true; };
    if (stage === 'send') f.hooks.send = () => f.delivery.stop();
    f.runImmediate();
    f.allImmediates.forEach(immediate => immediate.callback());
    assert.equal(f.reads.length, 1);
    assert.equal(f.sent.length, stage === 'send' ? 1 : 0);
    assert.equal(f.credits.length, 0);
    assert.equal(f.immediates.size, 0);
    assert.equal(f.timers.size, 0);
    assert.ok(copies.every(copy => copy.every(byte => byte === 0)));
    assert.deepEqual(f.failures, []);
  });
}

test('yield read failure clears every queued handle and schedules no later copy', context => {
  const f = fixture(context, 'yield');
  const copies = captureQueuedHandles(context, f.handle);
  for (let slot = 0; slot < 3; slot++) f.delivery.deliver(f.frame({ slot, serial: slot + 1, timestamp: (slot + 1) * 1000 }), f.handle);
  f.hooks.read = () => { throw Error('native read failure'); };
  f.runImmediate();
  assert.equal(f.reads.length, 1);
  assert.equal(f.sent.length, 0);
  assert.equal(f.immediates.size, 0);
  assert.equal(f.timers.size, 0);
  assert.ok(copies.every(copy => copy.every(byte => byte === 0)));
  assert.deepEqual(f.failures, ['cpu_frame_failed']);
});

test('three queued handles stay bounded when a synchronous ACK reentrantly reuses its slot', context => {
  const f = fixture(context, 'yield');
  const copies = captureQueuedHandles(context, f.handle);
  for (let slot = 0; slot < 3; slot++) f.delivery.deliver(f.frame({ slot, serial: slot + 1, timestamp: (slot + 1) * 1000 }), f.handle);
  f.hooks.send = metadata => { assert.equal(f.delivery.acknowledge(metadata), true); };
  f.hooks.released = metadata => {
    if (metadata.serial === 1) {
      assert.ok(copies[0].every(byte => byte === 0), 'wire bytes are retired before a synchronous ACK');
      f.delivery.deliver(f.frame({ serial: 4, timestamp: 4000 }), f.handle);
      assert.equal(copies.length, 4);
      assert.equal(copies.filter(copy => copy.some(byte => byte !== 0)).length, 3);
      assert.equal(f.delivery.snapshot().inFlight, 3);
    }
    return true;
  };
  for (let turn = 0; turn < 4; turn++) {
    f.runImmediate();
    assert.equal(f.sent.length, turn + 1);
    assert.ok(copies.filter(copy => copy.some(byte => byte !== 0)).length <= 3);
  }
  assert.equal(f.delivery.snapshot().released, 4);
  assert.ok(copies.every(copy => copy.every(byte => byte === 0)));
  assert.equal(f.timers.size, 0); assert.equal(f.immediates.size, 0);
  assert.deepEqual(f.failures, []);
});

test('yield validates the frozen snapshot when caller metadata accessors change during delivery', context => {
  const f = fixture(context, 'yield');
  let serialReads = 0;
  const metadata = { ...f.frame(), get serial() { return ++serialReads < 3 ? 1 : 0; } };
  f.delivery.deliver(metadata, f.handle);
  assert.equal(f.reads.length, 0); assert.equal(f.immediates.size, 0); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.failures, ['cpu_frame_failed']);
});

test('yield clock reentry cannot overwrite a newer queued lease during registration', context => {
  const f = fixture(context, 'yield');
  let reenter = true;
  const delivery = createNativeCpuFrameDelivery({ ...f.options, now() {
    if (reenter) {
      reenter = false;
      delivery.deliver(f.frame({ serial: 2, timestamp: 2000 }), f.handle);
    }
    return 0;
  } });
  context.after(() => delivery.stop());
  delivery.deliver(f.frame(), f.handle);
  f.allImmediates.forEach(immediate => immediate.callback());
  assert.equal(f.reads.length, 0); assert.equal(f.immediates.size, 0); assert.equal(f.timers.size, 0);
  assert.equal(delivery.snapshot().inFlight, 0);
  assert.deepEqual(f.failures, ['cpu_frame_failed']);
});

test('yield clock reentry during the pre-send deadline checks cannot send after stop', context => {
  const f = fixture(context, 'yield');
  let remainingClockReads = 0;
  const delivery = createNativeCpuFrameDelivery({ ...f.options, now() {
    if (remainingClockReads > 0 && --remainingClockReads === 0) delivery.stop();
    return 0;
  } });
  context.after(() => delivery.stop());
  f.hooks.imported = () => { remainingClockReads = 2; return true; };
  delivery.deliver(f.frame(), f.handle);
  f.runImmediate();
  assert.equal(f.reads.length, 1); assert.equal(f.imported.length, 1); assert.equal(f.sent.length, 0);
  assert.equal(f.immediates.size, 0); assert.equal(f.timers.size, 0);
  assert.equal(delivery.snapshot().stopped, true);
  assert.deepEqual(f.failures, []);
});
