import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeCpuBufferPipeline, type NativeCpuBufferPipelineOptions, type NativeCpuPipelineCounter } from '../electron/native-screen-cpu-buffer-pipeline';
import type { NativeCpuScreenFrame, NativeCpuFrameFailure } from '../electron/native-screen-cpu-delivery';

interface Timer { due: number; callback(): void; unref(): void }
interface Immediate { callback(): void }
function fixture(context: TestContext) {
  let time = 0;
  const timers = new Set<Timer>(), allTimers: Timer[] = [];
  const immediates = new Set<Immediate>(), allImmediates: Immediate[] = [];
  context.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay: number) => {
    const timer = { due: time + delay, callback, unref() {} };
    timers.add(timer); allTimers.push(timer); return timer;
  }) as unknown as typeof setTimeout);
  context.mock.method(globalThis, 'clearTimeout', ((timer: Timer) => timers.delete(timer)) as unknown as typeof clearTimeout);
  const events: string[] = [], failures: NativeCpuFrameFailure[] = [];
  const reads: { metadata: NativeCpuScreenFrame; handle: Buffer; target: ArrayBuffer }[] = [];
  const sent: { metadata: NativeCpuScreenFrame; data: ArrayBuffer; pixels: number[] }[] = [];
  const sources = new Map<number, { serial: number; handle: bigint; object: number }>();
  const cache = new Map<number, { handle: bigint; object: number }>();
  const handles: Buffer[] = [];
  const hooks = {
    read: (_metadata: NativeCpuScreenFrame, _target: ArrayBuffer) => {},
    release: (_metadata: NativeCpuScreenFrame, _disposition: 'copied' | 'discarded'): boolean => true,
    send: (_metadata: NativeCpuScreenFrame, _data: ArrayBuffer) => {},
    ack: (_metadata: NativeCpuScreenFrame): boolean => true,
    timing: (_stage: string) => {},
    counter: (_counter: NativeCpuPipelineCounter) => {},
    clock: () => {},
  };
  const options: NativeCpuBufferPipelineOptions = {
    requestId: 'request-1', sessionId: 'session-1', width: 4, height: 2, colorSpace: 'bt709-limited', fps: 120,
    now: () => { hooks.clock(); return time; },
    scheduler: {
      setImmediate(callback) { const value = { callback }; immediates.add(value); allImmediates.push(value); return value as any; },
      clearImmediate(value) { immediates.delete(value as unknown as Immediate); },
    },
    readFrame(handle, target, metadata) {
      events.push(`read:${metadata.serial}`); reads.push({ metadata, handle, target });
      assert.ok(Object.isFrozen(metadata));
      const source = sources.get(metadata.slot);
      assert.ok(source); assert.equal(source.serial, metadata.serial);
      assert.equal(handle.readBigUInt64LE(), source.handle);
      const previous = cache.get(metadata.slot);
      // Mirrors the addon's numeric-handle AND section-object identity contract.
      if (previous && (previous.handle !== source.handle || previous.object !== source.object)) throw Error('cached_frame_mismatch');
      cache.set(metadata.slot, { handle: source.handle, object: source.object });
      new Uint8Array(target).fill(metadata.serial);
      hooks.read(metadata, target);
    },
    releaseSource(metadata, disposition) {
      events.push(`${disposition}:${metadata.serial}`);
      assert.equal(sources.get(metadata.slot)?.serial, metadata.serial);
      sources.delete(metadata.slot); // The helper may issue a replacement before this callback returns.
      return hooks.release(metadata, disposition);
    },
    send(metadata, data) {
      events.push(`send:${metadata.serial}`);
      sent.push({ metadata, data, pixels: [...new Uint8Array(data)] }); hooks.send(metadata, data);
    },
    onFinalAck(metadata) { events.push(`ack:${metadata.serial}`); return hooks.ack(metadata); },
    onFailure(code) { events.push(code); failures.push(code); },
    onTiming(stage) { hooks.timing(stage); },
    onCounter(counter) { hooks.counter(counter); },
  };
  const pipeline = createNativeCpuBufferPipeline(options);
  context.after(() => pipeline.stop());
  const frame = (serial: number, slot = 0, patch: Partial<NativeCpuScreenFrame> = {}): NativeCpuScreenFrame => ({
    requestId: 'request-1', sessionId: 'session-1', slot, serial, timestamp: serial * 1000, width: 4, height: 2,
    refresh: false, pixelFormat: 'nv12', storage: 'cpu', colorSpace: 'bt709-limited', ...patch,
  });
  const issue = (serial: number, slot = 0, object = slot + 1, handleValue = BigInt(slot + 1)) => {
    assert.equal(sources.has(slot), false, 'fake helper cannot overwrite an uncredited section');
    sources.set(slot, { serial, object, handle: handleValue });
    const handle = Buffer.alloc(8); handle.writeBigUInt64LE(handleValue); handles.push(handle);
    const metadata = frame(serial, slot);
    pipeline.deliver(metadata, handle); handle.fill(0); return metadata;
  };
  return { pipeline, options, hooks, frame, issue, events, failures, reads, sent, sources, cache, handles,
    timers, allTimers, immediates, allImmediates,
    at(value: number) { time = value; },
    run() {
      const next = immediates.values().next().value; assert.ok(next, 'one scheduled turn must exist');
      immediates.delete(next); next.callback();
    },
    advance(ms: number) {
      const until = time + ms;
      while (true) {
        const next = [...timers].filter(value => value.due <= until).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        timers.delete(next); time = next.due; next.callback();
      }
      time = until;
    },
  };
}

