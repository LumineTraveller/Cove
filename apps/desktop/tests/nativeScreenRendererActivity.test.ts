import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireNativeScreenRendererActivity, type NativeScreenRendererActivityTarget } from '../electron/native-screen-renderer-activity';

function target(previous = true) {
  let policy = previous, destroyed = false, gets = 0;
  const writes: boolean[] = [];
  return {
    isDestroyed: () => destroyed,
    getBackgroundThrottling() { gets++; return policy; },
    setBackgroundThrottling(value: boolean) { writes.push(value); policy = value; },
    get policy() { return policy; }, get gets() { return gets; }, writes,
    destroy() { destroyed = true; },
  };
}

test('renderer activity restores the original policy after the final overlapping lease only', () => {
  const owner = target(), one = acquireNativeScreenRendererActivity(owner)!, two = acquireNativeScreenRendererActivity(owner)!;
  assert.equal(owner.policy, false); assert.equal(owner.gets, 1); assert.deepEqual(owner.writes, [false]);
  one(); one(); assert.equal(owner.policy, false);
  two(); two(); assert.equal(owner.policy, true); assert.deepEqual(owner.writes, [false, true]);
});

test('a stale release cannot restore over a successor, and targets have independent baselines', () => {
  const owner = target(), other = target();
  const old = acquireNativeScreenRendererActivity(owner)!; old();
  const current = acquireNativeScreenRendererActivity(owner)!, independent = acquireNativeScreenRendererActivity(other)!;
  old(); independent(); assert.equal(owner.policy, false); assert.equal(other.policy, true);
  current(); assert.equal(owner.policy, true); assert.deepEqual(owner.writes, [false, true, false, true]);
});

test('a pre-existing unthrottled policy remains unchanged', () => {
  const owner = target(false), release = acquireNativeScreenRendererActivity(owner)!;
  release(); release(); assert.equal(owner.policy, false); assert.deepEqual(owner.writes, []);
});

test('destroyed targets are never read or restored', () => {
  const before = target(); before.destroy();
  assert.equal(acquireNativeScreenRendererActivity(before), undefined); assert.equal(before.gets, 0);
  const after = target(), release = acquireNativeScreenRendererActivity(after)!; after.destroy();
  release(); assert.deepEqual(after.writes, [false]);
});

test('missing, throwing or nonboolean getters never mutate policy', () => {
  let writes = 0;
  const setBackgroundThrottling = () => { writes++; };
  for (const owner of [{}, { setBackgroundThrottling }, { getBackgroundThrottling: () => true },
    { getBackgroundThrottling() { throw Error('getter'); }, setBackgroundThrottling },
    { getBackgroundThrottling: () => 'true', setBackgroundThrottling },
    { isDestroyed() { throw Error('destroyed getter'); }, getBackgroundThrottling: () => true, setBackgroundThrottling }]) {
    assert.equal(acquireNativeScreenRendererActivity(owner as NativeScreenRendererActivityTarget), undefined);
  }
  assert.equal(writes, 0);
});

test('a partially applied throwing setter retains its baseline for safe final restoration', () => {
  const owner = target(), original = owner.setBackgroundThrottling;
  owner.setBackgroundThrottling = value => { original(value); if (!value) throw Error('partially applied'); };
  const release = acquireNativeScreenRendererActivity(owner)!;
  assert.equal(owner.policy, false); assert.doesNotThrow(release); assert.equal(owner.policy, true);
});

test('restoration failures are contained and do not poison the next lease', () => {
  const owner = target(), original = owner.setBackgroundThrottling;
  owner.setBackgroundThrottling = value => { original(value); if (value) throw Error('restore'); };
  const release = acquireNativeScreenRendererActivity(owner)!;
  assert.doesNotThrow(release); assert.equal(owner.policy, true);
  const next = acquireNativeScreenRendererActivity(owner)!;
  assert.equal(owner.policy, false); assert.doesNotThrow(next); assert.equal(owner.policy, true);
});
