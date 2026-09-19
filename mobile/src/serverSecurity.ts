export const CLIENT_PROTOCOL_VERSION = 2;

export type ServerSecurityErrorCode =
  | 'INVALID_PASSWORD'
  | 'INVALID_BOOTSTRAP'
  | 'SERVER_NOT_INITIALIZED'
  | 'SERVER_ALREADY_INITIALIZED'
  | 'SERVER_ACCESS_REQUIRED'
  | 'SERVER_ACCESS_INVALID'
  | 'SERVER_SECURITY_DISABLED'
  | 'CLIENT_VERSION_TOO_OLD'
  | 'INSECURE_TRANSPORT'
  | 'BOOTSTRAP_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INVALID_REQUEST'
  | 'SECURITY_UNAVAILABLE'
  | 'BOOTSTRAP_REQUIRED';

export interface ServerSecurityStatus {
  enabled: boolean;
  configured: boolean;
  bootstrapAvailable: boolean;
  tokenEpoch: number;
  authorized: boolean;
  secureTransportRequired: boolean;
}

export interface ServerAccessGrant {
  accessToken: string;
  expiresAt: number;
}

export class ServerSecurityClientError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: ServerSecurityErrorCode | string) {
    super(message);
    this.name = 'ServerSecurityClientError';
  }
}

const SERVER_ACCESS_RECOVERY_CODES = new Set<ServerSecurityErrorCode>([
  'SERVER_NOT_INITIALIZED',
  'SERVER_ACCESS_REQUIRED',
  'SERVER_ACCESS_INVALID',
  'INSECURE_TRANSPORT',
]);

export function requiresServerAccessRecovery(code: unknown): boolean {
  return typeof code === 'string' && SERVER_ACCESS_RECOVERY_CODES.has(code as ServerSecurityErrorCode);
}

// Keep the bearer token only for the current process. Account credentials and
// server addresses can be remembered; the server-wide unlock token cannot.
const accessTokens = new Map<string, ServerAccessGrant>();

export function normalizeServerSecurityURL(value: string): string {
  try {
    const candidate = value.trim();
    if (!candidate) return '';
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(candidate) && !/^https?:\/\//i.test(candidate)) return '';
    const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `http://${candidate}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return ''; }
}

const keyFor = (serverURL: string) => normalizeServerSecurityURL(serverURL);

export function getServerAccessGrant(serverURL: string): ServerAccessGrant | null {
  const key = keyFor(serverURL);
  if (!key) return null;
  const grant = accessTokens.get(key);
  if (!grant || grant.expiresAt <= Date.now()) {
    accessTokens.delete(key);
    return null;
  }
  return grant;
}

export function getServerAccessToken(serverURL: string): string | null {
  return getServerAccessGrant(serverURL)?.accessToken ?? null;
}

export function setServerAccessToken(serverURL: string, grant: ServerAccessGrant): void {
  const key = keyFor(serverURL);
  if (key && grant.accessToken && Number.isFinite(grant.expiresAt)) accessTokens.set(key, grant);
}

export function clearServerAccessToken(serverURL: string): void {
  const key = keyFor(serverURL);
  if (key) accessTokens.delete(key);
}

function requestURL(serverURL: string, target: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  return `${serverURL.replace(/\/+$/, '')}/${target.replace(/^\/+/, '')}`;
}

export function serverRequestInit(serverURL: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('X-Cove-Client-Protocol', String(CLIENT_PROTOCOL_VERSION));
  const token = getServerAccessToken(serverURL);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

export function serverFetch(serverURL: string, target: string, init: RequestInit = {}): Promise<Response> {
  return fetch(requestURL(serverURL, target), serverRequestInit(serverURL, init));
}

export function authorizedResourceURL(serverURL: string, target: string): string {
  const url = requestURL(serverURL, target);
  const token = getServerAccessToken(serverURL);
  if (!token) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('access_token', token);
    return parsed.toString();
  } catch { return url; }
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  return await response.json().catch(() => ({})) as Record<string, unknown>;
}

async function assertResponse(response: Response): Promise<Record<string, unknown>> {
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new ServerSecurityClientError(
      typeof payload.error === 'string' ? payload.error : `服务器安全请求失败（HTTP ${response.status}）`,
      response.status,
      typeof payload.code === 'string' ? payload.code : 'SECURITY_UNAVAILABLE',
    );
  }
  return payload;
}

export async function readServerSecurityStatus(serverURL: string): Promise<ServerSecurityStatus> {
  const response = await serverFetch(serverURL, '/api/security/status');
  if (response.status === 404) {
    clearServerAccessToken(serverURL);
    return {
      enabled: false,
      configured: false,
      bootstrapAvailable: false,
      tokenEpoch: 0,
      authorized: false,
      secureTransportRequired: false,
    };
  }
  const payload = await assertResponse(response);
  const enabled = payload.enabled === true
    || (payload.enabled !== false && typeof payload.configured === 'boolean' && typeof payload.tokenEpoch === 'number');
  if (!enabled) clearServerAccessToken(serverURL);
  return {
    enabled,
    configured: payload.configured === true,
    bootstrapAvailable: payload.bootstrapAvailable === true,
    tokenEpoch: typeof payload.tokenEpoch === 'number' ? payload.tokenEpoch : 0,
    authorized: payload.authorized === true,
    secureTransportRequired: payload.secureTransportRequired === true,
  };
}

function grantFromPayload(payload: Record<string, unknown>): ServerAccessGrant {
  if (typeof payload.accessToken !== 'string' || typeof payload.expiresAt !== 'number') {
    throw new ServerSecurityClientError('服务器没有返回有效的访问令牌', 502, 'SECURITY_UNAVAILABLE');
  }
  return { accessToken: payload.accessToken, expiresAt: payload.expiresAt };
}

export async function unlockServer(serverURL: string, password: string): Promise<ServerAccessGrant> {
  const payload = await assertResponse(await serverFetch(serverURL, '/api/security/access', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  }));
  const grant = grantFromPayload(payload);
  setServerAccessToken(serverURL, grant);
  return grant;
}

export async function bootstrapServer(serverURL: string, bootstrapToken: string, password: string): Promise<ServerAccessGrant> {
  const payload = await assertResponse(await serverFetch(serverURL, '/api/security/bootstrap', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrapToken, password }),
  }));
  const grant = grantFromPayload(payload);
  setServerAccessToken(serverURL, grant);
  return grant;
}

export async function ensureServerAccess(options: { serverURL: string; password: string; bootstrapToken?: string }): Promise<ServerAccessGrant | null> {
  const existing = getServerAccessGrant(options.serverURL);
  if (existing) {
    try {
      const status = await readServerSecurityStatus(options.serverURL);
      if (!status.enabled) return null;
      if (status.authorized) return existing;
    } catch { /* Fall through to password verification. */ }
    clearServerAccessToken(options.serverURL);
  }
  const status = await readServerSecurityStatus(options.serverURL);
  if (!status.enabled) return null;
  if (!status.configured) {
    if (!options.bootstrapToken?.trim()) throw new ServerSecurityClientError('这是新服务器，请填写管理员提供的一次性初始化凭据', 428, 'BOOTSTRAP_REQUIRED');
    return bootstrapServer(options.serverURL, options.bootstrapToken.trim(), options.password);
  }
  return unlockServer(options.serverURL, options.password);
}