test('copy ownership releases the native source before send and final ACK releases only its main AB', context => {
  const f = fixture(context); const original = f.issue(1);
  original.serial = 99;
  assert.equal(f.pipeline.snapshot().pendingFrames, 1); assert.equal(f.reads.length, 0);
  f.run();
  assert.deepEqual(f.events, ['read:1', 'copied:1', 'send:1']);
  assert.deepEqual(f.sent[0].pixels, Array(12).fill(1));
  assert.ok(f.reads[0].handle.every(byte => byte === 0));
  assert.equal(f.pipeline.snapshot().activeNativeLeases, 0);
  assert.equal(f.pipeline.snapshot().mainBuffersInUse, 1);
  assert.equal(f.pipeline.acknowledge(f.sent[0].metadata), true);
  assert.equal(f.pipeline.acknowledge(f.sent[0].metadata), false);
  assert.deepEqual(f.events, ['read:1', 'copied:1', 'send:1', 'ack:1']);
  const snapshot = f.pipeline.snapshot();
  assert.equal(snapshot.sourceCopied, 1); assert.equal(snapshot.sourceReleased, 1);
  assert.equal(snapshot.mainSent, 1); assert.equal(snapshot.finalAck, 1);
  snapshot.sourceCopied = 99;
  f.pipeline.stop(); assert.equal(f.pipeline.snapshot().sourceCopied, 1);
  assert.equal(f.pipeline.snapshot().allocatedBuffers, 0); assert.equal(f.timers.size, 0);
});

test('one helper slot can feed three distinct main buffers before any old final ACK arrives', context => {
  const f = fixture(context);
  for (let serial = 1; serial <= 3; serial++) { f.issue(serial); f.run(); }
  assert.equal(new Set(f.reads.map(value => value.target)).size, 3);
  assert.deepEqual(f.reads.map(value => value.metadata.slot), [0, 0, 0]);
  assert.deepEqual(f.sent.map(value => [...new Uint8Array(value.data)][0]), [1, 2, 3]);
  f.issue(4); assert.equal(f.immediates.size, 0);
  assert.equal(f.pipeline.snapshot().mainBuffersInUse, 3); assert.equal(f.pipeline.snapshot().pendingFrames, 1);
  assert.equal(f.pipeline.acknowledge({ ...f.sent[1].metadata, slot: 1 }), false);
  assert.equal(f.pipeline.acknowledge(f.sent[1].metadata), true); f.run();
  assert.equal(f.reads[3].target, f.reads[1].target);
  assert.equal(new Uint8Array(f.sent[0].data)[0], 1);
  assert.equal(f.pipeline.acknowledge(f.sent[1].metadata), false);
  assert.equal(f.pipeline.snapshot().mainBuffersInUse, 3);
  assert.equal(f.pipeline.acknowledge({ ...f.sent[3].metadata, sessionId: 'old-session' }), false);
  for (const index of [0, 2, 3]) assert.equal(f.pipeline.acknowledge(f.sent[index].metadata), true);
  assert.equal(f.pipeline.snapshot().mainBuffersInUse, 0); assert.equal(f.pipeline.snapshot().allocatedBuffers, 3);
  assert.equal(f.pipeline.snapshot().sourceReleased, 4); assert.equal(f.pipeline.snapshot().finalAck, 4);
  assert.equal(f.timers.size, 0); assert.deepEqual(f.failures, []);
});

