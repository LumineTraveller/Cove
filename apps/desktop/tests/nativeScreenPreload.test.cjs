const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync(require.resolve('../electron/preload.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
function bridge(enabled = true, options = {}) {
  const api = {}, ipc = new EventEmitter(), calls = [], sent = [], events = [], cpuFrames = [], timers = new Map(), timerDelays = new Map();
  let id = 0, receiver;
  ipc.invoke = async (...args) => { calls.push(args); events.push(['invoke', ...args]); return true; };
  ipc.send = (...args) => { sent.push(args); events.push(['send', ...args]); options.onSend?.(...args); };
  const VideoFrame = Object.hasOwn(options, 'VideoFrame') ? options.VideoFrame : class {
    constructor(data, init) {
      this.data = data; this.init = init; this.closed = 0;
      cpuFrames.push(this); events.push(['construct', this]);
    }
    close() { this.closed++; events.push(['close', this]); }
  };
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { api[name] = value; } },
    ipcRenderer: ipc, sharedTexture: options.sharedTexture === false ? {} : { setSharedTextureReceiver: callback => { receiver = callback; } } };
  vm.runInNewContext(source, { require: name => { assert.equal(name, 'electron'); return electron; }, exports: {},
    process: { platform: options.platform ?? 'win32', env: {}, versions: options.versions ?? { electron: '44.0.0' }, argv: [
      ...(enabled ? ['--cove-native-gpu-capture=1'] : []), ...(options.argv ?? []),
      ...(options.cpuFrameTiming ? ['--cove-native-cpu-frame-timing=1'] : []),
    ] },
    setTimeout: (callback, delay) => { timers.set(++id, callback); timerDelays.set(id, delay); return id; },
    clearTimeout: key => { timers.delete(key); timerDelays.delete(key); },
    console, Uint8Array, Buffer, VideoFrame, performance: options.performance,
    ...(options.Promise ? { Promise: options.Promise } : {}) });
  return { api: api.coveNativeScreen, ipc, calls, sent, events, cpuFrames, timers, timerDelays, receive: (...args) => receiver(...args),
    receiveCpu: (...args) => ipc.listeners('cove:native-screen:cpu-frame')[0]({}, ...args),
    hasReceiver: () => Boolean(receiver), hasCpuReceiver: () => ipc.listenerCount('cove:native-screen:cpu-frame') > 0 };
}
const metadata = { requestId: 'native_request_1', sessionId: 'session-1234', slot: 0, serial: 1,
  width: 64, height: 64, timestamp: 1000, refresh: false };
