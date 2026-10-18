const assert = require('node:assert/strict');
const test = require('node:test');
const { registerInstallationIntegrityIpc } = require('../dist-electron/installation-integrity-ipc.js');

function harness() {
  const handlers = new Map();
  const trusted = {};
  const calls = [];
  const state = { status: 'idle', version: '2.0.2', platform: 'win32', arch: 'x64' };
  const unavailable = { ...state, status: 'disabled' };
  let controller = Object.fromEntries(['getState', 'checkNow', 'downloadRepair', 'cancel'].map(action =>
    [action, () => { calls.push(action); return state; }]));
  controller.launchRepair = async () => { calls.push('launchRepair'); return true; };
  registerInstallationIntegrityIpc({ handle: (name, listener) => handlers.set(name, listener) }, {
    controller: () => controller,
    isTrustedSender: event => event === trusted,
    unavailableState: unavailable,
    openRelease: async () => { calls.push('openRelease'); return true; },
  });
  return { handlers, trusted, state, unavailable, calls, unset: () => { controller = null; } };
}

test('integrity IPC rejects foreign frames and all renderer supplied arguments without side effects', async () => {
  const h = harness();
  assert.equal(h.handlers.size, 6);
  for (const [name, handler] of h.handlers) {
    const rejected = /launch|open-release/.test(name) ? false : h.unavailable;
    assert.deepEqual(await handler({}), rejected, name);
    for (const payload of [undefined, 'https://evil.invalid/payload.exe', '../../userData', { version: '9.9.9' }]) {
      assert.deepEqual(await handler(h.trusted, payload), rejected, name);
    }
  }
  assert.deepEqual(h.calls, []);
});

test('integrity IPC dispatches only fixed no-argument controller actions', async () => {
  const h = harness();
  for (const suffix of ['get-state', 'check', 'download', 'cancel']) {
    assert.deepEqual(await h.handlers.get(`cove:integrity:${suffix}`)(h.trusted), h.state);
  }
  assert.equal(await h.handlers.get('cove:integrity:launch')(h.trusted), true);
  assert.equal(await h.handlers.get('cove:integrity:open-release')(h.trusted), true);
  assert.deepEqual(h.calls, ['getState', 'checkNow', 'downloadRepair', 'cancel', 'launchRepair', 'openRelease']);
});

test('an unready controller cannot check, download or launch an installer', async () => {
  const h = harness();
  h.unset();
  for (const suffix of ['get-state', 'check', 'download', 'cancel']) {
    assert.deepEqual(await h.handlers.get(`cove:integrity:${suffix}`)(h.trusted), h.unavailable);
  }
  assert.equal(await h.handlers.get('cove:integrity:launch')(h.trusted), false);
  assert.deepEqual(h.calls, []);
});