test('full main pool retains one latest source and independently expires it after two local frame periods', context => {
  const f = fixture(context);
  for (let serial = 1; serial <= 3; serial++) { f.issue(serial); f.run(); }
  f.issue(4, 0); f.issue(5, 1);
  assert.equal(f.pipeline.snapshot().sourceDiscarded, 1); assert.equal(f.pipeline.snapshot().pendingSuperseded, 1);
  assert.equal(f.pipeline.snapshot().activeNativeLeases, 1); assert.equal(f.pipeline.snapshot().pendingFrames, 1);
  assert.equal(f.pipeline.snapshot().mainBuffersInUse, 3); assert.equal(f.immediates.size, 0);
  f.advance(16); assert.equal(f.pipeline.snapshot().sourceDiscarded, 1);
  f.advance(1); assert.equal(f.pipeline.snapshot().sourceDiscarded, 2);
  assert.equal(f.pipeline.snapshot().pendingExpired, 1); assert.equal(f.pipeline.snapshot().pendingFrames, 0);
  assert.equal(f.reads.length, 3); assert.equal(f.pipeline.snapshot().sourceCopied, 3);
  assert.equal(f.pipeline.snapshot().sourceReleased, 5); assert.equal(f.pipeline.snapshot().mainSent, 3);
  for (const immediate of f.allImmediates) immediate.callback();
  assert.equal(f.reads.length, 3); assert.deepEqual(f.failures, []);
});

test('an overdue pending frame is never read even when its timer has not dispatched', context => {
  const f = fixture(context); f.issue(1); f.at(17); f.run();
  assert.equal(f.reads.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.pipeline.snapshot().pendingExpired, 1); assert.equal(f.pipeline.snapshot().sourceReleased, 1);
  assert.equal(f.timers.size, 0); assert.deepEqual(f.failures, []);
});

test('a pending expiry delayed past the total watchdog deadline cannot bypass session failure', context => {
  const f = fixture(context); f.issue(1); f.at(1500); f.allTimers[1].callback();
  assert.equal(f.reads.length, 0); assert.equal(f.pipeline.snapshot().sourceReleased, 0);
  assert.equal(f.pipeline.snapshot().pendingFrames, 0); assert.equal(f.timers.size, 0);
  f.allTimers.forEach(value => value.callback());
  assert.deepEqual(f.failures, ['cpu_ack_timeout']);
});

test('superseding an overdue pending source cannot clear its undispatched total watchdog', context => {
  const f = fixture(context); f.issue(1); f.at(1500); f.issue(2, 1);
  assert.equal(f.reads.length, 0); assert.equal(f.pipeline.snapshot().sourceDiscarded, 0);
  assert.equal(f.pipeline.snapshot().sourceReleased, 0); assert.equal(f.pipeline.snapshot().activeNativeLeases, 0);
  assert.equal(f.timers.size, 0); assert.equal(f.immediates.size, 0);
  assert.deepEqual(f.failures, ['cpu_ack_timeout']);
});