const cpuMetadata = { ...metadata, storage: 'cpu', pixelFormat: 'nv12', colorSpace: 'bt709-limited' };
const cpuBytes = () => new ArrayBuffer(cpuMetadata.width * cpuMetadata.height * 3 / 2);
function texture() {
  const state = { frames: 0, closed: 0, released: 0 };
  return { state, importedSharedTexture: { getVideoFrame() { state.frames++; return { close() { state.closed++; } }; },
    release() { state.released++; } } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

test('Canvas preference requires exact flag, qualified runtime and native support', () => {
  assert.equal(bridge(true, { argv: ['--cove-native-frame-sink=canvas'] }).api.preferredFrameSink, 'canvas');
  for (const [enabled, options] of [[true, {}], [false, { argv: ['--cove-native-frame-sink=canvas'] }],
    [true, { argv: ['--cove-native-frame-sink=canvas-extra'] }],
    [true, { argv: ['--cove-native-frame-sink=canvas'], versions: { electron: '43.0.0' } }],
    [true, { argv: ['--cove-native-frame-sink=canvas'], platform: 'linux' }],
    [true, { argv: ['--cove-native-frame-sink=canvas'], sharedTexture: false }]]) {
    assert.equal(bridge(enabled, options).api.preferredFrameSink, undefined);
  }
});

test('Worker preference requires its exact flag, qualified runtime and native support', () => {
  assert.equal(bridge(true, { argv: ['--cove-native-frame-sink=worker'] }).api.preferredFrameSink, 'worker');
  for (const [enabled, options] of [[true, {}], [false, { argv: ['--cove-native-frame-sink=worker'] }],
    [true, { argv: ['--cove-native-frame-sink=worker-extra'] }],
    [true, { argv: ['--cove-native-frame-sink=worker'], versions: { electron: '43.0.0' } }],
    [true, { argv: ['--cove-native-frame-sink=worker'], platform: 'linux' }],
    [true, { argv: ['--cove-native-frame-sink=worker'], sharedTexture: false }]]) {
    assert.equal(bridge(enabled, options).api.preferredFrameSink, undefined);
  }
});

test('CPU timing requires the exact opt-in flag and native support, with no default clock reads', async () => {
  for (const [enabled, options] of [[true, {}], [true, { argv: ['--cove-native-cpu-frame-timing=0'] }],
    [true, { argv: ['--cove-native-cpu-frame-timing=1-extra'] }], [false, { cpuFrameTiming: true }],
    [true, { cpuFrameTiming: true, platform: 'linux' }], [true, { cpuFrameTiming: true, sharedTexture: false }]]) {
    let reads = 0;
    const b = bridge(enabled, { ...options, performance: { now() { reads++; throw Error('disabled_clock_read'); } } });
    assert.equal(b.api.getCpuFrameTiming(), null);
    if (b.hasCpuReceiver()) {
      b.api.onFrame(metadata.requestId, async () => {});
      await b.receiveCpu(cpuMetadata, cpuBytes());
      assert.equal(b.cpuFrames[0].closed, 1); assert.equal(b.sent.length, 1); assert.equal(b.calls.length, 0);
    }
    assert.equal(b.api.getCpuFrameTiming(), null); assert.equal(reads, 0);
  }
});

test('CPU timing measures construction, awaited listener, close and validated handler including final ACK', async () => {
  let now = 0, finish, frame;
  const b = bridge(true, { cpuFrameTiming: true, performance: { now: () => now },
    VideoFrame: class {
      constructor() { now += 0.25; this.closed = 0; frame = this; }
      close() { now += 1.5; this.closed++; }
    }, onSend: () => { now += 3; } });
  b.api.onFrame(metadata.requestId, async () => {
    await new Promise(resolve => { finish = () => { now += 0.75; resolve(); }; });
  });
  const completed = b.receiveCpu(cpuMetadata, cpuBytes()); await flush();
  const pending = b.api.getCpuFrameTiming();
  assert.equal(pending.stages.construct.count, 1); assert.equal(pending.stages.listener.count, 0);
  assert.equal(pending.stages.close.count, 0); assert.equal(pending.stages.handler.count, 0);
  assert.equal(frame.closed, 0); assert.equal(b.sent.length, 0);
  finish(); await completed;
  assert.deepEqual(plain(b.api.getCpuFrameTiming()), {
    bucketUpperBoundsMs: [0.5, 1, 2, 4, 8, 16, null],
    stages: {
      construct: { count: 1, totalMs: 0.25, maxMs: 0.25, buckets: [1, 0, 0, 0, 0, 0, 0] },
      listener: { count: 1, totalMs: 0.75, maxMs: 0.75, buckets: [0, 1, 0, 0, 0, 0, 0] },
      close: { count: 1, totalMs: 1.5, maxMs: 1.5, buckets: [0, 0, 1, 0, 0, 0, 0] },
      handler: { count: 1, totalMs: 5.5, maxMs: 5.5, buckets: [0, 0, 0, 0, 1, 0, 0] },
    },
  });
  assert.equal(frame.closed, 1); assert.deepEqual(b.calls, []);
  assert.deepEqual(b.sent, [['cove:native-screen:cpu-frame-done', cpuMetadata]]);
});

test('CPU timing uses all seven fixed buckets with exclusive bounds in every stage', async () => {
  const durations = [0.25, 0.5, 1, 2, 4, 8, 16];
  for (const stage of ['construct', 'listener', 'close', 'handler']) {
    let now = 0, duration = 0;
    const b = bridge(true, { cpuFrameTiming: true, performance: { now: () => now },
      VideoFrame: class {
        constructor() { if (stage === 'construct') now += duration; }
        close() { if (stage === 'close') now += duration; }
      }, onSend: () => { if (stage === 'handler') now += duration; } });
    if (stage !== 'handler') b.api.onFrame(metadata.requestId, async () => { if (stage === 'listener') now += duration; });
    for (const [index, elapsed] of durations.entries()) {
      duration = elapsed;
      await b.receiveCpu({ ...cpuMetadata, serial: index + 1 }, cpuBytes());
    }
    assert.deepEqual(plain(b.api.getCpuFrameTiming().stages[stage]),
      { count: 7, totalMs: 31.75, maxMs: 16, buckets: [1, 1, 1, 1, 1, 1, 1] });
    assert.equal(b.sent.length, 7); assert.deepEqual(b.calls, []);
  }
});

test('CPU timing snapshots are detached, deeply read-only and limited to aggregate numbers', async () => {
  let now = 0;
  const b = bridge(true, { cpuFrameTiming: true, performance: { now: () => now++ } });
  const initial = b.api.getCpuFrameTiming();
  b.api.onFrame(metadata.requestId, async () => {});
  await b.receiveCpu(cpuMetadata, cpuBytes());
  const snapshot = b.api.getCpuFrameTiming(), clone = b.api.getCpuFrameTiming();
  assert.deepEqual(Object.keys(snapshot).sort(), ['bucketUpperBoundsMs', 'stages']);
  assert.deepEqual(Object.keys(snapshot.stages).sort(), ['close', 'construct', 'handler', 'listener']);
  assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.bucketUpperBoundsMs));
  assert.ok(Object.isFrozen(snapshot.stages));
  for (const [stage, aggregate] of Object.entries(snapshot.stages)) {
    assert.deepEqual(Object.keys(aggregate).sort(), ['buckets', 'count', 'maxMs', 'totalMs']);
    assert.ok(Object.isFrozen(aggregate)); assert.ok(Object.isFrozen(aggregate.buckets));
    assert.equal(Reflect.set(aggregate, 'count', 999), false);
    assert.equal(Reflect.set(aggregate.buckets, '0', 999), false);
    assert.notEqual(aggregate, clone.stages[stage]); assert.notEqual(aggregate.buckets, clone.stages[stage].buckets);
    assert.equal(initial.stages[stage].count, 0); assert.equal(aggregate.count, 1);
    assert.ok(Object.values(aggregate).every(value => Array.isArray(value) || typeof value === 'number'));
  }
  assert.notEqual(snapshot, clone); assert.notEqual(snapshot.stages, clone.stages);
  assert.equal(JSON.stringify(snapshot).includes(cpuMetadata.requestId), false);
  assert.equal(JSON.stringify(snapshot).includes(cpuMetadata.sessionId), false);
  await b.receiveCpu({ ...cpuMetadata, serial: 2 }, cpuBytes());
  assert.equal(snapshot.stages.handler.count, 1); assert.equal(b.api.getCpuFrameTiming().stages.handler.count, 2);
});

