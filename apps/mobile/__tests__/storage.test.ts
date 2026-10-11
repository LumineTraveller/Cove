import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearServerConfig, forgetRememberedServer, readLastServerAddress, readRememberedServers, readSessionConfig, saveLastServerAddress, saveSessionConfig } from '../src/features/settings/storage';
const mockValues = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: async (key: string) => mockValues.get(key) ?? null,
  setItem: async (key: string, value: string) => { mockValues.set(key, value); },
  removeItem: async (key: string) => { mockValues.delete(key); },
}));
beforeEach(() => mockValues.clear());
afterEach(() => jest.restoreAllMocks());
const account = (server: string) => ({ username: server, serverURL: `https://${server}.test/`, accountToken: `token-${server}`, accountId: server, email: `${server}@test.com` });

test('switching keeps per-server sessions and restores the selected account', async () => {
  const a = await saveSessionConfig(account('a'));
  await saveSessionConfig(account('b'));
  await clearServerConfig({ forgetSession: false });
  expect(await readSessionConfig()).toBeNull();
  const remembered = await readRememberedServers();
  expect(remembered).toHaveLength(2);
  expect(remembered.find(entry => entry.serverURL === 'https://a.test')?.accountToken).toBe('token-a');
  await saveSessionConfig(a);
  expect((await readSessionConfig())?.accountId).toBe('a');
});
test('invalidating a session retains nonsecret form defaults but not its token', async () => {
  await saveSessionConfig(account('a')); await saveSessionConfig(account('b'));
  await clearServerConfig();
  expect(await readSessionConfig()).toBeNull();
  const saved = await readRememberedServers();
  expect(saved.find(entry => entry.accountId === 'b')).toEqual(expect.objectContaining({ serverURL: 'https://b.test', email: 'b@test.com' }));
  expect(saved.find(entry => entry.accountId === 'b')?.accountToken).toBeUndefined();
  expect(saved.find(entry => entry.accountId === 'a')?.accountToken).toBe('token-a');
  await forgetRememberedServer('https://a.test');
  expect((await readRememberedServers()).map(entry => entry.accountId)).toEqual(['b']);
});
test('persistent config is whitelisted and never includes a password', async () => {
  await saveSessionConfig({ ...account('a'), ...{ password: 'must-not-persist' } });
  expect([...mockValues.values()].join('')).not.toContain('must-not-persist');
});

test('the submitted address survives a failed login without a complete session', async () => {
  const input = '  Example.test:3001/cove/  ';
  expect(await saveLastServerAddress(input)).toBe('Example.test:3001/cove/');
  expect(await readSessionConfig()).toBeNull();
  expect(await readLastServerAddress()).toBe('Example.test:3001/cove/');
});

test('successful login keeps the original form address through logout and server switching', async () => {
  await saveSessionConfig({
    ...account('a'),
    serverURL: 'https://a.test/cove',
    lastServerAddress: '  https://a.test:443/cove/  ',
  });
  expect((await readSessionConfig())?.serverURL).toBe('https://a.test/cove');
  await clearServerConfig();
  expect(await readSessionConfig()).toBeNull();
  expect(await readLastServerAddress()).toBe('https://a.test:443/cove/');
  await clearServerConfig({ forgetSession: false });
  expect(await readLastServerAddress()).toBe('https://a.test:443/cove/');
});

test('successful saves remember an address even when no separate form value is supplied', async () => {
  await saveSessionConfig(account('a'));
  expect(await readLastServerAddress()).toBe('https://a.test/');
});

test('legacy address restores independently and migrates before an incomplete session is cleared', async () => {
  mockValues.set('cove_server_url', '  https://legacy.test:8443/cove/  ');
  expect(await readSessionConfig()).toBeNull();
  expect(await readLastServerAddress()).toBe('https://legacy.test:8443/cove/');
  await clearServerConfig();
  expect(mockValues.has('cove_server_url')).toBe(false);
  expect(await readLastServerAddress()).toBe('https://legacy.test:8443/cove/');
});

test('the most recently submitted address takes precedence over an old account address', async () => {
  await saveSessionConfig(account('a'));
  await saveLastServerAddress('b.test:3001/new-path/');
  await clearServerConfig();
  expect(await readLastServerAddress()).toBe('b.test:3001/new-path/');
});

test.each([
  'http://', 'ftp://invalid.test',
  'https://user:synthetic-address-password@invalid.test',
  'https://invalid.test/?token=synthetic-address-token',
  'https://invalid.test/#synthetic-address-token',
  'https://invalid.test/unsafe\u0000path',
  `https://invalid.test/${'x'.repeat(4096)}`,
])('unsafe address input never replaces the previous address: %s', async input => {
  await saveLastServerAddress('safe.test:3001/cove/');
  expect(await saveLastServerAddress(input)).toBeNull();
  expect(await readLastServerAddress()).toBe('safe.test:3001/cove/');
  expect([...mockValues.values()].join('')).not.toContain('synthetic-address-password');
  expect([...mockValues.values()].join('')).not.toContain('synthetic-address-token');
});

test('a fresh install returns no remembered address without creating a session', async () => {
  expect(await readLastServerAddress()).toBeNull();
  expect(mockValues.size).toBe(0);
});

test.each(['', '   '])('explicitly clearing the address never falls back to the old session: %j', async input => {
  await saveSessionConfig(account('a'));
  expect(await saveLastServerAddress(input)).toBe('');
  expect(await readLastServerAddress()).toBe('');
  expect(mockValues.has('cove_last_server_address')).toBe(true);
  await clearServerConfig();
  expect(await readLastServerAddress()).toBe('');
});

test('a delayed earlier input write cannot overwrite the newest address', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  jest.spyOn(AsyncStorage, 'setItem').mockImplementation(async (key, value) => {
    if (value === 'first.test:3001/cove/') {
      entered();
      await pending;
    }
    mockValues.set(key, value);
  });
  const first = saveLastServerAddress('first.test:3001/cove/');
  await started;
  const second = saveLastServerAddress('second.test:8443/cove/');
  release();
  await Promise.all([first, second]);
  expect(await readLastServerAddress()).toBe('second.test:8443/cove/');
});

test('a failed storage write does not prevent the next address from being saved', async () => {
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('Synthetic storage failure'));
  await expect(saveLastServerAddress('first.test')).rejects.toThrow('Synthetic storage failure');
  await saveLastServerAddress('second.test');
  expect(await readLastServerAddress()).toBe('second.test');
});

test('legacy migration cannot overwrite an address entered while clearing the session', async () => {
  mockValues.set('cove_server_url', 'https://legacy.test:8443/cove/');
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  let delayed = false;
  jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async key => {
    if (key === 'cove_last_server_address' && !delayed) {
      delayed = true;
      entered();
      await pending;
    }
    return mockValues.get(key) ?? null;
  });
  const clearing = clearServerConfig();
  await started;
  const saving = saveLastServerAddress('https://latest.test:3001/new/');
  release();
  await Promise.all([clearing, saving]);
  expect(await readLastServerAddress()).toBe('https://latest.test:3001/new/');
});

test('a delayed session client ID read cannot reorder its address behind a newer input', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async key => {
    if (key === 'cove_client_id') {
      entered();
      await pending;
    }
    return mockValues.get(key) ?? null;
  });
  const savingSession = saveSessionConfig(account('a'));
  await started;
  await saveLastServerAddress('latest.test:3001/new/');
  release();
  await savingSession;
  expect(await readLastServerAddress()).toBe('latest.test:3001/new/');
});
