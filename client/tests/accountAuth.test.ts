import test from 'node:test';
import assert from 'node:assert/strict';
import { clearAccountSession, disconnectAccountSession, forgetRememberedLogin, normalizeLoginServer, readAccountSession, readRememberedLogins, rememberAccountSession, validAccountEmail } from '../src/accountAuth';

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
