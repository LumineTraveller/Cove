import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addSoundpackGroup, canAddSoundpackGroup, flattenSoundpackGroups, moveSoundpackToGroup, readSoundpackGroups, reconcileSoundpackGroups, resolveSoundpackDrop, soundpackGroupsStorageKey, swapSoundpackGroups, type SoundpackGroupGeometry } from '../src/features/soundpacks/soundpackGroups';

const groups = [{ id: 'default', soundIds: ['a', 'b', 'c', 'd', 'e', 'f'] }, { id: 'second', soundIds: ['g'] }];
const geometry: SoundpackGroupGeometry[] = [
  { id: 'default', top: 0, left: 0, width: 320, height: 170, rows: groups[0].soundIds.map((id, index) => ({ id, left: index % 3 * 110, top: Math.floor(index / 3) * 90, width: 100, height: 80 })) },
  { id: 'second', top: 180, left: 0, width: 320, height: 120, rows: [{ id: 'g', left: 0, top: 220, width: 100, height: 80 }] },
];

test('legacy and malformed settings migrate to one group in existing server order', () => {
  for (const value of [null, {}, { version: 2, groups }, { version: 1, groups: [] }]) {
    assert.deepEqual(reconcileSoundpackGroups(readSoundpackGroups(value), ['b', 'a']), [{ id: 'default', soundIds: ['b', 'a'] }]);
  }
  assert.deepEqual(readSoundpackGroups({ version: 1, groups: [{ id: 'one', soundIds: ['a', 'a', 1] }, { id: 'one', soundIds: ['b'] }, { id: 'empty', soundIds: [] }, { id: 'two', soundIds: ['a', 'b'] }] }), [{ id: 'one', soundIds: ['a'] }, { id: 'empty', soundIds: [] }, { id: 'two', soundIds: ['b'] }]);
});

test('scope keys separate accounts and servers and ignore a trailing slash', () => {
  assert.equal(soundpackGroupsStorageKey('https://example.com/', 'one'), soundpackGroupsStorageKey('https://example.com', 'one'));
  assert.notEqual(soundpackGroupsStorageKey('https://example.com', 'one'), soundpackGroupsStorageKey('https://example.com', 'two'));
  assert.notEqual(soundpackGroupsStorageKey('https://example.com', 'one'), soundpackGroupsStorageKey('https://other.example', 'one'));
});

test('reconciliation adds new sounds to first group while retaining order and empty groups', () => {
  const previous = [{ id: 'default', soundIds: ['c', 'a'] }, { id: 'second', soundIds: ['b'] }, { id: 'empty', soundIds: [] }];
  const next = reconcileSoundpackGroups(previous, ['new', 'a', 'c']);
  assert.deepEqual(next, [{ id: 'default', soundIds: ['new', 'c', 'a'] }, { id: 'second', soundIds: [] }, { id: 'empty', soundIds: [] }]);
  assert.deepEqual(previous[0].soundIds, ['c', 'a']);
});

test('last sound can leave a group, retaining empty group and blocking all further additions', () => {
  const next = moveSoundpackToGroup(groups, 'g', { groupId: 'default', index: 1 });
  assert.deepEqual(next[0].soundIds, ['a', 'g', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(next[1], { id: 'second', soundIds: [] });
  assert.equal(canAddSoundpackGroup(next), false);
  assert.deepEqual(addSoundpackGroup(next, 'third'), next);
  const restored = moveSoundpackToGroup(next, 'g', { groupId: 'second', index: 0 });
  assert.equal(canAddSoundpackGroup(restored), true);
  assert.deepEqual(addSoundpackGroup(restored, 'third')[2], { id: 'third', soundIds: [] });
  assert.equal(canAddSoundpackGroup([{ id: 'default', soundIds: [] }]), false);
});

test('divider swaps whole groups without changing sound order or deleting empty groups', () => {
  const withEmpty = [...groups, { id: 'empty', soundIds: [] }];
  assert.deepEqual(swapSoundpackGroups(withEmpty, 'empty', 'default'), [withEmpty[2], withEmpty[1], withEmpty[0]]);
  assert.deepEqual(flattenSoundpackGroups(swapSoundpackGroups(groups, 'second', 'default')), ['g', 'a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(groups[0].soundIds, ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('same-row hit matches neighbouring cell from either edge in both directions', () => {
  for (const x of [110, 111, 160, 209, 210]) {
    const target = resolveSoundpackDrop(geometry, 'default', 'a', x, 40)!;
    assert.deepEqual(target, { groupId: 'default', index: 1 });
    assert.deepEqual(moveSoundpackToGroup(groups, 'a', target)[0].soundIds, ['b', 'a', 'c', 'd', 'e', 'f']);
  }
  for (const x of [0, 1, 50, 99, 100]) assert.deepEqual(resolveSoundpackDrop(geometry, 'default', 'c', x, 40), { groupId: 'default', index: 0 });
});

test('wrapping, grid gaps, row edges and outside points resolve deterministic slots', () => {
  assert.deepEqual(resolveSoundpackDrop(geometry, 'default', 'a', 1, 91), { groupId: 'default', index: 3 });
  assert.deepEqual(resolveSoundpackDrop(geometry, 'default', 'd', 300, 1), { groupId: 'default', index: 2 });
  assert.deepEqual(resolveSoundpackDrop(geometry, 'default', 'a', 105, 40), { groupId: 'default', index: 0 });
  assert.deepEqual(resolveSoundpackDrop(geometry, 'default', 'a', 106, 40), { groupId: 'default', index: 1 });
  assert.deepEqual(resolveSoundpackDrop(geometry, 'default', 'a', -100, -10), { groupId: 'default', index: 0 });
  assert.deepEqual(resolveSoundpackDrop(geometry, 'default', 'a', 999, 130), { groupId: 'default', index: 5 });
});

test('cross-group insertion supports before, append and empty groups', () => {
  assert.deepEqual(resolveSoundpackDrop(geometry, 'default', 'a', 1, 230), { groupId: 'second', index: 0 });
  assert.deepEqual(resolveSoundpackDrop(geometry, 'default', 'a', 99, 230), { groupId: 'second', index: 1 });
  assert.deepEqual(resolveSoundpackDrop([...geometry, { id: 'empty', top: 310, left: 0, width: 320, height: 100, rows: [] }], 'default', 'a', 160, 350), { groupId: 'empty', index: 0 });
});

test('scrolled coordinates and persisted JSON produce identical hit and restarted state', () => {
  const target = resolveSoundpackDrop(geometry, 'default', 'a', 111, 130)!;
  const next = moveSoundpackToGroup(groups, 'a', target);
  assert.deepEqual(resolveSoundpackDrop(geometry, 'default', 'a', 111, 30 + 100), target);
  const restored = readSoundpackGroups(JSON.parse(JSON.stringify({ version: 1, groups: next })));
  assert.deepEqual(restored, next);
  assert.deepEqual(reconcileSoundpackGroups(restored, ['g', 'f', 'e', 'd', 'c', 'b', 'a']), next);
});
