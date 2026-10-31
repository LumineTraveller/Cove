'use strict';
// Runner for the actual bundled Worker fixture in dev or built file://. This
// process owns its temporary profile/window; it never controls an existing app.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const root = path.resolve(__dirname, '../../../..');
const mode = process.env.COVE_WORKER_SMOKE_MODE;
const runRoot = path.join(root, 'runtime', 'native-worker-sink-smoke');
fs.mkdirSync(runRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(runRoot, `${mode === 'file' ? 'file' : 'dev'}-`));
app.setPath('userData', path.join(directory, 'profile'));
let target, allowedFileRoot;
if (mode === 'dev') {
  const origin = new URL(process.env.COVE_WORKER_SMOKE_ORIGIN || '');
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port ||
      origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw Error('Expected an isolated loopback Vite origin');
  target = new URL('/tests/ui/native-worker-sink.html', origin).href;
} else if (mode === 'file') {
  allowedFileRoot = path.join(runRoot, 'build');
  target = pathToFileURL(path.join(allowedFileRoot, 'tests', 'ui', 'native-worker-sink.html')).href;
} else throw Error('Set COVE_WORKER_SMOKE_MODE to dev or file');
let win, watchdog, poll, finished = false;
function finish(result) {
  if (finished) return; finished = true;
  clearTimeout(watchdog); clearTimeout(poll);
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ directory, ...result }));
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(result.ok ? 0 : 1);
}
app.whenReady().then(async () => {
  const isolated = session.fromPartition('worker-sink-cpu-smoke');
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      if (mode === 'dev') allowed = url.origin === new URL(target).origin;
      else if (url.protocol === 'file:') {
        const file = path.resolve(fileURLToPath(url));
        allowed = file.startsWith(path.resolve(allowedFileRoot) + path.sep);
      }
    } catch {}
    callback({ cancel: !allowed });
  });
  win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: {
    session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
  } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('render-process-gone', () => finish({ ok: false, reason: 'renderer_gone' }));
  watchdog = setTimeout(() => finish({ ok: false, reason: 'watchdog' }), 8000);
  await win.loadURL(target);
  async function inspect() {
    try {
      const result = await win.webContents.executeJavaScript('globalThis.coveWorkerSmokeResult ?? null');
      if (result) { finish(result); return; }
      poll = setTimeout(inspect, 20);
    } catch { finish({ ok: false, reason: 'inspection_failed' }); }
  }
  await inspect();
}).catch(() => finish({ ok: false, reason: 'startup_failed' }));
