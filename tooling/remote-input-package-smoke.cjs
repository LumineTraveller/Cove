// Actual packaged Cove.exe/ASAR startup, paused before app code by the local
// inspector. Test-only guards keep profiles, windows, updater and OS input
// separate from the user's running Cove. No installer is executed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const { createHash } = require('node:crypto');
const WebSocket = require('ws');
const asar = require('@electron/asar');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const root = path.resolve(__dirname, '..');
const appDir = path.join(root, 'apps/desktop/dist-app-remote-input-2.0.1/win-unpacked');
const archive = path.join(appDir, 'resources/app.asar');
const executable = path.join(appDir, 'Cove.exe');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function guards(testDir, appDir, fixture) {
  const electron = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const Module = require('node:module');
  const cp = require('node:child_process');
  const { PassThrough } = require('node:stream');
  for (const name of ['profile', 'session']) fs.mkdirSync(path.join(testDir, name), { recursive: true });
  electron.app.setPath('userData', path.join(testDir, 'profile'));
  electron.app.setPath('sessionData', path.join(testDir, 'session'));
  const shortcuts = new Map();
  const state = { windows: [], journal: [], helpers: [], holdAcks: false, heldAcks: [], updaterStubbed: false };
  const fakeShortcuts = {
    register: (key, callback) => { shortcuts.set(key, callback); return true; },
    unregister: key => shortcuts.delete(key), unregisterAll: () => shortcuts.clear(),
    isRegistered: key => shortcuts.has(key),
  };
  class HiddenWindow extends electron.BrowserWindow {
    constructor(options) {
      super({ ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
      state.windows.push(this);
    }
  }
  const originalLoad = Module._load;
  Module._load = function (name, parent, ...args) {
    if (name === 'electron') return { ...electron, BrowserWindow: HiddenWindow, globalShortcut: fakeShortcuts };
    if (name === './updater' && parent?.filename.replaceAll('\\', '/').endsWith('/dist-electron/main.js')) {
      return { startAutoUpdater: () => { state.updaterStubbed = true; return null; }, openUpdaterLog: async () => false };
    }
    return originalLoad.call(this, name, parent, ...args);
  };
  const originalSpawn = cp.spawn;
  const nativePath = path.join(appDir, 'resources/remote-input-helper.exe').toLowerCase();
  cp.spawn = function (file, args, options) {
    if (typeof file !== 'string' || path.resolve(file).toLowerCase() !== nativePath)
      return originalSpawn.call(this, file, args, options);
    // Exact, checked redirection. No production pointer command reaches OS.
    const child = originalSpawn.call(this, fixture, ['0'], { ...options, windowsHide: true });
    const index = state.helpers.length;
    const info = { pid: child.pid, redirected: true, closed: false, sequences: [] };
    state.helpers.push(info);
    const originalOutput = child.stdout;
    const forwarded = new PassThrough();
    child.stdout = forwarded;
    let buffered = '';
    originalOutput.on('data', chunk => {
      buffered += chunk.toString('utf8');
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const message = JSON.parse(line);
        if (message.injected) state.journal.push({ helper: index, type: message.injected.type, flags: message.injected.flags });
        else if (message.seq) {
          info.sequences.push(message.seq);
          if (state.holdAcks) state.heldAcks.push({ forwarded, line });
          else forwarded.write(line + '\n');
        } else forwarded.write(line + '\n');
      }
    });
    originalOutput.on('end', () => { if (!state.holdAcks) forwarded.end(); });
    child.once('close', () => { info.closed = true; });
    return child;
  };
  electron.app.whenReady().then(() => {
    electron.session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_details, done) => done({ cancel: true }));
    electron.session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  });
  globalThis.__covePackageSmoke = {
    status: () => ({ version: electron.app.getVersion(), name: electron.app.getName(), isPackaged: electron.app.isPackaged,
      userData: electron.app.getPath('userData'), windows: state.windows.filter(win => !win.isDestroyed()).length,
      visible: state.windows.filter(win => !win.isDestroyed()).some(win => win.isVisible()),
      journal: state.journal, helpers: state.helpers, shortcuts: shortcuts.size, updaterStubbed: state.updaterStubbed }),
    renderer: code => state.windows[0].webContents.executeJavaScript(code),
    foreign: async code => {
      const win = new HiddenWindow({ webPreferences: { contextIsolation: true, nodeIntegration: false,
        preload: path.join(appDir, 'resources/app.asar/dist-electron/preload.js') } });
      try { await win.loadURL('data:text/html,<body>owned-foreign-frame</body>'); return await win.webContents.executeJavaScript(code); }
      finally { win.destroy(); }
    },
    hold: () => { state.holdAcks = true; },
    releaseLateAcks: () => { state.holdAcks = false; for (const entry of state.heldAcks.splice(0)) entry.forwarded.write(entry.line + '\n'); },
    emergency: () => { const callback = shortcuts.get('Control+Alt+Shift+X'); if (!callback) throw Error('No emergency callback'); callback(); },
    quit: () => electron.app.quit(),
  };
  return { guarded: true, userData: electron.app.getPath('userData') };
}

