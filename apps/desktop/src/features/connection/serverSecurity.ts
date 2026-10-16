import { CLIENT_PROTOCOL_VERSION } from '@cove/contracts';
export { CLIENT_PROTOCOL_VERSION } from '@cove/contracts';

import {
  CLIENT_PLATFORM,
  CLIENT_VERSION,
  notifyClientUpgrade,
  readClientVersionPolicy,
  type ClientVersionPolicy,
} from '../updates/clientVersion';

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
  versionPolicy?: ClientVersionPolicy;
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

const SERVER_ACCESS_RECOVERY_CODES = new Set<ServerSecurityErrorCode>([
  'SERVER_NOT_INITIALIZED',
  'SERVER_ACCESS_REQUIRED',
  'SERVER_ACCESS_INVALID',
  'INSECURE_TRANSPORT',
]);

export function requiresServerAccessRecovery(code: unknown): boolean {
  return (
    typeof code === 'string' && SERVER_ACCESS_RECOVERY_CODES.has(code as ServerSecurityErrorCode)
  );
}

// Durable grants are OS-encrypted through the main process, bound to an exact
// URL and account. The session copy only bridges the post-login renderer reload.
const accessTokens = new Map<string, ServerAccessGrant>();
const grantOwners = new Map<string, string>();
const grantObservedAt = new Map<string, number>();
const CLOCK_ROLLBACK_TOLERANCE = 5 * 60 * 1000;
const SESSION_ACCESS_KEY = 'cove_server_access_session';

function readSessionAccessTokens(): void {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SESSION_ACCESS_KEY) ?? '{}') as Record<
      string,
      ServerAccessGrant & { email?: string; lastObservedAt?: number }
    >;
    Object.entries(parsed).forEach(([key, grant]) => {
      if (
        grant &&
        typeof grant.accessToken === 'string' &&
        typeof grant.expiresAt === 'number' &&
        grant.expiresAt > Date.now()
      ) {
        accessTokens.set(key, { accessToken: grant.accessToken, expiresAt: grant.expiresAt });
        if (typeof grant.email === 'string' && grant.email.trim()) grantOwners.set(key, grant.email.trim().toLowerCase());
        grantObservedAt.set(key, Number.isFinite(grant.lastObservedAt) ? grant.lastObservedAt! : Date.now());
      }
    });
  } catch {
    /* sessionStorage may be unavailable in tests or privacy mode. */
  }
}

function writeSessionAccessTokens(): void {
  try {
    sessionStorage.setItem(SESSION_ACCESS_KEY, JSON.stringify(Object.fromEntries([...accessTokens].map(([key, grant]) =>
      [key, { ...grant, email: grantOwners.get(key), lastObservedAt: grantObservedAt.get(key) }]))));
  } catch {
    /* The current in-memory token remains usable. */
  }
}

if (typeof sessionStorage !== 'undefined') readSessionAccessTokens();

