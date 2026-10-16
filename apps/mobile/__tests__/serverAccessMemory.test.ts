import { NativeModules, Platform } from 'react-native';
import {
  captureServerAccessIntent, forgetAllServerAccess, forgetServerAccess,
  rememberServerAccess, restoreServerAccess, SERVER_ACCESS_MAX_AGE,
} from '../src/features/connection/serverAccessMemory';
import { clearServerAccessToken, getServerAccessToken, setServerAccessToken } from '../src/features/connection/serverSecurity';
const server = 'https://grant.example.test/cove';
const email = 'alice@example.test';
const records = new Map<string, string>();
const key = (s = server, e = email) => JSON.stringify([s, e]);
const receipt = () => ({ accessToken: 'synthetic-server-grant', verifiedAt: Date.now(),
  lastObservedAt: Date.now(), expiresAt: Date.now() + SERVER_ACCESS_MAX_AGE });
beforeEach(async () => {
  jest.restoreAllMocks();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  NativeModules.CoveServerAccessGrants = {
    get: jest.fn(async (s: string, e: string) => ({ available: true, ok: true, value: records.get(key(s, e)) ?? null })),
    save: jest.fn(async (s: string, e: string, value: string) => { records.set(key(s, e), value); return { available: true, ok: true }; }),
    remove: jest.fn(async (s: string, e: string) => { records.delete(key(s, e)); return { available: true, ok: true }; }),
    clear: jest.fn(async () => { records.clear(); return { available: true, ok: true }; }),
  };
  await forgetAllServerAccess();
  clearServerAccessToken(server);
});
afterEach(() => jest.restoreAllMocks());
async function remember() {
  const grant = receipt();
  expect(await rememberServerAccess(server, email, grant, captureServerAccessIntent(server, email))).toBe(true);
  return grant;
}
test('server path, port, scheme and account remain isolated while equivalent addresses normalize', async () => {
  await remember();
  expect(await restoreServerAccess(server + '/', ' Alice@Example.Test ')).toBeTruthy();
  expect(await restoreServerAccess(server, 'bob@example.test')).toBeNull();
  expect(getServerAccessToken(server)).toBeNull();
  for (const other of ['http://grant.example.test/cove', 'https://grant.example.test:8443/cove', 'https://grant.example.test/other'])
    expect(await restoreServerAccess(other, email)).toBeNull();
  expect(records.has(key())).toBe(true);
});
test('restoring at day seven retains the original fixed expiry and verification receipt', async () => {
  const original = await remember();
  jest.spyOn(Date, 'now').mockReturnValue(original.verifiedAt + 7 * 86400000);
  const restored = await restoreServerAccess(server, email);
  expect(restored).toEqual({ ...original, lastObservedAt: Date.now() });
  expect(JSON.parse(records.get(key())!).expiresAt).toBe(original.expiresAt);
});
test.each(['expiry', 'rollback', 'oversized-lifetime'])('%s cancels stored authorization safely', async reason => {
  const original = await remember();
  if (reason === 'expiry') jest.spyOn(Date, 'now').mockReturnValue(original.expiresAt);
  if (reason === 'rollback') jest.spyOn(Date, 'now').mockReturnValue(original.verifiedAt - 1);
  if (reason === 'oversized-lifetime') records.set(key(), JSON.stringify({ ...original, expiresAt: original.expiresAt + 1 }));
  expect(await restoreServerAccess(server, email)).toBeNull();
  expect(getServerAccessToken(server)).toBeNull();
  expect(records.has(key())).toBe(false);
});
test('a failed secure-store read does not erase the stored credential or invent authorization', async () => {
  await remember();
  NativeModules.CoveServerAccessGrants.get.mockResolvedValue({ available: true, ok: false });
  expect(await restoreServerAccess(server, email)).toBeNull();
  expect(records.size).toBe(1);
  expect(NativeModules.CoveServerAccessGrants.remove).not.toHaveBeenCalled();
});
test('clearing memory cancels an in-flight restore before it can install a bearer token', async () => {
  await remember();
  let release!: (value: object) => void;
  NativeModules.CoveServerAccessGrants.get.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const pending = restoreServerAccess(server, email);
  await Promise.resolve();
  await Promise.resolve();
  const clearing = forgetAllServerAccess();
  release({ available: true, ok: true, value: records.get(key()) });
  expect(await pending).toBeNull();
  expect(await clearing).toBe(true);
  expect(records.size).toBe(0);
  expect(getServerAccessToken(server)).toBeNull();
});
test('forgetting one account revokes pending saves and leaves another account isolated', async () => {
  const intent = captureServerAccessIntent(server, email);
  const grant = receipt();
  await forgetServerAccess(server, email);
  expect(await rememberServerAccess(server, email, grant, intent)).toBe(false);
  expect(records.size).toBe(0);
});

test('forgetting another account keeps the current account grant while clearing all also removes unbound memory', async () => {
  await remember();
  await restoreServerAccess(server, email);
  records.set(key(server, 'bob@example.test'), JSON.stringify(receipt()));
  await forgetServerAccess(server, 'bob@example.test');
  expect(getServerAccessToken(server)).toBe('synthetic-server-grant');
  expect(records.has(key())).toBe(true);
  setServerAccessToken('https://unbound.example.test', receipt());
  await forgetAllServerAccess();
  expect(getServerAccessToken('https://unbound.example.test')).toBeNull();
});
