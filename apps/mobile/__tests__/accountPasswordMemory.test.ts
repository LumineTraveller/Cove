import { NativeModules, Platform } from 'react-native';
import {
  captureAccountPasswordSaveIntent,
  clearAccountPasswords,
  invalidateAccountPasswordSave,
  invalidateAccountPasswordSaves,
  listAccountPasswords,
  passwordMemoryStatus,
  readAccountPassword,
  removeAccountPassword,
  saveAuthenticatedAccountPassword,
  type PasswordMemoryResult,
} from '../src/features/accounts/accountPasswordMemory';

const server = 'https://host.test';
const email = 'alice@test.com';
const syntheticPassword = 'fictional-account-password';
const records = new Map<string, string>();
const key = (address: string, account: string) =>
  JSON.stringify([address, account]);
const native = {
  status: jest.fn(),
  get: jest.fn(),
  save: jest.fn(),
  remove: jest.fn(),
  clear: jest.fn(),
  list: jest.fn(),
};
const save = (remember = true) =>
  saveAuthenticatedAccountPassword(
    server,
    email,
    syntheticPassword,
    remember,
    captureAccountPasswordSaveIntent(server, email),
  );

beforeEach(() => {
  invalidateAccountPasswordSaves();
  Platform.OS = 'android';
  NativeModules.CoveAccountPasswords = native;
  records.clear();
  for (const method of Object.values(native)) method.mockReset();
  native.status.mockResolvedValue({ available: true, ok: true });
  native.get.mockImplementation(async (address, account) => ({
    available: true,
    ok: true,
    remembered: records.has(key(address, account)),
    password: records.get(key(address, account)) ?? null,
  }));
  native.save.mockImplementation(async (address, account, password) => {
    records.set(key(address, account), password);
    return { available: true, ok: true, remembered: true };
  });
  native.remove.mockImplementation(async (address, account) => {
    records.delete(key(address, account));
    return { available: true, ok: true, remembered: false };
  });
  native.clear.mockImplementation(async () => {
    records.clear();
    return { available: true, ok: true, remembered: false };
  });
  native.list.mockResolvedValue({ available: true, ok: true, accounts: [] });
});
afterEach(() => {
  delete NativeModules.CoveAccountPasswords;
});

test('only opt-in saves reach native storage and normalization preserves server/account isolation', async () => {
  await save(false);
  expect(native.save).not.toHaveBeenCalled();
  const address = ' HTTPS://HOST.TEST:443/a/../tenant/ ';
  const account = ' ALICE@TEST.COM ';
  await saveAuthenticatedAccountPassword(
    address,
    account,
    syntheticPassword,
    true,
    captureAccountPasswordSaveIntent(address, account),
  );
  expect(native.save).toHaveBeenCalledWith(
    'https://host.test/tenant',
    email,
    syntheticPassword,
  );
  expect(
    (await readAccountPassword('https://host.test/tenant', email)).password,
  ).toBe(syntheticPassword);
  expect((await readAccountPassword(server, email)).password).toBeNull();
  expect(
    (await readAccountPassword('https://host.test/tenant', 'other@test.com'))
      .password,
  ).toBeNull();
});

test('schemes, ports, base paths, double slashes and encoded paths remain distinct scopes', async () => {
  const addresses = [
    'https://host.test',
    'http://host.test',
    'https://host.test:8443',
    'https://host.test/tenant',
    'https://host.test/a//b/%2F',
    'https://host.test/a/b/%2F',
    'https://host.test/a//b/%2f',
  ];
  for (const [index, address] of addresses.entries()) {
    await saveAuthenticatedAccountPassword(
      address,
      email,
      `synthetic-scope-password-${index}`,
      true,
      captureAccountPasswordSaveIntent(address, email),
    );
  }
  expect(records.size).toBe(addresses.length);
  for (const [index, address] of addresses.entries()) {
    expect((await readAccountPassword(address, email)).password).toBe(
      `synthetic-scope-password-${index}`,
    );
  }
});

test.each(['remove', 'clear', 'logout'] as const)(
  '%s revokes a login intent before its late authentication saves',
  async action => {
    const intent = captureAccountPasswordSaveIntent(server, email);
    if (action === 'remove') await removeAccountPassword(server, email);
    if (action === 'clear') await clearAccountPasswords();
    if (action === 'logout') invalidateAccountPasswordSaves();
    const result = await saveAuthenticatedAccountPassword(
      server,
      email,
      syntheticPassword,
      true,
      intent,
    );
    expect(result.cancelled).toBe(true);
    expect(native.save).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
  },
);

