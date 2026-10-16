import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearAllServerAccessTokens, clearRememberedServerAccess, clearServerAccessToken,
  ensureServerAccess, forgetServerAccess, getServerAccessGrant, readServerSecurityStatus,
  rememberServerAccess, restoreServerAccess, setServerAccessToken, unlockServer,
} from '../src/features/connection/serverSecurity';

const server = 'https://remember.example.test';
const email = 'fictional@example.test';
const grant = () => ({ accessToken: 'fictional-server-access', expiresAt: Date.now() + 14 * 24 * 60 * 60 * 1000 });
const response = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function withApi(api: any, run: () => Promise<void>) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  clearAllServerAccessTokens();
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { coveServerAccess: api } });
  try { await run(); }
  finally {
    clearAllServerAccessTokens();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('concurrent restore reads once and the bound grant cannot be saved for another account', async () => {
  const saved = grant(), read = deferred<any>();
  let reads = 0;
  await withApi({ get: () => { reads++; return read.promise; }, set: async () => ({ available: true, ok: true }) }, async () => {
    const first = restoreServerAccess(server, email), second = restoreServerAccess(server, email);
    assert.equal(first, second);
    await Promise.resolve();
    read.resolve({ available: true, ok: true, grant: saved });
    assert.equal(await first, true);
    assert.equal(reads, 1);
    assert.deepEqual(getServerAccessGrant(server), saved);
    assert.equal(await rememberServerAccess(server, 'other@example.test'), false);
    assert.equal(await rememberServerAccess(server, email), true);
  });
});

test('forget during pending restore cancels the read before it can repopulate memory', async () => {
  const read = deferred<any>();
  const removals: unknown[][] = [];
  await withApi({ get: () => read.promise, remove: async (...args: unknown[]) => { removals.push(args); return { available: true, ok: true }; } }, async () => {
    const restore = restoreServerAccess(server, email);
    await Promise.resolve();
    const removal = forgetServerAccess(server, email);
    read.resolve({ available: true, ok: true, grant: grant() });
    assert.equal(await restore, false);
    await removal;
    assert.equal(getServerAccessGrant(server), null);
    assert.deepEqual(removals, [[server, email]]);
  });
});

test('clear after pending save executes last and does not renew the captured expiry', async () => {
  const save = deferred<any>(), started = deferred<void>(), events: string[] = [], saved = grant();
  await withApi({ set: (_url: string, _email: string, value: unknown) => {
    assert.deepEqual(value, saved); events.push('save'); started.resolve(); return save.promise;
  }, clear: async () => { events.push('clear'); return { available: true, ok: true }; } }, async () => {
    setServerAccessToken(server, saved);
    const saving = rememberServerAccess(server, email);
    await started.promise;
    const clearing = clearRememberedServerAccess();
    save.resolve({ available: true, ok: true });
    assert.equal(await saving, false);
    await clearing;
    assert.deepEqual(events, ['save', 'clear']);
    assert.equal(getServerAccessGrant(server), null);
  });
});

test('offline status preserves the grant and makes one request without retrying password auth', async () => {
  const originalFetch = globalThis.fetch, saved = grant();
  let requests = 0;
  clearAllServerAccessTokens();
  setServerAccessToken(server, saved);
  globalThis.fetch = async () => { requests++; throw new TypeError('Synthetic offline'); };
  try {
    await assert.rejects(ensureServerAccess({ serverURL: server, password: 'fictional-server-password' }), /Synthetic offline/);
    assert.equal(requests, 1);
    assert.deepEqual(getServerAccessGrant(server), saved);
  } finally { globalThis.fetch = originalFetch; clearAllServerAccessTokens(); }
});

test('authoritative token denial removes remembered auth and asks for the server password', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0, removals = 0;
  globalThis.fetch = async () => { requests++; return response({ enabled: true, configured: true, authorized: false, tokenEpoch: 2 }); };
  try {
    await withApi({ remove: async () => { removals++; return { available: true, ok: true }; } }, async () => {
      setServerAccessToken(server, grant());
      await assert.rejects(ensureServerAccess({ serverURL: server, password: '' }), (error: any) => error.code === 'SERVER_ACCESS_REQUIRED');
      assert.equal(requests, 1);
      assert.equal(removals, 1);
      assert.equal(getServerAccessGrant(server), null);
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('logout cancels a late password exchange and an aborted status cannot clear a newer grant', async () => {
  const originalFetch = globalThis.fetch, pending = deferred<Response>();
  clearAllServerAccessTokens();
  globalThis.fetch = () => pending.promise;
  try {
    const exchange = unlockServer(server, 'fictional-password');
    clearServerAccessToken(server);
    pending.resolve(response(grant()));
    await assert.rejects(exchange, (error: any) => error.name === 'AbortError');
    assert.equal(getServerAccessGrant(server), null);
    const statusResponse = deferred<Response>(), controller = new AbortController(), newer = grant();
    globalThis.fetch = () => statusResponse.promise;
    const status = readServerSecurityStatus(server, controller.signal);
    controller.abort();
    setServerAccessToken(server, newer);
    statusResponse.resolve(response({ enabled: false }));
    await assert.rejects(status, (error: any) => error.name === 'AbortError');
    assert.deepEqual(getServerAccessGrant(server), newer);
  } finally { globalThis.fetch = originalFetch; clearAllServerAccessTokens(); }
});

test('OS storage unavailable or removal failure fails closed', async () => {
  await withApi({ get: async () => ({ available: false, ok: false }), remove: async () => ({ available: false, ok: false }) }, async () => {
    assert.equal(await restoreServerAccess(server, email), false);
    assert.equal(getServerAccessGrant(server), null);
    await assert.rejects(forgetServerAccess(server, email), /无法清除/);
  });
});

async function withReloadBridge(record: unknown, run: (security: typeof import('../src/features/connection/serverSecurity'), read: () => any) => Promise<void>) {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const key = 'cove_server_access_session';
  const values = new Map([[key, JSON.stringify(record)]]);
  const modulePath = require.resolve('../src/features/connection/serverSecurity');
  const originalModule = require.cache[modulePath];
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); },
  } });
  delete require.cache[modulePath];
  try {
    const fresh = require(modulePath) as typeof import('../src/features/connection/serverSecurity');
    await run(fresh, () => JSON.parse(values.get(key) ?? '{}'));
  } finally {
    if (originalModule) require.cache[modulePath] = originalModule;
    else delete require.cache[modulePath];
    if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
}

test('reloaded session bridge rejects legacy unknown owners and a different account without deleting durable auth', async () => {
  let removals = 0;
  await withApi({ get: async () => ({ available: true, ok: true, grant: null }),
    remove: async () => { removals++; return { available: true, ok: true }; } }, async () => {
    for (const owner of [undefined, 'other@example.test']) {
      await withReloadBridge({ [server]: { ...grant(), email: owner, lastObservedAt: Date.now() } }, async fresh => {
        assert.equal(await fresh.restoreServerAccess(server, email), false);
        assert.equal(fresh.getServerAccessGrant(server), null);
      });
    }
    assert.equal(removals, 0, 'clearing an incompatible session bridge must not delete any durable scope');
  });
});

test('manual account success binds the reload bridge even when OS storage is unavailable', async () => {
  await withApi({ get: async () => ({ available: false, ok: false }), set: async () => ({ available: false, ok: false }) }, async () => {
    const saved = grant();
    await withReloadBridge({}, async (fresh, read) => {
      fresh.setServerAccessToken(server, saved);
      assert.equal(await fresh.rememberServerAccess(server, email), false, 'durable remember is unavailable');
      assert.equal(read()[server].email, email);
      assert.equal(read()[server].expiresAt, saved.expiresAt);
      const copy = read();
      await withReloadBridge(copy, async reloaded => {
        assert.equal(await reloaded.restoreServerAccess(server, email), true);
        assert.deepEqual(reloaded.getServerAccessGrant(server), saved);
        assert.equal(await reloaded.restoreServerAccess(server + '/other', email), false);
        assert.deepEqual(reloaded.getServerAccessGrant(server), saved, 'another path does not clear this exact server');
        assert.equal(await reloaded.restoreServerAccess(server, 'other@example.test'), false);
        assert.equal(reloaded.getServerAccessGrant(server), null);
      });
    });
  });
});
