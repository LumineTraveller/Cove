// Explicitly coordinated desktop test. Real ShareViewV2/Fullscreen API,
// physical Windows mouse events and production native controller/helper.
// Source sampling and captured-output replay are separate to avoid a same-host
// remote-control feedback loop. No user profile, WAN or clicks; only an owned
// foreground Escape press/release is used for the native fullscreen exit.
const { app, BrowserWindow, screen } = require('electron');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { promisify } = require('util'), readline = require('readline'), assert = require('assert/strict');
if (process.env.COVE_EDGE_DESKTOP_WINDOW_GRANTED !== '1') throw Error('Desktop test window has not been coordinated');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'runtime/fullscreen-edge');
app.setPath('userData', path.join(out, 'live-profile')); app.setPath('sessionData', path.join(out, 'live-session'));
app.setAppPath(path.join(root, 'apps/desktop'));
const journal = [], failures = [];
const escapeOnly=process.env.COVE_EDGE_ESCAPE_ONLY==='1';
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
function lines(child, onActivity) {
  const pending = [], buffered = []; let activity = false;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line);
    if(value.userActivity) { activity=true;onActivity(value.kind);while(pending.length)pending.shift().reject(Error('User activity; desktop test stopped'));return; }
    if (pending.length) pending.shift().resolve(value); else buffered.push(value);
  });
  return (cleanup=false) => activity&&!cleanup ? Promise.reject(Error('User activity; desktop test stopped')) :
    buffered.length ? Promise.resolve(buffered.shift()) : new Promise((resolve,reject) => pending.push({resolve,reject}));
}
app.whenReady().then(async () => {
  let win, observer, next, report, userActivity=false;
  const trace={startedAt:new Date().toISOString(),phase:'starting'};
  const watchdog = setTimeout(() => {
    native.stop(); observer?.stdin.write('restore\n'); win?.destroy();
    setTimeout(() => app.exit(2), 300);
  }, 25000);
  try {
    const probe = path.join(root, 'runtime/fullscreen-edge-win-probe.exe');
    observer = cp.spawn(probe, ['--cursor-stdin'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    next = lines(observer,kind=>{userActivity=true;trace.activityKind=kind;native.stop();win?.hide();});
    const ready=await next();assert.equal(ready.ready,true);assert.equal(ready.activityMonitorAvailable,true);
    trace.ready=ready;trace.phase='observer-ready';
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
    const geometry = JSON.parse((await promisify(cp.execFile)(probe, [hwnd], { windowsHide: true, encoding: 'utf8' })).stdout);
    trace.geometry=geometry;trace.window={visible:win.isVisible(),focused:win.isFocused(),fullscreen:win.isFullScreen()};trace.phase='native-geometry';
    if(userActivity)throw Error('User activity; desktop test stopped before injection');
    assert.equal(geometry.visible, true);
    assert.ok(geometry.rows.every(r => r.hit === 1), 'all top edges must be native HTCLIENT');
    assert.equal(geometry.clientOrigin.x, 0); assert.equal(geometry.clientOrigin.y, 0);
    const read = async (x,y,expectedKey=0) => { observer.stdin.write(JSON.stringify({ x,y,expectedKey })+'\n'); return next(); };
    const owned = async (x,y) => { const r = await read(x,y); assert.equal(r.ownerAtTarget.toString(), hwnd);assert.equal(r.foreground.toString(),hwnd);
      assert.equal(r.held,false,'desktop input interference');assert.equal(r.userActivityObserved,false);return r; };
    const session = 'owned-fullscreen-edge'; assert.equal(await native.setActive(session), true);
    trace.phase='physical-input';
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
    for (const zoom of escapeOnly?[]:[1, 1.25, 1.5]) {
      win.webContents.setZoomFactor(zoom); await delay(100);
      await move({ type:'pointer',x:0.5,y:10/(height-1) },Math.round((width-1)*0.5),10);await delay(50);
      await js('edgeQa.rows.length=0'); const physical=[];
      const topXs=[...new Set([0,1,...Array.from({length:33},(_,i)=>Math.round(i*(width-1)/32)),width-2,width-1])].sort((a,b)=>a-b);
      for (const y of [0,1,2]) for (const x of y===0?topXs:[0,1,64,Math.floor(width/2),width-65,width-2,width-1]) {
        physical.push(await move({type:'pointer',x:x/(width-1),y:y/(height-1)},x,y)); await delay(20);
      }
      const rows = await js('edgeQa.rows'); const sent=rows.filter(r=>r.stage==='sent'&&r.type==='pointer');
      trace.lastPhase={zoom,topRowSamples:topXs.length,inspect:await js('edgeQa.inspect()'),physical,rows};
      const raw=rows.filter(r=>r.stage==='pointerrawupdate');const topRaw=raw.filter(r=>r.y===0);
      // Windows/Chromium can collapse a 0->1 physical-pixel movement at 150%
      // DPI before a DOM raw event exists. Verify every delivered raw event,
      // rather than assuming one DOM event per native command.
      assert.equal(sent.length,raw.length);assert.ok(topRaw.length>=topXs.length-3);
      assert.equal(sent.filter(r=>r.y===0).length,topRaw.length);
      assert.equal(topRaw[0].x,0);assert.ok(topRaw.at(-1).x*trace.lastPhase.inspect.viewport.dpr>=width-3);
      assert.ok(raw.every(r=>r.trusted===true&&r.target==='VIDEO'));
      phases.push({zoom,topRowSamples:topXs.length,topRawSamples:topRaw.length,rawSamples:raw.length,
        inspect:await js('edgeQa.inspect()'),physical,rows});
    }
    // Replay the actual mapped outputs while control is inactive, through the
    // production input validator/queue/helper, with independent OS observation.
    await js('edgeQa.setActive(false)'); await delay(80);
    const replay=[];
    for (const p of phases) for (const r of p.rows.filter(r=>r.stage==='sent'&&r.type==='pointer')) {
      const input={type:'pointer',x:r.x,y:r.y};
      replay.push(await move(input,Math.round(r.x*(width-1)),Math.round(r.y*(height-1))));
    }
    await js('edgeQa.setActive(true)');await delay(80);
    await js("document.querySelector('.remote-video-surface').focus()");
    const focusedBeforeEscape=await js("document.activeElement===document.querySelector('.remote-video-surface')");
    assert.equal(focusedBeforeEscape,true);
    const last=replay.at(-1)?.actual??ready.original;
    const guard=await read(last.x,last.y,27);assert.equal(guard.foreground.toString(),hwnd);
    for(const down of [true,false]) {
      assert.equal(native.send(session,{type:'key',code:'Escape',down}),true);seq++;
      for(let i=0;i<200&&!journal.some(r=>r.seq===seq);i++)await delay(5);
      assert.ok(journal.some(r=>r.seq===seq));
    }
    await delay(150);
    const afterEscape=await read(last.x,last.y);assert.equal(afterEscape.escapeHeld,false);
    assert.equal(win.isFullScreen(),false);assert.equal(await js('document.fullscreenElement===null'),true);
    await js('edgeQa.setActive(true)');await js("document.querySelector('.fullscreen-stack > button').click()");await delay(150);
    assert.equal(win.isFullScreen(),true);
    await js('edgeQa.setActive(false)');await delay(80);await js('edgeQa.rows.length=0');
    win.webContents.sendInputEvent({type:'mouseMove',x:100,y:0});await delay(30);
    assert.equal(await js("edgeQa.rows.filter(r=>r.stage==='sent').length"),0);
    native.stop();assert.equal(native.send(session,{type:'pointer',x:0,y:0}),false);
    assert.deepEqual(failures,[]);
    report={passed:true,observedAt:new Date().toISOString(),geometry,displays:screen.getAllDisplays().map(d=>({bounds:d.bounds,scaleFactor:d.scaleFactor})),
      scope:'visible actual ShareViewV2/Fullscreen API; physical Windows source events and captured-output production native replay are separate phases; no WAN or video latency',
      phases,replay,escaped:true,realNativeEscape:true,escapeWithControlActive:true,focusedBeforeEscape,escapeReleased:!afterEscape.escapeHeld,
      reentered:true,stoppedInputs:0,revokedInputRejected:true,
      activityMonitorAvailable:true,userActivityObserved:userActivity,failures};
  } finally {
    native.stop();win?.destroy();
    if(observer){observer.stdin.write('restore\n');observer.stdin.end();
      const cleanup=await Promise.race([next(true),delay(1500).then(()=>({cleanup:false}))]);
      if(report) { report.cleanup=cleanup;assert.equal(cleanup.cursorRestored,true);assert.equal(cleanup.foregroundRestored,true); }
      trace.cleanup=cleanup;
    }
    clearTimeout(watchdog);
    trace.userActivity=userActivity;trace.nativeCommands=journal.filter(r=>r.seq).length;
    fs.writeFileSync(path.join(out,'live-attempt.json'),JSON.stringify(trace,null,2));
    if(report) {
      fs.writeFileSync(path.join(out,escapeOnly?'live-native-escape.json':'live-windows.json'),JSON.stringify(report,null,2));
      console.log(JSON.stringify({passed:true,observedAt:report.observedAt,sourcePhysicalMoves:report.phases.map(p=>p.physical.length),
        mappedMoves:report.phases.map(p=>p.rows.filter(r=>r.stage==='sent').length),nativeReplay:report.replay.length,
        realNativeEscape:true,reentered:true,revokedInputRejected:true,activityMonitorAvailable:true,userActivityObserved:userActivity,
        cleanup:report.cleanup,displays:report.displays},null,2));
    }
    app.quit();
  }
}).catch(e=>{console.error(e);app.exit(1)});