test('CPU timing excludes invalid metadata and counts the handler for invalid bytes or an absent listener', async () => {
  let reads = 0;
  const b = bridge(true, { cpuFrameTiming: true, performance: { now: () => reads++ } });
  await b.receiveCpu({ ...cpuMetadata, width: 63 }, cpuBytes());
  assert.equal(reads, 0); assert.equal(b.sent.length, 0);
  assert.equal(b.api.getCpuFrameTiming().stages.handler.count, 0);
  await b.receiveCpu(cpuMetadata, new ArrayBuffer(3));
  await b.receiveCpu({ ...cpuMetadata, serial: 2 }, cpuBytes());
  const snapshot = b.api.getCpuFrameTiming();
  assert.equal(snapshot.stages.handler.count, 2);
  for (const stage of ['construct', 'listener', 'close']) assert.equal(snapshot.stages[stage].count, 0);
  assert.equal(b.sent.length, 2);
  assert.deepEqual(b.calls, [
    ['cove:native-screen:stop', metadata.requestId, 'receiver_failed'],
    ['cove:native-screen:stop', metadata.requestId, 'receiver_failed'],
  ]);
});

test('GPU snapshot preference requires exact opt-in and the qualified native bridge', () => {
  const flag = '--cove-native-frame-sink=gpu-snapshot';
  assert.equal(bridge(true, { argv: [flag] }).api.preferredFrameSink, 'gpu-snapshot');
  for (const [enabled, options] of [[true, {}], [false, { argv: [flag] }],
    [true, { argv: [flag + '-extra'] }],
    [true, { argv: [flag], versions: { electron: '43.0.0' } }],
    [true, { argv: [flag], platform: 'linux' }],
    [true, { argv: [flag], sharedTexture: false }]])
    assert.equal(bridge(enabled, options).api.preferredFrameSink, undefined);
});