test.each(['remove', 'clear'] as const)(
  '%s also removes a native save that was already in flight',
  async action => {
    let release!: (value: PasswordMemoryResult) => void;
    native.save.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    const pendingSave = save();
    await Promise.resolve();
    expect(native.save).toHaveBeenCalledTimes(1);
    const deletion =
      action === 'remove'
        ? removeAccountPassword(server, email)
        : clearAccountPasswords();
    records.set(key(server, email), syntheticPassword);
    release({ available: true, ok: true, remembered: true });
    expect((await pendingSave).cancelled).toBe(true);
    expect((await deletion).ok).toBe(true);
    expect(records.size).toBe(0);
  },
);

test('a new explicit login after cancellation can save while an old intent stays revoked', async () => {
  const old = captureAccountPasswordSaveIntent(server, email);
  invalidateAccountPasswordSave(server, email);
  expect(
    (
      await saveAuthenticatedAccountPassword(
        server,
        email,
        syntheticPassword,
        true,
        old,
      )
    ).cancelled,
  ).toBe(true);
  expect((await save()).remembered).toBe(true);
  expect(records.get(key(server, email))).toBe(syntheticPassword);
});

test('a late credential read cannot return a password after deletion', async () => {
  let release!: (value: PasswordMemoryResult) => void;
  native.get.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  const pendingRead = readAccountPassword(server, email);
  await removeAccountPassword(server, email);
  release({
    available: true,
    ok: true,
    remembered: true,
    password: syntheticPassword,
  });
  expect(await pendingRead).toEqual(
    expect.objectContaining({ cancelled: true, password: null }),
  );
});

test('logout invalidates pending intents without deleting an already completed explicit memory', async () => {
  await save();
  invalidateAccountPasswordSaves();
  expect(records.get(key(server, email))).toBe(syntheticPassword);
  expect(native.remove).not.toHaveBeenCalled();
});

test('metadata lists omit any native password fields and discard invalid/duplicate scopes', async () => {
  native.list.mockResolvedValue({
    available: true,
    ok: true,
    password: syntheticPassword,
    accounts: [
      {
        serverURL: 'HTTPS://HOST.TEST:443/',
        email: ' ALICE@TEST.COM ',
        password: syntheticPassword,
      },
      { serverURL: server, email },
      { serverURL: 'https://host.test:8443/tenant', email: 'other@test.com' },
      { serverURL: 'https://user@host.test', email },
      { serverURL: server, email: 'invalid' },
    ],
  });
  const result = await listAccountPasswords();
  expect(result.accounts).toEqual([
    { serverURL: server, email },
    { serverURL: 'https://host.test:8443/tenant', email: 'other@test.com' },
  ]);
  expect(JSON.stringify(result)).not.toContain(syntheticPassword);
});

test.each(['ios', 'android'] as const)(
  'unsupported %s permits manual authentication and removal without persistence fallback',
  async os => {
    Platform.OS = os;
    if (os === 'android') delete NativeModules.CoveAccountPasswords;
    expect((await passwordMemoryStatus()).available).toBe(false);
    expect((await readAccountPassword(server, email)).password).toBeNull();
    expect((await save()).ok).toBe(false);
    expect((await removeAccountPassword(server, email)).ok).toBe(true);
    expect((await clearAccountPasswords()).ok).toBe(true);
    expect(native.save).not.toHaveBeenCalled();
  },
);

test('native errors remain generic and distinguish a broken store from an unsupported build', async () => {
  native.get.mockRejectedValue(new Error('Synthetic decryption failure'));
  native.save.mockRejectedValue(new Error('Synthetic encryption failure'));
  expect(await readAccountPassword(server, email)).toEqual({
    available: true,
    ok: false,
    password: null,
  });
  expect(await save()).toEqual({ available: true, ok: false });
  expect(records.size).toBe(0);
});

test('invalid scopes never reach the native credential API', async () => {
  await readAccountPassword('https://user:pass@host.test', email);
  await readAccountPassword(server, 'invalid');
  await saveAuthenticatedAccountPassword(
    server,
    'invalid',
    syntheticPassword,
    true,
    captureAccountPasswordSaveIntent(server, 'invalid'),
  );
  expect(native.get).not.toHaveBeenCalled();
  expect(native.save).not.toHaveBeenCalled();
});
