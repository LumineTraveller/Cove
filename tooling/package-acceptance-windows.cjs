'use strict';
// Portable, local-only acceptance artifacts. No install, rebuild, signing or publishing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { within, cleanRuntimeEnvironment } = require('./acceptance/portable-common.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'runtime/acceptance-20261023/artifacts');
const tools = path.join(__dirname, 'acceptance');
const flavor = 'cove-acceptance-20261023';
function json(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 180000,
    env: cleanRuntimeEnvironment(), ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(executable)} ${args[0]} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function packageDirectory(requireFrom, name) {
  if (name.startsWith('@cove/')) {
    const local = path.join(root, 'packages', name.slice('@cove/'.length));
    if (fs.existsSync(path.join(local, 'package.json'))) return local;
  }
  const localRequire = createRequire(path.join(requireFrom, 'package.json'));
  let entry;
  try { entry = path.dirname(localRequire.resolve(`${name}/package.json`)); }
  catch { entry = path.dirname(localRequire.resolve(name)); }
  // Both exports can point into build/cjs/. Its format marker may repeat the
  // package name but omit the version and dependency graph of the actual owner.
  while (true) {
    const manifestFile = path.join(entry, 'package.json');
    if (fs.existsSync(manifestFile)) {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (manifest.name === name && typeof manifest.version === 'string') return fs.realpathSync(entry);
    }
    const parent = path.dirname(entry); if (entry === parent) throw new Error(`Cannot find package ${name}`); entry = parent;
  }
}
function copyTree(source, destination, extraFilter = () => true) {
  fs.cpSync(source, destination, { recursive: true, dereference: true,
    filter: file => !path.relative(source, file).split(path.sep).some(part => part === 'node_modules' || part === '.git') && extraFilter(file) });
}
function copyDependencies(requireFrom, names, destination) {
  const roots = new Map(); const copied = new Map(); const inventory = [];
  function add(from, name, parentDestination) {
    const source = packageDirectory(from, name);
    if (!roots.has(name)) roots.set(name, source);
    const target = path.join(roots.get(name) === source ? destination : path.join(parentDestination, 'node_modules'), name);
    if (copied.get(target) === source) return;
    if (copied.has(target)) throw new Error(`Conflicting dependency destination ${target}`);
    copied.set(target, source);
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    if (manifest.name !== name || typeof manifest.version !== 'string')
      throw new Error(`Dependency package metadata does not identify ${name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    copyTree(source, target, file => {
      const relative = path.relative(source, file).replaceAll('\\', '/');
      // Native runtime stays; vendored compiler/Python trees are not runtime dependencies.
      if (name === 'mediasoup' && relative.startsWith('worker/'))
        return relative === 'worker/out' || relative.startsWith('worker/out/Release') || relative === 'worker/out/Release';
      if (name.startsWith('@cove/')) return !relative.startsWith('src') && !relative.startsWith('tests');
      return true;
    });
    inventory.push({ name: manifest.name, version: manifest.version, path: path.relative(path.dirname(destination), target).replaceAll('\\', '/') });
    for (const dep of Object.keys(manifest.dependencies || {})) add(source, dep, target);
    for (const dep of Object.keys(manifest.optionalDependencies || {})) {
      try { packageDirectory(source, dep); } catch { continue; }
      add(source, dep, target);
    }
  }
  for (const name of names) add(requireFrom, name, path.dirname(destination));
  return inventory.sort((a, b) => a.path.localeCompare(b.path));
}
function assertPhysicalTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Artifact contains a link: ${target}`);
    if (entry.isDirectory()) assertPhysicalTree(target);
  }
}
function verifyReleaseGate(appRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const main = fs.readFileSync(path.join(appRoot, 'dist-electron/main.js'), 'utf8');
  if (manifest.coveBuildFlavor !== 'network-lab' || manifest.coveAcceptance?.appId !== 'com.cove.acceptance.20261023' ||
      !/isNetworkLabBuild\s*=\s*buildFlavor\s*===\s*['"]network-lab['"]/.test(main) ||
      !/updaterController\s*=\s*isNetworkLabBuild\s*\?\s*null\s*:/.test(main) ||
      !/isPackaged:\s*[^,]*!isNetworkLabBuild/.test(main))
    throw new Error('Acceptance updater/installer release gate could not be verified; refuse packaging');
  return { status: 'disabled', automaticReleaseChecks: false, automaticUpdates: false, installerRepair: false,
    verifiedBy: 'packaged network-lab manifest plus compiled main updater/integrity gates',
    manifestSha256: sha256(path.join(appRoot, 'package.json')), mainSha256: sha256(path.join(appRoot, 'dist-electron/main.js')) };
}
function writeConfig(destination, commit) {
  json(path.join(destination, 'acceptance.config.json'), { flavor, sourceCommit: commit,
    sourceVersion: require('../apps/desktop/package.json').version,
    httpPort: 33991, mediaPort: 41990, listenHost: '127.0.0.1', announceAddress: '127.0.0.1' });
}
function writeLauncher(file, executable, entry = '') {
  // Strip inherited preload/injection settings before a bundled runtime starts.
  fs.writeFileSync(file, `@echo off\r\nsetlocal\r\nset "NODE_OPTIONS="\r\nset "NODE_PATH="\r\nset "ELECTRON_RUN_AS_NODE="\r\ncd /d "%~dp0"\r\n"%~dp0${executable}" ${entry}\r\nif errorlevel 1 pause\r\n`, 'utf8');
}
async function ensureNodeLicense() {
  const target = path.join(output, '_licenses', `node-${process.version}-LICENSE.txt`);
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Official Node license unavailable: ${response.status}`);
  const content = await response.text();
  if (!content.includes('Node.js') || !content.includes('Permission is hereby granted')) throw new Error('Unexpected Node license');
  fs.writeFileSync(target, content);
  return target;
}
function buildApps(desktop, server) {
  const desktopRoot = path.join(root, 'apps/desktop');
  const req = createRequire(path.join(desktopRoot, 'package.json'));
  const tsc = require.resolve('typescript/bin/tsc');
  run(process.execPath, [tsc, '-p', 'apps/server/tsconfig.build.json', '--outDir', path.join(server, 'dist')]);
  run(process.execPath, [tsc, '-p', 'apps/desktop/electron/tsconfig.json', '--outDir', path.join(desktop, 'resources/app/dist-electron')]);
  const vite = path.join(path.dirname(req.resolve('vite/package.json')), 'bin/vite.js');
  run(process.execPath, [vite, 'build', '--outDir', path.join(desktop, 'resources/app/dist'), '--emptyOutDir'], {
    cwd: desktopRoot, env: { ...cleanRuntimeEnvironment(), VITE_SERVER_URL: 'http://127.0.0.1:33991', VITE_COVE_DEFAULT_SERVER: 'http://127.0.0.1:33991',
      COVE_VITE_CACHE_DIR: path.join(output, '_build-cache') },
  });
}
function compileHelpers(desktop) {
  const windows = process.env.WINDIR || 'C:\\Windows';
  const compiler = ['Framework64', 'Framework'].map(name => path.join(windows, 'Microsoft.NET', name, 'v4.0.30319/csc.exe')).find(fs.existsSync);
  if (!compiler) throw new Error('The existing Windows .NET C# compiler is required to build isolated acceptance helpers');
  return [
    ['annotation-window-helper', []],
    ['remote-input-helper', ['System.Web.Extensions.dll', 'System.Windows.Forms.dll']],
    ['application-audio-helper', ['System.Web.Extensions.dll', 'System.Drawing.dll']],
  ].map(([name, references]) => {
    const source = path.join(root, 'apps/desktop/electron', name + '.cs');
    const executable = path.join(desktop, 'resources', name + '.exe');
    run(compiler, ['/nologo', '/target:exe', '/optimize+', '/platform:x64', `/out:${executable}`,
      ...references.map(reference => `/reference:${reference}`), source]);
    return { name, sourceSha256: sha256(source), executableSha256: sha256(executable), builtFromFrozenSource: true };
  });
}
function hashTree(directory, prefix = '') {
  const rows = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'acceptance-data') continue;
    const name = prefix + entry.name;
    if (entry.isDirectory()) rows.push(...hashTree(path.join(directory, entry.name), name + '/'));
    else rows.push({ path: name, bytes: fs.statSync(path.join(directory, entry.name)).size, sha256: sha256(path.join(directory, entry.name)) });
  }
  return rows;
}
async function main(args) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.modules !== '137')
    throw new Error('Acceptance server requires the validated Windows x64 Node ABI 137 runtime');
  const prepare = args.includes('--prepare-only');
  if (args.some(arg => arg !== '--prepare-only')) throw new Error('Only --prepare-only is supported');
  const commit = run('git', ['rev-parse', 'HEAD']);
  if (!prepare && run('git', ['status', '--porcelain'])) throw new Error('Freeze and commit source before producing final acceptance archives');
  fs.mkdirSync(output, { recursive: true });
  if (!within(fs.realpathSync(root), fs.realpathSync(output))) throw new Error('Artifact output escaped this checkout');
  const label = commit.slice(0, 12);
  // Chromium's legacy cache paths have tighter Windows limits than Node's
  // file APIs. A short provisional folder keeps deep checkout probes valid.
  const stage = path.join(output, prepare ? `_prepare-${Date.now()}` : `Cove-Acceptance-20261023-${label}-win-x64`);
  fs.mkdirSync(stage); // Refuse overwrites; previous rollback artifacts remain intact.
  const desktop = path.join(stage, 'Desktop'); const server = path.join(stage, 'Server');
  const appRoot = path.join(desktop, 'resources/app');
  const desktopRoot = path.join(root, 'apps/desktop');
  const desktopRequire = createRequire(path.join(desktopRoot, 'package.json'));
  const electronDir = path.dirname(desktopRequire('electron'));
  fs.cpSync(electronDir, desktop, { recursive: true, dereference: true,
    filter: file => path.basename(file) !== 'default_app.asar' });
  fs.renameSync(path.join(desktop, 'electron.exe'), path.join(desktop, 'Cove-Acceptance.exe'));
  fs.mkdirSync(appRoot, { recursive: true }); fs.mkdirSync(server, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(server, 'node.exe'));
  fs.copyFileSync(await ensureNodeLicense(), path.join(server, 'NODE-LICENSE.txt'));
  const desktopDeps = copyDependencies(desktopRoot, ['electron-updater', 'loopback-capture'], path.join(appRoot, 'node_modules'));
  const serverDeps = copyDependencies(path.join(root, 'apps/server'), Object.keys(require('../apps/server/package.json').dependencies), path.join(server, 'node_modules'));
  for (const [directory, entry] of [[appRoot, 'desktop-entry.cjs'], [server, 'server-entry.cjs']]) {
    fs.copyFileSync(path.join(tools, entry), path.join(directory, entry));
    fs.copyFileSync(path.join(tools, 'portable-common.cjs'), path.join(directory, 'portable-common.cjs'));
  }
  const desktopManifest = require('../apps/desktop/package.json');
  json(path.join(appRoot, 'package.json'), { name: 'cove-acceptance-20261023', productName: 'Cove Acceptance 20261023',
    version: desktopManifest.version, main: 'desktop-entry.cjs', coveBuildFlavor: 'network-lab',
    coveAcceptance: { flavor, sourceCommit: commit, appId: 'com.cove.acceptance.20261023' } });
  json(path.join(server, 'package.json'), { name: 'cove-acceptance-server-20261023', version: require('../apps/server/package.json').version, private: true });
  writeConfig(desktop, commit); writeConfig(server, commit);
  writeLauncher(path.join(desktop, 'Start-Desktop.cmd'), 'Cove-Acceptance.exe');
  writeLauncher(path.join(server, 'Start-Server.cmd'), 'node.exe', 'server-entry.cjs');
  for (const helper of ['annotation-window-helper.exe', 'remote-input-helper.exe', 'application-audio-helper.exe'])
    fs.copyFileSync(path.join(desktopRoot, 'build', helper), path.join(desktop, 'resources', helper));
  fs.mkdirSync(path.join(appRoot, 'electron'), { recursive: true });
  fs.copyFileSync(path.join(desktopRoot, 'electron/annotation-overlay.html'), path.join(appRoot, 'electron/annotation-overlay.html'));
  const probe = run(path.join(server, 'node.exe'), [path.join(server, 'server-entry.cjs'), '--check'], { cwd: server, timeout: 30000 });
  console.log(probe);
  const desktopProbe = run(path.join(desktop, 'Cove-Acceptance.exe'), ['--acceptance-runtime-check'], { cwd: desktop, timeout: 30000 });
  const desktopRuntime = JSON.parse(desktopProbe.split(/\r?\n/).findLast(line => line.startsWith('{')));
  console.log(JSON.stringify(desktopRuntime));
  const manifest = { flavor, provisional: prepare, sourceCommit: commit, sourceTree: 'clean-required-for-final',
    builtAt: new Date().toISOString(), desktop: { version: desktopManifest.version, electron: desktopRuntime.electron,
      node: desktopRuntime.node, modules: desktopRuntime.modules, appId: 'com.cove.acceptance.20261023',
      autoUpdates: false, cache: 'Desktop/acceptance-data/cache', profile: 'Desktop/acceptance-data/desktop/Cove Network Lab', dependencies: desktopDeps },
    server: { version: require('../apps/server/package.json').version, node: process.version, modules: process.versions.modules,
      nodeExeSha256: sha256(path.join(server, 'node.exe')), httpPort: 33991, mediaPort: 41990, defaultBind: '127.0.0.1',
      profile: 'Server/acceptance-data/server', nativeProbe: JSON.parse(probe.split(/\r?\n/).findLast(line => line.startsWith('{'))), dependencies: serverDeps } };
  json(path.join(stage, 'manifest.json'), manifest);
  if (prepare) { console.log(JSON.stringify({ prepared: stage, provisional: true, finalBuildPending: true })); return; }
  buildApps(desktop, server);
  manifest.desktop.nativeHelpers = compileHelpers(desktop);
  json(path.join(stage, 'manifest.json'), manifest);
  json(path.join(stage, 'release-check.json'), verifyReleaseGate(appRoot));
  const serverSmoke = run(path.join(server, 'node.exe'), [path.join(server, 'server-entry.cjs'), '--smoke'], { cwd: server, timeout: 30000 });
  const desktopSmoke = run(path.join(desktop, 'Cove-Acceptance.exe'), ['--acceptance-smoke'], { cwd: desktop, timeout: 30000 });
  if (run('git', ['rev-parse', 'HEAD']) !== commit || run('git', ['status', '--porcelain']))
    throw new Error('Source changed while packaging; retain this staging folder for diagnosis and rebuild from a frozen commit');
  json(path.join(stage, 'smoke-results.json'), { server: serverSmoke, desktop: desktopSmoke });
  // Probe-only profiles are not user data and must not enter the archive.
  for (const base of [desktop, server]) {
    const target = path.join(base, 'acceptance-data');
    if (!within(stage, fs.realpathSync(target))) throw new Error('Refusing cleanup outside the artifact staging folder');
    fs.rmSync(target, { recursive: true });
  }
  fs.writeFileSync(path.join(stage, 'READ-ME.txt'),
    `Cove Windows acceptance 20261023\r\nCommit: ${commit}\r\n\r\n` +
    '1. Extract this entire ZIP into a new writable folder. No installation or developer tools required.\r\n' +
    '2. Open Server/Start-Server.cmd, then Desktop/Start-Desktop.cmd. Register test accounts; use http://127.0.0.1:33991.\r\n' +
    '3. To stop, close the desktop and press Ctrl+C in the server console.\r\n' +
    '4. State stays in each folder under acceptance-data. Never copy formal Cove profiles here. Automatic updates and installer repair are disabled.\r\n' +
    '5. Phone/LAN opt-in: stop the test server, change Server/acceptance.config.json listenHost to 0.0.0.0 and announceAddress to this PC private IPv4; phone manually enters http://THAT-IP:33991. No firewall changes are performed.\r\n' +
    '6. Rollback: close these test processes and return to your unchanged formal app. Archive/delete this extracted test folder when no longer needed; formal profiles are separate.\r\n' +
    'This is an unsigned portable test build, not an installer or formal upgrade. Desktop smoke verifies rendering only; real microphone/screen/input require manual acceptance.\r\n');
  assertPhysicalTree(stage);
  json(path.join(stage, 'file-hashes.json'), hashTree(stage));
  const zip = stage + '.zip';
  const seven = require('7zip-bin').path7za;
  run(seven, ['a', '-tzip', '-mx=5', zip, path.basename(stage)], { cwd: output, timeout: 300000 });
  const checksum = sha256(zip);
  fs.writeFileSync(zip + '.sha256', `${checksum}  ${path.basename(zip)}\n`);
  console.log(JSON.stringify({ artifact: zip, bytes: fs.statSync(zip).size, sha256: checksum, manifest: path.join(stage, 'manifest.json') }, null, 2));
}
module.exports = { packageDirectory, copyTree, copyDependencies, assertPhysicalTree, hashTree, verifyReleaseGate };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.stack); process.exitCode = 1; });
