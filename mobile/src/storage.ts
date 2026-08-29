import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SessionConfig } from './types';
import { httpsOrigin } from './serverCertificate';

const USERNAME_KEY = 'cove_username';
const SERVER_KEY = 'cove_server_url';
const CLIENT_ID_KEY = 'cove_client_id';
const CERTIFICATE_ORIGIN_KEY = 'cove_certificate_exception_origin';
const ACCOUNT_TOKEN_KEY = 'cove_account_token';
const ACCOUNT_ID_KEY = 'cove_account_id';
const ACCOUNT_EMAIL_KEY = 'cove_account_email';

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
  const [storedName, storedServer, storedClientId, certificateOrigin, accountToken, accountId, email] = await Promise.all([
    AsyncStorage.getItem(USERNAME_KEY),
    AsyncStorage.getItem(SERVER_KEY),
    AsyncStorage.getItem(CLIENT_ID_KEY),
    AsyncStorage.getItem(CERTIFICATE_ORIGIN_KEY),
    AsyncStorage.getItem(ACCOUNT_TOKEN_KEY),
    AsyncStorage.getItem(ACCOUNT_ID_KEY),
    AsyncStorage.getItem(ACCOUNT_EMAIL_KEY),
  ]);
  const username = storedName?.trim() ?? '';
  const serverURL = normalizeServerURL(storedServer ?? '');
  let clientId = storedClientId ?? '';
  if (!clientId) {
    clientId = createClientId();
    await AsyncStorage.setItem(CLIENT_ID_KEY, clientId);
  }
  return username && serverURL && accountToken && accountId && email ? {
    username, serverURL, clientId, accountToken, accountId, email,
    allowInvalidServerCertificate: !!certificateOrigin && certificateOrigin === httpsOrigin(serverURL),
  } : null;
}

export async function saveSessionConfig(input: {
  username: string;
  serverURL: string;
  accountToken: string;
  accountId: string;
  email: string;
  allowInvalidServerCertificate?: boolean;
}): Promise<SessionConfig> {
  const clientId = await AsyncStorage.getItem(CLIENT_ID_KEY) || createClientId();
  const config = {
    username: input.username.trim().slice(0, 64),
    serverURL: normalizeServerURL(input.serverURL),
    clientId,
    accountToken: input.accountToken,
    accountId: input.accountId,
    email: input.email.trim().toLowerCase(),
    allowInvalidServerCertificate: input.allowInvalidServerCertificate === true && !!httpsOrigin(input.serverURL),
  };
  await Promise.all([
    AsyncStorage.setItem(USERNAME_KEY, config.username),
    AsyncStorage.setItem(SERVER_KEY, config.serverURL),
    AsyncStorage.setItem(CLIENT_ID_KEY, config.clientId),
    AsyncStorage.setItem(ACCOUNT_TOKEN_KEY, config.accountToken),
    AsyncStorage.setItem(ACCOUNT_ID_KEY, config.accountId),
    AsyncStorage.setItem(ACCOUNT_EMAIL_KEY, config.email),
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
    AsyncStorage.removeItem(ACCOUNT_TOKEN_KEY),
    AsyncStorage.removeItem(ACCOUNT_ID_KEY),
    AsyncStorage.removeItem(ACCOUNT_EMAIL_KEY),
  ]);
}