test('a drain clock crossing 1500ms between deadline and freshness checks cannot become a normal discard', context => {
  const f = fixture(context); f.issue(1); let clockReads = 0;
  f.hooks.clock = () => { f.at(++clockReads === 1 ? 1499 : 1500); };
  f.run();
  assert.equal(f.reads.length, 0); assert.equal(f.pipeline.snapshot().sourceDiscarded, 0);
  assert.equal(f.pipeline.snapshot().sourceReleased, 0); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.failures, ['cpu_ack_timeout']);
});

test('pending timer rechecks identity after a clock callback replaces its source', context => {
  const f = fixture(context); f.issue(1); const old = f.allTimers[1];
  f.at(17); f.hooks.clock = () => { f.hooks.clock = () => {}; f.issue(2, 1); };
  old.callback();
  assert.equal(f.pipeline.snapshot().pendingFrames, 1); assert.equal(f.pipeline.snapshot().pendingExpired, 0);
  f.run(); assert.equal(f.sent[0].metadata.serial, 2); assert.equal(f.reads.length, 1);
  assert.deepEqual(f.failures, []);
});

test('copy, commands, send and ACK share the original 1500ms deadline', context => {
  const f = fixture(context); f.issue(1); f.at(10);
  f.hooks.read = () => f.at(1400); f.hooks.release = () => { f.at(1499); return true; };
  f.run(); assert.equal(f.sent.length, 1);
  f.at(1500); assert.equal(f.pipeline.acknowledge(f.sent[0].metadata), false);
  assert.deepEqual(f.failures, ['cpu_ack_timeout']); assert.equal(f.pipeline.snapshot().finalAck, 0);
  assert.equal(f.timers.size, 0); assert.equal(f.pipeline.snapshot().sourceReleased, 1);
});

test('source release crossing the total deadline cannot send a late frame', context => {
  const f = fixture(context); f.issue(1); f.hooks.release = () => { f.at(1500); return true; };
  f.run(); assert.equal(f.reads.length, 1); assert.equal(f.sent.length, 0);
  assert.deepEqual(f.failures, ['cpu_ack_timeout']); assert.equal(f.pipeline.snapshot().sourceReleased, 1);
});

for (const failure of ['read throw', 'detached target', 'release false', 'release throw', 'send throw'] as const) {
  test(`${failure} retires both pools without false publication or fabricated final ACK`, context => {
    const f = fixture(context); f.issue(1);
    if (failure === 'read throw') f.hooks.read = () => { throw Error('private read failure'); };
    if (failure === 'detached target') f.hooks.read = (_metadata, data) => { structuredClone(data, { transfer: [data] }); };
    if (failure === 'release false') f.hooks.release = () => false;
    if (failure === 'release throw') f.hooks.release = () => { throw Error('private source failure'); };
    if (failure === 'send throw') f.hooks.send = () => { throw Error('private send failure'); };
    f.run();
    const snapshot = f.pipeline.snapshot();
    assert.equal(snapshot.stopped, true); assert.equal(snapshot.activeNativeLeases, 0);
    assert.equal(snapshot.mainBuffersInUse, 0); assert.equal(snapshot.allocatedBuffers, 0);
    assert.equal(snapshot.mainSent, 0); assert.equal(snapshot.finalAck, 0);
    assert.equal(snapshot.sourceReleased, failure === 'send throw' ? 1 : 0);
    assert.ok(f.reads[0].handle.every(byte => byte === 0));
    f.allImmediates.forEach(value => value.callback()); f.allTimers.forEach(value => value.callback());
    assert.equal(f.reads.length, 1); assert.equal(f.timers.size, 0);
    assert.deepEqual(f.failures, ['cpu_frame_failed']);
  });
}

test('discard source command failure retires without reading the pending candidate', context => {
  const f = fixture(context); f.issue(1); f.hooks.release = () => false; f.issue(2, 1);
  assert.equal(f.pipeline.snapshot().sourceDiscarded, 1); assert.equal(f.pipeline.snapshot().sourceCopied, 0);
  assert.equal(f.pipeline.snapshot().sourceReleased, 0); assert.equal(f.immediates.size, 0);
  f.allImmediates.forEach(value => value.callback());
  assert.equal(f.reads.length, 0); assert.deepEqual(f.failures, ['cpu_frame_failed']);
});

