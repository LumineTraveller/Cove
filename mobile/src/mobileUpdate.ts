export type UpdateSource = 'github' | 'gitee';
export const UPDATE_SOURCES: UpdateSource[] = ['github', 'gitee'];
export const SOURCE_NAMES = { github: 'GitHub', gitee: 'Gitee' };

export interface InstalledVersion { versionName: string; versionCode: number; androidApi: number }
export interface AndroidRelease {
  versionName: string;
  versionCode: number;
  minAndroidApi: number;
  packageName: 'com.cove.mobile';
  tag: string;
  filename: string;
  size: number;
  sha256: string;
  notes: string;
}
export interface UpdateCandidate { release: AndroidRelease; sources: UpdateSource[] }
export interface UpdateCheckResult { candidate: UpdateCandidate | null; checkedSources: UpdateSource[]; errors: string[] }

// Native requests have their own deadline; this also covers a missing/hung bridge callback.
export async function withUpdateTimeout<T>(operation: Promise<T>, milliseconds = 18000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('更新检查超时，请稍后重试')), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function parseUpdateFeed(raw: string): AndroidRelease | null {
  const feed = JSON.parse(raw);
  if (feed?.schemaVersion !== 1 || feed.platform !== 'android') throw new Error('不是有效的 Android 更新清单');
  if (feed.release === null) return null;
  const r = feed.release;
  if (!r || typeof r.versionName !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(r.versionName)
    || !Number.isSafeInteger(r.versionCode) || r.versionCode <= 0 || r.versionCode > 2100000000
    || !Number.isSafeInteger(r.minAndroidApi) || r.minAndroidApi < 23 || r.minAndroidApi > 100
    || r.packageName !== 'com.cove.mobile' || typeof r.tag !== 'string'
    || !(r.tag === `mobile-v${r.versionName}` || /^v\d+\.\d+\.\d+$/.test(r.tag))
    || r.filename !== `Cove-Mobile-${r.versionName}.apk`
    || !Number.isSafeInteger(r.size) || r.size <= 0 || r.size > 1024 * 1024 * 1024
    || typeof r.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(r.sha256)
    || typeof r.notes !== 'string' || r.notes.length > 12000) throw new Error('Android 更新清单字段不完整或不安全');
  return { ...r, sha256: r.sha256.toLowerCase() };
}

export function releaseURL(release: AndroidRelease, source: UpdateSource, download = false): string {
  if (!UPDATE_SOURCES.includes(source)) throw new Error('未知更新源');
  const base = source === 'github' ? 'https://github.com' : 'https://gitee.com';
  return `${base}/LumineTraveller/Cove/releases/${download ? 'download' : 'tag'}/${encodeURIComponent(release.tag)}${download ? `/${encodeURIComponent(release.filename)}` : ''}`;
}

/** Both mirrors are checked; a fast but stale mirror must not hide a newer release. */
export async function checkAndroidUpdate(
  installed: InstalledVersion,
  fetchFeed: (source: UpdateSource) => Promise<string>,
): Promise<UpdateCheckResult> {
  if (!Number.isSafeInteger(installed.versionCode) || installed.versionCode < 1
    || !Number.isSafeInteger(installed.androidApi) || installed.androidApi < 1) throw new Error('无法读取当前 APK 版本');
  const errors: string[] = [];
  const results = await Promise.all(UPDATE_SOURCES.map(async source => {
    const started = Date.now();
    try { return { source, release: parseUpdateFeed(await withUpdateTimeout(fetchFeed(source))), elapsed: Date.now() - started }; }
    catch { errors.push(`${SOURCE_NAMES[source]} 检查失败`); return null; }
  }));
  const successful = results.filter((r): r is NonNullable<typeof r> => r !== null);
  if (!successful.length) throw new Error('GitHub 和 Gitee 均无法检查更新，请检查网络后重试');
  const newer = successful.filter(r => r.release && r.release.versionCode > installed.versionCode)
    .sort((a, b) => b.release!.versionCode - a.release!.versionCode || a.elapsed - b.elapsed);
  const latest = newer[0]?.release;
  const checkedSources = successful.map(r => r.source);
  if (!latest) return { candidate: null, checkedSources, errors };
  const matching = newer.filter(r => r.release!.versionCode === latest.versionCode);
  if (matching.some(r => r.release!.sha256 !== latest.sha256 || r.release!.versionName !== latest.versionName
    || r.release!.size !== latest.size || r.release!.minAndroidApi !== latest.minAndroidApi
    || r.release!.tag !== latest.tag)) throw new Error('两个更新源的安装包信息不一致，暂不下载，请联系发布者');
  if (latest.minAndroidApi > installed.androidApi) throw new Error(`新版需要 Android API ${latest.minAndroidApi} 或以上，当前设备暂不支持`);
  return { candidate: { release: latest, sources: matching.map(r => r.source) }, checkedSources, errors };
}
