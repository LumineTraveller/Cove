const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { inside, assertWritable, dependencyPlan, buildEnvironment, proxyArguments,
  sourceMetadata, assertSourceUnchanged, jdkDirectory } = require('./android-acceptance.cjs');
const toolsRoot = path.resolve(__dirname, '../runtime/acceptance-20261023/android-tools');

test('build writes reject escaped paths and junctions into borrowed dependencies', () => {
  assert.equal(inside(toolsRoot, path.join(toolsRoot, 'tmp')), true);
  assert.equal(inside(toolsRoot, `${toolsRoot}-other`), false);
  assert.throws(() => assertWritable(path.resolve(__dirname, '../apps/mobile/node_modules/react-native/build')), /escaped/);
  fs.mkdirSync(path.join(toolsRoot, 'safety-test'), { recursive: true });
  const link = path.join(toolsRoot, 'safety-test/borrowed');
  if (!fs.existsSync(link)) fs.symlinkSync(path.resolve(__dirname), link, 'junction');
  assert.throws(() => assertWritable(path.join(link, 'build')), /borrowed/);
  const dangling = path.join(toolsRoot, 'safety-test/dangling');
  if (!fs.lstatSync(dangling, { throwIfNoEntry: false }))
    fs.symlinkSync(path.join(toolsRoot, 'safety-test/missing-target'), dangling, 'junction');
  assert.throws(() => assertWritable(path.join(dangling, 'build')), /borrowed/);
});

test('all discovered native Gradle packages receive writable copies; ordinary JS stays read-only', () => {
  const plan = dependencyPlan(path.resolve(__dirname, '../apps/mobile/node_modules'));
  for (const name of ['react-native', '@react-native/gradle-plugin', 'react-native-webrtc',
    'react-native-video', 'react-native-safe-area-context', 'react-native-svg',
    'react-native-incall-manager', '@react-native-async-storage/async-storage'])
    assert.equal(plan.find(item => item.packageName === name)?.writable, true, name);
  assert.equal(plan.find(item => item.packageName === 'react')?.writable, false);
  assert.equal(plan.find(item => item.packageName === 'socket.io-client')?.writable, false);
});

test('build caches and temporary outputs stay local and cannot select external signing', () => {
  const sdk = path.join(toolsRoot, 'safety-test/sdk');
  fs.mkdirSync(path.join(sdk, 'platforms/android-36'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'platforms/android-36/android.jar'), 'synthetic sdk marker');
  const environment = buildEnvironment(sdk);
  for (const name of ['GRADLE_USER_HOME', 'ANDROID_USER_HOME', 'TMP', 'TEMP', 'npm_config_cache'])
    assert.equal(inside(toolsRoot, environment[name]), true, name);
  assert.equal(environment.COVE_ANDROID_SIGNING_MODE, 'legacy');
  assert.equal(environment.npm_config_offline, 'true');
  assert.equal(environment.ANDROID_HOME, sdk);
});

test('side-by-side Android identity and offline JS are restricted to the acceptance property', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../apps/mobile/android/app/build.gradle'), 'utf8');
  assert.match(source, /hasProperty\('coveRefactor'\)[\s\S]*?debuggableVariants = \[\]/);
  assert.match(source, /hasProperty\('coveRefactor'\)[\s\S]*?applicationIdSuffix "\.refactor"\s+resValue "string", "app_name", "Cove 验收测试"/);
  assert.match(source, /storeFile file\('debug.keystore'\)/);
  assert.match(source, /buildConfigField "boolean", "COVE_ACCEPTANCE_BUILD", "false"/);
  assert.match(source, /hasProperty\('coveRefactor'\)[\s\S]*?buildConfigField "boolean", "COVE_ACCEPTANCE_BUILD", "true"/);
  const application = fs.readFileSync(path.resolve(__dirname,
    '../apps/mobile/android/app/src/main/java/com/covemobile/MainApplication.kt'), 'utf8');
  assert.match(application, /useDevSupport = BuildConfig.DEBUG && !BuildConfig.COVE_ACCEPTANCE_BUILD/);
  const settings = fs.readFileSync(path.resolve(__dirname, '../apps/mobile/android/settings.gradle'), 'utf8');
  assert.match(settings, /containsKey\('coveRefactor'\)[\s\S]*?autolinkLibrariesFromCommand\([\s\S]*?'node'/);
});

test('Java uses the existing proxy only within its process and never exposes proxy credentials', () => {
  assert.deepEqual(proxyArguments({ HTTPS_PROXY: 'http://127.0.0.1:7897' }),
    ['-Dhttps.proxyHost=127.0.0.1', '-Dhttps.proxyPort=7897']);
  assert.deepEqual(proxyArguments({}), []);
  assert.throws(() => proxyArguments({ HTTPS_PROXY: 'http://synthetic-user:synthetic-password@localhost:7897' }), /credentials/);
});

test('source preparation rejects a different commit or uncommitted product changes', () => {
  const input = { head: 'a'.repeat(40), expected: 'a'.repeat(40), status: '', productStatus: '',
    productTrees: ['mobile-tree', 'contracts-tree', 'core-tree'], acceptanceId: 'acceptance-20261023' };
  assert.equal(sourceMetadata(input).sourceDirty, false);
  assert.equal(sourceMetadata({ ...input, status: ' M docs/acceptance.md' }).sourceDirty, true);
  assert.throws(() => sourceMetadata({ ...input, expected: 'b'.repeat(40) }), /frozen/);
  assert.throws(() => sourceMetadata({ ...input, productStatus: ' M apps/mobile/src/App.tsx' }), /product changes/);
  assert.throws(() => sourceMetadata({ ...input, acceptanceId: '../other' }), /acceptance ID/);
});

test('collection preserves the prepared commit while rejecting product changes during the build', () => {
  const prepared = { sourceCommit: 'a'.repeat(40), productTrees: ['mobile', 'contracts', 'core'] };
  assert.doesNotThrow(() => assertSourceUnchanged(prepared, { status: '', trees: prepared.productTrees }));
  assert.equal(prepared.sourceCommit, 'a'.repeat(40));
  assert.throws(() => assertSourceUnchanged(prepared, { status: ' M apps/mobile/App.tsx', trees: prepared.productTrees }), /changed/);
  assert.throws(() => assertSourceUnchanged(prepared, { status: '', trees: ['new-mobile', 'contracts', 'core'] }), /changed/);
});

test('missing JAVA_HOME reports a clear prerequisite before APK inspection', () => {
  assert.throws(() => jdkDirectory({}), /JAVA_HOME.*JDK 17/);
  assert.throws(() => jdkDirectory({ JAVA_HOME: path.join(toolsRoot, 'safety-test/missing-jdk') }), /JAVA_HOME.*JDK 17/);
});
