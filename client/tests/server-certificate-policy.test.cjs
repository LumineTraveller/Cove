const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ServerCertificatePolicy,
  normalizeHttpsOrigin,
} = require('../dist-electron/server-certificate-policy.js');

test('normalizes only HTTPS origins', () => {
  assert.equal(normalizeHttpsOrigin('https://Example.com:51758/api/rooms'), 'https://example.com:51758');
  assert.equal(normalizeHttpsOrigin('http://example.com:51758'), null);
  assert.equal(normalizeHttpsOrigin('not a url'), null);
});

test('allows only the configured HTTPS host and port', () => {
  const policy = new ServerCertificatePolicy();
  assert.equal(policy.configure('https://frp.example.com:51758/path', true), 'https://frp.example.com:51758');
  assert.equal(policy.allows('https://frp.example.com:51758/api/rooms'), true);
  assert.equal(policy.allows('https://frp.example.com:51759/api/rooms'), false);
  assert.equal(policy.allows('https://other.example.com:51758/api/rooms'), false);
  assert.equal(policy.allows('http://frp.example.com:51758/api/rooms'), false);
});

test('disabling the policy clears the exception', () => {
  const policy = new ServerCertificatePolicy();
  policy.configure('https://frp.example.com:51758', true);
  policy.configure('https://frp.example.com:51758', false);
  assert.equal(policy.allows('https://frp.example.com:51758/api/rooms'), false);
});

test('actual main-window permission handlers allow fullscreen only for the Cove main frame', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const handlers = {};
  let window;
  const electron = {
    app: { isPackaged: true, on() {}, commandLine: { appendSwitch() {} }, whenReady: () => ({ then() {} }) },
    BrowserWindow: class {
      constructor() { this.webContents = { on() {} }; window = this; }
      on() {}
      loadFile() {}
    },
    Menu: { setApplicationMenu() {} },
    session: { defaultSession: {
      setPermissionRequestHandler: handler => { handlers.request = handler; },
      setPermissionCheckHandler: handler => { handlers.check = handler; },
      setDisplayMediaRequestHandler() {},
    } },
  };
  const source = fs.readFileSync(require.resolve('../dist-electron/main.js'), 'utf8');
  vm.runInNewContext(source + '\ncreateWindow();', {
    exports: {}, __dirname, process: { platform: 'win32' },
    require: id => {
      if (id === 'electron') return electron;
      if (id === 'path') return require('node:path');
      if (id === './server-certificate-policy') return { ServerCertificatePolicy };
      if (id === './application-audio') return { ApplicationAudioCaptureController: class {} };
      return {};
    },
  });
  const request = (wc, permission, isMainFrame) => {
    let result;
    handlers.request(wc, permission, allowed => { result = allowed; }, { isMainFrame });
    return result;
  };
  for (const [wc, mainFrame, expected] of [
    [window.webContents, true, true],
    [window.webContents, false, false],
    [{}, true, false],
    [null, true, false],
  ]) {
    assert.equal(request(wc, 'fullscreen', mainFrame), expected);
    assert.equal(handlers.check(wc, 'fullscreen', '', { isMainFrame: mainFrame }), expected);
  }
  assert.equal(request(window.webContents, 'media', true), true);
  assert.equal(handlers.check(window.webContents, 'media', '', { isMainFrame: true }), true);
  assert.equal(request(window.webContents, 'notifications', true), false);
  assert.equal(request(window.webContents, 'geolocation', true), false);
});
