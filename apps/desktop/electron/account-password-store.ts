import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface AccountPasswordResult {
  available: boolean;
  ok: boolean;
  password?: string | null;
}
export interface PasswordEncryption {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export function accountPasswordScope(server: unknown, email: unknown): string | null {
  if (typeof server !== 'string' || typeof email !== 'string' || server.length > 2048) return null;
  try {
    const url = new URL(server.trim());
    const account = email.trim().toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      account.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account)) return null;
    return createHash('sha256').update(JSON.stringify([`${url.origin}${url.pathname.replace(/\/+$/, '')}`, account])).digest('hex');
  } catch { return null; }
}

/** Only OS-encrypted, scope-bound ciphertext is written to this dedicated file. */
export class AccountPasswordStore {
  constructor(private readonly file: string, private readonly encryption: PasswordEncryption, private readonly platform = process.platform) {}
  status(): AccountPasswordResult {
    try {
      const available = this.encryption.isEncryptionAvailable() &&
        (this.platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(this.encryption.getSelectedStorageBackend?.() ?? ''));
      return { available, ok: available };
    } catch { return { available: false, ok: false }; }
  }
  private entries(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    const raw = readFileSync(this.file, 'utf8');
    if (raw.length > 1024 * 1024) throw new Error('Invalid credential store');
    const value = JSON.parse(raw) as { version?: unknown; entries?: unknown };
    if (value.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) throw new Error('Invalid credential store');
    const entries = value.entries as Record<string, unknown>;
    if (Object.entries(entries).some(([key, cipher]) => !/^[a-f0-9]{64}$/.test(key) || typeof cipher !== 'string' || cipher.length > 20000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cipher))) throw new Error('Invalid credential store');
    return entries as Record<string, string>;
  }
  private write(entries: Record<string, string>) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, entries }), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.file);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  get(server: unknown, email: unknown): AccountPasswordResult {
    const status = this.status();
    if (!status.available) return status;
    const key = accountPasswordScope(server, email);
    if (!key) return { available: true, ok: false };
    try {
      const cipher = this.entries()[key];
      if (!cipher) return { available: true, ok: true, password: null };
      const value = JSON.parse(this.encryption.decryptString(Buffer.from(cipher, 'base64'))) as { scope?: unknown; password?: unknown };
      if (value.scope !== key || typeof value.password !== 'string') return { available: true, ok: false };
      return { available: true, ok: true, password: value.password };
    } catch { return { available: true, ok: false }; }
  }
  set(server: unknown, email: unknown, password: unknown): AccountPasswordResult {
    const status = this.status();
    if (!status.available) return status;
    const key = accountPasswordScope(server, email);
    if (!key || typeof password !== 'string' || password.length < 8 || password.length > 4096) return { available: true, ok: false };
    try {
      const entries = this.entries();
      if (!entries[key] && Object.keys(entries).length >= 64) return { available: true, ok: false };
      const encrypted = this.encryption.encryptString(JSON.stringify({ scope: key, password })).toString('base64');
      this.write({ ...entries, [key]: encrypted });
      return { available: true, ok: true };
    } catch { return { available: true, ok: false }; }
  }
  remove(server: unknown, email: unknown): AccountPasswordResult {
    const available = this.status().available;
    const key = accountPasswordScope(server, email);
    if (!key) return { available, ok: false };
    try {
      const entries = this.entries();
      if (entries[key]) { delete entries[key]; this.write(entries); }
      return { available, ok: true };
    } catch { return { available, ok: false }; }
  }
  clear(): AccountPasswordResult {
    const available = this.status().available;
    try { if (existsSync(this.file)) unlinkSync(this.file); return { available, ok: true }; }
    catch { return { available, ok: false }; }
  }
}
