'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { performanceSourceAgeEnabled, createSourceAgeRing, safeSourceAgeObservation } = require('./screen-performance-source-age.cjs');

test('source-age observation is strict opt-in and defaults off', () => {
  assert.equal(performanceSourceAgeEnabled({}), false);
  assert.equal(performanceSourceAgeEnabled({ COVE_FPS_SOURCE_AGE: '0' }), false);
  assert.equal(performanceSourceAgeEnabled({ COVE_FPS_SOURCE_AGE: '1' }), true);
  for (const value of ['', 'true', 'false', '01', '2', 0, 1, true, false, null])
    assert.throws(() => performanceSourceAgeEnabled({ COVE_FPS_SOURCE_AGE: value }), /Invalid source-age/);
});

test('ring resolves the original counter across 16-bit wrap with fractional browser times', () => {
  const ring = createSourceAgeRing();
  assert.equal(ring.record(65535, 1793199000000.125), true);
  assert.equal(ring.record(65536, 1793199000004.25), true);
  assert.deepEqual(ring.resolve(65535, 1793199000120.375), { status: 'matched', counter: 65535,
    drawAt: 1793199000000.125, snapshotAt: 1793199000120.375, ageMs: 120.25, retainedEntries: 2 });
  assert.equal(ring.resolve(0, 1793199000120.375).counter, 65536);
  assert.equal(ring.resolve(0, 1793199000120.375).ageMs, 116.125);
  assert.equal(ring.resolve(0, 1793199000004.25).ageMs, 0);
});

test('fixed ring capacity evicts old records and never returns a guessed match', () => {
  const ring = createSourceAgeRing();
  for (let counter = 0; counter < 5000; counter++) assert.equal(ring.record(counter, 10000 + counter), true);
  assert.deepEqual(ring.snapshot(), { capacity: 4096, size: 4096 });
  assert.equal(ring.resolve(903, 20000).status, 'history_miss');
  assert.equal(ring.resolve(904, 20000).counter, 904);
  assert.equal(ring.resolve(4999, 20000).counter, 4999);
  assert.equal(ring.resolve(5000, 20000).status, 'history_miss');
  assert.equal('entries' in ring.snapshot(), false);
});

test('duplicate sequence matches are rejected even when one history entry looks newer', () => {
  const ring = createSourceAgeRing();
  ring.record(0, 1000); ring.record(65536, 2000);
  assert.deepEqual(ring.resolve(0, 2500), { status: 'ambiguous_sequence', counter: null,
    drawAt: null, snapshotAt: 2500, ageMs: null, retainedEntries: 2 });
  const duplicate = createSourceAgeRing(); duplicate.record(1, 1000); duplicate.record(1, 1001);
  assert.equal(duplicate.resolve(1, 2000).status, 'ambiguous_sequence');
});

