// Finite, hidden, owned browser fixture. Synthetic pointer events only.
// No Socket.IO connection, media capture, focus change or Windows injection.
const { app, BrowserWindow } = require('electron');
const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const runDir = path.join(root, 'runtime/remote-input-browser');
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'user-data'));
app.setPath('sessionData', path.join(runDir, 'session-data'));
app.commandLine.appendSwitch('disable-http-cache');
const baseline = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'show',
  'checkpoint/published-main-65df169:apps/desktop/src/features/remote-control/remoteControl.ts'],
  { cwd: root, windowsHide: true, encoding: 'utf8' });
fs.writeFileSync(path.join(runDir, 'baseline.ts'), baseline);
const candidateSource = fs.readFileSync(path.join(root, 'apps/desktop/src/features/remote-control/remoteControl.ts'), 'utf8');
const browserCode = ['window.senders = {};', ...[['Baseline', baseline], ['Candidate', candidateSource]].map(([label, source]) =>
  `(() => { const exports = {}; ${ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  } }).outputText} window.senders.${label} = exports.RemotePointerSender; })();`)].join('\n');
fs.writeFileSync(path.join(runDir, 'senders.js'), browserCode);
fs.writeFileSync(path.join(runDir, 'index.html'), '<!doctype html><div id="target"></div><script src="senders.js"></script>');
const watchdog = setTimeout(() => { console.error('Browser fixture exceeded 15 seconds'); app.exit(1); }, 15_000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(runDir, 'index.html'));
  const results = await win.webContents.executeJavaScript(`(async () => {
    const rows = [];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (const [label, Sender] of Object.entries(window.senders)) {
      const target = document.getElementById('target');
      const samples = new Map();
      const sent = [];
      const sender = new Sender(input => sent.push({ at: performance.now(), sampled: samples.get(input.x), x: input.x }));
      const move = event => { const x = event.clientX / 144; samples.set(x, performance.now()); sender.send({ type: 'pointer', x, y: .5 }); };
      target.addEventListener('pointermove', move);
      const start = performance.now();
      for (let index = 0; index < 144; index++) {
        const due = start + index * 1000 / 144;
        while (performance.now() < due) await sleep(Math.max(1, due - performance.now()));
        target.dispatchEvent(new PointerEvent('pointermove', { clientX: index, clientY: 1 }));
      }
      await sleep(20);
      sender.cancel();
      target.removeEventListener('pointermove', move);
      const ages = sent.map(row => row.at - row.sampled).sort((a, b) => a - b);
      const gaps = sent.slice(1).map((row, i) => row.at - sent[i].at).sort((a, b) => a - b);
      rows.push({ label, sampled: 144, emitted: sent.length, lastSampleIndex: Math.round(sent.at(-1).x * 144),
        meanAgeMs: ages.reduce((a,b) => a+b, 0) / ages.length,
        p95AgeMs: ages[Math.ceil(ages.length * .95) - 1], maxAgeMs: ages.at(-1),
        p95SendGapMs: gaps[Math.ceil(gaps.length * .95) - 1], maxSendGapMs: gaps.at(-1) });
    }
    return rows;
  })()`);
  const [baselineResult, candidate] = results;
  if (results.some(row => row.lastSampleIndex !== 143) || candidate.emitted <= baselineResult.emitted)
    throw new Error('Candidate did not retain more real sampled positions or lost the final tail');
  const report = { capturedAt: new Date().toISOString(), electron: process.versions.electron,
    chromium: process.versions.chrome, scope: 'hidden Chromium synthetic DOM pointermove -> actual sender and browser timers',
    excluded: ['real hardware', 'network', 'native injection', 'video feedback'], results };
  fs.writeFileSync(path.join(root, 'runtime/remote-input-browser-timing.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  win.destroy();
  clearTimeout(watchdog);
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1); });
