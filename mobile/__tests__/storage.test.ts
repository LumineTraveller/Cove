import { clearServerConfig, forgetRememberedServer, readRememberedServers, readSessionConfig, saveSessionConfig } from '../src/storage';
const mockValues = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: async (key: string) => mockValues.get(key) ?? null,
  setItem: async (key: string, value: string) => { mockValues.set(key, value); },
  removeItem: async (key: string) => { mockValues.delete(key); },
}));
beforeEach(() => mockValues.clear());
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
