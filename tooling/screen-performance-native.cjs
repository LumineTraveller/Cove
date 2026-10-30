'use strict';
const fs = require('node:fs');
const path = require('node:path');

function nativePerformanceEnabled(env = process.env) {
  if (env.COVE_FPS_NATIVE_GPU && !['0', '1'].includes(env.COVE_FPS_NATIVE_GPU))
    throw Error('Invalid isolated native GPU capture option');
  return env.COVE_FPS_NATIVE_GPU === '1' && env.COVE_DISABLE_NATIVE_GPU_CAPTURE !== '1';
}

function nativePerformancePixelFormat(env = process.env) {
  const format = env.COVE_FPS_NATIVE_PIXEL_FORMAT ?? 'bgra';
  if (!['bgra', 'nv12'].includes(format)) throw Error('Invalid isolated native GPU pixel format');
  return format;
}

function nativePerformanceStorage(env = process.env, pixelFormat = nativePerformancePixelFormat(env)) {
  const storage = env.COVE_FPS_NATIVE_STORAGE ?? 'gpu';
  if (!['gpu', 'cpu'].includes(storage)) throw Error('Invalid isolated native GPU frame storage');
  if (storage === 'cpu' && pixelFormat !== 'nv12') throw Error('CPU frame storage requires NV12 pixel format');
  return storage;
}

function nativePerformanceCompletion(env = process.env, nativeEnabled = nativePerformanceEnabled(env)) {
  const completion = env.COVE_FPS_NATIVE_COMPLETION;
  if (completion !== undefined && !['query', 'fence'].includes(completion)) throw Error('Invalid native GPU completion option');
  if (completion === 'fence' && !nativeEnabled) throw Error('Fence completion requires native GPU performance measurement');
  return completion;
}

function nativeHelperCompletionEvidence(records, expectedCompletion, sessionIndex) {
  const observed = new Set(records.filter(record => Number.isSafeInteger(sessionIndex) && sessionIndex > 0 &&
    record.sessionIndex === sessionIndex && ['query', 'fence'].includes(record.selectedCompletion)).map(record => record.selectedCompletion));
  const actual = observed.size === 1 ? [...observed][0] : null;
  const validRequest = expectedCompletion === undefined || ['query', 'fence'].includes(expectedCompletion);
  return { expectedCompletion: expectedCompletion ?? null, selectedCompletion: actual,
    matched: validRequest && observed.size < 2 && (expectedCompletion === 'fence' ? actual === 'fence'
      : expectedCompletion === 'query' ? actual === null || actual === 'query'
        : actual === null || actual === 'query' || actual === 'fence') };
}

const HELPER_SNAPSHOT_FIELDS = ['elapsedUs', 'newFrames', 'refreshFrames', 'ticks', 'missedTicks', 'noSlot', 'noPresent', 'periodUs'];
const HELPER_SNAPSHOT_COUNTERS = ['newFrames', 'refreshFrames', 'ticks', 'missedTicks', 'noSlot', 'noPresent'];
const HELPER_SNAPSHOT_OPTIONAL = ['acquireSuccess', 'acquireTimeout'];
const HELPER_SNAPSHOT_MODES = ['gpu', 'final-ack', 'copy-complete'];
const safeNonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;

function nativeHelperTimingSnapshot(records, helperIndex, mode, maximumRecords = 120) {
  if (!Number.isInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 360 ||
      !Array.isArray(records) || records.length > maximumRecords || !Number.isSafeInteger(helperIndex) || helperIndex <= 0 ||
      !HELPER_SNAPSHOT_MODES.includes(mode)) return null;
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (record?.sessionIndex !== helperIndex || record.schemaVersion !== 1 ||
        !HELPER_SNAPSHOT_FIELDS.every(key => safeNonnegativeInteger(record[key])) || record.periodUs <= 0) continue;
    const snapshot = { helperIndex, mode };
    for (const key of HELPER_SNAPSHOT_FIELDS) snapshot[key] = record[key];
    for (const key of HELPER_SNAPSHOT_OPTIONAL) if (safeNonnegativeInteger(record[key])) snapshot[key] = record[key];
    snapshot.selectedCompletion = ['query', 'fence'].includes(record.selectedCompletion) ? record.selectedCompletion : null;
    snapshot.selectedAcquireMode = ['timeout', 'poll'].includes(record.selectedAcquireMode) ? record.selectedAcquireMode : null;
    return snapshot;
  }
  return null;
}

