import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type Database from 'better-sqlite3';
import type { Request } from 'express';
import { derivePassword, passwordMatches } from './accountAuth';

export const SERVER_ACCESS_TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;
const MIN_SERVER_PASSWORD_LENGTH = 8;
const MAX_SERVER_PASSWORD_LENGTH = 128;
const MAX_ACCESS_TOKEN_LENGTH = 256;
// Protocol 2 is the first client protocol that can obtain and send a server
// access token. Older clients do not send this marker at all.
export const CLIENT_PROTOCOL_VERSION = 2;

/**
 * The server-password protocol is shipped dormant so compatible clients can
 * be released before the server starts enforcing it. Enabling it is an
 * explicit deployment decision and requires a server restart.
 */
export function isServerSecurityEnabled(value = process.env.COVE_SERVER_SECURITY_ENABLED): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? '');
}

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
  | 'INVALID_REQUEST';

export class ServerSecurityError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ServerSecurityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServerSecurityError';
  }
}

interface ServerSecurityRecord {
  id: number;
  passwordHash: string | null;
  passwordSalt: string | null;
  tokenEpoch: number;
  bootstrapUsedAt: number | null;
  configuredAt: number | null;
  updatedAt: number | null;
}

export interface ServerSecurityStatus {
  configured: boolean;
  bootstrapAvailable: boolean;
  tokenEpoch: number;
}

export interface ServerAccessPrincipal {
  epoch: number;
  expiresAt: number;
}

interface AttemptState {
  count: number;
  until: number;
}

interface ServerSecurityStoreOptions {
  bootstrapToken?: string;
  now?: () => number;
  tokenLifetimeMs?: number;
  onBootstrapConsumed?: () => void;
  onAccessTokensRevoked?: () => void;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function isClientProtocolSupported(value: unknown): boolean {
  if (typeof value === 'number') return value === CLIENT_PROTOCOL_VERSION;
  return typeof value === 'string' && value.trim() === String(CLIENT_PROTOCOL_VERSION);
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validPassword(password: unknown): password is string {
  return typeof password === 'string'
    && password.length >= MIN_SERVER_PASSWORD_LENGTH
    && password.length <= MAX_SERVER_PASSWORD_LENGTH;
}

function validToken(token: unknown): token is string {
  return typeof token === 'string'
    && token.length >= 32
    && token.length <= MAX_ACCESS_TOKEN_LENGTH;
}

function currentRequestAddress(req: Pick<Request, 'ip' | 'socket'>): string {
  return req.socket.remoteAddress ?? req.ip ?? 'unknown';
}

function stripMappedLoopback(address: string): string {
  const value = address.trim().toLowerCase();
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const value = stripMappedLoopback(address);
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

/**
 * Cove accepts plaintext HTTP only for a process accessed through loopback.
 * Reverse-proxy deployments may opt in to the standard forwarded-proto header
 * with COVE_TRUST_PROXY=true; otherwise that header is intentionally ignored.
 */
export function isSecureHttpRequest(req: Pick<Request, 'protocol' | 'get' | 'socket' | 'ip'>): boolean {
  if (req.protocol === 'https') return true;
  const loopback = isLoopbackAddress(req.socket.remoteAddress) || isLoopbackAddress(req.ip);
  const forwarded = req.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  // A reverse proxy commonly connects to Cove over loopback. Do not mistake
  // its plaintext hop for local development unless the deployment explicitly
  // opted into forwarded-protocol trust.
  if (loopback) {
    if (forwarded && process.env.COVE_TRUST_PROXY?.trim().toLowerCase() !== 'true') return false;
    if (!forwarded) return true;
  }
  if (process.env.COVE_TRUST_PROXY?.trim().toLowerCase() === 'true') {
    if (forwarded === 'https') return true;
  }
  return false;
}

export function isSecureSocket(socket: {
  handshake?: { secure?: boolean; headers?: Record<string, unknown> };
  request?: { socket?: { encrypted?: boolean; remoteAddress?: string | undefined }; headers?: Record<string, unknown> };
}): boolean {
  const remoteAddress = socket.request?.socket?.remoteAddress;
  if (socket.handshake?.secure === true || socket.request?.socket?.encrypted === true) return true;
  const loopback = isLoopbackAddress(remoteAddress);
  const header = socket.handshake?.headers?.['x-forwarded-proto']
    ?? socket.request?.headers?.['x-forwarded-proto'];
  const forwarded = typeof header === 'string' ? header.split(',')[0]?.trim().toLowerCase() : '';
  if (loopback) {
    if (forwarded && process.env.COVE_TRUST_PROXY?.trim().toLowerCase() !== 'true') return false;
    if (!forwarded) return true;
  }
  if (process.env.COVE_TRUST_PROXY?.trim().toLowerCase() === 'true') {
    if (forwarded === 'https') return true;
  }
  return false;
}

export function readBearerToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]{32,256})$/i.exec(value.trim());
  return match?.[1] ?? null;
}