test('CPU timing records attempted stages when construction, listener or close throws and preserves stop/ACK order', async () => {
  for (const failure of ['construct', 'listener', 'close', 'listener-and-close']) {
    let now = 0, closes = 0;
    const actions = [];
    const b = bridge(true, { cpuFrameTiming: true, performance: { now: () => now++ },
      VideoFrame: class {
        constructor() { actions.push('construct'); if (failure === 'construct') throw Error('construct_failure'); }
        close() { closes++; actions.push('close'); if (failure.includes('close')) throw Error('close_failure'); }
      }, onSend: () => actions.push('ack') });
    b.api.onFrame(metadata.requestId, async () => {
      actions.push('listener');
      if (failure.includes('listener')) throw Error('listener_failure');
    });
    await b.receiveCpu(cpuMetadata, cpuBytes());
    const snapshot = b.api.getCpuFrameTiming();
    assert.equal(snapshot.stages.construct.count, 1); assert.equal(snapshot.stages.handler.count, 1);
    assert.equal(snapshot.stages.listener.count, failure === 'construct' ? 0 : 1);
    assert.equal(snapshot.stages.close.count, failure === 'construct' ? 0 : 1);
    assert.equal(closes, failure === 'construct' ? 0 : 1);
    assert.deepEqual(actions, failure === 'construct' ? ['construct', 'ack'] : ['construct', 'listener', 'close', 'ack']);
    assert.deepEqual(b.events.map(event => event[0]), ['invoke', 'send']);
    assert.deepEqual(b.calls, [['cove:native-screen:stop', metadata.requestId, 'receiver_failed']]);
    assert.deepEqual(b.sent, [['cove:native-screen:cpu-frame-done', cpuMetadata]]);
  }
});

