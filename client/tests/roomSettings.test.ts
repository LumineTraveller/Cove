import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomPayload, parseMaxMembers, updateRoomPayload, validRoomPassword } from '../src/roomSettings';

test('room limits accept unlimited and integer range only', () => {
  assert.equal(parseMaxMembers(''), null);
  assert.equal(parseMaxMembers('1000'), 1000);
  assert.ok(Number.isNaN(parseMaxMembers('0')));
  assert.ok(Number.isNaN(parseMaxMembers('1.5')));
});

test('create preserves password bytes but omits blank passwords', () => {
  assert.equal(validRoomPassword('  secret  '), true);
  assert.equal(validRoomPassword('   '), false);
  assert.deepEqual(createRoomPayload(' x ', '20', '  secret  '), { name: 'x', maxMembers: 20, password: '  secret  ' });
  assert.equal(createRoomPayload('x', '', '').password, undefined);
  assert.throws(() => createRoomPayload('x', '1001', ''), /人数上限/);
  assert.throws(() => createRoomPayload('x', '5', '   '), /密码/);
});

test('update distinguishes omitted, null, and new password', () => {
  assert.equal(updateRoomPayload('r', '5', 'keep', '').password, undefined);
  assert.equal(updateRoomPayload('r', '', 'clear', '').password, null);
  assert.equal(updateRoomPayload('r', '10', 'set', 'new').password, 'new');
  assert.throws(() => updateRoomPayload('r', '0', 'keep', ''), /人数上限/);
  assert.throws(() => updateRoomPayload('r', '5', 'set', '   '), /密码/);
});
