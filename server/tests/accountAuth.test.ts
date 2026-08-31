import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { derivePassword, passwordMatches, validEmail } from '../src/accountAuth';
import { createAccountStore } from '../src/accountAuth';

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

test('successful login replaces the old token; failed login and reconnect checks preserve it', async () => {
  const native = new DatabaseSync(':memory:');
  const db = {
    exec: (sql: string) => native.exec(sql),
    prepare: (sql: string) => native.prepare(sql),
    transaction: <T extends (...args: any[]) => any>(fn: T) => (...args: Parameters<T>) => {
      native.exec('BEGIN');
      try { const result = fn(...args); native.exec('COMMIT'); return result; }
      catch (error) { native.exec('ROLLBACK'); throw error; }
    },
  } as unknown as Parameters<typeof createAccountStore>[0];
  const auth = createAccountStore(db);
  const first = await auth.register('person@example.com', 'password-123', 'Person');
  assert.equal(auth.accountForToken(first.token)?.id, first.account.id);
  assert.equal(auth.accountForToken(first.token)?.id, first.account.id);
  await assert.rejects(() => auth.login('person@example.com', 'wrong-password'));
  assert.equal(auth.accountForToken(first.token)?.id, first.account.id);
  const second = await auth.login('person@example.com', 'password-123');
  assert.equal(auth.accountForToken(first.token), null);
  assert.equal(auth.accountForToken(second.token)?.id, first.account.id);
  native.close();
});

test('account session migration keeps only the newest legacy token', () => {
  const native = new DatabaseSync(':memory:');
  const hash = (token: string) => createHash('sha256').update(token).digest('hex');
  native.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE, passwordHash TEXT, passwordSalt TEXT, username TEXT, avatarUrl TEXT, createdAt INTEGER);
    CREATE TABLE account_sessions (tokenHash TEXT PRIMARY KEY, accountId TEXT, expiresAt INTEGER, createdAt INTEGER);
    INSERT INTO accounts VALUES ('a1', 'legacy@example.com', '00', '00', 'Legacy', NULL, 1);
  `);
  const insert = native.prepare('INSERT INTO account_sessions VALUES (?, ?, ?, ?)');
  insert.run(hash('old-token-abcdefghijklmnopqrstuvwxyz'), 'a1', Date.now() + 60_000, 10);
  insert.run(hash('new-token-abcdefghijklmnopqrstuvwxyz'), 'a1', Date.now() + 60_000, 20);
  const db = {
    exec: (sql: string) => native.exec(sql),
    prepare: (sql: string) => native.prepare(sql),
    transaction: <T extends (...args: any[]) => any>(fn: T) => (...args: Parameters<T>) => fn(...args),
  } as unknown as Parameters<typeof createAccountStore>[0];
  const auth = createAccountStore(db);
  assert.equal(auth.accountForToken('old-token-abcdefghijklmnopqrstuvwxyz'), null);
  assert.equal(auth.accountForToken('new-token-abcdefghijklmnopqrstuvwxyz')?.id, 'a1');
  assert.equal(native.prepare('SELECT COUNT(*) AS count FROM account_sessions').get().count, 1);
  native.close();
});
