const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');

const channel = 'cove:native-screen:cpu-frame-done';
const mainPath = require.resolve('../electron/main.ts');
const source = ts.createSourceFile(mainPath, fs.readFileSync(mainPath, 'utf8'), ts.ScriptTarget.Latest, true);
const registrations = [];
function visit(node) {
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
    const call = node.expression, target = call.expression;
    if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) &&
        target.expression.text === 'ipcMain' && target.name.text === 'on' &&
        call.arguments[0] && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === channel) {
      registrations.push(node);
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(registrations.length, 1, 'main.ts must register exactly one CPU frame ACK handler');
// Execute the exact production registration without starting Electron or a capture helper.
const registration = new vm.Script(ts.transpileModule(registrations[0].getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText, { filename: mainPath });

function webContents(mainFrame = {}) {
  const state = { mainFrame, destroyed: false };
  const sender = {
    isDestroyed: () => state.destroyed,
    get mainFrame() {
      if (state.destroyed) throw Error('WebContents has been destroyed');
      return state.mainFrame;
    },
  };
  return { sender, state };
}

function harness() {
  const ipcMain = new EventEmitter(), calls = [], contents = webContents();
  const context = {
    ipcMain,
    mainWindow: { webContents: contents.sender },
    nativeScreenCapture: { acknowledgeCpuFrame: (...args) => calls.push(args) },
  };
  registration.runInNewContext(context);
  assert.equal(ipcMain.listenerCount(channel), 1);
  return {
    ...contents, calls,
    receive: (event, metadata) => ipcMain.emit(channel, event, metadata),
    setWindow: sender => { context.mainWindow = sender ? { webContents: sender } : null; },
  };
}

const metadata = Object.freeze({ requestId: 'native_request_1', sessionId: 'session-1234',
  slot: 0, serial: 1, storage: 'cpu', pixelFormat: 'nv12', width: 64, height: 64, timestamp: 1000, refresh: false });

test('CPU ACK forwards the current main frame and unchanged metadata to the controller once', () => {
  const h = harness();
  h.receive({ sender: h.sender, senderFrame: h.state.mainFrame }, metadata);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].length, 2);
  assert.equal(h.calls[0][0], h.sender);
  assert.equal(h.calls[0][1], metadata);
});

test('CPU ACK rejects another WebContents even if it supplies the current main frame', () => {
  const h = harness(), other = webContents();
  for (const senderFrame of [other.state.mainFrame, h.state.mainFrame]) {
    h.receive({ sender: other.sender, senderFrame }, metadata);
  }
  assert.deepEqual(h.calls, []);
});

test('CPU ACK rejects child frames and a missing sender frame in the main WebContents', () => {
  const h = harness(), child = { parent: h.state.mainFrame, top: h.state.mainFrame };
  for (const senderFrame of [child, null, undefined]) {
    h.receive({ sender: h.sender, senderFrame }, metadata);
  }
  assert.deepEqual(h.calls, []);
});

test('CPU ACK compares against the live main frame after navigation', () => {
  const h = harness(), previousFrame = h.state.mainFrame, nextFrame = {};
  h.state.mainFrame = nextFrame;
  h.receive({ sender: h.sender, senderFrame: previousFrame }, metadata);
  assert.deepEqual(h.calls, []);
  h.receive({ sender: h.sender, senderFrame: nextFrame }, metadata);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], h.sender);
  assert.equal(h.calls[0][1], metadata);
});

test('CPU ACK rejects a former window and dispatches only to the replacement main window', () => {
  const h = harness(), replacement = webContents();
  h.setWindow(replacement.sender);
  h.receive({ sender: h.sender, senderFrame: h.state.mainFrame }, metadata);
  assert.deepEqual(h.calls, []);
  h.receive({ sender: replacement.sender, senderFrame: replacement.state.mainFrame }, metadata);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], replacement.sender);
});

test('CPU ACK is ignored when the main window has closed', () => {
  const h = harness();
  h.setWindow(null);
  assert.doesNotThrow(() => h.receive({ sender: h.sender, senderFrame: h.state.mainFrame }, metadata));
  assert.deepEqual(h.calls, []);
});

test('CPU ACK rejects a destroyed sender without reading its inaccessible main frame', () => {
  const h = harness(), senderFrame = h.state.mainFrame;
  h.state.destroyed = true;
  assert.doesNotThrow(() => h.receive({ sender: h.sender, senderFrame }, metadata));
  assert.deepEqual(h.calls, []);
});
