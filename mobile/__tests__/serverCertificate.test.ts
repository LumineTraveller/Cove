import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { configureServerCertificate, httpsOrigin } from '../src/serverCertificate';
import { clearServerConfig, readSessionConfig, saveSessionConfig } from '../src/storage';

jest.mock('@react-native-async-storage/async-storage', () => {
  const values = new Map<string, string>();
  return {
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { values.set(key, value); }),
    removeItem: jest.fn(async (key: string) => { values.delete(key); }),
    clear: jest.fn(async () => values.clear()),
  };
});

beforeEach(async () => { Platform.OS = 'android'; await AsyncStorage.clear(); NativeModules.CoveNative = { configureServerCertificate: jest.fn(async () => {}) }; });

test('HTTPS origin canonicalizes scheme/host/port and rejects other schemes or credentials', () => {
  expect(httpsOrigin(' HTTPS://Example.com:443/api/rooms ')).toBe('https://example.com');
  expect(httpsOrigin('https://example.com:51758')).toBe('https://example.com:51758');
  for (const url of ['http://example.com', 'wss://example.com', 'invalid', 'https://name:pass@example.com']) expect(httpsOrigin(url)).toBeNull();
});

test('native policy is awaited and never enabled for HTTP', async () => {
  await configureServerCertificate('https://example.com:51758/path', true);
  expect(NativeModules.CoveNative.configureServerCertificate).toHaveBeenLastCalledWith('https://example.com:51758', true);
  await configureServerCertificate('http://example.com:51758', true);
  expect(NativeModules.CoveNative.configureServerCertificate).toHaveBeenLastCalledWith('', false);
});

test('exception defaults off and survives restart only for the saved origin', async () => {
  await saveSessionConfig('Alice', 'https://example.com:51758');
  expect((await readSessionConfig())?.allowInvalidServerCertificate).toBe(false);
  await saveSessionConfig('Alice', 'https://example.com:51758', true);
  expect((await readSessionConfig())?.allowInvalidServerCertificate).toBe(true);
  await AsyncStorage.setItem('cove_server_url', 'https://example.com:51759');
  expect((await readSessionConfig())?.allowInvalidServerCertificate).toBe(false);
  await clearServerConfig();
  expect(await AsyncStorage.getItem('cove_certificate_exception_origin')).toBeNull();
});

test('missing native support fails explicitly instead of claiming TLS policy is configured', async () => {
  NativeModules.CoveNative = undefined;
  await expect(configureServerCertificate('https://example.com', true)).rejects.toThrow('当前安装包不支持');
  await expect(configureServerCertificate('https://example.com', false)).resolves.toBeUndefined();
});
