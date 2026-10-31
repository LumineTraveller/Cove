import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameIntervalWindow } from '../src/features/media/diagnostics/frameIntervals';

function approximately(actual: number | null, expected: number, tolerance = 1e-6) {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < tolerance, `${actual} differs from ${expected}`);
}

test('defaults wait for 100 actual intervals and report steady 120 FPS', () => {
  const window = createFrameIntervalWindow();
  assert.deepEqual(window.snapshot(0), {
    lowFps: null, sampleCount: 0, slowFrameCount: 0, windowMs: 30_000,
    observedMs: 0, maxFrameIntervalMs: null, lastFrameAgeMs: null, missedFrames: 0,
    status: 'sampling', capacityLimited: false,
  });
  for (let frame = 0; frame < 100; frame++) window.observe(frame * 1000 / 120, frame * 1000 / 120);
  const insufficient = window.snapshot(99 * 1000 / 120);
  assert.equal(insufficient.sampleCount, 99);
  assert.equal(insufficient.status, 'sampling');
  assert.equal(insufficient.lowFps, null);
  window.observe(100 * 1000 / 120, 100 * 1000 / 120);
  const ready = window.snapshot(100 * 1000 / 120);
  assert.equal(ready.sampleCount, 100);
  assert.equal(ready.slowFrameCount, 1);
  assert.equal(ready.status, 'ready');
  approximately(ready.lowFps, 120);
});

test('the maximum includes observed intervals while sampling', () => {
  const window = createFrameIntervalWindow({ minSamples: 3 });
  window.observe(0, 0);
  assert.equal(window.snapshot(0).maxFrameIntervalMs, null);
  window.observe(10, 10);
  window.observe(40, 40);
  const sample = window.snapshot(40);
  assert.equal(sample.status, 'sampling');
  assert.equal(sample.maxFrameIntervalMs, 30);
});

test('one real slow frame controls the slowest one percent without FPS averaging', () => {
  const window = createFrameIntervalWindow();
  window.observe(0, 0);
  let time = 0;
  for (let frame = 1; frame <= 100; frame++) {
    time += frame === 50 ? 100 : 10;
    window.observe(time, time);
  }
  const sample = window.snapshot(time);
  assert.equal(sample.slowFrameCount, 1);
  assert.equal(sample.lowFps, 10);
  assert.equal(sample.observedMs, 1090);
  assert.equal(sample.maxFrameIntervalMs, 100);
});

test('ceil one percent uses two real worst intervals at 101 samples', () => {
  const window = createFrameIntervalWindow();
  window.observe(0, 0);
  let time = 0;
  for (let frame = 1; frame <= 101; frame++) {
    time += frame === 50 ? 100 : frame === 51 ? 50 : 10;
    window.observe(time, time);
  }
  const sample = window.snapshot(time);
  assert.equal(sample.slowFrameCount, 2);
  approximately(sample.lowFps, 1000 / 75);
});

test('rolling expiry removes old slow intervals and uses the local observation clock', () => {
  const window = createFrameIntervalWindow({ windowMs: 100, minSamples: 1 });
  // The frame source and local observer have deliberately different origins.
  window.observe(1_000_000, 0);
  window.observe(1_000_100, 10);
  window.observe(1_000_110, 20);
  const initial = window.snapshot(20);
  assert.equal(initial.lowFps, 10);
  assert.equal(initial.maxFrameIntervalMs, 100);
  window.observe(1_000_120, 110);
  const sample = window.snapshot(110);
  assert.equal(sample.sampleCount, 2);
  assert.equal(sample.lowFps, 100);
  assert.equal(sample.maxFrameIntervalMs, 10);
  window.observe(1_000_140, 120);
  assert.equal(window.snapshot(120).lowFps, 50);
  assert.equal(window.snapshot(120).maxFrameIntervalMs, 20);
  assert.equal(window.snapshot(220).maxFrameIntervalMs, null);
});

