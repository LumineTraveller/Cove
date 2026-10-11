import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Alert, NativeModules, Platform } from 'react-native';
import { useCoveSession } from '../src/features/connection/useCoveSession';
import { clearServerAccessToken } from '../src/features/connection/serverSecurity';
import { readSessionConfig, saveSessionConfig } from '../src/features/settings/storage';
import type { AccountAuthRequest } from '../src/features/accounts/accountAuth';
import { version as clientVersion } from '../package.json';
import { removeAccountPassword } from '../src/features/accounts/accountPasswordMemory';

const mockValues = new Map<string, string>();
const mockPasswordValues = new Map<string, string>();
let mockDelayedAddressRead: Promise<string | null> | undefined;
const mockListeners = new Map<string, (...args: any[]) => void>();
const mockSocket: { connected: boolean; on: jest.Mock; off: jest.Mock; connect: jest.Mock;
  disconnect: jest.Mock; timeout: jest.Mock; emit: jest.Mock } = {
  connected: false,
  on: jest.fn((event: string, handler: (...args: any[]) => void) => {
    mockListeners.set(event, handler);
  }),
  off: jest.fn((event: string) => mockListeners.delete(event)),
  connect: jest.fn(() => {
    mockSocket.connected = true;
    mockListeners.get('connect')?.();
  }),
  disconnect: jest.fn(() => { mockSocket.connected = false; }),
  timeout: jest.fn(() => mockSocket),
  emit: jest.fn((_event: string, _payload: unknown, callback: (error: Error | null, response: { ok: boolean }) => void) => callback(null, { ok: true })),
};
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: async (key: string) => key === 'cove_last_server_address' && mockDelayedAddressRead
    ? mockDelayedAddressRead : mockValues.get(key) ?? null,
  setItem: async (key: string, value: string) => { mockValues.set(key, value); },
  removeItem: async (key: string) => { mockValues.delete(key); },
}));
jest.mock('../src/features/connection/socket', () => ({
  createCoveSocket: jest.fn(() => mockSocket),
}));

const base = 'https://mobileqa.example.test';
const request: AccountAuthRequest = {
  mode: 'login', username: '', email: 'mobileqa@example.test',
  password: 'synthetic-account-password', serverPassword: 'synthetic-server-password',
  serverURL: base, allowInvalidServerCertificate: false,
};
const account = { id: 'qa-account', username: 'MobileQA', email: request.email, avatarUrl: null };
const mockResolveAddresses = jest.fn<Promise<string[]>, [string]>();
let session: ReturnType<typeof useCoveSession>;
function Harness() { session = useCoveSession(); return null; }
let renderer: TestRenderer.ReactTestRenderer;
const response = (status: number, body: object) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body,
}) as Response;

beforeEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  jest.clearAllMocks();
  mockValues.clear();
  mockPasswordValues.clear();
  mockDelayedAddressRead = undefined;
  mockListeners.clear();
  mockSocket.connected = false;
  clearServerAccessToken(base);
  mockResolveAddresses.mockResolvedValue(['192.0.2.10', '2001:db8::10']);
  NativeModules.CoveNative = {
    configureServerCertificate: jest.fn(async () => undefined),
    resolveServerAddresses: mockResolveAddresses,
  };
  NativeModules.CoveAccountPasswords = {
    status: jest.fn(async () => ({ available: true, ok: true })),
    list: jest.fn(async () => ({ available: true, ok: true,
      accounts: [...mockPasswordValues.keys()].map(key => {
        const [serverURL, email] = JSON.parse(key);
        return { serverURL, email };
      }) })),
    save: jest.fn(async (serverURL: string, email: string, password: string) => {
      mockPasswordValues.set(JSON.stringify([serverURL, email]), password);
      return { available: true, ok: true, remembered: true };
    }),
    remove: jest.fn(async (serverURL: string, email: string) => {
      mockPasswordValues.delete(JSON.stringify([serverURL, email]));
      return { available: true, ok: true, remembered: false };
    }),
  };
  globalThis.fetch = jest.fn(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/security/status')) return response(200, {
      enabled: true, configured: true, authorized: false, tokenEpoch: 1,
      bootstrapAvailable: false, secureTransportRequired: false,
    });
    if (url.endsWith('/api/security/access')) {
      const body = JSON.parse(String(init?.body));
      return body.password === request.serverPassword
        ? response(200, { accessToken: 'synthetic-access-grant', expiresAt: Date.now() + 60000 })
        : response(401, { code: 'INVALID_PASSWORD', error: '服务器访问密码错误' });
    }
    if (/\/api\/auth\/(login|register)$/.test(url)) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-access-grant');
      const body = JSON.parse(String(init?.body));
      return body.password === request.password
        ? response(url.endsWith('/register') ? 201 : 200, { token: 'synthetic-account-token', account })
        : response(401, { error: '邮箱或密码错误' });
    }
    if (url.endsWith('/api/version')) return response(200, { upgradeRequired: false });
    throw new Error('Unexpected synthetic URL: ' + url);
  });
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); });
const mount = async () => { await act(async () => { renderer = TestRenderer.create(<Harness />); }); };
const submit = async (overrides: Partial<AccountAuthRequest> = {}) => {
  await act(async () => session.handleLogin({ ...request, ...overrides }));
};

