// Runs the production graph in real Chromium Web Audio, without opening a
// microphone, playing sound, or contacting a signaling server. No Vite needed.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const os = require('node:os');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cove-microphone-test-')));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const timeout = setTimeout(() => {
  console.error('microphoneProcessing: test timeout');
  app.exit(1);
}, 45_000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  try {
    await win.loadURL('about:blank');
    const compiled = ts.transpileModule(
      fs.readFileSync(path.join(__dirname, '../src/microphoneProcessing.ts'), 'utf8'),
      { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } },
    ).outputText;
    await win.webContents.executeJavaScript(`window.mic = (() => { const exports = {}; ${compiled}; return exports; })(); true`);
    const results = await win.webContents.executeJavaScript(`(${audioTests.toString()})()`);
    console.log('microphoneProcessing: PASS', JSON.stringify(results, null, 2));
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error('microphoneProcessing: FAIL', error);
    clearTimeout(timeout);
    app.exit(1);
  }
});

async function audioTests() {
  const { connectMicrophoneGain, setMicrophoneGain, createProcessedMicrophone, MICROPHONE_HEADROOM } = window.mic;
  const checks = [];
  function check(condition, label, metrics = {}) {
    if (!condition) throw new Error(label + ': ' + JSON.stringify(metrics));
    checks.push({ label, ...metrics });
  }
  const samples = (rate, seconds, fn) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => fn(i / rate));
  const maxAbs = (data) => data.reduce((max, x) => Math.max(max, Math.abs(x)), 0);
  function amplitude(data, hz, rate, start, count) {
    let real = 0, imag = 0;
    for (let i = start; i < start + count; i++) {
      real += data[i] * Math.cos(2 * Math.PI * hz * i / rate);
      imag += data[i] * Math.sin(2 * Math.PI * hz * i / rate);
    }
    return 2 * Math.hypot(real, imag) / count;
  }
  async function render(input, rate, volume, schedule) {
    const context = new OfflineAudioContext(1, input.length, rate);
    const buffer = context.createBuffer(1, input.length, rate);
    buffer.copyToChannel(input, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = connectMicrophoneGain(context, source, context.destination, volume);
    const pending = schedule?.(context, gain);
    source.start();
    const output = (await context.startRendering()).getChannelData(0);
    await pending;
    return output;
  }

  for (const rate of [16_000, 44_100, 48_000]) {
    const impulse = new Float32Array(rate);
    impulse[100] = 0.1;
    const impulseOut = await render(impulse, rate, 1);
    const lag = impulseOut.findIndex((x) => Math.abs(x) > 0.01) - 100;
    check(lag >= 0 && lag <= rate * 0.007, 'bounded native lookahead', { rate, lag });
    const input = samples(rate, 2, (t) => 0.08 * Math.sin(2 * Math.PI * 100 * t)
      + 0.06 * Math.sin(2 * Math.PI * 150 * t) + 0.05 * Math.sin(2 * Math.PI * 1125 * t)
      + 0.04 * Math.sin(2 * Math.PI * 3200 * t));
    const output = await render(input, rate, 1);
    let energy = 0, error = 0;
    for (let i = rate / 2; i < output.length - lag; i++) {
      const expected = input[i] * MICROPHONE_HEADROOM;
      energy += expected * expected;
      error += (output[i + lag] - expected) ** 2;
    }
    const snrDb = 10 * Math.log10(energy / Math.max(error, 1e-30));
    check(snrDb > 90, 'speech harmonics preserved at normal volume', { rate, snrDb });
    check(maxAbs(await render(input, rate, 0)) === 0, 'zero volume is silent', { rate });
  }

  const rate = 48_000;
  const tone = samples(rate, 10, (t) => 0.1 * Math.sin(2 * Math.PI * 1125 * t));
  const output = await render(tone, rate, 1);
  const early = amplitude(output, 1125, rate, rate, rate);
  const late = amplitude(output, 1125, rate, 8 * rate, rate);
  const sideband = Math.max(amplitude(output, 750, rate, rate, rate), amplitude(output, 1500, rate, rate, rate));
  check(Math.abs(late / early - 1) < 0.0001, 'sustained speech is not learned as noise', { early, late });
  check(sideband / early < 1e-5, 'no 375 Hz reconstruction sidebands', { sidebandRatio: sideband / early });
  const boosted = await render(tone.subarray(0, rate), rate, 2);
  check(Math.abs(amplitude(boosted, 1125, rate, rate / 2, rate / 2) - 0.2 * MICROPHONE_HEADROOM) < 1e-5, 'quiet speech can be amplified to 200%');

  // Abrupt loud onsets and speech-like bursts catch clipping and release-state
  // regressions that a steady sine alone would miss.
  for (const hz of [100, 1125, 6000]) {
    const loud = samples(rate, 1, (t) => t < 0.1 || (t % 0.17) < 0.04 ? 0 : 0.99 * Math.sin(2 * Math.PI * hz * t));
    const peak = maxAbs(await render(loud, rate, 2));
    check(peak < 1, 'boosted loud bursts avoid digital overload', { hz, peak });
  }

  const constant = samples(rate, 0.5, () => 0.1);
  const ramp = await render(constant, rate, 1, (context, gain) => {
    const first = context.suspend(0.1).then(() => { setMicrophoneGain(gain, 2); return context.resume(); });
    const second = context.suspend(0.11).then(() => { setMicrophoneGain(gain, 0); return context.resume(); });
    return Promise.all([first, second]);
  });
  let maxStep = 0;
  for (let i = rate * 0.08; i < rate * 0.2; i++) maxStep = Math.max(maxStep, Math.abs(ramp[i] - ramp[i - 1]));
  check(maxStep < 0.0005, 'rapid volume changes remain continuous', { maxStep });
  check(maxAbs(ramp.subarray(rate * 0.2)) === 0, 'volume ramp reaches exact silence');

  // Exercise the actual MediaStream factory with synthetic input. It must not
  // stop the original capture when the processed output is disposed.
  const capture = new AudioContext({ sampleRate: rate });
  const oscillator = capture.createOscillator();
  const rawDestination = capture.createMediaStreamDestination();
  oscillator.connect(rawDestination);
  oscillator.start();
  await capture.resume();
  let processed;
  try {
    processed = await createProcessedMicrophone(rawDestination.stream, 1, () => new AudioContext({ sampleRate: rate }));
    check(processed.stream !== rawDestination.stream && processed.context?.state === 'running', 'live MediaStream gain graph starts');
    check(processed.stream.getAudioTracks()[0].contentHint === 'speech', 'processed track is marked as speech');
    const analyser = processed.context.createAnalyser();
    const meter = processed.context.createMediaStreamSource(processed.stream);
    meter.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let peak = 0;
    for (let attempt = 0; attempt < 20 && peak < 0.01; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      analyser.getFloatTimeDomainData(data);
      peak = maxAbs(data);
    }
    check(peak > 0.01, 'live processed track contains audio samples', { peak });
    meter.disconnect();
    await testWebRtc(processed.stream, processed.context);
    processed.stream.getTracks().forEach((track) => track.stop());
    await processed.context.close();
    check(rawDestination.stream.getAudioTracks()[0].readyState === 'live', 'disposing graph preserves raw capture');
  } finally {
    if (processed?.context?.state !== 'closed') await processed?.context?.close();
    rawDestination.stream.getTracks().forEach((track) => track.stop());
    oscillator.stop();
    await capture.close();
  }
  return checks;

  async function testWebRtc(stream, context) {
    const sender = new RTCPeerConnection({ iceServers: [] });
    const receiver = new RTCPeerConnection({ iceServers: [] });
    const iceErrors = [];
    sender.onicecandidate = ({ candidate }) => {
      if (candidate) receiver.addIceCandidate(candidate).catch((error) => iceErrors.push(String(error)));
    };
    receiver.onicecandidate = ({ candidate }) => {
      if (candidate) sender.addIceCandidate(candidate).catch((error) => iceErrors.push(String(error)));
    };
    let meter;
    const activation = new Audio();
    activation.muted = true;
    activation.volume = 0;
    try {
      const received = new Promise((resolve) => { receiver.ontrack = (event) => resolve(event.streams[0]); });
      const track = stream.getAudioTracks()[0];
      const rtpSender = sender.addTrack(track, stream);
      await sender.setLocalDescription(await sender.createOffer());
      await receiver.setRemoteDescription(sender.localDescription);
      await receiver.setLocalDescription(await receiver.createAnswer());
      await sender.setRemoteDescription(receiver.localDescription);
      const remote = await received;
      // Match createRemoteAudioOutput: Chromium's remote-stream playout must
      // be activated even when its samples are read through Web Audio.
      activation.srcObject = remote;
      await activation.play();
      meter = context.createMediaStreamSource(remote);
      const analyser = context.createAnalyser();
      meter.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      let peak = 0;
      for (let attempt = 0; attempt < 60 && peak < 0.01; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        analyser.getFloatTimeDomainData(data);
        peak = maxAbs(data);
      }
      check(peak > 0.01, 'WebRTC loopback receiver gets processed microphone audio', { peak });
      const report = await rtpSender.getStats();
      const outbound = [...report.values()].find((stat) => stat.type === 'outbound-rtp' && stat.kind === 'audio');
      const codec = outbound && report.get(outbound.codecId);
      check(outbound?.bytesSent > 0 && codec?.mimeType.toLowerCase() === 'audio/opus', 'processed audio is sent through Opus', { bytesSent: outbound?.bytesSent, codec: codec?.mimeType });
      track.enabled = false;
      await new Promise((resolve) => setTimeout(resolve, 500));
      analyser.getFloatTimeDomainData(data);
      check(maxAbs(data) < 0.005, 'disabled microphone is silent at WebRTC receiver', { peak: maxAbs(data) });
      track.enabled = true;
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        analyser.getFloatTimeDomainData(data);
        if (maxAbs(data) > 0.01) break;
      }
      check(maxAbs(data) > 0.01, 'microphone resumes after mute');
      check(iceErrors.length === 0, 'loopback ICE succeeds', { iceErrors });
    } finally {
      activation.pause();
      activation.srcObject = null;
      meter?.disconnect();
      sender.close();
      receiver.close();
    }
  }
}