test('stalls invalidate old healthy values and retain the actual recovery gap', () => {
  const window = createFrameIntervalWindow({ minSamples: 1 });
  window.observe(0, 0);
  window.observe(10, 10);
  assert.equal(window.snapshot(10).lowFps, 100);
  const stalled = window.snapshot(1010);
  assert.equal(stalled.status, 'stalled');
  assert.equal(stalled.lowFps, null);
  assert.equal(stalled.lastFrameAgeMs, 1000);
  assert.equal(stalled.maxFrameIntervalMs, 10);
  window.observe(2010, 2010);
  const recovered = window.snapshot(2010);
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.lowFps, 0.5);
  assert.equal(recovered.observedMs, 2010);
  assert.equal(recovered.maxFrameIntervalMs, 2000);
});

test('a gap longer than the window is not clipped or replaced with invented frames', () => {
  const window = createFrameIntervalWindow({ windowMs: 100, minSamples: 1 });
  window.observe(0, 0);
  window.observe(10, 10);
  window.observe(1010, 1010);
  const sample = window.snapshot(1010);
  assert.equal(sample.sampleCount, 1);
  assert.equal(sample.lowFps, 1);
  assert.equal(sample.observedMs, 1000);
  assert.equal(sample.maxFrameIntervalMs, 1000);
});

test('missed callbacks suppress the claim of complete 1% low until they expire', () => {
  const window = createFrameIntervalWindow({ windowMs: 100, minSamples: 1 });
  window.observe(0, 0);
  window.observe(30, 30, 2);
  const incomplete = window.snapshot(30);
  assert.equal(incomplete.sampleCount, 1);
  assert.equal(incomplete.missedFrames, 2);
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(incomplete.lowFps, null);
  assert.equal(incomplete.maxFrameIntervalMs, 30);
  window.observe(40, 130);
  const complete = window.snapshot(130);
  assert.equal(complete.missedFrames, 0);
  assert.equal(complete.status, 'ready');
  assert.equal(complete.lowFps, 100);
  assert.equal(complete.maxFrameIntervalMs, 10);
});

test('fixed capacity discloses lost coverage until the overwritten interval expires', () => {
  const window = createFrameIntervalWindow({ capacity: 3, minSamples: 1, windowMs: 1000 });
  for (let frame = 0; frame <= 4; frame++) window.observe(frame * 10, frame * 10);
  const truncated = window.snapshot(40);
  assert.equal(truncated.sampleCount, 3);
  assert.equal(truncated.capacityLimited, true);
  assert.equal(truncated.status, 'incomplete');
  assert.equal(truncated.lowFps, null);
  const covered = window.snapshot(1011);
  assert.equal(covered.sampleCount, 3);
  assert.equal(covered.capacityLimited, false);
  assert.equal(covered.status, 'ready');
  assert.equal(covered.lowFps, 100);
});

test('capacity-limited maximum includes retained intervals only', () => {
  const window = createFrameIntervalWindow({ capacity: 3, minSamples: 1, windowMs: 1000 });
  for (const time of [0, 100, 110, 120, 130]) window.observe(time, time);
  const truncated = window.snapshot(130);
  assert.equal(truncated.capacityLimited, true);
  assert.equal(truncated.status, 'incomplete');
  assert.equal(truncated.maxFrameIntervalMs, 10);
  const covered = window.snapshot(1101);
  assert.equal(covered.capacityLimited, false);
  assert.equal(covered.status, 'ready');
  assert.equal(covered.maxFrameIntervalMs, 10);
});

test('overwriting already expired intervals does not falsely mark the current window incomplete', () => {
  const window = createFrameIntervalWindow({ capacity: 2, minSamples: 1, windowMs: 5 });
  for (let frame = 0; frame <= 5; frame++) window.observe(frame * 10, frame * 10);
  const sample = window.snapshot(50);
  assert.equal(sample.sampleCount, 1);
  assert.equal(sample.capacityLimited, false);
  assert.equal(sample.status, 'ready');
  assert.equal(sample.lowFps, 100);
});

