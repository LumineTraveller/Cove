'use strict';

function validatePerformanceCases(cases) {
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > 12)
    throw Error('Performance cases must be a bounded nonempty array');
  for (const config of cases) {
    if (!config || typeof config !== 'object' || !['generated', 'native'].includes(config.source) ||
        !['540p', '720p', '1080p', '1440p'].includes(config.preset) || ![30, 60, 120].includes(config.fps))
      throw Error('Invalid performance case');
    for (const [width, height] of [['expectWidth', 'expectHeight'],
      ['expectCaptureWidth', 'expectCaptureHeight'], ['expectEncodedWidth', 'expectEncodedHeight']]) {
      if (config[width] === undefined && config[height] === undefined) continue;
      if (![config[width], config[height]].every(value => typeof value === 'number' &&
          Number.isInteger(value) && value > 0 && value <= 8192))
        throw Error(`${width}/${height} must be paired positive integer dimensions`);
    }
    if (config.expectCodec !== undefined && !['video/VP8', 'video/AV1'].includes(config.expectCodec))
      throw Error('Unsupported comparison codec');
    if (config.captureTarget !== undefined && !['screen', 'window'].includes(config.captureTarget))
      throw Error('Unsupported native capture target');
    if (config.ownedWindowFullscreen !== undefined && typeof config.ownedWindowFullscreen !== 'boolean')
      throw Error('ownedWindowFullscreen must be a boolean');
    if (config.nativeResolution !== undefined && typeof config.nativeResolution !== 'boolean')
      throw Error('nativeResolution must be a boolean');
    if (config.nativeWindowPath !== undefined && (typeof config.nativeWindowPath !== 'boolean' ||
        config.source !== 'native' || config.captureTarget !== 'window'))
      throw Error('nativeWindowPath is a boolean for native window cases only');
  }
  return cases;
}

function screenShareStartArguments(config) {
  return [config.preset, config.fps, false, Boolean(config.game), Boolean(config.nativeResolution), Boolean(config.compatibility)];
}

// Reports must follow the live capture/sender or the receiver actually feeding
// the current video. A larger stale or placeholder counter is never a fallback.
function linkedVideoReport(sample, stage) {
  const link = sample?.pipeline?.[stage];
  if (!link) return null;
  return sample.reports?.find(report => report.id === link.reportId &&
    report.connectionIndex === link.connectionIndex) ?? null;
}

function linkedCounterRate(first, last, stage, key) {
  const a = linkedVideoReport(first, stage), b = linkedVideoReport(last, stage);
  if (!a || !b || a.id !== b.id || a.connectionIndex !== b.connectionIndex ||
      first.pipeline[stage].trackToken !== last.pipeline[stage].trackToken ||
      typeof a[key] !== 'number' || typeof b[key] !== 'number') return null;
  const seconds = (b.timestamp - a.timestamp) / 1000, delta = b[key] - a[key];
  return seconds > 0 && delta >= 0 ? delta / seconds : null;
}

function qualifyOwnedNativeBaseline(config, samples) {
  if (config.source !== 'native') return { required: false, passed: true };
  const first = samples[0], last = samples.at(-1);
  const sourceFps = first && last ? linkedCounterRate(first.sender, last.sender, 'source', 'frames') : null;
  const minimumSourceFps = Math.min(30, config.fps / 2);
  const markersMatched = samples.length >= 2 && samples.every(sample =>
    sample.viewer?.ownedPattern?.markersMatched?.length === 4 &&
    sample.viewer.ownedPattern.markersMatched.every(value => value === true));
  const sequenceAdvances = samples.slice(1).every((sample, index) => {
    const a = samples[index].viewer?.ownedPattern?.capturedSequence;
    const b = sample.viewer?.ownedPattern?.capturedSequence;
    const delta = (b - a + 65536) % 65536;
    return Number.isInteger(a) && Number.isInteger(b) && delta > 0 && delta < 32768;
  });
  const maximumSourceLagFrames = 1000;
  const capturedSequenceSourceLags = samples.map(sample => {
    const source = sample.nativeSourceFrames, captured = sample.viewer?.ownedPattern?.capturedSequence;
    return Number.isInteger(source) && Number.isInteger(captured)
      ? ((source % 65536) - captured + 65536) % 65536 : null;
  });
  const capturedSequenceNotFuture = capturedSequenceSourceLags.every(lag => lag !== null && lag <= maximumSourceLagFrames);
  return { required: true, captureTarget: config.captureTarget ?? 'window',
    minimumSourceFps, sourceFps, markersMatched, sequenceAdvances,
    maximumSourceLagFrames,capturedSequenceSourceLags,capturedSequenceNotFuture,
    passed: markersMatched && sequenceAdvances && capturedSequenceNotFuture && sourceFps !== null && sourceFps >= minimumSourceFps,
    meaning: 'Known owned pixels and changing captured sequence plus linked native media-source cadence; source rAF is not native FPS. This is qualification, not a count of every unique OS frame.' };
}

function selectOwnedCaptureSource({ captureTarget, sources, displays, primaryDisplayId, ownedWindowId, nativeWindowPath = false }) {
  let source, selectionMode;
  if (captureTarget === 'screen') {
    source = sources.find(item => item.display_id === String(primaryDisplayId));
    if (source) selectionMode = 'primary-display-id';
    else if (displays.length === 1 && sources.length === 1 && !sources[0].display_id) {
      source = sources[0]; selectionMode = 'single-display-single-source-without-display-id';
    }
  } else {
    source = sources.find(item => item.id === ownedWindowId);
    if (source) selectionMode = 'owned-window-id';
  }
  if (!source) throw Error('Owned controlled source is unavailable before capture request');
  const original = source.id.split(':'), originalThirdFieldNonzero = /^\d+$/.test(original[2] ?? '') ? Number(original[2]) !== 0 : null;
  if (nativeWindowPath) {
    if (captureTarget !== 'window' || !/^window:\d+:\d+$/.test(source.id)) throw Error('Prevalidated owned window ID cannot use native routing');
    source = { ...source, id: source.id.replace(/:\d+$/, ':0') };
  }
  return { source, metadata: { captureTarget, selectionMode, displayCount: displays.length,
    sourceCount: sources.length, selectedDisplayIdPresent: Boolean(source.display_id),
    sourceIdType: ['screen','window'].includes(original[0]) ? original[0] : 'other',
    originalThirdFieldNonzero, requestedThirdFieldNonzero: nativeWindowPath ? false : originalThirdFieldNonzero,
    nativeWindowPathRequested: nativeWindowPath } };
}

module.exports = { validatePerformanceCases, screenShareStartArguments, linkedVideoReport, linkedCounterRate, qualifyOwnedNativeBaseline, selectOwnedCaptureSource };