function nativeHelperTimingSummary(snapshots, maximumSamples = 31) {
  if (!Number.isInteger(maximumSamples) || maximumSamples < 2 || maximumSamples > 360 ||
      !Array.isArray(snapshots) || snapshots.length < 2 || snapshots.length > maximumSamples) return null;
  const sameFields = ['helperIndex', 'mode', 'periodUs', 'selectedCompletion', 'selectedAcquireMode'];
  const first = snapshots[0], lastSeenOptional = {};
  for (let index = 0; index < snapshots.length; index++) {
    const snapshot = snapshots[index], previous = snapshots[index - 1];
    if (!snapshot || !Number.isSafeInteger(snapshot.helperIndex) || snapshot.helperIndex <= 0 ||
        !HELPER_SNAPSHOT_MODES.includes(snapshot.mode) || !HELPER_SNAPSHOT_FIELDS.every(key => safeNonnegativeInteger(snapshot[key])) ||
        snapshot.periodUs <= 0 || ![null, 'query', 'fence'].includes(snapshot.selectedCompletion) ||
        ![null, 'timeout', 'poll'].includes(snapshot.selectedAcquireMode) ||
        !sameFields.every(key => snapshot[key] === first[key]) ||
        previous && ['elapsedUs', ...HELPER_SNAPSHOT_COUNTERS].some(key => snapshot[key] < previous[key])) return null;
    for (const key of HELPER_SNAPSHOT_OPTIONAL) if (Object.hasOwn(snapshot, key)) {
      if (!safeNonnegativeInteger(snapshot[key]) || lastSeenOptional[key] !== undefined && snapshot[key] < lastSeenOptional[key]) return null;
      lastSeenOptional[key] = snapshot[key];
    }
  }
  const last = snapshots.at(-1), elapsedUs = last.elapsedUs - first.elapsedUs;
  if (elapsedUs <= 0) return null;
  const deltas = Object.fromEntries(HELPER_SNAPSHOT_COUNTERS.map(key => [key, last[key] - first[key]]));
  for (const key of HELPER_SNAPSHOT_OPTIONAL)
    if (snapshots.every(snapshot => Object.hasOwn(snapshot, key))) deltas[key] = last[key] - first[key];
  // The denominator belongs to the same helper as the counters. Neither browser
  // polling time, broker frame acknowledgments nor renderer clocks enter it.
  return { helperIndex: first.helperIndex, mode: first.mode,
    startElapsedUs: first.elapsedUs, endElapsedUs: last.elapsedUs, seconds: elapsedUs / 1e6,
    uniqueCaptureFps: deltas.newFrames * 1e6 / elapsedUs, refreshFps: deltas.refreshFrames * 1e6 / elapsedUs, deltas };
}

function nativeStopRequestEvidence(fault, broker, at = Date.now()) {
  const counter = key => Number.isSafeInteger(broker?.[key]) && broker[key] >= 0 ? broker[key] : null;
  return { at, fault: ['renderer_failed', 'receiver_failed'].includes(fault) ? fault : 'normal',
    broker: { frames: counter('frames'), activeSessions: counter('activeSessions') } };
}

function performanceDisplaySleepPrevention(env = process.env, cases = null, minimizedSender = false) {
  const flag = env.COVE_FPS_PREVENT_DISPLAY_SLEEP;
  if (flag !== undefined && !['0', '1'].includes(flag)) throw Error('Invalid display sleep prevention option');
  const enabled = flag === '1';
  if (enabled && (minimizedSender || cases && cases.some(config => config.source !== 'native')))
    throw Error('Display sleep prevention is limited to foreground native source measurements');
  return enabled;
}