test('cached native slot rejects numeric handle reuse for a different section object before source credit', context => {
  const f = fixture(context); f.issue(1); f.run();
  f.issue(2, 0, 999, 1n); f.run();
  assert.equal(f.pipeline.snapshot().sourceCopied, 1); assert.equal(f.pipeline.snapshot().sourceReleased, 1);
  assert.equal(f.pipeline.snapshot().mainSent, 1); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.failures, ['cpu_frame_failed']);
});

test('synchronous ACK and reentrant slot reuse cannot overwrite the AB before outer send returns', context => {
  const f = fixture(context); let outerData: ArrayBuffer | undefined;
  f.hooks.send = (metadata, data) => {
    if (metadata.serial !== 1) return;
    outerData = data;
    assert.equal(f.pipeline.acknowledge(metadata), true);
    f.issue(2);
    assert.equal(f.reads.length, 1); assert.equal(new Uint8Array(data)[0], 1);
    assert.equal(f.immediates.size, 0);
  };
  f.issue(1); f.run(); assert.equal(f.immediates.size, 1);
  const late = f.allImmediates[0]; late.callback(); assert.equal(f.reads.length, 1);
  f.run(); assert.equal(f.reads[1].target, outerData); assert.equal(f.sent[1].pixels[0], 2);
  assert.equal(f.pipeline.acknowledge(f.sent[0].metadata), false); assert.equal(f.pipeline.snapshot().mainBuffersInUse, 1);
  assert.deepEqual(f.failures, []);
});

for (const stage of ['pending', 'read', 'source release', 'import timing', 'send', 'final ACK', 'copy counter', 'clock before read', 'clock after copy'] as const) {
  test(`stop during ${stage} invalidates all queues and every late callback`, context => {
    const f = fixture(context); f.issue(1);
    if (stage === 'pending') f.pipeline.stop();
    if (stage === 'read') f.hooks.read = () => f.pipeline.stop();
    if (stage === 'source release') f.hooks.release = () => { f.pipeline.stop(); return true; };
    if (stage === 'import timing') f.hooks.timing = value => { if (value === 'import') f.pipeline.stop(); };
    if (stage === 'send') f.hooks.send = () => f.pipeline.stop();
    if (stage === 'final ACK') f.hooks.ack = () => { f.pipeline.stop(); return true; };
    if (stage === 'copy counter') f.hooks.counter = value => { if (value === 'sourceCopied') f.pipeline.stop(); };
    if (stage === 'clock before read') f.hooks.clock = () => f.pipeline.stop();
    if (stage === 'clock after copy') f.hooks.read = () => { f.hooks.clock = () => f.pipeline.stop(); };
    if (f.immediates.size) f.run();
    if (stage === 'final ACK') assert.equal(f.pipeline.acknowledge(f.sent[0].metadata), true);
    const reads = f.reads.length, sends = f.sent.length;
    f.allImmediates.forEach(value => value.callback()); f.allTimers.forEach(value => value.callback());
    f.pipeline.stop(); assert.equal(f.pipeline.acknowledge(f.frame(1)), false);
    assert.equal(f.reads.length, reads); assert.equal(f.sent.length, sends);
    assert.equal(f.pipeline.snapshot().stopped, true); assert.equal(f.pipeline.snapshot().activeNativeLeases, 0);
    assert.equal(f.pipeline.snapshot().mainBuffersInUse, 0); assert.equal(f.pipeline.snapshot().pendingFrames, 0);
    assert.equal(f.timers.size, 0); assert.equal(f.immediates.size, 0);
    assert.ok(f.reads.every(value => value.handle.every(byte => byte === 0))); assert.deepEqual(f.failures, []);
  });
}

test('clock teardown during final ACK cannot credit a main buffer', context => {
  const f = fixture(context); f.issue(1); f.run();
  f.hooks.clock = () => f.pipeline.stop();
  assert.equal(f.pipeline.acknowledge(f.sent[0].metadata), false);
  assert.equal(f.pipeline.snapshot().finalAck, 0); assert.equal(f.pipeline.snapshot().sourceReleased, 1);
  assert.equal(f.timers.size, 0); assert.deepEqual(f.failures, []);
});

