// Explicitly coordinated desktop test. Real ShareViewV2/Fullscreen API,
// physical Windows mouse events and production native controller/helper.
// Source sampling and captured-output replay are separate to avoid a same-host
// remote-control feedback loop. No user profile, WAN, clicks, or OS key presses.
const { app, BrowserWindow, screen } = require('electron');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { promisify } = require('util'), readline = require('readline'), assert = require('assert/strict');
if (process.env.COVE_EDGE_DESKTOP_WINDOW_GRANTED !== '1') throw Error('Desktop test window has not been coordinated');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'runtime/fullscreen-edge');
app.setPath('userData', path.join(out, 'live-profile')); app.setPath('sessionData', path.join(out, 'live-session'));
app.setAppPath(path.join(root, 'apps/desktop'));
const journal = [], failures = [];
const originalSpawn = cp.spawn;
cp.spawn = function(file, args, options) {
  const native = path.basename(String(file)) === 'remote-input-helper.exe';
  const child = originalSpawn.call(this, file, native ? [...args, '--diagnostic'] : args, options);
  if (native) { let data = ''; child.stdout.on('data', chunk => { data += chunk.toString();
    let index; while ((index = data.indexOf('\n')) >= 0) {
      const line = data.slice(0, index); data = data.slice(index + 1);
      journal.push(JSON.parse(line));
    }
  }); }
  return child;
};
const { RemoteInputController } = require('../apps/desktop/dist-electron/remote-control.js');
const native = new RemoteInputController(reason => failures.push(reason));
const delay = ms => new Promise(r => setTimeout(r, ms));
function lines(child) {
  const pending = [], buffered = [];
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line); if (pending.length) pending.shift()(value); else buffered.push(value);
  });
  return () => buffered.length ? Promise.resolve(buffered.shift()) : new Promise(resolve => pending.push(resolve));
}
app.whenReady().then(async () => {
  let win, observer; const watchdog = setTimeout(() => {
    native.stop(); observer?.stdin.write('restore\n'); win?.destroy();
    setTimeout(() => app.exit(2), 300);
  }, 25000);
  try {
    win = new BrowserWindow({ width: 1280, height: 800, minWidth: 1100, minHeight: 600,
      resizable: true, frame: false, titleBarStyle: 'hidden', show: false,
      webPreferences: { backgroundThrottling: false } });
    const js = s => win.webContents.executeJavaScript(s, true);
    win.webContents.session.setPermissionRequestHandler((wc, p, cb, details) => cb(p === 'fullscreen' && wc === win.webContents && details.isMainFrame));
    win.webContents.session.setPermissionCheckHandler((wc, p, _origin, details) => p === 'fullscreen' && wc === win.webContents && details.isMainFrame);
    await win.loadURL('http://127.0.0.1:55179/tests/ui/fullscreen-edge-qa.html');
    for (let i = 0; i < 120; i++) {
      if (await js("document.querySelector('.remote-video-surface')?.getAttribute('aria-busy')==='false'")) break;
      await delay(25);
    }
    win.show(); win.focus();
    await js("document.querySelector('.fullscreen-stack > button').click()"); await delay(350);
    const handle = win.getNativeWindowHandle();
    const hwnd = (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
    const probe = path.join(root, 'runtime/fullscreen-edge-win-probe.exe');
    const geometry = JSON.parse((await promisify(cp.execFile)(probe, [hwnd], { windowsHide: true, encoding: 'utf8' })).stdout);
    assert.equal(geometry.visible, true);
    assert.ok(geometry.rows.every(r => r.hit === 1), 'all top edges must be native HTCLIENT');
    assert.equal(geometry.clientOrigin.x, 0); assert.equal(geometry.clientOrigin.y, 0);
    observer = cp.spawn(probe, ['--cursor-stdin'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const next = lines(observer); const ready = await next(); assert.equal(ready.ready, true);
    const read = async (x,y) => { observer.stdin.write(JSON.stringify({ x,y })+'\n'); return next(); };
    const owned = async (x,y) => { const r = await read(x,y); assert.equal(r.ownerAtTarget.toString(), hwnd); assert.equal(r.held, false, 'desktop input interference'); return r; };
    const session = 'owned-fullscreen-edge'; assert.equal(await native.setActive(session), true);
    let seq = 0;
    const move = async (input, targetX, targetY) => {
      await owned(targetX,targetY); assert.equal(native.send(session, input), true); seq++;
      for (let i = 0; i < 200 && !journal.some(r => r.seq === seq); i++) await delay(5);
      const ack = journal.find(r => r.seq === seq); assert.ok(ack); assert.equal(ack.suppressed, false);
      const r = await read(targetX,targetY);
      assert.ok(Math.abs(r.actual.x-targetX)<=1 && Math.abs(r.actual.y-targetY)<=1, 'independent cursor mismatch');
      return { input, target:{ x:targetX,y:targetY }, actual:r.actual, ack };
    };
    const width = geometry.client.right, height = geometry.client.bottom;
    const phases = [];
    for (const zoom of [1, 1.25, 1.5]) {
      win.webContents.setZoomFactor(zoom); await delay(100);
      await move({ type:'pointer',x:0.5,y:10/(height-1) },Math.round((width-1)*0.5),10);await delay(50);
      await js('edgeQa.rows.length=0'); const physical=[];
      for (const y of [0,1,2]) for (const x of [0,1,64,Math.floor(width/2),width-65,width-2,width-1]) {
        physical.push(await move({type:'pointer',x:x/(width-1),y:y/(height-1)},x,y)); await delay(30);
      }
      const rows = await js('edgeQa.rows'); const sent=rows.filter(r=>r.stage==='sent'&&r.type==='pointer');
      assert.equal(sent.length,21); assert.ok(sent.slice(0,7).every(r=>r.y===0));
      assert.ok(rows.filter(r=>r.stage==='pointerrawupdate').every(r=>r.trusted===true));
      phases.push({zoom,inspect:await js('edgeQa.inspect()'),physical,rows});
    }
    // Replay the actual mapped outputs while control is inactive, through the
    // production input validator/queue/helper, with independent OS observation.
    await js('edgeQa.setActive(false)'); await delay(80);
    const replay=[];
    for (const p of phases) for (const r of p.rows.filter(r=>r.stage==='sent'&&r.type==='pointer')) {
      const input={type:'pointer',x:r.x,y:r.y};
      replay.push(await move(input,Math.round(r.x*(width-1)),Math.round(r.y*(height-1))));
    }
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(150);
    assert.equal(win.isFullScreen(),false);assert.equal(await js('document.fullscreenElement===null'),true);
    await js('edgeQa.setActive(true)');await js("document.querySelector('.fullscreen-stack > button').click()");await delay(150);
    assert.equal(win.isFullScreen(),true);
    await js('edgeQa.setActive(false)');await delay(80);await js('edgeQa.rows.length=0');
    win.webContents.sendInputEvent({type:'mouseMove',x:100,y:0});await delay(30);
    assert.equal(await js("edgeQa.rows.filter(r=>r.stage==='sent').length"),0);
    native.stop();assert.equal(native.send(session,{type:'pointer',x:0,y:0}),false);
    assert.deepEqual(failures,[]);
    const report={passed:true,observedAt:new Date().toISOString(),geometry,displays:screen.getAllDisplays().map(d=>({bounds:d.bounds,scaleFactor:d.scaleFactor})),
      scope:'visible actual ShareViewV2/Fullscreen API; physical Windows source events and captured-output production native replay are separate phases; no WAN or video latency',
      phases,replay,escaped:true,reentered:true,stoppedInputs:0,revokedInputRejected:true,failures};
    fs.writeFileSync(path.join(out,'live-windows.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({passed:true,observedAt:report.observedAt,sourcePhysicalMoves:phases.map(p=>p.physical.length),
      mappedMoves:phases.map(p=>p.rows.filter(r=>r.stage==='sent').length),nativeReplay:replay.length,escaped:true,reentered:true,revokedInputRejected:true,displays:report.displays},null,2));
  } finally {
    native.stop();if(observer){observer.stdin.write('restore\n');observer.stdin.end();}
    win?.destroy();clearTimeout(watchdog);app.quit();
  }
}).catch(e=>{console.error(e);app.exit(1)});
