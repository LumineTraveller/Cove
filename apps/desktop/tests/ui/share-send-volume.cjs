// Run with an isolated Electron profile and a bundle of share-send-volume.tsx.
// No real screen, audio device, signaling connection, or installed client is used.
// From the repository root on Windows (existing dependencies only):
// $dir = Join-Path $env:TEMP ('cove-share-send-volume-' + [guid]::NewGuid().ToString('N'))
// New-Item -ItemType Directory -Path $dir | Out-Null
// & .\node_modules\@esbuild\win32-x64\esbuild.exe apps/desktop/tests/ui/share-send-volume.tsx --bundle --platform=browser --format=iife --jsx=automatic '--define:import.meta.env={}' --loader:.png=file --loader:.svg=file --loader:.wav=dataurl '--external:../assets/cove-icon.png' "--outdir=$dir"
// '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="share-send-volume.css"><div id="root"></div><script src="share-send-volume.js"></script>' | Set-Content -Encoding UTF8 (Join-Path $dir 'index.html')
// $env:COVE_SEND_VOLUME_QA_DIR = $dir
// & .\apps\desktop\node_modules\electron\dist\electron.exe .\apps\desktop\tests\ui\share-send-volume.cjs
// Read result.json in $dir for the verdict and PNGs for the rendered controls.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.COVE_SEND_VOLUME_QA_DIR;
if (!dir) throw new Error('COVE_SEND_VOLUME_QA_DIR must name the isolated fixture directory');
app.setPath('userData', path.join(dir, 'profile'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  const run = script => win.webContents.executeJavaScript(script, true);
  const snapshot = () => run('window.volumeQa.snapshot()');
  const waitForPaint = () => new Promise(resolve => setTimeout(resolve, 200));
  const until = async condition => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await snapshot();
      if (condition(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for UI: ${JSON.stringify(await snapshot())}`);
  };
  try {
    await win.loadFile(path.join(dir, 'index.html'));
    await until(state => state.label === null);
    await run('window.volumeQa.setShareHasAudio(true)');
    let state = await until(value => value.label === '共享发送音量');
    assert.equal(state.value, '100');
    await run("document.querySelector('.share-status-bar input').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' });
    state = await until(value => value.value === '99');
    assert.equal(state.shareVolume, 0.99);
    assert.equal(state.receiveVolume, 0.6);
    assert.ok(state.rangeRect.width > 0 && state.rangeRect.right <= state.viewportWidth);
    await waitForPaint();
    fs.writeFileSync(path.join(dir, 'sender.png'), (await win.capturePage()).toPNG());
    await run("document.querySelector('.share-status-bar .volume-icon').click()");
    state = await until(value => value.value === '0');
    assert.equal(state.muteLabel, '恢复共享发送音量');
    await run("document.querySelector('.share-status-bar .volume-icon').click()");
    await until(value => value.value === '99');
    await run('window.volumeQa.replaceVideo()');
    await until(value => value.label === '共享发送音量' && value.value === '99');
    await run('window.volumeQa.setRemote(true)');
    state = await until(value => value.label === '共享观看音量');
    assert.equal(state.value, '60');
    await run("document.querySelector('.share-status-bar .volume-icon').click()");
    state = await until(value => value.value === '0');
    assert.equal(state.shareVolume, 0.99);
    assert.equal(state.muteLabel, '恢复共享观看音量');
    await run('window.volumeQa.setRemote(false)');
    await until(value => value.label === '共享发送音量' && value.value === '99');
    await run('window.volumeQa.setShareHasAudio(false)');
    await until(value => value.label === null);
    await run('window.volumeQa.setShareHasAudio(true)');
    await until(value => value.label === '共享发送音量' && value.value === '99');
    await run('window.volumeQa.setRemote(true)');
    await until(value => value.label === '共享观看音量' && value.value === '0');
    await run("document.querySelector('.share-status-bar .volume-icon').click()");
    state = await until(value => value.value === '60');
    assert.equal(state.shareVolume, 0.99);
    win.setSize(800, 600);
    state = await until(value => value.viewportWidth <= 800);
    assert.ok(state.rangeRect.width > 0 && state.rangeRect.right <= state.viewportWidth);
    await waitForPaint();
    fs.writeFileSync(path.join(dir, 'viewer.png'), (await win.capturePage()).toPNG());
    const result = { ok: true, final: state, screenshots: dir };
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    win.destroy();
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ ok: false, error: String(error) }, null, 2));
    console.error(error);
    win.destroy();
    app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
