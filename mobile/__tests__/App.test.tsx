import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import App from '../App';
import { configureServerCertificate } from '../src/serverCertificate';
import { clearServerConfig } from '../src/storage';
import { clearServerAccessToken } from '../src/serverSecurity';

jest.mock('lucide-react-native', () => ({ WifiOff: 'WifiOff' }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('../src/screens/LoginScreen', () => ({ LoginScreen: 'LoginScreen' }));
jest.mock('../src/screens/RoomScreen', () => ({ RoomScreen: 'RoomScreen' }));
jest.mock('../src/screens/RoomListScreen', () => ({ RoomListScreen: 'RoomListScreen' }));
jest.mock('../src/storage', () => ({
  readSessionConfig: async () => ({ username: 'Alice', serverURL: 'https://example.test:51758', clientId: 'alice', accountToken: 'token', accountId: 'account', email: 'alice@example.test', allowInvalidServerCertificate: true }),
  clearServerConfig: jest.fn(), saveSessionConfig: jest.fn(),
  readRememberedServers: async () => [], forgetRememberedServer: jest.fn(),
}));
jest.mock('../src/accountAuth', () => ({ authenticateAccount: jest.fn() }));
jest.mock('../src/serverSecurity', () => ({
  getServerAccessToken: jest.fn(() => 'server-access-token'),
  clearServerAccessToken: jest.fn(),
  ensureServerAccess: jest.fn(),
  serverFetch: jest.fn(),
  requiresServerAccessRecovery: (code: unknown) => ['SERVER_NOT_INITIALIZED', 'SERVER_ACCESS_REQUIRED', 'SERVER_ACCESS_INVALID', 'INSECURE_TRANSPORT'].includes(String(code)),
}));
const mockSocket = { on: jest.fn(), off: jest.fn(), connect: jest.fn(), disconnect: jest.fn() };
jest.mock('../src/socket', () => ({ createCoveSocket: () => mockSocket }));
jest.mock('../src/serverCertificate', () => ({ configureServerCertificate: jest.fn() }));

beforeEach(() => { jest.clearAllMocks(); });

test('waits for native TLS configuration before connecting the saved server', async () => {
  let configured!: () => void;
  jest.mocked(configureServerCertificate).mockImplementation(() => new Promise(resolve => { configured = resolve; }));
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<App />); });
  expect(configureServerCertificate).toHaveBeenCalledWith('https://example.test:51758', true);
  expect(mockSocket.connect).not.toHaveBeenCalled();
  await act(async () => configured());
  expect(mockSocket.connect).toHaveBeenCalledTimes(1);
  await act(async () => renderer.unmount());
  expect(mockSocket.disconnect).toHaveBeenCalledTimes(1);
});

test('switching servers returns to login without revoking the saved session', async () => {
  jest.mocked(configureServerCertificate).mockResolvedValue(undefined);
  globalThis.fetch = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<App />); });
  const roomList = renderer.root.findByType('RoomListScreen' as any);
  await act(async () => roomList.props.onChangeServer());
  expect(clearServerConfig).toHaveBeenCalledWith({ forgetSession: false });
  expect(fetch).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType('LoginScreen' as any)).toHaveLength(1);
  await act(async () => renderer.unmount());
});

test('an active server access revocation returns the saved session to server unlock', async () => {
  jest.mocked(configureServerCertificate).mockResolvedValue(undefined);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<App />); });
  const handler = mockSocket.on.mock.calls.find(([event]) => event === 'server:access-invalid')?.[1];
  expect(handler).toBeInstanceOf(Function);
  await act(async () => handler({ code: 'SERVER_ACCESS_INVALID', message: '请重新验证服务器密码' }));
  expect(clearServerAccessToken).toHaveBeenCalledWith('https://example.test:51758');
  expect(renderer.root.findAllByType('LoginScreen' as any)).toHaveLength(1);
  expect(renderer.root.findByType('LoginScreen' as any).props.error).toBe('请重新验证服务器密码');
  await act(async () => renderer.unmount());
});
