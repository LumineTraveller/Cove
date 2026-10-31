'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { spawn } = require('node:child_process');
const { configuration, dimensions, stamp, writeHeader, sendIpcChunks, REASSEMBLY_DEADLINE_MS, Pool, summary, demand } = require('./protocol.cjs');
const { createTransport } = require('./transport.cjs');
const { startPacer, binary: pacerBinary } = require('./pacer.cjs');
const root = path.resolve(__dirname, '../../..');
const runtime = path.join(root, 'runtime/cpu-frame-socket-probe');
const PREFIX = 'cove:cpu-frame-probe:';
const electronModule = path.join(root, 'apps/desktop/node_modules/electron');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
function codeOf(error) { return /^[a-z0-9_]{1,80}$/.test(error?.message) ? error.message : 'cpu_frame_probe_failed'; }
async function bounded(promise, milliseconds, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, milliseconds, code, check) {
  const end = performance.now() + milliseconds;
  while (!predicate()) { check?.(); if (performance.now() >= end) throw new Error(code); await delay(5); }
  check?.();
}
function cpuSnapshot(app) {
  const processes = app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type,
    seconds: Number.isFinite(metric.cpu?.cumulativeCPUUsage) ? metric.cpu.cumulativeCPUUsage : null }));
  return { at: performance.now(), main: process.cpuUsage(), processes };
}
function cpuDifference(before, after) {
  const stable = before.processes.length === after.processes.length && before.processes.every(previous =>
    after.processes.some(current => current.pid === previous.pid && current.type === previous.type &&
      previous.seconds !== null && current.seconds !== null && current.seconds >= previous.seconds));
  const wallSeconds = (after.at - before.at) / 1000;
  const sum = snapshot => snapshot.processes.reduce((total, entry) => total + entry.seconds, 0);
  const cpuSeconds = stable ? sum(after) - sum(before) : null;
  return { scope: 'All Electron app processes; synthetic frame transport/construction only. Native pacer CPU is separate in pacer.terminal. No capture/codec/receiver.',
    wallSeconds, logicalProcessors: os.cpus().length, processSetStable: stable,
    before: before.processes.map(entry => ({ type: entry.type, cumulativeCPUSeconds: entry.seconds })),
    after: after.processes.map(entry => ({ type: entry.type, cumulativeCPUSeconds: entry.seconds })),
    totalCPUSeconds: cpuSeconds, coreEquivalent: cpuSeconds === null ? null : cpuSeconds / wallSeconds,
    hostNormalizedPercent: cpuSeconds === null ? null : 100 * cpuSeconds / wallSeconds / os.cpus().length,
    mainUserMs: (after.main.user - before.main.user) / 1000, mainSystemMs: (after.main.system - before.main.system) / 1000 };
}
async function launch() {
  const config = configuration(process.argv.slice(2));
  demand(require(path.join(electronModule, 'package.json')).version === '44.0.0', 'desktop_electron44_required');
  if (config.pacer === 'native') demand(fs.existsSync(pacerBinary), 'built_native_pacer_required');
  fs.mkdirSync(runtime, { recursive: true });
  const directory = fs.mkdtempSync(path.join(runtime, 'run-'));
  const env = { ...process.env, COVE_CPU_SOCKET_PROBE_DIR: directory, COVE_CPU_SOCKET_PROBE_CONFIG: JSON.stringify(config) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require(electronModule), [__filename], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  // Drain Chromium output without persisting arbitrary diagnostics, addresses,
  // profile contents, exception strings, synthetic pixels or any credentials.
  child.stdout.resume(); child.stderr.resume();
  let stopping = null, interrupted = false, timedOut = false;
  const cancel = () => stopping ||= (async () => {
    if (child.connected) child.send({ type: 'stop' }, () => {});
    for (let index = 0; index < 30 && child.exitCode === null && child.signalCode === null; ++index) await delay(100);
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(); }); killer.once('close', resolve);
    });
  })();
  const interrupt = () => { interrupted = true; void cancel(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const watchdog = setTimeout(() => { timedOut = true; void cancel(); }, (config.seconds + config.warmup + 9) * config.modes.length * 1000 + 10000);
  let exitCode;
  try { exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(watchdog); await stopping; process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
  const profile = path.join(directory, 'profile');
  demand(inside(runtime, directory) && inside(directory, profile) && path.basename(profile) === 'profile', 'profile_cleanup_path_rejected');
  if (fs.existsSync(profile)) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const resultPath = path.join(directory, 'result.json');
  const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
  console.log(JSON.stringify({ directory: path.relative(root, directory), resultPath: path.relative(root, resultPath), exitCode, interrupted, timedOut, result }, null, 2));
  process.exitCode = exitCode || interrupted || timedOut || !result?.passed ? 1 : 0;
}
async function runMode(app, BrowserWindow, ipcMain, config, mode, checkCancelled) {
  const pool = new Pool(config.width, config.height), preload = path.join(__dirname, 'preload.cjs');
  const result = { mode, passed: false, width: config.width, height: config.height, format: 'NV12', targetFps: 120,
    payloadBytes: dimensions(config.width, config.height), poolSize: 3, warmupSeconds: config.warmup, requestedMeasurementSeconds: config.seconds,
    security: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, windowShown: config.window === 'shown',
      noPageBridge: true, origin: 'null', loopbackOnly: mode === 'ws', compression: false, oneAuthorizedClient: mode === 'ws',
      authenticationSecretsPersisted: false, oneTimeClientTokenBits: mode === 'ws' ? 256 : null, independentServerProofBits: mode === 'ws' ? 256 : null },
    wsFraming: mode === 'ws' ? config.wsFraming : null,
    transport: mode === 'ws' ? (config.wsFraming === 'single-copy' ? 'CAUSAL CONTROL: one WebSocket binary frame from a full header+payload Buffer.concat copy per send.'
      : 'One fragmented binary message: 32-byte header, pooled zero-copy Node Buffer view; no Buffer.concat.' +
        (config.wsFraming === 'fragmented-cork' ? ' Both fragments share an outer socket.cork()/uncork() write batch.' : ''))
      : mode === 'ipc-inline-chunks' ? 'Independent exact-sized ArrayBuffer.slice copies + chunk metadata in synchronous mainFrame.send calls; bounded renderer reassembly then the same transferred VideoFrame. All split allocations/copies and sends are inside sendCall time.'
        : 'webContents.mainFrame.send(metadata, pooled ordinary ArrayBuffer); real Electron structured-clone ownership.',
    ipcChunks: mode === 'ipc-inline-chunks' ? { chunkBytes: config.chunkBytes, partsPerFrame: Math.ceil(dimensions(config.width, config.height) / config.chunkBytes),
      fullFrameEnvelopeControl: config.chunkBytes === dimensions(config.width, config.height), reassemblyDeadlineMs: REASSEMBLY_DEADLINE_MS,
      independentMainPayloadCopies: 0, independentMainPayloadCopyBytes: 0, sentParts: 0, measuredSentParts: 0,
      serializedSizeClaim: '48 KiB payload plus fixed metadata is intended for Electron inline serialization; this probe does not inspect Chromium serialized bytes.' } : null,
    validation: 'Independent 4-quadrant Y/UV samples, two source sequence stamps, transferred CPU VideoFrame actual NV12/709 format, post-construction 4x2 NV12 sequence readback, close and detached input for every frame.',
    counters: { sent: 0, acked: 0, ignoredAcks: 0, measuredSent: 0, measuredAcked: 0, noSlotTicks: 0, lateSkippedTicks: 0 },
    latencyClock: 'Main process performance.now() only. ACK round trip includes renderer validation; no one-way latency estimate.' };
  result.passedMeans = 'Frame ownership, validation and cleanup only; syntheticValidated120TargetReached separately reports the paced synthetic target.';
  result.schedulerLatenessClock = config.pacer === 'native' ? 'Native QPC wake lateness; main I/O interval/rate is recorded separately.' : 'Main process performance.now() callback lateness.';
  const samples = { sendCall: [], flush: [], ackRoundTrip: [], construct: [], scheduleLateness: [] };
  let window = null, transport = null, nativePacer = null, failure = null, ready = false, connected = false, rendererReport = null;
  let measuring = false, cpuBefore = null, cpuAfter = null, measuringAt = null, endedAt = null, scheduleTimer = null;
  let scheduleResolve = null, stopping = false, completed = false;
  const listeners = [];
  function fault(code) { failure ||= code; if (scheduleResolve) { clearTimeout(scheduleTimer); scheduleTimer = null; scheduleResolve(); scheduleResolve = null; } }
  function check() { checkCancelled(); if (failure) throw new Error(failure); }
  function ack(value) {
    if (stopping || !value || !Number.isInteger(value.slot) || !Number.isSafeInteger(value.serial) || value.flags !== 7 ||
      !Number.isFinite(value.constructMs) || value.constructMs < 0 || value.constructMs >= 5000) { result.counters.ignoredAcks++; return; }
    const slot = pool.matches(value.slot, value.serial);
    if (!slot || slot.acked) { result.counters.ignoredAcks++; return; }
    const measured = slot.measured, roundTripMs = performance.now() - slot.sentAt;
    if (!pool.ack(value.slot, value.serial)) { result.counters.ignoredAcks++; return; }
    result.counters.acked++;
    if (measured) { result.counters.measuredAcked++; samples.ackRoundTrip.push(roundTripMs); samples.construct.push(value.constructMs); }
  }
  function listen(type, callback) {
    const listener = (event, ...values) => {
      if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
      try { callback(...values); } catch (error) { fault(codeOf(error)); }
    };
    ipcMain.on(PREFIX + type, listener); listeners.push([PREFIX + type, listener]);
  }
  try {
    window = new BrowserWindow({ show: config.window === 'shown', width: 160, height: 120, webPreferences: { preload, sandbox: true,
      contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, spellcheck: false } });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('render-process-gone', () => fault('renderer_process_gone'));
    window.webContents.on('preload-error', () => fault('sandbox_preload_failed'));
    window.on('closed', () => { if (!stopping) fault('probe_window_closed'); });
    listen('ready', () => { if (ready) fault('duplicate_renderer_ready'); else ready = true; });
    listen('connected', () => { if (connected) fault('duplicate_renderer_connected'); else connected = true; });
    listen('fault', value => fault(/^[a-z0-9_]{1,80}$/.test(value?.code) ? value.code : 'renderer_fault'));
    listen('ack', value => { if (mode !== 'ws') ack(value); else fault('unexpected_ipc_ack'); });
    listen('stopped', value => { if (stopping && !rendererReport) rendererReport = sanitizeRenderer(value); });
    if (mode === 'ws') transport = await createTransport({ onAck: ack, onError: fault, framing: config.wsFraming });
    // Session filtering is deliberately exact; no real HTTP(S) endpoint or
    // wildcard loopback port can be reached by the otherwise empty page.
    let credentials = transport?.credentials();
    const allowed = credentials ? 'ws://127.0.0.1:' + credentials.port + credentials.path : null;
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      callback({ cancel: /^(?:https?|wss?):/i.test(details.url) && details.url !== allowed });
    });
    const html = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src ' +
      (allowed || "'none'") + '; script-src \'none\'"><title>Cove isolated CPU frame transport</title>';
    await bounded(window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)), 3000, 'probe_page_load_timeout');
    await until(() => ready, 1500, 'renderer_ready_timeout', check);
    window.webContents.mainFrame.send(PREFIX + 'init', { mode, width: config.width, height: config.height,
      chunkBytes: config.chunkBytes, reassemblyDeadlineMs: REASSEMBLY_DEADLINE_MS, ...credentials });
    credentials = null;
    await until(() => connected, 2000, 'renderer_connect_timeout', check);
    if (transport) demand(transport.state().authenticated && !transport.state().listenerOpen, 'loopback_listener_not_retired');
    const durationMs = (config.warmup + config.seconds) * 1000, period = 1000 / 120;
    let tick = 0, serial = 0, previousTick = 0, pacerCallbacks = 0, measuredPacerCallbacks = 0;
    let start = performance.now(), finalNativeState = null;
    const finishMeasurement = () => {
      if (endedAt !== null) return;
      endedAt = performance.now(); cpuAfter = cpuSnapshot(app);
      const resolve = scheduleResolve; scheduleResolve = null; resolve?.();
    };
    const dispatchTick = (phase, elapsedMs, lateness) => {
      check(); const now = performance.now();
      pacerCallbacks++;
      if (phase > previousTick + 1) result.counters.lateSkippedTicks += phase - previousTick - 1;
      previousTick = phase;
      if (!measuring && elapsedMs >= config.warmup * 1000) { measuring = true; measuringAt = now; cpuBefore = cpuSnapshot(app); }
      if (elapsedMs >= durationMs) { finishMeasurement(); return; }
      if (measuring) measuredPacerCallbacks++;
      const slot = pool.take(++serial);
      if (!slot) result.counters.noSlotTicks++;
      else {
        slot.measured = measuring; slot.sentAt = performance.now();
        stamp(slot.buffer, config.width, config.height, serial);
        const metadata = { slot: slot.index, serial, width: config.width, height: config.height,
          timestamp: Math.round(phase * 1000000 / 120) };
        const sentSerial = serial, callStarted = performance.now();
        if (mode === 'ws') {
          writeHeader(slot.header, metadata);
          transport.send(slot, () => {
            const current = pool.matches(slot.index, sentSerial);
            if (!current || current.flushed) return;
            if (current.measured) samples.flush.push(performance.now() - current.sentAt);
            pool.flush(slot.index, sentSerial);
          });
        } else if (mode === 'ipc-inline-chunks') {
          // Starting callStarted above the helper includes every independent
          // slice allocation/copy, metadata creation and synchronous send.
          const parts = sendIpcChunks(metadata, slot.buffer, config.chunkBytes,
            (part, buffer) => window.webContents.mainFrame.send(PREFIX + 'chunk', part, buffer));
          result.ipcChunks.independentMainPayloadCopies += parts;
          result.ipcChunks.independentMainPayloadCopyBytes += result.payloadBytes;
          result.ipcChunks.sentParts += parts;
          if (measuring) result.ipcChunks.measuredSentParts += parts;
          // No partial/chunk ACK grants credit: release still needs one final
          // validated frame ACK and completion of the complete synchronous loop.
          pool.flush(slot.index, sentSerial);
        } else {
          window.webContents.mainFrame.send(PREFIX + 'frame', metadata, slot.buffer);
          pool.flush(slot.index, sentSerial);
        }
        const callMs = performance.now() - callStarted;
        demand(slot.buffer.byteLength === result.payloadBytes, 'main_pool_buffer_detached');
        result.counters.sent++;
        if (measuring) { result.counters.measuredSent++; samples.sendCall.push(callMs); samples.scheduleLateness.push(lateness); }
      }
    };
    await new Promise(resolve => {
      scheduleResolve = resolve;
      if (config.pacer === 'native') {
        try {
          nativePacer = startPacer({ seconds: config.warmup + config.seconds, check,
            onReady: () => { start = performance.now(); },
            onTick: value => { if (scheduleResolve) dispatchTick(value.seq, value.elapsedUs / 1000, value.lateUs / 1000); } });
          nativePacer.done.then(state => {
            finalNativeState = state;
            if (state.terminal?.reason !== 'duration' || !state.terminal?.writerJoined) fault('native_pacer_incomplete');
            else finishMeasurement();
          }, error => fault(codeOf(error)));
        } catch (error) { fault(codeOf(error)); }
        return;
      }
      function schedule() {
        scheduleTimer = null;
        try {
          check(); const now = performance.now();
          if (now - start >= durationMs) { finishMeasurement(); return; }
          const due = start + tick * period;
          if (now < due) { scheduleTimer = setTimeout(schedule, Math.max(.25, due - now)); return; }
          const newestDue = Math.floor((now - start) / period);
          if (newestDue > tick) tick = newestDue;
          const lateness = now - (start + tick * period); tick++;
          dispatchTick(tick, now - start, lateness);
          scheduleTimer = setTimeout(schedule, Math.max(.25, start + tick * period - performance.now()));
        } catch (error) { fault(codeOf(error)); }
      }
      schedule();
    });
    check();
    if (nativePacer) finalNativeState = await bounded(nativePacer.done, 1500, 'native_pacer_finish_timeout');
    demand(measuring && measuringAt !== null && endedAt !== null && cpuBefore && cpuAfter, 'measurement_window_missing');
    await until(() => pool.inFlight === 0, 1500, 'frame_drain_timeout', check);
    completed = true;
    result.measurementWallSeconds = (endedAt - measuringAt) / 1000;
    result.acknowledgedMeasuredFramesPerSecond = result.counters.measuredAcked / result.measurementWallSeconds;
    result.sentMeasuredFramesPerSecond = result.counters.measuredSent / result.measurementWallSeconds;
    result.cpu = cpuDifference(cpuBefore, cpuAfter);
    result.pacer = { ...(finalNativeState || { kind: 'node-setTimeout-control', targetFps: 120 }),
      callbackTicks: pacerCallbacks, measuredCallbackTicks: measuredPacerCallbacks,
      measuredMainCallbackTicksPerSecond: measuredPacerCallbacks / result.measurementWallSeconds };
    result.pacer120Qualified = config.pacer === 'native' && finalNativeState.sourceTicksPerSecond >= 118 &&
      finalNativeState.sourceTicksPerSecond <= 122 && result.pacer.measuredMainCallbackTicksPerSecond >= 118;
    result.syntheticValidated120TargetReached = result.pacer120Qualified && result.acknowledgedMeasuredFramesPerSecond >= 118;
  } catch (error) { result.errorCode = codeOf(error); }
  finally {
    stopping = true; clearTimeout(scheduleTimer); scheduleTimer = null; scheduleResolve = null;
    if (nativePacer) { await nativePacer.stop(); result.pacerAfterCleanup = nativePacer.state(); }
    result.counters.maxInFlight = pool.maxInFlight;
    result.counters.slotsStillInFlightAtStop = pool.inFlight;
    result.counters.releasedSlots = pool.releases;
    if (window && !window.isDestroyed()) {
      try { window.webContents.mainFrame.send(PREFIX + 'stop'); await until(() => !!rendererReport, 1000, 'renderer_stop_timeout'); }
      catch { result.errorCode ||= 'renderer_stop_timeout'; }
    }
    await transport?.stop();
    result.socketAfterCleanup = transport?.state() || null;
    result.socketDiagnostics = transport?.diagnostics() || null;
    pool.stop();
    result.renderer = rendererReport;
    for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
    if (window && !window.isDestroyed()) { window.webContents.session.webRequest.onBeforeRequest(null); window.destroy(); }
    result.cleanup = { rendererWindowAlive: !!window && !window.isDestroyed(), pendingScheduleTimer: !!scheduleTimer,
      poolRetained: pool.slots.some(slot => slot.buffer || slot.payload || slot.header), listenersRetained: listeners.some(([channel, listener]) => ipcMain.listeners(channel).includes(listener)),
      loopbackListenerOpen: transport?.state().listenerOpen || false, loopbackSockets: transport?.state().socketCount || 0,
      loopbackWebsockets: transport?.state().websocketCount || 0, pacerChildAlive: nativePacer?.state().childAlive || false,
      pendingPacerImmediate: nativePacer?.state().pendingImmediate || false };
    result.timingsMs = { sendCall: summary(samples.sendCall), wsFlush: summary(samples.flush), acknowledgementRoundTrip: summary(samples.ackRoundTrip),
      rendererVideoFrameConstruct: summary(samples.construct), schedulerLateness: summary(samples.scheduleLateness) };
    result.measuredMainSendCallTotalMs = samples.sendCall.reduce((total, value) => total + value, 0);
    const clean = !result.cleanup.rendererWindowAlive && !result.cleanup.pendingScheduleTimer && !result.cleanup.poolRetained &&
      !result.cleanup.listenersRetained && !result.cleanup.loopbackListenerOpen && result.cleanup.loopbackSockets === 0 && result.cleanup.loopbackWebsockets === 0 &&
      !result.cleanup.pacerChildAlive && !result.cleanup.pendingPacerImmediate;
    const chunksVerified = mode !== 'ipc-inline-chunks' || rendererReport?.ipcChunks &&
      rendererReport.ipcChunks.parts === result.ipcChunks.sentParts && rendererReport.ipcChunks.payloadBytes === result.counters.sent * result.payloadBytes &&
      rendererReport.ipcChunks.frames === result.counters.sent && rendererReport.ipcChunks.maxSlots <= 3 &&
      rendererReport.ipcChunks.maxRetainedBytes <= 3 * result.payloadBytes && rendererReport.ipcChunks.partials === 0 &&
      rendererReport.ipcChunks.processingSlots === 0 && rendererReport.ipcChunks.timers === 0 && rendererReport.ipcChunks.retainedBytes === 0;
    const verified = chunksVerified && rendererReport?.resourcesDisposed && rendererReport.constructed === result.counters.sent &&
      rendererReport.detached === rendererReport.constructed && rendererReport.closed === rendererReport.constructed &&
      rendererReport.validated === rendererReport.constructed && rendererReport.acked === result.counters.acked &&
      rendererReport.rejected === 0 && rendererReport.pixelErrors === 0 && rendererReport.sequenceErrors === 0 && rendererReport.maxPending <= 3;
    result.passed = completed && !result.errorCode && clean && verified && pool.maxInFlight <= 3 &&
      result.counters.slotsStillInFlightAtStop === 0 && result.counters.sent === result.counters.acked && result.counters.measuredAcked > 0;
    if (!result.passed) result.errorCode ||= 'validation_or_cleanup_incomplete';
  }
  return result;
}
function sanitizeRenderer(value) {
  if (!value || typeof value !== 'object') throw new Error('invalid_renderer_report');
  const report = {};
  for (const name of ['received', 'constructed', 'detached', 'closed', 'validated', 'acked', 'rejected', 'pixelErrors', 'sequenceErrors',
    'maxPending', 'pendingAfterCleanup', 'framesAfterCleanup']) {
    demand(Number.isSafeInteger(value[name]) && value[name] >= 0 && value[name] <= 100000, 'invalid_renderer_counter'); report[name] = value[name];
  }
  report.resourcesDisposed = value.resourcesDisposed === true && value.socketReferenceRetained === false && value.helloTimerActive === false &&
    report.pendingAfterCleanup === 0 && report.framesAfterCleanup === 0;
  if (value.ipcChunks) {
    report.ipcChunks = {};
    for (const name of ['parts', 'payloadBytes', 'frames', 'maxSlots', 'maxRetainedBytes', 'partials', 'processingSlots', 'timers', 'retainedBytes']) {
      demand(Number.isSafeInteger(value.ipcChunks[name]) && value.ipcChunks[name] >= 0 && value.ipcChunks[name] <= 1e11, 'invalid_renderer_chunk_counter');
      report.ipcChunks[name] = value.ipcChunks[name];
    }
    report.resourcesDisposed &&= report.ipcChunks.partials === 0 && report.ipcChunks.processingSlots === 0 &&
      report.ipcChunks.timers === 0 && report.ipcChunks.retainedBytes === 0;
    const stat = value.ipcChunks.reassemblyMs;
    demand(Number.isSafeInteger(stat?.count) && stat.count >= 0 && stat.count <= 5000, 'invalid_renderer_chunk_timing');
    report.ipcChunks.reassemblyMs = { count: stat.count };
    for (const metric of ['mean', 'p50', 'p95', 'p99', 'max']) {
      demand(stat[metric] === null && stat.count === 0 || Number.isFinite(stat[metric]) && stat[metric] >= 0 && stat[metric] < 1e9, 'invalid_renderer_chunk_timing');
      report.ipcChunks.reassemblyMs[metric] = stat[metric];
    }
  } else report.ipcChunks = null;
  if (value.scheduling) {
    const scheduling = value.scheduling;
    demand(['hidden', 'visible', 'prerender'].includes(scheduling.initialVisibility) &&
      ['hidden', 'visible', 'prerender'].includes(scheduling.finalVisibility), 'invalid_renderer_visibility');
    report.scheduling = { initialVisibility: scheduling.initialVisibility, finalVisibility: scheduling.finalVisibility,
      focusedAtStop: scheduling.focusedAtStop === true };
    for (const name of ['localReceiveGapMs', 'localProcessingMs', 'localReadbackMs', 'postAckBufferedBytes']) {
      const stat = scheduling[name]; demand(Number.isSafeInteger(stat?.count) && stat.count >= 0 && stat.count <= 5000, 'invalid_renderer_timing_count');
      report.scheduling[name] = { count: stat.count };
      for (const metric of ['mean', 'p50', 'p95', 'p99', 'max']) {
        demand(stat[metric] === null && stat.count === 0 || Number.isFinite(stat[metric]) && stat[metric] >= 0 && stat[metric] < 1e9, 'invalid_renderer_timing');
        report.scheduling[name][metric] = stat[metric];
      }
    }
  }
  const frame = value.actualFrame;
  if (frame) {
    demand(frame.format === 'NV12' && [1728, 1920].includes(frame.codedWidth) && frame.codedHeight === 1080 &&
      frame.displayWidth === frame.codedWidth && frame.displayHeight === 1080 && frame.colorSpace?.primaries === 'bt709' &&
      frame.colorSpace.transfer === 'bt709' && frame.colorSpace.matrix === 'bt709' && frame.colorSpace.fullRange === false, 'invalid_renderer_format');
    report.actualFrame = { format: 'NV12', codedWidth: frame.codedWidth, codedHeight: 1080, displayWidth: frame.displayWidth,
      displayHeight: 1080, colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } };
  } else report.actualFrame = null;
  return report;
}
async function runElectron() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const directory = path.resolve(process.env.COVE_CPU_SOCKET_PROBE_DIR || '');
  demand(inside(runtime, directory) && fs.statSync(directory).isDirectory(), 'invalid_isolated_runtime_directory');
  const raw = JSON.parse(process.env.COVE_CPU_SOCKET_PROBE_CONFIG || '{}');
  const config = configuration(['--width', String(raw.width), '--seconds', String(raw.seconds), '--warmup', String(raw.warmup), '--mode',
    raw.modes?.join(',') === 'ipc,ws' ? 'both' : raw.modes?.join(',') === 'ws,ipc' ? 'ws-first' : raw.modes?.[0],
    '--pacer', raw.pacer, '--ws-framing', raw.wsFraming, '--window', raw.window, '--chunk-bytes', String(raw.chunkBytes)]);
  const profile = path.join(directory, 'profile'); fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile); app.setPath('sessionData', profile); app.on('window-all-closed', () => {});
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  process.on('message', message => { if (message?.type === 'stop') cancel(); }); process.once('disconnect', cancel);
  const result = { passed: false, probe: 'cpu-frame-ipc-vs-loopback-websocket', startedAt: new Date().toISOString(),
    scope: 'Synthetic NV12 from three pooled main ArrayBuffers to actual sandboxed CPU VideoFrame(transfer). No desktop capture, WebRTC, encoder, decoder, screen scanout or product changes.',
    product120FpsClaim: false, desktopCaptured: false, pixelsPersisted: false, handlesPersisted: false, secretsPersisted: false,
    configuration: config, versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
      ws: require('ws/package.json').version },
    hashes: Object.fromEntries(['run.cjs', 'protocol.cjs', 'transport.cjs', 'preload.cjs', 'pacer.cjs',
      ...(config.pacer === 'native' ? ['pacer.cpp'] : [])].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, file))).digest('hex')])),
    nativePacerSha256: config.pacer === 'native' ? crypto.createHash('sha256').update(fs.readFileSync(pacerBinary)).digest('hex') : null, runs: [] };
  const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  try {
    demand(process.platform === 'win32' && process.arch === 'x64' && process.versions.electron === '44.0.0' &&
      process.versions.chrome?.startsWith('152.'), 'electron44_chromium152_windows_x64_required');
    await app.whenReady();
    for (const mode of config.modes) {
      const run = await runMode(app, BrowserWindow, ipcMain, config, mode, () => { if (cancelled) throw new Error('probe_cancelled'); });
      result.runs.push(run); save();
      if (!run.passed) throw new Error(run.errorCode || 'transport_run_failed');
    }
    result.passed = !cancelled && result.runs.length === config.modes.length && result.runs.every(run => run.passed);
  } catch (error) { result.errorCode = codeOf(error); }
  finally {
    result.finishedAt = new Date().toISOString();
    // The temporary Chromium profile may contain opaque implementation caches.
    // Delete only the exact verified, newly-created profile owned by this run.
    // app.exit releases the profile; the launcher removes it after child exit.
    save(); app.exit(result.passed ? 0 : 2);
  }
}
if (process.versions.electron || require.main === module) (process.versions.electron ? runElectron() : launch()).catch(() => {
  console.error('cpu_frame_probe_launcher_failed');
  if (process.versions.electron) require('electron').app.exit(2);
  else process.exitCode = 2;
});
module.exports = { inside, bounded, cpuDifference, sanitizeRenderer };
