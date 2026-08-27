// Requires Vite on localhost:5173 and `npm run electron:compile -w client`.
// Run with the workspace Electron executable, not Node. Uses the real main process,
// permission handlers, production hook and control; no room or microphone is used.
const { app, session, screen } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const artifacts = path.resolve(__dirname, '../../..', 'tmp/fullscreen-regression');
fs.mkdirSync(artifacts, { recursive: true });
app.commandLine.appendSwitch('user-data-dir', path.join(artifacts, 'profile'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('Fullscreen QA timed out'); app.exit(1); }, 45000);

app.whenReady().then(async () => {
  const permissions = [];
  const original = session.defaultSession.setPermissionRequestHandler.bind(session.defaultSession);
  session.defaultSession.setPermissionRequestHandler = handler => original(handler && ((wc, permission, callback, details) => {
    handler(wc, permission, allowed => {
      permissions.push({ permission, allowed, mainFrame: details.isMainFrame });
      callback(allowed);
    }, details);
  }));
  const created = new Promise(resolve => app.once('browser-window-created', (_event, win) => resolve(win)));
  require('../../dist-electron/main.js');
  const win = await created;
  const passed = [];
  try {
    await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.closeDevTools();
    await win.loadURL('http://localhost:5173/tests/ui/media-controls.html');
    win.focus();
    const js = code => win.webContents.executeJavaScript(code);
    const waitFor = async (check, description) => {
      for (let i = 0; i < 60; i++) {
        if (await check()) return;
        await delay(50);
      }
      throw new Error(`Timed out: ${description}`);
    };
    const center = selector => js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`);
    const move = p => win.webContents.sendInputEvent({ type: 'mouseMove', ...p });
    const click = async selector => {
      const p = await center(selector);
      move(p);
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', ...p, clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', ...p, clickCount: 1 });
    };
    const key = keyCode => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    };
    await waitFor(() => js('!!document.querySelector(".cove-screen-container")'), 'fixture ready');
    const boundsBefore = win.getBounds();
    const assertNormal = async () => {
      await waitFor(async () => !win.isFullScreen() && await js('!document.fullscreenElement && document.querySelector(".cove-screen-container")?.dataset.maximized === "false" && !!document.querySelector(\'button[aria-label="窗口全屏"]\')'), 'normal room layout');
      assert.deepEqual(win.getBounds(), boundsBefore, 'original desktop window bounds');
    };
    const enterNative = async () => {
      move(await center('button[aria-controls]'));
      await waitFor(() => js('document.querySelector("button[aria-controls]")?.getAttribute("aria-expanded") === "true"'), 'fullscreen dropdown');
      await click('button[aria-pressed]');
      await waitFor(async () => win.isFullScreen() && await js('!!document.fullscreenElement && !!document.querySelector(\'button[aria-label="退出全屏"]\')'), 'native fullscreen');
      assert.deepEqual(win.getBounds(), screen.getDisplayMatching(win.getBounds()).bounds, 'entire monitor covered');
    };
    const enterWindow = async () => {
      await click('button[aria-label="窗口全屏"]');
      await waitFor(() => js('document.querySelector(".cove-screen-container")?.dataset.maximized === "true"'), 'window fullscreen');
      assert.equal(win.isFullScreen(), false);
    };

    await enterNative();
    move(await center('button[aria-label="退出全屏"]'));
    await js('document.querySelector(\'button[aria-label="退出全屏"]\').focus()');
    key('ArrowDown');
    await delay(200);
    assert.equal(await js('document.querySelectorAll("button[aria-controls], button[aria-pressed]").length'), 0, 'native mode must not render a dropdown, even on hover/focus');
    fs.writeFileSync(path.join(artifacts, 'native-single-exit.png'), (await win.webContents.capturePage()).toPNG());
    await click('button[aria-label="退出全屏"]');
    await assertNormal();
    passed.push('native fullscreen: one exit button, no dropdown, click restores room and window');

    await enterWindow();
    await click('button[aria-label="退出窗口全屏"]');
    await assertNormal();
    passed.push('window fullscreen still enters/exits independently');

    await enterWindow();
    await enterNative();
    await click('button[aria-label="退出全屏"]');
    await assertNormal();
    passed.push('window -> native -> exit clears BOTH fullscreen modes');

    await enterWindow();
    await enterNative();
    key('Escape');
    await assertNormal();
    passed.push('window -> native -> Esc restores normal layout');

    await enterNative();
    // Simulate remote share ending while native fullscreen hides the room header.
    await js('document.querySelector(\'[data-testid="toggle-share"]\').click()');
    await waitFor(async () => !win.isFullScreen() && await js('!document.fullscreenElement && !document.querySelector(".cove-screen-container")'), 'share end exits native mode');
    await click('[data-testid="toggle-share"]');
    await assertNormal();
    await enterNative();
    await click('button[aria-label="退出全屏"]');
    await assertNormal();
    passed.push('share end exits fullscreen; new share can enter and exit again');

    assert.ok(permissions.some(item => item.permission === 'fullscreen' && item.allowed));
    const result = { passed, permissions, boundsBefore, boundsAfter: win.getBounds() };
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    clearTimeout(timeout);
  }
}).then(() => app.exit(0), error => { console.error(error.stack); app.exit(1); });
