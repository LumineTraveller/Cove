// Real Chromium worklet + Opus/RTP loopback. No microphone, desktop capture,
// audible playback, login, production data or signaling server is accessed.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const ts = require('typescript');
const { pathToFileURL } = require('node:url');
const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-shared-audio-test-'));
app.setPath('userData', testDirectory);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const timeout = setTimeout(() => { console.error('applicationAudio: timeout'); app.exit(1); }, 45000);
const processor = fs.readFileSync(path.join(__dirname, '../src/features/media/application-audio/applicationAudioProcessor.js'));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/processor.js' ? 'application/javascript' : 'text/html');
  res.end(req.url === '/processor.js' ? processor : '<!doctype html><title>isolated shared audio test</title>');
});
app.whenReady().then(async () => {
  let win;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
    await win.loadURL(`http://127.0.0.1:${server.address().port}`);
    const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8')
      .replace("new URL('./applicationAudioProcessor.js', import.meta.url).href", "window.coveTestWorkletUrl"), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const queue = compile(path.join(__dirname, '../electron/pcmChunkQueue.ts'));
    const pipeline = compile(path.join(__dirname, '../src/features/media/application-audio/applicationAudio.ts'));
    const playout = compile(path.join(__dirname, '../src/features/media/transport/audioPlayoutPolicy.ts'));
    const injection = `window.sharedAudio = (() => {
      const queue = (() => { const exports = {}; ${queue}; return exports; })();
      const require = name => { if (name.endsWith('/pcmChunkQueue')) return queue; throw new Error(name); };
      const exports = {}; ${pipeline}; return exports;
    })(); window.playout = (() => { const exports = {}; ${playout}; return exports; })(); true`;
    await win.webContents.executeJavaScript(`window.coveTestWorkletUrl = new URL('/processor.js', window.location.href).href; ${injection}`);
    const results = await win.webContents.executeJavaScript(`(${audioTests.toString()})()`);
    // Electron production loads file://, not the dev server. Exercise that
    // origin as well; otherwise an HTTP-only worklet test could hide a release
    // regression. The fixture is generated inside the test's own temp directory.
    const fixture = path.join(testDirectory, 'fixture.html');
    fs.writeFileSync(fixture, '<!doctype html><title>isolated file-origin audio test</title>');
    await win.loadFile(fixture);
    const moduleUrl = pathToFileURL(path.join(__dirname, '../src/features/media/application-audio/applicationAudioProcessor.js')).href;
    await win.webContents.executeJavaScript(`window.coveTestWorkletUrl = ${JSON.stringify(moduleUrl)}; ${injection}`);
    const fileMode = await win.webContents.executeJavaScript(`(async () => {
      const pipeline = new window.sharedAudio.ApplicationAudioPipeline(0.5);
      try { await pipeline.resume(); pipeline.prime(); return pipeline.diagnostics.mode; }
      finally { pipeline.close(); }
    })()`);
    if (fileMode !== 'worklet') throw new Error('file-origin worklet failed: ' + fileMode);
    results.push({ label: 'file-origin worklet module initializes (packaged loading path)' });
    console.log('applicationAudio: PASS', JSON.stringify(results));
    app.exit(0);
  } catch (error) { console.error('applicationAudio: FAIL', error); app.exit(1); }
  finally { clearTimeout(timeout); server.close(); if (win && !win.isDestroyed()) win.destroy(); }
});