test('late pending and ACK timers cannot expire a newer serial reusing the native slot and main AB', context => {
  const f = fixture(context); f.issue(1); f.run();
  const oldTimers = [...f.allTimers]; assert.equal(f.pipeline.acknowledge(f.sent[0].metadata), true);
  f.issue(2); f.run(); oldTimers.forEach(value => value.callback());
  assert.equal(f.pipeline.snapshot().mainBuffersInUse, 1); assert.equal(f.pipeline.snapshot().finalAck, 1);
  assert.equal(f.pipeline.acknowledge(f.sent[1].metadata), true); assert.deepEqual(f.failures, []);
});

test('scheduler failure and throwing cancellation never leave native read capabilities alive', context => {
  const f = fixture(context);
  f.options.scheduler!.setImmediate = () => { throw Error('scheduler failed'); };
  f.issue(1);
  assert.equal(f.pipeline.snapshot().stopped, true); assert.equal(f.timers.size, 0);
  assert.equal(f.pipeline.snapshot().activeNativeLeases, 0); assert.deepEqual(f.failures, ['cpu_frame_failed']);
  const second = fixture(context); second.issue(1);
  second.options.scheduler!.clearImmediate = () => { throw Error('cancel failed'); };
  second.pipeline.stop(); second.allImmediates.forEach(value => value.callback());
  assert.equal(second.reads.length, 0); assert.equal(second.pipeline.snapshot().pendingFrames, 0);
});

test('invalid contracts and malformed source handles fail without native reads', context => {
  const f = fixture(context);
  for (const patch of [{ fps: 0 }, { colorSpace: 'bad' }, { requestId: '' }, { sessionId: '' }])
    assert.throws(() => createNativeCpuBufferPipeline({ ...f.options, ...patch } as any), TypeError);
  for (const patch of [{ width: 3 }, { height: Infinity }, { width: 4096, height: 2732 }])
    assert.throws(() => createNativeCpuBufferPipeline({ ...f.options, ...patch }), RangeError);
  f.pipeline.deliver(f.frame(1), Buffer.alloc(8));
  assert.equal(f.reads.length, 0); assert.equal(f.timers.size, 0); assert.deepEqual(f.failures, ['cpu_frame_failed']);
});

test('source release can immediately issue a newer serial in the same native slot without disturbing the old main lease', context => {
  const f = fixture(context);
  f.hooks.release = metadata => {
    assert.ok(f.reads.at(-1)!.handle.every(byte => byte === 0));
    if (metadata.serial === 1) {
      assert.equal(f.pipeline.snapshot().activeNativeLeases, 0);
      assert.equal(f.pipeline.snapshot().mainBuffersInUse, 1);
      assert.equal(f.pipeline.acknowledge(metadata), false);
      f.issue(2);
      assert.equal(f.reads.length, 1);
    }
    return true;
  };
  f.issue(1); f.run(); assert.equal(f.sent[0].metadata.serial, 1);
  f.run(); assert.equal(f.sent[1].metadata.serial, 2);
  assert.notEqual(f.sent[0].data, f.sent[1].data);
  assert.equal(new Uint8Array(f.sent[0].data)[0], 1);
  assert.equal(f.pipeline.snapshot().mainBuffersInUse, 2); assert.deepEqual(f.failures, []);
});

test('a clock reentry during source registration cannot overwrite the newer native lease', context => {
  const f = fixture(context);
  f.hooks.clock = () => { f.hooks.clock = () => {}; f.issue(2, 1); };
  f.issue(1, 0); f.allImmediates.forEach(value => value.callback());
  assert.equal(f.reads.length, 0); assert.equal(f.pipeline.snapshot().activeNativeLeases, 0);
  assert.equal(f.timers.size, 0); assert.equal(f.immediates.size, 0);
  assert.deepEqual(f.failures, ['cpu_frame_failed']);
});

