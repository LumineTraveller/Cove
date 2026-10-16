import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ServerAccessStore } from '../electron/server-access-store';
import { registerServerAccessIpc } from '../electron/server-access-ipc';
import type { PasswordEncryption } from '../electron/account-password-store';

const server = 'https://auth.example.test';
const email = 'fictional@example.test';
const fourteenDays = 14 * 24 * 60 * 60 * 1000;
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'cove-server-access-unit-'));
  const file = path.join(directory, 'server-access.v1.json');
  const key = randomBytes(32);
  let now = 1_800_000_000_000;
  const encryption: PasswordEncryption = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString: value => {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
  return { file, encryption, store: new ServerAccessStore(file, encryption, 'win32', () => now),
    now: () => now, setNow: (value: number) => { now = value; }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('OS ciphertext isolates exact server URL and account and survives a new store instance', () => {
  const f = fixture();
  try {
    const grant = { accessToken: 'fictional-server-grant', expiresAt: f.now() + fourteenDays };
    assert.equal(f.store.set(server, email, grant).ok, true);
    const raw = readFileSync(f.file, 'utf8');
    for (const secret of [grant.accessToken, email, server]) assert.equal(raw.includes(secret), false);
    const reopened = new ServerAccessStore(f.file, f.encryption, 'win32', f.now);
    assert.deepEqual(reopened.get('HTTPS://AUTH.EXAMPLE.TEST:443/', ' FICTIONAL@EXAMPLE.TEST ').grant, grant);
    for (const [url, account] of [[server + '/other', email], [server + ':8443', email],
      [server.replace('https:', 'http:'), email], ['https://alias.example.test', email], [server, 'other@example.test']]) {
      assert.equal(reopened.get(url, account).grant, null);
    }
  } finally { f.cleanup(); }
});

test('restoring and saving the same token never renew its fixed expiry', () => {
  const f = fixture();
  try {
    const issuedAt = f.now(), grant = { accessToken: 'fictional-fixed-grant', expiresAt: issuedAt + fourteenDays };
    f.store.set(server, email, grant);
    f.setNow(issuedAt + 7 * 24 * 60 * 60 * 1000);
    assert.deepEqual(f.store.get(server, email).grant, grant);
    assert.equal(f.store.set(server, email, { ...grant, expiresAt: f.now() + fourteenDays }).ok, true);
    assert.equal(f.store.get(server, email).grant?.expiresAt, grant.expiresAt);
    f.setNow(grant.expiresAt);
    assert.equal(f.store.get(server, email).grant, null);
  } finally { f.cleanup(); }
});

test('persisted clock watermark rejects rollback while tolerating small clock adjustments', () => {
  const f = fixture();
  try {
    const issuedAt = f.now();
    f.store.set(server, email, { accessToken: 'fictional-clock-grant', expiresAt: issuedAt + fourteenDays });
    f.setNow(issuedAt + 24 * 60 * 60 * 1000);
    assert.ok(f.store.get(server, email).grant);
    f.setNow(f.now() - 60_000);
    assert.ok(f.store.get(server, email).grant);
    f.setNow(issuedAt);
    assert.equal(new ServerAccessStore(f.file, f.encryption, 'win32', f.now).get(server, email).grant, null);
    f.setNow(issuedAt + 24 * 60 * 60 * 1000);
    assert.equal(f.store.get(server, email).grant, null, 'rollback removal must survive clock correction');
  } finally { f.cleanup(); }
});

test('removal scopes work without crypto and preserve other servers/accounts', () => {
  const f = fixture();
  try {
    const grant = { accessToken: 'fictional-remove-grant', expiresAt: f.now() + 60_000 };
    f.store.set(server, email, grant);
    f.store.set(server, 'other@example.test', grant);
    f.store.set(server + '/other', email, grant);
    f.store.remove(server, email);
    assert.equal(f.store.get(server, email).grant, null);
    assert.ok(f.store.get(server, 'other@example.test').grant);
    f.encryption.isEncryptionAvailable = () => false;
    assert.equal(f.store.remove(server).ok, true);
    f.encryption.isEncryptionAvailable = () => true;
    assert.equal(f.store.get(server, 'other@example.test').grant, null);
    assert.ok(f.store.get(server + '/other', email).grant);
    assert.equal(f.store.clear().ok, true);
    assert.equal(existsSync(f.file), false);
  } finally { f.cleanup(); }
});

test('unsafe crypto, malformed grants and swapped ciphertext fail closed', () => {
  const f = fixture();
  try {
    f.encryption.getSelectedStorageBackend = () => 'basic_text';
    assert.equal(new ServerAccessStore(f.file, f.encryption, 'linux', f.now).set(server, email,
      { accessToken: 'fictional-token', expiresAt: f.now() + 60_000 }).ok, false);
    assert.equal(existsSync(f.file), false);
    for (const expiresAt of [f.now(), Infinity, f.now() + fourteenDays * 2]) assert.equal(f.store.set(server, email,
      { accessToken: 'fictional-token', expiresAt }).ok, false);
    f.store.set(server, email, { accessToken: 'fictional-one', expiresAt: f.now() + 60_000 });
    f.store.set(server, 'other@example.test', { accessToken: 'fictional-two', expiresAt: f.now() + 60_000 });
    const data = JSON.parse(readFileSync(f.file, 'utf8')), scopes = Object.keys(data.entries);
    data.entries[scopes[1]] = data.entries[scopes[0]];
    writeFileSync(f.file, JSON.stringify(data));
    assert.equal(f.store.get(server, 'other@example.test').ok, false);
    assert.equal(f.store.get(server, email).grant?.accessToken, 'fictional-one');
  } finally { f.cleanup(); }
});

test('IPC rejects every untrusted frame before any store operation', () => {
  const f = fixture();
  try {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const trusted = { id: 'main-frame' };
    registerServerAccessIpc({ handle: (name, handler) => handlers.set(name, handler) } as any, f.store, event => event === trusted);
    for (const handler of handlers.values()) assert.deepEqual(handler({}, server, email,
      { accessToken: 'fictional-token', expiresAt: f.now() + 60_000 }), { available: false, ok: false });
    assert.equal(existsSync(f.file), false);
    assert.equal(handlers.size, 4);
  } finally { f.cleanup(); }
});
