'use strict';
// One immutable synthetic texture, not a screen-capture provider or FPS test.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const runtime = path.join(root, 'runtime/shared-texture-probe');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const executable = path.join(runtime, 'helper.exe');
async function launch() {
  fs.mkdirSync(runtime, { recursive: true });
  const directory = fs.mkdtempSync(path.join(runtime, 'interop-'));
  const descriptor = fs.openSync(path.join(directory, 'electron.log'), 'w');
  const env = { ...process.env, COVE_TEXTURE_PROBE_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require(path.join(root, 'apps/desktop/node_modules/electron')), [__filename],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', descriptor, descriptor, 'ipc'] });
  const watchdog = setTimeout(() => {
    if (child.connected) child.send({ type: 'stop' }, () => {});
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }, 3000).unref();
  }, 30000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(watchdog); fs.closeSync(descriptor); }
  const output = path.join(directory, 'result.json');
  const result = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null;
  console.log(JSON.stringify({ directory: path.relative(root, directory), exitCode: code, result }, null, 2));
  process.exitCode = code || !result?.passed ? 1 : 0;
}
async function electron() {
  const { app, BrowserWindow, ipcMain, sharedTexture } = require('electron');
  const directory = path.resolve(process.env.COVE_TEXTURE_PROBE_DIR || '');
  const relative = path.relative(runtime, directory);
  if (!relative || path.isAbsolute(relative) || relative.startsWith('..' + path.sep) || relative === '..') throw Error('Isolated owned runtime required');
  const profile = path.join(directory, 'profile'); fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile); app.setPath('sessionData', profile);
  let win, helper, imported, mainReleased = false, stopping = false;
  const result = { passed: false, startedAt: new Date().toISOString(), scope: 'Single immutable synthetic BGRA texture interoperability; no capture, codec, SFU or throughput result.',
    personalPixelsRetained: false, temporaryMainHandleClosed: false, allReferencesReleased: false };
  const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  const bounded = (promise, milliseconds, label) => {
    let timer; return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error(label + '_timeout')), milliseconds); })]).finally(() => clearTimeout(timer));
  };
  const releaseMain = () => { if (imported && !mainReleased) { mainReleased = true; imported.release(); } };
  const stop = () => { stopping = true; releaseMain(); if (win && !win.isDestroyed()) win.webContents.send('probe:release'); helper?.stdin.end(); };
  process.on('message', message => { if (message?.type === 'stop') stop(); }); process.once('disconnect', stop);
  app.on('window-all-closed', () => {});
  const listeners = [];
  function fromOwnRenderer(channel, resolve) {
    const listener = (event, data) => {
      if (win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame) resolve(data);
    };
    ipcMain.on(channel, listener); listeners.push([channel, listener]);
  }
  try {
    result.phase = 'starting'; save(); await app.whenReady();
    result.versions = process.versions;
    if (typeof sharedTexture?.importSharedTexture !== 'function') throw Error('shared_texture_api_unavailable');
    const ready = new Promise(resolve => fromOwnRenderer('probe:receiver-ready', resolve));
    const nonce = crypto.randomBytes(16).toString('hex');
    const classified = new Promise(resolve => fromOwnRenderer('probe:classification', value => {
      if (value?.nonce === nonce) resolve(value);
    }));
    win = new BrowserWindow({ width: 300, height: 180, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    await win.loadURL(pathToFileURL(path.join(__dirname, 'index.html')).href);
    await bounded(ready, 5000, 'sandbox_receiver_ready');
    if (stopping) throw Error('cancelled');
    result.helperSha256 = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
    const messages = new Map(), waiters = new Map(); let invalidOutput = null, helperError = '';
    const waitMessage = type => messages.has(type) ? Promise.resolve(messages.get(type)) :
      bounded(new Promise((resolve, reject) => waiters.set(type, { resolve, reject })), 10000, type);
    helper = spawn(executable, ['--owner-pid', String(process.pid)], { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const helperExit = new Promise((resolve, reject) => { helper.once('error', reject); helper.once('close', resolve); });
    // Attach a rejection handler immediately, including failures before await.
    helperExit.catch(() => {});
    let pending = '';
    helper.stdout.on('data', chunk => {
      pending += chunk;
      if (pending.length > 65536) { invalidOutput = 'helper_output_limit'; helper.kill(); return; }
      while (pending.includes('\n')) {
        const position = pending.indexOf('\n'), line = pending.slice(0, position); pending = pending.slice(position + 1);
        try {
          const message = JSON.parse(line);
          if (!['ready', 'main-handle-closed', 'done'].includes(message.type)) throw Error('unexpected_type');
          messages.set(message.type, message); waiters.get(message.type)?.resolve(message); waiters.delete(message.type);
        } catch { invalidOutput = 'invalid_helper_message'; helper.kill(); }
      }
    });
    helper.stderr.on('data', chunk => { helperError = (helperError + chunk).slice(0, 4096); });
    helperExit.then(code => {
      result.helperExitCode = code;
      for (const waiter of waiters.values()) waiter.reject(Error(invalidOutput || helperError || 'helper_exited_before_message'));
      waiters.clear();
    }, error => { for (const waiter of waiters.values()) waiter.reject(error); waiters.clear(); });
    const frame = await waitMessage('ready');
    if (frame.ownerPid !== process.pid || frame.helperPid !== helper.pid || frame.width !== 64 || frame.height !== 64 ||
      frame.timestamp !== 1000 || frame.producerGpuComplete !== true || !/^0x[0-9a-f]{1,16}$/i.test(frame.mainHandle)) throw Error('invalid_owned_texture_metadata');
    const handle = Buffer.alloc(8); handle.writeBigUInt64LE(BigInt(frame.mainHandle));
    let allReleased;
    const references = new Promise(resolve => { allReleased = resolve; });
    result.phase = 'importing'; save();
    try {
      imported = sharedTexture.importSharedTexture({ textureInfo: { handle: { ntHandle: handle }, codedSize: { width: 64, height: 64 }, pixelFormat: 'bgra', timestamp: 1000 },
        allReferencesReleased: () => { result.allReferencesReleased = true; allReleased(); } });
    } finally { handle.fill(0); }
    helper.stdin.write('imported\n');
    await waitMessage('main-handle-closed'); result.temporaryMainHandleClosed = true;
    await bounded(sharedTexture.sendSharedTexture({ frame: win.webContents.mainFrame, importedSharedTexture: imported }, nonce), 3000, 'texture_transfer');
    result.transferComplete = true; releaseMain(); win.webContents.send('probe:release');
    result.classification = await bounded(classified, 5000, 'texture_classification');
    // Nonce correlates owned IPC, it is not useful in retained diagnostics.
    delete result.classification.nonce;
    await bounded(references, 5000, 'all_references_released');
    helper.stdin.write('released\n'); await waitMessage('done'); helper.stdin.end();
    const exit = await bounded(helperExit, 3000, 'helper_exit');
    result.passed = exit === 0 && !stopping && result.classification.passed === true && result.classification.frameClosed &&
      result.temporaryMainHandleClosed && result.allReferencesReleased;
    result.phase = 'complete';
  } catch (error) { result.error = error.stack || String(error); }
  finally {
    stop();
    if (helper && helper.exitCode === null && helper.signalCode === null) {
      for (let n = 0; n < 20 && helper.exitCode === null && helper.signalCode === null; n++) await delay(50);
      if (helper.exitCode === null && helper.signalCode === null) helper.kill();
    }
    for (const [channel, listener] of listeners) ipcMain.off(channel, listener);
    if (win && !win.isDestroyed()) win.destroy();
    result.finishedAt = new Date().toISOString(); save(); app.exit(result.passed ? 0 : 1);
  }
}
if (process.versions.electron || require.main === module)
  (process.versions.electron ? electron() : launch()).catch(error => { console.error(error); process.exitCode = 1; });
