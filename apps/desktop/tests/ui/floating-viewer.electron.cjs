'use strict';
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../../..');
const { createLoopbackMediaProxy } = require(path.join(root, 'tooling/loopback-media-proxy.cjs'));
const directory = path.resolve(process.env.COVE_FLOATING_RUN_DIR || '');
const relative = path.relative(path.join(root, 'runtime/pip-20261023'), directory);
if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('An isolated floating-viewer run directory is required');
const resultPath = path.join(directory, 'result.json');
const renderer = new URL(process.env.COVE_QA_RENDERER_URL);
if (renderer.protocol !== 'http:' || renderer.hostname !== '127.0.0.1' || renderer.pathname !== '/' || renderer.search || renderer.hash || renderer.username || renderer.password) throw new Error('Expected an owned loopback renderer');
if (!process.env.COVE_TEST_NODE) throw new Error('A standalone Node runtime is required');
app.setPath('userData', path.join(directory, 'electron-profile'));
// Generated PCM WAV and canvas are the only capture inputs. Every AudioContext
// is routed by the renderer fixture to Chromium's {type:none} silent sink.
const sampleRate = 48000, sampleCount = sampleRate * 4;
const pcm = Buffer.alloc(sampleCount * 2);
for (let index = 0; index < sampleCount; index++) {
  const t = index / sampleRate, envelope = .15 + .2 * (.5 + .5 * Math.sin(2 * Math.PI * 3 * t));
  pcm.writeInt16LE(Math.round(envelope * (Math.sin(2 * Math.PI * 440 * t) + .3 * Math.sin(2 * Math.PI * 660 * t)) * 32767), index * 2);
}
const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
const wav = path.join(directory, 'synthetic.wav'); fs.writeFileSync(wav, Buffer.concat([header, pcm]));
app.commandLine.appendSwitch('use-fake-device-for-media-stream'); app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
app.on('window-all-closed', () => {});
const runId = require('node:crypto').randomUUID(), startedAt = new Date().toISOString();
const evidence = { checks: [], audio: {}, cleanup: {}, focusReturns: 0 };
fs.writeFileSync(resultPath, JSON.stringify({ passed: false, status: 'running', runId, startedAt }));
const windows = [];
let backend, proxy, finished = false, failure = null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (win, code, userGesture = false) => win.webContents.executeJavaScript(code, userGesture);
async function waitFor(win, code, timeout = 24000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await evaluate(win, code)) return; await delay(100); }
  throw new Error('Timed out: ' + code);
}
function check(name, value = true) { assert.ok(value, name); evidence.checks.push(name); console.log('[floating-check]', name); }
let requestSequence = 0;
function backendRequest(type) {
  return new Promise((resolve, reject) => {
    const requestId = ++requestSequence;
    const timer = setTimeout(() => { backend.off('message', receive); reject(new Error('Backend IPC timed out: ' + type)); }, 15000);
    function receive(message) { if (message?.requestId !== requestId) return; clearTimeout(timer); backend.off('message', receive); message.type === 'backend-error' ? reject(new Error(message.error)) : resolve(message.resources); }
    backend.on('message', receive); backend.send({ type, requestId });
  });
}
async function finish(code) {
  if (finished) return; finished = true; clearTimeout(watchdog);
  for (const win of windows) if (!win.isDestroyed()) try { await evaluate(win, 'window.coveMediaQA?.rtc.leaveVoice();window.coveMediaQA?.socket.disconnect()'); } catch {}
  await delay(200);
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  if (proxy) { evidence.proxy = proxy.counts(); await proxy.close(); }
  if (backend && backend.exitCode === null) await new Promise(resolve => {
    const kill = setTimeout(() => backend.kill(), 5000), deadline = setTimeout(resolve, 10000);
    backend.once('exit', () => { clearTimeout(kill); clearTimeout(deadline); resolve(); });
    if (backend.connected) backend.send({ type: 'stop' }, error => { if (error) backend.kill(); }); else backend.kill();
  });
  evidence.cleanup.backendStopped = !backend || backend.exitCode !== null;
  evidence.cleanup.windowsDestroyed = windows.every(win => win.isDestroyed());
  const passed = code === 0 && evidence.cleanup.backendStopped && evidence.cleanup.windowsDestroyed;
  fs.writeFileSync(resultPath, JSON.stringify({ schemaVersion: 1, passed, status: 'completed', runId, startedAt, finishedAt: new Date().toISOString(), error: failure,
    electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform,
    scope: 'real ShareViewV2, useWebRTC, local SFU, native video Picture-in-Picture; synthetic canvas/WAV, silent PCM sinks',
    physicalCaptureUsed: false, speakerAudibilityMeasured: false, endToEndLatencyMeasured: false, evidence }, null, 2) + '\n');
  app.exit(passed ? 0 : 1);
}
const watchdog = setTimeout(() => { failure = 'Floating viewer integration timed out'; void finish(1); }, 215000);
app.whenReady().then(async () => {
  try {
    backend = spawn(process.env.COVE_TEST_NODE, [path.join(__dirname, 'floating-viewer-backend.cjs')], { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned backend startup timed out')), 25000);
      backend.once('error', error => { clearTimeout(timer); reject(error); });
      backend.once('exit', code => { clearTimeout(timer); reject(new Error('Backend exited: ' + code)); });
      backend.on('message', message => { if (message?.type === 'ready') { clearTimeout(timer); resolve(message); } });
    });
    proxy = await createLoopbackMediaProxy(Number(process.env.COVE_QA_MEDIA_PORT), 'udp');
    session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'media'));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
    ipcMain.handle('floating-viewer-test:focus', event => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!windows.includes(win)) return false;
      evidence.focusReturns++; if (win.isMinimized()) win.restore(); win.show(); win.focus(); return true;
    });
    for (let index = 0; index < 2; index++) {
      // Native windows and the product's default backgroundThrottling=true.
      // No offscreen mode, throttle overrides or physical input devices.
      const win = new BrowserWindow({ width: 860, height: 650, x: index ? 500 : 40, y: 70, show: true,
        title: 'Cove floating viewer synthetic integration', webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'floating-viewer-preload.cjs') } });
      windows.push(win);
      win.webContents.on('console-message', (_event, _level, message) => { if (/Error|error|\[media-recovery\]/.test(message)) console.log('[renderer]', message); });
      win.webContents.on('render-process-gone', (_event, detail) => { console.error('[renderer-gone]', detail.reason); });
      const query = new URLSearchParams({ base: info.base, room: info.roomId, token: info.accounts[index].token, index: String(index), floating: '1' });
      if (index === 1) { query.set('iceProxy', String(proxy.port)); query.set('iceProtocol', 'udp'); }
      await win.loadURL(renderer.origin + '/tests/ui/media-integration.html?' + query);
      await waitFor(win, 'Boolean(window.coveMediaQA?.ready&&window.coveFloatingQA)');
      await evaluate(win, "window.coveMediaQA.rtc.selectMicrophoneNoiseMode('system')");
      await evaluate(win, 'window.coveMediaQA.rtc.joinVoice()');
      await waitFor(win, 'window.coveMediaQA.rtc.inVoice');
    }
    const [sender, viewer] = windows;
    async function screenshot(filename) {
      viewer.show(); viewer.focus();
      // DOM state can precede a hidden/occluded renderer's last compositor
      // frame. Obtain two actual painted frames before visual evidence.
      await evaluate(viewer, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
      fs.writeFileSync(path.join(directory, filename), (await viewer.webContents.capturePage()).toPNG());
    }
    evidence.backgroundThrottling = windows.map(win => typeof win.webContents.getBackgroundThrottling === 'function'
      ? win.webContents.getBackgroundThrottling() : win.webContents.getLastWebPreferences().backgroundThrottling !== false);
    check('native main windows retain product backgroundThrottling=true', evidence.backgroundThrottling.every(Boolean));
    for (const win of windows) await waitFor(win, 'window.coveMediaQA.rtc.voiceMembers.length===2');
    async function publish() { await evaluate(sender, "window.coveMediaQA.rtc.startScreenShare('1080p',30,false,false,true,true)"); await waitFor(sender, 'Boolean(window.coveMediaQA.rtc.localScreen)'); await waitFor(viewer, 'window.coveMediaQA.rtc.availableScreens.length===1'); }
    async function watch() {
      await evaluate(viewer, 'window.coveMediaQA.rtc.watchScreen(window.coveMediaQA.rtc.availableScreens[0].socketId)');
      await waitFor(viewer, 'Boolean(window.coveMediaQA.rtc.remoteScreen)&&document.querySelector(".share-view video")?.videoWidth===640&&document.querySelector(".share-view video").readyState>=2&&!document.querySelector(".floating-view-toggle").disabled');
    }
    async function open() {
      await waitFor(viewer, 'Boolean(document.querySelector(".floating-view-toggle"))&&!window.coveFloatingQA.snapshot().floatingDisabled&&window.coveFloatingQA.snapshot().readyState>=2&&window.coveFloatingQA.snapshot().width>0');
      await evaluate(viewer, 'document.querySelector(".floating-view-toggle").click()', true);
      await waitFor(viewer, 'window.coveFloatingQA.snapshot().pictureElementIsVideo&&window.coveFloatingQA.snapshot().floatingPressed==="true"&&!window.coveFloatingQA.snapshot().floatingDisabled');
    }
    async function close() {
      const count = evidence.focusReturns;
      await evaluate(viewer, 'document.querySelector(".floating-view-toggle").click()', true);
      await waitFor(viewer, '!document.pictureInPictureElement&&window.coveFloatingQA.snapshot().floatingPressed==="false"&&!window.coveFloatingQA.snapshot().floatingDisabled');
      assert.equal(evidence.focusReturns, count + 1, 'return action invokes the narrow product focus bridge exactly once');
    }
    const mediaIdentity = async () => ({ transports: await evaluate(viewer, 'window.coveMediaQA.ice.snapshot().map(t=>({id:t.id,direction:t.direction,consumers:t.consumers,producers:t.producers.map(p=>p.id)}))'), resources: await evaluate(viewer, 'window.coveMediaQA.resources()'), backend: await backendRequest('snapshot') });
    await publish(); await watch();
    await waitFor(viewer, 'window.coveMediaQA.ice.audioDiagnostics().then(d=>d.taps.some(t=>t.label==="consumer"&&t.rms>1e-5))');
    const before = await mediaIdentity(); evidence.before = before;
    await screenshot('normal-main.png');
    evidence.audio.scope = 'actual synthetic voice consumer PCM and existing voice playback; system/screen audio capture is not invoked';
    evidence.audio.before = await evaluate(viewer, 'window.coveMediaQA.ice.audioDiagnostics()');
    const protocols = await evaluate(viewer, 'window.coveMediaQA.ice.selectedProtocols()');
    check('actual SFU receive transport selects the owned UDP proxy', protocols.some(item => item.direction === 'recv' && item.protocol === 'udp'));
    check('actual voice decoding and playback use running silent sinks', evidence.audio.before.contexts.every(context => context.state === 'running' && context.sinkType === 'none'));
    await evaluate(viewer, 'window.coveFloatingQA.capture()');
    for (const state of ['pending', 'active']) {
      await evaluate(viewer, `window.coveFloatingQA.setControl(${JSON.stringify(state)})`);
      await waitFor(viewer, 'window.coveFloatingQA.snapshot().floatingDisabled');
      await evaluate(viewer, 'document.querySelector(".floating-view-toggle").click()', true);
      assert.equal(await evaluate(viewer, 'Boolean(document.pictureInPictureElement)'), false);
    }
    await evaluate(viewer, 'window.coveFloatingQA.setControl("available")');
    await waitFor(viewer, '!window.coveFloatingQA.snapshot().floatingDisabled');
    check('actual UI prevents entry while remote control is pending or active');
    await evaluate(viewer, 'document.querySelector(".share-operations-trigger").click()', true);
    await waitFor(viewer, 'Boolean(document.querySelector(".share-operations-popover"))&&![...document.querySelectorAll(".share-operations-popover button")].at(-1).disabled');
    await evaluate(viewer, '[...document.querySelectorAll(".share-operations-popover button")].at(-1).click()', true);
    await waitFor(viewer, 'Boolean(document.querySelector(".annotation-input-surface"))&&window.coveFloatingQA.snapshot().floatingDisabled');
    await evaluate(viewer, 'document.querySelector(".floating-view-toggle").click()', true);
    assert.equal(await evaluate(viewer, 'Boolean(document.pictureInPictureElement)'), false);
    await evaluate(viewer, 'document.querySelector(".screen-annotation-layer").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await waitFor(viewer, '!document.querySelector(".annotation-input-surface")&&!window.coveFloatingQA.snapshot().floatingDisabled');
    check('real annotation UI blocks entry until drawing is exited');
    await evaluate(viewer, '(()=>{const b=document.querySelector(".floating-view-toggle");b.click();b.click();b.click();})()', true);
    await waitFor(viewer, 'window.coveFloatingQA.snapshot().pictureElementIsVideo&&!window.coveFloatingQA.snapshot().floatingDisabled');
    const floated = await evaluate(viewer, 'window.coveFloatingQA.snapshot()');
    check('repeated entry opens exactly one native picture and retains the same video/stream/tracks', floated.events.enter === 1 && floated.sameVideo && floated.sameStream && floated.sameTracks && floated.videos === 1);
    check('floating view hides remote/annotation operations and disables fullscreen', floated.operations === 0 && floated.annotations === 0 && floated.fullscreenDisabled);
    await evaluate(viewer, 'window.coveFloatingQA.setControl("active")');
    await waitFor(viewer, 'window.coveFloatingQA.snapshot().control==="active"');
    const inputCount = await evaluate(viewer, 'window.coveFloatingQA.snapshot().inputs');
    await evaluate(viewer, 'document.querySelector(".remote-video-surface").dispatchEvent(new KeyboardEvent("keydown",{code:"KeyA",key:"a",bubbles:true}))');
    assert.equal(await evaluate(viewer, 'window.coveFloatingQA.snapshot().inputs'), inputCount);
    await evaluate(viewer, 'window.coveFloatingQA.setControl("available")');
    await waitFor(viewer, 'window.coveFloatingQA.snapshot().control==="available"');
    check('floating production video forwards no remote keyboard input even if authorization props change');
    const during = await mediaIdentity(); evidence.during = during;
    assert.deepEqual(during.transports, before.transports); assert.deepEqual(during.backend, before.backend);
    for (const resource of ['peerConnections', 'liveTracks', 'liveTransports', 'liveProducers', 'liveConsumers', 'audioContexts', 'analysisTaps']) assert.equal(during.resources[resource], before.resources[resource], resource + ' is retained during native PiP');
    check('native entry adds no peer, transport, consumer, producer, track or audio graph');
    evidence.floated = floated;
    await screenshot('floating-main.png');
    const frames = await evaluate(viewer, 'window.coveMediaQA.ice.decodedFrames()');
    const audio = await evaluate(viewer, 'window.coveMediaQA.ice.audioProgress()');
    viewer.minimize(); await delay(250); assert.ok(viewer.isMinimized());
    await waitFor(viewer, `window.coveMediaQA.ice.decodedFrames().then(n=>n>${frames}+2)`);
    await waitFor(viewer, `window.coveMediaQA.ice.audioProgress().then(a=>a.packets>${audio.packets}+2&&a.nonConcealedSamples>${audio.nonConcealedSamples}+960)`);
    check('minimized owner retains native PiP with advancing decoded frames and audio');
    const focusBefore = evidence.focusReturns;
    await evaluate(viewer, 'document.exitPictureInPicture()', true);
    await waitFor(viewer, '!document.pictureInPictureElement&&window.coveFloatingQA.snapshot().floatingPressed==="false"');
    await delay(200);
    check('native leave invokes focus bridge once and restores minimized main window', evidence.focusReturns === focusBefore + 1 && !viewer.isMinimized() && viewer.isVisible());
    assert.equal(await evaluate(viewer, 'window.coveMediaQA.rtc.inVoice&&Boolean(window.coveMediaQA.rtc.remoteScreen)&&window.coveFloatingQA.snapshot().sameStream'), true);
    check('closing the native window preserves watching and voice');
    await screenshot('returned-main.png');
    await open();
    const recv = (await evaluate(viewer, 'window.coveMediaQA.ice.snapshot()')).find(item => item.direction === 'recv');
    proxy.setBlocked(true);
    await waitFor(viewer, 'window.coveMediaQA.ice.snapshot().some(t=>t.direction==="recv"&&["disconnected","failed"].includes(t.state))', 35000);
    const stalledFrames = await evaluate(viewer, 'window.coveMediaQA.ice.decodedFrames()');
    const stalledAudio = await evaluate(viewer, 'window.coveMediaQA.ice.audioProgress()');
    await waitFor(viewer, 'window.coveMediaQA.ice.snapshot().some(t=>t.direction==="recv"&&t.restartCalls>0)');
    proxy.setBlocked(false);
    await waitFor(viewer, 'window.coveMediaQA.ice.snapshot().some(t=>t.direction==="recv"&&t.state==="connected")');
    await waitFor(viewer, `window.coveMediaQA.ice.decodedFrames().then(n=>n>${stalledFrames}+2)`);
    await waitFor(viewer, `window.coveMediaQA.ice.audioProgress().then(a=>a.packets>${stalledAudio.packets}+2&&a.nonConcealedSamples>${stalledAudio.nonConcealedSamples}+960)`);
    await waitFor(viewer, 'window.coveMediaQA.ice.audioDiagnostics().then(d=>d.taps.some(t=>t.label==="consumer"&&t.rms>1e-5))');
    const restarted = (await evaluate(viewer, 'window.coveMediaQA.ice.snapshot()')).find(item => item.id === recv.id);
    assert.deepEqual(restarted.consumers, recv.consumers);
    assert.equal(restarted.credentialsChanged, true);
    const recovered = await evaluate(viewer, 'window.coveFloatingQA.snapshot()');
    check('real UDP fault/ICE restart retains open picture, same video/stream/tracks and consumers', recovered.pictureElementIsVideo && recovered.sameVideo && recovered.sameStream && recovered.sameTracks);
    evidence.audio.afterRecovery = await evaluate(viewer, 'window.coveMediaQA.ice.audioDiagnostics()');
    evidence.recovery = { transportRetained: true, consumersRetained: true, credentialsChanged: restarted.credentialsChanged, restartCalls: restarted.restartCalls, framesResumed: true, nonConcealedSamplesResumed: true, nonSilentPCM: true };
    check('real UDP recovery resumes fresh decoded frames and non-silent audio PCM');
    await close();
    for (let cycle = 0; cycle < 3; cycle++) { await open(); await close(); }
    const afterCycles = await mediaIdentity(); assert.deepEqual(afterCycles.transports, before.transports); assert.deepEqual(afterCycles.backend, before.backend);
    check('repeated open/close cycles retain all media ownership');
    await open();
    const returnsBeforeReplacement = evidence.focusReturns;
    await evaluate(viewer, 'window.coveFloatingQA.replaceStream()');
    await waitFor(viewer, '!document.pictureInPictureElement'); await delay(250);
    assert.equal(evidence.focusReturns, returnsBeforeReplacement);
    assert.equal(await evaluate(viewer, 'Boolean(document.pictureInPictureElement)'), false);
    check('replacing live presentation MediaStream closes without auto-reopen or focus stealing');
    await open();
    await evaluate(viewer, 'document.querySelector(".end-share").click()', true);
    await waitFor(viewer, '!window.coveMediaQA.rtc.remoteScreen&&!document.pictureInPictureElement');
    check('actual stop-watching button closes picture and preserves voice', await evaluate(viewer, 'window.coveMediaQA.rtc.inVoice'));
    await watch(); await open();
    await evaluate(sender, 'window.coveMediaQA.rtc.stopScreenShare()');
    await waitFor(viewer, '!window.coveMediaQA.rtc.remoteScreen&&!document.pictureInPictureElement');
    check('real publisher shareend closes picture and preserves both voice sessions', await evaluate(viewer, 'window.coveMediaQA.rtc.inVoice') && await evaluate(sender, 'window.coveMediaQA.rtc.inVoice'));
    await publish(); await watch(); await open();
    await evaluate(viewer, 'window.coveFloatingQA.setMounted(false)');
    await waitFor(viewer, '!document.pictureInPictureElement&&!document.querySelector(".share-view")');
    check('unmount closes owned native presentation and leaves live SFU watch intact', await evaluate(viewer, 'Boolean(window.coveMediaQA.rtc.remoteScreen)&&window.coveMediaQA.rtc.inVoice'));
    await evaluate(viewer, 'window.coveFloatingQA.setMounted(true)');
    await waitFor(viewer, 'Boolean(document.querySelector(".floating-view-toggle"))&&!document.querySelector(".floating-view-toggle").disabled');
    await open(); await evaluate(viewer, 'window.coveMediaQA.rtc.leaveVoice()');
    await waitFor(viewer, '!document.pictureInPictureElement&&!window.coveMediaQA.rtc.inVoice');
    check('leaving voice closes the picture');
    await evaluate(sender, 'window.coveMediaQA.rtc.leaveVoice()');
    for (const win of windows) await waitFor(win, '(()=>{const r=window.coveMediaQA.resources();return r.peerConnections===0&&r.liveTracks===0&&r.liveTransports===0&&r.liveProducers===0&&r.liveConsumers===0&&r.audioContexts<=1&&r.analysisTaps===0})()');
    // useAudioMeters intentionally retains its reusable presence/output context
    // while mounted. Dispose the real hook owner before requiring zero contexts.
    evidence.cleanup.mountedRenderers = await Promise.all(windows.map(win => evaluate(win, 'window.coveMediaQA.resources()')));
    for (const win of windows) await evaluate(win, 'window.coveFloatingQA.unmountFixture()');
    for (const win of windows) await waitFor(win, '(()=>{const r=window.coveMediaQA.resources();return r.audioContexts===0&&r.analysisTaps===0&&r.intervals===0})()');
    evidence.cleanup.renderers = await Promise.all(windows.map(win => evaluate(win, 'window.coveMediaQA.resources()')));
    evidence.cleanup.backend = await backendRequest('snapshot');
    assert.equal(evidence.cleanup.backend.transports, 0); assert.equal(evidence.cleanup.backend.producers, 0); assert.equal(evidence.cleanup.backend.consumers, 0);
    check('final cleanup releases all media tracks, peers, consumers, producers, graphs and SFU transports');
    await screenshot('cleaned-main.png');
    await finish(0);
  } catch (error) {
    failure = error.stack || String(error); console.error(error);
    evidence.failureSnapshots = [];
    for (const win of windows) if (!win.isDestroyed()) try { evidence.failureSnapshots.push(await evaluate(win, '({floating:window.coveFloatingQA?.snapshot(),ready:window.coveMediaQA?.ready,error:window.coveMediaQA?.error,resources:window.coveMediaQA?.resources()})')); } catch {}
    await finish(1);
  }
});
