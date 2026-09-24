// Discover the selected server's HTTPS mirror first and GitHub as fallback.
export type UpdateSourceId = 'github' | 'cloud';

export interface UpdateSourceCandidate {
  id: UpdateSourceId;
  label: 'GitHub' | 'Cove 服务器' | '当前服务器';
  version: string;
  feedUrl: string;
  latencyMs: number;
}

interface SourceDefinition {
  id: UpdateSourceId;
  label: UpdateSourceCandidate['label'];
  apiUrl: string;
  releaseBaseUrl: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const GITHUB_SOURCE: SourceDefinition = {
  id: 'github',
  label: 'GitHub',
  apiUrl: 'https://api.github.com/repos/LumineTraveller/Cove/releases/latest',
  releaseBaseUrl: 'https://github.com/LumineTraveller/Cove/releases/download/',
};

/** Only a valid HTTPS chat-server URL may host automatic update metadata. */
export function getServerUpdateBaseUrl(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function createServerSource(serverUrl: string): SourceDefinition | null {
  const baseUrl = getServerUpdateBaseUrl(serverUrl);
  if (!baseUrl) return null;
  return {
    id: 'cloud',
    label: '当前服务器',
    apiUrl: `${baseUrl}/releases/latest.json`,
    releaseBaseUrl: `${baseUrl}/releases/`,
  };
}

function numericVersion(version: string): number[] {
  return version.replace(/^v/i, '').split(/[.-]/).map(part => Number.parseInt(part, 10) || 0);
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = numericVersion(left);
  const b = numericVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

async function discoverSource(
  source: SourceDefinition,
  fetchImpl: FetchLike,
  timeoutMs: number,
  now: () => number,
): Promise<UpdateSourceCandidate> {
  const startedAt = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(source.apiUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'Cove-Updater' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${source.label} Release API 返回 HTTP ${response.status}`);
    const release = await response.json() as { tag_name?: unknown; prerelease?: unknown; draft?: unknown };
    if (release.draft === true || release.prerelease === true || typeof release.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+/.test(release.tag_name)) {
      throw new Error(`${source.label} 没有可用的正式版本`);
    }
    const tag = release.tag_name;
    return {
      id: source.id,
      label: source.label,
      version: tag.replace(/^v/i, ''),
      feedUrl: `${source.releaseBaseUrl}${encodeURIComponent(tag)}/`,
      latencyMs: Math.max(0, now() - startedAt),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 先按固定顺序探测更新源，再优先返回版本较新的正式发行版。
 *
 * 当前服务器和 GitHub 使用同一份 electron-builder 更新清单和校验值。
 * 同版本时当前服务器优先；如果镜像落后，则先用 GitHub，避免可访问但
 * 尚未同步的镜像把新版本隐藏掉。
 */
export async function discoverUpdateSources(
  serverUrl = '',
  fetchImpl: FetchLike = fetch,
  timeoutMs = 6_000,
  now: () => number = Date.now,
): Promise<UpdateSourceCandidate[]> {
  const sources = [createServerSource(serverUrl), GITHUB_SOURCE].filter(
    (source): source is SourceDefinition => source !== null,
  );
  const discovered: UpdateSourceCandidate[] = [];
  for (const source of sources) {
    try {
      discovered.push(await discoverSource(source, fetchImpl, timeoutMs, now));
    } catch {
      // Keep probing the lower-priority mirror when the preferred source is
      // unavailable. The updater will report an error only if both fail.
    }
  }
  return discovered
    .map((source, order) => ({ source, order }))
    .sort((left, right) => compareReleaseVersions(right.source.version, left.source.version) || left.order - right.order)
    .map(({ source }) => source);
}
