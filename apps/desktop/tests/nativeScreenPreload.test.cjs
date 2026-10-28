const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync(require.resolve('../electron/preload.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
function bridge(enabled = true) {
  const api = {}, ipc = new EventEmitter(), calls = [], timers = new Map(); let id = 0, receiver;
  ipc.invoke = async (...args) => { calls.push(args); return true; };
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { api[name] = value; } },
    ipcRenderer: ipc, sharedTexture: { setSharedTextureReceiver: callback => { receiver = callback; } } };
  vm.runInNewContext(source, { require: name => { assert.equal(name, 'electron'); return electron; }, exports: {},
    process: { platform: 'win32', env: {}, argv: enabled ? ['--cove-native-gpu-capture=1'] : [] },
    setTimeout: callback => { timers.set(++id, callback); return id; }, clearTimeout: key => timers.delete(key),
    console, Uint8Array, Buffer });
  return { api: api.coveNativeScreen, ipc, calls, timers, receive: (...args) => receiver(...args), hasReceiver: () => Boolean(receiver) };
}
const metadata = { requestId: 'native_request_1', sessionId: 'session-1234', slot: 0, serial: 1,
  width: 64, height: 64, timestamp: 1000, refresh: false };
function texture() {
  const state = { frames: 0, closed: 0, released: 0 };
  return { state, importedSharedTexture: { getVideoFrame() { state.frames++; return { close() { state.closed++; } }; },
    release() { state.released++; } } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('formal preload leaves native receiver disabled', () => {
  const b = bridge(false); assert.equal(b.api.supported, false); assert.equal(b.hasReceiver(), false);
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
