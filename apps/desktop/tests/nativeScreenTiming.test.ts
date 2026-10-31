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
const tail = (elapsedUs = 1_000_000, gapUs = 20_000) => ({ elapsedUs, gapUs, tickLatenessUs: 123,
  acquireUs: 50, acquireTimeoutUs: 1000, gpuWaitUs: 2000, drawUs: 10,
  slotCreditWaitUs: 8000,
  noPresent: 1, noSlot: 0, missedTicks: 1, sourcePresents: 2, refresh: false });
const delivery = (events = [tail()]) => ({ count: 119, totalGapUs: 1_000_000, maxGapUs: 30_000,
  buckets: [10, 100, 5, 1, 1, 1, 1], tailCandidates: 9, tailRetained: events.length, tail: events });

test('delivery tail is a bounded deeply frozen numeric whitelist', () => {
  const raw = { ...helper(), delivery: { ...delivery(), secret: 'private',
    tail: [{ ...tail(), token: 'private', source: 'private' }] } };
  const safe = nativeScreenHelperTiming(raw)!;
  assert.equal(safe.delivery?.tail[0].gapUs, 20_000);
  assert.equal(safe.delivery?.tail[0].slotCreditWaitUs, 8000);
  assert.equal(JSON.stringify(safe).includes('private'), false);
  assert.ok(Object.isFrozen(safe.delivery));
  assert.ok(Object.isFrozen(safe.delivery?.buckets));
  assert.ok(Object.isFrozen(safe.delivery?.tail));
  assert.ok(Object.isFrozen(safe.delivery?.tail[0]));
  raw.delivery.tail[0].gapUs = 99_999;
  raw.delivery.tail[0].slotCreditWaitUs = 99_999;
  assert.equal(safe.delivery?.tail[0].gapUs, 20_000);
  assert.equal(safe.delivery?.tail[0].slotCreditWaitUs, 8000);
  for (const invalid of [
    { ...delivery(), tail: Array.from({ length: 9 }, () => tail()), tailRetained: 9 },
    { ...delivery(), tailRetained: 0 }, { ...delivery(), buckets: [1] },
    { ...delivery(), tail: [{ ...tail(), refresh: 1 }] },
    { ...delivery(), tail: [{ ...tail(), gapUs: 0 }] },
    { ...delivery(), tail: [{ ...tail(), acquireTimeoutUs: Number.MAX_SAFE_INTEGER + 1 }] },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, '8000'].map(slotCreditWaitUs =>
      ({ ...delivery(), tail: [{ ...tail(), slotCreditWaitUs }] })),
  ]) assert.equal(nativeScreenHelperTiming({ ...helper(), delivery: invalid })!.delivery, undefined);
});

test('delivery tails preserve slot-credit wait without noSlot ticks and accept old helper fields', () => {
  const { slotCreditWaitUs: _omitted, ...oldTail } = tail(2_000_000, 25_000);
  const events = [{ ...tail(), noSlot: 2, slotCreditWaitUs: 25_000 },
    { ...tail(1_500_000), noSlot: 0, slotCreditWaitUs: 6000 }, oldTail];
  const rawDelivery = { ...delivery(), tailRetained: events.length, tail: events };
  const safe = nativeScreenHelperTiming({ ...helper(), delivery: rawDelivery })!;
  assert.deepEqual(safe.delivery?.tail.map(event => [event.noSlot, event.slotCreditWaitUs]),
    [[2, 25_000], [0, 6000], [0, undefined]]);
  assert.equal(Object.prototype.hasOwnProperty.call(safe.delivery!.tail[2], 'slotCreditWaitUs'), false);
  const samples: unknown[] = [];
  const collector = createNativeScreenHelperTimingCollector(sample => samples.push(sample));
  collector.write(Buffer.from('COVE_NATIVE_CAPTURE_TIMING ' + JSON.stringify({ ...helper(),
    delivery: rawDelivery }) + '\n'));
  assert.equal(samples.length, 1);
  assert.equal(collector.snapshot().rejected, 0);
});

test('maximum safe delivery report fits collector byte limit and preserves no raw fields', () => {
  const events = Array.from({ length: 8 }, (_, i) => ({ ...Object.fromEntries(Object.keys(tail())
    .filter(key => key !== 'refresh').map(key => [key, Number.MAX_SAFE_INTEGER - i])), refresh: false }));
  const bytes = Buffer.from('COVE_NATIVE_CAPTURE_TIMING ' + JSON.stringify({ ...helper(),
    delivery: { ...delivery(), tail: events, tailRetained: 8 } }) + '\n');
  assert.ok(bytes.byteLength < 16_384);
  const samples: unknown[] = [];
  const collector = createNativeScreenHelperTimingCollector(sample => samples.push(sample));
  collector.write(bytes);
  assert.equal(samples.length, 1);
  assert.equal(collector.snapshot().rejected, 0);
});

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

test('logger merges every helper tail between outputs without replaying or mixing captures', () => {
  const f = loggerFixture(); f.logger.start();
  const send = (capture: number, elapsed: number, gap: number) => f.logger.helper(nativeScreenHelperTiming({
    ...helper(), elapsedUs: elapsed, delivery: delivery([tail(elapsed, gap)]),
  })!, capture);
  for (let i = 1; i <= 10; i++) send(1, i * 1_000_000, i * 10_000);
  send(1, 10_000_000, 999_999); // Duplicate report is not a new observation.
  send(1, 9_000_000, 999_999); // Late report cannot replace newer counters.
  f.tick();
  const rows = f.rows as { helper: { counts: { elapsedUs: number }; delivery: ReturnType<typeof delivery> } }[];
  assert.equal(rows[0].helper.counts.elapsedUs, 10_000_000);
  assert.deepEqual(rows[0].helper.delivery.tail.map(event => event.gapUs),
    [100_000, 90_000, 80_000, 70_000, 60_000, 50_000, 40_000, 30_000]);
  assert.equal(rows[0].helper.delivery.tailRetained, 8);
  f.tick();
  assert.deepEqual(rows[1].helper.delivery.tail, [], 'old one-second tails are not replayed');
  send(1, 11_000_000, 200_000);
  send(2, 1_000_000, 20_000);
  send(1, 12_000_000, 999_999);
  f.tick();
  assert.deepEqual(rows[2].helper.delivery.tail.map(event => event.gapUs), [20_000]);
  f.logger.stop();
});

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
