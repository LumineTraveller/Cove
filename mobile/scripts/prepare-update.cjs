const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function createFeed(metadata, packageVersion, notes, apk, previous, releaseTag) {
  const item = metadata.elements?.[0];
  if (metadata.applicationId !== 'com.cove.mobile' || metadata.variantName !== 'release'
    || metadata.elements?.length !== 1 || item?.type !== 'SINGLE' || item.filters?.length
    || item.outputFile !== 'app-release.apk') throw new Error('需要单一通用 Release APK 的 output-metadata.json');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(item.versionName)
    || item.versionName !== packageVersion || !Number.isSafeInteger(item.versionCode)
    || item.versionCode < 1 || item.versionCode > 2100000000) throw new Error('APK 版本与 mobile/package.json 不一致，或版本不合法；请先重新构建');
  if (previous?.release && item.versionCode <= previous.release.versionCode) throw new Error('versionCode 必须高于已发布手机版本，不能覆盖已有版本');
  const minApi = metadata.minSdkVersionForDexing;
  if (!Number.isSafeInteger(minApi) || minApi < 23 || minApi > 100) throw new Error('APK 元数据缺少有效最低 Android API');
  if (!notes.trim() || notes.length > 12000) throw new Error('需要 1—12000 字符的手机端更新说明');
  if (!Buffer.isBuffer(apk) || apk.length === 0 || apk.length > 1024 * 1024 * 1024) throw new Error('APK 大小无效');
  if (typeof releaseTag !== 'string' || !(releaseTag === `mobile-v${item.versionName}` || /^v\d+\.\d+\.\d+$/.test(releaseTag))) {
    throw new Error('请指定承载 APK 的已有 Release 标签（如 v0.8.0）');
  }
  return {
    schemaVersion: 1, platform: 'android', release: {
      packageName: metadata.applicationId, versionName: item.versionName, versionCode: item.versionCode,
      minAndroidApi: minApi, tag: releaseTag, filename: `Cove-Mobile-${item.versionName}.apk`,
      size: apk.length, sha256: createHash('sha256').update(apk).digest('hex'), notes: notes.trim(),
    },
  };
}

function main() {
  const mobileDir = path.resolve(__dirname, '..');
  const notesPath = process.argv[2];
  const releaseTag = process.argv[3];
  if (!notesPath || !releaseTag) throw new Error('用法：npm run update:prepare -- <手机端更新说明.md> <已有Release标签>（在 mobile 目录）');
  const apkDir = path.join(mobileDir, 'android/app/build/outputs/apk/release');
  const metadata = JSON.parse(fs.readFileSync(path.join(apkDir, 'output-metadata.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(mobileDir, 'package.json'), 'utf8'));
  const previous = JSON.parse(fs.readFileSync(path.join(mobileDir, 'update.json'), 'utf8'));
  const apk = fs.readFileSync(path.join(apkDir, 'app-release.apk'));
  const feed = createFeed(metadata, pkg.version, fs.readFileSync(path.resolve(notesPath), 'utf8'), apk, previous, releaseTag);
  const output = path.join(mobileDir, 'build', 'updates', `mobile-v${feed.release.versionName}`);
  fs.mkdirSync(output, { recursive: true });
  // Never silently replace a staged release or the live feed.
  const apkPath = path.join(output, feed.release.filename);
  const feedPath = path.join(output, 'update.json');
  if (fs.existsSync(apkPath) || fs.existsSync(feedPath)) throw new Error(`暂存目录已有发布文件，请先人工检查：${output}`);
  fs.writeFileSync(apkPath, apk, { flag: 'wx' });
  fs.writeFileSync(feedPath, `${JSON.stringify(feed, null, 2)}\n`, { flag: 'wx' });
  console.log(`准备完成（尚未发布）：${output}\n先将 APK 上传两平台 ${feed.release.tag} Release，确认可下载后再更新 mobile/update.json 并推送两平台。`);
}

module.exports = { createFeed };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