test.each(['login', 'register'] as const)('%s succeeds through unlock, domain DNS, storage and Socket registration', async mode => {
  await mount();
  await submit({ mode, username: 'MobileQA' });
  expect(session.authError).toBeNull();
  expect(mockResolveAddresses).toHaveBeenCalledWith('mobileqa.example.test');
  expect(session.config).toEqual(expect.objectContaining({
    serverURL: base, accountId: account.id,
    serverKey: 'ip:192.0.2.10,2001:db8::10|443',
  }));
  expect(session.sessionReady).toBe(true);
  expect(mockSocket.emit).toHaveBeenCalledWith('user:register', expect.objectContaining({
    authToken: 'synthetic-account-token', platform: 'mobile', clientVersion,
  }), expect.any(Function));
  const stored = [...mockValues.values()].join('');
  expect(stored).not.toContain(request.password);
  expect(stored).not.toContain(request.serverPassword);
  expect(stored).not.toContain('synthetic-access-grant');
});

test.each([
  [{ password: 'wrong-account-password' }, '邮箱或密码错误'],
  [{ serverPassword: 'wrong-server-password' }, '服务器访问密码错误'],
])('wrong credentials stay on login and never invoke post-login native DNS', async (overrides, message) => {
  await mount();
  await submit(overrides);
  expect(session.config).toBeNull();
  expect(session.authError).toBe(message);
  expect(mockResolveAddresses).not.toHaveBeenCalled();
  expect(mockSocket.connect).not.toHaveBeenCalled();
  expect(await readSessionConfig()).toBeNull();
});

test('domain DNS failure falls back to a host key without changing the connection URL', async () => {
  mockResolveAddresses.mockRejectedValue(new Error('Synthetic DNS failure'));
  await mount();
  await submit();
  expect(session.config?.serverKey).toBe('host:mobileqa.example.test:443');
  expect(session.config?.serverURL).toBe(base);
  expect(session.sessionReady).toBe(true);
});

test('IP login bypasses native DNS', async () => {
  await mount();
  await submit({ serverURL: 'https://192.0.2.10' });
  expect(mockResolveAddresses).not.toHaveBeenCalled();
  expect(session.config?.serverKey).toBe('ip:192.0.2.10|443');
  expect(session.sessionReady).toBe(true);
});

test('saved domain account survives an access-token recovery and reconnects after unlock', async () => {
  const saved = await saveSessionConfig({
    username: account.username, email: account.email, accountId: account.id,
    accountToken: 'synthetic-account-token', serverURL: base,
  });
  await mount();
  expect(session.config?.clientId).toBe(saved.clientId);
  await act(async () => mockListeners.get('connect_error')?.(Object.assign(new Error('请重新解锁'), {
    data: { code: 'SERVER_ACCESS_REQUIRED' },
  })));
  expect(session.config).toBeNull();
  expect((await readSessionConfig())?.accountToken).toBe('synthetic-account-token');
  await submit();
  expect(session.sessionReady).toBe(true);
  await act(async () => mockListeners.get('disconnect')?.());
  expect(session.sessionReady).toBe(false);
  await act(async () => mockListeners.get('connect')?.());
  expect(session.sessionReady).toBe(true);
});

test('unmount cancels the pending connection and removes Socket listeners', async () => {
  await saveSessionConfig({ username: account.username, email: account.email, accountId: account.id,
    accountToken: 'synthetic-account-token', serverURL: base, serverKey: 'host:mobileqa.example.test:443' });
  let release!: () => void;
  NativeModules.CoveNative.configureServerCertificate = jest.fn(() => new Promise<void>(resolve => { release = resolve; }));
  await mount();
  expect(mockSocket.connect).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
  await act(async () => release());
  expect(mockSocket.connect).not.toHaveBeenCalled();
  expect(mockListeners.size).toBe(0);
});

test('password memory requires explicit opt-in and stores only the authenticated account password natively', async () => {
  await mount();
  await submit({ rememberAccountPassword: true, email: ' MobileQA@Example.Test ' });
  expect(NativeModules.CoveAccountPasswords.save).toHaveBeenCalledWith(base, account.email, request.password);
  expect([...mockValues.values()].join('')).not.toContain(request.password);
  expect([...mockValues.values()].join('')).not.toContain(request.serverPassword);
  await act(async () => session.handleChangeServer());
  expect(mockPasswordValues.size).toBe(1);
  expect(session.lastServerURL).toBe(base);
});

test('default and failed logins never save passwords', async () => {
  await mount();
  await submit({ password: 'wrong-account-password', rememberAccountPassword: true });
  expect(NativeModules.CoveAccountPasswords.save).not.toHaveBeenCalled();
  await submit();
  expect(NativeModules.CoveAccountPasswords.save).not.toHaveBeenCalled();
});

