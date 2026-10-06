import { CLIENT_PROTOCOL_VERSION, MINIMUM_CLIENT_VERSION, compareSemanticVersions, isSupportedClientVersion } from '@cove/contracts';
import packageInfo from '../../../package.json';

export const CLIENT_VERSION = packageInfo.version;
export const CLIENT_PLATFORM = 'desktop' as const;
export const CLIENT_UPGRADE_EVENT = 'cove:client-upgrade-required';
export const OFFICIAL_RELEASE_URL = 'https://github.com/LumineTraveller/Cove/releases/latest';

export interface ClientVersionPolicy {
  serverVersion?: string;
  minimumClientVersion: string;
  downloadUrl?: string;
}

export interface ClientUpgradeRequirement extends ClientVersionPolicy {
  serverURL: string;
}

export function safeUpgradeDownloadUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
        url.username || url.password || url.search || url.hash) return undefined;
    return url.toString();
  } catch { return undefined; }
}

export function readClientVersionPolicy(payload: unknown): ClientVersionPolicy | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  if (value.clientPlatform !== undefined && value.clientPlatform !== CLIENT_PLATFORM) return null;
  if (typeof value.minimumClientVersion !== 'string' ||
      compareSemanticVersions(value.minimumClientVersion, value.minimumClientVersion) === null ||
      !isSupportedClientVersion(value.minimumClientVersion, MINIMUM_CLIENT_VERSION)) return null;
  return {
    minimumClientVersion: value.minimumClientVersion,
    ...(typeof value.serverVersion === 'string' ? { serverVersion: value.serverVersion } : {}),
    ...(safeUpgradeDownloadUrl(value.downloadUrl) ? { downloadUrl: safeUpgradeDownloadUrl(value.downloadUrl) } : {}),
  };
}

export function requiresClientUpgrade(policy: ClientVersionPolicy, version = CLIENT_VERSION): boolean {
  return !isSupportedClientVersion(version, policy.minimumClientVersion);
}

// Metadata can advertise an upgrade incorrectly. The version comparison is the
// authority; an absent/invalid minimum never turns a network error into a gate.
export function notifyClientUpgrade(serverURL: string, payload: unknown): void {
  const policy = readClientVersionPolicy(payload);
  if (policy && requiresClientUpgrade(policy) && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<ClientUpgradeRequirement>(CLIENT_UPGRADE_EVENT, {
      detail: { ...policy, serverURL },
    }));
  }
}

export type ClientVersionCheck =
  | { status: 'required'; policy: ClientVersionPolicy }
  | { status: 'supported'; policy: ClientVersionPolicy }
  | { status: 'unavailable' };

export function createClientVersionGate(options: {
  version?: string;
  fetchPolicy: (serverURL: string) => Promise<unknown>;
  onRequired: (requirement: ClientUpgradeRequirement) => void;
  onSupported?: (serverURL: string) => void;
}) {
  const pending = new Map<string, Promise<ClientVersionCheck>>();
  const announced = new Map<string, string>();
  const observe = (serverURL: string, payload: unknown): ClientVersionCheck => {
    const policy = readClientVersionPolicy(payload);
    if (!policy) return { status: 'unavailable' };
    if (!requiresClientUpgrade(policy, options.version ?? CLIENT_VERSION)) {
      announced.delete(serverURL);
      options.onSupported?.(serverURL);
      return { status: 'supported', policy };
    }
    if (announced.get(serverURL) !== policy.minimumClientVersion) {
      announced.set(serverURL, policy.minimumClientVersion);
      options.onRequired({ ...policy, serverURL });
    }
    return { status: 'required', policy };
  };
  const check = (serverURL: string): Promise<ClientVersionCheck> => {
    const existing = pending.get(serverURL);
    if (existing) return existing;
    const result = Promise.resolve().then(() => options.fetchPolicy(serverURL))
      .then(payload => observe(serverURL, payload))
      .catch((): ClientVersionCheck => ({ status: 'unavailable' }))
      .finally(() => { pending.delete(serverURL); });
    pending.set(serverURL, result);
    return result;
  };
  return { check, observe };
}

// This is a public compatibility probe, separate from login and from the fixed
// updater feed. A chat server's download URL is only a manual download option.
export async function fetchClientVersionPolicy(serverURL: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(`${serverURL.replace(/\/+$/, '')}/api/version`, {
      headers: {
        'X-Cove-Client-Protocol': String(CLIENT_PROTOCOL_VERSION),
        'X-Cove-Client-Version': CLIENT_VERSION,
        'X-Cove-Client-Platform': CLIENT_PLATFORM,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Version probe returned HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}