test('CPU timing clock failures and invalid samples cannot change cleanup or final ACK', async () => {
  for (const read of [() => { throw Error('clock_failure'); }, () => NaN, () => Infinity, (() => {
    let now = 100; return () => now--;
  })()]) {
    const b = bridge(true, { cpuFrameTiming: true, performance: { now: read } });
    b.api.onFrame(metadata.requestId, async () => { throw Error('listener_failure'); });
    await b.receiveCpu(cpuMetadata, cpuBytes());
    assert.equal(b.cpuFrames[0].closed, 1);
    assert.deepEqual(b.events.map(event => event[0]), ['construct', 'invoke', 'close', 'send']);
    assert.deepEqual(b.calls, [['cove:native-screen:stop', metadata.requestId, 'receiver_failed']]);
    assert.deepEqual(b.sent, [['cove:native-screen:cpu-frame-done', cpuMetadata]]);
    for (const aggregate of Object.values(b.api.getCpuFrameTiming().stages)) assert.equal(aggregate.count, 0);
  }
});
test('formal preload leaves native receiver disabled', () => {
  const b = bridge(false); assert.equal(b.api.supported, false); assert.equal(b.hasReceiver(), false);
  assert.equal(b.hasCpuReceiver(), false);
});
test('frame closes before its import releases, and only its transfer permit unlocks it', async () => {
  const b = bridge(), t = texture(); let seen = 0;
  b.api.onFrame(metadata.requestId, async () => { seen++; });
  const completed = b.receive(t, metadata); await flush();
  assert.equal(seen, 1); assert.equal(t.state.closed, 1); assert.equal(t.state.released, 0);
  b.ipc.emit('cove:native-screen:release-permit', {}, { ...metadata, serial: 2 }); await flush();
  assert.equal(t.state.released, 0);
  b.ipc.emit('cove:native-screen:release-permit', {}, metadata); await completed;
  assert.equal(t.state.released, 1); assert.equal(b.timers.size, 0);
});
test('early permit is matched and an unsubscribed frame still releases', async () => {
  const b = bridge(), t = texture(); const remove = b.api.onFrame(metadata.requestId, async () => assert.fail()); remove();
  b.ipc.emit('cove:native-screen:release-permit', {}, metadata);
  await b.receive(t, metadata);
  assert.equal(t.state.frames, 0); assert.equal(t.state.released, 1); assert.equal(b.timers.size, 0);
});
function countedPermitPromises() {
  let count = 0;
  const constructor = new Proxy(Promise, {
    construct(target, args) { count++; return Reflect.construct(target, args, target); },
  });
  return { constructor, get count() { return count; } };
}
test('an early GPU permit needs no permit Promise or timer', async () => {
  const promises = countedPermitPromises(), b = bridge(true, { Promise: promises.constructor }), t = texture();
  b.api.onFrame(metadata.requestId, async () => {});
  b.ipc.emit('cove:native-screen:release-permit', {}, metadata);
  await b.receive(t, metadata);
  assert.equal(promises.count, 0); assert.equal(t.state.closed, 1); assert.equal(t.state.released, 1);
  assert.equal(b.timers.size, 0); assert.deepEqual(b.calls, []);
});
test('a GPU permit received during the listener skips one Promise and releases in the close continuation', async () => {
  const promises = countedPermitPromises(), b = bridge(true, { Promise: promises.constructor }), t = texture();
  let finish, releasedAtNextMicrotask;
  t.importedSharedTexture.getVideoFrame = () => {
    t.state.frames++;
    return { close() {
      t.state.closed++;
      queueMicrotask(() => { releasedAtNextMicrotask = t.state.released; });
    } };
  };
  b.api.onFrame(metadata.requestId, () => new Promise(resolve => { finish = resolve; }));
  const completed = b.receive(t, metadata);
  assert.equal(promises.count, 0); assert.equal(b.timers.size, 1);
  b.ipc.emit('cove:native-screen:release-permit', {}, metadata);
  assert.equal(t.state.closed, 0); assert.equal(t.state.released, 0);
  assert.equal(b.timers.size, 1, 'the original listener timeout must remain armed');
  finish(); await completed;
  assert.equal(promises.count, 0, 'the prior eager permit barrier allocated one Promise here');
  assert.equal(releasedAtNextMicrotask, 1, 'close and release must not be separated by an already-settled await');
  assert.equal(t.state.closed, 1); assert.equal(t.state.released, 1); assert.equal(b.timers.size, 0);
});
test('a GPU permit still missing after listener completion constructs exactly one awaited barrier', async () => {
  const promises = countedPermitPromises(), b = bridge(true, { Promise: promises.constructor }), t = texture();
  b.api.onFrame(metadata.requestId, async () => {});
  const completed = b.receive(t, metadata); await flush();
  assert.equal(promises.count, 1); assert.equal(t.state.closed, 1); assert.equal(t.state.released, 0);
  b.ipc.emit('cove:native-screen:release-permit', {}, { ...metadata, sessionId: 'session-other' });
  b.ipc.emit('cove:native-screen:release-permit', {}, { ...metadata, serial: 2 });
  await flush(); assert.equal(t.state.released, 0); assert.equal(promises.count, 1);
  b.ipc.emit('cove:native-screen:release-permit', {}, metadata); await completed;
  b.ipc.emit('cove:native-screen:release-permit', {}, metadata);
  assert.equal(t.state.released, 1); assert.equal(promises.count, 1); assert.equal(b.timers.size, 0);
});
test('the original 1500ms GPU timeout survives an arrived permit while its listener hangs', async () => {
  const promises = countedPermitPromises(), b = bridge(true, { Promise: promises.constructor }), t = texture();
  let finish;
  b.api.onFrame(metadata.requestId, () => new Promise(resolve => { finish = resolve; }));
  const completed = b.receive(t, metadata), timer = [...b.timers.entries()][0];
  assert.equal(b.timerDelays.get(timer[0]), 1500);
  b.ipc.emit('cove:native-screen:release-permit', {}, metadata);
  assert.equal(b.timers.get(timer[0]), timer[1], 'permit arrival must neither replace nor clear the original timer');
  timer[1]();
  assert.deepEqual(b.calls, [['cove:native-screen:stop', metadata.requestId, 'receiver_failed']]);
  assert.equal(t.state.closed, 0); assert.equal(t.state.released, 0); assert.equal(promises.count, 0);
  finish(); await completed;
  assert.equal(t.state.closed, 1); assert.equal(t.state.released, 1); assert.equal(b.timers.size, 0);
});
test('an already-arrived GPU permit does not hide a listener rejection or change close/release order', async () => {
  const promises = countedPermitPromises(), b = bridge(true, { Promise: promises.constructor }), t = texture();
  let reject;
  t.importedSharedTexture.release = () => {
    assert.equal(t.state.closed, 1); assert.equal(b.calls.length, 1); t.state.released++;
  };
  b.api.onFrame(metadata.requestId, () => new Promise((_resolve, no) => { reject = no; }));
  const completed = b.receive(t, metadata);
  b.ipc.emit('cove:native-screen:release-permit', {}, metadata);
  reject(Error('writer_failed')); await completed;
  assert.deepEqual(b.calls, [['cove:native-screen:stop', metadata.requestId, 'receiver_failed']]);
  assert.equal(t.state.closed, 1); assert.equal(t.state.released, 1); assert.equal(promises.count, 0);
  assert.equal(b.timers.size, 0);
});
test('stopping a GPU listener and old-session permits cannot bypass another import barrier', async () => {
  const b = bridge(), old = texture(), current = texture();
  const newer = { ...metadata, sessionId: 'session-newer' }; let finish;
  const remove = b.api.onFrame(metadata.requestId, () => new Promise(resolve => { finish = resolve; }));
  const oldCompleted = b.receive(old, metadata); remove(); await b.api.stop(metadata.requestId);
  const newCompleted = b.receive(current, newer); await flush();
  assert.equal(old.state.closed, 0); assert.equal(old.state.released, 0);
  assert.equal(current.state.released, 0);
  b.ipc.emit('cove:native-screen:release-permit', {}, metadata); finish(); await oldCompleted;
  b.ipc.emit('cove:native-screen:release-permit', {}, metadata); await flush();
  assert.equal(old.state.closed, 1); assert.equal(old.state.released, 1); assert.equal(current.state.released, 0);
  b.ipc.emit('cove:native-screen:release-permit', {}, newer); await newCompleted;
  assert.equal(current.state.released, 1); assert.equal(b.timers.size, 0);
  assert.deepEqual(b.calls, [['cove:native-screen:stop', metadata.requestId, undefined]]);
});
test('callback rejection retires its session but still waits for transfer', async () => {
  const b = bridge(), t = texture();
  b.api.onFrame(metadata.requestId, async () => { throw Error('writer_failed'); });
  const completed = b.receive(t, metadata); await flush();
  assert.deepEqual(b.calls[0], ['cove:native-screen:stop', metadata.requestId, 'receiver_failed']);
  assert.equal(t.state.released, 0);
  b.ipc.emit('cove:native-screen:release-permit', {}, metadata); await completed;
  assert.equal(t.state.closed, 1); assert.equal(t.state.released, 1);
});
test('missing transfer permit retires rather than manufacturing a slot credit', async () => {
  const b = bridge(), t = texture(); const completed = b.receive(t, metadata); await flush();
  for (const timer of [...b.timers.values()]) timer();
  await completed;
  assert.deepEqual(b.calls, [['cove:native-screen:stop', metadata.requestId, 'receiver_failed']]);
  assert.equal(t.state.released, 1); assert.equal(b.timers.size, 0);
});

