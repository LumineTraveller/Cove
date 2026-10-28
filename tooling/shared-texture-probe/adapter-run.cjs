'use strict';
// Hidden, single immutable GPU texture -> actual sandbox preload -> actual
// renderer adapter. This is an ownership/interop probe, never desktop capture.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, ipcMain, sharedTexture } = require('electron');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'node_modules/typescript'));
const directory = fs.mkdtempSync(path.join(root, 'runtime/shared-texture-probe/gpu-adapter-'));
const helperPath = path.join(root, 'runtime/shared-texture-probe/helper.exe');
const preloadPath = path.join(root, 'apps/desktop/electron/preload.ts');
const adapterPath = path.join(root, 'apps/desktop/src/features/media/screen/nativeScreenCapture.ts');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const result = { passed: false, scope: 'Hidden immutable synthetic GPU64; no desktop, codec, SFU or throughput test.',
  directory, sourceHashes: { preload: hash(fs.readFileSync(preloadPath)), adapter: hash(fs.readFileSync(adapterPath)),
    helper: hash(fs.readFileSync(helperPath)) }, phases: [], rendererConsole: [] };
const phase = (name, value) => result.phases.push({ name, at: Date.now(), value });
let preloadSource = ts.transpileModule(fs.readFileSync(preloadPath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
preloadSource = preloadSource
  .replace('let frame;', "electron_1.ipcRenderer.send('gpu-probe:phase', {name:'receiver-enter', metadata}); let frame;")
  .replace('if (!nativeFrameValid(metadata))', "electron_1.ipcRenderer.send('gpu-probe:phase', {name:'permit-received', metadata}); if (!nativeFrameValid(metadata))")
  .replace('frame = imported.getVideoFrame();', "frame = imported.getVideoFrame(); electron_1.ipcRenderer.send('gpu-probe:phase', {name:'frame-created', width:frame.displayWidth,height:frame.displayHeight,timestamp:frame.timestamp});")
  .replace('await listener(frame, metadata);', "await listener(frame, metadata); electron_1.ipcRenderer.send('gpu-probe:phase', {name:'listener-done'});")
  .replace('await permit;', "electron_1.ipcRenderer.send('gpu-probe:phase', {name:'frame-closed-await-permit'}); await permit; electron_1.ipcRenderer.send('gpu-probe:phase', {name:'permit-resolved'});")
  .replace('imported.release();\n            if (timedOut)', "imported.release(); electron_1.ipcRenderer.send('gpu-probe:phase', {name:'import-released', timedOut});\n            if (timedOut)");
const runtimePreload = path.join(directory, 'preload.cjs'); fs.writeFileSync(runtimePreload, preloadSource);
const adapterSource = ts.transpileModule(fs.readFileSync(adapterPath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const profile = path.join(directory, 'profile'); fs.mkdirSync(profile);
app.setPath('userData', profile); app.setPath('sessionData', profile);
let win, helper, imported, mainReleased = false, stopped = false, allReleased;
const references = new Promise(resolve => { allReleased = resolve; });
const bounded = (promise, milliseconds, label) => {
  let timer;
  return Promise.race([promise, new Promise((_res, reject) => { timer = setTimeout(() => reject(Error(label + '_timeout')), milliseconds); })])
    .finally(() => clearTimeout(timer));
};
const releaseMain = () => { if (imported && !mainReleased) { mainReleased = true; imported.release(); phase('main-import-released'); } };
app.on('window-all-closed', () => {});
const hardTimeout = setTimeout(() => { phase('hard-timeout'); void finish(); }, 10000);
let finishing = false;
async function finish() {
  if (finishing) return; finishing = true; clearTimeout(hardTimeout);
  try { releaseMain(); } catch (error) { result.cleanupError = String(error); }
  try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
  try { helper?.stdin.end(); } catch {}
  if (helper && helper.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (helper.exitCode === null) helper.kill();
  }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, passed: result.passed, error: result.error, adapter: result.adapter }, null, 2));
  app.exit(result.passed ? 0 : 1);
}
app.whenReady().then(async () => {
  result.versions = process.versions;
  ipcMain.on('gpu-probe:phase', (event, value) => {
    if (event.sender === win?.webContents) phase('preload:' + value.name, value);
  });
  win = new BrowserWindow({ show: false, width: 100, height: 100, webPreferences: {
    preload: runtimePreload, sandbox: true, contextIsolation: true, nodeIntegration: false,
    backgroundThrottling: false, additionalArguments: ['--cove-native-gpu-capture=1'],
  } });
  win.webContents.on('console-message', (_event, _level, message) => result.rendererConsole.push(message));
  await win.loadURL('data:text/html;charset=utf-8,<title>Hidden GPU adapter probe</title>');
  const messages = new Map(), waiters = new Map();
  const waitMessage = type => messages.has(type) ? Promise.resolve(messages.get(type)) :
    bounded(new Promise((resolve, reject) => waiters.set(type, {resolve, reject})), 5000, type);
  helper = spawn(helperPath, ['--owner-pid', String(process.pid)], { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = '';
  helper.stdout.on('data', chunk => {
    pending += chunk;
    while (pending.includes('\n')) {
      const split = pending.indexOf('\n'), line = pending.slice(0, split); pending = pending.slice(split + 1);
      try { const value = JSON.parse(line); messages.set(value.type, value); waiters.get(value.type)?.resolve(value); waiters.delete(value.type); }
      catch (error) { phase('helper-invalid', String(error)); }
    }
  });
  helper.stderr.on('data', chunk => { result.helperError = (result.helperError || '') + String(chunk); });
  helper.once('close', code => { result.helperExit = code; for (const waiter of waiters.values()) waiter.reject(Error('helper-exit')); });
  const frame = await waitMessage('ready'); phase('helper-ready', { width: frame.width, height: frame.height });
  if (frame.ownerPid !== process.pid || frame.helperPid !== helper.pid || frame.width !== 64 || frame.height !== 64) throw Error('invalid-source');
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(BigInt(frame.mainHandle));
  try {
    imported = sharedTexture.importSharedTexture({ textureInfo: { handle: { ntHandle: handle }, codedSize: { width: 64, height: 64 },
      pixelFormat: 'bgra', timestamp: 1000 }, allReferencesReleased: () => { result.allReferencesReleased = true; phase('all-references-released'); allReleased(); } });
  } finally { handle.fill(0); }
  helper.stdin.write('imported\n'); await waitMessage('main-handle-closed');
  ipcMain.handle('cove:native-screen:stop', () => { result.stopCalls = (result.stopCalls || 0) + 1; phase('adapter-stop-ipc'); stopped = true; return true; });
  ipcMain.handle('cove:native-screen:start', (event, requestId, options) => {
    phase('adapter-start-ipc', options);
    setTimeout(async () => {
      if (stopped) return;
      const metadata = { requestId, sessionId: 'synthetic-gpu-session-1234', slot: 0, serial: 1, width: 64, height: 64, timestamp: 1000, refresh: false };
      try {
        phase('send-start');
        await sharedTexture.sendSharedTexture({ frame: event.senderFrame, importedSharedTexture: imported }, metadata);
        result.transferred = true; phase('send-complete'); releaseMain();
        event.senderFrame.send('cove:native-screen:release-permit', metadata);
        result.permitSent = true; phase('permit-sent');
      } catch (error) { result.sendError = String(error); phase('send-error', String(error)); }
    }, 5);
    return { ok: true, sessionId: 'synthetic-gpu-session-1234', width: 64, height: 64 };
  });
  result.adapter = await bounded(win.webContents.executeJavaScript(`(async () => {
    const exports = {}; ${adapterSource}
    const trace = [], NativeGenerator = MediaStreamTrackGenerator;
    class ObservedGenerator extends NativeGenerator {
      constructor(options) {
        super(options); const writer = this.writable.getWriter.bind(this.writable);
        this.writable.getWriter = () => {
          const value = writer(), write = value.write.bind(value);
          value.write = async frame => {
            trace.push({name:'write-begin', width:frame.displayWidth, height:frame.displayHeight, timestamp:frame.timestamp, at:performance.now()});
            const result = await write(frame); trace.push({name:'write-resolve', settings:this.getSettings(),at:performance.now()}); return result;
          }; return value;
        };
      }
      getSettings() { const settings = super.getSettings(); trace.push({name:'settings',settings,at:performance.now()}); return settings; }
    }
    window.MediaStreamTrackGenerator = ObservedGenerator;
    const stock = new EventTarget(); stock.readyState = 'live'; stock.stops = 0;
    stock.getSettings = () => ({ displaySurface:'monitor', width:64,height:64 }); stock.stop = () => { stock.stops++; stock.readyState='ended'; };
    const start = performance.now();
    const candidate = await exports.tryNativeScreenCapture({getVideoTracks:()=>[stock]}, {
      maxWidth:64,maxHeight:64,fps:120,nativeResolution:false,contentHint:'motion',isCurrent:()=>true,signal:new AbortController().signal,
    });
    const value = {candidate:Boolean(candidate),elapsedMs:performance.now()-start,trace};
    if (candidate) { const track=candidate.stream.getVideoTracks()[0]; value.settings=track.getSettings();candidate.commit();candidate.stop();value.afterStop=track.readyState; }
    value.stockStops=stock.stops;
    return value;
  })()`), 4000, 'adapter');
  await bounded(references, 3000, 'references');
  helper.stdin.write('released\n'); await waitMessage('done');
  result.passed = result.adapter.candidate && result.transferred && result.permitSent && result.allReferencesReleased && result.adapter.stockStops === 0;
  await finish();
}).catch(async error => { result.error = error.stack || String(error); await finish(); });
