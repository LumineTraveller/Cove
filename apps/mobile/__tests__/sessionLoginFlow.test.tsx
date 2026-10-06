import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { NativeModules } from 'react-native';
import { useCoveSession } from '../src/features/connection/useCoveSession';
import { clearServerAccessToken } from '../src/features/connection/serverSecurity';
import { readSessionConfig, saveSessionConfig } from '../src/features/settings/storage';
import type { AccountAuthRequest } from '../src/features/accounts/accountAuth';

const mockValues = new Map<string, string>();
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
  getItem: async (key: string) => mockValues.get(key) ?? null,
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
  jest.clearAllMocks();
  mockValues.clear();
  mockListeners.clear();
  mockSocket.connected = false;
  clearServerAccessToken(base);
  mockResolveAddresses.mockResolvedValue(['192.0.2.10', '2001:db8::10']);
  NativeModules.CoveNative = {
    configureServerCertificate: jest.fn(async () => undefined),
    resolveServerAddresses: mockResolveAddresses,
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
    authToken: 'synthetic-account-token', platform: 'mobile', clientVersion: '0.8.0',
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
