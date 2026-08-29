export type AccountAuthMode = 'login' | 'register';

export interface AccountAuthRequest {
  mode: AccountAuthMode;
  username: string;
  email: string;
  password: string;
  serverURL: string;
  allowInvalidServerCertificate: boolean;
}

interface AuthResponse {
  token: string;
  account: {
    id: string;
    email: string;
    username: string;
    avatarUrl: string | null;
  };
}

export const validAccountEmail = (email: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && email.trim().length <= 254;

function normalizeServerURL(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export async function authenticateAccount(request: AccountAuthRequest): Promise<AuthResponse> {
  const serverURL = normalizeServerURL(request.serverURL);
  const response = await fetch(`${serverURL}/api/auth/${request.mode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request.mode === 'register'
      ? { email: request.email.trim(), password: request.password, username: request.username.trim() }
      : { email: request.email.trim(), password: request.password }),
  });
  const payload = await response.json().catch(() => ({})) as Partial<AuthResponse> & { error?: string };
  if (!response.ok || !payload.token || !payload.account) {
    throw new Error(payload.error || `账号请求失败（HTTP ${response.status}）`);
  }
  return payload as AuthResponse;
}
