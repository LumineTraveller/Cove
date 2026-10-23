const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { inside, assertWritable, dependencyPlan, buildEnvironment, proxyArguments,
  sourceMetadata, assertSourceUnchanged, jdkDirectory, metroConfiguration, createOwnedRoot, validateOwnedRoot,
  assertSnapshotFiles, assertSharedDist, resetOwnedNativeCache, copyGradleCache } = require('./android-acceptance.cjs');
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

test('Metro can see real Babel helpers behind borrowed per-package junctions', () => {
  const plan = dependencyPlan(path.resolve(__dirname, '../apps/mobile/node_modules'));
  const babel = plan.find(item => item.packageName === '@babel/runtime');
  assert.ok(babel && !babel.writable);
  const realBabel = fs.realpathSync(babel.source);
  assert.ok(fs.existsSync(path.join(realBabel, 'helpers/interopRequireDefault.js')));
  const configuration = metroConfiguration(plan);
  assert.ok(configuration.watchFolders.includes(path.dirname(path.dirname(realBabel))));
});

test('Metro discovers and deduplicates every physical dependency root behind scoped and unscoped junctions', () => {
  const fixture = path.join(toolsRoot, 'safety-test/metro-junctions');
  const borrowed = path.join(fixture, 'borrowed/node_modules');
  const roots = ['one', 'two', 'native'].map(name => path.join(fixture, name, 'node_modules'));
  for (const [name, root] of [['@babel/runtime', roots[0]], ['@babel/helpers', roots[0]],
    ['react', roots[1]], ['native-module', roots[2]]]) {
    const source = path.join(root, name);
    fs.mkdirSync(source, { recursive: true });
    if (name === 'native-module') fs.mkdirSync(path.join(source, 'android'), { recursive: true });
    const link = path.join(borrowed, name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (!fs.existsSync(link)) fs.symlinkSync(source, link, 'junction');
  }
  const configuration = metroConfiguration(dependencyPlan(borrowed));
  assert.deepEqual(configuration.watchFolders.sort(), roots.slice(0, 2).sort());
});

test('acceptance Metro preserves product resolution and pins all caches plus Gradle configuration to isolation', () => {
  const configuration = metroConfiguration([], path.join(toolsRoot, 'build-source/apps/mobile'));
  const original = { projectRoot: 'product-root', watchFolders: ['shared-packages'],
    resolver: { disableHierarchicalLookup: true }, transformer: { productOption: true } };
  const context = { module: { exports: {} }, require(name) {
    if (name === './metro.config.js') return original;
    if (name === 'metro-cache') return { FileStore: class { constructor(options) { this.root = options.root; } } };
    throw new Error(`Unexpected generated configuration import: ${name}`);
  } };
  vm.runInNewContext(configuration.configSource, context);
  const configured = context.module.exports;
  assert.equal(configured.projectRoot, original.projectRoot);
  assert.equal(configured.resolver, original.resolver);
  assert.equal(configured.transformer, original.transformer);
  assert.deepEqual([...configured.watchFolders], original.watchFolders);
  for (const target of [configuration.configPath, configuration.initPath,
    configured.fileMapCacheDirectory, configured.cacheStores[0].root]) assert.equal(inside(toolsRoot, target), true);
  assert.match(configuration.initSource, /hasProperty\('coveRefactor'\)/);
  assert.match(configuration.initSource, /withPlugin\('com\.facebook\.react'\)/);
  assert.match(configuration.initSource, /bundleConfig\.set\(new File\(/);
  const source = fs.readFileSync(path.resolve(__dirname, './android-acceptance.cjs'), 'utf8');
  assert.match(source, /const prepared = resume \? \{ \.\.\.verifyPreparedSnapshot\(sourceRoot\)/);
  assert.match(source, /'--init-script', prepared\.metroInitScript/);
});

test('build caches and temporary outputs stay local and cannot select external signing', () => {
  const sdk = path.join(toolsRoot, 'safety-test/sdk');
  fs.mkdirSync(path.join(sdk, 'platforms/android-36'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'platforms/android-36/android.jar'), 'synthetic sdk marker');
  const environment = buildEnvironment(sdk, null);
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

test('short Android roots require physical unique Temp ownership and reject a mismatched marker or junction', () => {
  const temporary = path.join(toolsRoot, 'safety-test/owned-temp');
  fs.mkdirSync(temporary, { recursive: true });
  const owned = createOwnedRoot(temporary);
  assert.deepEqual(validateOwnedRoot(owned, temporary), owned);
  assert.throws(() => validateOwnedRoot({ ...owned, token: 'different-owner' }, temporary), /ownership/);
  assert.throws(() => validateOwnedRoot({ ...owned, root: toolsRoot }, temporary), /unique directory/);
  const alias = path.join(temporary, 'cva-alias1');
  if (!fs.existsSync(alias)) fs.symlinkSync(owned.root, alias, 'junction');
  assert.throws(() => validateOwnedRoot({ ...owned, root: alias }, temporary), /physical/);
  const borrowed = path.join(owned.root, 'borrowed');
  fs.symlinkSync(path.resolve(__dirname), borrowed, 'junction');
  assert.throws(() => assertWritable(path.join(borrowed, '.cxx'), owned.root), /borrowed/);
});

test('short Gradle cache stays in the owned root while other caches stay in project isolation', () => {
  const sdk = path.join(toolsRoot, 'safety-test/sdk');
  const owned = createOwnedRoot();
  const environment = buildEnvironment(sdk, owned);
  assert.equal(environment.GRADLE_USER_HOME, path.join(owned.root, 'g'));
  for (const name of ['TMP', 'TEMP', 'ANDROID_USER_HOME', 'npm_config_cache'])
    assert.equal(inside(toolsRoot, environment[name]), true);
  const other = createOwnedRoot();
  fs.symlinkSync(path.resolve(__dirname), path.join(other.root, 'g'), 'junction');
  assert.throws(() => buildEnvironment(sdk, other), /borrowed/);
});

test('relocated snapshots compare every selected product file and reject mutation or path escape', () => {
  const snapshot = path.join(toolsRoot, 'safety-test/snapshot');
  const relative = 'apps/mobile/package.json';
  const target = path.join(snapshot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '..', relative), target);
  assert.doesNotThrow(() => assertSnapshotFiles(snapshot, [relative]));
  fs.appendFileSync(target, '\nmodified snapshot\n');
  assert.throws(() => assertSnapshotFiles(snapshot, [relative]), /differs from frozen/);
  assert.throws(() => assertSnapshotFiles(snapshot, ['../escaped']), /escaped/);
  const source = fs.readFileSync(path.resolve(__dirname, './android-acceptance.cjs'), 'utf8');
  assert.match(source, /prepared\.sourceCommit[\s\S]*?prepared\.productTrees[\s\S]*?assertSnapshotFiles/);
  assert.match(source, /sourceCommit: prepared\.sourceCommit, buildToolingCommit: git\('rev-parse', 'HEAD'\)/);
});

test('shared untracked dist bytes and file sets are verified and hashed before reuse', () => {
  const fixture = fs.mkdtempSync(path.join(toolsRoot, 'safety-test/dist-'));
  const original = path.join(fixture, 'original');
  const snapshot = path.join(fixture, 'snapshot');
  for (const name of ['contracts', 'client-core']) {
    const directory = path.join(original, name, 'dist');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'index.js'), `module.exports = '${name}';\n`);
    fs.mkdirSync(path.join(snapshot, 'packages'), { recursive: true });
    fs.cpSync(path.join(original, name), path.join(snapshot, 'packages', name), { recursive: true });
  }
  const evidence = assertSharedDist(snapshot, original);
  assert.equal(evidence['client-core'].files.length, 1);
  assert.match(evidence.contracts.sha256, /^[a-f\d]{64}$/);
  const staged = path.join(snapshot, 'packages/client-core/dist/index.js');
  fs.appendFileSync(staged, 'stale output');
  assert.throws(() => assertSharedDist(snapshot, original), /shared dist differs/);
  fs.copyFileSync(path.join(original, 'client-core/dist/index.js'), staged);
  fs.writeFileSync(path.join(snapshot, 'packages/client-core/dist/extra.js'), 'extra');
  assert.throws(() => assertSharedDist(snapshot, original), /shared dist differs/);
});

test('native cache cleanup validates all targets before deleting and never follows a later borrowed junction', () => {
  const owned = createOwnedRoot();
  const source = path.join(owned.root, 's');
  const mobile = path.join(source, 'apps/mobile');
  const appCache = path.join(mobile, 'android/app/.cxx');
  fs.mkdirSync(appCache, { recursive: true });
  fs.writeFileSync(path.join(appCache, 'keep.txt'), 'first owned cache');
  const borrowed = fs.mkdtempSync(path.join(toolsRoot, 'safety-test/native-borrowed-'));
  fs.mkdirSync(path.join(borrowed, 'android/.cxx'), { recursive: true });
  fs.writeFileSync(path.join(borrowed, 'android/.cxx/keep.txt'), 'borrowed cache');
  fs.mkdirSync(path.join(mobile, 'node_modules'), { recursive: true });
  fs.symlinkSync(borrowed, path.join(mobile, 'node_modules/unsafe'), 'junction');
  assert.throws(() => resetOwnedNativeCache([{ packageName: 'unsafe', writable: true }], owned, source), /borrowed/);
  assert.equal(fs.readFileSync(path.join(appCache, 'keep.txt'), 'utf8'), 'first owned cache');
  const safeCache = path.join(mobile, 'node_modules/safe/android/.cxx');
  fs.mkdirSync(safeCache, { recursive: true });
  fs.writeFileSync(path.join(safeCache, 'remove.txt'), 'owned native cache');
  resetOwnedNativeCache([{ packageName: 'safe', writable: true }], owned, source);
  assert.equal(fs.existsSync(appCache), false);
  assert.equal(fs.existsSync(safeCache), false);
  assert.equal(fs.readFileSync(path.join(borrowed, 'android/.cxx/keep.txt'), 'utf8'), 'borrowed cache');
});

test('Gradle cache copies reject physical source aliases and included nested links before dereferencing', () => {
  const fixture = fs.mkdtempSync(path.join(toolsRoot, 'safety-test/cache-'));
  const source = path.join(fixture, 'source');
  const outside = path.join(fixture, 'outside');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'outside.txt'), 'must not be copied');
  fs.symlinkSync(source, path.join(fixture, 'alias'), 'junction');
  assert.throws(() => copyGradleCache(path.join(fixture, 'alias'), createOwnedRoot()), /borrowed/);
  fs.symlinkSync(outside, path.join(source, 'included-link'), 'junction');
  const rejected = createOwnedRoot();
  assert.throws(() => copyGradleCache(source, rejected), /link inside Gradle cache/);
  assert.equal(fs.existsSync(path.join(rejected.root, 'g/included-link/outside.txt')), false);
  const safe = path.join(fixture, 'safe-source');
  fs.mkdirSync(safe, { recursive: true });
  fs.writeFileSync(path.join(safe, 'cache.bin'), 'cached bytes');
  fs.symlinkSync(outside, path.join(safe, '.tmp'), 'junction');
  const copied = copyGradleCache(safe, createOwnedRoot());
  assert.equal(fs.readFileSync(path.join(copied, 'cache.bin'), 'utf8'), 'cached bytes');
  assert.equal(fs.existsSync(path.join(copied, '.tmp')), false);
});
