import type { UserProfile } from './types';
import { profileForStorage, readProfile } from './profile';

const SESSION_KEY = 'cove_account_session';
const HISTORY_KEY = 'cove_remembered_logins';

export interface AccountSession {
  serverUrl: string;
  token: string;
  accountId: string;
  email: string;
  profile?: UserProfile;
  allowInvalidServerCertificate?: boolean;
}

export type RememberedLogin = Omit<AccountSession, 'token'> & { token?: string };

export function normalizeLoginServer(value: string): string {
  try {
    const candidate = value.trim();
    if (!candidate) return '';
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(candidate) && !/^https?:\/\//i.test(candidate)) return '';
    const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `http://${candidate}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return ''; }
}

function legacySession(): AccountSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
    if (typeof value?.token !== 'string' || !value.token || typeof value.accountId !== 'string' || typeof value.email !== 'string' || typeof value.serverUrl !== 'string') return null;
    const serverUrl = normalizeLoginServer(value.serverUrl);
    const profile = value.profile && typeof value.profile.username === 'string'
      ? profileForStorage({
        username: value.profile.username,
        avatarUrl: typeof value.profile.avatarUrl === 'string' ? value.profile.avatarUrl : null,
      })
      : readProfile();
    return serverUrl ? { ...value, serverUrl, profile } : null;
  } catch { return null; }
}

export function readRememberedLogins(): RememberedLogin[] {
  let entries: RememberedLogin[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    if (Array.isArray(parsed)) entries = parsed
      .filter(value => typeof value?.serverUrl === 'string' && normalizeLoginServer(value.serverUrl) === value.serverUrl && typeof value.email === 'string' && typeof value.accountId === 'string')
      .map(value => value.profile && typeof value.profile.username === 'string'
        ? { ...value, profile: profileForStorage({ username: value.profile.username, avatarUrl: typeof value.profile.avatarUrl === 'string' ? value.profile.avatarUrl : null }) }
        : value);
  } catch { /* Keep the current login usable if history is damaged. */ }
  const current = legacySession();
  if (current && !entries.some(entry => entry.serverUrl === current.serverUrl)) {
    entries = [current, ...entries].slice(0, 8);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
    } catch {
      // A legacy session may contain a large avatar. It remains usable as the
      // active session; history persistence is best effort only.
    }
  }
  return entries;
}

export function rememberAccountSession(session: AccountSession) {
  const serverUrl = normalizeLoginServer(session.serverUrl);
  if (!serverUrl) throw new Error('服务器地址无效');
  // Whitelist persisted fields: never store a login form or its password.
  const saved: AccountSession = { serverUrl, token: session.token, accountId: session.accountId, email: session.email,
    profile: session.profile ? profileForStorage(session.profile) : undefined,
    allowInvalidServerCertificate: session.allowInvalidServerCertificate === true };
  const history = readRememberedLogins().filter(entry => entry.serverUrl !== serverUrl);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify([saved, ...history].slice(0, 8)));
    localStorage.setItem(SESSION_KEY, JSON.stringify(saved));
  } catch {
    // Keep the active login recoverable even if old history consumed most of
    // the quota. Large animated avatar data is deliberately not persisted.
    const compact = saved.profile
      ? { ...saved, profile: { ...saved.profile, avatarUrl: null } }
      : saved;
    try {
      localStorage.removeItem(HISTORY_KEY);
      localStorage.setItem(HISTORY_KEY, JSON.stringify([compact]));
      localStorage.setItem(SESSION_KEY, JSON.stringify(compact));
    } catch {
      // The current in-memory session is still valid until the window closes.
    }
  }
}

interface AuthResponse {
  token: string;
  account: UserProfile & { id: string; email: string };
}

export const validAccountEmail = (email: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && email.trim().length <= 254;

export function readAccountSession(serverUrl?: string): AccountSession | null {
  const current = legacySession();
  if (!serverUrl) return current;
  const normalized = normalizeLoginServer(serverUrl);
  if (!normalized) return null;
  if (current?.serverUrl === normalized) return current;
  const remembered = readRememberedLogins().find(entry => entry.serverUrl === normalized);
  return remembered && typeof remembered.token === 'string' && remembered.token ? remembered as AccountSession : null;
}

export function clearAccountSession(serverUrl = legacySession()?.serverUrl) {
  const history = readRememberedLogins();
  const normalized = normalizeLoginServer(serverUrl ?? '');
  if (!normalized || legacySession()?.serverUrl === normalized) localStorage.removeItem(SESSION_KEY);
  const safeHistory = history.map(entry => entry.profile ? { ...entry, profile: profileForStorage(entry.profile) } : entry);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(safeHistory.map(entry => entry.serverUrl === normalized ? { ...entry, token: undefined } : entry)));
  } catch {
    // Removing the active token is more important than preserving history.
  }
}

export function forgetRememberedLogin(serverUrl: string) {
  const normalized = normalizeLoginServer(serverUrl);
  const history = readRememberedLogins().filter(entry => entry.serverUrl !== normalized);
  if (legacySession()?.serverUrl === normalized) localStorage.removeItem(SESSION_KEY);
  const safeHistory = history.map(entry => entry.profile ? { ...entry, profile: profileForStorage(entry.profile) } : entry);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(safeHistory));
  } catch {
    // The current session has already been removed; history is best effort.
  }
}

export function disconnectAccountSession() {
  readRememberedLogins(); // Migrate a legacy active session before disconnecting it.
  localStorage.removeItem(SESSION_KEY);
}

async function authRequest(serverUrl: string, endpoint: 'register' | 'login', body: Record<string, string>) {
  serverUrl = normalizeLoginServer(serverUrl);
  if (!serverUrl) throw new Error('服务器地址无效');
  const response = await fetch(`${serverUrl}/api/auth/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as Partial<AuthResponse> & { error?: string };
  if (!response.ok || !payload.token || !payload.account)
    throw new Error(payload.error || `账号请求失败（HTTP ${response.status}）`);
  const session: AccountSession = {
    serverUrl,
    token: payload.token,
    accountId: payload.account.id,
    email: payload.account.email,
    profile: { username: payload.account.username, avatarUrl: payload.account.avatarUrl },
  };
  rememberAccountSession(session);
  return { session, profile: { username: payload.account.username, avatarUrl: payload.account.avatarUrl } };
}

export const registerAccount = (serverUrl: string, email: string, password: string, username: string) =>
  authRequest(serverUrl, 'register', { email: email.trim(), password, username: username.trim() });

export const loginAccount = (serverUrl: string, email: string, password: string) =>
  authRequest(serverUrl, 'login', { email: email.trim(), password });
