const { parseGradleVersion, verifyPreflight, verifyFeed, sha256 } = require('../scripts/verify-release.cjs');

const GRADLE = '        versionCode 10\n        versionName "0.6.0"\n';
const PUBLISHED = {
  schemaVersion: 1,
  platform: 'android',
  release: {
    packageName: 'com.cove.mobile', versionName: '0.5.2', versionCode: 9,
    minAndroidApi: 24, tag: 'mobile-v0.5.2', filename: 'Cove-Mobile-0.5.2.apk',
    size: 100, sha256: 'a'.repeat(64), notes: '旧说明',
  },
};
const APK = Buffer.from('final release apk bytes');
const NOTES = '# Cove Mobile v0.6.0\n\n发布日期：2026-09-20。\n';
const METADATA = {
  applicationId: 'com.cove.mobile', variantName: 'release', minSdkVersionForDexing: 24,
  elements: [{ type: 'SINGLE', filters: [], versionCode: 10, versionName: '0.6.0', outputFile: 'app-release.apk' }],
};

function preflight(overrides = {}) {
  return verifyPreflight({
    tag: 'mobile-v0.6.0', packageVersion: '0.6.0', gradleVersionName: '0.6.0',
    gradleVersionCode: 10, feed: PUBLISHED, ...overrides,
  });
}

function stagedRelease(overrides = {}) {
  return {
    schemaVersion: 1,
    platform: 'android',
    release: {
      packageName: 'com.cove.mobile', versionName: '0.6.0', versionCode: 10, minAndroidApi: 24,
      tag: 'mobile-v0.6.0', filename: 'Cove-Mobile-0.6.0.apk',
      size: APK.length, sha256: sha256(APK), notes: NOTES.trim(),
      ...overrides,
    },
  };
}

function feed(overrides = {}) {
  return verifyFeed({
    tag: 'mobile-v0.6.0', version: '0.6.0', gradleVersionCode: 10, metadata: METADATA,
    apk: APK, stagedApk: APK, notesSource: NOTES, stagedFeed: stagedRelease(), ...overrides,
  });
}

function metadataWith(overrides) {
  return { ...METADATA, ...overrides };
}

test('gradle version parsing requires exactly one versionCode', () => {
  expect(parseGradleVersion(GRADLE)).toEqual({ versionName: '0.6.0', versionCode: 10 });
  expect(() => parseGradleVersion('versionName "0.6.0"')).toThrow('versionCode');
  expect(() => parseGradleVersion(`${GRADLE}        versionCode 11\n`)).toThrow('只有一处 versionCode');
});

test('preflight accepts a strictly increasing versionCode and reports the previous one', () => {
  expect(preflight()).toEqual({ version: '0.6.0', versionCode: 10, previousVersionCode: 9 });
});

test('preflight stops a release that reuses or lowers the published Android versionCode', () => {
  // 只改显示版本号、不递增 Android versionCode 时必须停止。
  expect(() => preflight({ gradleVersionCode: 9 })).toThrow('必须严格大于线上清单的 9');
  expect(() => preflight({ gradleVersionCode: 8 })).toThrow('必须严格大于线上清单的 9');
  // 清单已经被提前改成本次版本时，提示正确的发布顺序而不是含糊的版本号错误。
  expect(() => preflight({
    gradleVersionCode: 10,
    feed: { ...PUBLISHED, release: { ...PUBLISHED.release, versionName: '0.6.0', versionCode: 10 } },
  })).toThrow('先在尚未更新清单的提交上打标签');
});

test('the live mobile feed stays parseable and free of encoding damage', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { parseUpdateFeed } = require('../src/mobileUpdate');
  // 用客户端自己的解析器校验仓库里的清单，避免两者脱节。
  // 这里不比较 versionName：按 AGENTS.md 的顺序，打标签时清单仍是上一个已发布版本。
  const raw = fs.readFileSync(path.join(__dirname, '..', 'update.json'), 'utf8');
  const release = parseUpdateFeed(raw);
  if (release) {
    expect(release.notes.length).toBeGreaterThan(0);
    expect(release.notes).not.toContain('\uFFFD');
    expect(release.packageName).toBe('com.cove.mobile');
    expect(release.filename).toBe(`Cove-Mobile-${release.versionName}.apk`);
  }
});

