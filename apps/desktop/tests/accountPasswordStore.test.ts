import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountPasswordStore, accountPasswordScope, type PasswordEncryption } from '../electron/account-password-store';
import { registerAccountPasswordIpc } from '../electron/account-password-ipc';

const server = 'https://memory.example.test';
const email = 'account@example.test';
const password = 'fictional-account-password';
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'cove-password-unit-'));
  const file = path.join(directory, 'account-passwords.v1.json');
  const key = randomBytes(32);
  const encryption: PasswordEncryption = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const payload = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), payload]);
    },
    decryptString: value => {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
  return { file, encryption, store: new AccountPasswordStore(file, encryption, 'win32'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('scopes normalize case/default ports and isolate protocol, host, port, path and account', () => {
  const scope = accountPasswordScope(server, email);
  assert.equal(scope, accountPasswordScope(' HTTPS://MEMORY.EXAMPLE.TEST:443/ ', ' ACCOUNT@EXAMPLE.TEST '));
  for (const [url, account] of [[server.replace('https:', 'http:'), email], [server + ':8443', email], [server + '/other', email], ['https://other.example.test', email], [server, 'other@example.test']]) {
    assert.notEqual(accountPasswordScope(url, account), scope);
  }
  for (const url of ['not-a-url', 'ftp://memory.example.test', 'https://user:pass@memory.example.test', server + '?q=1', server + '#fragment']) assert.equal(accountPasswordScope(url, email), null);
  assert.equal(accountPasswordScope(server, 'invalid-email'), null);
});

test('roundtrip writes ciphertext only, retains independent accounts and supports removal/clear', () => {
  const f = fixture();
  try {
    assert.equal(f.store.get(server, email).password, null);
    assert.equal(f.store.set(server, email, password).ok, true);
    assert.equal(f.store.set(server, 'other@example.test', 'other-fictional-password').ok, true);
    const raw = readFileSync(f.file, 'utf8');
    assert.equal(raw.includes(password), false);
    assert.equal(raw.includes(email), false);
    assert.equal(f.store.get(server, email).password, password);
    assert.equal(f.store.get(server + '/other', email).password, null);
    assert.equal(f.store.remove(server, email).ok, true);
    assert.equal(f.store.get(server, email).password, null);
    assert.equal(f.store.get(server, 'other@example.test').password, 'other-fictional-password');
    assert.equal(f.store.clear().ok, true);
    assert.equal(existsSync(f.file), false);
  } finally { f.cleanup(); }
});

test('unavailable crypto and Linux plaintext/unknown backends never save', () => {
  const f = fixture();
  try {
    f.encryption.isEncryptionAvailable = () => false;
    assert.equal(f.store.set(server, email, password).ok, false);
    assert.equal(existsSync(f.file), false);
    f.encryption.isEncryptionAvailable = () => true;
    for (const backend of ['basic_text', 'unknown', '']) {
      f.encryption.getSelectedStorageBackend = () => backend;
      assert.deepEqual(new AccountPasswordStore(f.file, f.encryption, 'linux').status(), { available: false, ok: false });
    }
  } finally { f.cleanup(); }
});

test('encryption failure and invalid input preserve a previously valid credential', () => {
  const f = fixture();
  try {
    f.store.set(server, email, password);
    const previous = readFileSync(f.file, 'utf8');
    f.encryption.encryptString = () => { throw new Error('Synthetic encryption failure'); };
    assert.equal(f.store.set(server, email, 'new-fictional-password').ok, false);
    assert.equal(f.store.set(server, email, 'short').ok, false);
    assert.equal(readFileSync(f.file, 'utf8'), previous);
    assert.equal(f.store.get(server, email).password, password);
    f.encryption.isEncryptionAvailable = () => false;
    assert.equal(f.store.remove(server, email).ok, true);
    assert.equal(Object.keys(JSON.parse(readFileSync(f.file, 'utf8')).entries).length, 0);
  } finally { f.cleanup(); }
});

test('swapped/tampered ciphertext is rejected and damaged storage is not overwritten', () => {
  const f = fixture();
  try {
    f.store.set(server, email, password);
    const record = JSON.parse(readFileSync(f.file, 'utf8'));
    record.entries[accountPasswordScope(server, 'other@example.test')!] = record.entries[accountPasswordScope(server, email)!];
    writeFileSync(f.file, JSON.stringify(record));
    assert.equal(f.store.get(server, 'other@example.test').ok, false);
    record.entries[accountPasswordScope(server, email)!] = Buffer.from('corrupted').toString('base64');
    writeFileSync(f.file, JSON.stringify(record));
    assert.equal(f.store.get(server, email).ok, false);
    writeFileSync(f.file, '{damaged');
    assert.equal(f.store.set(server, email, password).ok, false);
    assert.equal(readFileSync(f.file, 'utf8'), '{damaged');
    assert.equal(f.store.clear().ok, true);
  } finally { f.cleanup(); }
});

test('IPC rejects untrusted windows and frames before reading or mutating credentials', () => {
  const f = fixture();
  try {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const trusted = { id: 'main-frame' };
    registerAccountPasswordIpc({ handle: (name, handler) => handlers.set(name, handler) } as any, f.store, event => event === trusted);
    for (const handler of handlers.values()) assert.deepEqual(handler({}, server, email, password), { available: false, ok: false });
    assert.equal(existsSync(f.file), false);
    assert.deepEqual(handlers.get('cove:account-password:set')!(trusted, server, email, password), { available: true, ok: true });
    assert.equal((handlers.get('cove:account-password:get')!(trusted, server, email) as { password: string }).password, password);
    assert.equal(handlers.size, 5);
  } finally { f.cleanup(); }
});
