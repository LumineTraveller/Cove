export type UpdateSourceId = 'github' | 'gitee';

export interface UpdateSourceCandidate {
  id: UpdateSourceId;
  label: 'GitHub' | 'Gitee';
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

const SOURCES: SourceDefinition[] = [
  {
    id: 'github',
    label: 'GitHub',
    apiUrl: 'https://api.github.com/repos/LumineTraveller/Cove/releases/latest',
    releaseBaseUrl: 'https://github.com/LumineTraveller/Cove/releases/download/',
  },
  {
    id: 'gitee',
    label: 'Gitee',
    apiUrl: 'https://gitee.com/api/v5/repos/LumineTraveller/Cove/releases/latest',
    releaseBaseUrl: 'https://gitee.com/LumineTraveller/Cove/releases/download/',
  },
];

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
 * 同时探测国内外两个 Release API。优先选择版本较新者；版本相同时选择
 * 响应更快者，另一个保留为下载失败时的自动回退源。
 */
export async function discoverUpdateSources(
  fetchImpl: FetchLike = fetch,
  timeoutMs = 6_000,
  now: () => number = Date.now,
): Promise<UpdateSourceCandidate[]> {
  const results = await Promise.allSettled(
    SOURCES.map(source => discoverSource(source, fetchImpl, timeoutMs, now)),
  );
  return results
    .flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    .sort((left, right) => compareReleaseVersions(right.version, left.version) || left.latencyMs - right.latencyMs);
}