test('CPU NV12 uses exact bytes, tight planes and limited BT709, then closes before ACK', async () => {
  const b = bridge(), data = cpuBytes(); let finish, seen;
  b.api.onFrame(metadata.requestId, async (frame, value) => {
    seen = { frame, metadata: value };
    await new Promise(resolve => { finish = resolve; });
  });
  const completed = b.receiveCpu(cpuMetadata, data); await flush();
  assert.equal(b.cpuFrames.length, 1); const frame = b.cpuFrames[0], init = frame.init;
  assert.equal(frame.data, data); assert.equal(seen.frame, frame); assert.equal(seen.metadata, cpuMetadata);
  assert.deepEqual({ format: init.format, codedWidth: init.codedWidth, codedHeight: init.codedHeight,
    displayWidth: init.displayWidth, displayHeight: init.displayHeight, timestamp: init.timestamp },
  { format: 'NV12', codedWidth: 64, codedHeight: 64, displayWidth: 64, displayHeight: 64, timestamp: 1000 });
  assert.deepEqual(Array.from(init.layout, plane => ({ ...plane })), [{ offset: 0, stride: 64 }, { offset: 4096, stride: 64 }]);
  assert.deepEqual({ ...init.colorSpace }, { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false });
  assert.equal(init.transfer.length, 1); assert.equal(init.transfer[0], data);
  assert.equal(frame.closed, 0); assert.equal(b.sent.length, 0); assert.equal(b.timers.size, 0);
  finish(); await completed;
  assert.equal(frame.closed, 1); assert.deepEqual(b.sent, [['cove:native-screen:cpu-frame-done', cpuMetadata]]);
  assert.deepEqual(b.events.map(event => event[0]), ['construct', 'close', 'send']); assert.deepEqual(b.calls, []);
});

