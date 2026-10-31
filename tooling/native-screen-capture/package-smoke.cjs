'use strict';
// Hidden packaged-renderer/native-binary gate. Never logs in or captures media.
const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const candidate = fs.realpathSync(process.argv[2] || '');
const relative = path.relative(path.join(root, 'runtime'), candidate);
if (path.isAbsolute(relative) || relative.startsWith('..') || !relative.startsWith('native-capture-lab-'))
  throw Error('An isolated native-capture-lab runtime candidate is required');
const directory = fs.mkdtempSync(path.join(root, 'runtime/native-capture-package-smoke-'));
fs.mkdirSync(path.join(directory, 'profile/session'), { recursive: true });
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'profile/session'));
const result = { passed: false, startedAt: new Date().toISOString(), blockedNetworkRequests: 0,
  microphoneRequested: false, desktopCaptured: false, installed: false };
let win;
const watchdog = setTimeout(() => { result.error = 'watchdog'; finish(1); }, 30000);
function finish(code) {
  clearTimeout(watchdog);
  if (win && !win.isDestroyed()) win.destroy();
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ directory, ...result })); app.exit(code);
}
app.whenReady().then(async () => {
  try {
    const archive = path.join(candidate, 'resources/app.asar');
    const metadata = JSON.parse(fs.readFileSync(path.join(candidate, 'CANDIDATE.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(archive, 'package.json'), 'utf8'));
    assert.equal(manifest.coveBuildFlavor, 'native-capture-lab');
    assert.equal(metadata.flavor, 'native-capture-lab');
    const handles = require(path.join(candidate, 'resources/native-screen-handles.node'));
    assert.equal(typeof handles.openChild, 'function');
    const check = spawnSync(path.join(candidate, 'resources/native-screen-capture-helper.exe'), ['--self-test'],
      { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    assert.equal(check.status, 0, check.error?.message || check.stderr);
    const algorithms = JSON.parse(check.stdout.trim()); assert.equal(algorithms.passed, true);
    Object.assign(result, { sourceCommit: metadata.sourceCommit, versions: process.versions,
      helperCpuOnlyChecks: algorithms.checks, nativeAddonLoaded: true });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_details, done) => { result.blockedNetworkRequests++; done({ cancel: true }); });
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    for (const [channel, value] of [
      ['cove:window:is-maximized', false], ['cove:account-password:status', { available: false }],
      ['cove:server-access:get', { available: false }], ['cove:account-password:get', { available: false }],
      ['cove:update:get-state', { status: 'disabled', message: 'isolated test' }],
      ['cove:integrity:get-state', { status: 'disabled', version: manifest.version, platform: 'win32', arch: 'x64' }],
    ]) ipcMain.handle(channel, () => value);
    win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false,
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: path.join(archive, 'dist-electron/preload.js'), additionalArguments: ['--cove-native-gpu-capture=1'] } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadFile(path.join(archive, 'dist/index.html'));
    for (let n = 0; n < 100; n++) {
      if (await win.webContents.executeJavaScript('Boolean(document.querySelector("#login-email")&&document.querySelector("#login-password"))')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const rendered = await win.webContents.executeJavaScript(`({
      login: Boolean(document.querySelector('#login-email') && document.querySelector('#login-password')),
      brand: document.querySelector('.auth-brand img')?.naturalWidth > 0,
      nativeBridge: window.coveNativeScreen?.supported === true,
      isolated: typeof window.require === 'undefined' && typeof window.process === 'undefined'
    })`);
    assert.deepEqual(rendered, { login: true, brand: true, nativeBridge: true, isolated: true });
    Object.assign(result, rendered, { passed: true }); finish(0);
  } catch (error) { result.error = String(error); finish(1); }
});
