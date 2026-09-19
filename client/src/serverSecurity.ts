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
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: ServerSecurityErrorCode | string,
  ) {
    super(message);
    this.name = 'ServerSecurityClientError';
  }
}

// Account sessions may be remembered for convenience, but a bearer token that
// unlocks every REST and Socket.IO operation is never written to localStorage.
// A sessionStorage copy lets the renderer reload after the first login without
// asking for the server password again; it disappears with the browser/window
// session and is not used by the mobile app. It is only ever put in a URL for
// the short-lived static media helper below.
const accessTokens = new Map<string, ServerAccessGrant>();
const SESSION_ACCESS_KEY = 'cove_server_access_session';

function readSessionAccessTokens(): void {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SESSION_ACCESS_KEY) ?? '{}') as Record<string, ServerAccessGrant>;
    Object.entries(parsed).forEach(([key, grant]) => {
      if (grant && typeof grant.accessToken === 'string' && typeof grant.expiresAt === 'number' && grant.expiresAt > Date.now()) accessTokens.set(key, grant);
    });
  } catch { /* sessionStorage may be unavailable in tests or privacy mode. */ }
}

function writeSessionAccessTokens(): void {
  try { sessionStorage.setItem(SESSION_ACCESS_KEY, JSON.stringify(Object.fromEntries(accessTokens))); }
  catch { /* The current in-memory token remains usable. */ }
}

if (typeof sessionStorage !== 'undefined') readSessionAccessTokens();

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

function serverKey(serverURL: string): string {
  return normalizeServerSecurityURL(serverURL);
}

export function getServerAccessGrant(serverURL: string): ServerAccessGrant | null {
  const key = serverKey(serverURL);
  if (!key) return null;
  const grant = accessTokens.get(key);
  if (!grant || grant.expiresAt <= Date.now()) {
    accessTokens.delete(key);
    writeSessionAccessTokens();
    return null;
  }
  return grant;
}

export function getServerAccessToken(serverURL: string): string | null {
  return getServerAccessGrant(serverURL)?.accessToken ?? null;
}

export function setServerAccessToken(serverURL: string, grant: ServerAccessGrant): void {
  const key = serverKey(serverURL);
  if (!key || !grant.accessToken || !Number.isFinite(grant.expiresAt)) return;
  accessTokens.set(key, grant);
  writeSessionAccessTokens();
}

export function clearServerAccessToken(serverURL: string): void {
  const key = serverKey(serverURL);
  if (key) {
    accessTokens.delete(key);
    writeSessionAccessTokens();
  }
}

export function clearAllServerAccessTokens(): void {
  accessTokens.clear();
  writeSessionAccessTokens();
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
  // Servers released before the dormant security capability do not expose a
  // status endpoint. Treat their 404 as the legacy, password-free mode so the
  // compatible client can be rolled out first.
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
  // The first development build of protocol 2 did not include `enabled` but
  // did include the remaining status fields. Continue to recognize it as an
  // enabled server during migration.
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  }));
  const grant = grantFromPayload(payload);
  setServerAccessToken(serverURL, grant);
  return grant;
}

export async function bootstrapServer(serverURL: string, bootstrapToken: string, password: string): Promise<ServerAccessGrant> {
  const payload = await assertResponse(await serverFetch(serverURL, '/api/security/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapToken, password }),
  }));
  const grant = grantFromPayload(payload);
  setServerAccessToken(serverURL, grant);
  return grant;
}

export async function ensureServerAccess(options: {
  serverURL: string;
  password: string;
  bootstrapToken?: string;
}): Promise<ServerAccessGrant | null> {
  const currentGrant = getServerAccessGrant(options.serverURL);
  if (currentGrant) {
    try {
      const status = await readServerSecurityStatus(options.serverURL);
      if (!status.enabled) return null;
      if (status.authorized) {
        return currentGrant;
      }
    } catch {
      // Re-verify through the password flow below so a rotated/expired token
      // cannot leave the login screen stuck on a stale session.
    }
    clearServerAccessToken(options.serverURL);
  }

  const status = await readServerSecurityStatus(options.serverURL);
  if (!status.enabled) return null;
  if (!status.configured) {
    if (!options.bootstrapToken?.trim()) {
      throw new ServerSecurityClientError('这是新服务器，请填写管理员提供的一次性初始化凭据', 428, 'BOOTSTRAP_REQUIRED');
    }
    return bootstrapServer(options.serverURL, options.bootstrapToken.trim(), options.password);
  }
  return unlockServer(options.serverURL, options.password);
}

export async function rotateServerPassword(serverURL: string, currentPassword: string, newPassword: string): Promise<ServerAccessGrant> {
  const payload = await assertResponse(await serverFetch(serverURL, '/api/security/rotate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  }));
  const grant = grantFromPayload(payload);
  setServerAccessToken(serverURL, grant);
  return grant;
}
