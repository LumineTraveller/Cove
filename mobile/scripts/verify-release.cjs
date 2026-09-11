/**
 * 手机版发布闸门。把 AGENTS.md 里此前靠人工执行的三条纪律变成可执行校验：
 *
 *   node scripts/verify-release.cjs --preflight <tag>   打标签后、构建前
 *   node scripts/verify-release.cjs --feed <tag>        生成清单后、发布前
 *
 * --preflight 在构建前拦截“只改显示版本号、不递增 versionCode”这类必须停止的发布；
 * --feed 用最终 APK 复核暂存清单，并确认应用内更新说明与 RELEASE_NOTES.md 同源。
 *
 * 仓库约定：手机端应用内更新说明（update.json 的 release.notes）与
 * mobile/RELEASE_NOTES.md 同源同文。若将来要让两者不同，请在这里显式放宽，
 * 不要绕过校验——曾经有一次清单是手工用 PowerShell 重新生成的，notes 被按
 * 错误编码写成了乱码并直接发给所有用户。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MOBILE_DIR = path.resolve(__dirname, '..');
const ANDROID_APK_DIR = path.join(MOBILE_DIR, 'android', 'app', 'build', 'outputs', 'apk', 'release');
const PACKAGE_NAME = 'com.cove.mobile';
const MOBILE_TAG = /^mobile-v(\d+\.\d+\.\d+)$/;
const ANY_RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const MAX_NOTES_LENGTH = 12_000;

function fail(message) {
  throw new Error(message);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function readFile(file, label) {
  if (!fs.existsSync(file)) fail(`找不到${label}：${path.relative(MOBILE_DIR, file)}`);
  return fs.readFileSync(file);
}

function readJson(file, label) {
  try {
    return JSON.parse(readFile(file, label).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} 不是有效 JSON：${error.message}`);
    throw error;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 从 build.gradle 读取 versionName 与 versionCode，并要求 versionCode 只出现一次。 */
function parseGradleVersion(gradleSource) {
  const versionName = /versionName\s+"([^"]+)"/.exec(gradleSource)?.[1];
  const codes = gradleSource.match(/versionCode\s+\d+/g) ?? [];
  if (!versionName) fail('build.gradle 缺少 versionName');
  if (codes.length !== 1) fail(`build.gradle 应只有一处 versionCode，实际 ${codes.length} 处`);
  return { versionName, versionCode: Number(codes[0].replace(/\D+/g, '')) };
}

/** 构建前：标签、package.json、build.gradle 与线上清单四方核对。 */
function verifyPreflight({ tag, packageVersion, gradleVersionName, gradleVersionCode, feed }) {
  const match = MOBILE_TAG.exec(tag);
  if (!match) fail(`手机版标签必须形如 mobile-vX.Y.Z，收到 ${tag}`);
  const version = match[1];

  if (packageVersion !== version) fail(`mobile/package.json 版本 ${packageVersion} 与标签 ${tag} 不一致`);
  if (gradleVersionName !== version) fail(`build.gradle versionName ${gradleVersionName} 与标签 ${tag} 不一致`);
  if (!isPositiveSafeInteger(gradleVersionCode)) fail('build.gradle versionCode 必须是正整数');

  if (feed?.schemaVersion !== 1 || feed?.platform !== 'android')
    fail('mobile/update.json 不是有效的 Android 更新清单');

  const published = feed.release;
  if (published === null || published === undefined)
    return { version, versionCode: gradleVersionCode, previousVersionCode: null };

  if (published.packageName !== PACKAGE_NAME)
    fail(`线上清单 packageName ${published.packageName} 不是 ${PACKAGE_NAME}`);
  if (!isPositiveSafeInteger(published.versionCode))
    fail('线上清单缺少有效的 release.versionCode');

  // 只改显示版本号、不递增 Android versionCode 时必须停止：否则用户永远收不到更新。
  if (published.versionName === version && published.versionCode === gradleVersionCode) {
    fail(`tag 提交中的 mobile/update.json 已经是 ${version}（versionCode ${gradleVersionCode}）；` +
      '请按 AGENTS.md 的顺序发布：先在尚未更新清单的提交上打标签、上传 APK 并确认可下载，再推送新清单');
  }
  if (gradleVersionCode <= published.versionCode) {
    fail(`Android versionCode 必须严格大于线上清单的 ${published.versionCode}，` +
      `当前 build.gradle 为 ${gradleVersionCode}（只改 versionName 不算发布）`);
  }

  return { version, versionCode: gradleVersionCode, previousVersionCode: published.versionCode };
}

