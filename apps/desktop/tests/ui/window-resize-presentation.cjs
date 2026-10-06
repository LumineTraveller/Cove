// Onscreen GPU regression: unlike the offscreen layout test, do not wait for
// the renderer between native size changes. Accounts/network/media are doubles.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const artifacts = process.env.COVE_UI_QA_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'cove-present-'));
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const frames = [], sizes = [], gestures = [];
const manual = process.env.COVE_UI_QA_MANUAL === '1';
const nativeState = process.env.COVE_UI_QA_NATIVE_STATE === '1';
const watchdog = setTimeout(() => app.exit(2), manual ? 180000 : 45000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ x: 90, y: 90, width: manual ? 1600 : 1100, height: manual ? 900 : 650,
    minWidth: 1100, minHeight: 600, frame: false, title: 'Cove Resize QA',
    backgroundColor: '#09090b', show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false,
      ...(nativeState ? { preload:path.join(__dirname,'window-resize-preload.cjs') } : {}),
      partition: 'resize-presentation-isolated' } });
  if(nativeState) require('../../dist-electron/window-resize').installNativeResizeState(win);
  win.on('page-title-updated', event => event.preventDefault());
  win.webContents.setAudioMuted(true);
  win.on('resize', () => sizes.push({ at: Date.now(), size: win.getContentSize() }));
  win.on('will-resize', () => gestures.push({ at:Date.now(), active:true }));
  win.on('resized', () => gestures.push({ at:Date.now(), active:false }));
  const js = code => win.webContents.executeJavaScript(code, true);
  const waitFor = async code => {
    for (let i = 0; i < 240; i++) {
      if (await js(code)) return;
      await delay(25);
    }
    throw new Error('Timed out: ' + code);
  };
  await win.loadURL(process.env.COVE_UI_QA_URL);
  await waitFor("Boolean(document.querySelector('button[title=\"加入语音\"]'))");
  await js("document.querySelector('button[title=\"加入语音\"]').click()");
  await waitFor("Boolean(document.querySelector('.mode-available'))");
  await js("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='观看共享').click()");
  await waitFor("Boolean(document.querySelector('.mode-watching video')?.videoWidth)");
  await js("(()=>{const b=document.querySelector('.chat-edge-toggle');if(b?.getAttribute('aria-expanded')==='true')b.click()})()");
  await js("window.__resizeVideo = document.querySelector('.video-content video')");
  const record = () => fs.writeFileSync(path.join(artifacts, 'presentation.json'), JSON.stringify({
    runtime: process.versions, gpu: app.getGPUFeatureStatus(), sizes, gestures, frames,
  }, null, 2));
  win.webContents.beginFrameSubscription(image => {
    const size=image.getSize(), corner=image.crop({x:Math.max(0,size.width-16),y:Math.max(0,size.height-16),width:1,height:1}).toBitmap();
    const blank=corner[0]>240&&corner[1]>240&&corner[2]>240;
    frames.push({ at: Date.now(), frame: size, native: win.getContentSize(), corner:[corner[2],corner[1],corner[0]], blank });
    if(blank&&!fs.existsSync(path.join(artifacts,'first-blank-frame.png')))fs.writeFileSync(path.join(artifacts,'first-blank-frame.png'),image.toPNG());
    if (frames.length > 6000) frames.shift();
  });
  if (manual) {
    const timer = setInterval(record, 1000);
    win.on('closed', () => { clearInterval(timer); record(); clearTimeout(watchdog); app.exit(0); });
    console.log('Manual GPU resize QA ready. Isolated title: Cove Resize QA');
    return;
  }
  for (const theme of ['light', 'dark']) {
    await js(`window.shareChatQa.setTheme('${theme}')`);
    await js("document.querySelector('.cove-shell').style.setProperty('--room-bottom','#a58b42')");
    await delay(400);
    for (let repeat = 0; repeat < 3; repeat++) {
      for (let step = 0; step < 30; step++) {
        const t = step < 15 ? step / 14 : (29 - step) / 14;
        win.setSize(Math.round(1100 + 600 * t), Math.round(650 + 290 * t));
        // Intentionally not waiting for innerWidth / layout / paint.
        await delay(8);
      }
      await delay(200);
    }
    await waitFor("Math.abs(innerWidth-1100)<2 && Math.abs(innerHeight-648)<3");
    const state = await js(`(() => {
      const r=document.querySelector('.cove-shell').getBoundingClientRect();
      return { right:r.right, bottom:r.bottom, width:innerWidth, height:innerHeight,
        videoRetained:window.__resizeVideo===document.querySelector('.video-content video'),
        videoPlaying:!window.__resizeVideo.paused, resizing:document.documentElement.classList.contains('viewport-resizing') };
    })()`);
    assert.ok(Math.abs(state.right-state.width)<1 && Math.abs(state.bottom-state.height)<1);
    assert.ok(state.videoRetained && state.videoPlaying && !state.resizing);
  }
  record();
  const mismatches = frames.filter(f => Math.abs(f.frame.width-f.native[0])>2 || Math.abs(f.frame.height-f.native[1])>2);
  console.log(JSON.stringify({ runtime:process.versions.electron, frameCount:frames.length,
    nativeResizes:sizes.length, laggingFrames:mismatches.length,
    largestWidthLag:Math.max(0,...frames.map(f=>f.native[0]-f.frame.width)),
    largestHeightLag:Math.max(0,...frames.map(f=>f.native[1]-f.frame.height)), blankCornerFrames:frames.filter(f=>f.blank).length, artifacts }));
  win.webContents.endFrameSubscription();
  win.destroy(); clearTimeout(watchdog); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1); });
