'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { nativePerformanceEnabled, nativePerformancePaths, nativeUpgradeRequired, nativeBrokerSnapshot, nativeResourcesReleased, nativeUpgradeEvidence, captureCpuSummary } = require('./screen-performance-native.cjs');

test('native measurement requires its own opt-in and respects the disable override', () => {
  assert.equal(nativePerformanceEnabled({}), false);
  assert.equal(nativePerformanceEnabled({ COVE_NATIVE_GPU_CAPTURE: '1' }), false);
  assert.equal(nativePerformanceEnabled({ COVE_FPS_NATIVE_GPU: '1' }), true);
  assert.equal(nativePerformanceEnabled({ COVE_FPS_NATIVE_GPU: '1', COVE_DISABLE_NATIVE_GPU_CAPTURE: '1' }), false);
  assert.throws(() => nativePerformanceEnabled({ COVE_FPS_NATIVE_GPU: 'true' }));
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

test('safe broker evidence omits private fields and cleanup cannot pass missing counters', () => {
  const zero = Object.fromEntries(['sessions', 'activeSessions', 'helpers', 'imports', 'pendingReferences', 'childHandles', 'busySlots'].map(key => [key, 0]));
  const safe = nativeBrokerSnapshot({ snapshot: () => ({ ...zero, disabled: false, failureCode: 'helper_failed', pid: 123, handle: 'private', sourceId: 'private' }) });
  assert.equal(nativeResourcesReleased(safe), true);
  assert.equal(nativeResourcesReleased({ ...safe, helpers: 1 }), false);
  assert.equal(nativeResourcesReleased({ ...safe, pendingReferences: 1 }), false);
  assert.equal(nativeResourcesReleased({ ...safe, childHandles: 1 }), false);
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
