import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartupLoginCheck } from '../src/features/accounts/startupLogin';

const account = { serverUrl: 'https://startup.test/cove', email: 'alice@example.test', accountId: 'synthetic-account', token: 'synthetic-account-token' };
test('startup reuses the remembered account and server grant; concurrent starts share one probe', async () => {
  let probes = 0, restores = 0;
  const check = createStartupLoginCheck({ restore: async () => { restores++; return true; }, status: async () => { probes++; return { enabled: true, authorized: true }; }, reject: async () => { assert.fail('valid grant was removed'); } });
  const first = check(account), second = check(account);
  assert.equal(first, second);
  assert.deepEqual(await Promise.all([first, second]), ['ready', 'ready']);
  assert.equal(probes, 1); assert.equal(restores, 1);
});
test('a network failure preserves credentials, stops, and allows a deliberate retry', async () => {
  let probes = 0, removed = 0;
  const check = createStartupLoginCheck({ restore: async () => true, status: async () => { probes++; throw new TypeError('synthetic offline'); }, reject: async () => { removed++; } });
  assert.equal(await check(account), 'offline');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(probes, 1); assert.equal(removed, 0);
  assert.equal(await check(account), 'offline'); assert.equal(probes, 2);
});
test('only an authoritative rejection removes the scoped grant and requests the server step', async () => {
  const removed: string[][] = [];
  const check = createStartupLoginCheck({ restore: async () => false, status: async () => ({ enabled: true, authorized: false }), reject: async (...scope) => { removed.push(scope); } });
  assert.equal(await check(account), 'server-required');
  assert.deepEqual(removed, [[account.serverUrl, account.email]]);
  assert.equal(await check(null), 'login');
});
test('password-free legacy servers retain account authentication without issuing a new grant', async () => {
  const check = createStartupLoginCheck({ restore: async () => false, status: async () => ({ enabled: false, authorized: false }), reject: async () => assert.fail() });
  assert.equal(await check(account), 'ready');
});
test('a hung probe is bounded and a late negative response cannot clear credentials', async () => {
  let complete!: (value: { enabled: boolean; authorized: boolean }) => void;
  const check = createStartupLoginCheck({ timeoutMs: 10, restore: async () => true, status: () => new Promise(resolve => { complete = resolve; }), reject: async () => assert.fail('late response removed credentials') });
  assert.equal(await check(account), 'offline');
  complete({ enabled: true, authorized: false });
  await new Promise(resolve => setTimeout(resolve, 0));
});
