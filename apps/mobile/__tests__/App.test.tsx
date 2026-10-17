import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { NativeModules, Platform } from 'react-native';
import App from '../App';
import { configureServerCertificate } from '../src/features/connection/serverCertificate';
import { clearServerConfig } from '../src/features/settings/storage';
import { clearAllServerAccessTokens, clearServerAccessToken, readServerSecurityStatus } from '../src/features/connection/serverSecurity';

const mockGrantValues = new Map<string, string>();

jest.mock('lucide-react-native', () => ({ WifiOff: 'WifiOff' }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('../src/features/accounts/screens/LoginScreen', () => ({ LoginScreen: 'LoginScreen' }));
jest.mock('../src/features/rooms/screens/RoomScreen', () => ({ RoomScreen: 'RoomScreen' }));
jest.mock('../src/features/rooms/screens/RoomListScreen', () => ({ RoomListScreen: 'RoomListScreen' }));
jest.mock('../src/features/updates/components/MobileUpdater', () => {
  const selectServer = jest.fn();
  return {
    MobileUpdateProvider: ({ children }: { children: React.ReactNode }) => children,
    useMobileUpdateServerSelection: () => selectServer,
  };
});
jest.mock('../src/features/settings/storage', () => ({
  ...jest.requireActual('../src/features/settings/storage'),
  readSessionConfig: async () => ({ username: 'Alice', serverURL: 'https://example.test:51758', clientId: 'alice', accountToken: 'token', accountId: 'account', email: 'alice@example.test', allowInvalidServerCertificate: true }),
  clearServerConfig: jest.fn(), saveSessionConfig: jest.fn(),
  readRememberedServers: async () => [], forgetRememberedServer: jest.fn(),
  readLastServerAddress: async () => 'https://example.test:51758',
  saveLastServerAddress: jest.fn(async (value: string) => value),
}));
jest.mock('../src/features/accounts/accountAuth', () => ({ authenticateAccount: jest.fn() }));
jest.mock('../src/features/connection/serverSecurity', () => {
  const security = jest.requireActual('../src/features/connection/serverSecurity');
  return {
    ...security,
    clearServerAccessToken: jest.fn(security.clearServerAccessToken),
    readServerSecurityStatus: jest.fn(async (serverURL: string) => ({
      enabled: true, configured: true, bootstrapAvailable: false, tokenEpoch: 1,
      authorized: security.getServerAccessToken(serverURL) === 'synthetic-server-access-token',
      secureTransportRequired: false,
    })),
    serverFetch: jest.fn(async () => ({ ok: true, json: async () => ({ serverVersion: '2.0.0', minimumClientVersion: '0.8.0', upgradeRequired: false }) })),
  };
});
const mockSocket = { on: jest.fn(), off: jest.fn(), connect: jest.fn(), disconnect: jest.fn() };
jest.mock('../src/features/connection/socket', () => ({ createCoveSocket: () => mockSocket }));
jest.mock('../src/features/connection/serverCertificate', () => ({ configureServerCertificate: jest.fn() }));

const originalPlatform = Platform.OS;
const originalFetch = globalThis.fetch;
const originalGrantStore = NativeModules.CoveServerAccessGrants;
let renderer: TestRenderer.ReactTestRenderer | undefined;

beforeEach(() => {
  clearAllServerAccessTokens();
  jest.clearAllMocks();
  jest.mocked(configureServerCertificate).mockReset().mockResolvedValue(undefined);
  Platform.OS = 'android';
  mockGrantValues.clear();
  const now = Date.now();
  mockGrantValues.set(JSON.stringify(['https://example.test:51758', 'alice@example.test']), JSON.stringify({
    accessToken: 'synthetic-server-access-token', verifiedAt: now, lastObservedAt: now,
    expiresAt: now + 14 * 24 * 60 * 60 * 1000,
  }));
  NativeModules.CoveServerAccessGrants = {
    get: jest.fn(async (server: string, email: string) => ({ available: true, ok: true, value: mockGrantValues.get(JSON.stringify([server, email])) ?? null })),
    save: jest.fn(async (server: string, email: string, value: string) => { mockGrantValues.set(JSON.stringify([server, email]), value); return { available: true, ok: true }; }),
    remove: jest.fn(async (server: string, email: string) => { mockGrantValues.delete(JSON.stringify([server, email])); return { available: true, ok: true }; }),
    clear: jest.fn(async () => { mockGrantValues.clear(); return { available: true, ok: true }; }),
  };
});

const unmount = async () => {
  const mountedRenderer = renderer;
  renderer = undefined;
  if (mountedRenderer) await act(async () => mountedRenderer.unmount());
};

afterEach(async () => {
  await unmount();
  Platform.OS = originalPlatform;
  globalThis.fetch = originalFetch;
  NativeModules.CoveServerAccessGrants = originalGrantStore;
});

test('waits for native TLS configuration before connecting the saved server', async () => {
  let startupConfigured!: () => void;
  let socketConfigured!: () => void;
  jest.mocked(configureServerCertificate)
    .mockImplementationOnce(() => new Promise(resolve => { startupConfigured = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { socketConfigured = resolve; }));
  await act(async () => { renderer = TestRenderer.create(<App />); });
  expect(configureServerCertificate).toHaveBeenCalledWith('https://example.test:51758', true);
  expect(readServerSecurityStatus).not.toHaveBeenCalled();
  expect(mockSocket.connect).not.toHaveBeenCalled();
  await act(async () => startupConfigured());
  expect(NativeModules.CoveServerAccessGrants.get).toHaveBeenCalledWith('https://example.test:51758', 'alice@example.test');
  expect(readServerSecurityStatus).toHaveBeenCalledWith('https://example.test:51758');
  expect(configureServerCertificate).toHaveBeenCalledTimes(2);
  expect(mockSocket.connect).not.toHaveBeenCalled();
  await act(async () => socketConfigured());
  expect(mockSocket.connect).toHaveBeenCalledTimes(1);
  await unmount();
  expect(mockSocket.disconnect).toHaveBeenCalledTimes(1);
});

test('switching servers returns to login without revoking the saved session', async () => {
  jest.mocked(configureServerCertificate).mockResolvedValue(undefined);
  globalThis.fetch = jest.fn();
  await act(async () => { renderer = TestRenderer.create(<App />); });
  const roomList = renderer!.root.findByType('RoomListScreen' as any);
  await act(async () => roomList.props.onChangeServer());
  expect(clearServerConfig).toHaveBeenCalledWith({ forgetSession: false });
  expect(fetch).not.toHaveBeenCalled();
  expect(renderer!.root.findAllByType('LoginScreen' as any)).toHaveLength(1);
});

test('an active server access revocation returns the saved session to server unlock', async () => {
  jest.mocked(configureServerCertificate).mockResolvedValue(undefined);
  await act(async () => { renderer = TestRenderer.create(<App />); });
  const handler = mockSocket.on.mock.calls.find(([event]) => event === 'server:access-invalid')?.[1];
  expect(handler).toBeInstanceOf(Function);
  await act(async () => handler({ code: 'SERVER_ACCESS_INVALID', message: '请重新验证服务器密码' }));
  expect(clearServerAccessToken).toHaveBeenCalledWith('https://example.test:51758');
  expect(renderer!.root.findAllByType('LoginScreen' as any)).toHaveLength(1);
  expect(renderer!.root.findByType('LoginScreen' as any).props.error).toBe('请重新验证服务器密码');
});
