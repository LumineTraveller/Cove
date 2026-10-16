import test from 'node:test';
import assert from 'node:assert/strict';
import { clearAccountSession, disconnectAccountSession, enrichRememberedLoginIdentities, forgetRememberedLogin, normalizeLoginServer, readAccountSession, readRememberedLogins, rememberAccountSession, validAccountEmail } from '../src/features/accounts/accountAuth';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test('account email validation matches the login form contract', () => {
  assert.equal(validAccountEmail('person@example.com'), true);
  assert.equal(validAccountEmail('not-an-email'), false);
});

test('remembered accounts survive switching servers without leaking tokens across hosts, ports or paths', () => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  const a = { serverUrl: 'https://ONE.test/', token: 'token-one', accountId: 'one', email: 'one@test.com', profile: { username: 'One', avatarUrl: null } };
  const b = { serverUrl: 'https://two.test', token: 'token-two', accountId: 'two', email: 'two@test.com', profile: { username: 'Two', avatarUrl: null } };
  rememberAccountSession(a); rememberAccountSession(b); disconnectAccountSession();
  assert.equal(readAccountSession(), null);
  assert.equal(readAccountSession('https://one.test')?.token, 'token-one');
  assert.equal(readAccountSession('https://two.test/')?.profile?.username, 'Two');
  assert.equal(readAccountSession('http://one.test'), null);
  assert.equal(readAccountSession('https://one.test:8443'), null);
  assert.equal(readAccountSession('https://one.test/other'), null);
  assert.equal(normalizeLoginServer('ftp://one.test'), '');
  assert.equal(normalizeLoginServer('https://user:secret@one.test'), '');
});

test('logout or expiry removes only that token and keeps address/email for refilling', () => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
  rememberAccountSession({ serverUrl: 'https://a.test', token: 'a-token', accountId: 'a', email: 'a@test.com' });
  rememberAccountSession({ serverUrl: 'https://b.test', token: 'b-token', accountId: 'b', email: 'b@test.com' });
  clearAccountSession('https://b.test');
  assert.equal(readAccountSession('https://b.test'), null);
  assert.equal(readRememberedLogins().find(entry => entry.serverUrl === 'https://b.test')?.email, 'b@test.com');
  assert.equal(readAccountSession('https://a.test')?.token, 'a-token');
  forgetRememberedLogin('https://a.test');
  assert.equal(readAccountSession('https://a.test'), null);
  assert.equal(readRememberedLogins().length, 1);
});

test('login persistence never serializes a password from caller input', () => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  const form = { serverUrl: 'https://a.test', token: 'a-token', accountId: 'a', email: 'a@test.com', password: 'must-not-persist' };
  rememberAccountSession(form);
  assert.equal(storage.getItem('cove_account_session')?.includes('must-not-persist'), false);
  assert.equal(storage.getItem('cove_remembered_logins')?.includes('must-not-persist'), false);
});

test('account sessions are scoped to their server and can be cleared', () => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  storage.setItem('cove_account_session', JSON.stringify({
    serverUrl: 'https://cove.example', token: 'token', accountId: 'account-id', email: 'person@example.com',
  }));
  assert.equal(readAccountSession('https://cove.example')?.accountId, 'account-id');
  assert.equal(readAccountSession('https://other.example'), null);
  clearAccountSession();
  assert.equal(readAccountSession(), null);
});

test('multiple accounts on one server retain distinct history and logout/forget affect only the selected account', () => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
  const a = { serverUrl: 'https://same.test', serverKey: 'same-key', token: 'token-a', accountId: 'a', email: 'a@test.com' };
  const b = { ...a, token: 'token-b', accountId: 'b', email: 'b@test.com' };
  rememberAccountSession(a); rememberAccountSession(b);
  assert.equal(readRememberedLogins().length, 2);
  clearAccountSession(b.serverUrl);
  assert.equal(readRememberedLogins().find(entry => entry.accountId === 'a')?.token, 'token-a');
  assert.equal(readRememberedLogins().find(entry => entry.accountId === 'b')?.token, undefined);
  forgetRememberedLogin(a.serverUrl, 'b');
  assert.deepEqual(readRememberedLogins().map(entry => entry.accountId), ['a']);
});

test('a late identity lookup cannot restore a cleared account token', async () => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let finishLookup!: (addresses: string[]) => void;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    coveSecurity: { resolveServerAddresses: () => new Promise<string[]>(resolve => { finishLookup = resolve; }) },
  } });
  try {
    rememberAccountSession({ serverUrl: 'https://late.test', token: 'synthetic-old-token', accountId: 'a', email: 'a@example.test' });
    const pending = enrichRememberedLoginIdentities();
    clearAccountSession('https://late.test');
    finishLookup(['192.0.2.10']);
    await pending;
    assert.equal(readAccountSession(), null);
    assert.equal(readAccountSession('https://late.test'), null);
    const [entry] = readRememberedLogins();
    assert.equal(entry?.token, undefined);
    assert.equal(entry?.serverKey, 'ip:192.0.2.10|443');
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('a late identity lookup preserves forgetting and the latest account order, token and profile', async () => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let finishLookup!: (addresses: string[]) => void;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    coveSecurity: { resolveServerAddresses: () => new Promise<string[]>(resolve => { finishLookup = resolve; }) },
  } });
  try {
    const surviving = { serverUrl: 'https://current.test', serverKey: 'current-key', token: 'synthetic-old-token', accountId: 'b', email: 'b@example.test', profile: { username: 'Old', avatarUrl: null } };
    rememberAccountSession(surviving);
    rememberAccountSession({ serverUrl: 'https://forgotten.test', token: 'synthetic-forgotten-token', accountId: 'a', email: 'a@example.test' });
    const pending = enrichRememberedLoginIdentities();
    forgetRememberedLogin('https://forgotten.test', 'a');
    rememberAccountSession({ ...surviving, token: 'synthetic-new-token', profile: { username: 'Current', avatarUrl: null } });
    rememberAccountSession({ serverUrl: 'https://new.test', serverKey: 'new-key', token: 'synthetic-new-account-token', accountId: 'c', email: 'c@example.test' });
    finishLookup(['192.0.2.11']);
    await pending;
    const entries = readRememberedLogins();
    assert.deepEqual(entries.map(entry => entry.accountId), ['c', 'b']);
    assert.equal(entries[1]?.token, 'synthetic-new-token');
    assert.equal(entries[1]?.profile?.username, 'Current');
    assert.equal(readAccountSession()?.accountId, 'c');
    assert.equal(readAccountSession('https://forgotten.test'), null);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('identity enrichment still deduplicates DNS aliases in their latest history order', async () => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    coveSecurity: { resolveServerAddresses: async () => ['192.0.2.12'] },
  } });
  try {
    rememberAccountSession({ serverUrl: 'https://alias-one.test', token: 'synthetic-first-token', accountId: 'a', email: 'a@example.test' });
    rememberAccountSession({ serverUrl: 'https://alias-two.test', token: 'synthetic-second-token', accountId: 'a', email: 'a@example.test' });
    const entries = await enrichRememberedLoginIdentities();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.serverUrl, 'https://alias-two.test');
    assert.equal(entries[0]?.token, 'synthetic-second-token');
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
