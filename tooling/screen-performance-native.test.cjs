'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { nativePerformanceEnabled, nativePerformancePaths, nativeUpgradeRequired, nativeBrokerSnapshot, nativeResourcesReleased, nativeUpgradeEvidence, captureCpuSummary, safeNativeHelperTiming, createNativeTimingCollector, nativePerformanceTracePhase, nativeProviderDiagnosticsDelta, nativePerformancePixelFormat, nativePerformanceStorage, safeNativeHelperStartup, createNativeStartupCollector, nativePerformanceCompletion, nativeHelperCompletionEvidence, nativeStopRequestEvidence, performanceDisplaySleepPrevention, stockFallbackPlaybackEvidence } = require('./screen-performance-native.cjs');

test('native measurement requires its own opt-in and respects the disable override', () => {
  assert.equal(nativePerformanceEnabled({}), false);
  assert.equal(nativePerformanceEnabled({ COVE_NATIVE_GPU_CAPTURE: '1' }), false);
  assert.equal(nativePerformanceEnabled({ COVE_FPS_NATIVE_GPU: '1' }), true);
  assert.equal(nativePerformanceEnabled({ COVE_FPS_NATIVE_GPU: '1', COVE_DISABLE_NATIVE_GPU_CAPTURE: '1' }), false);
  assert.throws(() => nativePerformanceEnabled({ COVE_FPS_NATIVE_GPU: 'true' }));
});

test('native pixel format is explicit, defaults to BGRA and rejects unrecognized values', () => {
  assert.equal(nativePerformancePixelFormat({}), 'bgra');
  assert.equal(nativePerformancePixelFormat({ COVE_FPS_NATIVE_PIXEL_FORMAT: 'bgra' }), 'bgra');
  assert.equal(nativePerformancePixelFormat({ COVE_FPS_NATIVE_PIXEL_FORMAT: 'nv12' }), 'nv12');
  for (const format of ['', 'NV12', 'rgba', 'nv12,bgra', '../nv12'])
    assert.throws(() => nativePerformancePixelFormat({ COVE_FPS_NATIVE_PIXEL_FORMAT: format }), /pixel format/);
  for (const format of ['bgra', 'nv12'])
    assert.equal(nativeBrokerSnapshot({ snapshot: () => ({ pixelFormat: format }) }).pixelFormat, format);
  for (const format of [undefined, null, 'RGBA', 'private-format'])
    assert.equal(nativeBrokerSnapshot({ snapshot: () => ({ pixelFormat: format }) }).pixelFormat, null);
});

test('native storage defaults to GPU and accepts CPU only with NV12', () => {
  assert.equal(nativePerformanceStorage({}), 'gpu');
  assert.equal(nativePerformanceStorage({ COVE_FPS_NATIVE_STORAGE: 'gpu', COVE_FPS_NATIVE_PIXEL_FORMAT: 'nv12' }), 'gpu');
  assert.equal(nativePerformanceStorage({ COVE_FPS_NATIVE_STORAGE: 'cpu', COVE_FPS_NATIVE_PIXEL_FORMAT: 'nv12' }), 'cpu');
  assert.throws(() => nativePerformanceStorage({ COVE_FPS_NATIVE_STORAGE: 'cpu' }), /requires NV12/);
  assert.throws(() => nativePerformanceStorage({ COVE_FPS_NATIVE_STORAGE: 'cpu' }, 'bgra'), /requires NV12/);
  for (const storage of ['', 'CPU', 'shared', 'cpu,gpu', '../cpu'])
    assert.throws(() => nativePerformanceStorage({ COVE_FPS_NATIVE_STORAGE: storage }, 'nv12'), /frame storage/);
});

test('only eligible monitor preset cases require an actual native upgrade', () => {
  const config = { source: 'native', captureTarget: 'screen' };
  assert.equal(nativeUpgradeRequired(config, true), true);
  for (const variation of [{ source: 'generated' }, { captureTarget: 'window' }, { nativeResolution: true }, { fps: 30 }])
    assert.equal(nativeUpgradeRequired({ ...config, ...variation }, true), false);
  assert.equal(nativeUpgradeRequired({ ...config, fps: 60 }, true), true);
  assert.equal(nativeUpgradeRequired(config, false), false);
});

