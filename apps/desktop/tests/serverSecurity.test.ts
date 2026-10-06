import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_PROTOCOL_VERSION,
  ensureServerAccess,
  readServerSecurityStatus,
  requiresServerAccessRecovery,
  serverRequestInit,
  serverSocketAuth,
  authorizedResourceURL,
  serverFetch,
  setServerAccessToken,
} from '../src/features/connection/serverSecurity';

const response = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('legacy server status 404 is treated as password-free mode', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response(404, { error: 'not found' });
  try {
    const status = await readServerSecurityStatus('http://legacy.test');
    assert.deepEqual(status, {
      enabled: false,
      configured: false,
      bootstrapAvailable: false,
      tokenEpoch: 0,
      authorized: false,
      secureTransportRequired: false,
    });
    assert.equal(await ensureServerAccess({ serverURL: 'http://legacy.test', password: '' }), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('explicitly disabled security status skips the password exchange', async () => {
  const originalFetch = globalThis.fetch;
  const requests: RequestInfo[] = [];
  globalThis.fetch = async input => {
    requests.push(input);
    return response(200, {
      enabled: false,
      configured: false,
      bootstrapAvailable: false,
      tokenEpoch: 1,
      authorized: false,
      secureTransportRequired: false,
    });
  };
  try {
    assert.equal(await ensureServerAccess({ serverURL: 'https://disabled.test', password: '' }), null);
    assert.equal(requests.length, 1);
    assert.match(String(requests[0]), /\/api\/security\/status$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('client requests advertise protocol 3 and the actual desktop identity for an enabled server', () => {
  const init = serverRequestInit('https://enabled.test', { headers: { 'X-Test': 'kept', 'X-Cove-Client-Version': '1.5.4' } });
  const headers = new Headers(init.headers);
  assert.equal(headers.get('x-cove-client-protocol'), String(CLIENT_PROTOCOL_VERSION));
  assert.equal(CLIENT_PROTOCOL_VERSION, 3);
  assert.equal(headers.get('x-cove-client-version'), '2.0.0');
  assert.equal(headers.get('x-cove-client-platform'), 'desktop');
  assert.equal(headers.get('x-test'), 'kept');
});

test('socket identity and direct media requests identify the desktop version with and without a grant', () => {
  const server = 'https://identity.test';
  assert.deepEqual(serverSocketAuth(server), {
    serverAccessToken: null, clientProtocol: 3, clientVersion: '2.0.0', clientPlatform: 'desktop',
  });
  const withoutGrant = new URL(authorizedResourceURL(server, '/sounds/tone.ogg'));
  assert.equal(withoutGrant.searchParams.get('client_version'), '2.0.0');
  assert.equal(withoutGrant.searchParams.get('client_platform'), 'desktop');
  assert.equal(withoutGrant.searchParams.has('access_token'), false);
  setServerAccessToken(server, { accessToken: 'synthetic-test-grant', expiresAt: Date.now() + 60_000 });
  assert.equal(serverSocketAuth(server).serverAccessToken, 'synthetic-test-grant');
  const withGrant = new URL(authorizedResourceURL(server, '/chat-images/test.png'));
  assert.equal(withGrant.searchParams.get('access_token'), 'synthetic-test-grant');
  assert.equal(withGrant.searchParams.get('client_protocol'), '3');
  const external = 'https://cdn.test/avatar.png';
  assert.equal(authorizedResourceURL(server, external), external, 'do not add a grant or identity to a CDN URL');
  assert.equal(authorizedResourceURL(server, 'data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(authorizedResourceURL(server, 'blob:https://identity.test/synthetic'), 'blob:https://identity.test/synthetic');
});

test('an upgrade response remains readable by the original auth caller', async () => {
  const originalFetch = globalThis.fetch;
  const body = { code: 'CLIENT_VERSION_TOO_OLD', minimumClientVersion: '3.0.0', error: 'Update required' };
  globalThis.fetch = async () => response(426, body);
  try {
    const result = await serverFetch('https://upgrade.test', '/api/auth/login');
    assert.equal(result.status, 426);
    assert.deepEqual(await result.json(), body, 'checking an upgrade must not consume the response body');
  } finally { globalThis.fetch = originalFetch; }
});

test('public password status preserves a valid version policy without changing its security state', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response(200, {
    enabled: false, minimumClientVersion: '2.0.0', serverVersion: '2.0.0', upgradeRequired: false,
    downloadUrl: 'https://updates.test/downloads/Cove-Setup.exe',
  });
  try {
    const status = await readServerSecurityStatus('https://policy.test');
    assert.equal(status.enabled, false);
    assert.deepEqual(status.versionPolicy, {
      minimumClientVersion: '2.0.0', serverVersion: '2.0.0', downloadUrl: 'https://updates.test/downloads/Cove-Setup.exe',
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('server access recovery includes an enabled but uninitialized server', () => {
  assert.equal(requiresServerAccessRecovery('SERVER_NOT_INITIALIZED'), true);
  assert.equal(requiresServerAccessRecovery('SERVER_ACCESS_REQUIRED'), true);
  assert.equal(requiresServerAccessRecovery('SERVER_ACCESS_INVALID'), true);
  assert.equal(requiresServerAccessRecovery('INSECURE_TRANSPORT'), true);
  assert.equal(requiresServerAccessRecovery('CLIENT_VERSION_TOO_OLD'), false);
  assert.equal(requiresServerAccessRecovery(undefined), false);
});
