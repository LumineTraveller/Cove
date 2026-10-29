import test from 'node:test';
import assert from 'node:assert/strict';
import { reuseAudioMeterLevels } from '../src/features/media/audio/audioMeterLevels';

test('empty or exactly equal levels preserve the previous state identity', () => {
  const empty = Object.freeze({});
  assert.equal(reuseAudioMeterLevels(empty, {}), empty);
  const previous = Object.freeze({ alice: 0, bob: 0.25 });
  assert.equal(reuseAudioMeterLevels(previous, { bob: 0.25, alice: 0 }), previous);
});

test('adding, deleting or replacing an own key publishes the new state', () => {
  const previous = Object.freeze({ alice: 0, bob: 0.25 });
  const replacements: Record<string, number>[] = [
    { alice: 0 }, { alice: 0, bob: 0.25, charlie: 0 }, { alice: 0, charlie: 0.25 }, {},
  ];
  for (const next of replacements) {
    assert.equal(reuseAudioMeterLevels(previous, next), next);
  }
});

test('every exact value change is published without thresholds or quantization', () => {
  const previous = Object.freeze({ alice: 0 });
  for (const next of [{ alice: Number.EPSILON }, { alice: -0 }, { alice: 1 }]) {
    assert.equal(reuseAudioMeterLevels(previous, next), next);
  }
  const nan = Object.freeze({ alice: Number.NaN });
  assert.equal(reuseAudioMeterLevels(nan, { alice: Number.NaN }), nan);
});

test('comparison does not mutate either state and never treats inherited keys as own keys', () => {
  const previous = Object.freeze({ alice: 0.4 });
  const equal = Object.freeze({ alice: 0.4 });
  assert.equal(reuseAudioMeterLevels(previous, equal), previous);
  assert.deepEqual(previous, { alice: 0.4 });
  assert.deepEqual(equal, { alice: 0.4 });
  const inherited = Object.assign(Object.create({ bob: 0.2 }), { alice: 0.4 });
  const replacement = Object.freeze({ bob: 0.2 });
  assert.equal(reuseAudioMeterLevels(inherited, replacement), replacement);
});

test('the updater compares the latest supplied state rather than a captured snapshot', () => {
  const target = Object.freeze({ alice: 0.4 });
  const update = (previous: Record<string, number>) => reuseAudioMeterLevels(previous, target);
  const latestSame = Object.freeze({ alice: 0.4 });
  assert.equal(update(latestSame), latestSame);
  assert.equal(update({ alice: 0.5 }), target);
});