async function audioTests() {
  const checks = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (ok, label, details = {}) => { if (!ok) throw new Error(label + JSON.stringify(details)); checks.push({ label, ...details }); };
  const pipeline = new window.sharedAudio.ApplicationAudioPipeline(0.5);
  const sender = new RTCPeerConnection({ iceServers: [] });
  const receiver = new RTCPeerConnection({ iceServers: [] });
  const activation = new Audio(); activation.muted = true;
  const playoutPolicy = new window.playout.AudioPlayoutPolicy();
  let timer, source;
  const originalTrack = pipeline.track;
  try {
    await pipeline.resume(); pipeline.prime();
    check(pipeline.diagnostics.mode === 'worklet', 'real AudioWorklet initializes');
    check(originalTrack === pipeline.track && originalTrack.readyState === 'live', 'silent warmup preserves live track');
    const iceErrors = [];
    sender.onicecandidate = ({ candidate }) => { if (candidate) receiver.addIceCandidate(candidate).catch(e => iceErrors.push(String(e))); };
    receiver.onicecandidate = ({ candidate }) => { if (candidate) sender.addIceCandidate(candidate).catch(e => iceErrors.push(String(e))); };
    const received = new Promise(resolve => { receiver.ontrack = e => resolve(e.streams[0]); });
    sender.addTrack(originalTrack, pipeline.destination.stream);
    const offer = await sender.createOffer();
    offer.sdp = offer.sdp.replace(/useinbandfec=1/g, 'useinbandfec=1;usedtx=1;stereo=1');
    await sender.setLocalDescription(offer);
    await receiver.setRemoteDescription(sender.localDescription);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);
    const remote = await received;
    const rtpReceiver = receiver.getReceivers()[0];
    playoutPolicy.watch({ id: 'loopback', kind: 'audio', rtpReceiver, track: rtpReceiver.track,
      getStats: () => rtpReceiver.getStats() }, 'mic-loopback', 'audio');
    if ('jitterBufferTarget' in rtpReceiver)
      check(rtpReceiver.jitterBufferTarget === 40, 'real jitterBufferTarget accepts milliseconds', { target: rtpReceiver.jitterBufferTarget });
    else if ('playoutDelayHint' in rtpReceiver)
      check(rtpReceiver.playoutDelayHint === 0.04, 'real playoutDelayHint accepts seconds');
    activation.srcObject = remote; await activation.play();
    await sleep(300);
    let silentPackets = 0;
    (await sender.getStats()).forEach(s => { if (s.type === 'outbound-rtp' && s.kind === 'audio') silentPackets += s.packetsSent || 0; });
    check(silentPackets > 0, 'worklet silence establishes RTP SSRC before captured PCM with Opus DTX', { silentPackets });
    source = pipeline.context.createMediaStreamSource(remote);
    const analyser = pipeline.context.createAnalyser(); analyser.fftSize = 2048; source.connect(analyser);
    const values = new Float32Array(analyser.fftSize);
    const peak = () => { analyser.getFloatTimeDomainData(values); return values.reduce((p, x) => Math.max(p, Math.abs(x)), 0); };
    let supplied = 0;
    const start = performance.now();
    const pump = () => {
      const due = Math.floor((performance.now() - start) * 48) + 1440;
      const frames = due - supplied;
      if (frames <= 0) return;
      const pcm = new Uint8Array(frames * 4), view = new DataView(pcm.buffer);
      for (let i = 0; i < frames; i++) {
        const value = Math.round(32767 * 0.1 * Math.sin(2 * Math.PI * 1125 * (supplied + i) / 48000));
        view.setInt16(i * 4, value, true); view.setInt16(i * 4 + 2, value, true);
      }
      pipeline.pushPcm(pcm); supplied += frames;
      if (!pcm.byteLength) throw new Error('caller PCM was detached');
    };
    pump(); timer = setInterval(pump, 10);
    let audible = 0;
    for (let i = 0; i < 60 && audible < 0.02; i++) { await sleep(50); audible = peak(); }
    check(audible > 0.02, 'shared PCM crosses real Opus/RTP without a second audible path', { audible });
    check(iceErrors.length === 0, 'ICE loopback has no errors', { iceErrors });
    await sleep(1500);
    check(pipeline.diagnostics.bufferedMs <= 120 && pipeline.diagnostics.targetMs <= 80,
      'real audio-thread ring remains bounded', pipeline.diagnostics);
    pipeline.setVolume(0); await sleep(300);
    check(peak() < 0.001, 'zero master volume stays silent');
    pipeline.setVolume(0.75); await sleep(300);
    check(peak() > 0.03, 'volume changes recover on the same track');
    // Emulate a main/UI scheduling stall, then restore the source clock. Old
    // backlog is bounded and discarded, rather than shifting the whole track.
    const blockedUntil = performance.now() + 180;
    while (performance.now() < blockedUntil) { /* intentional test stall */ }
    pump(); await sleep(1300);
    check(peak() > 0.03 && pipeline.track === originalTrack
      && pipeline.diagnostics.bufferedMs <= pipeline.diagnostics.targetMs + 30,
      'recovers low water level after UI stall without replacing SSRC track', pipeline.diagnostics);
    const stats = await receiver.getStats();
    let packets = 0; stats.forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'audio') packets += s.packetsReceived || 0; });
    check(packets > 20, 'receiver decodes live RTP packets', { packets });
  } finally {
    clearInterval(timer); activation.pause(); activation.srcObject = null;
    source?.disconnect(); playoutPolicy.dispose(); sender.close(); receiver.close(); pipeline.close(); pipeline.close();
  }
  check(originalTrack.readyState === 'ended' && pipeline.context.state === 'closed', 'close tears down track and context');
  return checks;
}
