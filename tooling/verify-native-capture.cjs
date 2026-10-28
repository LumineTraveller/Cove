'use strict';
// Native API diagnosis only. Reuses the existing owned pattern and never opens
// a production profile, SFU, microphone, arbitrary source or image output.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const namespace = path.join(root, 'runtime/fps-validation-efficiency-20261028');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function selectedModes(value = '') {
  const modes = value ? value.split(',') : ['acquire-only', 'readback', 'readback-copy'];
  const allowed = ['acquire-only', 'readback', 'readback-copy', 'gpu-scaled-readback-copy'];
  if (!modes.length || modes.length > 6 || modes.some(mode => !allowed.includes(mode))) throw Error('Invalid bounded native mode list');
  return modes;
}
function inside(parent, target) {
  const relative = path.relative(parent, target);
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
function options(args) {
  const value = name => args[args.indexOf(name) + 1];
  if (args.length !== 4 || args[0] !== '--exe' || args[2] !== '--seconds')
    throw Error('Usage: node tooling/verify-native-capture.cjs --exe <owned runtime probe.exe> --seconds <1..20>');
  const executable = path.resolve(value('--exe'));
  const seconds = Number(value('--seconds'));
  if (!inside(namespace, executable) || path.extname(executable).toLowerCase() !== '.exe' || !fs.statSync(executable).isFile())
    throw Error('The compiled probe must be inside this investigation runtime');
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 20) throw Error('Invalid bounded duration');
  return { executable, seconds };
}
function patternHtml() {
  const ts = require('typescript');
  const input = fs.readFileSync(path.join(root, 'apps/desktop/tests/ui/screen-performance.electron.cjs'), 'utf8');
  const ast = ts.createSourceFile('owned-source.cjs', input, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'source' && node.initializer &&
      ts.isNoSubstitutionTemplateLiteral(node.initializer)) found.push(node.initializer.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (found.length !== 1 || !found[0].includes('window.sourceFrames=frames')) throw Error('Known owned source was not found uniquely');
  return found[0];
}
async function launch() {
  const config = options(process.argv.slice(2));
  fs.mkdirSync(namespace, { recursive: true });
  const directory = fs.mkdtempSync(path.join(namespace, 'native-api-'));
  const modes = selectedModes(process.env.COVE_NATIVE_MODES);
  const env = { ...process.env, COVE_NATIVE_RUN_DIR: directory, COVE_NATIVE_EXE: config.executable, COVE_NATIVE_SECONDS: String(config.seconds), COVE_NATIVE_MODES: modes.join(',') };
  delete env.ELECTRON_RUN_AS_NODE;
  const descriptor = fs.openSync(path.join(directory, 'electron.log'), 'w');
  const child = spawn(require(path.join(root, 'apps/desktop/node_modules/electron')), [__filename],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', descriptor, descriptor, 'ipc'] });
  let interrupted = false;
  let stopping;
  const cancel = () => {
    interrupted = true;
    if (stopping) return stopping;
    stopping = (async () => {
      if (child.connected) child.send({ type: 'stop' }, () => {});
      for (let n = 0; n < 30 && child.exitCode === null && child.signalCode === null; n++) await delay(100);
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Only the exact process tree created by this launcher is a fallback target.
      await new Promise(resolve => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { child.kill(); resolve(); }); killer.once('close', resolve);
      });
    })();
    return stopping;
  };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const watchdog = setTimeout(() => void cancel(), modes.length * (config.seconds + 30) * 1000 + 20000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(watchdog); await stopping; fs.closeSync(descriptor); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
  const resultPath = path.join(directory, 'result.json');
  const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
  console.log(JSON.stringify({ directory: path.relative(root, directory), exitCode: code, interrupted, result }, null, 2));
  process.exitCode = code || interrupted || !result?.passed ? 1 : 0;
}
async function runElectron() {
  const { app, BrowserWindow, screen } = require('electron');
  const directory = path.resolve(process.env.COVE_NATIVE_RUN_DIR || '');
  const executable = path.resolve(process.env.COVE_NATIVE_EXE || '');
  const seconds = Number(process.env.COVE_NATIVE_SECONDS);
  if (!inside(namespace, directory) || !inside(namespace, executable) || !Number.isInteger(seconds) || seconds < 1 || seconds > 20)
    throw Error('Invalid isolated native capture configuration');
  const profile = path.join(directory, 'profile'); fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile); app.setPath('sessionData', profile);
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  let window, activeChild, stopped = false;
  const result = { passed: false, startedAt: new Date().toISOString(), scope: 'Native DXGI API timings with owned full-screen pattern; excludes encoder, SFU and receiver.',
    personalPixelsRetained: false, secondsPerMode: seconds, modes: [],
    executableSha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex') };
  const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  const cancel = () => { stopped = true; activeChild?.kill(); };
  process.on('message', message => { if (message?.type === 'stop') cancel(); });
  process.once('disconnect', cancel);
  app.on('window-all-closed', () => {});
  async function probe(args) {
    if (stopped) throw Error('Owned native experiment cancelled');
    return new Promise((resolve, reject) => {
      let output = '', error = '', settled = false;
      const child = spawn(executable, args, { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      activeChild = child;
      const timeout = setTimeout(() => { child.kill(); finish(Error('Native probe timeout')); }, (seconds + 30) * 1000);
      function finish(cause, value) { if (settled) return; settled = true; clearTimeout(timeout); if (activeChild === child) activeChild = null; cause ? reject(cause) : resolve(value); }
      child.once('error', finish);
      child.stdout.on('data', data => { output += data; if (output.length > 2 * 1024 * 1024) { child.kill(); finish(Error('Unexpected native output size')); } });
      child.stderr.on('data', data => { error += data; if (error.length > 65536) { child.kill(); finish(Error('Unexpected native error size')); } });
      child.once('close', code => {
        let data; try { data = JSON.parse(output.trim() || error.trim()); } catch { return finish(Error('Native probe returned invalid JSON: ' + error.slice(0, 1000))); }
        if (code !== 0) return finish(Error('Native probe failed (' + code + '): ' + JSON.stringify(data)));
        finish(null, data);
      });
    });
  }
  try {
    result.phase = 'waiting-for-electron'; save();
    await app.whenReady();
    result.versions = process.versions;
    result.phase = 'gpu-self-test'; save();
    result.selfTest = await probe(['--self-test']); save();
    const html = patternHtml(); result.patternSha256 = crypto.createHash('sha256').update(html).digest('hex');
    const primary = screen.getPrimaryDisplay();
    result.display = { bounds: primary.bounds, scaleFactor: primary.scaleFactor, displayFrequency: primary.displayFrequency };
    window = new BrowserWindow({ frame: false, show: false, title: 'Cove owned native API test — Escape cancels',
      webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    window.webContents.on('before-input-event', (_event, input) => { if (input.key === 'Escape') cancel(); });
    window.on('closed', cancel);
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    window.setFullScreen(true); window.show(); window.focus(); await delay(1500);
    const handle = window.getNativeWindowHandle();
    const hwnd = '0x' + (handle.length === 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString(16);
    result.window = { focused: window.isFocused(), fullscreen: window.isFullScreen(), bounds: window.getBounds(),
      ownedHwndProvided: true, ownedPidProvided: true };
    save();
    for (const mode of selectedModes(process.env.COVE_NATIVE_MODES)) {
      // Focus only at a deliberate mode boundary. Guard loss during a mode
      // still cancels it; never fight a user's window change mid-measurement.
      window.show(); window.focus(); await delay(300);
      result.phase = mode; save();
      const before = await window.webContents.executeJavaScript('window.sourceFrames');
      const startedAt = new Date().toISOString();
      const data = await probe(['--profile', '--owned-hwnd', hwnd, '--owned-pid', String(process.pid),
        '--seconds', String(seconds), '--mode', mode, '--poll-us', '1000', '--focus-wait-ms', '15000']);
      const after = await window.webContents.executeJavaScript('window.sourceFrames');
      result.modes.push({ mode, startedAt, finishedAt: new Date().toISOString(), sourceFramesBefore: before, sourceFramesAfter: after, data });
      save();
    }
    result.phase = 'complete';
    result.passed = !stopped;
  } catch (error) { result.error = error.stack || String(error); }
  finally { cancel(); if (window && !window.isDestroyed()) window.destroy(); result.finishedAt = new Date().toISOString(); save(); app.exit(result.passed ? 0 : 1); }
}
// Electron's application loader need not set require.main to this CJS module.
// Ordinary node imports remain side-effect free for contract checks.
if (process.versions.electron || require.main === module)
  (process.versions.electron ? runElectron() : launch()).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { options, patternHtml, inside, selectedModes };