test('invalid values clear history, while a valid reset/duplicate becomes a new baseline', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const window = createFrameIntervalWindow({ minSamples: 1 });
    window.observe(100, 100);
    window.observe(110, 110);
    window.observe(bad, 120);
    assert.equal(window.snapshot(120).sampleCount, 0);
    assert.equal(window.snapshot(120).maxFrameIntervalMs, null);
    assert.equal(window.snapshot(120).lastFrameAgeMs, null);
    window.observe(200, 200);
    window.observe(210, 210);
    assert.equal(window.snapshot(210).lowFps, 100);
  }
  const window = createFrameIntervalWindow({ minSamples: 1 });
  window.observe(100, 100);
  window.observe(110, 110);
  window.observe(110, 120);
  assert.equal(window.snapshot(120).sampleCount, 0);
  assert.equal(window.snapshot(120).maxFrameIntervalMs, null);
  window.observe(120, 130);
  assert.equal(window.snapshot(130).lowFps, 100);
  window.observe(10, 140);
  assert.equal(window.snapshot(140).sampleCount, 0);
  window.observe(20, 130); // Local clock reset too.
  assert.equal(window.snapshot(130).sampleCount, 0);
});

test('invalid observation clocks, missed counts and snapshot clocks cannot preserve a healthy reading', () => {
  for (const [timestamp, observedAt, missed] of [
    [20, Number.NaN, 0], [20, -1, 0], [20, 20, -1], [20, 20, 0.5],
    [20, 20, Number.NaN], [20, 20, Number.POSITIVE_INFINITY], [20, 20, 0x1_0000_0000],
  ]) {
    const window = createFrameIntervalWindow({ minSamples: 1 });
    window.observe(0, 0);
    window.observe(10, 10);
    window.observe(timestamp, observedAt, missed);
    assert.equal(window.snapshot(20).lowFps, null);
    assert.equal(window.snapshot(20).sampleCount, 0);
  }
  const window = createFrameIntervalWindow({ minSamples: 1 });
  window.observe(0, 0);
  window.observe(10, 10);
  assert.equal(window.snapshot(9).status, 'sampling');
  assert.equal(window.snapshot(9).maxFrameIntervalMs, null);
  window.observe(20, 20);
  assert.equal(window.snapshot(Number.NaN).lowFps, null);
});

test('reset is reusable, independent instances and detached snapshots retain no shared state', () => {
  const first = createFrameIntervalWindow({ minSamples: 1 });
  const second = createFrameIntervalWindow({ minSamples: 1 });
  first.observe(0, 0);
  first.observe(10, 10);
  const oldSnapshot = first.snapshot(10);
  oldSnapshot.lowFps = -999;
  assert.equal(first.snapshot(10).lowFps, 100);
  assert.equal(second.snapshot(10).lowFps, null);
  first.reset();
  first.reset();
  assert.equal(first.snapshot(10).status, 'sampling');
  assert.equal(first.snapshot(10).lastFrameAgeMs, null);
  assert.equal(first.snapshot(10).maxFrameIntervalMs, null);
  first.observe(100, 100);
  first.observe(120, 120);
  assert.equal(first.snapshot(120).lowFps, 50);
  assert.equal(first.snapshot(120).maxFrameIntervalMs, 20);
});

test('capacity remains bounded during a sustained high-rate observation burst', () => {
  const window = createFrameIntervalWindow();
  for (let frame = 0; frame <= 20_000; frame++) window.observe(frame, frame);
  const sample = window.snapshot(20_000);
  assert.equal(sample.sampleCount, 8192);
  assert.equal(sample.capacityLimited, true);
  assert.equal(sample.lowFps, null);
});

test('invalid configuration is rejected instead of allocating an unbounded or unusable window', () => {
  for (const options of [
    { windowMs: 0 }, { windowMs: Number.NaN }, { capacity: 0 }, { capacity: 1.5 },
    { capacity: 65_537 }, { minSamples: 0 }, { minSamples: 8193 },
    { staleAfterMs: 0 }, { staleAfterMs: Number.POSITIVE_INFINITY },
  ]) assert.throws(() => createFrameIntervalWindow(options), RangeError);
});
