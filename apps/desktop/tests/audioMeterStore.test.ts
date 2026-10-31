import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioMeterStore } from '../src/features/media/audio/audioMeterLevels';

test('snapshots are stable, immutable and independent from publisher inputs', () => {
  const store = createAudioMeterStore();
  const initial = store.getLevels('voice');
  assert.equal(store.getLevels('voice'), initial);
  store.publish({}, {});
  assert.equal(store.getLevels('voice'), initial);
  const input = { alice: 0.25 };
  store.publish(input, {});
  const snapshot = store.getLevels('voice');
  assert.notEqual(snapshot, input);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(input), false);
  input.alice = 0.75;
  assert.equal(store.getLevel('voice', 'alice'), 0.25);
  store.publish({ alice: 0.25 }, {});
  assert.equal(store.getLevels('voice'), snapshot);
  assert.equal(store.getLevel('voice', 'alice'), 0.25);
});

test('only subscribers of exactly changed own keys are notified', () => {
  const store = createAudioMeterStore();
  const calls = { alice: 0, bob: 0, shared: 0 };
  store.subscribe('voice', 'alice', () => calls.alice++);
  store.subscribe('voice', 'bob', () => calls.bob++);
  store.subscribe('shared', 'alice', () => calls.shared++);
  store.publish({ alice: 0 }, {});
  assert.deepEqual(calls, { alice: 1, bob: 0, shared: 0 });
  store.publish({ alice: Number.EPSILON }, {});
  assert.deepEqual(calls, { alice: 2, bob: 0, shared: 0 });
  store.publish({ alice: Number.EPSILON, bob: 0 }, { alice: 0.5 });
  assert.deepEqual(calls, { alice: 2, bob: 1, shared: 1 });
  store.publish({ bob: 0 }, { alice: 0.5 });
  assert.deepEqual(calls, { alice: 3, bob: 1, shared: 1 });
  store.publish({ bob: 0 }, { alice: 0.5 });
  assert.deepEqual(calls, { alice: 3, bob: 1, shared: 1 });
});

test('both channel snapshots are committed before one deduplicated callback runs', () => {
  const store = createAudioMeterStore();
  const observed: number[][] = [];
  const listener = () => observed.push([
    store.getLevel('voice', 'alice'),
    store.getLevel('voice', 'bob'),
    store.getLevel('shared', 'alice'),
  ]);
  store.subscribe('voice', 'alice', listener);
  store.subscribe('voice', 'bob', listener);
  store.subscribe('shared', 'alice', listener);
  store.publish({ alice: 0.25, bob: 0.5 }, { alice: 0.75 });
  assert.deepEqual(observed, [[0.25, 0.5, 0.75]]);
});

test('primary zero wins over fallback and missing keys produce zero', () => {
  const store = createAudioMeterStore();
  store.publish({ primary: 0, fallback: 0.75 }, {});
  assert.equal(store.getLevel('voice', 'primary', 'fallback'), 0);
  assert.equal(store.getLevel('voice', 'missing', 'fallback'), 0.75);
  assert.equal(store.getLevel('voice', 'missing'), 0);
  assert.equal(store.getLevel('shared', 'primary', 'fallback'), 0);
  store.publish({ fallback: 0.75 }, {});
  assert.equal(store.getLevel('voice', 'primary', 'fallback'), 0.75);
  // Prototype names must not masquerade as measured socket keys.
  assert.equal(store.getLevel('voice', 'toString', 'constructor'), 0);
  store.publish(Object.assign(Object.create({ inherited: 0.5 }), { own: 0.25 }), {});
  assert.equal(store.getLevel('voice', 'inherited'), 0);
  assert.equal(store.getLevel('voice', 'own'), 0.25);
});

test('key addition/removal notify even when both numeric snapshots would be zero', () => {
  const store = createAudioMeterStore();
  let calls = 0;
  store.subscribe('voice', 'primary', () => calls++);
  store.publish({ fallback: 0.5 }, {});
  assert.equal(calls, 0);
  store.publish({ primary: 0, fallback: 0.5 }, {});
  assert.equal(calls, 1);
  store.publish({ fallback: 0.5 }, {});
  assert.equal(calls, 2);
});

test('unsubscribe is idempotent and repeated callback subscriptions remain independent', () => {
  const store = createAudioMeterStore();
  let calls = 0;
  const listener = () => calls++;
  const first = store.subscribe('voice', 'alice', listener);
  const second = store.subscribe('voice', 'alice', listener);
  assert.equal(store.subscriptionCount(), 2);
  first();
  first();
  assert.equal(store.subscriptionCount(), 1);
  store.publish({ alice: 0.25 }, {});
  assert.equal(calls, 1);
  second();
  assert.equal(store.subscriptionCount(), 0);
  store.publish({ alice: 0.5 }, {});
  assert.equal(calls, 1);
  // Re-creating the same key subscription must work after the bucket empties.
  const third = store.subscribe('voice', 'alice', listener);
  store.publish({ alice: 0.75 }, {});
  assert.equal(calls, 2);
  third();
  store.clear();
  assert.equal(calls, 2);
  assert.equal(store.subscriptionCount(), 0);
});

test('clear publishes removals, preserves subscriptions and permits a later session', () => {
  const store = createAudioMeterStore();
  let calls = 0;
  const listener = () => calls++;
  const unsubscribeVoice = store.subscribe('voice', 'old-socket', listener);
  const unsubscribeShared = store.subscribe('shared', 'old-socket', listener);
  assert.equal(store.subscriptionCount(), 2);
  store.publish({ 'old-socket': 0.25 }, { 'old-socket': 0.5 });
  assert.equal(calls, 1);
  store.clear();
  assert.equal(calls, 2);
  assert.deepEqual(store.getLevels('voice'), {});
  assert.deepEqual(store.getLevels('shared'), {});
  assert.equal(store.subscriptionCount(), 2);
  store.clear();
  assert.equal(calls, 2);
  store.publish({ 'new-socket': 0.5 }, {});
  assert.equal(calls, 2);
  store.publish({ 'old-socket': 0.75 }, {});
  assert.equal(calls, 3);
  unsubscribeVoice();
  unsubscribeShared();
  assert.equal(store.subscriptionCount(), 0);
});

test('instances do not share levels, listeners or lifecycle', () => {
  const first = createAudioMeterStore();
  const second = createAudioMeterStore();
  let calls = 0;
  second.subscribe('voice', 'alice', () => calls++);
  first.publish({ alice: 0.25 }, {});
  assert.equal(second.getLevel('voice', 'alice'), 0);
  assert.equal(calls, 0);
  second.publish({ alice: 0.75 }, {});
  first.clear();
  assert.equal(second.getLevel('voice', 'alice'), 0.75);
  assert.equal(calls, 1);
});

test('exact Object.is semantics preserve NaN and distinguish signed zero', () => {
  const store = createAudioMeterStore();
  let calls = 0;
  store.subscribe('voice', 'alice', () => calls++);
  store.publish({ alice: Number.NaN }, {});
  const nanSnapshot = store.getLevels('voice');
  store.publish({ alice: Number.NaN }, {});
  assert.equal(store.getLevels('voice'), nanSnapshot);
  assert.equal(calls, 1);
  store.publish({ alice: 0 }, {});
  store.publish({ alice: -0 }, {});
  assert.equal(calls, 3);
  assert.equal(Object.is(store.getLevel('voice', 'alice'), -0), true);
});