function stockFallbackPlaybackEvidence(first, last) {
  const a = first?.currentVideo, b = last?.currentVideo;
  const decodedFramesDelta = a && b && a.trackToken === b.trackToken && a.reportId === b.reportId &&
    Number.isSafeInteger(a.framesDecoded) && Number.isSafeInteger(b.framesDecoded) && b.framesDecoded >= a.framesDecoded
    ? b.framesDecoded - a.framesDecoded : null;
  const x = first?.ownedPattern?.capturedSequence, y = last?.ownedPattern?.capturedSequence;
  const sequenceDelta = Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < 65536 && y >= 0 && y < 65536
    ? (y - x + 65536) % 65536 : null;
  const sequenceAdvanced = sequenceDelta !== null && sequenceDelta > 0 && sequenceDelta < 32768;
  const markersMatched = [first, last].every(sample => sample?.ownedPattern?.markersMatched?.length === 4 &&
    sample.ownedPattern.markersMatched.every(value => value === true));
  return { decodedFramesDelta, sequenceAdvanced, markersMatched,
    playbackContinues: decodedFramesDelta !== null && decodedFramesDelta > 1 && sequenceAdvanced && markersMatched };
}

function nativePerformancePaths(root, env = process.env) {
  const variant = env.COVE_FPS_NATIVE_VARIANT;
  if (variant !== undefined && !/^[0-9a-z-]{1,60}$/.test(variant))
    throw Error('Invalid isolated native GPU capture variant');
  // An explicitly selected experiment is immutable measurement input. Never
  // fall through to a newer build when its helper or bridge is unavailable.
  const helpers = variant !== undefined ? [`runtime/native-throughput-${variant}/helper.exe`]
    : ['apps/desktop/build/native-screen-capture-helper.exe', 'runtime/native-screen-capture/helper.exe'];
  const helper = helpers.find(file => fs.existsSync(path.join(root, file)));
  if (!helper) throw Error('Build the opt-in native screen helper before native performance measurement');
  const handleBridge = path.posix.join(path.posix.dirname(helper), 'native-screen-handles.node');
  if (!fs.existsSync(path.join(root, handleBridge)))
    throw Error('Build native-screen-handles.node beside the selected native screen helper before native performance measurement');
  const preload = 'apps/desktop/dist-electron/preload.js', broker = 'apps/desktop/dist-electron/native-screen-capture.js';
  for (const file of [preload, broker]) if (!fs.existsSync(path.join(root, file)))
    throw Error('Compile the product Electron preload/broker before native performance measurement');
  return { helper, handleBridge, preload, broker };
}

function nativeUpgradeRequired(config, enabled) {
  return enabled && config.source === 'native' && config.captureTarget === 'screen' && !config.nativeResolution && config.fps !== 30;
}

function nativePerformanceTracePhase(env = process.env, nativeEnabled = nativePerformanceEnabled(env), cases = null) {
  const phase = env.COVE_FPS_TRACE_PHASE ?? 'startup';
  if (!['startup', 'native-steady'].includes(phase)) throw Error('Invalid capture trace phase');
  if (phase === 'native-steady' && (!nativeEnabled || cases &&
      (cases.length !== 1 || !nativeUpgradeRequired(cases[0], nativeEnabled))))
    throw Error('Native-steady capture profiling requires one native GPU upgrade case');
  return phase;
}

function nativeProviderDiagnosticsDelta(first, last) {
  const delta = key => {
    const a = first?.[key], b = last?.[key];
    return Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= a ? b - a : null;
  };
  const maximum = key => delta(key) === null ? null : last[key];
  const written = delta('framesWritten'), queueAge = delta('totalQueueAgeMs');
  return {
    framesDroppedExpired: delta('framesDroppedExpired'), totalQueueAgeMs: queueAge,
    meanQueueAgeMs: written > 0 && queueAge !== null ? queueAge / written : null,
    maxQueueAgeMs: maximum('maxQueueAgeMs'), maxQueueAgeMsIncrease: delta('maxQueueAgeMs'),
    totalWriteIdleMs: delta('totalWriteIdleMs'), maxWriteIdleMs: maximum('maxWriteIdleMs'),
    maxWriteIdleMsIncrease: delta('maxWriteIdleMs'), writesOverFramePeriod: delta('writesOverFramePeriod'),
    maximaMeaning: 'Max fields are lifetime maxima at the last sample; Increase fields are differences of cumulative maxima, not maxima within the sample window.',
  };
}

