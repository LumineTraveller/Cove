'use strict';
const fs = require('node:fs');
const path = require('node:path');

function nativePerformanceEnabled(env = process.env) {
  if (env.COVE_FPS_NATIVE_GPU && !['0', '1'].includes(env.COVE_FPS_NATIVE_GPU))
    throw Error('Invalid isolated native GPU capture option');
  return env.COVE_FPS_NATIVE_GPU === '1' && env.COVE_DISABLE_NATIVE_GPU_CAPTURE !== '1';
}

function nativePerformancePaths(root) {
  const helpers = ['apps/desktop/build/native-screen-capture-helper.exe', 'runtime/native-screen-capture/helper.exe'];
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

// The broker already exposes safe diagnostics. Keep an explicit allowlist here
// so result.json can never acquire future handles, source IDs or process IDs.
function nativeBrokerSnapshot(controller) {
  if (!controller) return null;
  const snapshot = controller.snapshot(), safe = {};
  for (const key of ['sessions', 'activeSessions', 'helpers', 'imports', 'pendingReferences', 'childHandles', 'busySlots', 'started', 'stopped', 'frames', 'refreshFrames', 'transferredFrames', 'releasedFrames']) {
    const value = snapshot[key];
    if (Number.isSafeInteger(value) && value >= 0) safe[key] = value;
  }
  if (typeof snapshot.disabled === 'boolean') safe.disabled = snapshot.disabled;
  safe.failureCode = typeof snapshot.failureCode === 'string' && /^[a-z_]{1,50}$/.test(snapshot.failureCode)
    ? snapshot.failureCode : null;
  safe.lastEndReason = typeof snapshot.lastEndReason === 'string' && /^[a-z_]{1,50}$/.test(snapshot.lastEndReason)
    ? snapshot.lastEndReason : null;
  safe.helperCpuSeconds = Number.isFinite(snapshot.helperCpuSeconds) && snapshot.helperCpuSeconds >= 0
    ? snapshot.helperCpuSeconds : null;
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
  return Boolean(snapshot && ['sessions', 'activeSessions', 'helpers', 'imports', 'pendingReferences', 'childHandles', 'busySlots'].every(key => snapshot[key] === 0));
}

function nativeUpgradeEvidence(sample, broker) {
  const source = sample?.sources?.find(item => item.isLiveSenderSource === true);
  const nativeSource = source?.kind === 'native-gpu-adapter' && source.trackState === 'live';
  const stockTrackEnded = sample?.sources?.some(item => item.kind === 'native-display-capture' && item.trackState === 'ended') === true;
  const localScreenTrackMatchesSender = sample?.nativeGpu?.localScreenTrackMatchesSender === true;
  const bridgeSupported = sample?.nativeGpu?.bridgeSupported === true;
  const brokerActive = broker?.activeSessions === 1 && broker?.helpers === 1 && broker.frames > 0 && broker.disabled === false;
  return { nativeSource, stockTrackEnded, localScreenTrackMatchesSender, bridgeSupported, brokerActive,
    passed: nativeSource && stockTrackEnded && localScreenTrackMatchesSender && bridgeSupported && brokerActive };
}

module.exports = { nativePerformanceEnabled, nativePerformancePaths, nativeUpgradeRequired, nativeBrokerSnapshot,
  nativeResourcesReleased, nativeUpgradeEvidence, captureCpuSummary };
