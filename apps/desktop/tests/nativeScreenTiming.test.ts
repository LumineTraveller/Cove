import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeScreenHelperTimingCollector, createNativeScreenTimingLogger,
  nativeScreenBrokerTiming, nativeScreenHelperTiming } from '../electron/native-screen-capture-timing';

const helper = () => ({ schemaVersion: 1, final: false, selectedCompletion: 'query', selectedAcquireMode: 'timeout',
  elapsedUs: 1_000_000, periodUs: 8333, ticks: 120, newFrames: 115, refreshFrames: 1, noSlot: 3, noPresent: 1,
  stages: { gpuWait: { count: 116, totalUs: 1000, maxUs: 100 }, slotCreditWait: { count: 3, totalUs: 200, maxUs: 100 } },
  leaseResidence: { count: 116, totalUs: 1_000_000, maxUs: 20_000, buckets: [1, 2, 3, 4, 5, 6, 95] } });
const wire = (value = helper()) => Buffer.from('COVE_NATIVE_CAPTURE_TIMING ' + JSON.stringify(value) + '\n');
const broker = () => ({ activeSessions: 1, sessions: 1, frames: 120, busySlots: 2, pendingReferences: 2,
  started: 1, stopped: 0, disabled: false, failureCode: null, lastEndReason: null,
  pixelFormat: 'bgra', frameStorage: 'gpu',
  timing: { reference: { count: 118, totalMs: 2000, maxMs: 32, buckets: [0, 1, 2, 3, 4, 5, 103] } } });

test('helper timing copies only fixed numeric fields and freezes residence buckets', () => {
  const raw = { ...helper(), token: 'private', source: 'private',
    stages: { ...helper().stages, secret: { count: 1, totalUs: 1, maxUs: 1 } } };
  const safe = nativeScreenHelperTiming(raw)!;
  assert.equal(safe.counts.newFrames, 115);
  assert.equal(safe.stages.gpuWait?.maxUs, 100);
  assert.equal(JSON.stringify(safe).includes('private'), false);
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.ok(Object.isFrozen(safe));
  assert.ok(Object.isFrozen(safe.leaseResidence?.buckets));
  raw.leaseResidence.buckets[0] = 100;
  assert.equal(safe.leaseResidence?.buckets[0], 1);
});

test('invalid and nonfinite helper fields are rejected or omitted', () => {
  for (const value of [null, [], {}, { schemaVersion: 2 }, { schemaVersion: 1, ticks: 1 },
    { schemaVersion: 1, stages: { gpuWait: { count: 1, totalUs: 1, maxUs: 1 } } }])
    assert.equal(nativeScreenHelperTiming(value), null);
  const safe = nativeScreenHelperTiming({ ...helper(), noSlot: -1, ticks: NaN, private: 'secret',
    leaseResidence: { count: 1, totalUs: 2, maxUs: 2, buckets: [1, 2] },
    stages: { gpuWait: { count: 1, totalUs: Infinity, maxUs: 1 }, draw: { count: 1, totalUs: 1, maxUs: 1 } } })!;
  assert.equal(safe.counts.ticks, undefined);
  assert.equal(safe.counts.noSlot, undefined);
  assert.equal(safe.stages.gpuWait, undefined);
  assert.equal(safe.leaseResidence, undefined);
});

test('collector handles split lines and never forwards raw helper output', () => {
  const samples: unknown[] = [];
  const collector = createNativeScreenHelperTimingCollector(sample => samples.push(sample));
  const bytes = wire();
  for (const byte of bytes) collector.write(Buffer.from([byte]));
  collector.write(Buffer.from('unrecognized token=secret\nCOVE_NATIVE_CAPTURE_TIMING invalid-json\n'));
  assert.equal(samples.length, 1);
  assert.equal(collector.snapshot().rejected, 1);
  assert.equal(JSON.stringify(samples).includes('secret'), false);
  assert.equal(collector.snapshot().pendingCharacters, 0);
});

test('oversized partial lines and chunks discard their tails and recover at the next full line', () => {
  const samples: unknown[] = [];
  const collector = createNativeScreenHelperTimingCollector(sample => samples.push(sample));
  collector.write(Buffer.from('COVE_NATIVE_CAPTURE_TIMING ' + 'x'.repeat(16_384)));
  assert.equal(collector.snapshot().pendingCharacters, 0);
  collector.write(Buffer.concat([Buffer.from('tail\n'), wire()]));
  collector.write(Buffer.alloc(65_537, 120));
  collector.write(Buffer.concat([wire(), wire()]));
  assert.equal(samples.length, 2, 'the first line after an oversized chunk is its discarded tail');
  assert.equal(collector.snapshot().rejected, 2);
  collector.write(Buffer.from('unfinished'));
  collector.close();
  collector.write(wire());
  assert.equal(samples.length, 2);
  assert.equal(collector.snapshot().pendingCharacters, 0);
});

test('observer callback failure is swallowed and later helper samples still parse', () => {
  let calls = 0;
  const collector = createNativeScreenHelperTimingCollector(() => { calls++; throw Error('private'); });
  assert.doesNotThrow(() => collector.write(Buffer.concat([wire(), wire()])));
  assert.equal(calls, 2);
  assert.equal(collector.snapshot().samples, 2);
});

test('UTF8 byte limit is enforced even when an oversized line has fewer than 16384 characters', () => {
  const samples: unknown[] = [];
  const collector = createNativeScreenHelperTimingCollector(sample => samples.push(sample));
  collector.write(Buffer.from('COVE_NATIVE_CAPTURE_TIMING ' + '汉'.repeat(6000)));
  assert.equal(collector.snapshot().rejected, 1);
  assert.equal(collector.snapshot().pendingBytes, 0);
  collector.write(Buffer.concat([Buffer.from('discarded tail\n'), wire()]));
  assert.equal(samples.length, 1);
  assert.equal(collector.snapshot().pendingCharacters, 0);
});

