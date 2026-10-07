// Hidden owned window: actual ShareViewV2, Fullscreen API and trusted renderer events.
const { app, BrowserWindow, screen } = require('electron');
const fs = require('fs'), path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const assert = require('assert/strict');
const out = path.resolve(__dirname, '../runtime/fullscreen-edge');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'hidden-profile'));
app.setPath('sessionData', path.join(out, 'hidden-session'));
if (process.env.COVE_EDGE_DEVICE_SCALE) app.commandLine.appendSwitch('force-device-scale-factor', process.env.COVE_EDGE_DEVICE_SCALE);
const delay = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, minWidth: 1100, minHeight: 600,
    resizable: true, frame: false, titleBarStyle: 'hidden', show: false, focusable: false,
    webPreferences: { backgroundThrottling: false, offscreen: true } });
  // Windows can mark an HTML fullscreen window visible again on exit.
  // Keep the owned offscreen test hidden at every such transition.
  win.on('show', () => win.hide());
  const js = s => win.webContents.executeJavaScript(s, true);
  win.webContents.session.setPermissionRequestHandler((wc, p, cb, details) =>
    cb(p === 'fullscreen' && wc === win.webContents && details.isMainFrame));
  win.webContents.session.setPermissionCheckHandler((wc, p, _origin, details) =>
    p === 'fullscreen' && wc === win.webContents && details.isMainFrame);
  try {
    await win.loadURL('http://127.0.0.1:55179/tests/ui/fullscreen-edge-qa.html');
    for (let i = 0; i < 120; i++) {
      if (await js("document.querySelector('.remote-video-surface')?.getAttribute('aria-busy')==='false'")) break;
      await delay(25);
    }
    await js("document.querySelector('.fullscreen-stack > button').click()"); await delay(500);
    const phases = [];
    const handle = win.getNativeWindowHandle();
    const hwnd = (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
    // Leave the Electron message pump running while querying WM_NCHITTEST.
    const nativeQuery = await promisify(execFile)(path.join(out, '../fullscreen-edge-win-probe.exe'), [hwnd], { windowsHide: true, encoding: 'utf8' });
    const nativeHitTest = JSON.parse(nativeQuery.stdout);
    for (const zoom of [1, 1.25, 1.5]) {
      win.webContents.setZoomFactor(zoom); await delay(120);
      await js('edgeQa.rows.length=0');
      const inspect = await js('edgeQa.inspect()');
      for (const y of [0, 1, 2, 10]) for (const x of [0, 1, Math.floor(inspect.viewport.width/2), inspect.viewport.width-1]) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x*zoom), y: Math.round(y*zoom) });
        await delay(20);
      }
      phases.push({ zoom, inspect, rows: await js('edgeQa.rows') });
      if (process.env.COVE_EDGE_EXPECT_FIXED) {
        assert.equal(inspect.fullscreen, 'video-surface');
        assert.equal(inspect.points[0].hit, 'VIDEO');
        assert.equal(inspect.points[0].mapped.y, 0);
        assert.equal(phases.at(-1).rows.filter(r => r.stage === 'sent' && r.type === 'pointer').length, 16);
      }
    }
    win.webContents.setZoomFactor(1);
    await js('document.exitFullscreen()'); await delay(150);
    const exited = !win.isFullScreen() && await js('document.fullscreenElement===null');
    await js("document.querySelector('.fullscreen-stack > button').click()"); await delay(200);
    const reentered = win.isFullScreen() && await js("document.fullscreenElement?.className==='video-surface'");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await delay(150);
    const escaped = !win.isFullScreen() && await js('document.fullscreenElement===null');
    // Exit through the actual Fullscreen API even if an offscreen window did
    // not receive an OS Escape transition; record this distinction below.
    if (!escaped) await js('document.exitFullscreen()');
    await js('edgeQa.setActive(false)'); await delay(80); await js('edgeQa.rows.length=0');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 200, y: 80 }); await delay(30);
    const stoppedInputs = await js("edgeQa.rows.filter(r=>r.stage==='sent').length");
    assert.equal(exited, true); assert.equal(reentered, true); assert.equal(stoppedInputs, 0);
    win.hide();
    const report = { observedAt: new Date().toISOString(), hidden: !win.isVisible(), offscreenRendering: true,
      nativeFullscreen: win.isFullScreen(), bounds: win.getBounds(), contentBounds: win.getContentBounds(),
      hwnd, nativeHitTest, exited, reentered, escaped, stoppedInputs,
      displays: screen.getAllDisplays().map(d => ({ bounds: d.bounds, scaleFactor: d.scaleFactor })), phases };
    const name = process.env.COVE_EDGE_DEVICE_SCALE ? `fixed-hidden-scale-${process.env.COVE_EDGE_DEVICE_SCALE}.json` : 'hidden-inspection.json';
    fs.writeFileSync(path.join(out, name), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ observedAt: report.observedAt, hidden: report.hidden, exited, reentered, escaped, stoppedInputs,
      nativeTopHits: nativeHitTest.rows, displays: report.displays,
      phases: phases.map(p => ({ zoom: p.zoom, viewport: p.inspect.viewport, topMapped: p.inspect.points[0].mapped,
        sent: p.rows.filter(r => r.stage === 'sent').length, rawEvents: p.rows.filter(r => r.stage === 'pointerrawupdate').length })) }, null, 2));
  } finally { win.destroy(); app.quit(); }
}).catch(e => { console.error(e); app.exit(1); });
