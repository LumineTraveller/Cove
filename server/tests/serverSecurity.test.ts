import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  CLIENT_PROTOCOL_VERSION,
  createServerSecurityStore,
  isClientProtocolSupported,
  isServerSecurityEnabled,
  isLoopbackAddress,
  isSecureHttpRequest,
  isSecureSocket,
  readBearerToken,
  ServerSecurityError,
} from '../src/serverSecurity';

class TestDatabase {
  private readonly native: DatabaseSync;

  constructor() { this.native = new DatabaseSync(':memory:'); }

  exec(sql: string) { return this.native.exec(sql); }
  prepare(sql: string) { return this.native.prepare(sql); }
  transaction<T extends (...args: any[]) => any>(fn: T) {
    return (...args: Parameters<T>) => {
      this.native.exec('BEGIN');
      try {
        const result = fn(...args);
        this.native.exec('COMMIT');
        return result;
      } catch (error) {
        this.native.exec('ROLLBACK');
        throw error;
      }
    };
  }
  close() { this.native.close(); }
}

function securityDatabase() {
  const database = new TestDatabase();
  return {
    database,
    db: database as unknown as Parameters<typeof createServerSecurityStore>[0],
  };
}

test('server password is initialized once, stored as a hash, and issues hashed expiring access sessions', async () => {
  let now = 1_700_000_000_000;
  const { database, db } = securityDatabase();
  const security = createServerSecurityStore(db, {
    bootstrapToken: 'bootstrap-credential-for-tests',
    now: () => now,
    tokenLifetimeMs: 1_000,
  });

  assert.deepEqual(security.status(), { configured: false, bootstrapAvailable: true, tokenEpoch: 1 });
  await assert.rejects(
    () => security.bootstrap('wrong-bootstrap-credential', 'server-password-123'),
    (error: unknown) => error instanceof ServerSecurityError && error.code === 'INVALID_BOOTSTRAP',
  );

  const first = await security.bootstrap('bootstrap-credential-for-tests', 'server-password-123');
  assert.equal(first.accessToken.length, 43);
  assert.equal(security.status().configured, true);
  assert.equal(security.status().bootstrapAvailable, false);
  assert.deepEqual(security.accessForToken(first.accessToken), { epoch: 1, expiresAt: now + 1_000 });
  assert.ok(await security.unlock('server-password-123'));
  await assert.rejects(
    () => security.bootstrap('bootstrap-credential-for-tests', 'another-password-123'),
    (error: unknown) => error instanceof ServerSecurityError && error.code === 'SERVER_ALREADY_INITIALIZED',
  );

  const row = database.prepare('SELECT passwordHash, passwordSalt FROM server_security WHERE id = 1').get() as { passwordHash: string; passwordSalt: string };
  assert.notEqual(row.passwordHash, 'server-password-123');
  assert.notEqual(row.passwordSalt, 'server-password-123');
  const session = database.prepare('SELECT tokenHash, expiresAt, epoch FROM server_access_sessions').get() as { tokenHash: string; expiresAt: number; epoch: number };
  assert.ok(session.tokenHash);
  assert.notEqual(session.tokenHash, first.accessToken);
  assert.equal(session.expiresAt, first.expiresAt);
  assert.equal(session.epoch, 1);

  now += 1_001;
  assert.equal(security.accessForToken(first.accessToken), null);
  database.close();
});

test('password rotation revokes every old access token and accepts only the new password', async () => {
  const { database, db } = securityDatabase();
  const security = createServerSecurityStore(db, { bootstrapToken: 'bootstrap-credential-for-tests' });
  const first = await security.bootstrap('bootstrap-credential-for-tests', 'server-password-123');
  const second = await security.unlock('server-password-123');
  assert.notEqual(first.accessToken, second.accessToken);

  const rotated = await security.rotate('server-password-123', 'rotated-password-123');
  assert.equal(security.accessForToken(first.accessToken), null);
  assert.equal(security.accessForToken(second.accessToken), null);
  assert.ok(security.accessForToken(rotated.accessToken));
  await assert.rejects(
    () => security.unlock('server-password-123'),
    (error: unknown) => error instanceof ServerSecurityError && error.code === 'INVALID_PASSWORD',
  );
  assert.ok(await security.unlock('rotated-password-123'));
  assert.equal(security.status().tokenEpoch, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM server_access_sessions').get().count >= 1, true);
  database.close();
});

test('concurrent bootstrap has one winner and cannot overwrite an existing database', async () => {
  const { database, db } = securityDatabase();
  const security = createServerSecurityStore(db, { bootstrapToken: 'bootstrap-credential-for-tests' });
  const results = await Promise.allSettled([
    security.bootstrap('bootstrap-credential-for-tests', 'server-password-123'),
    security.bootstrap('bootstrap-credential-for-tests', 'other-password-123'),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof ServerSecurityError);
  assert.equal(rejected.reason.code, 'SERVER_ALREADY_INITIALIZED');
  database.close();
});

test('transport and bearer helpers distinguish loopback from public plaintext HTTP', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('192.0.2.4'), false);

  const headers = new Map<string, string>();
  const request = (remoteAddress: string, protocol = 'http') => ({
    protocol,
    ip: remoteAddress,
    socket: { remoteAddress },
    get: (name: string) => headers.get(name.toLowerCase()),
  });
  assert.equal(isSecureHttpRequest(request('127.0.0.1')), true);
  assert.equal(isSecureHttpRequest(request('192.0.2.4')), false);
  assert.equal(isSecureHttpRequest(request('192.0.2.4', 'https')), true);
  assert.equal(isSecureSocket({ request: { socket: { remoteAddress: '127.0.0.1' } } }), true);
  assert.equal(isSecureSocket({ request: { socket: { remoteAddress: '192.0.2.4', encrypted: false } }, handshake: { secure: false } }), false);
  assert.equal(readBearerToken('Bearer abcdefghijklmnopqrstuvwxyz0123456789_-'), 'abcdefghijklmnopqrstuvwxyz0123456789_-');
  assert.equal(readBearerToken('Basic abcdefghijklmnopqrstuvwxyz0123456789_-'), null);
  assert.equal(readBearerToken('Bearer too-short'), null);
});

test('client protocol marker distinguishes supported clients from legacy clients', () => {
  assert.equal(isClientProtocolSupported(CLIENT_PROTOCOL_VERSION), true);
  assert.equal(isClientProtocolSupported(String(CLIENT_PROTOCOL_VERSION)), true);
  assert.equal(isClientProtocolSupported(CLIENT_PROTOCOL_VERSION - 1), false);
  assert.equal(isClientProtocolSupported(undefined), false);
});

test('server password enforcement is disabled unless explicitly enabled', () => {
  assert.equal(isServerSecurityEnabled(undefined), false);
  assert.equal(isServerSecurityEnabled('false'), false);
  assert.equal(isServerSecurityEnabled('0'), false);
  assert.equal(isServerSecurityEnabled('true'), true);
  assert.equal(isServerSecurityEnabled('1'), true);
  assert.equal(isServerSecurityEnabled('ON'), true);
});
