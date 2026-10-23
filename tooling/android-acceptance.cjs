// Local-only Android acceptance build. Does not install, publish, or create keys.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');

const repository = path.resolve(__dirname, '..');
const toolsRoot = path.join(repository, 'runtime/acceptance-20261023/android-tools');
const layoutFile = path.join(toolsRoot, 'short-layout.json');
const legacySourceRoot = path.join(toolsRoot, 'build-source');
const ownedLayout = fs.existsSync(layoutFile) ? validateOwnedRoot(JSON.parse(fs.readFileSync(layoutFile, 'utf8'))) : null;
const sourceRoot = ownedLayout ? path.join(ownedLayout.root, 's') : legacySourceRoot;
const mobileRoot = path.join(sourceRoot, 'apps/mobile');
const artifactsRoot = path.join(repository, 'runtime/acceptance-20261023/artifacts');
const writableNativePackages = new Set(['react-native', '@react-native/gradle-plugin']);
const productPaths = ['apps/mobile', 'packages/contracts', 'packages/client-core'];

function git(...args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Cannot verify Android source provenance');
  return result.stdout.trim();
}

function sourceMetadata({ head, expected, status, productStatus, productTrees, acceptanceId }) {
  if (!/^[a-f\d]{40}$/i.test(head) || (expected && expected !== head))
    throw new Error('COVE_ACCEPTANCE_SOURCE_COMMIT must match the frozen full HEAD');
  if (productStatus) throw new Error('Commit or preserve product changes before preparing an acceptance build');
  if (!/^[a-z\d][a-z\d._-]{1,79}$/i.test(acceptanceId)) throw new Error('Invalid acceptance ID');
  return { sourceCommit: head, acceptanceId, sourceDirty: !!status,
    sourceStatus: status ? status.split(/\r?\n/) : [], productTrees };
}

function productState() {
  return { status: git('status', '--porcelain=v1', '--untracked-files=all', '--', ...productPaths),
    trees: git('rev-parse', ...productPaths.map(name => `HEAD:${name}`)).split(/\r?\n/) };
}

function assertSourceUnchanged(prepared, current) {
  if (current.status || JSON.stringify(prepared.productTrees) !== JSON.stringify(current.trees))
    throw new Error('Product sources changed after Android preparation; rebuild from a frozen snapshot');
}

function jdkDirectory(environment) {
  const directory = environment.JAVA_HOME;
  if (!directory || !['java.exe', 'jar.exe'].every(name => fs.existsSync(path.join(directory, 'bin', name))))
    throw new Error('Set JAVA_HOME to the existing JDK 17 directory containing java.exe and jar.exe');
  return directory;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function assertWritable(target, root) {
  root ||= [toolsRoot, ownedLayout?.root].filter(Boolean).find(candidate => inside(candidate, path.resolve(target)));
  if (!root) throw new Error(`Build write escaped isolation directory: ${target}`);
  if (!inside(root, path.resolve(target))) throw new Error(`Build write escaped isolation directory: ${target}`);
  for (let part = path.resolve(target); part === root || inside(root, part); part = path.dirname(part)) {
    if (fs.lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`Build write would follow a borrowed directory: ${part}`);
  }
}

function copy(source, target, root) {
  assertWritable(target, root);
  fs.cpSync(source, target, { recursive: true, dereference: true, filter: item =>
    !['node_modules', '.gradle', '.cxx', 'build', '.git'].includes(path.basename(item)) });
}

function temporaryRoot() {
  return fs.realpathSync(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : os.tmpdir());
}

function validateOwnedRoot(layout, temporaryDirectory = temporaryRoot()) {
  const root = path.resolve(layout.root);
  if (path.dirname(root) !== fs.realpathSync(temporaryDirectory) || !/^cva-[a-z\d]{6}$/i.test(path.basename(root)) ||
    fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root)
    throw new Error('Short Android root must be an owned, physical, unique directory directly in user Temp');
  const marker = JSON.parse(fs.readFileSync(path.join(root, '.cove-android-owner.json'), 'utf8'));
  if (marker.repository !== repository || marker.token !== layout.token ||
    marker.acceptanceId !== 'cove-acceptance-20261023') throw new Error('Short Android root ownership does not match');
  return { root, token: layout.token };
}

function createOwnedRoot(temporaryDirectory = temporaryRoot()) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(temporaryDirectory), 'cva-'));
  const layout = { root, token: randomUUID() };
  fs.writeFileSync(path.join(root, '.cove-android-owner.json'), JSON.stringify({
    repository, token: layout.token, acceptanceId: 'cove-acceptance-20261023',
  }, null, 2));
  return validateOwnedRoot(layout, temporaryDirectory);
}