test('native measurement rejects missing artifacts and records the exact helper selected', () => {
  const tempParent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempParent, 'cove-native-performance-test-'));
  try {
    assert.throws(() => nativePerformancePaths(root), /helper/);
    const write = file => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), 'test-only artifact'); };
    write('runtime/native-screen-capture/helper.exe');
    assert.throws(() => nativePerformancePaths(root), /native-screen-handles\.node/);
    write('runtime/native-screen-capture/native-screen-handles.node');
    assert.throws(() => nativePerformancePaths(root), /preload\/broker/);
    write('apps/desktop/dist-electron/preload.js');write('apps/desktop/dist-electron/native-screen-capture.js');
    assert.equal(nativePerformancePaths(root).helper, 'runtime/native-screen-capture/helper.exe');
    assert.equal(nativePerformancePaths(root).handleBridge, 'runtime/native-screen-capture/native-screen-handles.node');
    write('apps/desktop/build/native-screen-capture-helper.exe');
    write('apps/desktop/build/native-screen-handles.node');
    assert.equal(nativePerformancePaths(root).helper, 'apps/desktop/build/native-screen-capture-helper.exe');
  } finally {
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), tempParent);
    assert.equal(path.basename(target).startsWith('cove-native-performance-test-'), true);
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('explicit native variants select their owned artifacts and never fall back', () => {
  const tempParent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempParent, 'cove-native-variant-test-'));
  try {
    const write = file => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), 'test-only artifact'); };
    for (const file of ['apps/desktop/build/native-screen-capture-helper.exe', 'apps/desktop/build/native-screen-handles.node',
      'apps/desktop/dist-electron/preload.js', 'apps/desktop/dist-electron/native-screen-capture.js']) write(file);
    const env = { COVE_FPS_NATIVE_VARIANT: '20261028-baseline' };
    assert.throws(() => nativePerformancePaths(root, env), /helper/);
    write('runtime/native-throughput-20261028-baseline/helper.exe');
    assert.throws(() => nativePerformancePaths(root, env), /native-screen-handles\.node/);
    write('runtime/native-throughput-20261028-baseline/native-screen-handles.node');
    assert.deepEqual(nativePerformancePaths(root, env), {
      helper: 'runtime/native-throughput-20261028-baseline/helper.exe',
      handleBridge: 'runtime/native-throughput-20261028-baseline/native-screen-handles.node',
      preload: 'apps/desktop/dist-electron/preload.js', broker: 'apps/desktop/dist-electron/native-screen-capture.js',
    });
    assert.equal(nativePerformancePaths(root, {}).helper, 'apps/desktop/build/native-screen-capture-helper.exe');
    for (const variant of ['', '../baseline', 'BASELINE', 'a/b', 'a\\b', 'x'.repeat(61)])
      assert.throws(() => nativePerformancePaths(root, { COVE_FPS_NATIVE_VARIANT: variant }), /variant/);
  } finally {
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), tempParent);
    assert.equal(path.basename(target).startsWith('cove-native-variant-test-'), true);
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('safe broker evidence omits private fields and cleanup cannot pass missing counters', () => {
  const zero = Object.fromEntries(['sessions', 'activeSessions', 'helpers', 'imports', 'pendingReferences', 'childHandles', 'busySlots'].map(key => [key, 0]));
  const safe = nativeBrokerSnapshot({ snapshot: () => ({ ...zero, disabled: false, failureCode: 'helper_failed', pid: 123, handle: 'private', sourceId: 'private' }) });
  assert.equal(nativeResourcesReleased(safe), true);
  assert.equal(nativeResourcesReleased({ ...safe, helpers: 1 }), false);
  assert.equal(nativeResourcesReleased({ ...safe, pendingReferences: 1 }), false);
  assert.equal(nativeResourcesReleased({ ...safe, childHandles: 1 }), false);
  assert.equal(nativeResourcesReleased({ ...safe, cpuFramesInFlight: 0 }), true);
  for (const value of [1, -1, NaN, undefined, null])
    assert.equal(nativeResourcesReleased({ ...safe, cpuFramesInFlight: value }), false);
  assert.equal(nativeResourcesReleased({}), false);
  assert.equal(nativeResourcesReleased(null), false);
  assert.equal(safe.failureCode, 'helper_failed');
  assert.equal('pid' in safe || 'handle' in safe || 'sourceId' in safe, false);
});

