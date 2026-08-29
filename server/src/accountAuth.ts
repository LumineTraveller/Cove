import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import type Database from 'better-sqlite3';
import { promisify } from 'util';

const scrypt = promisify(scryptCallback);
const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export interface PublicAccount {
  id: string;
  email: string;
  username: string;
  avatarUrl: string | null;
}

interface AccountRecord extends PublicAccount {
  passwordHash: string;
  passwordSalt: string;
}

export class AccountAuthError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function derivePassword(password: string, salt: string): Promise<Buffer> {
  return scrypt(password, salt, 64) as Promise<Buffer>;
}

export async function passwordMatches(password: string, salt: string, passwordHash: string): Promise<boolean> {
  const actual = await derivePassword(password, salt);
  const expected = Buffer.from(passwordHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createAccountStore(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      passwordHash TEXT NOT NULL,
      passwordSalt TEXT NOT NULL,
      username TEXT NOT NULL,
      avatarUrl TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_sessions (
      tokenHash TEXT PRIMARY KEY,
      accountId TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      FOREIGN KEY (accountId) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS account_sessions_account_id ON account_sessions(accountId);
  `);

  const getByEmail = db.prepare('SELECT * FROM accounts WHERE email = ?');
  const getById = db.prepare('SELECT * FROM accounts WHERE id = ?');
  const insertAccount = db.prepare('INSERT INTO accounts (id, email, passwordHash, passwordSalt, username, avatarUrl, createdAt) VALUES (?, ?, ?, ?, ?, NULL, ?)');
  const insertSession = db.prepare('INSERT INTO account_sessions (tokenHash, accountId, expiresAt, createdAt) VALUES (?, ?, ?, ?)');
  const getSessionAccount = db.prepare(`
    SELECT accounts.* FROM account_sessions
    JOIN accounts ON accounts.id = account_sessions.accountId
    WHERE account_sessions.tokenHash = ? AND account_sessions.expiresAt > ?
  `);
  const removeSession = db.prepare('DELETE FROM account_sessions WHERE tokenHash = ?');
  const removeExpired = db.prepare('DELETE FROM account_sessions WHERE expiresAt <= ?');
  const updateProfile = db.prepare('UPDATE accounts SET username = ?, avatarUrl = ? WHERE id = ?');

  const publicAccount = (record: AccountRecord): PublicAccount => ({
    id: record.id, email: record.email, username: record.username, avatarUrl: record.avatarUrl,
  });
  const issueSession = (accountId: string) => {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    removeExpired.run(now);
    insertSession.run(tokenHash(token), accountId, now + SESSION_LIFETIME_MS, now);
    return token;
  };

  return {
    async register(emailValue: string, password: string, usernameValue: string) {
      const email = normalizeEmail(emailValue);
      const username = usernameValue.trim().slice(0, 64);
      if (!validEmail(email)) throw new AccountAuthError(400, '邮箱格式不正确');
      if (password.length < 8 || password.length > 128) throw new AccountAuthError(400, '密码长度应为 8–128 个字符');
      if (!username) throw new AccountAuthError(400, '用户名不能为空');
      if (getByEmail.get(email)) throw new AccountAuthError(409, '该邮箱已注册');
      const id = randomUUID();
      const salt = randomBytes(16).toString('hex');
      const passwordHash = (await derivePassword(password, salt)).toString('hex');
      try { insertAccount.run(id, email, passwordHash, salt, username, Date.now()); }
      catch { throw new AccountAuthError(409, '该邮箱已注册'); }
      const account = publicAccount(getById.get(id) as AccountRecord);
      return { account, token: issueSession(id) };
    },

    async login(emailValue: string, password: string) {
      const email = normalizeEmail(emailValue);
      const record = getByEmail.get(email) as AccountRecord | undefined;
      if (!record || password.length > 128) throw new AccountAuthError(401, '邮箱或密码错误');
      if (!await passwordMatches(password, record.passwordSalt, record.passwordHash))
        throw new AccountAuthError(401, '邮箱或密码错误');
      return { account: publicAccount(record), token: issueSession(record.id) };
    },

    accountForToken(token: unknown): PublicAccount | null {
      if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
      const record = getSessionAccount.get(tokenHash(token), Date.now()) as AccountRecord | undefined;
      return record ? publicAccount(record) : null;
    },

    logout(token: unknown) {
      if (typeof token === 'string') removeSession.run(tokenHash(token));
    },

    updateProfile(accountId: string, username: string, avatarUrl: string | null) {
      updateProfile.run(username, avatarUrl, accountId);
    },
  };
}