test('CPU accepts a genuine cross-realm ArrayBuffer without relying on instanceof', async () => {
  const b = bridge(), data = vm.runInNewContext('new ArrayBuffer(6144)');
  assert.equal(data instanceof ArrayBuffer, false);
  b.api.onFrame(metadata.requestId, async () => {});
  await b.receiveCpu(cpuMetadata, data);
  assert.equal(b.cpuFrames[0].data, data); assert.equal(b.cpuFrames[0].closed, 1); assert.equal(b.calls.length, 0);
});

test('CPU BT601 constructs limited SMPTE170M on every component and keeps the close/ACK barrier', async () => {
  const b = bridge(), value = { ...cpuMetadata, colorSpace: 'bt601-limited' };
  b.api.onFrame(value.requestId, async () => {});
  await b.receiveCpu(value, cpuBytes());
  assert.deepEqual({ ...b.cpuFrames[0].init.colorSpace },
    { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false });
  assert.deepEqual(b.events.map(event => event[0]), ['construct', 'close', 'send']);
  assert.deepEqual(b.sent, [['cove:native-screen:cpu-frame-done', value]]);
  assert.equal(b.timers.size, 0); assert.deepEqual(b.calls, []);
});

test('unsubscribed and late CPU frames are ACKed without constructing a VideoFrame', async () => {
  const b = bridge(true, { VideoFrame: undefined });
  const remove = b.api.onFrame(metadata.requestId, async () => assert.fail('unsubscribed listener'));
  remove();
  await b.receiveCpu(cpuMetadata, cpuBytes());
  await b.receiveCpu({ ...cpuMetadata, serial: 2 }, cpuBytes());
  assert.equal(b.cpuFrames.length, 0); assert.equal(b.calls.length, 0); assert.equal(b.sent.length, 2);
  assert.equal(b.sent[0][1], cpuMetadata); assert.equal(b.sent[1][1].serial, 2); assert.equal(b.timers.size, 0);
});

test('CPU callback rejection closes its frame and sends stop before ACK without a GPU permit', async () => {
  const b = bridge();
  b.api.onFrame(metadata.requestId, async () => { throw Error('writer_failed'); });
  await b.receiveCpu(cpuMetadata, cpuBytes());
  assert.equal(b.cpuFrames[0].closed, 1);
  assert.deepEqual(b.calls, [['cove:native-screen:stop', metadata.requestId, 'receiver_failed']]);
  assert.deepEqual(b.events.map(event => event[0]), ['construct', 'invoke', 'close', 'send']);
  assert.deepEqual(b.sent, [['cove:native-screen:cpu-frame-done', cpuMetadata]]); assert.equal(b.timers.size, 0);
});

test('CPU cancellation during an awaited callback retains ownership until that callback finishes', async () => {
  const b = bridge(); let finish;
  const remove = b.api.onFrame(metadata.requestId, async () => new Promise(resolve => { finish = resolve; }));
  const completed = b.receiveCpu(cpuMetadata, cpuBytes()); await flush();
  remove(); await b.api.stop(metadata.requestId); await flush();
  assert.equal(b.cpuFrames[0].closed, 0); assert.equal(b.sent.length, 0);
  finish(); await completed;
  assert.equal(b.cpuFrames[0].closed, 1); assert.equal(b.sent.length, 1);
  await b.receiveCpu({ ...cpuMetadata, serial: 2 }, cpuBytes());
  assert.equal(b.cpuFrames.length, 1); assert.equal(b.sent.length, 2);
});

