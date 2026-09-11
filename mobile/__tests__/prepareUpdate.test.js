const { createFeed } = require('../scripts/prepare-update.cjs');

const metadata = {
  applicationId: 'com.cove.mobile', variantName: 'release', minSdkVersionForDexing: 24,
  elements: [{ type: 'SINGLE', filters: [], versionCode: 6, versionName: '0.4.0', outputFile: 'app-release.apk' }],
};
const apk = Buffer.from('test apk data');
test('release generator records exact APK size/hash and mobile-specific names', () => {
  const result = createFeed(metadata, '0.4.0', '更新说明', apk, { release: null }, 'v0.8.0');
  expect(result.release.filename).toBe('Cove-Mobile-0.4.0.apk');
  expect(result.release.tag).toBe('v0.8.0');
  expect(result.release.size).toBe(apk.length);
  expect(result.release.sha256).toHaveLength(64);
});
test('rejects stale APK metadata, duplicate version codes, and missing release notes', () => {
  expect(() => createFeed(metadata, '0.5.0', '说明', apk, null)).toThrow('不一致');
  expect(() => createFeed(metadata, '0.4.0', '说明', apk, { release: { versionCode: 6 } })).toThrow('必须高于');
  expect(() => createFeed(metadata, '0.4.0', '', apk, null)).toThrow('更新说明');
  expect(() => createFeed({ ...metadata, variantName: 'debug' }, '0.4.0', '说明', apk, null)).toThrow('Release APK');
  expect(() => createFeed(metadata, '0.4.0', '说明', apk, null, '../bad')).toThrow('已有 Release');
});
test('rejects release notes written with the wrong encoding', () => {
  // 历史事故：清单被手工重新生成后，notes 里的中文变成了乱码。
  expect(() => createFeed(metadata, '0.4.0', '\uFFFD鍙戝竷鏃ユ湡', apk, null)).toThrow('替换字符');
  expect(() => createFeed(metadata, '0.4.0', '正常说明', apk, null, 'mobile-v0.4.0')).not.toThrow();
});
