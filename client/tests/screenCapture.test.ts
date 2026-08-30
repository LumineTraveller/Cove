import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyScreenCaptureConstraints,
  buildScreenCaptureConstraints,
  createScreenEncodingPlan,
  isScreenEncodingWithinPlan,
  toScreenRtpEncoding,
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
  assert.equal(plan.bitrate, 6_000_000);
  assert.equal(plan.degradationPreference, 'maintain-framerate');
  assert.deepEqual(toScreenRtpEncoding(plan), {
    maxBitrate: 6_000_000,
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
  assert.equal(plan.bitrate, 1_400_000);
});

test('1440p keeps a 4K screen at 2560x1440 with the 2K game-mode bitrate', () => {
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
  assert.equal(plan.bitrate, 10_000_000);
  assert.deepEqual(toScreenRtpEncoding(plan), {
    maxBitrate: 10_000_000,
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
  assert.equal(plan.bitrate, 1_100_000);
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