test('CPU rejects incorrect byte counts, views, shared buffers and forged ArrayBuffer brands', async () => {
  const detached = cpuBytes(); structuredClone(detached, { transfer: [detached] });
  const invalid = [new ArrayBuffer(6143), new ArrayBuffer(6145), new ArrayBuffer(17 * 1024 * 1024),
    new Uint8Array(6144), Buffer.alloc(6144), new SharedArrayBuffer(6144), detached,
    { byteLength: 6144 }, { byteLength: 6144, [Symbol.toStringTag]: 'ArrayBuffer' }, null];
  for (const data of invalid) {
    const b = bridge(); b.api.onFrame(metadata.requestId, async () => assert.fail('invalid CPU bytes reached listener'));
    await b.receiveCpu(cpuMetadata, data);
    assert.equal(b.cpuFrames.length, 0);
    assert.deepEqual(b.calls, [['cove:native-screen:stop', metadata.requestId, 'receiver_failed']]);
    assert.deepEqual(b.events.map(event => event[0]), ['invoke', 'send']); assert.equal(b.sent.length, 1);
  }
});

test('CPU constructor absence or rejection stops before ACK and does not change native permissions', async () => {
  for (const VideoFrame of [undefined, class { constructor() { throw TypeError('unsupported'); } }]) {
    const b = bridge(true, { VideoFrame }); b.api.onFrame(metadata.requestId, async () => assert.fail());
    await b.receiveCpu(cpuMetadata, cpuBytes());
    assert.deepEqual(b.calls, [['cove:native-screen:stop', metadata.requestId, 'receiver_failed']]);
    assert.deepEqual(b.events.map(event => event[0]), ['invoke', 'send']); assert.equal(b.sent.length, 1);
  }
  for (const options of [{ platform: 'linux' }, { sharedTexture: false }]) {
    const b = bridge(true, options);
    assert.equal(b.api.supported, false); assert.equal(b.hasCpuReceiver(), false); assert.equal(b.hasReceiver(), false);
    assert.equal((await b.api.start(metadata.requestId, {})).ok, false); assert.equal(b.calls.length, 0);
  }
});

test('CPU metadata stays within the native session, slot, timestamp and even NV12 geometry contract', async () => {
  const invalid = [{ requestId: 'bad' }, { sessionId: '../session' }, { slot: 3 }, { slot: -1 }, { serial: 0 },
    { serial: Number.MAX_SAFE_INTEGER + 1 }, { timestamp: -1 }, { timestamp: 0.5 }, { refresh: 1 },
    { width: 63 }, { height: 63 }, { width: 4098 }, { height: 2562 }, { storage: undefined },
    { storage: 'gpu' }, { pixelFormat: undefined }, { pixelFormat: 'bgra' }, { pixelFormat: 'rgba' },
    { colorSpace: undefined }, { colorSpace: 'bt2020-limited' }, { colorSpace: 'smpte170m' }];
  for (const patch of invalid) {
    const b = bridge(); b.api.onFrame(metadata.requestId, async () => assert.fail());
    await b.receiveCpu({ ...cpuMetadata, ...patch }, cpuBytes());
    assert.equal(b.cpuFrames.length, 0); assert.equal(b.sent.length, 0); assert.equal(b.timers.size, 0);
    assert.equal(b.calls.length, patch.requestId === 'bad' ? 0 : 1);
  }
});

test('GPU imports reject CPU storage and CPU ACK never substitutes for a GPU release permit', async () => {
  const b = bridge(), rejected = texture(), pending = texture();
  await b.receive(rejected, cpuMetadata);
  assert.equal(rejected.state.frames, 0); assert.equal(rejected.state.released, 1); assert.equal(b.timers.size, 0);
  const completed = b.receive(pending, metadata); await flush();
  b.ipc.emit('cove:native-screen:release-permit', {}, cpuMetadata);
  await b.receiveCpu(cpuMetadata, cpuBytes());
  assert.equal(pending.state.released, 0); assert.equal(b.timers.size, 1);
  b.ipc.emit('cove:native-screen:release-permit', {}, metadata); await completed;
  assert.equal(pending.state.released, 1); assert.equal(b.timers.size, 0);
});
