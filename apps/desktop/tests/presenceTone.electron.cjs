// Production resource playback only: no sound output, devices or server.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const output = path.resolve(process.env.COVE_TONE_ARTIFACTS || path.join(root, 'runtime/presence-resources'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(output, 'profile-')));
const timeout = setTimeout(() => { console.error('presenceTone: timed out'); app.exit(1); }, 45_000);
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_request, done) => done({ cancel: true }));
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
  try {
    const expected = {}, hashes = {};
    for (const action of ['join', 'leave']) {
      const desktop = fs.readFileSync(path.join(__dirname, '../src/features/media/audio/assets', `voice-${action}.wav`));
      const android = fs.readFileSync(path.join(root, 'apps/mobile/android/app/src/main/res/raw', `voice_${action}.wav`));
      assert.deepEqual(desktop, android, `${action}: both platforms ship identical resources`);
      assert.equal(desktop.toString('ascii', 0, 4), 'RIFF');
      assert.equal(desktop.readUInt16LE(20), 1); assert.equal(desktop.readUInt16LE(22), 1);
      assert.equal(desktop.readUInt32LE(24), 48_000); assert.equal(desktop.readUInt16LE(34), 16);
      expected[action] = Array.from({ length: (desktop.length - 44) / 2 }, (_, i) => desktop.readInt16LE(44 + i * 2) / 32768);
      hashes[action] = crypto.createHash('sha256').update(desktop).digest('hex');
    }
    const { build } = await import('vite');
    const buildDir = path.join(output, 'production-build');
    await build({ root: path.join(root, 'apps/desktop'), configFile: path.join(root, 'apps/desktop/vite.config.ts'),
      cacheDir: path.join(output, 'vite-cache'), logLevel: 'error',
      build: { outDir: buildDir, emptyOutDir: true, rollupOptions: { input: path.join(__dirname, 'presenceTone-fixture.html') } } });
    await win.loadFile(path.join(buildDir, 'tests/presenceTone-fixture.html'));
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript('Boolean(window.presenceTone)')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const checks = await win.webContents.executeJavaScript(`(${resourceTests.toString()})(${JSON.stringify(expected)})`);
    const report = { passed: true, electron: process.versions.electron, audiblePlayback: false,
      method: 'actual Vite production file:// page and real OfflineAudioContext decoding', resources: hashes, checks };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('presenceTone: PASS', JSON.stringify(report));
    clearTimeout(timeout); win.destroy(); app.exit(0);
  } catch (error) { console.error('presenceTone: FAIL', error); clearTimeout(timeout); win.destroy(); app.exit(1); }
});
async function resourceTests(expected) {
  const checks = [], requests = [], realFetch = window.fetch.bind(window);
  window.fetch = (...args) => { requests.push(String(args[0])); return realFetch(...args); };
  function check(ok, label, detail = {}) { if (!ok) throw new Error(label + ': ' + JSON.stringify(detail)); checks.push({ label, ...detail }); }
  const peak = data => data.reduce((maximum, x) => Math.max(maximum, Math.abs(x)), 0);
  async function render(action, volume = 1, repeats = 1) {
    const context = new OfflineAudioContext(1, 48_000 * 0.45, 48_000);
    const master = context.createGain(); master.gain.value = volume; master.connect(context.destination);
    const create = context.createBufferSource.bind(context); let created = 0, disconnected = 0;
    context.createBufferSource = () => {
      created++; const source = create(), disconnect = source.disconnect.bind(source);
      source.disconnect = () => { disconnected++; disconnect(); }; return source;
    };
    await Promise.all(Array.from({ length: repeats }, () => window.presenceTone.schedulePresenceTone(context, master, action)));
    const samples = (await context.startRendering()).getChannelData(0);
    await new Promise(resolve => setTimeout(resolve, 0));
    return { samples, created, disconnected, volume: master.gain.value };
  }
  for (const action of ['join', 'leave']) {
    const full = await render(action), half = await render(action, 0.5), muted = await render(action, 0), data = full.samples;
    const maxError = expected[action].reduce((maximum, sample, i) => Math.max(maximum, Math.abs(data[i] - sample)), 0);
    // Native WAV decoders may normalize S16 by 32767 rather than 32768. Keep
    // the comparison inside one PCM16 quantum, without altering playback gain.
    check(maxError < 1 / 32768, 'production playback retains approved PCM precision', { action, maxError });
    check(data.every(Number.isFinite) && peak(data) > 0.11 && peak(data) < 0.13, 'selected 2x gain remains finite and unclipped', { action, peak: peak(data) });
    check(peak(data.subarray(Math.ceil(0.31 * 48_000))) === 0 && data[0] === 0, 'zero onset and silent tail remain intact', { action });
    check(full.created === 1 && full.disconnected === 1 && full.volume === 1, 'only the cue source is created and released', { action });
    check(half.samples.every((sample, i) => Math.abs(sample - data[i] * 0.5) < 1e-7) && peak(muted.samples) === 0, 'master volume and mute remain authoritative', { action });
  }
  const count = requests.length, repeated = await render('join', 1, 2);
  check(requests.length === count + 1 && repeated.created === 2 && repeated.disconnected === 2, 'concurrent cues reuse decode and release both sources');
  check(requests.every(url => url.startsWith('data:audio/')), 'production audio is inline without file/http fetches');
  const context = new OfflineAudioContext(1, 480, 48_000); let sources = 0, release;
  const create = context.createBufferSource.bind(context);
  context.createBufferSource = () => { sources++; return create(); };
  window.fetch = (...args) => new Promise(resolve => { release = () => resolve(realFetch(...args)); });
  const late = window.presenceTone.schedulePresenceTone(context, context.destination, 'leave');
  await context.startRendering(); release(); await late;
  check(sources === 0, 'late decode does not start a closed owner');
  const retry = new OfflineAudioContext(1, 48_000 * 0.45, 48_000);
  window.fetch = () => Promise.reject(new Error('controlled resource failure'));
  await window.presenceTone.schedulePresenceTone(retry, retry.destination, 'join');
  window.fetch = realFetch;
  await window.presenceTone.schedulePresenceTone(retry, retry.destination, 'join');
  check(peak((await retry.startRendering()).getChannelData(0)) > 0.11, 'resource failure is contained and later cue may recover');
  return checks;
}
