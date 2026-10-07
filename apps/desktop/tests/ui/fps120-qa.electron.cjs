// Real ChatRoomV2/settings/useWebRTC UI regression. Vite serves this checkout
// on loopback. All backend/media methods come from the synthetic room fixture.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../../..');
const artifacts = path.resolve(process.env.COVE_FPS_QA_ARTIFACTS || path.join(root, 'runtime/ui-validation/fps120'));
fs.mkdirSync(artifacts, { recursive: true });
const profile = fs.mkdtempSync(path.join(artifacts, 'synthetic-profile-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const url = process.env.COVE_FPS_QA_URL || 'http://127.0.0.1:55174/tests/ui/fps120-qa.html?layout-animation';
const checks = [];
const screenshots = [];
const snapshots = [];
const rendererErrors = [];
let win;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('120 FPS UI regression timed out'); app.exit(2); }, 120_000);

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1200, height: 960, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  // Reject any native request. The fixture's synthetic media does not need it.
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.on('console-message', (_event, level, message) => {
    if (typeof level === 'number' && level >= 3) rendererErrors.push(message);
  });
  const js = source => win.webContents.executeJavaScript(source, true);
  const wait = async (source, label = source) => {
    for (let i = 0; i < 200; i++) { if (await js(source)) return; await delay(40); }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const check = async (source, label) => {
    const passed = Boolean(await js(source)); checks.push({ label, passed }); assert.equal(passed, true, label);
  };
  const click = async (selector, label) => {
    await wait(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, label);
    const point = await js(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      button.scrollIntoView({ block: 'nearest' });
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !button.contains(hit) || button.disabled) throw new Error('Control is not hittable: ' + ${JSON.stringify(label)});
      return { x, y };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(point.x), y: Math.round(point.y) });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(point.x), y: Math.round(point.y) });
    await delay(80);
  };
  const capture = async name => {
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(120);
    fs.writeFileSync(path.join(artifacts, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    screenshots.push(`${name}.png`);
    snapshots.push({ name, ...await js('window.coveFpsQa.snapshot()') });
  };
  const fps = value => `.fps-grid button:nth-child(${value === 30 ? 1 : value === 60 ? 2 : 3})`;
  const nativeToggle = '.screen-settings .settings-toggle-card:nth-of-type(1) input';
  const gameToggle = '.screen-settings .settings-toggle-card:nth-of-type(2) input';
  const joinVoice = async () => {
    await wait('Boolean(window.coveFpsQa?.ready && document.querySelector(".control-ball"))', 'real room fixture');
    await click('[title="加入语音"]', 'join synthetic voice');
    await wait('Boolean(document.querySelector(".control-ball.voice-active"))', 'voice active');
  };
  const openSettings = async () => {
    await click('[title="共享屏幕"]', 'open real screen settings');
    await wait('Boolean(document.querySelector(".screen-settings"))', 'screen settings open');
  };
  const load = async () => {
    await win.loadURL(url);
    await wait('Boolean(window.coveFpsQa?.ready)', 'fixture ready');
    await joinVoice();
    await openSettings();
  };
  const assert120Active = label => check('document.querySelector(".fps-grid button:nth-child(3)")?.classList.contains("active")', label);
  const stored = 'window.coveFpsQa.snapshot().preferences';
  try {
    await load();
    await check('[...document.querySelectorAll(".fps-grid button")].map(b=>b.textContent.trim()).join(",") === "30 fps,60 fps,120 fps"', 'real settings render 30/60/120 FPS in normal mode');
    await click('.resolution-grid button:nth-child(3)', 'choose 1080p');
    await click(fps(120), 'choose 120 FPS in normal mode');
    await assert120Active('normal mode selects 120 FPS');
    await click(nativeToggle, 'enable native resolution');
    await check('document.querySelector(".resolution-grid .active")?.textContent.includes("1080p") && [...document.querySelectorAll(".resolution-grid button")].every(b=>b.disabled)', 'native resolution preserves the 1080p preference while disabling its buttons');
    await capture('normal-120-native');
    await click(gameToggle, 'enable game mode');
    await assert120Active('enabling game mode preserves selected 120 FPS');
    await check('document.querySelector(".screen-settings input[type=checkbox]").checked && document.querySelector(".resolution-grid .active")?.textContent.includes("1080p")', 'game mode preserves native and resolution preferences');
    await click(fps(60), 'choose 60 FPS in game mode');
    await click(fps(120), 'choose 120 FPS in game mode');
    await assert120Active('game mode can select 120 FPS');
    await capture('game-120-native');
    await click(gameToggle, 'return to normal mode');
    await assert120Active('disabling game mode preserves selected 120 FPS');
    await click('.screen-settings .primary-wide', 'confirm normal screen share');
    await wait('Boolean(document.querySelector(".mode-self"))', 'synthetic normal share active');
    await wait(`${stored}.fps === 120 && ${stored}.preset === '1080p' && ${stored}.nativeResolution === true && ${stored}.gameMode === false`, 'actual hook persisted normal120 preferences');
    await check('window.coveFpsQa.snapshot().captures.some(c=>c.video?.frameRate?.ideal===120&&c.video?.frameRate?.max===120&&!c.video?.frameRate?.min)', 'real normal publishing hook requests ideal/max120 without a hard minimum');
    await check('window.coveFpsQa.snapshot().alerts.length===0', 'synthetic120 normal share completes without product alert');
    await win.webContents.session.flushStorageData();

    // A fresh renderer reads the product hook\'s stored preference. No fixture
    // state or extra localStorage save is used for this120 reload assertion.
    await load();
    await assert120Active('fresh renderer restores 120 FPS from actual hook persistence');
    await check('document.querySelector(".screen-settings input[type=checkbox]").checked && document.querySelector(".resolution-grid .active")?.textContent.includes("1080p")', 'fresh renderer restores native/resolution preferences');
    await capture('reloaded-120-native');
    await click(gameToggle, 'enable game mode after reload');
    await click('.screen-settings .primary-wide', 'confirm game mode screen share');
    await wait('Boolean(document.querySelector(".mode-self"))', 'synthetic game share active');
    await wait(`${stored}.fps === 120 && ${stored}.gameMode === true && ${stored}.nativeResolution === true && ${stored}.preset === '1080p'`, 'actual hook persisted game120 preferences');
    await check('window.coveFpsQa.snapshot().captures.some(c=>c.video?.frameRate?.ideal===120&&c.video?.frameRate?.max===120&&!c.video?.frameRate?.min)', 'real game publishing hook requests ideal/max120 without a hard minimum');
    snapshots.push({ name: 'game120-confirmed', ...await js('window.coveFpsQa.snapshot()') });

    for (const legacyFps of [30, 60]) {
      const preferences = { preset: '1440p', fps: legacyFps, audio: false, gameMode: legacyFps === 60, nativeResolution: false };
      await js(`localStorage.setItem(window.coveFpsQa.preferencesKey, ${JSON.stringify(JSON.stringify(preferences))})`);
      await load();
      await check(`document.querySelector(${JSON.stringify(fps(legacyFps))})?.classList.contains('active') && ${stored}.fps === ${legacyFps}`, `legacy${legacyFps} preference restores unchanged in the real settings UI`);
      await check('document.querySelector(".resolution-grid .active")?.textContent.includes("1440p")', `legacy${legacyFps} resolution remains intact`);
      await click(fps(120), `preview120 from legacy${legacyFps}`);
      await click('.screen-settings header .icon-btn', 'cancel pending settings');
      await check(`${stored}.fps === ${legacyFps}`, `cancel120 preview keeps the saved legacy${legacyFps} preference`);
      await openSettings();
      await check(`document.querySelector(${JSON.stringify(fps(legacyFps))})?.classList.contains('active')`, `reopening after cancel restores legacy${legacyFps}`);
    }
    await check('window.coveFpsQa.snapshot().actualProductRoom', 'checks ran on the actual product room renderer');
    const result = { passed: true, actualProductRenderer: true, actualProductScreenSettings: true,
      actualProductPreferenceHook: true, nativePermissionsDenied: true, syntheticMediaOnly: true,
      verifiesRequestedCadenceNotHardwareThroughput: true, electron: process.versions.electron,
      chromium: process.versions.chrome, url, checks, screenshots, snapshots, rendererErrors };
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
    console.log(`PASS: ${checks.length} real120 FPS UI checks (${screenshots.length} screenshots): ${path.join(artifacts, 'result.json')}`);
    clearTimeout(deadline); win.destroy(); app.exit(0);
  } catch (error) {
    try { await capture('failure'); } catch { /* renderer may be unavailable */ }
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ passed: false, checks, screenshots, snapshots, rendererErrors, error: String(error.stack ?? error) }, null, 2));
    console.error(error); clearTimeout(deadline); if (win && !win.isDestroyed()) win.destroy(); app.exit(1);
  }
});
