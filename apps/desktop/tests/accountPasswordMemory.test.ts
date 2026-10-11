import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordMemoryStatus, readAccountPassword, saveAuthenticatedAccountPassword, removeAccountPassword, clearAccountPasswords } from '../src/features/accounts/accountPasswordMemory';

test('renderer only sends normalized account scopes and explicitly remembered successful passwords', async () => {
  const calls: unknown[][] = [];
  const ok = async (...args: unknown[]) => { calls.push(args); return { available: true, ok: true }; };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { coveAccountPasswords: { status: ok, get: ok, set: ok, remove: ok, clear: ok } } });
  await saveAuthenticatedAccountPassword('HTTPS://HOST.TEST:443/', ' ALICE@TEST.COM ', 'fictional-password', false);
  assert.equal(calls.length, 0);
  await saveAuthenticatedAccountPassword('HTTPS://HOST.TEST:443/', ' ALICE@TEST.COM ', 'fictional-password', true);
  assert.deepEqual(calls.pop(), ['https://host.test', 'alice@test.com', 'fictional-password']);
  await readAccountPassword('https://host.test/', ' ALICE@TEST.COM ');
  assert.deepEqual(calls.pop(), ['https://host.test', 'alice@test.com']);
  await removeAccountPassword('https://host.test/', ' ALICE@TEST.COM ');
  assert.deepEqual(calls.pop(), ['https://host.test', 'alice@test.com']);
  await clearAccountPasswords(); assert.deepEqual(calls.pop(), []);
});

test('web mode and rejected IPC remain usable without a plaintext fallback', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  assert.equal((await passwordMemoryStatus()).available, false);
  assert.equal((await readAccountPassword('https://host.test', 'a@test.com')).ok, false);
  assert.equal((await saveAuthenticatedAccountPassword('https://host.test', 'a@test.com', 'fictional-password', true)).ok, false);
  assert.equal((await removeAccountPassword('https://host.test', 'a@test.com')).ok, true);
  assert.equal((await clearAccountPasswords()).ok, true);
  window.coveAccountPasswords = { status: async () => { throw new Error('Synthetic unavailable'); } } as any;
  assert.equal((await passwordMemoryStatus()).available, false);
});