/** 发布前：用最终 APK 复核 output-metadata.json 与暂存清单。 */
function verifyFeed({ tag, version, gradleVersionCode, metadata, apk, stagedFeed, stagedApk, notesSource }) {
  if (!Buffer.isBuffer(apk) || apk.length === 0) fail('最终 APK 为空');
  if (tag !== `mobile-v${version}` && !ANY_RELEASE_TAG.test(tag))
    fail(`请指定承载 APK 的 Release 标签（如 mobile-v${version}），收到 ${tag}`);

  // AGENTS.md 第 5 条：构建后用 output-metadata.json 复核 APK 元数据。
  if (metadata?.applicationId !== PACKAGE_NAME)
    fail(`APK applicationId ${metadata?.applicationId} 不是 ${PACKAGE_NAME}`);
  if (metadata?.variantName !== 'release') fail('output-metadata.json 不是 release 变体');
  if (metadata?.elements?.length !== 1) fail('发布包必须是单一 APK，不接受分包或 ABI 变体');
  const element = metadata.elements[0];
  if (element?.type !== 'SINGLE' || element.filters?.length)
    fail('发布包必须是未按 ABI 拆分的通用 Release APK；' +
      '请用 -PreactNativeArchitectures=armeabi-v7a,arm64-v8a 重新构建');
  if (element.outputFile !== 'app-release.apk') fail(`意外的 APK 产物名 ${element.outputFile}`);
  if (element.versionName !== version)
    fail(`APK versionName ${element.versionName} 与源码版本 ${version} 不一致，请重新构建`);
  if (element.versionCode !== gradleVersionCode)
    fail(`APK versionCode ${element.versionCode} 与 build.gradle 的 ${gradleVersionCode} 不一致，请重新构建`);
  const minAndroidApi = metadata.minSdkVersionForDexing;
  if (!Number.isSafeInteger(minAndroidApi) || minAndroidApi < 23 || minAndroidApi > 100)
    fail('output-metadata.json 缺少有效的最低 Android API');

  // AGENTS.md 第 6 条：清单中的版本和校验值必须来自这一个最终 APK。
  const release = stagedFeed?.release;
  if (!release) fail('暂存清单缺少 release 字段');
  const digest = sha256(apk);
  if (release.versionName !== version) fail(`清单 versionName ${release.versionName} 与 APK ${version} 不一致`);
  if (release.versionCode !== element.versionCode) fail('清单 versionCode 与 APK 元数据不一致');
  if (release.packageName !== PACKAGE_NAME) fail('清单 packageName 与 APK 不一致');
  if (release.minAndroidApi !== minAndroidApi) fail('清单 minAndroidApi 与 APK 元数据不一致');
  if (release.tag !== tag) fail(`清单 tag ${release.tag} 与本次标签 ${tag} 不一致`);
  if (release.filename !== `Cove-Mobile-${version}.apk`)
    fail(`清单 filename ${release.filename} 不符合 Cove-Mobile-<版本>.apk`);
  if (release.size !== apk.length)
    fail(`清单 size ${release.size} 与最终 APK 实际大小 ${apk.length} 不一致，禁止手填或沿用旧值`);
  if (release.sha256 !== digest)
    fail(`清单 sha256 与最终 APK 实际值不一致：清单 ${release.sha256}，APK ${digest}`);
  if (!Buffer.isBuffer(stagedApk) || Buffer.compare(stagedApk, apk) !== 0)
    fail('暂存目录中的 APK 与刚构建的 APK 内容不一致，请重新执行 update:prepare');

  // 应用内更新说明与 RELEASE_NOTES.md 同源：这条精确校验能挡住编码损坏。
  const expectedNotes = notesSource.trim();
  if (!expectedNotes || expectedNotes.length > MAX_NOTES_LENGTH)
    fail('RELEASE_NOTES.md 为空或超过 12000 字符');
  if (release.notes !== expectedNotes)
    fail('清单 notes 与 mobile/RELEASE_NOTES.md 不一致' +
      '（历史事故：清单被手工重新生成后中文变成乱码）');
  if (release.notes.includes('\uFFFD'))
    fail('清单 notes 含替换字符，说明写入时使用了错误的编码');

  return { version, versionCode: element.versionCode, minAndroidApi, size: apk.length, sha256: digest };
}

