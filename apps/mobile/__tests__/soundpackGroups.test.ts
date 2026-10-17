import {addGroup, applySoundpackOrder, canAddGroup, flattenGroups, groupsStorageKey, moveSound, orderedGroups, readGroups, reconcileGroups, swapGroups} from '../src/features/soundpacks/soundpackGroups';

test('old or corrupt installations retain one server-ordered group', () => {
  expect(readGroups(null)).toEqual([{id: 'default', soundIds: []}]);
  expect(readGroups({version: 2, groups: []})).toEqual(readGroups(null));
  expect(reconcileGroups(readGroups(null), ['c', 'a'])).toEqual([{id: 'default', soundIds: ['c', 'a']}]);
});
test('groups and sounds are deduplicated and malformed entries are rejected', () => {
  expect(readGroups({version: 1, groups: [{id: 'a', soundIds: ['1', '1', 2]}, {id: 'a', soundIds: ['2']}, {id: 'b', soundIds: ['1', '2']}, null]}))
    .toEqual([{id: 'a', soundIds: ['1']}, {id: 'b', soundIds: ['2']}]);
});
test('deleted sounds vanish, new sounds go first and empty groups survive', () => {
  expect(reconcileGroups([{id: 'a', soundIds: ['gone', '1']}, {id: 'b', soundIds: []}], ['2', '1']))
    .toEqual([{id: 'a', soundIds: ['2', '1']}, {id: 'b', soundIds: []}]);
});
test('adding is disabled until every group contains a sound', () => {
  const groups = [{id: 'a', soundIds: ['1']}];
  expect(canAddGroup(groups)).toBe(true);
  expect(addGroup(groups, 'b')).toEqual([...groups, {id: 'b', soundIds: []}]);
  expect(addGroup(addGroup(groups, 'b'), 'c')).toHaveLength(2);
});
test('touch equivalents move within and across groups and exchange dividers', () => {
  const groups = [{id: 'a', soundIds: ['1', '2']}, {id: 'b', soundIds: ['3']}];
  expect(flattenGroups(moveSound(groups, '1', 'a', 1))).toEqual(['2', '1', '3']);
  expect(moveSound(groups, '2', 'b', 99)[1].soundIds).toEqual(['3', '2']);
  expect(flattenGroups(swapGroups(groups, 'a', 'b'))).toEqual(['3', '1', '2']);
  expect(moveSound(groups, 'missing', 'a', 1)).toEqual(groups);
});
test('authoritative order preserves membership and leaves concurrent new sounds', () => {
  expect(applySoundpackOrder([{id: '1'}, {id: 'new'}, {id: '2'}], ['2', '2', 'gone', '1'])).toEqual([{id: '2'}, {id: '1'}, {id: 'new'}]);
  expect(orderedGroups([{id: 'a', soundIds: ['1', '2']}, {id: 'b', soundIds: ['3']}], ['3', '2', '1']))
    .toEqual([{id: 'a', soundIds: ['2', '1']}, {id: 'b', soundIds: ['3']}]);
});
test('preferences isolate account, origin and server path while normalizing trailing slashes', () => {
  expect(groupsStorageKey('http://example.test/cove/', 'alice', 'room-a')).toBe(groupsStorageKey('http://example.test/cove', 'alice', 'room-a'));
  expect(groupsStorageKey('http://example.test/cove', 'alice', 'room-a')).not.toBe(groupsStorageKey('http://example.test/cove', 'bob', 'room-a'));
  expect(groupsStorageKey('http://example.test/a', 'alice', 'room-a')).not.toBe(groupsStorageKey('http://example.test/b', 'alice', 'room-a'));
});

test('rooms have independent v2 preference keys and never alias the old global keys', () => {
  const first = groupsStorageKey('https://example.test/cove', 'alice', 'room-a');
  expect(first).not.toBe(groupsStorageKey('https://example.test/cove', 'alice', 'room-b'));
  expect(first).toContain('soundpack-groups:v2:');
  expect(first).not.toContain('soundpack-groups:v1:');
});