test('a source-release clock teardown cannot send copied bytes after stop', context => {
  const f = fixture(context);
  f.hooks.release = () => { f.hooks.clock = () => f.pipeline.stop(); return true; };
  f.issue(1); f.run();
  assert.equal(f.pipeline.snapshot().sourceReleased, 1); assert.equal(f.sent.length, 0);
  assert.equal(f.pipeline.snapshot().mainBuffersInUse, 0); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.failures, []);
});

test('a scheduler that reentrantly stops before returning its token is still cancelled', context => {
  const f = fixture(context); const schedule = f.options.scheduler!.setImmediate;
  f.options.scheduler!.setImmediate = callback => {
    const token = schedule(callback); f.pipeline.stop(); return token;
  };
  f.issue(1); f.allImmediates.forEach(value => value.callback());
  assert.equal(f.reads.length, 0); assert.equal(f.immediates.size, 0); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.failures, []);
});

test('unknown ACK accessors cannot free an old or newer main lease after teardown', context => {
  const f = fixture(context); f.issue(1); f.run(); f.issue(2); f.run();
  for (const value of [null, [], { ...f.sent[0].metadata, serial: 5 }, { ...f.sent[0].metadata, timestamp: 999 },
    { ...f.sent[0].metadata, refresh: true }, { ...f.sent[0].metadata, colorSpace: 'bt601-limited' },
    { get serial() { throw Error('unknown getter'); } }]) assert.equal(f.pipeline.acknowledge(value), false);
  assert.equal(f.pipeline.snapshot().mainBuffersInUse, 2);
  const ack = { ...f.sent[0].metadata, get serial() { f.pipeline.stop(); return 1; } };
  assert.equal(f.pipeline.acknowledge(ack), false);
  assert.equal(f.pipeline.snapshot().finalAck, 0); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.failures, []);
});

for (const [label, patch] of [
  ['session', { sessionId: 'old' }], ['slot', { slot: 3 }], ['serial', { serial: 0 }], ['timestamp', { timestamp: Infinity }],
  ['geometry', { width: 6 }], ['storage', { storage: 'gpu' }], ['format', { pixelFormat: 'bgra' }],
  ['color', { colorSpace: 'bt601-limited' }], ['refresh', { refresh: 1 }],
] as const) {
  test(`copy ownership rejects changed ${label} before retaining a native handle`, context => {
    const f = fixture(context);
    f.pipeline.deliver(f.frame(1, 0, patch as any), Buffer.alloc(8, 1));
    assert.equal(f.reads.length, 0); assert.equal(f.pipeline.snapshot().activeNativeLeases, 0);
    assert.equal(f.timers.size, 0); assert.equal(f.immediates.size, 0);
    assert.deepEqual(f.failures, ['cpu_frame_failed']);
  });
}

test('sustained deterministic backpressure keeps both pools bounded and never overwrites unacknowledged pixels', context => {
  const f = fixture(context); const acknowledged = new Set<number>();
  for (let serial = 1; serial <= 60; serial++) {
    f.issue(serial, serial % 3);
    if (f.immediates.size) f.run();
    if (serial % 3 === 0) {
      const oldest = f.sent.find(value => !acknowledged.has(value.metadata.serial));
      if (oldest) { assert.equal(f.pipeline.acknowledge(oldest.metadata), true); acknowledged.add(oldest.metadata.serial); }
    }
    const snapshot = f.pipeline.snapshot();
    assert.ok(snapshot.activeNativeLeases <= 3); assert.ok(snapshot.mainBuffersInUse <= 3);
    assert.ok(snapshot.allocatedBuffers <= 3); assert.ok(snapshot.pendingFrames <= 1);
    for (const sent of f.sent.filter(value => !acknowledged.has(value.metadata.serial)))
      assert.equal(new Uint8Array(sent.data)[0], sent.metadata.serial);
    f.advance(8);
  }
  assert.ok(f.pipeline.snapshot().sourceDiscarded > 0);
  f.pipeline.stop(); f.allImmediates.forEach(value => value.callback());
  assert.equal(f.timers.size, 0); assert.equal(f.pipeline.snapshot().allocatedBuffers, 0);
  assert.deepEqual(f.failures, []);
});
