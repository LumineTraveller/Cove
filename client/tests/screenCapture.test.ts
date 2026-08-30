import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyScreenCaptureConstraints,
  buildScreenCaptureConstraints,
  createScreenEncodingPlan,
  isScreenEncodingWithinPlan,
  SCREEN_PRESETS,
  toScreenRtpEncoding,
  withScreenEncodingPlan,
  type ScreenActivity,
  type ScreenPreset,
} from '../src/screenCapture';

test('game mode requests a 55-60 FPS capture range without pretending to resize the desktop source', () => {
  assert.deepEqual(buildScreenCaptureConstraints({
    fps: 60,
    strictFrameRate: true,
  }), {
    frameRate: { min: 55, ideal: 60, max: 60 },
  });
});

test('1080p keeps a 16:10 source inside 1920x1080 without cropping', () => {
  const plan = createScreenEncodingPlan({
    preset: '1080p',
    maxFps: 60,
    activity: 'motion',
    sourceWidth: 2560,
    sourceHeight: 1600,
  });

  assert.equal(plan.outputWidth, 1728);
  assert.equal(plan.outputHeight, 1080);
  assert.ok(Math.abs(plan.scaleResolutionDownBy - (1600 / 1080)) < 0.000_001);
  assert.equal(plan.fps, 60);
  assert.equal(plan.degradationPreference, 'maintain-framerate');
  assert.deepEqual(toScreenRtpEncoding(plan), {
    maxFramerate: 60,
    scaleResolutionDownBy: 1600 / 1080,
  });
});

test('720p turns a 2560x1600 desktop into a bounded 1152x720 RTP stream', () => {
  const plan = createScreenEncodingPlan({
    preset: '720p',
    maxFps: 30,
    activity: 'active',
    sourceWidth: 2560,
    sourceHeight: 1600,
  });

  assert.equal(plan.outputWidth, 1152);
  assert.equal(plan.outputHeight, 720);
  assert.ok(Math.abs(plan.scaleResolutionDownBy - (1600 / 720)) < 0.000_001);
  assert.equal(plan.fps, 30);
});

test('1440p keeps a 4K screen at 2560x1440 and 60 FPS without a bitrate cap', () => {
  const plan = createScreenEncodingPlan({
    preset: '1440p',
    maxFps: 60,
    activity: 'motion',
    sourceWidth: 3840,
    sourceHeight: 2160,
  });

  assert.equal(plan.outputWidth, 2560);
  assert.equal(plan.outputHeight, 1440);
  assert.equal(plan.scaleResolutionDownBy, 1.5);
  assert.equal(plan.fps, 60);
  assert.deepEqual(toScreenRtpEncoding(plan), {
    maxFramerate: 60,
    scaleResolutionDownBy: 1.5,
  });
});

test('a window below the selected preset is never enlarged', () => {
  const plan = createScreenEncodingPlan({
    preset: '1080p',
    maxFps: 30,
    activity: 'static',
    sourceWidth: 1280,
    sourceHeight: 800,
  });

  assert.equal(plan.outputWidth, 1280);
  assert.equal(plan.outputHeight, 800);
  assert.equal(plan.scaleResolutionDownBy, 1);
  assert.equal(plan.fps, 15);
});

test('every resolution, frame-rate choice and activity leaves bitrate to WebRTC', () => {
  for (const preset of Object.keys(SCREEN_PRESETS) as ScreenPreset[]) {
    for (const maxFps of [30, 60] as const) {
      for (const activity of ['static', 'active', 'motion'] as ScreenActivity[]) {
        const plan = createScreenEncodingPlan({ preset, maxFps, activity });
        const encoding = toScreenRtpEncoding(plan);
        assert.equal(Object.hasOwn(encoding, 'maxBitrate'), false, `${preset}/${maxFps}/${activity}`);
        assert.equal(encoding.maxFramerate, activity === 'static' ? 15 : activity === 'motion' ? maxFps : 30);
        assert.equal(encoding.scaleResolutionDownBy, 1);
      }
    }
  }
});

test('runtime mode changes clear a previous cap without losing sender identity or active state', () => {
  const original: RTCRtpSendParameters = {
    transactionId: 'transaction-1',
    codecs: [], headerExtensions: [], rtcp: { cname: 'screen-sender' },
    encodings: [{ rid: 'screen', active: false, maxBitrate: 350_000, maxFramerate: 15, scaleResolutionDownBy: 4 }],
  };
  let parameters = original;
  for (const activity of ['motion', 'static', 'active'] as ScreenActivity[]) {
    const plan = createScreenEncodingPlan({ preset: '1440p', maxFps: 60, activity, sourceWidth: 3840, sourceHeight: 2160 });
    parameters = withScreenEncodingPlan(parameters, plan);
    assert.equal(Object.hasOwn(parameters.encodings[0], 'maxBitrate'), false);
    assert.equal(parameters.transactionId, original.transactionId);
    assert.equal(parameters.encodings[0].rid, 'screen');
    assert.equal(parameters.encodings[0].active, false);
    assert.equal(parameters.encodings[0].maxFramerate, plan.fps);
    assert.equal(parameters.encodings[0].scaleResolutionDownBy, 1.5);
    assert.equal(parameters.degradationPreference, plan.degradationPreference);
  }
  assert.equal(original.encodings[0].maxBitrate, 350_000, 'the previous parameter snapshot is not mutated');
});

test('runtime stats detect when Chromium ignored the RTP resolution limit', () => {
  const plan = createScreenEncodingPlan({
    preset: '1080p',
    maxFps: 60,
    activity: 'motion',
    sourceWidth: 2560,
    sourceHeight: 1600,
  });

  assert.equal(isScreenEncodingWithinPlan(1728, 1080, plan), true);
  assert.equal(isScreenEncodingWithinPlan(1730, 1082, plan), true);
  assert.equal(isScreenEncodingWithinPlan(2560, 1600, plan), false);
  assert.equal(isScreenEncodingWithinPlan(undefined, undefined, plan), null);
});

test('strict capture constraints fall back to ideal/max when Chromium rejects min', async () => {
  const calls: MediaTrackConstraints[] = [];
  const track = {
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      calls.push(constraints);
      if (calls.length === 1) throw new Error('Overconstrained');
    },
  } as unknown as MediaStreamTrack;

  const result = await applyScreenCaptureConstraints(track, {
    fps: 60,
    strictFrameRate: true,
  });

  assert.equal(result.mode, 'preferred');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].frameRate, { min: 55, ideal: 60, max: 60 });
  assert.deepEqual(calls[1].frameRate, { ideal: 60, max: 60 });
});
