'use strict';
// Optional local-only portable candidate. Never installs, signs, or publishes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { cleanRuntimeEnvironment } = require('./acceptance/portable-common.cjs');
const root = path.resolve(__dirname, '..');
const desktop = path.join(root, 'apps/desktop');
const manifest = require(path.join(desktop, 'package.json'));
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, encoding: 'utf8', env: cleanRuntimeEnvironment() });
if (git.status !== 0 || !/^[0-9a-f]{40}$/.test(git.stdout.trim())) throw Error('Source commit is unavailable');
const sourceCommit = git.stdout.trim();
if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Windows x64 is required');
for (const file of ['dist/index.html', 'dist-electron/main.js', 'dist-electron/preload.js',
  'build/native-screen-capture-helper.exe', 'build/native-screen-handles.node']) {
  if (!fs.existsSync(path.join(desktop, file))) throw Error(`Build prerequisite missing: ${file}`);
}
const destination = fs.mkdtempSync(path.join(root, 'runtime/native-capture-lab-'));
const config = {
  ...manifest.build,
  appId: 'com.cove.nativecapturelab', productName: 'Cove Native Capture Lab',
  npmRebuild: false, nodeGypRebuild: false, buildDependenciesFromSource: false,
  electronVersion: require(require.resolve('electron/package.json', { paths: [desktop] })).version,
  electronDist: path.join(path.dirname(require.resolve('electron/package.json', { paths: [desktop] })), 'dist'),
  publish: null, directories: { output: destination },
  extraMetadata: { coveBuildFlavor: 'native-capture-lab' },
  win: { ...manifest.build.win, signAndEditExecutable: false, extraResources: [
    ...manifest.build.win.extraResources,
    { from: 'build/native-screen-capture-helper.exe', to: 'native-screen-capture-helper.exe' },
    { from: 'build/native-screen-handles.node', to: 'native-screen-handles.node' },
  ] },
};
const configFile = path.join(destination, 'builder.json');
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
const builder = require.resolve('electron-builder/cli.js', { paths: [desktop] });
const result = spawnSync(process.execPath, [builder, '--dir', '--win', '--x64', '--publish', 'never', '--config', configFile], {
  cwd: desktop, windowsHide: true, stdio: 'inherit', timeout: 240000,
  env: { ...cleanRuntimeEnvironment(), CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});
if (result.error || result.status !== 0) throw Error('Local candidate packaging failed; no release was published');
const directory = path.join(destination, 'win-unpacked');
const executable = 'Cove Native Capture Lab.exe';
fs.writeFileSync(path.join(directory, 'CANDIDATE.json'), JSON.stringify({ flavor: 'native-capture-lab',
  sourceVersion: manifest.version, sourceCommit, createdAt: new Date().toISOString(),
  formalInstallationChanged: false, formalUpdateChannelsEnabled: false }, null, 2) + '\n');
for (const [name, disabled] of [['Start-Native.cmd', ''], ['Start-Stock.cmd', '1']]) {
  const rollback = disabled ? 'set "COVE_DISABLE_NATIVE_GPU_CAPTURE=1"\r\n' : '';
  fs.writeFileSync(path.join(directory, name), `@echo off\r\nsetlocal\r\nset "NODE_OPTIONS="\r\nset "NODE_PATH="\r\nset "ELECTRON_RUN_AS_NODE="\r\n${rollback}cd /d "%~dp0"\r\nstart "" "%~dp0${executable}"\r\n`, 'utf8');
}
fs.writeFileSync(path.join(directory, 'READ-ME.txt'),
  'Cove Native Capture Lab — isolated local acceptance candidate\r\n' +
  'Start-Native.cmd: native GPU capture when eligible; stock startup fallback.\r\n' +
  'Start-Stock.cmd: disable the native path for this launch. Close this lab before switching.\r\n' +
  'Separate app profile: Cove Native Capture Lab. Formal Cove data and update channels are not used.\r\n' +
  'First version: one physical primary display, SDR landscape, preset resolution. Other cases use stock.\r\n' +
  'A committed native failure stops sharing safely; retry manually uses stock for that app session.\r\n' +
  'No server update is needed. This archive is not a formal release or installer.\r\n', 'utf8');
const files = [];
function inspect(current) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw Error('Unexpected link in candidate');
    if (entry.isDirectory()) inspect(file);
    else files.push({ path: path.relative(directory, file).replaceAll('\\', '/'), bytes: fs.statSync(file).size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
  }
}
inspect(directory);
fs.writeFileSync(path.join(destination, 'files-sha256.json'), JSON.stringify({ version: manifest.version, sourceCommit,
  flavor: 'native-capture-lab', files }, null, 2) + '\n');
console.log(JSON.stringify({ destination, directory, executable: path.join(directory, executable),
  fileManifest: path.join(destination, 'files-sha256.json'), published: false }));
