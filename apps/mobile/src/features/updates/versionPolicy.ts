import {
  compareSemanticVersions,
  isSupportedClientVersion,
  CLIENT_PROTOCOL_VERSION,
} from '@cove/contracts';
import {
  MOBILE_RELEASE_VERSION,
  MOBILE_MINIMUM_VERSION,
} from '../connection/clientVersion';

export interface ClientUpgradePolicy {
  minimumClientVersion: string;
  upgradeRequired: boolean;
  serverVersion?: string;
  downloadUrl?: string;
  requiredClientProtocol?: number;
}

export function readUpgradePolicy(
  payload: unknown,
  installedVersion: unknown = MOBILE_RELEASE_VERSION,
): ClientUpgradePolicy | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  const minimum = value.minimumClientVersion;
  if (
    typeof minimum !== 'string' ||
    compareSemanticVersions(minimum, minimum) === null
  )
    return null;
  return {
    minimumClientVersion: minimum,
    upgradeRequired:
      value.upgradeRequired === true ||
      !isSupportedClientVersion(installedVersion, minimum) ||
      (typeof value.requiredClientProtocol === 'number' &&
        value.requiredClientProtocol > CLIENT_PROTOCOL_VERSION),
    ...(typeof value.requiredClientProtocol === 'number'
      ? { requiredClientProtocol: value.requiredClientProtocol }
      : {}),
    ...(typeof value.serverVersion === 'string'
      ? { serverVersion: value.serverVersion }
      : {}),
    ...(safeUpgradeURL(value.downloadUrl)
      ? { downloadUrl: value.downloadUrl as string }
      : {}),
  };
}

export function safeUpgradeURL(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

// A server rejection can arrive from either HTTP, security status, or Socket.IO.
// Keep a single notification path without importing React into network adapters.
const listeners = new Set<(policy: ClientUpgradePolicy) => void>();
let pending: ClientUpgradePolicy | null = null;

export function requireClientUpgrade(payload?: unknown): void {
  const policy = readUpgradePolicy(payload) ?? {
    minimumClientVersion: MOBILE_MINIMUM_VERSION,
    upgradeRequired: true,
  };
  pending = { ...policy, upgradeRequired: true };
  listeners.forEach(listener => listener(pending!));
}

export function subscribeClientUpgrade(
  listener: (policy: ClientUpgradePolicy) => void,
): () => void {
  listeners.add(listener);
  if (pending) listener(pending);
  return () => {
    listeners.delete(listener);
  };
}
