import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { accountPasswordScope, type PasswordEncryption } from './account-password-store';

export interface StoredServerGrant { accessToken: string; expiresAt: number }
export interface ServerAccessStoreResult {
  available: boolean;
  ok: boolean;
  grant?: StoredServerGrant | null;
}
interface ProtectedGrant {
  scope: string;
  grant: StoredServerGrant;
  firstStoredAt: number;
  lastObservedAt: number;
}
const MAX_LIFETIME = 14 * 24 * 60 * 60 * 1000;
const CLOCK_TOLERANCE = 5 * 60 * 1000;

function serverPrefix(server: unknown): string | null {
  if (!accountPasswordScope(server, 'scope@example.test')) return null;
  const url = new URL((server as string).trim());
  const normalized = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return `${createHash('sha256').update(normalized).digest('hex')}:`;
}
function scopeFor(server: unknown, email: unknown): string | null {
  const account = accountPasswordScope(server, email);
  const prefix = serverPrefix(server);
  return account && prefix ? `${prefix}${account}` : null;
}

/** Dedicated OS-encrypted store. Exact URL and account scope are authenticated inside ciphertext. */
export class ServerAccessStore {
  constructor(private readonly file: string, private readonly encryption: PasswordEncryption,
    private readonly platform = process.platform, private readonly now = Date.now) {}

  status(): ServerAccessStoreResult {
    try {
      const available = this.encryption.isEncryptionAvailable() &&
        (this.platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(this.encryption.getSelectedStorageBackend?.() ?? ''));
      return { available, ok: available };
    } catch { return { available: false, ok: false }; }
  }
  private entries(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    const raw = readFileSync(this.file, 'utf8');
    if (raw.length > 2 * 1024 * 1024) throw new Error('Invalid server access store');
    const data = JSON.parse(raw) as { version?: unknown; entries?: unknown };
    if (data.version !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw new Error('Invalid server access store');
    if (Object.entries(data.entries).some(([scope, cipher]) => !/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(scope) ||
      typeof cipher !== 'string' || cipher.length > 40000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cipher))) throw new Error('Invalid server access store');
    return data.entries as Record<string, string>;
  }
  private write(entries: Record<string, string>): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, entries }), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.file);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private decode(scope: string, cipher: string): ProtectedGrant {
    const record = JSON.parse(this.encryption.decryptString(Buffer.from(cipher, 'base64'))) as ProtectedGrant;
    if (record.scope !== scope || !record.grant || typeof record.grant.accessToken !== 'string' ||
      !record.grant.accessToken || record.grant.accessToken.length > 16384 ||
      !Number.isFinite(record.grant.expiresAt) || !Number.isFinite(record.firstStoredAt) ||
      !Number.isFinite(record.lastObservedAt) || record.firstStoredAt > record.lastObservedAt ||
      record.grant.expiresAt > record.firstStoredAt + MAX_LIFETIME) throw new Error('Invalid protected server grant');
    return record;
  }
  private encode(record: ProtectedGrant): string {
    return this.encryption.encryptString(JSON.stringify(record)).toString('base64');
  }
  get(server: unknown, email: unknown): ServerAccessStoreResult {
    const status = this.status();
    if (!status.available) return status;
    const scope = scopeFor(server, email);
    if (!scope) return { available: true, ok: false };
    try {
      const entries = this.entries();
      if (!entries[scope]) return { available: true, ok: true, grant: null };
      const record = this.decode(scope, entries[scope]);
      const now = this.now();
      if (now + CLOCK_TOLERANCE < record.lastObservedAt || record.grant.expiresAt <= now) {
        delete entries[scope];
        this.write(entries);
        return { available: true, ok: true, grant: null };
      }
      record.lastObservedAt = Math.max(now, record.lastObservedAt);
      entries[scope] = this.encode(record);
      this.write(entries); // Fail closed if the clock watermark cannot be persisted.
      return { available: true, ok: true, grant: record.grant };
    } catch { return { available: true, ok: false }; }
  }
  set(server: unknown, email: unknown, value: unknown): ServerAccessStoreResult {
    const status = this.status();
    if (!status.available) return status;
    const scope = scopeFor(server, email);
    const grant = value as StoredServerGrant | null;
    const now = this.now();
    if (!scope || !grant || typeof grant.accessToken !== 'string' || !grant.accessToken ||
      grant.accessToken.length > 16384 || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now ||
      grant.expiresAt > now + MAX_LIFETIME + CLOCK_TOLERANCE) return { available: true, ok: false };
    try {
      const entries = this.entries();
      if (!entries[scope] && Object.keys(entries).length >= 64) return { available: true, ok: false };
      const previous = entries[scope] ? this.decode(scope, entries[scope]) : null;
      const retained = previous?.grant.accessToken === grant.accessToken ? previous : null;
      if (retained && now + CLOCK_TOLERANCE < retained.lastObservedAt) return { available: true, ok: false };
      const firstStoredAt = retained ? retained.firstStoredAt : now;
      const expiresAt = Math.min(grant.expiresAt, firstStoredAt + MAX_LIFETIME,
        retained ? retained.grant.expiresAt : Infinity);
      if (expiresAt <= now) return { available: true, ok: false };
      entries[scope] = this.encode({ scope, grant: { accessToken: grant.accessToken, expiresAt }, firstStoredAt,
        lastObservedAt: retained ? Math.max(now, retained.lastObservedAt) : now });
      this.write(entries);
      return { available: true, ok: true };
    } catch { return { available: true, ok: false }; }
  }
  remove(server: unknown, email?: unknown): ServerAccessStoreResult {
    const available = this.status().available;
    const prefix = serverPrefix(server);
    const scope = email === undefined ? null : scopeFor(server, email);
    if (!prefix || (email !== undefined && !scope)) return { available, ok: false };
    try {
      const entries = this.entries();
      Object.keys(entries).forEach(key => { if (scope ? key === scope : key.startsWith(prefix)) delete entries[key]; });
      this.write(entries);
      return { available, ok: true };
    } catch { return { available, ok: false }; }
  }
  clear(): ServerAccessStoreResult {
    const available = this.status().available;
    try { if (existsSync(this.file)) unlinkSync(this.file); return { available, ok: true }; }
    catch { return { available, ok: false }; }
  }
}
