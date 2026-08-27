import { checkAndroidUpdate, parseUpdateFeed, releaseURL, type AndroidRelease } from '../src/mobileUpdate';

export const release: AndroidRelease = {
  versionName: '0.4.0', versionCode: 6, minAndroidApi: 24, packageName: 'com.cove.mobile',
  tag: 'mobile-v0.4.0', filename: 'Cove-Mobile-0.4.0.apk', size: 1024,
  sha256: 'a'.repeat(64), notes: '手机端更新测试',
};
const installed = { versionName: '0.3.1', versionCode: 5, androidApi: 36 };
const feed = (r: unknown = release) => JSON.stringify({ schemaVersion: 1, platform: 'android', release: r });

test('empty bootstrap feed and desktop releases never count as a mobile update', () => {
  expect(parseUpdateFeed(feed(null))).toBeNull();
  expect(() => parseUpdateFeed(JSON.stringify({ tag_name: 'v0.8.0', assets: [] }))).toThrow();
  expect(() => parseUpdateFeed(feed({ ...release, packageName: 'cove-client' }))).toThrow();
  expect(() => parseUpdateFeed(feed({ ...release, tag: '../v0.8.0' }))).toThrow();
});

test('uses actual Android versionCode rather than desktop or display versions', async () => {
  expect((await checkAndroidUpdate(installed, async () => feed())).candidate?.release.versionCode).toBe(6);
  expect((await checkAndroidUpdate({ ...installed, versionCode: 6 }, async () => feed())).candidate).toBeNull();
  expect((await checkAndroidUpdate({ ...installed, versionCode: 7 }, async () => feed())).candidate).toBeNull();
});

test('falls back to a working mirror and reports partial failure', async () => {
  const result = await checkAndroidUpdate(installed, async s => {
    if (s === 'github') throw new Error('offline');
    return feed();
  });
  expect(result.candidate?.sources).toEqual(['gitee']);
  expect(result.errors).toHaveLength(1);
});

test('rejects all-source failure instead of claiming user has the latest version', async () => {
  await expect(checkAndroidUpdate(installed, async () => '<html>login</html>')).rejects.toThrow('均无法');
});

test('selects newest artifact, not an older mirror which responded faster', async () => {
  const result = await checkAndroidUpdate(installed, async s => feed(s === 'gitee' ? { ...release, versionCode: 5 } : release));
  expect(result.candidate?.sources).toEqual(['github']);
});

test('prefers faster source only when mirrors carry the same artifact', async () => {
  jest.useFakeTimers();
  try {
    const result = checkAndroidUpdate(installed, s => new Promise(resolve => setTimeout(() => resolve(feed()), s === 'github' ? 100 : 10)));
    await jest.advanceTimersByTimeAsync(100);
    expect((await result).candidate?.sources).toEqual(['gitee', 'github']);
  } finally { jest.useRealTimers(); }
});

test('hung source times out while another mirror still works', async () => {
  jest.useFakeTimers();
  try {
    const result = checkAndroidUpdate(installed, s => s === 'github' ? new Promise(() => {}) : Promise.resolve(feed()));
    await jest.advanceTimersByTimeAsync(18001);
    expect((await result).candidate?.sources).toEqual(['gitee']);
  } finally { jest.useRealTimers(); }
});

test('conflicting same-version artifacts and unsupported Android versions are refused', async () => {
  await expect(checkAndroidUpdate(installed, async s => feed({ ...release, sha256: (s === 'github' ? 'a' : 'b').repeat(64) }))).rejects.toThrow('不一致');
  await expect(checkAndroidUpdate(installed, async s => feed({ ...release, tag: s === 'github' ? 'v0.8.0' : 'v0.8.1' }))).rejects.toThrow('不一致');
  await expect(checkAndroidUpdate({ ...installed, androidApi: 23 }, async () => feed())).rejects.toThrow('暂不支持');
});

test('APK URL is rebuilt from fixed official origins, never from feed-supplied URLs', () => {
  const parsed = parseUpdateFeed(feed({ ...release, downloadURL: 'http://evil.test/malware.apk' }))!;
  expect(releaseURL(parsed, 'gitee', true)).toBe('https://gitee.com/LumineTraveller/Cove/releases/download/mobile-v0.4.0/Cove-Mobile-0.4.0.apk');
  expect(releaseURL(parsed, 'github')).toBe('https://github.com/LumineTraveller/Cove/releases/tag/mobile-v0.4.0');
  expect(() => parseUpdateFeed(feed({ ...release, filename: '../malware.apk' }))).toThrow();
});

test('mobile APK may be attached to a desktop release without comparing desktop version numbers', async () => {
  const result = await checkAndroidUpdate(installed, async () => feed({ ...release, tag: 'v0.8.0' }));
  expect(result.candidate?.release.versionName).toBe('0.4.0');
  expect(releaseURL(result.candidate!.release, 'gitee', true)).toBe('https://gitee.com/LumineTraveller/Cove/releases/download/v0.8.0/Cove-Mobile-0.4.0.apk');
});