test('preflight requires the tag, package.json and gradle versionName to agree', () => {
  expect(() => preflight({ tag: 'v0.6.0' })).toThrow('mobile-vX.Y.Z');
  expect(() => preflight({ packageVersion: '0.6.1' })).toThrow('package.json');
  expect(() => preflight({ gradleVersionName: '0.5.9' })).toThrow('versionName');
  expect(() => preflight({ feed: { schemaVersion: 1, platform: 'ios' } })).toThrow('Android 更新清单');
  expect(() => preflight({ feed: { schemaVersion: 1, platform: 'android', release: { versionCode: 9 } } }))
    .toThrow('packageName');
});

test('preflight allows the first mobile release while the live feed has no release', () => {
  expect(preflight({ feed: { schemaVersion: 1, platform: 'android', release: null } }))
    .toEqual({ version: '0.6.0', versionCode: 10, previousVersionCode: null });
});

test('feed check binds the manifest to the final APK bytes', () => {
  expect(feed()).toEqual({
    version: '0.6.0', versionCode: 10, minAndroidApi: 24, size: APK.length, sha256: sha256(APK),
  });
  expect(() => feed({ stagedFeed: stagedRelease({ size: APK.length - 1 }) })).toThrow('禁止手填或沿用旧值');
  expect(() => feed({ stagedFeed: stagedRelease({ sha256: 'b'.repeat(64) }) }))
    .toThrow('sha256 与最终 APK 实际值不一致');
  expect(() => feed({ stagedFeed: stagedRelease({ versionCode: 9 }) }))
    .toThrow('versionCode 与 APK 元数据不一致');
  expect(() => feed({ stagedFeed: stagedRelease({ minAndroidApi: 26 }) }))
    .toThrow('minAndroidApi 与 APK 元数据不一致');
  expect(() => feed({ stagedFeed: stagedRelease({ filename: 'Cove-Mobile-0.6.0-release.apk' }) }))
    .toThrow('Cove-Mobile-<版本>.apk');
  expect(() => feed({ stagedApk: Buffer.from('stale staged apk') })).toThrow('暂存目录中的 APK');
});

test('feed check rejects split or stale APK metadata', () => {
  const split = metadataWith({ elements: [{ ...METADATA.elements[0], filters: [{ abi: 'arm64-v8a' }] }] });
  expect(() => feed({ metadata: split })).toThrow('通用 Release APK');
  expect(() => feed({ metadata: metadataWith({ variantName: 'debug' }) })).toThrow('release 变体');
  expect(() => feed({ metadata: metadataWith({ elements: [{ ...METADATA.elements[0], versionCode: 9 }] }) }))
    .toThrow('请重新构建');
  expect(() => feed({ metadata: metadataWith({ applicationId: 'com.other.app' }) })).toThrow('applicationId');
  expect(() => feed({ metadata: metadataWith({ minSdkVersionForDexing: 0 }) })).toThrow('最低 Android API');
});

test('feed check rejects update notes that no longer match RELEASE_NOTES.md', () => {
  // 事故回归：清单被手工重新生成后，中文更新说明变成了乱码。
  const mojibake = '# Cove Mobile v0.6.0\n\n鍙戝竷鏃ユ湡锛?026-09-20銆?';
  expect(() => feed({ stagedFeed: stagedRelease({ notes: mojibake }) }))
    .toThrow('与 mobile/RELEASE_NOTES.md 不一致');
  expect(() => feed({ stagedFeed: stagedRelease({ notes: `${NOTES.trim()}\n额外一行` }) }))
    .toThrow('RELEASE_NOTES.md');
  expect(() => feed({ stagedFeed: stagedRelease({ notes: '' }) })).toThrow('RELEASE_NOTES.md');
  expect(() => feed({ stagedFeed: stagedRelease({ notes: `\uFFFD${NOTES.trim()}` }) }))
    .toThrow('RELEASE_NOTES.md');
});

test('feed check requires the staged manifest tag to match this release', () => {
  expect(() => feed({ stagedFeed: stagedRelease({ tag: 'v0.5.2' }) }))
    .toThrow('与本次标签 mobile-v0.6.0 不一致');
  // 允许把手机 APK 挂在桌面版 Release 标签下（与 prepare-update.cjs 的约定一致）。
  expect(() => feed({ tag: 'v0.6.0', stagedFeed: stagedRelease({ tag: 'v0.6.0' }) })).not.toThrow();
});

test('feed check requires RELEASE_NOTES.md to exist with usable content', () => {
  expect(() => feed({ notesSource: '   ' })).toThrow('RELEASE_NOTES.md 为空');
  expect(() => feed({ notesSource: 'x'.repeat(12_001) })).toThrow('12000');
});
