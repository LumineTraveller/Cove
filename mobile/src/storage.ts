import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SessionConfig } from './types';
import { httpsOrigin } from './serverCertificate';

const USERNAME_KEY = 'cove_username';
const SERVER_KEY = 'cove_server_url';
const CLIENT_ID_KEY = 'cove_client_id';
const CERTIFICATE_ORIGIN_KEY = 'cove_certificate_exception_origin';

export function normalizeServerURL(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function createClientId(): string {
  const random = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join('-');
  return `mobile-${Date.now().toString(36)}-${random}`;
}

export async function readSessionConfig(): Promise<SessionConfig | null> {
  const [storedName, storedServer, storedClientId, certificateOrigin] = await Promise.all([
    AsyncStorage.getItem(USERNAME_KEY),
    AsyncStorage.getItem(SERVER_KEY),
    AsyncStorage.getItem(CLIENT_ID_KEY),
    AsyncStorage.getItem(CERTIFICATE_ORIGIN_KEY),
  ]);
  const username = storedName?.trim() ?? '';
  const serverURL = normalizeServerURL(storedServer ?? '');
  let clientId = storedClientId ?? '';
  if (!clientId) {
    clientId = createClientId();
    await AsyncStorage.setItem(CLIENT_ID_KEY, clientId);
  }
  return username && serverURL ? {
    username, serverURL, clientId,
    allowInvalidServerCertificate: !!certificateOrigin && certificateOrigin === httpsOrigin(serverURL),
  } : null;
}

export async function saveSessionConfig(username: string, serverURL: string, allowInvalidServerCertificate = false): Promise<SessionConfig> {
  const current = await readSessionConfig();
  const clientId = current?.clientId || createClientId();
  const config = {
    username: username.trim().slice(0, 64),
    serverURL: normalizeServerURL(serverURL),
    clientId,
    allowInvalidServerCertificate: allowInvalidServerCertificate && !!httpsOrigin(serverURL),
  };
  await Promise.all([
    AsyncStorage.setItem(USERNAME_KEY, config.username),
    AsyncStorage.setItem(SERVER_KEY, config.serverURL),
    AsyncStorage.setItem(CLIENT_ID_KEY, config.clientId),
    config.allowInvalidServerCertificate
      ? AsyncStorage.setItem(CERTIFICATE_ORIGIN_KEY, httpsOrigin(config.serverURL)!)
      : AsyncStorage.removeItem(CERTIFICATE_ORIGIN_KEY),
  ]);
  return config;
}

export async function clearServerConfig() {
  await Promise.all([
    AsyncStorage.removeItem(USERNAME_KEY),
    AsyncStorage.removeItem(SERVER_KEY),
    AsyncStorage.removeItem(CERTIFICATE_ORIGIN_KEY),
  ]);
}