const HELPER_TIMING_PREFIX = 'COVE_NATIVE_CAPTURE_TIMING ';
const HELPER_STARTUP_PREFIX = 'COVE_NATIVE_CAPTURE_STARTUP ';
const HELPER_STARTUP_PHASES = ['setup', 'sourceLookup', 'device', 'pipeline', 'slots', 'query',
  'validateOutput', 'duplicateOutput', 'readyOutput'];
const HELPER_STARTUP_STAGES = HELPER_STARTUP_PHASES.map(phase => phase + 'Us');
const HELPER_TIMING_COUNTS = ['ticks', 'missedTicks', 'acquireSuccess', 'acquireTimeout', 'noPresent', 'noSlot',
  'sourcePresents', 'pointerOnly', 'accumulatedFrames', 'maxAccumulatedFrames', 'newFrames', 'refreshFrames',
  'openSlotCreditWaitUs', 'periodUs', 'elapsedUs', 'readinessRetries', 'readinessExpired', 'readinessCancelled',
  'readinessSlotWaitWindows', 'readinessPresentWaitWindows', 'readinessRecoveredSlot', 'readinessRecoveredPresent',
  'cpuMapAttempts', 'cpuMapStillDrawing', 'cpuMapCancelled', 'cpuMapTimeouts'];
const HELPER_TIMING_STAGES = ['acquire', 'draw', 'gpuWait', 'gpuFlush', 'gpuQuery', 'frameRelease', 'output',
  'tickWork', 'tickLateness', 'timerWait', 'timerOvershoot', 'slotCreditWait', 'cpuReadback',
  'gpuFenceCheck', 'gpuEventArm', 'gpuEventWait', 'cpuMapWait', 'acquireSuccessWait', 'acquireTimeoutWait'];
const HELPER_DELIVERY_FIELDS = ['elapsedUs', 'gapUs', 'tickLatenessUs', 'acquireUs', 'acquireTimeoutUs',
  'gpuWaitUs', 'drawUs', 'noPresent', 'noSlot', 'missedTicks', 'sourcePresents'];
function safeNativeHelperDelivery(value) {
  const record = item => Boolean(item && typeof item === 'object' && !Array.isArray(item));
  if (!record(value) || !['count', 'totalGapUs', 'maxGapUs', 'tailCandidates', 'tailRetained']
    .every(key => safeNonnegativeInteger(value[key])) ||
      !Array.isArray(value.buckets) || value.buckets.length !== 7 ||
      !Array.from(value.buckets).every(safeNonnegativeInteger) ||
      !Array.isArray(value.tail) || value.tail.length > 8 || value.tailRetained !== value.tail.length ||
      value.tailCandidates < value.tailRetained) return null;
  const tail = [];
  for (const event of value.tail) {
    if (!record(event) || !HELPER_DELIVERY_FIELDS.every(key => safeNonnegativeInteger(event[key])) ||
        event.gapUs === 0 || typeof event.refresh !== 'boolean') return null;
    tail.push({ ...Object.fromEntries(HELPER_DELIVERY_FIELDS.map(key => [key, event[key]])), refresh: event.refresh });
  }
  return { count: value.count, totalGapUs: value.totalGapUs, maxGapUs: value.maxGapUs,
    buckets: [...value.buckets], tailCandidates: value.tailCandidates, tailRetained: value.tailRetained, tail };
}
function safeNativeHelperTiming(value) {
  if (!value || value.schemaVersion !== 1) return null;
  const safe = { schemaVersion: 1, final: value.final === true, stages: {} };
  if (['query', 'fence'].includes(value.selectedCompletion)) safe.selectedCompletion = value.selectedCompletion;
  if (['timeout', 'poll'].includes(value.selectedAcquireMode)) safe.selectedAcquireMode = value.selectedAcquireMode;
  let counters = 0;
  for (const key of HELPER_TIMING_COUNTS) {
    const item = value[key];
    if (Number.isSafeInteger(item) && item >= 0) { safe[key] = item; counters++; }
  }
  for (const stage of HELPER_TIMING_STAGES) {
    const item = value.stages?.[stage], copied = {};
    for (const key of ['count', 'totalUs', 'maxUs']) {
      const number = item?.[key];
      if (Number.isSafeInteger(number) && number >= 0) copied[key] = number;
    }
    if (Object.keys(copied).length === 3) safe.stages[stage] = copied;
  }
  // Optional helper-clock residency histograms. Their seven buckets use strict
  // <1T/<2T/<3T/<4T/<6T/<12T/remainder boundaries, with T = periodUs.
  for (const key of ['leaseResidence', 'importedResidence']) {
    const item = value[key];
    if (!item || !['count', 'totalUs', 'maxUs'].every(field => Number.isSafeInteger(item[field]) && item[field] >= 0) ||
        !Array.isArray(item.buckets) || item.buckets.length !== 7) continue;
    const buckets = Array.from(item.buckets);
    if (!buckets.every(bucket => Number.isSafeInteger(bucket) && bucket >= 0)) continue;
    safe[key] = { count: item.count, totalUs: item.totalUs, maxUs: item.maxUs, buckets };
  }
  // Match the product timing parser's numeric allowlist and bounded examples.
  // These helper-clock gaps are actual delivery intervals, not generated ticks.
  const delivery = safeNativeHelperDelivery(value.delivery);
  if (delivery) safe.delivery = delivery;
  return counters && Object.keys(safe.stages).length ? safe : null;
}

