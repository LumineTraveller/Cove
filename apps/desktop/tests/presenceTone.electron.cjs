// Render the production cue in Chromium without sound output, devices or a server.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const output = path.resolve(process.env.COVE_TONE_ARTIFACTS || path.join(__dirname, '../../../runtime/presence-tones'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(output, 'profile-')));
const timeout = setTimeout(() => { console.error('presenceTone: timed out'); app.exit(1); }, 30_000);
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_request, done) => done({ cancel: true }));
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadURL('about:blank');
    const compiled = ts.transpileModule(
      fs.readFileSync(path.join(__dirname, '../src/features/media/audio/presenceTone.ts'), 'utf8'),
      { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } },
    ).outputText;
    await win.webContents.executeJavaScript(`window.presenceTone = (() => { const exports = {}; ${compiled}; return exports; })(); true`);
    const result = await win.webContents.executeJavaScript(`(${renderTests.toString()})()`);
    assert(result.checks.length >= 30);
    for (const [name, data] of Object.entries(result.previews)) writeWav(path.join(output, name + '.wav'), data, 48_000);
    const report = { passed: true, engine: process.versions, method: 'production schedulePresenceTone through real Chromium OfflineAudioContext', audiblePlayback: false, checks: result.checks };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('presenceTone: PASS', JSON.stringify(report));
    clearTimeout(timeout); win.destroy(); app.exit(0);
  } catch (error) {
    console.error('presenceTone: FAIL', error); clearTimeout(timeout); win.destroy(); app.exit(1);
  }
});

function writeWav(file, samples, rate) {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), index * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
}

async function renderTests() {
  const checks = [], previews = {};
  function check(ok, label, metrics = {}) {
    if (!ok) throw new Error(label + ': ' + JSON.stringify(metrics));
    checks.push({ label, ...metrics });
  }
  const peak = data => data.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
  const energy = data => data.reduce((sum, sample) => sum + sample * sample, 0) / data.length;
  function legacy(context, output, action) {
    (action === 'join' ? [523.25, 659.25] : [493.88, 392]).forEach((frequency, index) => {
      const oscillator = context.createOscillator(), gain = context.createGain(), start = context.currentTime + index * 0.11;
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.13, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
      oscillator.connect(gain).connect(output); oscillator.start(start); oscillator.stop(start + 0.14);
    });
  }
  async function render(rate, action, volume = 1, old = false) {
    const context = new OfflineAudioContext(1, Math.ceil(rate * 0.32), rate);
    const output = context.createGain(); output.gain.value = volume; output.connect(context.destination);
    let oscillatorDisconnects = 0, gainDisconnects = 0;
    const createOscillator = context.createOscillator.bind(context), createGain = context.createGain.bind(context);
    context.createOscillator = () => {
      const node = createOscillator(), disconnect = node.disconnect.bind(node);
      node.disconnect = (...args) => { oscillatorDisconnects++; return disconnect(...args); };
      return node;
    };
    context.createGain = () => {
      const node = createGain(), disconnect = node.disconnect.bind(node);
      node.disconnect = (...args) => { gainDisconnects++; return disconnect(...args); };
      return node;
    };
    (old ? legacy : window.presenceTone.schedulePresenceTone)(context, output, action);
    const samples = (await context.startRendering()).getChannelData(0);
    await new Promise(resolve => setTimeout(resolve, 0));
    return { samples, oscillatorDisconnects, gainDisconnects, volume: output.gain.value };
  }
  function amplitude(data, hz, rate, start, end) {
    let real = 0, imaginary = 0;
    const first = Math.round(start * rate), last = Math.round(end * rate);
    for (let index = first; index < last; index++) {
      // Hann window limits spectral leakage while retaining the short attack.
      const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * (index - first) / (last - first - 1));
      real += data[index] * weight * Math.cos(2 * Math.PI * hz * index / rate);
      imaginary += data[index] * weight * Math.sin(2 * Math.PI * hz * index / rate);
    }
    return Math.hypot(real, imaginary);
  }
  function fundamental(data, rate, start, end) {
    let best = { hz: 0, strength: 0 };
    for (let hz = 300; hz < 800; hz++) {
      const strength = amplitude(data, hz, rate, start, end);
      if (strength > best.strength) best = { hz, strength };
    }
    return best.hz;
  }
  for (const rate of [16_000, 44_100, 48_000]) {
    for (const action of ['join', 'leave']) {
      const rendered = await render(rate, action), data = rendered.samples;
      const old = (await render(rate, action, 1, true)).samples;
      check(data.every(Number.isFinite) && peak(data) > 0.05 && peak(data) < 0.13, 'finite nonzero samples without clipping', { rate, action, peak: peak(data) });
      check(peak(data) <= peak(old) && energy(data) <= energy(old), 'no increase in peak or fixed-window energy', { rate, action, peakRatio: peak(data) / peak(old), energyRatio: energy(data) / energy(old) });
      const last = data.findLastIndex(sample => Math.abs(sample) > 1e-7) / rate;
      check(last > 0.15 && last < 0.174 && peak(data.subarray(Math.ceil(rate * 0.174))) === 0, 'short cue with exact-silent tail', { rate, action, lastAudibleSeconds: last });
      check(data[0] === 0 && Math.abs(data[1]) < 0.001 && peak(data.subarray(Math.floor(rate * 0.168), Math.ceil(rate * 0.174))) < 1e-5, 'soft zero onset and silent stop avoid edge clicks', { rate, action });
      check(rendered.oscillatorDisconnects === 2 && rendered.gainDisconnects === 2 && rendered.volume === 1, 'finished cue disconnects only its own nodes', { rate, action });
      const first = fundamental(data, rate, 0.008, 0.05), second = fundamental(data, rate, 0.086, 0.128);
      const expected = action === 'join' ? [523.25, 659.25] : [493.88, 392];
      check(Math.abs(first - expected[0]) < 4 && Math.abs(second - expected[1]) < 4, 'original rising/falling note identity is retained', { rate, action, first, second });
      const harmonicRatio = amplitude(data, 2 * expected[0], rate, 0.008, 0.05) / amplitude(data, expected[0], rate, 0.008, 0.05);
      check(harmonicRatio > 0.1 && harmonicRatio < 0.2, 'restrained second harmonic adds definition', { rate, action, harmonicRatio });
      if (rate === 48_000) { previews[action] = Array.from(data); previews['old-' + action] = Array.from(old); }
    }
  }
  const full = (await render(48_000, 'join')).samples;
  const half = (await render(48_000, 'join', 0.5)).samples;
  check(full.every((sample, index) => Math.abs(half[index] - sample * 0.5) < 1e-7), 'selected master volume remains proportional');
  for (const action of ['join', 'leave']) check(peak((await render(48_000, action, 0)).samples) === 0, 'master mute remains completely silent', { action });
  const silence = Array(48_000 * 0.3).fill(0);
  previews['before-after'] = [...previews['old-join'], ...silence, ...previews.join, ...silence, ...previews['old-leave'], ...silence, ...previews.leave];
  delete previews['old-join']; delete previews['old-leave'];
  return { checks, previews };
}
