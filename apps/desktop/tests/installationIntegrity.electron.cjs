// Isolated renderer fixture only: random loopback Vite port, private temporary
// profile, hidden/offscreen BrowserWindow, mocked bridge, and no external traffic.
// Run with apps/desktop/node_modules/electron/dist/electron.exe and this file.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const repo = path.resolve(__dirname, '../../..');
const runtime = path.join(repo, 'runtime', 'installation-integrity-ui');
fs.mkdirSync(runtime, { recursive: true });
const profile = fs.mkdtempSync(path.join(runtime, 'profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'session'));
app.setPath('crashDumps', path.join(profile, 'crashes'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => { console.error('Integrity UI fixture timed out'); app.exit(1); }, 55_000);
let server;

async function randomPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

app.whenReady().then(async () => {
  let win;
  try {
    const { createServer } = await import('vite');
    const port = await randomPort();
    server = await createServer({
      configFile: false, root: path.resolve(__dirname, '..'),
      cacheDir: path.join(runtime, 'vite-cache'), logLevel: 'error',
      resolve: { alias: { '@cove/contracts': path.join(repo, 'packages/contracts/src/index.ts') } },
      css: { postcss: { plugins: [] } },
      optimizeDeps: { entries: ['tests/fixtures/installation-integrity.html'] },
      server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [repo] } },
    });
    await server.listen();
    const origin = `http://127.0.0.1:${port}`;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith(`${origin}/`) && !details.url.startsWith(`ws://127.0.0.1:${port}/`) && !details.url.startsWith('devtools:') });
    });
    win = new BrowserWindow({ width: 1000, height: 940, show: false,
      webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.webContents.on('console-message', ({ message }) => {
      if (/error|failed|uncaught/i.test(message)) console.error('fixture renderer:', message);
    });
    await win.loadURL(`${origin}/tests/fixtures/installation-integrity.html`);
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const timer = setInterval(() => {
        if (window.integrityFixture && document.querySelector('.installation-integrity')) { clearInterval(timer); resolve(true); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('fixture did not mount')); }
      }, 25);
    })`);
    const render = async (state, theme = 'light') => {
      await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; window.integrityFixture.emit(${JSON.stringify(state)}); true`);
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    };
    const measure = () => win.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.installation-integrity');
      const page = document.querySelector('.settings-page');
      return { panel: { width: panel.clientWidth, scroll: panel.scrollWidth }, page: { width: page.clientWidth, scroll: page.scrollWidth }, text: panel.innerText,
        calls: window.integrityFixture.calls, buttons: [...panel.querySelectorAll('button')].map(b => ({ text: b.innerText, disabled: b.disabled })) };
    })()`);
    const states = ['idle', 'checking', 'healthy', 'damaged', 'unavailable', 'downloading', 'downloaded', 'confirming', 'launching', 'error', 'disabled'];
    for (const status of states) {
      await render({ status, repairAvailable: true, checkedFiles: 25, totalFiles: 100, progress: { transferred: 40_000_000, total: 100_000_000, percent: 40 } });
      const result = await measure();
      assert.equal(result.panel.scroll, result.panel.width, `${status}: panel overflow`);
      assert.equal(result.calls.launches, 0, `${status}: no automatic launch`);
      assert.equal(result.calls.checks, 0, `${status}: no automatic check`);
      assert.equal(result.calls.downloads, 0, `${status}: no automatic download`);
    }
    const damaged = { status: 'damaged', repairAvailable: true, checkedFiles: 146, totalFiles: 146, checkedAt: 1_792_320_000_000,
      issueCount: 27, issues: ['missing', 'modified', 'unreadable', 'unsafe'].map((kind, index) => ({ kind, path: `resources/${'very-long-relative-directory/'.repeat(5)}file-${index}.bin` })) };
    for (const theme of ['light', 'dark']) {
      await render(damaged, theme);
      const result = await measure();
      assert.equal(result.panel.scroll, result.panel.width, `${theme}: long path overflow`);
      fs.writeFileSync(path.join(runtime, `integrity-damaged-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    }
    win.setSize(440, 940);
    // The desktop screenshot above includes the existing update center. At
    // narrow widths, inspect this new panel independently of its older layout.
    await win.webContents.executeJavaScript("document.querySelector('.integrity-fixture').classList.add('integrity-fixture-panel-only'); true");
    await render(damaged, 'dark');
    const narrow = await measure();
    assert.equal(narrow.panel.scroll, narrow.panel.width, 'narrow: long path overflow');
    assert.equal(narrow.page.scroll, narrow.page.width, 'narrow: settings overflow');
    fs.writeFileSync(path.join(runtime, 'integrity-narrow-dark.png'), (await win.webContents.capturePage()).toPNG());
    await render({ status: 'downloaded', repairAvailable: true }, 'dark');
    const before = await measure();
    assert.equal(before.calls.launches, 0);
    await win.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('.installation-integrity button')].find(b => b.innerText.includes('退出并修复'));
      button.focus(); if (document.activeElement !== button) throw new Error('repair button cannot focus');
      button.click(); return true;
    })()`);
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const after = await measure();
    assert.equal(after.calls.launches, 1);
    assert.ok(after.buttons.some(button => button.text.includes('退出并修复') && !button.disabled), 'cancelled native confirmation retains ready state');
    fs.writeFileSync(path.join(runtime, 'integrity-ready-dark.png'), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(runtime, 'fixture-results.json'), JSON.stringify({ states, before, after, narrow, profile, port }, null, 2));
    console.log(`Integrity UI fixture: PASS (${states.length} states; light/dark/narrow; manual launch only). Evidence: ${runtime}`);
    clearTimeout(watchdog);
    win.destroy();
    await server.close();
    app.exit(0);
  } catch (error) {
    console.error('Integrity UI fixture: FAIL', error);
    clearTimeout(watchdog);
    win?.destroy();
    if (server) await server.close();
    app.exit(1);
  }
});