function safeNativeHelperStartup(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.complete !== 'boolean' ||
      !HELPER_STARTUP_PHASES.includes(value.phase) || !Number.isSafeInteger(value.elapsedUs) || value.elapsedUs < 0) return null;
  const safe = { schemaVersion: 1, complete: value.complete, phase: value.phase, elapsedUs: value.elapsedUs, stages: {} };
  if (['query', 'fence'].includes(value.selectedCompletion)) safe.selectedCompletion = value.selectedCompletion;
  if (['timeout', 'poll'].includes(value.selectedAcquireMode)) safe.selectedAcquireMode = value.selectedAcquireMode;
  for (const key of HELPER_STARTUP_STAGES) {
    const duration = value.stages?.[key];
    if (!Number.isSafeInteger(duration) || duration < 0) return null;
    safe.stages[key] = duration;
  }
  return safe;
}

// A test-only stderr consumer. Unknown lines/fields never leave the parser;
// oversized lines are discarded through their newline, including their tail.
function createNativeJsonLineCollector(prefix, sanitize, onSample, maximumSamples) {
  let pending = '', discarding = false, samples = 0, rejectedLines = 0, limited = false;
  const maximumLineBytes = 16384, maximumChunkBytes = 65536;
  return {
    write(chunk) {
      if (samples >= maximumSamples) { limited = true; return; }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.byteLength > maximumChunkBytes) { pending = ''; discarding = true; rejectedLines++; return; }
      const text = bytes.toString('utf8');
      let offset = 0;
      while (offset < text.length && samples < maximumSamples) {
        const newline = text.indexOf('\n', offset), end = newline < 0 ? text.length : newline;
        if (!discarding) {
          const length = end - offset;
          if (pending.length + length > maximumLineBytes) { pending = ''; discarding = true; rejectedLines++; }
          else pending += text.slice(offset, end);
        }
        if (newline < 0) break;
        if (!discarding && pending.startsWith(prefix)) {
          try {
            const safe = sanitize(JSON.parse(pending.slice(prefix.length)));
            if (safe) { samples++; onSample(safe); } else rejectedLines++;
          } catch { rejectedLines++; }
        }
        pending = ''; discarding = false; offset = newline + 1;
      }
      if (samples >= maximumSamples) { pending = ''; limited = true; }
    },
    snapshot() { return { samples, rejectedLines, limited, pendingBytes: pending.length }; },
  };
}

function createNativeTimingCollector(onSample, maximumSamples = 120) {
  return createNativeJsonLineCollector(HELPER_TIMING_PREFIX, safeNativeHelperTiming, onSample, maximumSamples);
}

