// Real RoomList with synthetic MemoryRouter notice state; no account or service connection.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const artifacts = path.resolve(
  process.env.COVE_ROOM_KICK_ARTIFACTS ||
    path.join(__dirname, '../../../../runtime/ui-annotation-interactions/room-kick-notice'),
);
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'electron-data'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

const width = 1280;
const results = { width, checks: [], errors: [], simulatedKeys: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => app.exit(2), 45000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height: 800,
    useContentSize: true,
    show: false,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      partition: `room-kick-notice-${process.pid}`,
    },
  });
  win.webContents.setFrameRate(60);
  win.webContents.on('console-message', event => {
    if (event.level === 'error') results.errors.push(event.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => results.errors.push(details));
  const js = code => win.webContents.executeJavaScript(code, true);
  const waitFor = async code => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await js(code)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${code}`);
  };
  const check = async (code, label) => {
    const passed = Boolean(await js(code));
    results.checks.push({ label, passed });
    if (!passed) throw new Error(label);
  };
  const key = async (keyCode, modifiers = []) => {
    await js("window.__roomKickKeyReached=false;window.__roomKickKeyPrevented=false;window.__roomKickKeyProbe=event=>{window.__roomKickKeyReached=true;window.__roomKickKeyPrevented=event.defaultPrevented};window.addEventListener('keydown',window.__roomKickKeyProbe)");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await delay(60);
    // Inactive offscreen windows may not dispatch native keyboard input. This
    // fallback tests the app handler, not OS-level keyboard focus behavior.
    if (await js("!document.hasFocus()&&!window.__roomKickKeyReached")) {
      results.simulatedKeys.push({ keyCode, modifiers });
      await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(keyCode)},shiftKey:${modifiers.includes('shift')},bubbles:true,cancelable:true}))`);
    }
    await js("window.removeEventListener('keydown',window.__roomKickKeyProbe)");
  };
  const capture = async name => {
    await delay(220);
    fs.writeFileSync(path.join(artifacts, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const page = theme => `http://127.0.0.1:55373/tests/ui/room-kick-notice.fixture.html?theme=${theme}`;

  try {
    await win.loadURL(page('light'));
    await waitFor("Boolean(document.querySelector('[role=alertdialog] button'))");
    await check("document.documentElement.dataset.theme === 'light'", 'light palette applied');
    await check(
      "document.querySelector('[role=alertdialog]')?.getAttribute('aria-modal') === 'true' && document.querySelector('[role=alertdialog] h2')?.textContent.trim() === '已被移出频道'",
      'notice has accessible modal semantics and the requested title',
    );
    await check(
      "document.querySelector('#room-kick-notice-copy')?.textContent === '你已被测试房主移出频道。'",
      'fixture message is announced',
    );
    await check(
      "document.activeElement === document.querySelector('[role=alertdialog] button')",
      'initial focus is on the confirmation action',
    );
    await check(
      "getComputedStyle(document.querySelector('.remote-notice-dialog')).backgroundColor !== 'rgba(0, 0, 0, 0)'",
      'light dialog has a painted surface',
    );
    await key('Tab');
    await check(
      "window.__roomKickKeyPrevented && document.activeElement === document.querySelector('[role=alertdialog] button')",
      'Tab remains contained in the one-action notice',
    );
    await key('Tab', ['shift']);
    await check(
      "window.__roomKickKeyPrevented && document.activeElement === document.querySelector('[role=alertdialog] button')",
      'Shift+Tab remains contained in the one-action notice',
    );
    await capture('light-dialog');
    const action = await js("(()=>{const r=document.querySelector('[role=alertdialog] button').getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
    win.webContents.sendInputEvent({type:'mouseMove',...action});
    win.webContents.sendInputEvent({type:'mouseDown',...action,button:'left',clickCount:1});
    await delay(40);
    win.webContents.sendInputEvent({type:'mouseUp',...action,button:'left',clickCount:1});
    await waitFor("!document.querySelector('[role=alertdialog]')");
    await check("!document.querySelector('[role=alertdialog]')", 'clicking the confirmation dismisses the notice');

    await win.loadURL(page('dark'));
    await waitFor("Boolean(document.querySelector('[role=alertdialog] button'))");
    await check("document.documentElement.dataset.theme === 'dark'", 'dark palette applied');
    await check(
      "getComputedStyle(document.querySelector('.remote-notice-dialog')).backgroundColor !== 'rgba(0, 0, 0, 0)'",
      'dark dialog has a painted surface',
    );
    await capture('dark-dialog');
    await key('Escape');
    await waitFor("!document.querySelector('[role=alertdialog]')");
    await check("!document.querySelector('[role=alertdialog]')", 'Escape dismisses the notice');

    if (results.errors.length) throw new Error(`Renderer errors: ${JSON.stringify(results.errors)}`);
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ passed: true, ...results }, null, 2));
    console.log(`PASS: ${results.checks.length} RoomList kick-notice checks at ${width}px`);
    clearTimeout(timeout);
    win.destroy();
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ passed: false, ...results, error: String(error) }, null, 2));
    console.error(error);
    clearTimeout(timeout);
    win.destroy();
    app.exit(1);
  }
});