test('stock fallback, unknown sender tracks and inactive brokers never pass native acceptance', () => {
  const sample = { sources: [
    { kind: 'native-display-capture', trackState: 'ended' },
    { kind: 'native-gpu-adapter', trackState: 'live', isLiveSenderSource: true },
  ], nativeGpu: { bridgeSupported: true, localScreenTrackMatchesSender: true } };
  const broker = { activeSessions: 1, helpers: 1, frames: 1, disabled: false };
  assert.equal(nativeUpgradeEvidence(sample, broker).passed, true);
  assert.equal(nativeUpgradeEvidence({ ...sample, sources: [{ kind: 'native-display-capture', trackState: 'live', isLiveSenderSource: true }] }, broker).passed, false);
  assert.equal(nativeUpgradeEvidence({ ...sample, nativeGpu: { bridgeSupported: true, localScreenTrackMatchesSender: false } }, broker).passed, false);
  assert.equal(nativeUpgradeEvidence(sample, { ...broker, frames: 0 }).passed, false);
  assert.equal(nativeUpgradeEvidence(sample, { ...broker, disabled: true }).passed, false);
  // Older BGRA frame writers have no new adapter diagnostic fields. Actual
  // broker format is sufficient; a fallback format or missing evidence is not.
  assert.equal(nativeUpgradeEvidence(sample, { ...broker, pixelFormat: 'bgra' }, 'bgra').passed, true);
  assert.equal(nativeUpgradeEvidence(sample, { ...broker, pixelFormat: 'nv12' }, 'nv12').passed, true);
  assert.equal(nativeUpgradeEvidence(sample, { ...broker, pixelFormat: 'bgra' }, 'nv12').passed, false);
  assert.equal(nativeUpgradeEvidence(sample, { ...broker, pixelFormat: 'nv12' }, 'bgra').passed, false);
  assert.equal(nativeUpgradeEvidence(sample, broker, 'nv12').passed, false);
  assert.equal(nativeUpgradeEvidence(sample, { ...broker, pixelFormat: null }, 'bgra').passed, false);
  assert.equal(nativeUpgradeEvidence(sample, { ...broker, pixelFormat: 'nv12' }, 'unknown').passed, false);
  const cpu = { ...broker, pixelFormat: 'nv12', frameStorage: 'cpu' };
  assert.equal(nativeUpgradeEvidence(sample, cpu, 'nv12', 'cpu').passed, true);
  assert.equal(nativeUpgradeEvidence(sample, { ...cpu, frameStorage: 'gpu' }, 'nv12', 'cpu').passed, false);
  assert.equal(nativeUpgradeEvidence(sample, cpu, 'nv12', 'gpu').passed, false);
  assert.equal(nativeUpgradeEvidence(sample, { ...broker, pixelFormat: 'nv12' }, 'nv12', 'cpu').passed, false);
  assert.equal(nativeUpgradeEvidence(sample, cpu, 'nv12', 'shared').passed, false);
  assert.equal(nativeUpgradeEvidence(sample, { ...broker, pixelFormat: 'bgra', frameStorage: 'gpu' }, 'bgra', 'gpu').passed, true);
});

test('CPU comparison includes helper and refuses unknown or replaced process counters', () => {
  const a = { at: 0, cpu: [{ pid: 1, type: 'Browser', cpu: { cumulativeCPUUsage: 2 } }],
    nativeGpu: { helperCpuSeconds: 0.1, started: 1, activeSessions: 1 } };
  const b = { at: 2000, cpu: [{ pid: 1, type: 'Browser', cpu: { cumulativeCPUUsage: 3 } }],
    nativeGpu: { helperCpuSeconds: 0.3, started: 1, activeSessions: 1 } };
  const native = captureCpuSummary([a, b], true);
  assert.equal(native.appSeconds, 1);
  assert.ok(Math.abs(native.helperSeconds - 0.2) < 1e-9);
  assert.ok(Math.abs(native.combinedCorePercent - 60) < 1e-9);
  assert.equal(captureCpuSummary([a, b], false).combinedCorePercent, 50);
  assert.equal(captureCpuSummary([a, { ...b, nativeGpu: { ...b.nativeGpu, helperCpuSeconds: null } }], true).combinedCorePercent, null);
  assert.equal(captureCpuSummary([a, { ...b, cpu: [{ ...b.cpu[0], pid: 2 }] }], true).combinedCorePercent, null);
  assert.equal(captureCpuSummary([a, { ...b, nativeGpu: { ...b.nativeGpu, started: 2 } }], true).combinedCorePercent, null);
  assert.equal(captureCpuSummary([{ ...a, nativeGpu: { activeSessions: 0, started: 0 } },
    { ...b, nativeGpu: { activeSessions: 0, started: 0 } }], true).combinedCorePercent, 50);
});

