import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_PROTOCOL_VERSION,
  ensureServerAccess,
  readServerSecurityStatus,
  serverRequestInit,
} from '../src/serverSecurity';

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

test('client requests continue to advertise protocol 2 for an enabled server', () => {
  const init = serverRequestInit('https://enabled.test');
  assert.equal(new Headers(init.headers).get('x-cove-client-protocol'), String(CLIENT_PROTOCOL_VERSION));
});