test('invalid counters and nonfinite, negative, zero or unsafe clocks never enter history', () => {
  const ring = createSourceAgeRing();
  for (const counter of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', true, null, undefined, 1n])
    assert.equal(ring.record(counter, 1000), false);
  for (const clock of [-1, 0, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1000', true, null, undefined, 1n])
    assert.equal(ring.record(1, clock), false);
  assert.deepEqual(ring.snapshot(), { capacity: 4096, size: 0 });
  assert.equal(ring.record(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), true);
  assert.equal(ring.resolve(Number.MAX_SAFE_INTEGER % 65536, Number.MAX_SAFE_INTEGER).ageMs, 0);
});

test('invalid lookup input and negative elapsed age are rejected without exposing history', () => {
  const ring = createSourceAgeRing(); ring.record(1, 2000);
  for (const sequence of [-1, 65536, 1.5, NaN, Infinity, '1', true, null, undefined, 1n]) {
    const result = ring.resolve(sequence, 3000);
    assert.equal(result.status, 'invalid_sequence'); assert.equal(result.counter, null); assert.equal(result.ageMs, null);
  }
  for (const clock of [-1, 0, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '3000', true, null, undefined, 1n]) {
    const result = ring.resolve(1, clock);
    assert.equal(result.status, 'invalid_clock'); assert.equal(result.snapshotAt, null); assert.equal(result.ageMs, null);
  }
  assert.deepEqual(ring.resolve(1, 1999), { status: 'negative_age', counter: null, drawAt: null,
    snapshotAt: 1999, ageMs: null, retainedEntries: 1 });
});

test('returned metadata is detached and contains no IDs, pixels or arbitrary values', () => {
  const ring = createSourceAgeRing(); ring.record(1, 1000, 'private');
  const result = ring.resolve(1, 1100);
  assert.deepEqual(Object.keys(result).sort(), ['ageMs', 'counter', 'drawAt', 'retainedEntries', 'snapshotAt', 'status']);
  result.drawAt = 1; result.counter = 2; result.ageMs = 999;
  assert.equal(ring.resolve(1, 1100).ageMs, 100);
  const summary = ring.snapshot(); summary.size = 0;
  assert.equal(ring.snapshot().size, 1);
});

test('serialized ring runs with browser builtins and no Node or module state', () => {
  const ring = vm.runInNewContext('(' + createSourceAgeRing.toString() + ')()', Object.create(null));
  assert.equal(ring.record(65536, 1000.25), true);
  assert.equal(ring.resolve(0, 1020.75).ageMs, 20.5);
  assert.equal(JSON.stringify(ring.snapshot()), JSON.stringify({ capacity: 4096, size: 1 }));
});

test('source-age IPC sanitizer keeps only fixed metadata and exact nonnegative elapsed age', () => {
  const value = { status: 'matched', counter: 65536, drawAt: 1793199000000.125,
    snapshotAt: 1793199000120.375, ageMs: 120.25, retainedEntries: 1 };
  const safe = safeSourceAgeObservation({ ...value, requestId: 'private', pixels: [1, 2], sourceId: 'private' });
  assert.deepEqual(safe, value); assert.notEqual(safe, value);
  const invalid = { status: 'invalid_record', counter: null, drawAt: null, snapshotAt: null, ageMs: null, retainedEntries: 0 };
  for (const item of [null, undefined, {}, [], { ...value, status: 'private/url?token=secret' },
    { ...value, retainedEntries: -1 }, { ...value, retainedEntries: 4097 }, { ...value, retainedEntries: 1.5 },
    { ...value, retainedEntries: '1' }, { ...value, counter: -1 }, { ...value, counter: 1.5 },
    { ...value, counter: Number.MAX_SAFE_INTEGER + 1 }, { ...value, counter: '65536' },
    { ...value, ageMs: 120.5 }, { ...value, ageMs: -1 }, { ...value, ageMs: NaN },
    { ...value, ageMs: Infinity }, { ...value, ageMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...value, ageMs: '120.25' }]) assert.deepEqual(safeSourceAgeObservation(item), invalid);
  for (const field of ['drawAt', 'snapshotAt'])
    for (const clock of [-1, 0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1000', true, null, undefined])
      assert.deepEqual(safeSourceAgeObservation({ ...value, [field]: clock }), invalid);
  assert.deepEqual(safeSourceAgeObservation({ ...value, drawAt: value.snapshotAt, ageMs: 0 }), { ...value, drawAt: value.snapshotAt, ageMs: 0 });
});

test('source-age rejected statuses cannot smuggle a counter, draw clock, duration or IDs', () => {
  for (const status of ['invalid_sequence', 'invalid_clock', 'history_miss', 'ambiguous_sequence', 'negative_age']) {
    const safe = safeSourceAgeObservation({ status, counter: 'private', drawAt: 'private', snapshotAt: 2000.5,
      ageMs: 'private', retainedEntries: 4096, requestId: 'private' });
    assert.deepEqual(safe, { status, counter: null, drawAt: null, snapshotAt: 2000.5, ageMs: null, retainedEntries: 4096 });
    assert.equal(safeSourceAgeObservation({ ...safe, snapshotAt: 'private' }).snapshotAt, null);
  }
  const ring = createSourceAgeRing(); ring.record(1, 1000.25);
  for (const observation of [ring.resolve(1, 1100.5), ring.resolve(2, 1100.5), ring.resolve(1, 900),
    ring.resolve(-1, 1100.5), ring.resolve(1, NaN)]) assert.deepEqual(safeSourceAgeObservation(observation), observation);
});