test('native timing accepts only fixed numeric counters and clones broker buckets', () => {
  const stage = { count: 2, totalUs: 45, maxUs: 31, handle: 'private' };
  const safe = safeNativeHelperTiming({ schemaVersion: 1, final: true, ticks: 2, elapsedUs: 100, periodUs: 8333,
    private: 'secret', noSlot: -1, newFrames: NaN, stages: { acquire: stage, pixelDump: stage } });
  assert.deepEqual(safe, { schemaVersion: 1, final: true, stages: { acquire: { count: 2, totalUs: 45, maxUs: 31 } }, ticks: 2, periodUs: 8333, elapsedUs: 100 });
  assert.equal(safeNativeHelperTiming({ schemaVersion: 2, ticks: 1, stages: { acquire: stage } }), null);
  const buckets = [1, 2, 3, 4, 5, 6, 7], value = { count: 28, totalMs: 123.4, maxMs: 35, buckets, private: 'secret' };
  const snapshot = nativeBrokerSnapshot({ snapshot: () => ({ timing: { import: value, transfer: { ...value, buckets: [1] }, reference: { ...value, totalMs: Infinity }, private: value } }) });
  assert.deepEqual(snapshot.timing, { import: { count: 28, totalMs: 123.4, maxMs: 35, buckets: [1, 2, 3, 4, 5, 6, 7] } });
  buckets[0] = 999;
  assert.equal(snapshot.timing.import.buckets[0], 1);
});

test('helper stderr parser bounds chunks, lines and samples without retaining unknown output', () => {
  const records = [], collector = createNativeTimingCollector(value => records.push(value), 2);
  const line = 'COVE_NATIVE_CAPTURE_TIMING ' + JSON.stringify({ schemaVersion: 1, ticks: 1, stages: { acquire: { count: 1, totalUs: 3, maxUs: 3 } }, secret: 'private' }) + '\n';
  collector.write(Buffer.from('private stderr\n' + line.slice(0, 31)));
  collector.write(Buffer.from(line.slice(31)));
  assert.equal(records.length, 1);
  collector.write(Buffer.from('x'.repeat(16385) + line));
  assert.equal(records.length, 1);
  collector.write(Buffer.alloc(65537, 120));
  collector.write(Buffer.from('\n' + line + line));
  assert.equal(records.length, 2);
  assert.equal(records.some(record => 'secret' in record), false);
  assert.deepEqual(collector.snapshot(), { samples: 2, rejectedLines: 2, limited: true, pendingBytes: 0 });
});

test('helper residency histograms retain only fixed safe integers and seven cloned buckets', () => {
  const timing = { schemaVersion: 1, ticks: 1, periodUs: 8333,
    stages: { acquire: { count: 1, totalUs: 3, maxUs: 3 } } };
  const value = { count: 28, totalUs: 1230000, maxUs: 350000, buckets: [1, 2, 3, 4, 5, 6, 7],
    serial: 'private', handle: 'private', extra: 'private' };
  const safe = safeNativeHelperTiming({ ...timing, leaseResidence: value, importedResidence: value,
    privateResidence: value });
  for (const key of ['leaseResidence', 'importedResidence']) {
    assert.deepEqual(safe[key], { count: 28, totalUs: 1230000, maxUs: 350000, buckets: [1, 2, 3, 4, 5, 6, 7] });
    assert.notEqual(safe[key].buckets, value.buckets);
  }
  assert.notEqual(safe.leaseResidence.buckets, safe.importedResidence.buckets);
  value.buckets[0] = 99;
  assert.equal(safe.leaseResidence.buckets[0], 1);
  assert.equal('privateResidence' in safe, false);
  const legacy = safeNativeHelperTiming(timing);
  assert.equal('leaseResidence' in legacy, false); assert.equal('importedResidence' in legacy, false);
  const zero = { count: 0, totalUs: 0, maxUs: 0, buckets: Array(7).fill(0) };
  assert.deepEqual(safeNativeHelperTiming({ ...timing, leaseResidence: zero }).leaseResidence, zero);
  for (const key of ['leaseResidence', 'importedResidence']) {
    const invalid = [null, {}, { ...zero, buckets: [] }, { ...zero, buckets: Array(6).fill(0) },
      { ...zero, buckets: Array(8).fill(0) }, { ...zero, buckets: Array(7) }, { ...zero, buckets: '0000000' }];
    for (const bad of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', true, null, 1n]) {
      for (const field of ['count', 'totalUs', 'maxUs']) invalid.push({ ...zero, [field]: bad });
      invalid.push({ ...zero, buckets: [bad, 0, 0, 0, 0, 0, 0] });
    }
    for (const item of invalid) assert.equal(key in safeNativeHelperTiming({ ...timing, [key]: item }), false);
  }
});