function createNativeStartupCollector(onSample, maximumSamples = 120) {
  return createNativeJsonLineCollector(HELPER_STARTUP_PREFIX, safeNativeHelperStartup, onSample, maximumSamples);
}

// The broker already exposes safe diagnostics. Keep an explicit allowlist here
// so result.json can never acquire future handles, source IDs or process IDs.
function nativeBrokerSnapshot(controller) {
  if (!controller) return null;
  const snapshot = controller.snapshot(), safe = {};
  for (const key of ['sessions', 'activeSessions', 'helpers', 'imports', 'pendingReferences', 'childHandles', 'busySlots', 'started', 'stopped', 'frames', 'refreshFrames', 'transferredFrames', 'releasedFrames', 'cpuFramesInFlight', 'cpuFrameBuffers', 'sourceCopied', 'sourceDiscarded', 'sourceReleased', 'mainSent', 'finalAck', 'pendingSuperseded', 'pendingExpired', 'activeNativeLeases', 'mainBuffersInUse', 'pendingFrames']) {
    const value = snapshot[key];
    if (Number.isSafeInteger(value) && value >= 0) safe[key] = value;
  }
  if (typeof snapshot.disabled === 'boolean') safe.disabled = snapshot.disabled;
  if (typeof snapshot.keepRendererActive === 'boolean') safe.keepRendererActive = snapshot.keepRendererActive;
  if (Number.isSafeInteger(snapshot.rendererActivityLeases) && snapshot.rendererActivityLeases >= 0)
    safe.rendererActivityLeases = snapshot.rendererActivityLeases;
  safe.pixelFormat = ['bgra', 'nv12'].includes(snapshot.pixelFormat) ? snapshot.pixelFormat : null;
  safe.frameStorage = ['gpu', 'cpu'].includes(snapshot.frameStorage) ? snapshot.frameStorage : null;
  if (['immediate', 'yield'].includes(snapshot.cpuDeliveryScheduling))
    safe.cpuDeliveryScheduling = snapshot.cpuDeliveryScheduling;
  if (['final-ack', 'copy-complete'].includes(snapshot.cpuOwnership))
    safe.cpuOwnership = snapshot.cpuOwnership;
  safe.failureCode = typeof snapshot.failureCode === 'string' && /^[a-z_]{1,50}$/.test(snapshot.failureCode)
    ? snapshot.failureCode : null;
  safe.lastEndReason = typeof snapshot.lastEndReason === 'string' && /^[a-z_]{1,50}$/.test(snapshot.lastEndReason)
    ? snapshot.lastEndReason : null;
  safe.helperCpuSeconds = Number.isFinite(snapshot.helperCpuSeconds) && snapshot.helperCpuSeconds >= 0
    ? snapshot.helperCpuSeconds : null;
  safe.timing = null;
  if (snapshot.timing && typeof snapshot.timing === 'object') {
    const timing = {};
    for (const key of ['import', 'transfer', 'reference']) {
      const value = snapshot.timing[key];
      if (Number.isSafeInteger(value?.count) && value.count >= 0 &&
          Number.isFinite(value.totalMs) && value.totalMs >= 0 && Number.isFinite(value.maxMs) && value.maxMs >= 0 &&
          Array.isArray(value.buckets) && value.buckets.length === 7 &&
          value.buckets.every(bucket => Number.isSafeInteger(bucket) && bucket >= 0))
        timing[key] = { count: value.count, totalMs: value.totalMs, maxMs: value.maxMs, buckets: [...value.buckets] };
    }
    if (Object.keys(timing).length) safe.timing = timing;
  }
  return safe;
}

