import { CLIENT_PROTOCOL_VERSION } from '@cove/contracts';
import {
  readUpgradePolicy,
  requireClientUpgrade,
  type ClientUpgradePolicy,
} from '../updates/versionPolicy';
import { MOBILE_RELEASE_VERSION } from './clientVersion';
export { CLIENT_PROTOCOL_VERSION };

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

export interface ServerSecurityStatus extends Partial<ClientUpgradePolicy> {
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
  /** Local receipt of an actual successful password check, never refreshed by status. */
  verifiedAt?: number;
  lastObservedAt?: number;
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

const SERVER_ACCESS_RECOVERY_CODES = new Set<ServerSecurityErrorCode>([
  'SERVER_NOT_INITIALIZED',
  'SERVER_ACCESS_REQUIRED',
  'SERVER_ACCESS_INVALID',
  'INSECURE_TRANSPORT',
]);

export function requiresServerAccessRecovery(code: unknown): boolean {
  return (
    typeof code === 'string' &&
    SERVER_ACCESS_RECOVERY_CODES.has(code as ServerSecurityErrorCode)
  );
}

// Active grants remain process-local. Opted-in account-scoped persistence is
// handled separately by serverAccessMemory through Android Keystore.
const accessTokens = new Map<string, ServerAccessGrant>();
const exchangeRevisions = new Map<string, number>();
let exchangeRevision = 0;
export function clearAllServerAccessTokens() {
  accessTokens.clear();
  invalidateServerAccessExchanges();
}
export function invalidateServerAccessExchanges() {
  exchangeRevision += 1;
}
function beginExchange(serverURL: string) {
  const key = keyFor(serverURL);
  const revision = (exchangeRevisions.get(key) ?? 0) + 1;
  exchangeRevisions.set(key, revision);
  const globalRevision = exchangeRevision;
  return () =>
    globalRevision === exchangeRevision &&
    exchangeRevisions.get(key) === revision;
}
function commitExchange(
  serverURL: string,
  grant: ServerAccessGrant,
  current: () => boolean,
) {
  if (!current())
    throw new ServerSecurityClientError(
      '服务器认证请求已取消',
      499,
      'REQUEST_CANCELLED',
    );
  setServerAccessToken(serverURL, grant);
}

export function normalizeServerSecurityURL(value: string): string {
  try {
    const candidate = value.trim();
    if (!candidate) return '';
    if (
      /^[a-z][a-z\d+.-]*:\/\//i.test(candidate) &&
      !/^https?:\/\//i.test(candidate)
    )
      return '';
    const url = new URL(
      /^https?:\/\//i.test(candidate) ? candidate : `http://${candidate}`,
    );
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

const keyFor = (serverURL: string) => normalizeServerSecurityURL(serverURL);

export function getServerAccessGrant(
  serverURL: string,
): ServerAccessGrant | null {
  const key = keyFor(serverURL);
  if (!key) return null;
  const grant = accessTokens.get(key);
  const now = Date.now();
  if (
    !grant ||
    grant.expiresAt <= now ||
    (grant.lastObservedAt !== undefined && now < grant.lastObservedAt)
  ) {
    accessTokens.delete(key);
    return null;
  }
  return grant;
}

export function getServerAccessToken(serverURL: string): string | null {
  return getServerAccessGrant(serverURL)?.accessToken ?? null;
}

export function setServerAccessToken(
  serverURL: string,
  grant: ServerAccessGrant,
): void {
  const key = keyFor(serverURL);
  if (key && grant.accessToken && Number.isFinite(grant.expiresAt))
    accessTokens.set(key, grant);
}

export function clearServerAccessToken(serverURL: string): void {
  const key = keyFor(serverURL);
  if (key) {
    accessTokens.delete(key);
    exchangeRevisions.set(key, (exchangeRevisions.get(key) ?? 0) + 1);
  }
}

function requestURL(serverURL: string, target: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  return `${serverURL.replace(/\/+$/, '')}/${target.replace(/^\/+/, '')}`;
}

export function serverRequestInit(
  serverURL: string,
  init: RequestInit = {},
): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('X-Cove-Client-Protocol', String(CLIENT_PROTOCOL_VERSION));
  headers.set('X-Cove-Client-Version', MOBILE_RELEASE_VERSION);
  headers.set('X-Cove-Client-Platform', 'mobile');
  const token = getServerAccessToken(serverURL);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

export async function serverFetch(
  serverURL: string,
  target: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(
    requestURL(serverURL, target),
    serverRequestInit(serverURL, init),
  );
  if (response.status === 426 && typeof response.clone === 'function') {
    const payload = await response
      .clone()
      .json()
      .catch(() => ({}));
    if (payload.code === 'CLIENT_VERSION_TOO_OLD')
      requireClientUpgrade(payload);
  }
  return response;
}

export function authorizedResourceURL(
  serverURL: string,
  target: string,
): string {
  const url = requestURL(serverURL, target);
  const token = getServerAccessToken(serverURL);
  try {
    const parsed = new URL(url);
    // Never attach a server token or version metadata to external chat images.
    if (parsed.origin !== new URL(serverURL).origin) return url;
    if (token) parsed.searchParams.set('access_token', token);
    parsed.searchParams.set('client_version', MOBILE_RELEASE_VERSION);
    parsed.searchParams.set('client_platform', 'mobile');
    parsed.searchParams.set('client_protocol', String(CLIENT_PROTOCOL_VERSION));
    return parsed.toString();
  } catch {
    return url;
  }
}

async function readPayload(
  response: Response,
): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

async function assertResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const payload = await readPayload(response);
  if (!response.ok) {
    if (payload.code === 'CLIENT_VERSION_TOO_OLD')
      requireClientUpgrade(payload);
    throw new ServerSecurityClientError(
      typeof payload.error === 'string'
        ? payload.error
        : `服务器安全请求失败（HTTP ${response.status}）`,
      response.status,
      typeof payload.code === 'string' ? payload.code : 'SECURITY_UNAVAILABLE',
    );
  }
  return payload;
}

export async function readServerSecurityStatus(
  serverURL: string,
): Promise<ServerSecurityStatus> {
  const key = keyFor(serverURL);
  const globalRevision = exchangeRevision;
  const scopeRevision = exchangeRevisions.get(key);
  const current = () =>
    globalRevision === exchangeRevision &&
    scopeRevision === exchangeRevisions.get(key);
  const response = await serverFetch(serverURL, '/api/security/status');
  if (response.status === 404) {
    if (current()) clearServerAccessToken(serverURL);
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
  const policy = readUpgradePolicy(payload);
  if (policy?.upgradeRequired) requireClientUpgrade(policy);
  const enabled =
    payload.enabled === true ||
    (payload.enabled !== false &&
      typeof payload.configured === 'boolean' &&
      typeof payload.tokenEpoch === 'number');
  if (!enabled && current()) clearServerAccessToken(serverURL);
  return {
    enabled,
    configured: payload.configured === true,
    bootstrapAvailable: payload.bootstrapAvailable === true,
    tokenEpoch: typeof payload.tokenEpoch === 'number' ? payload.tokenEpoch : 0,
    authorized: payload.authorized === true,
    secureTransportRequired: payload.secureTransportRequired === true,
    ...policy,
  };
}

function grantFromPayload(payload: Record<string, unknown>): ServerAccessGrant {
  if (
    typeof payload.accessToken !== 'string' ||
    typeof payload.expiresAt !== 'number'
  ) {
    throw new ServerSecurityClientError(
      '服务器没有返回有效的访问令牌',
      502,
      'SECURITY_UNAVAILABLE',
    );
  }
  const verifiedAt = Date.now();
  return {
    accessToken: payload.accessToken,
    expiresAt: Math.min(
      payload.expiresAt,
      verifiedAt + 14 * 24 * 60 * 60 * 1000,
    ),
    verifiedAt,
    lastObservedAt: verifiedAt,
  };
}

export async function unlockServer(
  serverURL: string,
  password: string,
): Promise<ServerAccessGrant> {
  const current = beginExchange(serverURL);
  const payload = await assertResponse(
    await serverFetch(serverURL, '/api/security/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
  );
  const grant = grantFromPayload(payload);
  commitExchange(serverURL, grant, current);
  return grant;
}

export async function bootstrapServer(
  serverURL: string,
  bootstrapToken: string,
  password: string,
): Promise<ServerAccessGrant> {
  const current = beginExchange(serverURL);
  const payload = await assertResponse(
    await serverFetch(serverURL, '/api/security/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken, password }),
    }),
  );
  const grant = grantFromPayload(payload);
  commitExchange(serverURL, grant, current);
  return grant;
}

export async function ensureServerAccess(options: {
  serverURL: string;
  password: string;
  bootstrapToken?: string;
}): Promise<ServerAccessGrant | null> {
  const existing = getServerAccessGrant(options.serverURL);
  if (existing) {
    try {
      const status = await readServerSecurityStatus(options.serverURL);
      if (!status.enabled) return null;
      if (status.authorized) return existing;
    } catch (cause) {
      // Transport failures do not prove revocation and must not erase memory or
      // turn an automatic resume into another password request.
      if (
        !(cause instanceof ServerSecurityClientError) ||
        !requiresServerAccessRecovery(cause.code)
      )
        throw cause;
    }
    clearServerAccessToken(options.serverURL);
  }
  const status = await readServerSecurityStatus(options.serverURL);
  if (status.upgradeRequired)
    throw new ServerSecurityClientError(
      '当前版本不符合服务器要求，请完成更新后连接。',
      426,
      'CLIENT_VERSION_TOO_OLD',
    );
  if (!status.enabled) return null;
  if (!status.configured) {
    if (!options.bootstrapToken?.trim())
      throw new ServerSecurityClientError(
        '这是新服务器，请填写管理员提供的一次性初始化凭据',
        428,
        'BOOTSTRAP_REQUIRED',
      );
    return bootstrapServer(
      options.serverURL,
      options.bootstrapToken.trim(),
      options.password,
    );
  }
  return unlockServer(options.serverURL, options.password);
}
