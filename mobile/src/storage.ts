import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SessionConfig } from './types';
import { httpsOrigin } from './serverCertificate';
import { resolveServerIdentity } from './serverIdentity';

const USERNAME_KEY = 'cove_username';
const SERVER_KEY = 'cove_server_url';
const CLIENT_ID_KEY = 'cove_client_id';
const CERTIFICATE_ORIGIN_KEY = 'cove_certificate_exception_origin';
const ACCOUNT_TOKEN_KEY = 'cove_account_token';
const ACCOUNT_ID_KEY = 'cove_account_id';
const ACCOUNT_EMAIL_KEY = 'cove_account_email';
const SERVER_IDENTITY_KEY = 'cove_server_identity';
const REMEMBERED_SERVERS_KEY = 'cove_remembered_servers';
export type RememberedServer = Omit<SessionConfig, 'accountToken'> & { accountToken?: string };

export async function readRememberedServers(): Promise<RememberedServer[]> {
  try {
    const values = JSON.parse(await AsyncStorage.getItem(REMEMBERED_SERVERS_KEY) ?? '[]');
    return Array.isArray(values) ? values.flatMap(value => {
      if (typeof value?.serverURL !== 'string' || !normalizeServerURL(value.serverURL) || typeof value.email !== 'string' || typeof value.username !== 'string' || typeof value.accountId !== 'string' || typeof value.clientId !== 'string') return [];
      const serverURL = normalizeServerURL(value.serverURL);
      return [{
        username: value.username,
        serverURL,
        clientId: value.clientId,
        accountId: value.accountId,
        email: value.email,
        ...(typeof value.accountToken === 'string' && value.accountToken ? { accountToken: value.accountToken } : {}),
        ...(typeof value.serverKey === 'string' && value.serverKey ? { serverKey: value.serverKey } : {}),
        allowInvalidServerCertificate: value.allowInvalidServerCertificate === true,
      }];
    }) : [];
  } catch { return []; }
}

async function rememberServer(config: SessionConfig) {
  const identity = config.serverKey ? { key: config.serverKey } : await resolveServerIdentity(config.serverURL);
  const previous = await Promise.all((await readRememberedServers()).map(async entry => {
    const key = entry.serverKey ?? (await resolveServerIdentity(entry.serverURL)).key;
    return { entry: entry.serverKey ? entry : { ...entry, serverKey: key }, key };
  }));
  const filtered = previous.filter(item => item.key !== identity.key && item.entry.serverURL !== config.serverURL).map(item => item.entry);
  await AsyncStorage.setItem(REMEMBERED_SERVERS_KEY, JSON.stringify([{ ...config, serverKey: identity.key }, ...filtered].slice(0, 8)));
}

export async function forgetRememberedServer(serverURL: string) {
  const normalized = normalizeServerURL(serverURL);
  const previous = await readRememberedServers();
  await AsyncStorage.setItem(REMEMBERED_SERVERS_KEY, JSON.stringify(previous.filter(entry => entry.serverURL !== normalized)));
}

export async function forgetRememberedServerToken(serverURL: string) {
  const normalized = normalizeServerURL(serverURL);
  const history = await readRememberedServers();
  await AsyncStorage.setItem(REMEMBERED_SERVERS_KEY, JSON.stringify(history.map(entry =>
    entry.serverURL === normalized ? { ...entry, accountToken: undefined } : entry)));
}

export function normalizeServerURL(value: string): string {
  try {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return '';
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return ''; }
}

function createClientId(): string {
  const random = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join('-');
  return `mobile-${Date.now().toString(36)}-${random}`;
}

export async function readSessionConfig(): Promise<SessionConfig | null> {
  const [storedName, storedServer, storedClientId, certificateOrigin, accountToken, accountId, email, serverKey] = await Promise.all([
    AsyncStorage.getItem(USERNAME_KEY),
    AsyncStorage.getItem(SERVER_KEY),
    AsyncStorage.getItem(CLIENT_ID_KEY),
    AsyncStorage.getItem(CERTIFICATE_ORIGIN_KEY),
    AsyncStorage.getItem(ACCOUNT_TOKEN_KEY),
    AsyncStorage.getItem(ACCOUNT_ID_KEY),
    AsyncStorage.getItem(ACCOUNT_EMAIL_KEY),
    AsyncStorage.getItem(SERVER_IDENTITY_KEY),
  ]);
  const username = storedName?.trim() ?? '';
  const serverURL = normalizeServerURL(storedServer ?? '');
  let clientId = storedClientId ?? '';
  if (!clientId) {
    clientId = createClientId();
    await AsyncStorage.setItem(CLIENT_ID_KEY, clientId);
  }
  const config = username && serverURL && accountToken && accountId && email ? {
    username, serverURL, clientId, accountToken, accountId, email, ...(serverKey ? { serverKey } : {}),
    allowInvalidServerCertificate: !!certificateOrigin && certificateOrigin === httpsOrigin(serverURL),
  } : null;
  if (config) await rememberServer(config);
  return config;
}

export async function saveSessionConfig(input: {
  username: string;
  serverURL: string;
  accountToken: string;
  accountId: string;
  email: string;
  serverKey?: string;
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
    ...(input.serverKey ? { serverKey: input.serverKey } : {}),
    allowInvalidServerCertificate: input.allowInvalidServerCertificate === true && !!httpsOrigin(input.serverURL),
  };
  await Promise.all([
    AsyncStorage.setItem(USERNAME_KEY, config.username),
    AsyncStorage.setItem(SERVER_KEY, config.serverURL),
    AsyncStorage.setItem(CLIENT_ID_KEY, config.clientId),
    AsyncStorage.setItem(ACCOUNT_TOKEN_KEY, config.accountToken),
    AsyncStorage.setItem(ACCOUNT_ID_KEY, config.accountId),
    AsyncStorage.setItem(ACCOUNT_EMAIL_KEY, config.email),
    config.serverKey
      ? AsyncStorage.setItem(SERVER_IDENTITY_KEY, config.serverKey)
      : AsyncStorage.removeItem(SERVER_IDENTITY_KEY),
    config.allowInvalidServerCertificate
      ? AsyncStorage.setItem(CERTIFICATE_ORIGIN_KEY, httpsOrigin(config.serverURL)!)
      : AsyncStorage.removeItem(CERTIFICATE_ORIGIN_KEY),
  ]);
  await rememberServer(config);
  return config;
}

export async function clearServerConfig({ forgetSession = true }: { forgetSession?: boolean } = {}) {
  const active = await readSessionConfig();
  if (forgetSession && active) {
    await forgetRememberedServerToken(active.serverURL);
  }
  await Promise.all([
    AsyncStorage.removeItem(USERNAME_KEY),
    AsyncStorage.removeItem(SERVER_KEY),
    AsyncStorage.removeItem(CERTIFICATE_ORIGIN_KEY),
    AsyncStorage.removeItem(ACCOUNT_TOKEN_KEY),
    AsyncStorage.removeItem(ACCOUNT_ID_KEY),
    AsyncStorage.removeItem(ACCOUNT_EMAIL_KEY),
    AsyncStorage.removeItem(SERVER_IDENTITY_KEY),
  ]);
}