function captureCpuSummary(samples, nativeEnabled) {
  const first = samples[0], last = samples.at(-1);
  const seconds = (last.at - first.at) / 1000;
  const signature = sample => sample.cpu?.map(item => `${item.pid}:${item.type}`).sort().join('|');
  const total = sample => sample.cpu?.every(item => Number.isFinite(item.cpu?.cumulativeCPUUsage))
    ? sample.cpu.reduce((sum, item) => sum + item.cpu.cumulativeCPUUsage, 0) : null;
  const a = total(first), b = total(last);
  const appSeconds = a != null && b != null && b >= a && signature(first) === signature(last) ? b - a : null;
  const helperA = first.nativeGpu?.helperCpuSeconds, helperB = last.nativeGpu?.helperCpuSeconds;
  const noHelper = first.nativeGpu?.activeSessions === 0 && last.nativeGpu?.activeSessions === 0 &&
    first.nativeGpu.started === last.nativeGpu.started;
  const helperSeconds = !nativeEnabled || noHelper ? 0 : Number.isFinite(helperA) && Number.isFinite(helperB) && helperB >= helperA &&
    first.nativeGpu.started === last.nativeGpu.started && first.nativeGpu.activeSessions === 1 && last.nativeGpu.activeSessions === 1
    ? helperB - helperA : null;
  return { appSeconds, helperSeconds,
    combinedCorePercent: seconds > 0 && appSeconds != null && helperSeconds != null ? 100 * (appSeconds + helperSeconds) / seconds : null,
    meaning: 'CPU time of the complete Electron test app (source, sender, viewer, browser/GPU processes) plus the owned capture helper; 100% is one CPU core. Local Node SFU and GPU execution time are excluded in both paths.' };
}

function nativeResourcesReleased(snapshot) {
  return Boolean(snapshot && ['sessions', 'activeSessions', 'helpers', 'imports', 'pendingReferences', 'childHandles', 'busySlots'].every(key => snapshot[key] === 0) &&
    (!Object.hasOwn(snapshot, 'rendererActivityLeases') || snapshot.rendererActivityLeases === 0) &&
    (!Object.hasOwn(snapshot, 'cpuFramesInFlight') || snapshot.cpuFramesInFlight === 0) &&
    (snapshot.cpuOwnership !== 'copy-complete' ||
      ['activeNativeLeases', 'mainBuffersInUse', 'pendingFrames', 'cpuFrameBuffers'].every(key => snapshot[key] === 0)));
}

function nativeUpgradeEvidence(sample, broker, expectedFormat, expectedStorage) {
  const source = sample?.sources?.find(item => item.isLiveSenderSource === true);
  const nativeSource = source?.kind === 'native-gpu-adapter' && source.trackState === 'live';
  const stockTrackEnded = sample?.sources?.some(item => item.kind === 'native-display-capture' && item.trackState === 'ended') === true;
  const localScreenTrackMatchesSender = sample?.nativeGpu?.localScreenTrackMatchesSender === true;
  const bridgeSupported = sample?.nativeGpu?.bridgeSupported === true;
  const brokerActive = broker?.activeSessions === 1 && broker?.helpers === 1 && broker.frames > 0 && broker.disabled === false;
  const pixelFormatMatched = expectedFormat === undefined ||
    ['bgra', 'nv12'].includes(expectedFormat) && broker?.pixelFormat === expectedFormat;
  const frameStorageMatched = expectedStorage === undefined ||
    ['gpu', 'cpu'].includes(expectedStorage) && broker?.frameStorage === expectedStorage;
  return { nativeSource, stockTrackEnded, localScreenTrackMatchesSender, bridgeSupported, brokerActive, pixelFormatMatched, frameStorageMatched,
    passed: nativeSource && stockTrackEnded && localScreenTrackMatchesSender && bridgeSupported && brokerActive && pixelFormatMatched && frameStorageMatched };
}

module.exports = { nativePerformanceEnabled, nativePerformancePaths, nativeUpgradeRequired, nativeBrokerSnapshot,
  nativeResourcesReleased, nativeUpgradeEvidence, captureCpuSummary, safeNativeHelperTiming, createNativeTimingCollector,
  nativePerformanceTracePhase, nativeProviderDiagnosticsDelta, nativePerformancePixelFormat, nativePerformanceStorage,
  safeNativeHelperStartup, createNativeStartupCollector, nativePerformanceCompletion, nativeHelperCompletionEvidence,
  nativeStopRequestEvidence, performanceDisplaySleepPrevention, stockFallbackPlaybackEvidence,
  nativeHelperTimingSnapshot, nativeHelperTimingSummary };
