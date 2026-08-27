import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import App from '../App';
import { configureServerCertificate } from '../src/serverCertificate';

jest.mock('lucide-react-native', () => ({ WifiOff: 'WifiOff' }));
jest.mock('../src/screens/LoginScreen', () => ({ LoginScreen: 'LoginScreen' }));
jest.mock('../src/screens/RoomScreen', () => ({ RoomScreen: 'RoomScreen' }));
jest.mock('../src/screens/RoomListScreen', () => ({ RoomListScreen: 'RoomListScreen' }));
jest.mock('../src/storage', () => ({
  readSessionConfig: async () => ({ username: 'Alice', serverURL: 'https://example.test:51758', clientId: 'alice', allowInvalidServerCertificate: true }),
  clearServerConfig: jest.fn(), saveSessionConfig: jest.fn(),
}));
const mockSocket = { on: jest.fn(), off: jest.fn(), connect: jest.fn(), disconnect: jest.fn() };
jest.mock('../src/socket', () => ({ createCoveSocket: () => mockSocket }));
jest.mock('../src/serverCertificate', () => ({ configureServerCertificate: jest.fn() }));

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
