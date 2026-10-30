'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { safeNativeHelperTiming, createNativeTimingCollector } = require('../tooling/screen-performance-native.cjs');

const fields = ['elapsedUs', 'gapUs', 'tickLatenessUs', 'acquireUs', 'acquireTimeoutUs',
  'gpuWaitUs', 'drawUs', 'noPresent', 'noSlot', 'missedTicks', 'sourcePresents'];
function event(index = 0) {
  return { elapsedUs: 1000000 + index, gapUs: 18000, tickLatenessUs: 800, acquireUs: 900,
    acquireTimeoutUs: 100, gpuWaitUs: 1100, drawUs: 300, noPresent: 2, noSlot: 0,
    missedTicks: 1, sourcePresents: 1, refresh: false };
}
function delivery(length = 1) {
  return { count: 120, totalGapUs: 1000000, maxGapUs: 18000,
    buckets: [0, 118, 2, 0, 0, 0, 0], tailCandidates: length + 1, tailRetained: length,
    tail: Array.from({ length }, (_, index) => event(index)) };
}
function report(value = delivery()) {
  return { schemaVersion: 1, ticks: 120, selectedCompletion: 'query', selectedAcquireMode: 'poll',
    stages: { acquire: { count: 120, totalUs: 2000, maxUs: 100 } }, delivery: value };
}

test('helper delivery preserves the fixed numeric schema with zero to eight tail examples', () => {
  for (const length of [0, 1, 8]) {
    const input = report(delivery(length)), output = safeNativeHelperTiming(input);
    assert.deepEqual(output.delivery, input.delivery);
    assert.equal(output.selectedAcquireMode, 'poll');
    assert.notEqual(output.delivery, input.delivery);
    assert.notEqual(output.delivery.buckets, input.delivery.buckets);
    assert.notEqual(output.delivery.tail, input.delivery.tail);
    if (length) assert.notEqual(output.delivery.tail[0], input.delivery.tail[0]);
    input.delivery.buckets[0] = 99;
    if (length) input.delivery.tail[0].gapUs = 99;
    assert.equal(output.delivery.buckets[0], 0);
    if (length) assert.equal(output.delivery.tail[0].gapUs, 18000);
  }
  const refresh = report(); refresh.delivery.tail[0].refresh = true;
  assert.equal(safeNativeHelperTiming(refresh).delivery.tail[0].refresh, true);
});

test('helper delivery strips unknown private fields at every report level', () => {
  const input = report();
  input.sourceId = 'private-source'; input.delivery.windowTitle = 'private-title';
  input.delivery.tail[0].handle = 'private-handle'; input.delivery.tail[0].pid = 1234;
  input.delivery.tail[0].url = 'https://private.invalid/token';
  const output = safeNativeHelperTiming(input);
  assert.deepEqual(Object.keys(output.delivery).sort(),
    ['count', 'totalGapUs', 'maxGapUs', 'buckets', 'tailCandidates', 'tailRetained', 'tail'].sort());
  assert.deepEqual(Object.keys(output.delivery.tail[0]).sort(), [...fields, 'refresh'].sort());
  assert.doesNotMatch(JSON.stringify(output), /private|handle|windowTitle|sourceId|"pid"|"url"/);
});

test('invalid optional delivery is omitted while valid timing remains available', () => {
  const malformed = [null, [], {}, { ...delivery(), buckets: [0, 0] },
    { ...delivery(), buckets: Array(7) }, { ...delivery(), tail: 'private' },
    { ...delivery(9) }, { ...delivery(), tailRetained: 0 },
    { ...delivery(), tailCandidates: 0 }, { ...delivery(), tail: [null] },
    { ...delivery(), tail: [[]] }];
  for (const key of ['count', 'totalGapUs', 'maxGapUs', 'tailCandidates', 'tailRetained']) {
    for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'])
      malformed.push({ ...delivery(), [key]: invalid });
  }
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'])
    malformed.push({ ...delivery(), buckets: [0, 0, 0, invalid, 0, 0, 0] });
  for (const key of fields) {
    for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', undefined])
      malformed.push({ ...delivery(), tail: [{ ...event(), [key]: invalid }] });
  }
  malformed.push({ ...delivery(), tail: [{ ...event(), gapUs: 0 }] });
  for (const invalid of [0, 1, 'false', null, undefined])
    malformed.push({ ...delivery(), tail: [{ ...event(), refresh: invalid }] });
  for (const input of malformed) {
    const output = safeNativeHelperTiming(report(input));
    assert.ok(output && output.stages.acquire);
    assert.equal(Object.hasOwn(output, 'delivery'), false);
  }
  const missing = report(); delete missing.delivery;
  assert.equal(Object.hasOwn(safeNativeHelperTiming(missing), 'delivery'), false);
  assert.equal(safeNativeHelperTiming({ schemaVersion: 1, delivery: delivery() }), null);
});

test('bounded helper line collector retains sanitized delivery across chunk boundaries', () => {
  const samples = [], collector = createNativeTimingCollector(sample => samples.push(sample), 1);
  const input = report(delivery(8)); input.delivery.tail[0].secret = 'private';
  const line = 'COVE_NATIVE_CAPTURE_TIMING ' + JSON.stringify(input) + '\n';
  collector.write(Buffer.from(line.slice(0, 53)));
  assert.equal(samples.length, 0);
  collector.write(Buffer.from(line.slice(53)));
  assert.equal(samples.length, 1);
  assert.equal(samples[0].delivery.tail.length, 8);
  assert.doesNotMatch(JSON.stringify(samples), /secret|private/);
  collector.write(Buffer.from(line));
  assert.equal(samples.length, 1);
  assert.equal(collector.snapshot().limited, true);
  assert.equal(collector.snapshot().pendingBytes, 0);
});
