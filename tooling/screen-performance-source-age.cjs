'use strict';

function performanceSourceAgeEnabled(env = process.env) {
  const value = env.COVE_FPS_SOURCE_AGE;
  if (value !== undefined && value !== '0' && value !== '1') throw new Error('Invalid source-age option');
  return value === '1';
}

// This function is serialized into the test-owned source page. Keep it closed
// over only its own locals and browser builtins; no Node clock or module state.
function createSourceAgeRing() {
  const capacity = 4096, entries = new Array(capacity);
  let next = 0, size = 0;
  const validClock = value => Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
  function record(counter, drawAt) {
    if (!Number.isSafeInteger(counter) || counter < 0 || !validClock(drawAt)) return false;
    entries[next] = { counter, drawAt };
    next = (next + 1) % capacity;
    size = Math.min(size + 1, capacity);
    return true;
  }
  function resolve(capturedSequence, snapshotAt) {
    const result = { status: 'history_miss', counter: null, drawAt: null,
      snapshotAt: validClock(snapshotAt) ? snapshotAt : null, ageMs: null, retainedEntries: size };
    if (!Number.isInteger(capturedSequence) || capturedSequence < 0 || capturedSequence > 65535) {
      result.status = 'invalid_sequence'; return result;
    }
    if (!validClock(snapshotAt)) { result.status = 'invalid_clock'; return result; }
    let match = null;
    for (let index = 0; index < size; index++) {
      const entry = entries[index];
      if (entry.counter % 65536 !== capturedSequence) continue;
      if (match !== null) { result.status = 'ambiguous_sequence'; return result; }
      match = entry;
    }
    if (match === null) return result;
    const ageMs = snapshotAt - match.drawAt;
    if (!Number.isFinite(ageMs) || ageMs < 0) { result.status = 'negative_age'; return result; }
    return { ...result, status: 'matched', counter: match.counter, drawAt: match.drawAt, ageMs };
  }
  return { record, resolve, snapshot: () => ({ capacity, size }) };
}

function safeSourceAgeObservation(value) {
  const invalid = { status: 'invalid_record', counter: null, drawAt: null,
    snapshotAt: null, ageMs: null, retainedEntries: 0 };
  if (!value || !['matched', 'invalid_sequence', 'invalid_clock', 'history_miss',
    'ambiguous_sequence', 'negative_age'].includes(value.status) ||
    !Number.isSafeInteger(value.retainedEntries) || value.retainedEntries < 0 || value.retainedEntries > 4096) return invalid;
  const validClock = item => Number.isFinite(item) && item > 0 && item <= Number.MAX_SAFE_INTEGER;
  if (value.status !== 'matched') return { status: value.status, counter: null, drawAt: null,
    snapshotAt: validClock(value.snapshotAt) ? value.snapshotAt : null, ageMs: null, retainedEntries: value.retainedEntries };
  if (!Number.isSafeInteger(value.counter) || value.counter < 0 || !validClock(value.drawAt) || !validClock(value.snapshotAt) ||
    !Number.isFinite(value.ageMs) || value.ageMs < 0 || value.ageMs > Number.MAX_SAFE_INTEGER ||
    value.ageMs !== value.snapshotAt - value.drawAt) return invalid;
  return { status: 'matched', counter: value.counter, drawAt: value.drawAt,
    snapshotAt: value.snapshotAt, ageMs: value.ageMs, retainedEntries: value.retainedEntries };
}

module.exports = { performanceSourceAgeEnabled, createSourceAgeRing, safeSourceAgeObservation };