test('helper residency records obey the existing bounded timing collector capacity', () => {
  const records = [], collector = createNativeTimingCollector(value => records.push(value), 1);
  const residence = { count: 1, totalUs: 8333, maxUs: 8333, buckets: [0, 1, 0, 0, 0, 0, 0] };
  const line = 'COVE_NATIVE_CAPTURE_TIMING ' + JSON.stringify({ schemaVersion: 1, ticks: 1, periodUs: 8333,
    stages: { acquire: { count: 1, totalUs: 3, maxUs: 3 } }, leaseResidence: residence,
    importedResidence: residence, sourceId: 'private' }) + '\n';
  collector.write(Buffer.from(line + line));
  assert.equal(records.length, 1); assert.deepEqual(records[0].leaseResidence, residence);
  assert.deepEqual(records[0].importedResidence, residence); assert.equal('sourceId' in records[0], false);
  assert.deepEqual(collector.snapshot(), { samples: 1, rejectedLines: 0, limited: true, pendingBytes: 0 });
});

test('native-steady trace selection requires an eligible native upgrade case', () => {
  const config = { source: 'native', captureTarget: 'screen', fps: 120 };
  assert.equal(nativePerformanceTracePhase({}, false), 'startup');
  assert.equal(nativePerformanceTracePhase({ COVE_FPS_TRACE_PHASE: 'native-steady' }, true, [config]), 'native-steady');
  assert.throws(() => nativePerformanceTracePhase({ COVE_FPS_TRACE_PHASE: 'native-steady' }, false), /requires one native GPU/);
  for (const variation of [{ source: 'generated' }, { captureTarget: 'window' }, { nativeResolution: true }, { fps: 30 }])
    assert.throws(() => nativePerformanceTracePhase({ COVE_FPS_TRACE_PHASE: 'native-steady' }, true, [{ ...config, ...variation }]), /requires one native GPU/);
  for (const phase of ['', 'steady', 'STARTUP']) assert.throws(() => nativePerformanceTracePhase({ COVE_FPS_TRACE_PHASE: phase }, true), /Invalid/);
});

test('queue diagnostics preserve unavailable baseline fields and distinguish cumulative maxima', () => {
  const baseline = { framesWritten: 10, totalWriteMs: 50 };
  const unknown = nativeProviderDiagnosticsDelta(baseline, { ...baseline, framesWritten: 30 });
  for (const key of ['framesDroppedExpired', 'totalQueueAgeMs', 'meanQueueAgeMs', 'maxQueueAgeMs', 'maxQueueAgeMsIncrease',
    'totalWriteIdleMs', 'maxWriteIdleMs', 'maxWriteIdleMsIncrease', 'writesOverFramePeriod']) assert.equal(unknown[key], null);
  const first = { framesWritten: 10, framesDroppedExpired: 2, totalQueueAgeMs: 8, maxQueueAgeMs: 4,
    totalWriteIdleMs: 3, maxWriteIdleMs: 2, writesOverFramePeriod: 1 };
  const last = { framesWritten: 15, framesDroppedExpired: 3, totalQueueAgeMs: 18, maxQueueAgeMs: 4,
    totalWriteIdleMs: 7, maxWriteIdleMs: 3, writesOverFramePeriod: 4 };
  const actual = nativeProviderDiagnosticsDelta(first, last);
  assert.equal(actual.framesDroppedExpired, 1); assert.equal(actual.totalQueueAgeMs, 10); assert.equal(actual.meanQueueAgeMs, 2);
  assert.equal(actual.maxQueueAgeMs, 4); assert.equal(actual.maxQueueAgeMsIncrease, 0);
  assert.equal(actual.totalWriteIdleMs, 4); assert.equal(actual.maxWriteIdleMs, 3); assert.equal(actual.maxWriteIdleMsIncrease, 1);
  assert.equal(actual.writesOverFramePeriod, 3);
  assert.equal(nativeProviderDiagnosticsDelta(first, { ...last, totalQueueAgeMs: NaN }).totalQueueAgeMs, null);
  assert.equal(nativeProviderDiagnosticsDelta(first, { ...last, framesDroppedExpired: 0 }).framesDroppedExpired, null);
});

test('readiness timing fields match the helper allowlist without adding arbitrary metadata', () => {
  const fields = ['readinessRetries', 'readinessExpired', 'readinessCancelled', 'readinessSlotWaitWindows',
    'readinessPresentWaitWindows', 'readinessRecoveredSlot', 'readinessRecoveredPresent'];
  const value = { schemaVersion: 1, stages: { acquire: { count: 1, totalUs: 1, maxUs: 1 } },
    ...Object.fromEntries(fields.map((key, index) => [key, index])), readinessPrivate: 'secret' };
  const safe = safeNativeHelperTiming(value);
  for (const [index, key] of fields.entries()) assert.equal(safe[key], index);
  assert.equal('readinessPrivate' in safe, false);
});