export function normalizeServerSecurityURL(value: string): string {
  try {
    const candidate = value.trim();
    if (!candidate) return '';
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(candidate) && !/^https?:\/\//i.test(candidate)) return '';
    const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `http://${candidate}`);
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

function serverKey(serverURL: string): string {
  return normalizeServerSecurityURL(serverURL);
}

export function getServerAccessGrant(serverURL: string): ServerAccessGrant | null {
  const key = serverKey(serverURL);
  if (!key) return null;
  const grant = accessTokens.get(key);
  const now = Date.now();
  const clockRolledBack = now + CLOCK_ROLLBACK_TOLERANCE < (grantObservedAt.get(key) ?? now);
  if (!grant || grant.expiresAt <= now || clockRolledBack) {
    const owner = grantOwners.get(key);
    accessTokens.delete(key);
    grantOwners.delete(key);
    grantObservedAt.delete(key);
    writeSessionAccessTokens();
    if (clockRolledBack) void forgetServerAccess(key, owner).catch(() => undefined);
    return null;
  }
  grantObservedAt.set(key, Math.max(now, grantObservedAt.get(key) ?? now));
  writeSessionAccessTokens();
  return grant;
}

export function getServerAccessToken(serverURL: string): string | null {
  return getServerAccessGrant(serverURL)?.accessToken ?? null;
}

export function setServerAccessToken(serverURL: string, grant: ServerAccessGrant): void {
  const key = serverKey(serverURL);
  if (!key || !grant.accessToken || !Number.isFinite(grant.expiresAt)) return;
  invalidateServerOperations(key);
  accessTokens.set(key, grant);
  grantOwners.delete(key);
  grantObservedAt.set(key, Date.now());
  writeSessionAccessTokens();
}

export function clearServerAccessToken(serverURL: string): void {
  const key = serverKey(serverURL);
  if (key) {
    invalidateServerOperations(key);
    accessTokens.delete(key);
    grantOwners.delete(key);
    grantObservedAt.delete(key);
    writeSessionAccessTokens();
  }
}

export function clearAllServerAccessTokens(): void {
  operationGeneration += 1;
  accessTokens.clear();
  grantOwners.clear();
  grantObservedAt.clear();
  writeSessionAccessTokens();
}

// Serialize IPC mutations: a forget/clear queued during a save always executes
// after it. Generations prevent pending reads and delayed saves from restoring it.
let operationGeneration = 0;
const serverGenerations = new Map<string, number>();
const accountGenerations = new Map<string, number>();
const restores = new Map<string, Promise<boolean>>();
const exchanges = new Map<string, number>();
let storageOperations: Promise<unknown> = Promise.resolve();
function scopeFor(serverURL: string, email: string): string {
  return JSON.stringify([serverKey(serverURL), email.trim().toLowerCase()]);
}
function invalidateServerOperations(serverURL: string): void {
  serverGenerations.set(serverURL, (serverGenerations.get(serverURL) ?? 0) + 1);
}
function operationIsCurrent(server: string, scope: string): () => boolean {
  const all = operationGeneration, serverVersion = serverGenerations.get(server), account = accountGenerations.get(scope);
  return () => all === operationGeneration && serverVersion === serverGenerations.get(server) && account === accountGenerations.get(scope);
}
function storageOperation<T>(run: () => Promise<T>): Promise<T> {
  const next = storageOperations.then(run, run);
  storageOperations = next.catch(() => undefined);
  return next;
}
function assertCurrent(current: () => boolean): void {
  if (!current()) throw new DOMException('认证操作已取消', 'AbortError');
}
function exchangeIsCurrent(serverURL: string): () => boolean {
  const server = serverKey(serverURL), current = operationIsCurrent(server, '');
  const revision = (exchanges.get(server) ?? 0) + 1;
  exchanges.set(server, revision);
  return () => current() && exchanges.get(server) === revision;
}

/** Restores locally only. The caller must still verify authorization with the server. */
export function restoreServerAccess(serverURL: string, email: string): Promise<boolean> {
  const server = serverKey(serverURL), account = email.trim().toLowerCase();
  if (!server || !account) return Promise.resolve(false);
  const scope = scopeFor(server, account);
  const pending = restores.get(scope);
  if (pending) return pending;
  const existing = getServerAccessGrant(server);
  const bridge = existing && grantOwners.get(server) === account ? existing : null;
  // Legacy/unbound and other-account session copies may not authorize this
  // account. Clearing memory never deletes another account's durable record.
  if (!bridge) clearServerAccessToken(server);
  if (typeof window === 'undefined' || !window.coveServerAccess) return Promise.resolve(Boolean(bridge));
  const current = operationIsCurrent(server, scope);
  const operation = storageOperation(async () => {
    if (!current()) return false;
    const result = await window.coveServerAccess!.get(server, account).catch(() => null);
    if (!current()) return false;
    if (!result?.ok || !result.available || !result.grant || result.grant.expiresAt <= Date.now())
      return Boolean(bridge && getServerAccessGrant(server)?.accessToken === bridge.accessToken && grantOwners.get(server) === account);
    setServerAccessToken(server, result.grant);
    grantOwners.set(server, account);
    writeSessionAccessTokens();
    return true;
  });
  restores.set(scope, operation);
  void operation.finally(() => { if (restores.get(scope) === operation) restores.delete(scope); });
  return operation;
}

/** Call only after the matching account successfully authenticated. Never changes expiresAt. */
export function rememberServerAccess(serverURL: string, email: string): Promise<boolean> {
  const server = serverKey(serverURL), account = email.trim().toLowerCase(), grant = getServerAccessGrant(serverURL);
  if (!server || !account || !grant || (grantOwners.has(server) && grantOwners.get(server) !== account)) return Promise.resolve(false);
  // Bind the reload bridge after account success even if durable OS storage is
  // unavailable, so manual login can enter the app without an auth/reload loop.
  grantOwners.set(server, account);
  writeSessionAccessTokens();
  if (typeof window === 'undefined' || !window.coveServerAccess) return Promise.resolve(false);
  const scope = scopeFor(server, account), current = operationIsCurrent(server, scope);
  return storageOperation(async () => {
    if (!current() || getServerAccessGrant(server)?.accessToken !== grant.accessToken) return false;
    const result = await window.coveServerAccess!.set(server, account, grant).catch(() => null);
    return current() && result?.available === true && result.ok;
  });
}

/** Invalidation is synchronous even though deleting the encrypted record is asynchronous. */
export function forgetServerAccess(serverURL: string, email?: string): Promise<void> {
  const server = serverKey(serverURL);
  if (!server) return Promise.resolve();
  const account = email?.trim().toLowerCase();
  if (account === undefined) clearServerAccessToken(server);
  else {
    const scope = scopeFor(server, account);
    accountGenerations.set(scope, (accountGenerations.get(scope) ?? 0) + 1);
    if (!grantOwners.has(server) || grantOwners.get(server) === account) clearServerAccessToken(server);
  }
  return storageOperation(async () => {
    if (typeof window !== 'undefined' && window.coveServerAccess) {
      const result = await window.coveServerAccess.remove(server, account);
      if (!result.ok) throw new Error('无法清除已记住的服务器认证，请重试');
    }
  });
}

export function clearRememberedServerAccess(): Promise<void> {
  clearAllServerAccessTokens();
  return storageOperation(async () => {
    if (typeof window !== 'undefined' && window.coveServerAccess) {
      const result = await window.coveServerAccess.clear();
      if (!result.ok) throw new Error('无法清除已记住的服务器认证，请重试');
    }
  });
}

function requestURL(serverURL: string, target: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  return `${serverURL.replace(/\/+$/, '')}/${target.replace(/^\/+/, '')}`;
}

export function serverRequestInit(serverURL: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('X-Cove-Client-Protocol', String(CLIENT_PROTOCOL_VERSION));
  headers.set('X-Cove-Client-Version', CLIENT_VERSION);
  headers.set('X-Cove-Client-Platform', CLIENT_PLATFORM);
  const token = getServerAccessToken(serverURL);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

export function serverFetch(
  serverURL: string,
  target: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(requestURL(serverURL, target), serverRequestInit(serverURL, init)).then(async response => {
    if (!response.ok) {
      const payload = await response.clone().json().catch(() => null);
      if (payload?.code === 'CLIENT_VERSION_TOO_OLD') notifyClientUpgrade(serverURL, payload);
    }
    return response;
  });
}

export function serverSocketAuth(serverURL: string) {
  return {
    serverAccessToken: getServerAccessToken(serverURL),
    clientProtocol: CLIENT_PROTOCOL_VERSION,
    clientVersion: CLIENT_VERSION,
    clientPlatform: CLIENT_PLATFORM,
  };
}

export function authorizedResourceURL(serverURL: string, target: string): string {
  if (/^(?:data|blob):/i.test(target)) return target;
  const url = requestURL(serverURL, target);
  const token = getServerAccessToken(serverURL);
  try {
    const parsed = new URL(url);
    if (parsed.origin !== new URL(serverURL).origin) return url;
    parsed.searchParams.set('client_protocol', String(CLIENT_PROTOCOL_VERSION));
    parsed.searchParams.set('client_version', CLIENT_VERSION);
    parsed.searchParams.set('client_platform', CLIENT_PLATFORM);
    if (token) parsed.searchParams.set('access_token', token);
    return parsed.toString();
  } catch {
    return url;
  }
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

async function assertResponse(response: Response): Promise<Record<string, unknown>> {
  const payload = await readPayload(response);
  if (!response.ok) {
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

export async function readServerSecurityStatus(serverURL: string, signal?: AbortSignal): Promise<ServerSecurityStatus> {
  const current = operationIsCurrent(serverKey(serverURL), '');
  const response = await serverFetch(serverURL, '/api/security/status', { signal });
  signal?.throwIfAborted();
  assertCurrent(current);
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
  signal?.throwIfAborted();
  assertCurrent(current);
  const versionPolicy = readClientVersionPolicy(payload);
  notifyClientUpgrade(serverURL, payload);
  // The first development build of protocol 2 did not include `enabled` but
  // did include the remaining status fields. Continue to recognize it as an
  // enabled server during migration.
  const enabled =
    payload.enabled === true ||
    (payload.enabled !== false &&
      typeof payload.configured === 'boolean' &&
      typeof payload.tokenEpoch === 'number');
  if (!enabled) clearServerAccessToken(serverURL);
  return {
    enabled,
    configured: payload.configured === true,
    bootstrapAvailable: payload.bootstrapAvailable === true,
    tokenEpoch: typeof payload.tokenEpoch === 'number' ? payload.tokenEpoch : 0,
    authorized: payload.authorized === true,
    secureTransportRequired: payload.secureTransportRequired === true,
    ...(versionPolicy ? { versionPolicy } : {}),
  };
}

function grantFromPayload(payload: Record<string, unknown>): ServerAccessGrant {
  if (typeof payload.accessToken !== 'string' || typeof payload.expiresAt !== 'number') {
    throw new ServerSecurityClientError(
      '服务器没有返回有效的访问令牌',
      502,
      'SECURITY_UNAVAILABLE',
    );
  }
  return { accessToken: payload.accessToken, expiresAt: payload.expiresAt };
}

export async function unlockServer(
  serverURL: string,
  password: string,
): Promise<ServerAccessGrant> {
  const current = exchangeIsCurrent(serverURL);
  const payload = await assertResponse(
    await serverFetch(serverURL, '/api/security/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
  );
  assertCurrent(current);
  const grant = grantFromPayload(payload);
  setServerAccessToken(serverURL, grant);
  return grant;
}

export async function bootstrapServer(
  serverURL: string,
  bootstrapToken: string,
  password: string,
): Promise<ServerAccessGrant> {
  const current = exchangeIsCurrent(serverURL);
  const payload = await assertResponse(
    await serverFetch(serverURL, '/api/security/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken, password }),
    }),
  );
  assertCurrent(current);
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
  const current = operationIsCurrent(serverKey(options.serverURL), '');
  // A transport/server failure is not an authorization denial. Preserve the
  // grant and propagate it once, without an automatic second password request.
  const status = await readServerSecurityStatus(options.serverURL);
  // Disabled status clears the old grant itself, so its successful return is
  // authoritative. For enabled servers cancellation must stop the exchange.
  if (!status.enabled) return null;
  assertCurrent(current);
  if (currentGrant && status.authorized) return currentGrant;
  if (currentGrant) {
    const removal = forgetServerAccess(options.serverURL);
    const afterRemoval = operationIsCurrent(serverKey(options.serverURL), '');
    await removal;
    assertCurrent(afterRemoval);
  }
  if (!options.password) throw new ServerSecurityClientError('请重新输入服务器密码', 401, 'SERVER_ACCESS_REQUIRED');
  if (!status.configured) {
    if (!options.bootstrapToken?.trim()) {
      throw new ServerSecurityClientError(
        '这是新服务器，请填写管理员提供的一次性初始化凭据',
        428,
        'BOOTSTRAP_REQUIRED',
      );
    }
    return bootstrapServer(options.serverURL, options.bootstrapToken.trim(), options.password);
  }
  return unlockServer(options.serverURL, options.password);
}

export async function rotateServerPassword(
  serverURL: string,
  currentPassword: string,
  newPassword: string,
): Promise<ServerAccessGrant> {
  const current = exchangeIsCurrent(serverURL);
  const payload = await assertResponse(
    await serverFetch(serverURL, '/api/security/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  );
  assertCurrent(current);
  const grant = grantFromPayload(payload);
  setServerAccessToken(serverURL, grant);
  return grant;
}
