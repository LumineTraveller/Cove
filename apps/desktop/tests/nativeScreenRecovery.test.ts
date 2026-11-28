import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareNativeScreen, type NativeScreenSettings } from '../src/features/media/screen/nativeScreenRecovery';
import type {
  NativeCaptureCandidate, NativeScreenCaptureAttempt, NativeScreenCaptureOptions,
} from '../src/features/media/screen/nativeScreenCapture';

const display = { authorizationId: 'same-display', width: 2560, height: 1600 };
const lease = { display, release() {} };
const settings: NativeScreenSettings = { preset: '1080p', fps: 120, gameMode: true, nativeResolution: false, gpuEncoding: false };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fail(options: NativeScreenCaptureOptions, reason: string) {
  options.onAttemptStopped?.({ startFailureReason: reason } as NativeScreenCaptureAttempt);
  return null;
}
function candidate() {
  const track = { readyState: 'live', getSettings: () => ({ width: 1728, height: 1080 }) };
  return { stream: { getVideoTracks: () => [track] }, commit() {}, stop() {} } as unknown as NativeCaptureCandidate;
}

test('delivery failures can recover using native CPU NV12 with the current codec and unchanged capture settings', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempts: NativeScreenCaptureOptions[] = [];
  const opening = prepareNativeScreen(lease, settings, 'bt601-limited', new AbortController().signal, () => true, false,
    async (source, options) => {
      assert.equal(source, display);
      attempts.push(options);
      return options.cpuNv12 ? candidate() : fail(options, 'transfer_failed');
    });
  await flush();
  t.mock.timers.tick(250);
  await flush();
  t.mock.timers.tick(850);
  const result = await opening;
  assert.equal(attempts.length, 3);
  assert.equal(attempts[1].conservativeDelivery, true);
  assert.equal(attempts[2].cpuNv12, true);
  for (const option of attempts) {
    assert.equal(option.colorSpace, 'bt601-limited');
    assert.deepEqual([option.maxWidth, option.maxHeight, option.fps], [1920, 1080, 120]);
  }
  assert.deepEqual([result?.plan.outputWidth, result?.plan.outputHeight, result?.plan.fps], [1728, 1080, 120]);
});

test('a long secure-desktop interruption preserves native recovery and stop cancels its wait immediately', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let attempts = 0;
  const recovery = prepareNativeScreen(lease, settings, 'bt709-limited', controller.signal, () => true, true,
    async (source, options) => { assert.equal(source, display); ++attempts; return fail(options, 'desktop_unavailable'); });
  await flush();
  for (const delay of [250, 850, 1800, 4000, 5000, 6000, 7000]) {
    t.mock.timers.tick(delay);
    await flush();
  }
  assert.equal(attempts, 8);
  controller.abort();
  assert.equal(await recovery, null);
  t.mock.timers.tick(8000);
  assert.equal(attempts, 8);
});

test('extended transient failures can return to the same screen after the initial retry budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const recovery = prepareNativeScreen(lease, settings, 'bt709-limited', new AbortController().signal, () => true, true,
    async (source, options) => {
      assert.equal(source, display);
      return ++attempts <= 5 ? fail(options, 'duplication_busy') : candidate();
    });
  await flush();
  for (const delay of [250, 850, 1800, 4000, 5000]) {
    t.mock.timers.tick(delay);
    await flush();
  }
  assert.equal((await recovery)?.plan.fps, 120);
  assert.equal(attempts, 6);
});

test('a failed display query retries the selected display and reports the query failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const opening = prepareNativeScreen(lease, settings, undefined, new AbortController().signal, () => true, false,
    async (source, options) => {
      assert.equal(source, display);
      ++attempts;
      return fail(options, 'display_query_failed');
    });
  const failed = assert.rejects(opening, { message: '无法读取当前显示器的状态。请重新开始屏幕共享。' });
  await flush();
  for (const delay of [250, 850, 1800]) {
    t.mock.timers.tick(delay);
    await flush();
  }
  await failed;
  assert.equal(attempts, 4);
});

test('a revoked selection stops immediately without asking for or starting a different native display', async () => {
  let attempts = 0;
  await assert.rejects(prepareNativeScreen(lease, settings, undefined, new AbortController().signal, () => true, true,
    async (source, options) => { assert.equal(source, display); ++attempts; return fail(options, 'authorization_expired'); }));
  assert.equal(attempts, 1);
});