test('CPU delivery diagnostics retain only enum storage, nonnegative in-flight counts and wall timing', () => {
  for (const frameStorage of ['gpu', 'cpu']) {
    const safe = nativeBrokerSnapshot({ snapshot: () => ({ frameStorage, cpuFramesInFlight: 2, mappedAddress: 'private' }) });
    assert.equal(safe.frameStorage, frameStorage); assert.equal(safe.cpuFramesInFlight, 2);
    assert.equal('mappedAddress' in safe, false);
  }
  for (const frameStorage of [undefined, null, 'GPU', 'shared'])
    assert.equal(nativeBrokerSnapshot({ snapshot: () => ({ frameStorage }) }).frameStorage, null);
  for (const cpuFramesInFlight of [-1, NaN, Infinity, 0.5, '0'])
    assert.equal('cpuFramesInFlight' in nativeBrokerSnapshot({ snapshot: () => ({ cpuFramesInFlight }) }), false);
  const safe = safeNativeHelperTiming({ schemaVersion: 1, ticks: 1,
    stages: { cpuReadback: { count: 1, totalUs: 2043, maxUs: 2043, pixels: 'private' } } });
  assert.deepEqual(safe.stages, { cpuReadback: { count: 1, totalUs: 2043, maxUs: 2043 } });
});

test('helper startup keeps only complete fixed-schema timing records and known phases', () => {
  const phases = ['setup', 'sourceLookup', 'device', 'pipeline', 'slots', 'query', 'validateOutput', 'duplicateOutput', 'readyOutput'];
  const stages = Object.fromEntries(phases.map((phase, index) => [phase + 'Us', index]));
  const value = { schemaVersion: 1, complete: true, phase: 'readyOutput', elapsedUs: 1234, stages, private: 'secret' };
  const safe = safeNativeHelperStartup({ ...value, stages: { ...stages, private: 'secret' } });
  assert.deepEqual(safe, { schemaVersion: 1, complete: true, phase: 'readyOutput', elapsedUs: 1234, stages });
  for (const phase of phases) assert.equal(safeNativeHelperStartup({ ...value, complete: false, phase }).phase, phase);
  for (const variation of [{ schemaVersion: 2 }, { complete: 1 }, { phase: 'private/source' }, { elapsedUs: -1 },
    { elapsedUs: NaN }, { stages: { ...stages, setupUs: undefined } }, { stages: { ...stages, readyOutputUs: Infinity } }])
    assert.equal(safeNativeHelperStartup({ ...value, ...variation }), null);
});

test('startup stderr is isolated from loop timing with the same bounded parser behavior', () => {
  const stages = Object.fromEntries(['setup', 'sourceLookup', 'device', 'pipeline', 'slots', 'query',
    'validateOutput', 'duplicateOutput', 'readyOutput'].map(phase => [phase + 'Us', 0]));
  const line = 'COVE_NATIVE_CAPTURE_STARTUP ' + JSON.stringify({ schemaVersion: 1, complete: false,
    phase: 'device', elapsedUs: 12, stages, private: 'secret' }) + '\n';
  const loopLine = 'COVE_NATIVE_CAPTURE_TIMING ' + JSON.stringify({ schemaVersion: 1, ticks: 1,
    stages: { acquire: { count: 1, totalUs: 3, maxUs: 3 } } }) + '\n';
  const startup = [], timing = [], collector = createNativeStartupCollector(value => startup.push(value), 2);
  const loop = createNativeTimingCollector(value => timing.push(value), 2);
  for (const chunk of [Buffer.from('private stderr\n' + line.slice(0, 45)), Buffer.from(line.slice(45) + loopLine)]) {
    collector.write(chunk); loop.write(chunk);
  }
  assert.equal(startup.length, 1); assert.equal(timing.length, 1); assert.equal(startup[0].complete, false);
  collector.write(Buffer.from('x'.repeat(16385) + line));
  collector.write(Buffer.alloc(65537, 120));
  collector.write(Buffer.from('\n' + line + line));
  assert.equal(startup.length, 2); assert.equal('private' in startup[0], false);
  assert.deepEqual(collector.snapshot(), { samples: 2, rejectedLines: 2, limited: true, pendingBytes: 0 });
});

