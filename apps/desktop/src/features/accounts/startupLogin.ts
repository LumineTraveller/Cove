export interface StartupAccount {
  serverUrl: string;
  email: string;
  accountId: string;
  token: string;
}

export type StartupLoginResult = 'ready' | 'login' | 'server-required' | 'offline';

/** One probe per active account, including concurrent React startup effects.
 * Never exchange an account password here: a revoked account must stay revoked.
 */
export function createStartupLoginCheck(deps: {
  restore: (server: string, email: string) => Promise<boolean>;
  status: (server: string, signal: AbortSignal) => Promise<{ enabled: boolean; authorized: boolean }>;
  reject: (server: string, email: string) => Promise<void>;
  timeoutMs?: number;
}) {
  const pending = new Map<string, Promise<StartupLoginResult>>();
  return (account: StartupAccount | null): Promise<StartupLoginResult> => {
    if (!account?.token) return Promise.resolve('login');
    const key = JSON.stringify([account.serverUrl, account.email.toLowerCase(), account.token]);
    const existing = pending.get(key);
    if (existing) return existing;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const operation = async (): Promise<StartupLoginResult> => {
      await deps.restore(account.serverUrl, account.email);
      if (controller.signal.aborted) return 'offline';
      const status = await deps.status(account.serverUrl, controller.signal);
      if (controller.signal.aborted) return 'offline';
      if (!status.enabled || status.authorized) return 'ready';
      await deps.reject(account.serverUrl, account.email);
      return 'server-required';
    };
    const timeout = new Promise<StartupLoginResult>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve('offline'); }, deps.timeoutMs ?? 12_000);
    });
    const result = Promise.race([operation().catch(() => 'offline' as const), timeout])
      .finally(() => { clearTimeout(timer); pending.delete(key); });
    pending.set(key, result);
    return result;
  };
}
