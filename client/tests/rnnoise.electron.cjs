// Real Chromium/WASM checks using generated noise only; no microphone access.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cove-rnnoise-test-')));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const watchdog = setTimeout(() => { console.error('RNNoise test timeout'); app.exit(1); }, 45_000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  async function inject(name, file, loader) {
    const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/', file), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const raw = {
      '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js?raw': loader,
      './rnnoiseProcessor.js?raw': fs.readFileSync(path.join(__dirname, '../src/rnnoiseProcessor.js'), 'utf8'),
    };
    await win.webContents.executeJavaScript(`(() => {
      const exports = {}, raw = ${JSON.stringify(raw)};
      const require = (id) => id === './microphoneProcessing' ? window.mic : { default: raw[id] };
      ${compiled}
      window[${JSON.stringify(name)}] = exports;
    })()`);
  }
  try {
    await win.loadFile(path.join(__dirname, 'fixtures/audio-host.html'));
    await inject('mic', 'microphoneProcessing.ts');
    await inject('rn', 'rnnoiseMicrophone.ts', fs.readFileSync(require.resolve('@jitsi/rnnoise-wasm/dist/rnnoise-sync.js'), 'utf8'));
    await inject('brokenRn', 'rnnoiseMicrophone.ts', 'function createRNNWasmModuleSync() { throw new Error("Deliberately broken model"); }');
    // Optional locally generated speech WAV, never a microphone recording.
    if (process.argv[2]) await win.webContents.executeJavaScript(`window.speechWav = ${JSON.stringify(fs.readFileSync(process.argv[2]).toString('base64'))}; true`);
    const result = await win.webContents.executeJavaScript(`(${runAudioChecks.toString()})()`);
    console.log('RNNoise WASM: PASS', JSON.stringify(result, null, 2));
    clearTimeout(watchdog);
    app.exit(0);
  } catch (error) {
    console.error('RNNoise WASM: FAIL', error);
    clearTimeout(watchdog);
    app.exit(1);
  }
});

async function runAudioChecks() {
  const checks = [];
  const check = (condition, name, metrics = {}) => {
    if (!condition) throw new Error(name + ': ' + JSON.stringify(metrics));
    checks.push({ name, ...metrics });
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const capture = new AudioContext({ sampleRate: 48000 });
  const raw = capture.createMediaStreamDestination();
  const noise = capture.createBufferSource();
  const buffer = capture.createBuffer(1, 48000 * 2, 48000);
  let seed = 7;
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[i] = ((seed / 0x100000000) * 2 - 1) * 0.04;
  }
  noise.buffer = buffer;
  noise.loop = true;
  noise.connect(raw);
  noise.start();
  await capture.resume();
  async function rms(stream, windows = 8) {
    const meter = capture.createMediaStreamSource(stream);
    const analyser = capture.createAnalyser();
    analyser.fftSize = 4096;
    meter.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let energy = 0;
    for (let i = 0; i < windows; i++) {
      await wait(50);
      analyser.getFloatTimeDomainData(samples);
      for (const x of samples) { if (!Number.isFinite(x)) throw Error('Non-finite audio'); energy += x * x; }
    }
    meter.disconnect();
    return Math.sqrt(energy / (samples.length * windows));
  }
  const contexts = [];
  try {
    const baseline = await rms(raw.stream);
    check(baseline > 0.01, 'synthetic input contains noise', { baseline });
    for (let cycle = 0; cycle < 2; cycle++) {
      const rn = await window.rn.createRnnoiseMicrophone(raw.stream, 1);
      contexts.push(rn.context);
      check(rn.context.state === 'running' && rn.stream.getAudioTracks()[0].readyState === 'live', 'model initializes a live stream', { cycle });
      await wait(800);
      const filtered = await rms(rn.stream);
      const reductionDb = 20 * Math.log10(baseline / Math.max(filtered, 1e-12));
      check(reductionDb > 8, 'real RNNoise reduces stationary noise', { cycle, filtered, reductionDb });
      rn.processor.port.postMessage({ type: 'dispose' });
      rn.stream.getTracks().forEach((track) => track.stop());
      await rn.context.close();
      check(raw.stream.getAudioTracks()[0].readyState === 'live', 'disposing experiment preserves capture', { cycle });
      const rawReference = await rms(raw.stream);
      const system = await window.mic.createProcessedMicrophone(raw.stream, 1, () => new AudioContext({ sampleRate: 48000 }));
      contexts.push(system.context);
      const restored = await rms(system.stream);
      check(restored > rawReference * 0.75 && restored < rawReference * 1.01, 'original gain path works again after rollback', { cycle, baseline, rawReference, restored });
      system.stream.getTracks().forEach((track) => track.stop());
      await system.context.close();
    }
    let rejected = false;
    try { await window.brokenRn.createRnnoiseMicrophone(raw.stream, 1); }
    catch { rejected = true; }
    check(rejected, 'broken model fails instead of silently passing untreated capture');
    check(raw.stream.getAudioTracks()[0].readyState === 'live', 'failed initialization does not stop caller capture');
    if (window.speechWav) {
      noise.disconnect();
      const speech = capture.createBufferSource();
      speech.buffer = await capture.decodeAudioData(Uint8Array.from(atob(window.speechWav), (x) => x.charCodeAt(0)).buffer);
      speech.loop = true;
      speech.connect(raw);
      const rn = await window.rn.createRnnoiseMicrophone(raw.stream, 1);
      contexts.push(rn.context);
      speech.start();
      await wait(800);
      const [inputRms, outputRms] = await Promise.all([rms(raw.stream, 64), rms(rn.stream, 64)]);
      check(inputRms > 0.005 && outputRms > inputRms * 0.2 && outputRms < inputRms * 1.5,
        'Chinese synthesized speech remains audible through RNNoise', { inputRms, outputRms });
      speech.stop();
      speech.disconnect();
      rn.stream.getTracks().forEach((track) => track.stop());
      await rn.context.close();
    }
  } finally {
    for (const context of contexts) if (context && context.state !== 'closed') await context.close();
    raw.stream.getTracks().forEach((track) => track.stop());
    noise.stop();
    await capture.close();
  }
  return checks;
}
