import type { UserProfile } from './types';

const SESSION_KEY = 'cove_account_session';

export interface AccountSession {
  serverUrl: string;
  token: string;
  accountId: string;
  email: string;
}

interface AuthResponse {
  token: string;
  account: UserProfile & { id: string; email: string };
}

export const validAccountEmail = (email: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && email.trim().length <= 254;

export function readAccountSession(serverUrl?: string): AccountSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as AccountSession | null;
    if (!value?.token || !value.accountId || !value.serverUrl) return null;
    return serverUrl && value.serverUrl !== serverUrl ? null : value;
  } catch { return null; }
}

export function clearAccountSession() {
  localStorage.removeItem(SESSION_KEY);
}

async function authRequest(serverUrl: string, endpoint: 'register' | 'login', body: Record<string, string>) {
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
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return { session, profile: { username: payload.account.username, avatarUrl: payload.account.avatarUrl } };
}

export const registerAccount = (serverUrl: string, email: string, password: string, username: string) =>
  authRequest(serverUrl, 'register', { email: email.trim(), password, username: username.trim() });

export const loginAccount = (serverUrl: string, email: string, password: string) =>
  authRequest(serverUrl, 'login', { email: email.trim(), password });

