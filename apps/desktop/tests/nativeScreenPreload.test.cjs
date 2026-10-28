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
  const api = {}, ipc = new EventEmitter(), calls = [], sent = [], events = [], cpuFrames = [], timers = new Map();
  let id = 0, receiver;
  ipc.invoke = async (...args) => { calls.push(args); events.push(['invoke', ...args]); return true; };
  ipc.send = (...args) => { sent.push(args); events.push(['send', ...args]); };
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
    process: { platform: options.platform ?? 'win32', env: {}, argv: enabled ? ['--cove-native-gpu-capture=1'] : [] },
    setTimeout: callback => { timers.set(++id, callback); return id; }, clearTimeout: key => timers.delete(key),
    console, Uint8Array, Buffer, VideoFrame });
  return { api: api.coveNativeScreen, ipc, calls, sent, events, cpuFrames, timers, receive: (...args) => receiver(...args),
    receiveCpu: (...args) => ipc.listeners('cove:native-screen:cpu-frame')[0]({}, ...args),
    hasReceiver: () => Boolean(receiver), hasCpuReceiver: () => ipc.listenerCount('cove:native-screen:cpu-frame') > 0 };
}
const metadata = { requestId: 'native_request_1', sessionId: 'session-1234', slot: 0, serial: 1,
  width: 64, height: 64, timestamp: 1000, refresh: false };
const cpuMetadata = { ...metadata, storage: 'cpu', pixelFormat: 'nv12' };
const cpuBytes = () => new ArrayBuffer(cpuMetadata.width * cpuMetadata.height * 3 / 2);
function texture() {
  const state = { frames: 0, closed: 0, released: 0 };
  return { state, importedSharedTexture: { getVideoFrame() { state.frames++; return { close() { state.closed++; } }; },
    release() { state.released++; } } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
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
    { storage: 'gpu' }, { pixelFormat: undefined }, { pixelFormat: 'bgra' }, { pixelFormat: 'rgba' }];
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
