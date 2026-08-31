import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import App from '../App';
import { configureServerCertificate } from '../src/serverCertificate';
import { clearServerConfig } from '../src/storage';

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
