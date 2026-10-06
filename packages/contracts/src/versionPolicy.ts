/** Stable release identity and the first supported client version. */
export const COVE_RELEASE_VERSION = '2.0.0';
export const MINIMUM_CLIENT_VERSION = '2.0.0';

interface SemanticVersion {
  core: number[];
  prerelease: string[];
}

function parseVersion(value: unknown): SemanticVersion | null {
  if (typeof value !== 'string') return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  if (core.some(number => !Number.isSafeInteger(number))) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;
  return {core, prerelease};
}

/** SemVer precedence; invalid versions have no ordering. Build metadata is ignored. */
export function compareSemanticVersions(left: unknown, right: unknown): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return x.length !== y.length ? x.length > y.length ? 1 : -1 : x > y ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function isSupportedClientVersion(version: unknown, minimum: unknown = MINIMUM_CLIENT_VERSION): boolean {
  const comparison = compareSemanticVersions(version, minimum);
  return comparison !== null && comparison >= 0;
}