test('completion selection is strict and fence acceptance requires current-helper evidence', () => {
  assert.equal(nativePerformanceCompletion({}, true), undefined);
  assert.equal(nativePerformanceCompletion({ COVE_FPS_NATIVE_COMPLETION: 'query' }, false), 'query');
  assert.equal(nativePerformanceCompletion({ COVE_FPS_NATIVE_COMPLETION: 'fence' }, true), 'fence');
  assert.throws(() => nativePerformanceCompletion({ COVE_FPS_NATIVE_COMPLETION: 'fence' }, false), /requires native GPU/);
  for (const completion of ['', 'FENCE', 'auto', '../query'])
    assert.throws(() => nativePerformanceCompletion({ COVE_FPS_NATIVE_COMPLETION: completion }, true), /Invalid/);
  assert.equal(nativeHelperCompletionEvidence([], undefined, 1).matched, true);
  assert.equal(nativeHelperCompletionEvidence([], 'fence', 1).matched, false);
  const fence = [{ sessionIndex: 1, selectedCompletion: 'fence' }];
  assert.equal(nativeHelperCompletionEvidence(fence, 'fence', 1).matched, true);
  assert.equal(nativeHelperCompletionEvidence(fence, 'fence', 2).matched, false);
  assert.equal(nativeHelperCompletionEvidence(fence, 'query', 1).matched, false);
  assert.equal(nativeHelperCompletionEvidence(fence, undefined, 1).matched, false);
  assert.equal(nativeHelperCompletionEvidence([...fence, { sessionIndex: 1, selectedCompletion: 'query' }], 'fence', 1).matched, false);
});

test('completion enums and fence wait stages are safe optional helper diagnostics', () => {
  const stages = Object.fromEntries(['setup', 'sourceLookup', 'device', 'pipeline', 'slots', 'query',
    'validateOutput', 'duplicateOutput', 'readyOutput'].map(phase => [phase + 'Us', 0]));
  for (const selectedCompletion of ['query', 'fence']) {
    assert.equal(safeNativeHelperStartup({ schemaVersion: 1, complete: true, phase: 'readyOutput', elapsedUs: 1,
      stages, selectedCompletion }).selectedCompletion, selectedCompletion);
    const safe = safeNativeHelperTiming({ schemaVersion: 1, ticks: 1, selectedCompletion,
      stages: Object.fromEntries(['gpuFenceCheck', 'gpuEventArm', 'gpuEventWait'].map(stage => [stage, { count: 1, totalUs: 5, maxUs: 5 }])) });
    assert.equal(safe.selectedCompletion, selectedCompletion);
    assert.deepEqual(Object.keys(safe.stages), ['gpuFenceCheck', 'gpuEventArm', 'gpuEventWait']);
  }
  const safe = safeNativeHelperTiming({ schemaVersion: 1, ticks: 1, selectedCompletion: 'private',
    stages: { gpuQuery: { count: 1, totalUs: 1, maxUs: 1 } } });
  assert.equal('selectedCompletion' in safe, false);
});

test('stop request evidence excludes IDs, stacks and unknown fault text', () => {
  const broker = { frames: 0, activeSessions: 1, requestId: 'private', stack: 'private', handle: 'private' };
  assert.deepEqual(nativeStopRequestEvidence(undefined, broker, 100), { at: 100, fault: 'normal', broker: { frames: 0, activeSessions: 1 } });
  for (const fault of ['renderer_failed', 'receiver_failed'])
    assert.equal(nativeStopRequestEvidence(fault, broker, 100).fault, fault);
  assert.equal(nativeStopRequestEvidence('private/url?token=secret', broker, 100).fault, 'normal');
  assert.deepEqual(nativeStopRequestEvidence(undefined, { frames: NaN, activeSessions: -1 }, 100).broker,
    { frames: null, activeSessions: null });
});

