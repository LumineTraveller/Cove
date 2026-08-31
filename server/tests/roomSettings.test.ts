import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomSettingsError,
  assertRoomCapacity,
  hashRoomPassword,
  parseRoomLimit,
  validateRoomPassword,
  verifyRoomPassword,
} from '../src/roomSettings';

test('parseRoomLimit accepts unlimited and inclusive integer bounds', () => {
  assert.equal(parseRoomLimit(undefined), null);
  assert.equal(parseRoomLimit(null), null);
  assert.equal(parseRoomLimit(1), 1);
  assert.equal(parseRoomLimit(1000), 1000);
  for (const value of [0, -1, 1.5, 1001, '10', true, {}, []])
    assert.throws(() => parseRoomLimit(value), RoomSettingsError);
});

test('validateRoomPassword preserves meaningful spaces and distinguishes undefined from null', () => {
  assert.equal(validateRoomPassword(undefined), undefined);
  assert.equal(validateRoomPassword(null), null);
  assert.equal(validateRoomPassword('  secret  '), '  secret  ');
  for (const value of ['', '   ', 'x'.repeat(129), 123, false, {}])
    assert.throws(() => validateRoomPassword(value), RoomSettingsError);
});

test('room password hashing is salted and verifies exact password', async () => {
  const first = await hashRoomPassword('  secret  ');
  const second = await hashRoomPassword('  secret  ');
  assert.notEqual(first.passwordSalt, second.passwordSalt);
  assert.notEqual(first.passwordHash, second.passwordHash);
  assert.equal(await verifyRoomPassword('  secret  ', first.passwordHash!, first.passwordSalt!), true);
  assert.equal(await verifyRoomPassword('secret', first.passwordHash!, first.passwordSalt!), false);
  assert.equal(await verifyRoomPassword('wrong', first.passwordHash!, first.passwordSalt!), false);
  assert.deepEqual(await hashRoomPassword(undefined), { passwordHash: null, passwordSalt: null });
  assert.deepEqual(await hashRoomPassword(null), { passwordHash: null, passwordSalt: null });
});

test('capacity allows existing members but rejects only new members when full', () => {
  const members = new Set(['a', 'b']);
  assert.doesNotThrow(() => assertRoomCapacity(members, 'a', 2));
  assert.throws(() => assertRoomCapacity(members, 'c', 2), /房间人数已满/);
  assert.doesNotThrow(() => assertRoomCapacity(members, 'c', null));
  assert.doesNotThrow(() => assertRoomCapacity(members, 'c', 3));
});