function readSources() {
  return {
    packageVersion: readJson(path.join(MOBILE_DIR, 'package.json'), 'mobile/package.json').version,
    gradle: parseGradleVersion(readFile(
      path.join(MOBILE_DIR, 'android', 'app', 'build.gradle'), 'build.gradle').toString('utf8')),
    feed: readJson(path.join(MOBILE_DIR, 'update.json'), 'mobile/update.json'),
  };
}

function runPreflight(tag) {
  const { packageVersion, gradle, feed } = readSources();
  const result = verifyPreflight({
    tag, packageVersion, gradleVersionName: gradle.versionName,
    gradleVersionCode: gradle.versionCode, feed,
  });
  // 线上清单是用户当前真正读到的内容；乱码只告警不阻断，允许在一次发版里修复。
  if (typeof feed.release?.notes === 'string' && feed.release.notes.includes('\uFFFD'))
    console.warn('[verify-release] 警告：现有 mobile/update.json 的 notes 含替换字符，请一并修复');
  console.log(`[verify-release] 预检通过：${tag}，versionCode ` +
    `${result.previousVersionCode ?? '（尚未发布手机版）'} → ${result.versionCode}`);
  return result;
}

function runFeedCheck(tag) {
  const { packageVersion, gradle, feed } = readSources();
  const { version } = verifyPreflight({
    tag, packageVersion, gradleVersionName: gradle.versionName,
    gradleVersionCode: gradle.versionCode, feed,
  });
  const stagedDir = path.join(MOBILE_DIR, 'build', 'updates', `mobile-v${version}`);
  const result = verifyFeed({
    tag,
    version,
    gradleVersionCode: gradle.versionCode,
    metadata: readJson(path.join(ANDROID_APK_DIR, 'output-metadata.json'), 'output-metadata.json'),
    apk: readFile(path.join(ANDROID_APK_DIR, 'app-release.apk'), '最终 APK'),
    stagedFeed: readJson(path.join(stagedDir, 'update.json'), '暂存 update.json'),
    stagedApk: readFile(path.join(stagedDir, `Cove-Mobile-${version}.apk`), '暂存 APK'),
    notesSource: readFile(path.join(MOBILE_DIR, 'RELEASE_NOTES.md'), 'RELEASE_NOTES.md').toString('utf8'),
  });
  console.log(`[verify-release] 清单校验通过：${tag} versionCode ${result.versionCode}、` +
    `minAndroidApi ${result.minAndroidApi}、${result.size} 字节、sha256 ${result.sha256.slice(0, 12)}…`);
  return result;
}

function main() {
  const [mode, tag] = process.argv.slice(2);
  if (mode === '--preflight' && tag) return void runPreflight(tag);
  if (mode === '--feed' && tag) return void runFeedCheck(tag);
  console.error('用法：node scripts/verify-release.cjs --preflight <tag> | --feed <tag>');
  process.exitCode = 2;
}

module.exports = {
  parseGradleVersion, verifyPreflight, verifyFeed, sha256,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[verify-release] ${error.message}`);
    process.exitCode = 1;
  }
}
