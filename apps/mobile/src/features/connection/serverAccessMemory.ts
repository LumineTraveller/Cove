import { NativeModules, Platform } from 'react-native';
import {
  clearServerAccessToken,
  clearAllServerAccessTokens,
  invalidateServerAccessExchanges,
  normalizeServerSecurityURL,
  setServerAccessToken,
  type ServerAccessGrant,
} from './serverSecurity';

export const SERVER_ACCESS_MAX_AGE = 14 * 24 * 60 * 60 * 1000;
export interface RememberedServerAccess extends ServerAccessGrant {
  verifiedAt: number;
  lastObservedAt: number;
}
interface NativeResult {
  available: boolean;
  ok: boolean;
  value?: string | null;
}
interface NativeStore {
  get(server: string, email: string): Promise<NativeResult>;
  save(server: string, email: string, value: string): Promise<NativeResult>;
  remove(server: string, email: string): Promise<NativeResult>;
  clear(): Promise<NativeResult>;
}
export interface ServerAccessIntent {
  revision: number;
  scope: string;
  scopeRevision: number;
}
const native = (): NativeStore | undefined =>
  Platform.OS === 'android' ? NativeModules.CoveServerAccessGrants : undefined;
let revision = 0;
export const serverAccessGeneration = () => revision;
const revisions = new Map<string, number>();
const activeScopes = new Map<string, string>();
let mutations: Promise<unknown> = Promise.resolve();
function scopeFor(server: string, email: string) {
  const serverURL = normalizeServerSecurityURL(server);
  const account = email.trim().toLowerCase();
  return serverURL && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account)
    ? { serverURL, email: account, key: JSON.stringify([serverURL, account]) }
    : null;
}
export function captureServerAccessIntent(
  server: string,
  email: string,
): ServerAccessIntent {
  const scope = scopeFor(server, email)?.key ?? '';
  return { revision, scope, scopeRevision: revisions.get(scope) ?? 0 };
}
export function isServerAccessIntentCurrent(intent: ServerAccessIntent) {
  return (
    intent.revision === revision &&
    intent.scopeRevision === (revisions.get(intent.scope) ?? 0)
  );
}
const current = isServerAccessIntentCurrent;
export function invalidateServerAccessOperations() {
  revision += 1;
  invalidateServerAccessExchanges();
}
function queue<T>(run: () => Promise<T>): Promise<T> {
  const next = mutations.then(run, run);
  mutations = next.catch(() => undefined);
  return next;
}
export function validRememberedServerAccess(
  value: unknown,
  now = Date.now(),
): value is RememberedServerAccess {
  const grant = value as RememberedServerAccess | null;
  return (
    !!grant &&
    typeof grant.accessToken === 'string' &&
    !!grant.accessToken &&
    grant.accessToken.length <= 3000 &&
    Number.isFinite(grant.expiresAt) &&
    Number.isFinite(grant.verifiedAt) &&
    Number.isFinite(grant.lastObservedAt) &&
    grant.verifiedAt > 0 &&
    grant.lastObservedAt >= grant.verifiedAt &&
    now >= grant.lastObservedAt &&
    now < grant.expiresAt &&
    grant.expiresAt > grant.verifiedAt &&
    grant.expiresAt <= grant.verifiedAt + SERVER_ACCESS_MAX_AGE
  );
}

/** Save only the original password-verification receipt; never mint a new lifetime. */
export function rememberServerAccess(
  server: string,
  email: string,
  grant: ServerAccessGrant,
  intent: ServerAccessIntent,
): Promise<boolean> {
  const scope = scopeFor(server, email);
  if (
    !scope ||
    scope.key !== intent.scope ||
    !validRememberedServerAccess(grant)
  )
    return Promise.resolve(false);
  return queue(async () => {
    const store = native();
    if (!store || !current(intent)) return false;
    try {
      const result = await store.save(
        scope.serverURL,
        scope.email,
        JSON.stringify(grant),
      );
      if (!current(intent)) {
        await store.remove(scope.serverURL, scope.email);
        clearServerAccessToken(scope.serverURL);
        return false;
      }
      if (result.ok) activeScopes.set(scope.serverURL, scope.key);
      return result.ok;
    } catch {
      return false;
    }
  });
}

/** Exact server/account lookup, with a persisted wall-clock high-water mark. */
export function restoreServerAccess(
  server: string,
  email: string,
  isScopeCurrent: () => boolean = () => true,
): Promise<RememberedServerAccess | null> {
  const scope = scopeFor(server, email);
  if (!scope || !isScopeCurrent()) return Promise.resolve(null);
  const intent = captureServerAccessIntent(server, email);
  const mayRestore = () => current(intent) && isScopeCurrent();
  if (activeScopes.get(scope.serverURL) !== scope.key)
    clearServerAccessToken(scope.serverURL);
  return queue(async () => {
    const store = native();
    if (!store || !mayRestore()) return null;
    try {
      const result = await store.get(scope.serverURL, scope.email);
      if (!result.ok || !mayRestore()) return null;
      const grant: unknown = result.value ? JSON.parse(result.value) : null;
      if (!validRememberedServerAccess(grant)) {
        if (result.value) await store.remove(scope.serverURL, scope.email);
        if (!mayRestore()) return null;
        clearServerAccessToken(scope.serverURL);
        return null;
      }
      const observed = { ...grant, lastObservedAt: Date.now() };
      const saved = await store.save(
        scope.serverURL,
        scope.email,
        JSON.stringify(observed),
      );
      if (!saved.ok || !mayRestore()) return null;
      activeScopes.set(scope.serverURL, scope.key);
      setServerAccessToken(scope.serverURL, observed);
      return observed;
    } catch {
      return null;
    }
  });
}
export function forgetServerAccess(
  server: string,
  email: string,
): Promise<boolean> {
  const scope = scopeFor(server, email);
  if (!scope) return Promise.resolve(true);
  revisions.set(scope.key, (revisions.get(scope.key) ?? 0) + 1);
  if (
    activeScopes.get(scope.serverURL) === scope.key ||
    !activeScopes.has(scope.serverURL)
  ) {
    activeScopes.delete(scope.serverURL);
    clearServerAccessToken(scope.serverURL);
  } else {
    invalidateServerAccessExchanges();
  }
  return queue(async () => {
    const store = native();
    try {
      return store
        ? (await store.remove(scope.serverURL, scope.email)).ok
        : true;
    } catch {
      return false;
    }
  });
}
export function forgetAllServerAccess(): Promise<boolean> {
  invalidateServerAccessOperations();
  clearAllServerAccessTokens();
  activeScopes.clear();
  return queue(async () => {
    const store = native();
    try {
      return store ? (await store.clear()).ok : true;
    } catch {
      return false;
    }
  });
}