function assertSnapshotFiles(snapshot, files) {
  for (const relative of files) {
    const staged = path.resolve(snapshot, relative);
    if (!inside(repository, path.resolve(repository, relative)) || !inside(snapshot, staged))
      throw new Error('Snapshot file escaped product roots');
    assertWritable(staged, snapshot);
    if (!fs.readFileSync(staged).equals(fs.readFileSync(path.join(repository, relative))))
      throw new Error(`Prepared snapshot differs from frozen product file: ${relative}`);
  }
}

function assertSharedDist(snapshot, packagesRoot = path.join(repository, 'packages')) {
  function manifest(directory) {
    const files = [];
    function visit(relative) {
      for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = path.join(relative, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Shared dist cannot contain borrowed links');
        if (entry.isDirectory()) visit(name);
        else files.push({ path: name.replaceAll('\\', '/'),
          sha256: createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex') });
      }
    }
    visit('');
    if (!files.some(file => file.path === 'index.js')) throw new Error('Build shared package dist before acceptance');
    return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
  }
  const result = {};
  for (const name of ['contracts', 'client-core']) {
    const original = manifest(path.join(packagesRoot, name, 'dist'));
    const staged = manifest(path.join(snapshot, 'packages', name, 'dist'));
    if (JSON.stringify(original) !== JSON.stringify(staged)) throw new Error(`Prepared shared dist differs: ${name}`);
    result[name] = staged;
  }
  return result;
}

function verifyPreparedSnapshot(snapshot) {
  const prepared = JSON.parse(fs.readFileSync(path.join(snapshot, 'prepared-source.json'), 'utf8'));
  if (!/^[a-f\d]{40}$/i.test(prepared.sourceCommit) ||
    (process.env.COVE_ACCEPTANCE_SOURCE_COMMIT && process.env.COVE_ACCEPTANCE_SOURCE_COMMIT !== prepared.sourceCommit))
    throw new Error('Prepared snapshot does not match the requested frozen source commit');
  if (process.env.COVE_ACCEPTANCE_ID && process.env.COVE_ACCEPTANCE_ID !== prepared.acceptanceId)
    throw new Error('Prepared snapshot does not match the requested acceptance ID');
  assertSourceUnchanged(prepared, productState());
  const frozenTrees = git('rev-parse', ...productPaths.map(name => `${prepared.sourceCommit}:${name}`)).split(/\r?\n/);
  if (JSON.stringify(prepared.productTrees) !== JSON.stringify(frozenTrees))
    throw new Error('Prepared snapshot product trees do not match its recorded commit');
  assertSnapshotFiles(snapshot, git('ls-files', '-z', '--', ...productPaths).split('\0').filter(Boolean));
  const sharedDist = assertSharedDist(snapshot);
  if (prepared.sharedDist && JSON.stringify(prepared.sharedDist) !== JSON.stringify(sharedDist))
    throw new Error('Prepared shared dist changed after its hash evidence was recorded');
  return { ...prepared, sharedDist };
}

function dependencyPlan(nodeModules) {
  const packages = [];
  for (const name of fs.readdirSync(nodeModules).filter(name => !name.startsWith('.'))) {
    const names = name.startsWith('@') ? fs.readdirSync(path.join(nodeModules, name)).map(leaf => `${name}/${leaf}`) : [name];
    for (const packageName of names) {
      const source = path.join(nodeModules, packageName);
      if (!fs.statSync(source).isDirectory()) continue;
      const native = writableNativePackages.has(packageName) || fs.existsSync(path.join(source, 'android'));
      packages.push({ packageName, source, writable: native });
    }
  }
  return packages;
}

function metroConfiguration(plan, destinationMobile = mobileRoot) {
  const watchFolders = [...new Set(plan.filter(item => !item.writable && !item.packageName.startsWith('@cove/'))
    .map(item => {
      const physical = fs.realpathSync(item.source);
      let root = physical;
      while (path.basename(root).toLowerCase() !== 'node_modules' && path.dirname(root) !== root)
        root = path.dirname(root);
      return path.basename(root).toLowerCase() === 'node_modules' ? root : physical;
    }))];
  const configPath = path.join(destinationMobile, 'metro.acceptance.config.cjs');
  const initPath = path.join(toolsRoot, 'acceptance-metro.gradle');
  const cacheDirectories = ['metro-transform-cache', 'metro-file-map'].map(name => path.join(toolsRoot, name));
  const configSource = `// Generated acceptance-only configuration; borrowed dependencies stay read-only.
const base = require('./metro.config.js');
const { FileStore } = require('metro-cache');
module.exports = {
  ...base,
  watchFolders: [...new Set([...(base.watchFolders || []), ...${JSON.stringify(watchFolders)}])],
  cacheStores: [new FileStore({ root: ${JSON.stringify(cacheDirectories[0])} })],
  fileMapCacheDirectory: ${JSON.stringify(cacheDirectories[1])},
  maxWorkers: 2,
};
`;
  const groovyConfigPath = configPath.replaceAll('\\', '/').replaceAll("'", "\\'");
  const initSource = `// Apply only to the isolated acceptance invocation.
gradle.beforeProject { project ->
    if (project.path == ':app' && project.hasProperty('coveRefactor')) {
        project.pluginManager.withPlugin('com.facebook.react') {
            project.extensions.getByName('react').bundleConfig.set(new File('${groovyConfigPath}'))
        }
    }
}
`;
  return { watchFolders, configPath, initPath, cacheDirectories, configSource, initSource };
}

function stageDependencies(plan, destinationSource = sourceRoot, root) {
  const destinationMobile = path.join(destinationSource, 'apps/mobile');
  for (const item of plan) {
    if (item.packageName.startsWith('@cove/')) continue;
    const target = path.join(destinationMobile, 'node_modules', item.packageName);
    assertWritable(path.dirname(target), root);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (item.writable) copy(fs.realpathSync(item.source), target, root);
    else if (!fs.existsSync(target)) {
      assertWritable(target, root);
      fs.symlinkSync(fs.realpathSync(item.source), target, 'junction');
    } else if (fs.realpathSync(target) !== fs.realpathSync(item.source))
      throw new Error(`Borrowed dependency target changed: ${item.packageName}`);
  }
  for (const name of ['contracts', 'client-core']) {
    const target = path.join(destinationMobile, 'node_modules/@cove', name);
    assertWritable(path.dirname(target), root);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) {
      assertWritable(target, root);
      fs.symlinkSync(path.join(destinationSource, 'packages', name), target, 'junction');
    }
  }
}

function writeMetroConfiguration(plan, destinationMobile = mobileRoot, root) {
  const metro = metroConfiguration(plan, destinationMobile);
  for (const directory of metro.cacheDirectories) {
    assertWritable(directory);
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const [target, source] of [[metro.configPath, metro.configSource], [metro.initPath, metro.initSource]]) {
    assertWritable(target, inside(toolsRoot, target) ? toolsRoot : root);
    fs.writeFileSync(target, source);
  }
  return metro;
}

function copyGradleCache(source, layout) {
  validateOwnedRoot(layout);
  assertWritable(source, toolsRoot);
  if (fs.realpathSync(source) !== path.resolve(source)) throw new Error('Gradle cache source must be physical');
  const target = path.join(layout.root, 'g');
  assertWritable(target, layout.root);
  fs.cpSync(source, target, { recursive: true, dereference: false, filter: item => {
    if (['daemon', '.tmp'].includes(path.basename(item)) || item.endsWith('.lock')) return false;
    if (fs.lstatSync(item).isSymbolicLink()) throw new Error(`Borrowed link inside Gradle cache: ${item}`);
    return true;
  } });
  return target;
}

function shortenPreparedSnapshot() {
  if (ownedLayout) throw new Error('A short Android root already exists; resume it instead');
  const prepared = verifyPreparedSnapshot(legacySourceRoot);
  const layout = createOwnedRoot();
  const destinationSource = path.join(layout.root, 's');
  for (const name of productPaths) copy(path.join(legacySourceRoot, name), path.join(destinationSource, name), layout.root);
  const plan = dependencyPlan(path.join(repository, 'apps/mobile/node_modules'));
  stageDependencies(plan, destinationSource, layout.root);
  const gradleHome = copyGradleCache(path.join(toolsRoot, 'gradle-user-home'), layout);
  writeMetroConfiguration(plan, path.join(destinationSource, 'apps/mobile'), layout.root);
  assertSnapshotFiles(destinationSource, git('ls-files', '-z', '--', ...productPaths).split('\0').filter(Boolean));
  assertSharedDist(destinationSource);
  assertSourceUnchanged(prepared, productState());
  fs.writeFileSync(path.join(destinationSource, 'prepared-source.json'), JSON.stringify({ ...prepared,
    relocatedFrom: legacySourceRoot, buildRoot: layout.root, nativeCacheMode: 'fresh-owned-cxx',
  }, null, 2));
  assertWritable(layoutFile, toolsRoot);
  fs.writeFileSync(layoutFile, JSON.stringify(layout, null, 2));
  return { ...prepared, sourceRoot: destinationSource, gradleUserHome: gradleHome,
    nativeCacheMode: 'fresh-owned-cxx', ownershipMarker: path.join(layout.root, '.cove-android-owner.json') };
}

function resetOwnedNativeCache(plan, layout = ownedLayout, stagedSource = sourceRoot) {
  if (!layout) return;
  validateOwnedRoot(layout);
  if (stagedSource !== path.join(layout.root, 's')) throw new Error('Native source root does not match owned layout');
  const stagedMobile = path.join(stagedSource, 'apps/mobile');
  const targets = [path.join(stagedMobile, 'android/app/.cxx'), ...plan.filter(item => item.writable)
    .map(item => path.join(stagedMobile, 'node_modules', item.packageName, 'android/.cxx'))];
  for (const target of targets) assertWritable(target, stagedSource);
  for (const target of targets) fs.rmSync(target, { recursive: true, force: true });
}

function prepare() {
  const product = productState();
  const prepared = sourceMetadata({ head: git('rev-parse', 'HEAD'), expected: process.env.COVE_ACCEPTANCE_SOURCE_COMMIT,
    status: git('status', '--porcelain=v1', '--untracked-files=all'), productStatus: product.status,
    productTrees: product.trees, acceptanceId: process.env.COVE_ACCEPTANCE_ID || 'acceptance-20261023' });
  assertWritable(mobileRoot);
  fs.mkdirSync(toolsRoot, { recursive: true });
  fs.mkdirSync(mobileRoot, { recursive: true });
  const originalMobile = path.join(repository, 'apps/mobile');
  for (const name of fs.readdirSync(originalMobile)) {
    if (['node_modules', '.gradle', 'build', '.git'].includes(name)) continue;
    copy(path.join(originalMobile, name), path.join(mobileRoot, name));
  }
  for (const name of ['contracts', 'client-core']) {
    const destination = path.join(sourceRoot, 'packages', name);
    copy(path.join(repository, 'packages', name), destination);
    // The runtime entrypoints are generated by the root's shared package build.
    const dist = path.join(repository, 'packages', name, 'dist');
    if (!fs.existsSync(dist)) throw new Error(`Build shared package first: ${name}`);
    copy(dist, path.join(destination, 'dist'));
  }
  const plan = dependencyPlan(path.join(originalMobile, 'node_modules'));
  stageDependencies(plan);
  const metro = writeMetroConfiguration(plan);
  prepared.sharedDist = assertSharedDist(sourceRoot);
  fs.writeFileSync(path.join(toolsRoot, 'dependency-isolation.json'), JSON.stringify({
    copied: plan.filter(item => item.writable).map(item => item.packageName),
    readonlyLinks: plan.filter(item => !item.writable).length,
  }, null, 2));
  assertSourceUnchanged(prepared, productState());
  fs.writeFileSync(path.join(sourceRoot, 'prepared-source.json'), JSON.stringify(prepared, null, 2));
  return { mobileRoot, toolsRoot, ...prepared, metroInitScript: metro.initPath,
    copied: plan.filter(item => item.writable).map(item => item.packageName) };
}

function buildEnvironment(sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT, layout = ownedLayout) {
  if (!sdk || !fs.existsSync(path.join(sdk, 'platforms/android-36/android.jar')))
    throw new Error('An existing Android SDK 36 is required (read-only)');
  const environment = { ...process.env, CI: 'true', COVE_ANDROID_SIGNING_MODE: 'legacy',
    GRADLE_USER_HOME: layout ? path.join(validateOwnedRoot(layout).root, 'g') : path.join(toolsRoot, 'gradle-user-home'),
    ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_USER_HOME: path.join(toolsRoot, 'android-user'),
    TMP: path.join(toolsRoot, 'tmp'), TEMP: path.join(toolsRoot, 'tmp'),
    npm_config_cache: path.join(toolsRoot, 'npm-cache'), npm_config_offline: 'true' };
  for (const name of ['GRADLE_USER_HOME', 'ANDROID_USER_HOME', 'TMP']) {
    assertWritable(environment[name], layout && inside(layout.root, environment[name]) ? layout.root : toolsRoot);
    fs.mkdirSync(environment[name], { recursive: true });
  }
  return environment;
}

function proxyArguments(environment) {
  const args = [];
  for (const [protocol, key] of [['http', 'HTTP_PROXY'], ['https', 'HTTPS_PROXY']]) {
    if (!environment[key]) continue;
    const proxy = new URL(environment[key]);
    if (proxy.protocol !== 'http:' || proxy.username || proxy.password)
      throw new Error('Gradle accepts only the existing unauthenticated HTTP proxy; do not pass credentials in command arguments');
    args.push(`-D${protocol}.proxyHost=${proxy.hostname}`, `-D${protocol}.proxyPort=${proxy.port || 80}`);
  }
  return args;
}

function runGradle(tasks, resume = false) {
  if (resume && !ownedLayout) throw new Error('Create and verify a short snapshot with shorten before resuming');
  const prepared = resume ? { ...verifyPreparedSnapshot(sourceRoot),
    metroInitScript: writeMetroConfiguration(dependencyPlan(path.join(repository, 'apps/mobile/node_modules'))).initPath } : prepare();
  const gradleHome = path.join(toolsRoot, 'gradle-9.3.1');
  const classpath = path.join(gradleHome, 'lib/gradle-gradle-cli-main-9.3.1.jar');
  if (!fs.existsSync(classpath)) throw new Error('Download and verify official Gradle 9.3.1 into android-tools first');
  const java = path.join(jdkDirectory(process.env), 'bin/java.exe');
  const environment = buildEnvironment();
  resetOwnedNativeCache(dependencyPlan(path.join(repository, 'apps/mobile/node_modules')));
  const invocation = path.join(sourceRoot, 'build-invocation.json');
  assertWritable(invocation);
  fs.writeFileSync(invocation, JSON.stringify({ sourceCommit: prepared.sourceCommit, buildToolingCommit: git('rev-parse', 'HEAD'),
    sourceRoot, gradleUserHome: environment.GRADLE_USER_HOME, nativeCacheMode: ownedLayout ? 'fresh-owned-cxx' : 'default',
    sharedDist: prepared.sharedDist,
  }, null, 2));
  const result = spawnSync(java, ['-Dfile.encoding=UTF-8', `-Djava.io.tmpdir=${environment.TMP}`, '-classpath', classpath,
    'org.gradle.launcher.GradleMain', ...tasks, '--init-script', prepared.metroInitScript,
    '--no-daemon', '--console=plain', '--stacktrace', '--max-workers=2',
    '-PcoveRefactor', '-PreactNativeArchitectures=armeabi-v7a,arm64-v8a',
    '-Pkotlin.compiler.execution.strategy=in-process',
    '-Dandroid.builder.sdkDownload=false', '-Dorg.gradle.java.installations.auto-download=false',
    '-Dorg.gradle.internal.http.connectionTimeout=20000', '-Dorg.gradle.internal.http.socketTimeout=60000',
    ...proxyArguments(environment)],
  { cwd: path.join(mobileRoot, 'android'), env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Gradle exited ${result.status}`);
}

function collect() {
  const prepared = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'prepared-source.json'), 'utf8'));
  if (process.env.COVE_ACCEPTANCE_SOURCE_COMMIT && process.env.COVE_ACCEPTANCE_SOURCE_COMMIT !== prepared.sourceCommit)
    throw new Error('Collected APK does not match COVE_ACCEPTANCE_SOURCE_COMMIT');
  assertSourceUnchanged(prepared, productState());
  const output = path.join(mobileRoot, 'android/app/build/outputs/apk/debug');
  const metadata = JSON.parse(fs.readFileSync(path.join(output, 'output-metadata.json'), 'utf8'));
  if (metadata.applicationId !== 'com.cove.mobile.refactor' || metadata.elements.length !== 1)
    throw new Error('Refusing to collect a non-isolated or ambiguous APK');
  const element = metadata.elements[0];
  const apk = path.join(output, element.outputFile);
  const destination = path.join(artifactsRoot, `Cove-Mobile-${element.versionName}-acceptance-20261023.apk`);
  assertWritable(destination, artifactsRoot);
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('Set ANDROID_HOME to the existing read-only Android SDK');
  const sdkTools = path.join(sdk, 'build-tools/36.0.0');
  const javaBin = path.join(jdkDirectory(process.env), 'bin');
  function inspect(executable, args) {
    const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`APK inspection failed: ${path.basename(executable)}`);
    return result.stdout;
  }
  const manifest = inspect(path.join(sdkTools, 'aapt.exe'), ['dump', 'badging', apk]);
  if (!manifest.includes("package: name='com.cove.mobile.refactor'") ||
    !manifest.includes("application-label:'Cove 验收测试'") ||
    !manifest.includes(`versionCode='${element.versionCode}'`) ||
    !manifest.includes(`versionName='${element.versionName}'`))
    throw new Error('APK manifest does not contain the isolated test identity and label');
  const entries = inspect(path.join(javaBin, 'jar.exe'), ['tf', apk]).split(/\r?\n/);
  if (!entries.includes('assets/index.android.bundle')) throw new Error('APK has no offline JS bundle');
  const buildConfig = fs.readFileSync(path.join(mobileRoot,
    'android/app/build/generated/source/buildConfig/debug/com/covemobile/BuildConfig.java'), 'utf8');
  if (!/boolean COVE_ACCEPTANCE_BUILD = true;/.test(buildConfig))
    throw new Error('Generated Android configuration has not disabled Metro for this acceptance build');
  const abis = [...new Set(entries.filter(name => /^lib\/[^/]+\/.+\.so$/.test(name)).map(name => name.split('/')[1]))].sort();
  if (JSON.stringify(abis) !== JSON.stringify(['arm64-v8a', 'armeabi-v7a']))
    throw new Error('APK must contain both requested ARM architectures');
  const signature = inspect(path.join(javaBin, 'java.exe'), ['-jar', path.join(sdkTools, 'lib/apksigner.jar'),
    'verify', '--verbose', '--print-certs', apk]);
  const signerSha256 = signature.match(/Signer #1 certificate SHA-256 digest: ([a-f\d]{64})/i)?.[1].toLowerCase();
  if (signerSha256 !== 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c')
    throw new Error('APK signer differs from the checked-in debug identity; no artifact collected');
  const invocation = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'build-invocation.json'), 'utf8'));
  if (invocation.sourceCommit !== prepared.sourceCommit) throw new Error('Build invocation source commit does not match');
  const sharedDist = assertSharedDist(sourceRoot);
  if (JSON.stringify(invocation.sharedDist) !== JSON.stringify(sharedDist))
    throw new Error('Shared dist changed during the Android build');
  fs.mkdirSync(artifactsRoot, { recursive: true });
  fs.copyFileSync(apk, destination);
  const sha256 = createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
  const report = { applicationId: metadata.applicationId, versionName: element.versionName,
    sourceCommit: prepared.sourceCommit, acceptanceId: prepared.acceptanceId,
    buildToolingCommit: invocation.buildToolingCommit, buildSourceRoot: sourceRoot,
    gradleUserHome: invocation.gradleUserHome, nativeCacheMode: invocation.nativeCacheMode,
    sharedDist,
    sourceDirty: prepared.sourceDirty, sourceStatus: prepared.sourceStatus,
    versionCode: element.versionCode, filename: path.basename(destination), size: fs.statSync(destination).size,
    sha256, testSigning: true, signerSha256, abis,
    minAndroidApi: Number(manifest.match(/sdkVersion:'(\d+)'/)?.[1]),
    targetAndroidApi: Number(manifest.match(/targetSdkVersion:'(\d+)'/)?.[1]),
    applicationLabel: 'Cove 验收测试', acceptanceBuildFlag: true, installPerformed: false, requiresMetro: false };
  fs.writeFileSync(`${destination}.inspection.txt`, `${manifest}\n${signature}`);
  fs.writeFileSync(`${destination}.json`, JSON.stringify(report, null, 2));
  return report;
}

module.exports = { inside, assertWritable, dependencyPlan, prepare, buildEnvironment, proxyArguments,
  sourceMetadata, assertSourceUnchanged, jdkDirectory, metroConfiguration, validateOwnedRoot, createOwnedRoot,
  assertSnapshotFiles, assertSharedDist, verifyPreparedSnapshot, copyGradleCache,
  shortenPreparedSnapshot, resetOwnedNativeCache, collect };
if (require.main === module) {
  const command = process.argv[2];
  if (command === 'prepare') console.log(JSON.stringify(prepare(), null, 2));
  else if (command === 'probe') runGradle(['help']);
  else if (command === 'build') { runGradle([':app:assembleDebug', ':app:testDebugUnitTest']); console.log(JSON.stringify(collect(), null, 2)); }
  else if (command === 'shorten') console.log(JSON.stringify(shortenPreparedSnapshot(), null, 2));
  else if (command === 'resume') { runGradle([':app:assembleDebug', ':app:testDebugUnitTest'], true); console.log(JSON.stringify(collect(), null, 2)); }
  else if (command === 'collect') console.log(JSON.stringify(collect(), null, 2));
  else throw new Error('Usage: node tooling/android-acceptance.cjs prepare|probe|build|shorten|resume|collect');
}
