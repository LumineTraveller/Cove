import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COVE_RELEASE_VERSION } from '@cove/contracts';
import {
  CLIENT_VERSION,
  createClientVersionGate,
  fetchClientVersionPolicy,
  readClientVersionPolicy,
  requiresClientUpgrade,
  safeUpgradeDownloadUrl,
} from '../src/features/updates/clientVersion';

const policy = { minimumClientVersion: '2.0.0', serverVersion: '2.0.0', upgradeRequired: true };

test('the actual desktop identity matches the release and a current stable client never loops on upgrade flags', () => {
  assert.equal(CLIENT_VERSION, '2.0.0');
  assert.equal(CLIENT_VERSION, COVE_RELEASE_VERSION);
  assert.equal(requiresClientUpgrade(policy), false);
  assert.equal(requiresClientUpgrade(policy, '2.0.0+local.1'), false);
  assert.equal(requiresClientUpgrade(policy, '2.0.0-rc.1'), true);
  assert.equal(requiresClientUpgrade(policy, '1.10.0'), true);
  assert.equal(requiresClientUpgrade(policy, '2.1.0'), false);
});

test('a gate needs a valid minimum; an error code, arbitrary string or boolean alone is insufficient', () => {
  for (const payload of [null, {}, { code: 'CLIENT_VERSION_TOO_OLD' }, { upgradeRequired: true },
    { minimumClientVersion: '2' }, { minimumClientVersion: '02.0.0' }, { minimumClientVersion: 2 }]) {
    assert.equal(readClientVersionPolicy(payload), null);
  }
  assert.equal(readClientVersionPolicy({ minimumClientVersion: '0.8.0', clientPlatform: 'mobile' }), null);
  assert.equal(readClientVersionPolicy({ minimumClientVersion: '0.8.0' }), null);
  assert.equal(readClientVersionPolicy({ ...policy, clientPlatform: 'mobile' }), null);
  assert.equal(readClientVersionPolicy({ ...policy, clientPlatform: 'unknown' }), null);
  assert.ok(readClientVersionPolicy({ ...policy, clientPlatform: 'desktop' }));
  assert.equal(readClientVersionPolicy({ ...policy, downloadUrl: 'javascript:alert(1)' })?.downloadUrl, undefined);
  assert.equal(safeUpgradeDownloadUrl('https://user:secret@updates.test/setup.exe'), undefined);
  assert.equal(safeUpgradeDownloadUrl('http://updates.test/setup.exe'), undefined);
  assert.equal(safeUpgradeDownloadUrl('http://127.0.0.1:3301/downloads/setup.exe'), 'http://127.0.0.1:3301/downloads/setup.exe');
});

test('concurrent startup checks share one request and repeated confirmed rejections announce one update', async () => {
  let requests = 0;
  let resolve!: (payload: unknown) => void;
  const notices: unknown[] = [];
  const gate = createClientVersionGate({
    version: '1.5.4',
    fetchPolicy: async () => { requests++; return new Promise(done => { resolve = done; }); },
    onRequired: notice => notices.push(notice),
  });
  const first = gate.check('https://server.test');
  const second = gate.check('https://server.test');
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(requests, 1);
  resolve(policy);
  assert.equal((await first).status, 'required');
  gate.observe('https://server.test', policy);
  gate.observe('https://server.test', { ...policy, code: 'CLIENT_VERSION_TOO_OLD' });
  assert.equal(notices.length, 1);
  gate.observe('https://other.test', policy);
  assert.equal(notices.length, 2, 'a different server has a separate gate');
});

test('unavailable checks allow retry and neither announce upgrades nor erase an established requirement', async () => {
  let offline = true;
  let required = 0;
  let supported = 0;
  const gate = createClientVersionGate({
    version: '1.5.4',
    fetchPolicy: async () => { if (offline) throw new Error('offline'); return policy; },
    onRequired: () => { required++; }, onSupported: () => { supported++; },
  });
  assert.equal((await gate.check('https://server.test')).status, 'unavailable');
  assert.equal(required, 0);
  assert.equal(supported, 0);
  offline = false;
  assert.equal((await gate.check('https://server.test')).status, 'required');
  assert.equal(required, 1);
  offline = true;
  assert.equal((await gate.check('https://server.test')).status, 'unavailable');
  assert.equal(supported, 0, 'a failed retry is not evidence that the server lifted its gate');
});

test('a supported authoritative policy clears only its server gate without re-triggering update', async () => {
  const notices: string[] = [];
  const allowed: string[] = [];
  const gate = createClientVersionGate({ fetchPolicy: async () => policy,
    onRequired: requirement => notices.push(requirement.serverURL), onSupported: url => allowed.push(url) });
  gate.observe('https://higher.test', { minimumClientVersion: '3.0.0' });
  assert.equal(notices.length, 1);
  assert.equal((await gate.check('https://current.test')).status, 'supported');
  assert.deepEqual(allowed, ['https://current.test']);
  assert.equal(notices.length, 1);
});

test('the public version probe identifies the platform, carries no saved credential and bounds failure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, 'https://server.test/cove/api/version');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('X-Cove-Client-Version'), '2.0.0');
    assert.equal(headers.get('X-Cove-Client-Platform'), 'desktop');
    assert.equal(headers.get('X-Cove-Client-Protocol'), '3');
    assert.equal(headers.has('authorization'), false);
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(JSON.stringify(policy));
  };
  try {
    assert.deepEqual(await fetchClientVersionPolicy('https://server.test/cove/'), policy);
    globalThis.fetch = async () => { throw new TypeError('Network unavailable'); };
    await assert.rejects(fetchClientVersionPolicy('https://server.test'), /Network unavailable/);
  } finally { globalThis.fetch = originalFetch; }
});
