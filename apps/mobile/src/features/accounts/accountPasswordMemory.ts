import { NativeModules, Platform } from 'react-native';
import { normalizeServerSecurityURL } from '../connection/serverSecurity';
import { validAccountEmail } from './accountAuth';

export interface PasswordMemoryResult {
  available: boolean;
  ok: boolean;
  remembered?: boolean;
  password?: string | null;
  cancelled?: boolean;
}
export interface RememberedAccountPassword {
  serverURL: string;
  email: string;
}
export interface PasswordMemoryListResult extends PasswordMemoryResult {
  accounts: RememberedAccountPassword[];
}
interface PasswordMemoryNative {
  status(): Promise<PasswordMemoryResult>;
  get(serverURL: string, email: string): Promise<PasswordMemoryResult>;
  save(
    serverURL: string,
    email: string,
    password: string,
  ): Promise<PasswordMemoryResult>;
  remove(serverURL: string, email: string): Promise<PasswordMemoryResult>;
  clear(): Promise<PasswordMemoryResult>;
  list(): Promise<PasswordMemoryListResult>;
}
export interface AccountPasswordSaveIntent {
  readonly scope: string;
  readonly scopeRevision: number;
  readonly revision: number;
}

const native = (): PasswordMemoryNative | undefined =>
  Platform.OS === 'android' ? NativeModules.CoveAccountPasswords : undefined;
const unsupported: PasswordMemoryResult = { available: false, ok: false };
export const PASSWORD_MEMORY_UNAVAILABLE =
  '当前安装包无法安全记住账号密码，请手动填写；密码不会保存为明文。';
export const PASSWORD_MEMORY_FAILED =
  '无法安全读取或保存账号密码，请手动填写或重试。';
let revision = 0;
const scopeRevisions = new Map<string, number>();
let mutations: Promise<void> = Promise.resolve();

export function normalizeAccountPasswordScope(
  serverURL: string,
  email: string,
) {
  const server = normalizeServerSecurityURL(serverURL);
  const account = email.trim().toLowerCase();
  return server && validAccountEmail(account)
    ? {
        serverURL: server,
        email: account,
        key: JSON.stringify([server, account]),
      }
    : null;
}

/** Capture before authentication begins, so later cancellation can revoke saving. */
export function captureAccountPasswordSaveIntent(
  serverURL: string,
  email: string,
): AccountPasswordSaveIntent {
  const scope = normalizeAccountPasswordScope(serverURL, email)?.key ?? '';
  return { scope, scopeRevision: scopeRevisions.get(scope) ?? 0, revision };
}
function current(intent: AccountPasswordSaveIntent) {
  return (
    intent.revision === revision &&
    intent.scopeRevision === (scopeRevisions.get(intent.scope) ?? 0)
  );
}
export function invalidateAccountPasswordSave(
  serverURL: string,
  email: string,
) {
  const scope = normalizeAccountPasswordScope(serverURL, email)?.key;
  if (scope) scopeRevisions.set(scope, (scopeRevisions.get(scope) ?? 0) + 1);
}
/** Cancel pending saves on logout without deleting completed, opted-in credentials. */
export function invalidateAccountPasswordSaves() {
  revision += 1;
}

function queueMutation<T>(run: () => Promise<T>): Promise<T> {
  const result = mutations.then(run, run);
  mutations = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
function resultWithoutPassword(
  result: PasswordMemoryResult,
): PasswordMemoryResult {
  return {
    available: result.available === true,
    ok: result.ok === true,
    remembered: result.remembered === true,
  };
}

export async function passwordMemoryStatus(): Promise<PasswordMemoryResult> {
  const module = native();
  try {
    return module ? resultWithoutPassword(await module.status()) : unsupported;
  } catch {
    return { available: !!module, ok: false };
  }
}

export async function listAccountPasswords(): Promise<PasswordMemoryListResult> {
  const module = native();
  try {
    const result = await module?.list();
    if (!result) return { ...unsupported, accounts: [] };
    const scopes = new Map<string, RememberedAccountPassword>();
    if (result.ok && Array.isArray(result.accounts)) {
      for (const account of result.accounts) {
        if (
          typeof account?.serverURL !== 'string' ||
          typeof account.email !== 'string'
        )
          continue;
        const scope = normalizeAccountPasswordScope(
          account.serverURL,
          account.email,
        );
        if (scope)
          scopes.set(scope.key, {
            serverURL: scope.serverURL,
            email: scope.email,
          });
      }
    }
    return { ...resultWithoutPassword(result), accounts: [...scopes.values()] };
  } catch {
    return { available: !!module, ok: false, accounts: [] };
  }
}

export async function readAccountPassword(
  serverURL: string,
  email: string,
): Promise<PasswordMemoryResult> {
  const scope = normalizeAccountPasswordScope(serverURL, email);
  if (!scope) return { ...unsupported, password: null };
  const intent = captureAccountPasswordSaveIntent(serverURL, email);
  const module = native();
  try {
    const result = await module?.get(scope.serverURL, scope.email);
    if (!result) return { ...unsupported, password: null };
    if (!current(intent))
      return {
        available: result.available === true,
        ok: true,
        remembered: false,
        password: null,
        cancelled: true,
      };
    return {
      ...resultWithoutPassword(result),
      password:
        result.ok && result.remembered && typeof result.password === 'string'
          ? result.password
          : null,
    };
  } catch {
    return { available: !!module, ok: false, password: null };
  }
}

export async function saveAuthenticatedAccountPassword(
  serverURL: string,
  email: string,
  password: string,
  remember: boolean,
  intent: AccountPasswordSaveIntent,
): Promise<PasswordMemoryResult> {
  if (!remember) return { available: !!native(), ok: true, remembered: false };
  const scope = normalizeAccountPasswordScope(serverURL, email);
  if (!scope || intent.scope !== scope.key || !password) return unsupported;
  return queueMutation(async () => {
    const module = native();
    if (!module) return unsupported;
    if (!current(intent)) return { available: true, ok: true, cancelled: true };
    try {
      const result = resultWithoutPassword(
        await module.save(scope.serverURL, scope.email, password),
      );
      if (current(intent)) return result;
      // A deletion can arrive while the native save is executing. Remove its
      // result before allowing the next queued mutation to run.
      const removed = resultWithoutPassword(
        await module.remove(scope.serverURL, scope.email),
      );
      return { ...removed, remembered: false, cancelled: true };
    } catch {
      if (!current(intent)) {
        try {
          const removed = resultWithoutPassword(
            await module.remove(scope.serverURL, scope.email),
          );
          return { ...removed, remembered: false, cancelled: true };
        } catch {
          return { available: true, ok: false, cancelled: true };
        }
      }
      return { available: true, ok: false };
    }
  });
}

export function removeAccountPassword(
  serverURL: string,
  email: string,
): Promise<PasswordMemoryResult> {
  invalidateAccountPasswordSave(serverURL, email);
  const scope = normalizeAccountPasswordScope(serverURL, email);
  return queueMutation(async () => {
    const module = native();
    if (!module || !scope)
      return { available: !!module, ok: true, remembered: false };
    try {
      return resultWithoutPassword(
        await module.remove(scope.serverURL, scope.email),
      );
    } catch {
      return { available: true, ok: false };
    }
  });
}
export function clearAccountPasswords(): Promise<PasswordMemoryResult> {
  invalidateAccountPasswordSaves();
  return queueMutation(async () => {
    const module = native();
    if (!module) return { available: false, ok: true, remembered: false };
    try {
      return resultWithoutPassword(await module.clear());
    } catch {
      return { available: true, ok: false };
    }
  });
}