test('acquire mode and outcome wait stages are optional fixed helper diagnostics', () => {
  const startup = { schemaVersion: 1, complete: true, phase: 'readyOutput', elapsedUs: 1,
    stages: Object.fromEntries(['setup', 'sourceLookup', 'device', 'pipeline', 'slots', 'query',
      'validateOutput', 'duplicateOutput', 'readyOutput'].map(phase => [phase + 'Us', 0])) };
  const timing = { schemaVersion: 1, ticks: 2, stages: {
    acquire: { count: 2, totalUs: 1000, maxUs: 900 },
    acquireSuccessWait: { count: 1, totalUs: 100, maxUs: 100 },
    acquireTimeoutWait: { count: 1, totalUs: 900, maxUs: 900 },
    privateStage: { count: 1, totalUs: 1, maxUs: 1 } } };
  for (const selectedAcquireMode of ['timeout', 'poll']) {
    assert.equal(safeNativeHelperStartup({ ...startup, selectedAcquireMode }).selectedAcquireMode, selectedAcquireMode);
    const safe = safeNativeHelperTiming({ ...timing, selectedAcquireMode });
    assert.equal(safe.selectedAcquireMode, selectedAcquireMode);
    assert.deepEqual(safe.stages.acquire, timing.stages.acquire);
    assert.deepEqual(safe.stages.acquireSuccessWait, timing.stages.acquireSuccessWait);
    assert.deepEqual(safe.stages.acquireTimeoutWait, timing.stages.acquireTimeoutWait);
    assert.equal('privateStage' in safe.stages, false);
  }
  for (const selectedAcquireMode of [undefined, null, '', 'POLL', 'private/url?token=secret']) {
    assert.equal('selectedAcquireMode' in safeNativeHelperStartup({ ...startup, selectedAcquireMode }), false);
    assert.equal('selectedAcquireMode' in safeNativeHelperTiming({ ...timing, selectedAcquireMode }), false);
  }
  assert.equal('acquireTimeoutWait' in safeNativeHelperTiming({ ...timing,
    stages: { ...timing.stages, acquireTimeoutWait: { count: -1, totalUs: 900, maxUs: 900 } } }).stages, false);
});

test('CPU Map readiness counters and host wall timing remain separate from readback copying', () => {
  const safe = safeNativeHelperTiming({ schemaVersion: 1, ticks: 1, cpuMapAttempts: 3, cpuMapStillDrawing: 2,
    cpuMapCancelled: 0, cpuMapTimeouts: 0, privateMapping: 'private',
    stages: { cpuMapWait: { count: 1, totalUs: 501, maxUs: 501 }, cpuReadback: { count: 1, totalUs: 20, maxUs: 20 } } });
  assert.equal(safe.cpuMapAttempts, 3); assert.equal(safe.cpuMapStillDrawing, 2);
  assert.equal(safe.cpuMapCancelled, 0); assert.equal(safe.cpuMapTimeouts, 0);
  assert.deepEqual(safe.stages.cpuMapWait, { count: 1, totalUs: 501, maxUs: 501 });
  assert.deepEqual(safe.stages.cpuReadback, { count: 1, totalUs: 20, maxUs: 20 });
  assert.equal('privateMapping' in safe, false);
});

test('display sleep prevention defaults off and is limited to native foreground cases', () => {
  assert.equal(performanceDisplaySleepPrevention({}, [{ source: 'generated' }]), false);
  assert.equal(performanceDisplaySleepPrevention({ COVE_FPS_PREVENT_DISPLAY_SLEEP: '0' }), false);
  assert.equal(performanceDisplaySleepPrevention({ COVE_FPS_PREVENT_DISPLAY_SLEEP: '1' }, [{ source: 'native' }]), true);
  assert.throws(() => performanceDisplaySleepPrevention({ COVE_FPS_PREVENT_DISPLAY_SLEEP: '1' }, [{ source: 'generated' }]), /foreground native/);
  assert.throws(() => performanceDisplaySleepPrevention({ COVE_FPS_PREVENT_DISPLAY_SLEEP: '1' }, [{ source: 'native' }], true), /foreground native/);
  for (const flag of ['', 'true', '2']) assert.throws(() => performanceDisplaySleepPrevention({ COVE_FPS_PREVENT_DISPLAY_SLEEP: flag }), /Invalid/);
});

test('stock fallback continuous playback requires multiple decoded frames and advancing owned pixels', () => {
  const first = { currentVideo: { trackToken: 1, reportId: 'owned', framesDecoded: 10 },
    ownedPattern: { capturedSequence: 100, markersMatched: [true, true, true, true] } };
  const sample = (frames, sequence) => ({ currentVideo: { ...first.currentVideo, framesDecoded: frames },
    ownedPattern: { ...first.ownedPattern, capturedSequence: sequence } });
  assert.deepEqual(stockFallbackPlaybackEvidence(first, sample(11, 101)),
    { decodedFramesDelta: 1, sequenceAdvanced: true, markersMatched: true, playbackContinues: false });
  assert.equal(stockFallbackPlaybackEvidence(first, sample(12, 100)).playbackContinues, false);
  assert.equal(stockFallbackPlaybackEvidence(first, sample(12, 101)).playbackContinues, true);
  const changed = sample(12, 101); changed.currentVideo.trackToken = 2;
  assert.equal(stockFallbackPlaybackEvidence(first, changed).decodedFramesDelta, null);
  const bad = sample(12, 101); bad.ownedPattern.markersMatched[0] = false;
  assert.equal(stockFallbackPlaybackEvidence(first, bad).playbackContinues, false);
});
