'use strict';
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { readConfig, privateAddress } = require('./portable-common.cjs');
const root = path.dirname(process.execPath);
const config = readConfig(root);
const data = path.join(config.state, 'desktop');
const profile = path.join(data, 'Cove Network Lab');
for (const directory of [data, profile, path.join(profile, 'session'), path.join(data, 'temp'), path.join(data, 'logs'), path.join(data, 'crashes'), path.join(config.state, 'cache')])
  fs.mkdirSync(directory, { recursive: true });
// Existing network-lab gating disables updater and installer repair. Redirect
// appData first so its legacy profile name also stays inside THIS test bundle.
app.setName('Cove Acceptance 20261023');
app.setAppUserModelId('com.cove.acceptance.20261023');
app.setPath('appData', data);
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'session'));
app.setPath('temp', path.join(data, 'temp'));
app.setPath('logs', path.join(data, 'logs'));
app.setPath('crashDumps', path.join(data, 'crashes'));
// A shallow cache path also avoids legacy Windows MAX_PATH limits when the
// archive is prepared under a deeply nested checkout.
app.commandLine.appendSwitch('disk-cache-dir', path.join(config.state, 'cache'));
app.commandLine.appendSwitch('disable-background-networking');
delete process.env.COVE_DEV_RENDERER_URL;
const smoke = process.argv.includes('--acceptance-smoke');
const runtimeCheck = process.argv.includes('--acceptance-runtime-check');
app.whenReady().then(async () => {
  // No automatic production network activity. Local or explicitly entered LAN
  // servers are allowed; user profiles start empty and default to localhost.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, done) => {
    let allowed = false;
    try { allowed = privateAddress(new URL(request.url).hostname); } catch {}
    done({ cancel: smoke || runtimeCheck || !allowed });
  });
  if (runtimeCheck) {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    if (!app.isPackaged || manifest.coveBuildFlavor !== 'network-lab') throw new Error('Acceptance package gating is unavailable');
    // Resolve the actual copied main-process dependency closure, without
    // activating capture, input helpers, updater checks or a visible window.
    require('electron-updater');
    require('loopback-capture');
    console.log(JSON.stringify({ ok: true, runtimeOnly: true, electron: process.versions.electron,
      node: process.versions.node, modules: process.versions.modules, packaged: app.isPackaged,
      releaseCheck: 'disabled', name: app.getName(), profile: app.getPath('userData'), session: app.getPath('sessionData'), temp: app.getPath('temp') }));
    app.exit(0);
    return;
  }
  if (!smoke) return;
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const timer = setTimeout(() => app.exit(1), 20000);
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: true } });
  try {
    await win.loadFile(path.join(__dirname, 'dist/index.html'));
    for (let index = 0; index < 100; index++) {
      if (await win.webContents.executeJavaScript('Boolean(document.querySelector("#login-email")&&document.querySelector("#login-server"))')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const result = await win.webContents.executeJavaScript('({login:Boolean(document.querySelector("#login-email")&&document.querySelector("#login-server")),server:document.querySelector("#login-server")?.value,branding:document.querySelector(".auth-brand img")?.naturalWidth>0})');
    if (!result.login || !result.branding || result.server !== `http://127.0.0.1:${config.httpPort}`) throw new Error(`Portable UI smoke failed: ${JSON.stringify(result)}`);
    console.log(JSON.stringify({ ok: true, ...result, electron: process.versions.electron, node: process.versions.node,
      modules: process.versions.modules, profile: app.getPath('userData'), packaged: app.isPackaged, visible: win.isVisible() }));
    clearTimeout(timer); win.destroy(); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(timer); win.destroy(); app.exit(1); }
});
if (!smoke && !runtimeCheck) {
  app.on('browser-window-created', (_event, win) => {
    win.on('page-title-updated', event => { event.preventDefault(); win.setTitle('Cove Acceptance 20261023'); });
  });
  require('./dist-electron/main.js');
}
