import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SessionConfig } from './types';

const USERNAME_KEY = 'cove_username';
const SERVER_KEY = 'cove_server_url';
const CLIENT_ID_KEY = 'cove_client_id';

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
  const [storedName, storedServer, storedClientId] = await Promise.all([
    AsyncStorage.getItem(USERNAME_KEY),
    AsyncStorage.getItem(SERVER_KEY),
    AsyncStorage.getItem(CLIENT_ID_KEY),
  ]);
  const username = storedName?.trim() ?? '';
  const serverURL = normalizeServerURL(storedServer ?? '');
  let clientId = storedClientId ?? '';
  if (!clientId) {
    clientId = createClientId();
    await AsyncStorage.setItem(CLIENT_ID_KEY, clientId);
  }
  return username && serverURL ? { username, serverURL, clientId } : null;
}

export async function saveSessionConfig(username: string, serverURL: string): Promise<SessionConfig> {
  const current = await readSessionConfig();
  const clientId = current?.clientId || createClientId();
  const config = {
    username: username.trim().slice(0, 64),
    serverURL: normalizeServerURL(serverURL),
    clientId,
  };
  await Promise.all([
    AsyncStorage.setItem(USERNAME_KEY, config.username),
    AsyncStorage.setItem(SERVER_KEY, config.serverURL),
    AsyncStorage.setItem(CLIENT_ID_KEY, config.clientId),
  ]);
  return config;
}

export async function clearServerConfig() {
  await Promise.all([
    AsyncStorage.removeItem(USERNAME_KEY),
    AsyncStorage.removeItem(SERVER_KEY),
  ]);
}