export function createServerSecurityStore(db: Database.Database, options: ServerSecurityStoreOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const tokenLifetimeMs = options.tokenLifetimeMs ?? SERVER_ACCESS_TOKEN_LIFETIME_MS;
  const bootstrapToken = options.bootstrapToken?.trim() || undefined;
  const attempts = new Map<string, AttemptState>();

  db.exec(`
    CREATE TABLE IF NOT EXISTS server_security (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      passwordHash TEXT,
      passwordSalt TEXT,
      tokenEpoch INTEGER NOT NULL DEFAULT 1,
      bootstrapUsedAt INTEGER,
      configuredAt INTEGER,
      updatedAt INTEGER
    );
    INSERT OR IGNORE INTO server_security (id, tokenEpoch) VALUES (1, 1);
    CREATE TABLE IF NOT EXISTS server_access_sessions (
      tokenHash TEXT PRIMARY KEY,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      epoch INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS server_access_sessions_expiry ON server_access_sessions(expiresAt);
  `);

  const getSecurity = db.prepare('SELECT * FROM server_security WHERE id = 1');
  const setInitialPassword = db.prepare(`
    UPDATE server_security
    SET passwordHash = ?, passwordSalt = ?, bootstrapUsedAt = ?, configuredAt = ?, updatedAt = ?
    WHERE id = 1 AND passwordHash IS NULL
  `);
  const updatePassword = db.prepare(`
    UPDATE server_security
    SET passwordHash = ?, passwordSalt = ?, tokenEpoch = tokenEpoch + 1, updatedAt = ?
    WHERE id = 1 AND passwordHash = ? AND passwordSalt = ?
  `);
  const insertSession = db.prepare('INSERT INTO server_access_sessions (tokenHash, expiresAt, createdAt, epoch) VALUES (?, ?, ?, ?)');
  const getSession = db.prepare('SELECT expiresAt, epoch FROM server_access_sessions WHERE tokenHash = ?');
  const removeExpired = db.prepare('DELETE FROM server_access_sessions WHERE expiresAt <= ?');
  const removeSessions = db.prepare('DELETE FROM server_access_sessions');

  const status = (): ServerSecurityStatus => {
    const record = getSecurity.get() as ServerSecurityRecord;
    return {
      configured: typeof record.passwordHash === 'string' && typeof record.passwordSalt === 'string',
      bootstrapAvailable: !record.passwordHash && !!bootstrapToken,
      tokenEpoch: record.tokenEpoch,
    };
  };

  const recordFailedAttempt = (key: string) => {
    const currentTime = now();
    for (const [attemptKey, value] of attempts) if (value.until <= currentTime) attempts.delete(attemptKey);
    const current = attempts.get(key) ?? { count: 0, until: currentTime + 60_000 };
    current.count += 1;
    attempts.set(key, current);
    if (current.count > 5) throw new ServerSecurityError(429, 'RATE_LIMITED', '尝试次数过多，请一分钟后再试');
  };

  const clearAttempts = (key: string) => { attempts.delete(key); };

  const issueAccessToken = db.transaction(() => {
    const record = getSecurity.get() as ServerSecurityRecord;
    const currentTime = now();
    removeExpired.run(currentTime);
    const accessToken = randomBytes(32).toString('base64url');
    const expiresAt = currentTime + tokenLifetimeMs;
    insertSession.run(hashToken(accessToken), expiresAt, currentTime, record.tokenEpoch);
    return { accessToken, expiresAt, epoch: record.tokenEpoch };
  });

  const configuredRecord = () => {
    const record = getSecurity.get() as ServerSecurityRecord;
    if (!record.passwordHash || !record.passwordSalt)
      throw new ServerSecurityError(503, 'SERVER_NOT_INITIALIZED', '服务器尚未初始化，请先设置服务器访问密码');
    return record;
  };

  const checkPassword = async (password: string, record: ServerSecurityRecord): Promise<boolean> => {
    try { return await passwordMatches(password, record.passwordSalt!, record.passwordHash!); }
    catch { return false; }
  };

  return {
    status,

    async bootstrap(bootstrapCredential: unknown, password: unknown, attemptKey = 'bootstrap') {
      if (!validPassword(password))
        throw new ServerSecurityError(400, 'INVALID_PASSWORD', '服务器访问密码应为 8–128 个字符');
      const current = getSecurity.get() as ServerSecurityRecord;
      if (current.passwordHash)
        throw new ServerSecurityError(409, 'SERVER_ALREADY_INITIALIZED', '服务器已经完成初始化');
      if (!bootstrapToken)
        throw new ServerSecurityError(503, 'BOOTSTRAP_UNAVAILABLE', '服务器管理员尚未配置一次性初始化凭据');
      if (typeof bootstrapCredential !== 'string' || !equalSecret(bootstrapCredential, bootstrapToken)) {
        recordFailedAttempt(attemptKey);
        throw new ServerSecurityError(401, 'INVALID_BOOTSTRAP', '初始化凭据无效');
      }

      const salt = randomBytes(16).toString('hex');
      const passwordHash = (await derivePassword(password, salt)).toString('hex');
      const configuredAt = now();
      const changed = db.transaction(() => setInitialPassword.run(
        passwordHash, salt, configuredAt, configuredAt, configuredAt,
      ))();
      if (changed.changes !== 1)
        throw new ServerSecurityError(409, 'SERVER_ALREADY_INITIALIZED', '服务器已经完成初始化');
      clearAttempts(attemptKey);
      options.onBootstrapConsumed?.();
      const issued = issueAccessToken();
      return { accessToken: issued.accessToken, expiresAt: issued.expiresAt };
    },

    async unlock(password: unknown, attemptKey = 'access') {
      if (typeof password !== 'string' || password.length > MAX_SERVER_PASSWORD_LENGTH)
        throw new ServerSecurityError(401, 'INVALID_PASSWORD', '服务器访问密码错误');
      const record = configuredRecord();
      if (!await checkPassword(password, record)) {
        recordFailedAttempt(attemptKey);
        throw new ServerSecurityError(401, 'INVALID_PASSWORD', '服务器访问密码错误');
      }
      clearAttempts(attemptKey);
      const issued = issueAccessToken();
      return { accessToken: issued.accessToken, expiresAt: issued.expiresAt };
    },

    async rotate(currentPassword: unknown, nextPassword: unknown, attemptKey = 'rotate') {
      if (!validPassword(nextPassword))
        throw new ServerSecurityError(400, 'INVALID_PASSWORD', '新的服务器访问密码应为 8–128 个字符');
      if (typeof currentPassword !== 'string')
        throw new ServerSecurityError(401, 'INVALID_PASSWORD', '服务器访问密码错误');
      const current = configuredRecord();
      if (!await checkPassword(currentPassword, current)) {
        recordFailedAttempt(attemptKey);
        throw new ServerSecurityError(401, 'INVALID_PASSWORD', '服务器访问密码错误');
      }
      const salt = randomBytes(16).toString('hex');
      const passwordHash = (await derivePassword(nextPassword, salt)).toString('hex');
      const changedAt = now();
      const changed = db.transaction(() => {
        const result = updatePassword.run(passwordHash, salt, changedAt, current.passwordHash, current.passwordSalt);
        if (result.changes === 1) removeSessions.run();
        return result;
      })();
      if (changed.changes !== 1)
        throw new ServerSecurityError(409, 'SERVER_ACCESS_INVALID', '服务器访问密码已变更，请重新验证');
      clearAttempts(attemptKey);
      options.onAccessTokensRevoked?.();
      const issued = issueAccessToken();
      return { accessToken: issued.accessToken, expiresAt: issued.expiresAt };
    },

    accessForToken(token: unknown): ServerAccessPrincipal | null {
      if (!validToken(token)) return null;
      const record = getSecurity.get() as ServerSecurityRecord;
      if (!record.passwordHash || !record.passwordSalt) return null;
      const currentTime = now();
      const session = getSession.get(hashToken(token)) as { expiresAt: number; epoch: number } | undefined;
      if (!session || session.expiresAt <= currentTime || session.epoch !== record.tokenEpoch) return null;
      return { epoch: session.epoch, expiresAt: session.expiresAt };
    },

    revokeAll() {
      db.transaction(() => {
        db.prepare('UPDATE server_security SET tokenEpoch = tokenEpoch + 1, updatedAt = ? WHERE id = 1').run(now());
        removeSessions.run();
      })();
      options.onAccessTokensRevoked?.();
    },
  };
}

export function securityErrorResponse(error: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) {
  if (error instanceof ServerSecurityError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  console.error('[security] unexpected security error');
  res.status(500).json({ error: '服务器安全服务暂时不可用', code: 'SECURITY_UNAVAILABLE' });
}

export function requestAttemptKey(req: Pick<Request, 'ip' | 'socket'>, scope: string): string {
  return `${scope}:${currentRequestAddress(req)}`;
}
