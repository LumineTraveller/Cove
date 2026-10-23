import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCompleteSoundpackOrder, orderSoundpacks, reconcilePersonalSoundpackGroups } from '../src/soundpackOrdering';

test('independent personal layouts share content membership without inheriting snapshot rank', () => {
  const alice = [{ id: 'one', soundIds: ['b', 'a'] }, { id: 'two', soundIds: ['c'] }];
  const bob = [{ id: 'default', soundIds: ['c', 'a', 'b'] }];
  const content = ['c', 'new', 'b'];
  assert.deepEqual(reconcilePersonalSoundpackGroups(alice, content), [
    { id: 'one', soundIds: ['b', 'new'] }, { id: 'two', soundIds: ['c'] },
  ]);
  assert.deepEqual(reconcilePersonalSoundpackGroups(bob, content), [{ id: 'default', soundIds: ['c', 'b', 'new'] }]);
  assert.deepEqual(alice[0].soundIds, ['b', 'a']);
  assert.deepEqual(bob[0].soundIds, ['c', 'a', 'b']);
});

test('first snapshot seeds an empty installation and duplicate content IDs cannot create duplicate cards', () => {
  assert.deepEqual(reconcilePersonalSoundpackGroups([], ['b', 'a', 'b']), [{ id: 'default', soundIds: ['b', 'a'] }]);
  assert.deepEqual(reconcilePersonalSoundpackGroups([{ id: 'one', soundIds: ['a', 'a'] }, { id: 'empty', soundIds: [] }], []), [
    { id: 'one', soundIds: [] }, { id: 'empty', soundIds: [] },
  ]);
});

test('local validation supports complete large layouts and rejects duplicates, missing and foreign sounds', () => {
  const ids = Array.from({ length: 1201 }, (_, index) => String(index));
  const personal = [...ids].reverse();
  assert.equal(isCompleteSoundpackOrder(personal, ids), true);
  assert.equal(isCompleteSoundpackOrder([...personal.slice(1), personal[1]], ids), false);
  assert.equal(isCompleteSoundpackOrder(personal.slice(1), ids), false);
  assert.equal(isCompleteSoundpackOrder(['foreign', ...personal.slice(1)], ids), false);
  assert.deepEqual(orderSoundpacks(ids.map(id => ({ id })), personal).map(pack => pack.id), personal);
});