test('asynchronous helper observer rejection cannot become an unhandled rejection', async () => {
  let calls = 0;
  const collector = createNativeScreenHelperTimingCollector(async () => { calls++; throw Error('private'); });
  collector.write(wire());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(collector.snapshot().samples, 1);
});

test('broker observation strips future private fields and invalid counter/timing values', () => {
  const safe = nativeScreenBrokerTiming({ ...broker(), requestId: 'secret', handles: ['secret'],
    token: 'secret', frames: NaN, failureCode: 'secret', lastEndReason: 'source_ineligible\nsecret',
    timing: { reference: { count: 1, totalMs: 1, maxMs: 1, buckets: [1] },
      import: { count: 1, totalMs: 0.25, maxMs: 0.25, buckets: [1, 0, 0, 0, 0, 0, 0] }, secret: 'secret' } })!;
  assert.equal(safe.frames, undefined);
  assert.equal(safe.failureReason, 'unknown_failure');
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.deepEqual((safe.timing as Record<string, unknown>).reference, undefined);
  assert.equal(nativeScreenBrokerTiming(null), null);
});

function loggerFixture(overrides: { snapshot?: () => unknown; log?: (value: unknown) => void; timerThrows?: boolean } = {}) {
  let now = 0, nowCalls = 0, cleared = 0, unrefs = 0, snapshotCalls = 0;
  let callback: (() => void) | undefined;
  const rows: unknown[] = [];
  const logger = createNativeScreenTimingLogger({
    now: () => { nowCalls++; return now; },
    setInterval(fn, milliseconds) {
      assert.equal(milliseconds, 5000);
      if (overrides.timerThrows) throw Error('private');
      callback = fn;
      return { unref() { unrefs++; } };
    },
    clearInterval() { cleared++; },
    snapshot: () => { snapshotCalls++; return overrides.snapshot?.() ?? broker(); },
    log: value => { rows.push(value); return overrides.log?.(value); },
  });
  return { logger, rows, tick(elapsedMs = 5000) { now += elapsedMs; callback?.(); },
    state: () => ({ nowCalls, cleared, unrefs, snapshotCalls }) };
}

test('logger is dormant until start and emits only five-second fixed summaries', () => {
  const f = loggerFixture();
  assert.deepEqual(f.state(), { nowCalls: 0, cleared: 0, unrefs: 0, snapshotCalls: 0 });
  f.logger.start(); f.logger.start();
  assert.equal(f.state().unrefs, 1);
  const safe = nativeScreenHelperTiming(helper())!;
  f.logger.helper({ ...safe, token: 'private' } as typeof safe, 2);
  f.logger.helper(safe, 1);
  f.tick();
  const row = f.rows[0] as Record<string, unknown>;
  assert.equal(row.event, 'sample');
  assert.equal(row.helperCaptureNumber, 2);
  assert.equal(row.helperMatchesLatestStart, false);
  assert.equal(JSON.stringify(row).includes('private'), false);
  assert.equal(f.logger.state().retainedHelperSamples, 1);
  f.logger.stop(); f.logger.stop();
  f.logger.helper(safe, 3); f.tick();
  assert.equal(f.rows.length, 1);
  assert.equal(f.state().cleared, 1);
  assert.equal(f.logger.state().retainedHelperSamples, 0);
});

test('logger stops only observation at 120 records / ten minutes and reports limited', () => {
  const f = loggerFixture(); f.logger.start();
  for (let i = 0; i < 125; i++) f.tick();
  assert.equal(f.rows.length, 120);
  assert.equal(f.logger.state().stopped, true);
  assert.equal(f.state().snapshotCalls, 119);
  assert.deepEqual(f.rows[119], { event: 'limited', limited: true, elapsedMs: 600000,
    reason: 'time_limit', recordLimit: 120, durationLimitMs: 600000 });
  assert.equal(f.state().cleared, 1);
});

test('delayed timers cannot extend the ten-minute observation budget', () => {
  const f = loggerFixture(); f.logger.start(); f.tick(600_001);
  assert.equal(f.rows.length, 1);
  assert.equal((f.rows[0] as { limited: boolean }).limited, true);
  assert.equal(f.state().snapshotCalls, 0);
  assert.equal(f.logger.state().stopped, true);
});

test('snapshot/log/timer failures do not throw into capture and never log exception text', () => {
  const snapshot = loggerFixture({ snapshot: () => { throw Error('private token'); } });
  snapshot.logger.start(); assert.doesNotThrow(() => snapshot.tick());
  assert.equal(snapshot.logger.state().stopped, true);
  assert.equal(JSON.stringify(snapshot.rows).includes('private'), false);
  const output = loggerFixture({ log: () => { throw Error('private token'); } });
  output.logger.start(); assert.doesNotThrow(() => output.tick());
  assert.equal(output.logger.state().stopped, false);
  output.logger.stop();
  const timer = loggerFixture({ timerThrows: true });
  assert.doesNotThrow(() => timer.logger.start());
  assert.equal(timer.logger.state().stopped, true);
});

test('asynchronous logger rejection is observed without changing capture or logging exception text', async () => {
  const f = loggerFixture({ log: async () => { throw Error('private token'); } });
  f.logger.start(); f.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.logger.state().stopped, false);
  assert.equal(f.rows.length, 1);
  assert.equal(JSON.stringify(f.rows).includes('private'), false);
  f.logger.stop();
});
