// Read-only verification of already-built official Windows release assets.
// Usage: node tools/verify-release-integrity.cjs ASSETS_DIR [--allow-draft]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const asar = require('@electron/asar');
const yaml = require('js-yaml');
const sevenZip = require('7zip-bin').path7za;
const root = path.resolve(__dirname, '..');
const assets = path.resolve(process.argv[2] || 'runtime/release-210/assets');
const runtime = path.dirname(assets);
const allowDraft = process.argv.includes('--allow-draft');
const release = JSON.parse(fs.readFileSync(path.join(assets, 'release.json'), 'utf8'));
assert.match(release.tag_name, /^v\d+\.\d+\.\d+$/);
const version = release.tag_name.slice(1);
const manifestName = `Cove-Integrity-${version}-win32-x64.json`;
const installerName = `Cove-Setup-${version}.exe`;
const report = { status: 'running', version, startedAt: new Date().toISOString(),
  installerExecuted: false, applicationExecuted: false, repairLaunched: false, checks: [] };
const save = () => fs.writeFileSync(path.join(runtime, 'artifact-verification.json'), JSON.stringify(report, null, 2) + '\n');
async function hash(file, algorithm = 'sha256', encoding = 'hex') {
  const value = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) value.update(chunk);
  return value.digest(encoding);
}
async function run(command, args, timeout = 300000) {
  return exec(command, args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout });
}
async function download(name) {
  const found = release.assets.filter(asset => asset.name === name);
  assert.equal(found.length, 1);
  const asset = found[0];
  assert.equal(asset.state, 'uploaded');
  assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
  assert(asset.size > 0 && asset.size < 120 * 1024 * 1024);
  // A draft may temporarily use an untagged browser URL. No URL is fetched here.
  if (!release.draft) assert.equal(asset.browser_download_url, `https://github.com/LumineTraveller/Cove/releases/download/v${version}/${name}`);
  const file = path.join(assets, name);
  assert(fs.existsSync(file), `Missing supplied asset: ${name}`);
  assert.equal(fs.statSync(file).size, asset.size);
  assert.equal(`sha256:${await hash(file)}`, asset.digest);
  report.checks.push({ name, bytes: asset.size, digest: asset.digest, officialAssetVerified: true });
  save();
  return file;
}
async function main() {
  assert(allowDraft || release.draft === false, 'Unpublished assets require explicit offline draft verification');
  report.inputDraft = release.draft;
  report.tag = release.tag_name;
  assert.equal(release.prerelease, false);
  const expectedNames = [installerName, `${installerName}.blockmap`, `Cove-Server-Setup-${version}.exe`,
    `Cove-Server-Setup-${version}.exe.blockmap`, 'latest.yml', manifestName].sort();
  assert.deepEqual(release.assets.map(item => item.name).sort(), expectedNames);
  for (const name of expectedNames) await download(name);
  const installer = path.join(assets, installerName);
  const manifestFile = path.join(assets, manifestName);
  const updateFile = path.join(assets, 'latest.yml');
  const update = yaml.load(fs.readFileSync(updateFile, 'utf8'));
  assert.equal(update.version, version);
  assert.equal(update.path, installerName);
  assert.equal(update.sha512, await hash(installer, 'sha512', 'base64'));
  const listing = (await run(sevenZip, ['l', '-slt', '-sccUTF-8', installer])).stdout;
  fs.writeFileSync(path.join(runtime, 'installer-listing.txt'), listing);
  const entries = [];
  let total = 0;
  for (const block of listing.replace(/\r/g, '').split(/\n\s*\n/)) {
    const item = {};
    for (const line of block.split('\n')) {
      const split = line.indexOf(' = ');
      if (split > 0) item[line.slice(0, split)] = line.slice(split + 3);
    }
    if (!item.Path || item.Size === undefined) continue;
    const relative = item.Path.replace(/\\/g, '/');
    assert(!relative.startsWith('/') && !relative.includes(':'));
    assert(relative.split('/').every(part => part && part !== '.' && part !== '..'));
    assert(!item['Symbolic Link'] && !item['Hard Link']);
    const size = Number(item.Size);
    assert(Number.isSafeInteger(size) && size >= 0);
    total += size;
    assert(total < 2 * 1024 * 1024 * 1024 && entries.length < 30000);
    entries.push({ relative, size });
  }
  const executable = entries.filter(item => item.relative.split('/').at(-1) === 'Cove.exe');
  assert.equal(executable.length, 1);
  const extracted = fs.mkdtempSync(path.join(runtime, 'payload-'));
  assert(path.resolve(extracted).startsWith(path.resolve(runtime) + path.sep));
  await run(sevenZip, ['x', '-y', `-o${extracted}`, installer]);
  const payloadRoot = path.dirname(path.join(extracted, ...executable[0].relative.split('/')));
  const embedded = path.join(payloadRoot, 'resources', 'cove-integrity.json');
  assert.deepEqual(fs.readFileSync(embedded), fs.readFileSync(manifestFile));
  const descriptor = fs.openSync(path.join(payloadRoot, 'Cove.exe'), 'r');
  const pe = Buffer.alloc(65536);
  let headerBytes;
  try { headerBytes = fs.readSync(descriptor, pe, 0, pe.length, 0); }
  finally { fs.closeSync(descriptor); }
  assert.equal(pe.toString('ascii', 0, 2), 'MZ');
  const peOffset = pe.readUInt32LE(0x3c);
  assert(peOffset + 6 <= headerBytes);
  assert.equal(pe.readUInt32LE(peOffset), 0x00004550);
  assert.equal(pe.readUInt16LE(peOffset + 4), 0x8664);
  const archive = path.join(payloadRoot, 'resources', 'app.asar');
  const packed = JSON.parse(asar.extractFile(archive, 'package.json'));
  assert.equal(packed.name, 'cove-client');
  assert.equal(packed.version, version);
  assert.equal(packed.coveBuildFlavor, undefined);
  const code = asar.extractFile(archive, path.normalize('dist-electron/installation-integrity.js')).toString('utf8');
  const loaded = new Module(path.join(runtime, 'packaged-integrity-under-test.cjs'), module);
  loaded.filename = path.join(runtime, 'packaged-integrity-under-test.cjs');
  loaded.paths = module.paths;
  loaded._compile(code, loaded.filename);
  const manifestBytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes);
  for (const required of ['Cove.exe', 'resources/app.asar', 'resources/elevate.exe',
    'resources/annotation-window-helper.exe', 'resources/remote-input-helper.exe', 'resources/application-audio-helper.exe']) {
    assert(manifest.files.some(file => file.path === required), required);
  }
  const requests = [];
  const controller = loaded.exports.createInstallationIntegrityController({
    isPackaged: true, platform: 'win32', arch: 'x64', version, installRoot: payloadRoot,
    userDataDir: path.join(runtime, 'unused-user-profile'), cacheRoot: path.join(runtime, 'unused-repair-cache'),
    publishState() {}, isExternalBusy: () => false,
    fetchImpl: async url => {
      requests.push(String(url));
      // The API bytes and file hashes were validated by the caller. This offline
      // payload check emulates publication; it never trusts a draft in production.
      if (url === `https://api.github.com/repos/LumineTraveller/Cove/releases/tags/v${version}`) return new Response(JSON.stringify({ ...release, draft: false,
        assets: release.assets.map(asset => ({ ...asset, browser_download_url: `https://github.com/LumineTraveller/Cove/releases/download/v${version}/${asset.name}` })) }));
      if (url === `https://github.com/LumineTraveller/Cove/releases/download/v${version}/${manifestName}`) return new Response(manifestBytes);
      throw new Error('No other network request is permitted');
    },
    confirmInstall: async () => { throw new Error('No repair confirmation permitted'); },
    openInstaller: async () => { throw new Error('No installer execution permitted'); },
    quit: () => { throw new Error('No application exit permitted'); },
  });
  const state = await controller.checkNow();
  assert.equal(state.status, 'healthy', JSON.stringify(state));
  assert.equal(state.issueCount, 0);
  assert.equal(state.checkedFiles, manifest.files.length);
  assert.equal(requests.length, 2);
  controller.dispose();
  report.status = 'passed';
  report.managedFiles = state.checkedFiles;
  report.packagedCoreMatchedActualPayload = true;
  report.embeddedAndOfficialManifestsIdentical = true;
  report.nsisElevateHelperVerified = true;
  report.windowsX64PE = true;
  report.updateSha512Verified = true;
  report.extractedBytes = total;
  report.completedAt = new Date().toISOString();
  save();
  // Remove only this verifier's newly-created payload tree, never any real install.
  assert(path.dirname(extracted) === runtime && path.basename(extracted).startsWith('payload-'));
  fs.rmSync(extracted, { recursive: true, force: true });
  report.temporaryPayloadRemoved = true;
  save();
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { report.status = 'failed'; report.error = error.message; save(); console.error(error); process.exitCode = 1; });