test('cancelling memory while authentication is pending prevents a late successful login from restoring it', async () => {
  await mount();
  const originalFetch = globalThis.fetch;
  let release!: (value: Response) => void;
  globalThis.fetch = jest.fn((input, init) => String(input).endsWith('/api/auth/login')
    ? new Promise<Response>(resolve => { release = resolve; }) : originalFetch(input, init));
  let pending!: Promise<void>;
  await act(async () => { pending = session.handleLogin({ ...request, rememberAccountPassword: true }); });
  await removeAccountPassword(base, account.email);
  await act(async () => {
    release(response(200, { token: 'synthetic-account-token', account }));
    await pending;
  });
  expect(session.config?.accountId).toBe(account.id);
  expect(NativeModules.CoveAccountPasswords.save).not.toHaveBeenCalled();
});

test('unmount during authentication prevents any late session or password persistence', async () => {
  await mount();
  const originalFetch = globalThis.fetch;
  let release!: (value: Response) => void;
  globalThis.fetch = jest.fn((input, init) => String(input).endsWith('/api/auth/login')
    ? new Promise<Response>(resolve => { release = resolve; }) : originalFetch(input, init));
  let pending!: Promise<void>;
  await act(async () => { pending = session.handleLogin({ ...request, rememberAccountPassword: true }); });
  await act(async () => renderer.unmount());
  await act(async () => {
    release(response(200, { token: 'synthetic-account-token', account }));
    await pending;
  });
  expect(NativeModules.CoveAccountPasswords.save).not.toHaveBeenCalled();
  expect(await readSessionConfig()).toBeNull();
});

test('native storage failure reports a generic warning and still completes account login', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  NativeModules.CoveAccountPasswords.save.mockRejectedValue(new Error(request.password));
  await mount();
  await submit({ rememberAccountPassword: true });
  expect(session.config?.accountId).toBe(account.id);
  expect(alert).toHaveBeenCalledWith('密码记忆未确认', expect.any(String));
  expect(JSON.stringify(alert.mock.calls)).not.toContain(request.password);
  alert.mockRestore();
});

test('failed deletion after cancelling an in-flight native save remains visible when account login succeeds', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  let release!: (value: object) => void;
  NativeModules.CoveAccountPasswords.save.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  NativeModules.CoveAccountPasswords.remove.mockResolvedValue({ available: true, ok: false });
  await mount();
  let pending!: Promise<void>;
  await act(async () => { pending = session.handleLogin({ ...request, rememberAccountPassword: true }); });
  const removing = removeAccountPassword(base, account.email);
  await act(async () => {
    release({ available: true, ok: true, remembered: true });
    await pending;
    await removing;
  });
  expect(session.config?.accountId).toBe(account.id);
  expect(alert).toHaveBeenCalledWith('密码记忆未取消', expect.stringContaining('可能仍保存在本机'));
  alert.mockRestore();
});

test('last entered address survives failed login and return to the connection screen with its port and path', async () => {
  const address = 'https://mobileqa.example.test:8443/cove/';
  await mount();
  await submit({ serverURL: address, password: 'wrong-account-password' });
  expect(mockValues.get('cove_last_server_address')).toBe(address);
  expect(session.lastServerURL).toBe(address);
  await submit({ serverURL: address });
  await act(async () => session.handleChangeServer());
  expect(session.config).toBeNull();
  expect(session.lastServerURL).toBe(address);
  expect(mockValues.get('cove_last_server_address')).toBe(address);
});

test.each(['https://edited.example.test:8443/path/', ''])('manual address editing beats a delayed restore, including an explicit clear (%s)', async address => {
  let release!: (value: string) => void;
  mockDelayedAddressRead = new Promise(resolve => { release = resolve; });
  await mount();
  await act(async () => session.handleServerURLChange(address));
  await act(async () => { release('https://old.example.test'); });
  expect(session.lastServerURL).toBe(address);
  expect(mockValues.get('cove_last_server_address')).toBe(address);
});

test('forgetting a server removes all its remembered account passwords while preserving other server credentials', async () => {
  mockPasswordValues.set(JSON.stringify([base, account.email]), request.password);
  mockPasswordValues.set(JSON.stringify([base, 'second@example.test']), 'synthetic-second-account');
  mockPasswordValues.set(JSON.stringify(['https://another.example.test', account.email]), 'synthetic-other-server');
  const saved = await saveSessionConfig({ username: account.username, email: account.email,
    accountId: account.id, accountToken: 'synthetic-account-token', serverURL: base });
  await mount();
  await act(async () => session.handleChangeServer());
  await act(async () => session.handleForget(saved));
  expect(mockPasswordValues.size).toBe(1);
  expect(mockPasswordValues.has(JSON.stringify(['https://another.example.test', account.email]))).toBe(true);
  expect(session.rememberedServers).toEqual([]);
});