async function main() {
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  assert.equal(manifest.version, '2.0.1'); assert.equal(manifest.name, 'cove-client');
  assert.equal(manifest.coveBuildFlavor, undefined);
  for (const file of ['main.js', 'preload.js', 'remote-control.js', 'remote-input-queue.js'])
    assert.equal(hash(asar.extractFile(archive, 'dist-electron/' + file)), hash(fs.readFileSync(path.join(root, 'apps/desktop/dist-electron', file))));
  for (const helper of ['remote-input-helper.exe', 'annotation-window-helper.exe', 'application-audio-helper.exe'])
    assert.equal(hash(fs.readFileSync(path.join(appDir, 'resources', helper))), hash(fs.readFileSync(path.join(root, 'apps/desktop/build', helper))));
  const fuses = await getCurrentFuseWire(executable);
  assert.equal(fuses[FuseV1Options.EnableNodeCliInspectArguments], 49, 'inspect pause must be enabled before launching the formal app');
  const candidates = fs.readdirSync(path.join(root, 'runtime')).filter(name => name.startsWith('cove-native-input-fixture-'))
    .filter(name => !fs.readFileSync(path.join(root, 'runtime', name, 'fixture.cs'), 'utf8').includes('RejectOnce'))
    .sort((a, b) => fs.statSync(path.join(root, 'runtime', a, 'fixture.cs')).mtimeMs - fs.statSync(path.join(root, 'runtime', b, 'fixture.cs')).mtimeMs);
  assert.ok(candidates.length);
  const fixtureDir = path.join(root, 'runtime', candidates.at(-1));
  const fixtureSource = fs.readFileSync(path.join(fixtureDir, 'fixture.cs'), 'utf8');
  assert.ok(fixtureSource.includes('Console.WriteLine(new JavaScriptSerializer().Serialize(record))'));
  assert.ok(!fixtureSource.includes('extern uint SendInput('));
  assert.ok(!fixtureSource.includes('        StartMouseActivityHook();'));
  const fixture = path.join(fixtureDir, 'fixture.exe');
  assert.ok(fs.existsSync(fixture));
  const testDir = fs.mkdtempSync(path.join(root, 'runtime/packaged-remote-input-'));
  const portServer = net.createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const child = spawn(executable, [`--inspect-brk=127.0.0.1:${port}`, `--user-data-dir=${path.join(testDir, 'profile')}`],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let socket;
  let stderr = '';
  child.stdout.resume();
  const watchdog = setTimeout(() => {
    if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }, 35_000);
  try {
    const inspectorUrl = await new Promise((resolve, reject) => {
      child.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8');
        const match = stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
        if (match) resolve(match[1]);
      });
      child.once('exit', code => reject(Error('Packaged app exited before inspector: ' + code)));
    });
    socket = new WebSocket(inspectorUrl); await once(socket, 'open');
    let sequence = 0;
    const pending = new Map();
    let pausedResolve;
    const paused = new Promise(resolve => { pausedResolve = resolve; });
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.method === 'Debugger.paused') pausedResolve(message.params);
      if (message.id) {
        const request = pending.get(message.id); pending.delete(message.id);
        if (message.error) request?.reject(Error(JSON.stringify(message.error))); else request?.resolve(message.result);
      }
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    });
    await command('Runtime.enable'); await command('Debugger.enable'); await command('Runtime.runIfWaitingForDebugger');
    const pause = await paused;
    const guardExpression = `(${guards.toString()})(${JSON.stringify(testDir)},${JSON.stringify(appDir)},${JSON.stringify(fixture)})`;
    const guarded = await command('Debugger.evaluateOnCallFrame', { callFrameId: pause.callFrames[0].callFrameId,
      expression: guardExpression, returnByValue: true });
    assert.ok(!guarded.exceptionDetails, JSON.stringify(guarded.exceptionDetails));
    assert.equal(guarded.result.value.guarded, true);
    await command('Debugger.resume');
    const evaluate = async expression => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const status = () => evaluate('__covePackageSmoke.status()');
    const renderer = code => evaluate(`__covePackageSmoke.renderer(${JSON.stringify(code)})`);
    const wait = async predicate => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) { const value = await status(); if (predicate(value)) return value; await sleep(20); }
      throw Error('Packaged smoke state timeout: ' + JSON.stringify(await status()));
    };
    await wait(state => state.windows === 1 && state.updaterStubbed);
    for (let i = 0; i < 100; i++) {
      if (await renderer('Boolean(document.querySelector("#login-email") && document.querySelector("#login-password"))')) break;
      await sleep(20);
    }
    assert.equal(await renderer('Boolean(document.querySelector("#login-email") && document.querySelector("#login-password"))'), true);
    assert.equal(await renderer('document.querySelector(".auth-brand img").naturalWidth > 0'), true);
    const initial = await status();
    assert.equal(initial.isPackaged, true); assert.equal(initial.version, '2.0.1'); assert.equal(initial.visible, false);
    assert.equal(initial.userData, path.join(testDir, 'profile'));
    assert.equal(initial.journal.length, 0); assert.equal(initial.helpers.length, 0);
    const foreign = await evaluate(`__covePackageSmoke.foreign(${JSON.stringify('(async () => ({ active: await window.coveRemoteControl.setActive("foreign-session-one"), input: await window.coveRemoteControl.sendInput("foreign-session-one", {type:"key",code:"ShiftLeft",down:true}) }))()')})`);
    assert.equal(foreign.active.ok, false); assert.equal(foreign.input, false);
    const activation = await renderer('window.coveRemoteControl.setActive("packaged-smoke-session-one")');
    assert.equal(activation.ok, true);
    const active = await status();
    assert.equal(active.helpers.length, 1); assert.equal(active.helpers[0].redirected, true, 'guard must be proven before any pressed input');
    assert.equal(active.journal.length, 0, 'warmup must not inject input');
    assert.equal(await renderer('window.coveRemoteControl.sendInput("packaged-smoke-session-one",{type:"key",code:"ShiftLeft",down:true})'), true);
    assert.equal(await renderer('window.coveRemoteControl.sendInput("packaged-smoke-session-one",{type:"button",button:"left",down:true,x:.4,y:.4})'), true);
    await wait(state => state.journal.some(row => row.type === 1 && row.flags === 0) && state.journal.some(row => row.type === 0 && row.flags === 2));
    await evaluate('__covePackageSmoke.hold()');
    const accepted = await renderer('(async()=>Promise.all(Array.from({length:80},(_,i)=>window.coveRemoteControl.sendInput("packaged-smoke-session-one",{type:"pointer",x:i/80,y:.5}))))()');
    assert.ok(accepted.every(Boolean));
    const beforeStop = await status();
    assert.equal((await renderer('window.coveRemoteControl.setActive(null)')).ok, true);
    assert.equal(await renderer('window.coveRemoteControl.sendInput("packaged-smoke-session-one",{type:"pointer",x:1,y:1})'), false);
    const stopped = await wait(state => state.helpers[0].closed);
    assert.equal(stopped.shortcuts, 0);
    assert.deepEqual(stopped.journal.slice(-2).map(row => [row.type, row.flags]), [[1, 2], [0, 4]]);
    assert.ok(stopped.journal.filter(row => row.type === 0 && row.flags === 0x8001).length <= 2,
      'at most the already executing move precedes stop; the unsent burst must be discarded');
    await evaluate('__covePackageSmoke.releaseLateAcks()'); await sleep(30);
    assert.deepEqual((await status()).journal, stopped.journal); assert.equal((await status()).helpers.length, 1);
    assert.equal((await renderer('window.coveRemoteControl.setActive("packaged-smoke-session-two")')).ok, true);
    assert.equal((await status()).helpers[1].redirected, true);
    assert.equal(await renderer('window.coveRemoteControl.sendInput("packaged-smoke-session-two",{type:"key",code:"ShiftLeft",down:true})'), true);
    await wait(state => state.journal.some(row => row.helper === 1 && row.type === 1 && row.flags === 0));
    await evaluate('__covePackageSmoke.emergency()');
    await wait(state => state.helpers[1].closed);
    assert.equal(await renderer('window.coveRemoteControl.sendInput("packaged-smoke-session-two",{type:"key",code:"ShiftLeft",down:true})'), false);
    await renderer('window.coveRemoteControl.setActive(null)');
    const final = await status(); assert.equal(final.shortcuts, 0);
    assert.deepEqual(final.journal.filter(row => row.helper === 1).map(row => [row.type, row.flags]), [[1, 0], [1, 2]]);
    const report = { capturedAt: new Date().toISOString(), executable, archiveSha256: hash(fs.readFileSync(archive)),
      identity: { version: initial.version, runtimeName: initial.name, manifestName: manifest.name, appId: 'com.cove.app' },
      actualPackagedExecutableStarted: true, loginAndBrandingRendered: true, hiddenAndProfileIsolated: true,
      networkAndUpdaterIsolated: true, foreignIpcDenied: true, nativeWarmupZeroInput: true,
      authorizedIpcAccepted: true, queuedBurstAccepted: accepted.length, burstJournalBeforeRevoke: beforeStop.journal.length,
      revokeDiscardsPendingMoves: true, nativeHeldInputReleased: true, staleSessionInputDenied: true,
      lateAckCannotResume: true, emergencyStopsAndReleases: true, helpersExited: final.helpers.every(helper => helper.closed),
      nativeBoundary: 'recording-only SendInput replacement; no real system input',
      globalShortcutBoundary: 'owned callback map; no real system shortcut registration',
      excluded: ['installation/rollback execution', 'real OS cursor', 'WAN', 'video feedback'], testDir };
    const reportName = process.env.COVE_PACKAGE_SMOKE_RAW === '1' ? 'remote-input-raw-packaged-smoke.json' : 'remote-input-packaged-smoke.json';
    fs.writeFileSync(path.join(root, 'runtime', reportName), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    await command('Runtime.evaluate', { expression: '__covePackageSmoke.quit()' }); socket.close();
    await exited;
  } finally {
    clearTimeout(watchdog);
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
