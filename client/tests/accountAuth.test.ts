import test from 'node:test';
import assert from 'node:assert/strict';
import { clearAccountSession, readAccountSession, validAccountEmail } from '../src/accountAuth';

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

