import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePassword, passwordMatches, validEmail } from '../src/accountAuth';

test('validEmail accepts ordinary addresses and rejects malformed values', () => {
  assert.equal(validEmail('person@example.com'), true);
  assert.equal(validEmail('not-an-email'), false);
  assert.equal(validEmail('a@b'), false);
});

test('password derivation is salted and can be verified', async () => {
  const password = 'correct horse battery staple';
  const saltA = '0123456789abcdef0123456789abcdef';
  const saltB = 'fedcba9876543210fedcba9876543210';
  const hashA = (await derivePassword(password, saltA)).toString('hex');
  const hashB = (await derivePassword(password, saltB)).toString('hex');
  assert.notEqual(hashA, password);
  assert.notEqual(hashA, hashB);
  assert.equal(await passwordMatches(password, saltA, hashA), true);
  assert.equal(await passwordMatches('wrong password', saltA, hashA), false);
});
