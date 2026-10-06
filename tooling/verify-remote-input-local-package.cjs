// Verify the final NSIS payload without running or installing the installer.
// 7-Zip streams entries directly into hashes; no extra large disk copies.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const yaml = require('js-yaml');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'apps/desktop/dist-app-remote-input-2.0.1');
const installerName = process.argv[2] ?? 'Cove-Setup-2.0.1.exe';
assert.ok(['Cove-Setup-2.0.1.exe', 'Cove-Setup-2.0.1-raw-input.exe', 'Cove-Setup-2.0.1-remote-input-account-memory.exe'].includes(installerName));
const rawInputCandidate = installerName.includes('raw-input');
const unifiedCandidate = installerName.includes('remote-input-account-memory');
const installer = path.join(output, installerName);
const rollback = path.join(root, 'runtime/rollback-2.0.0/Cove-Setup-2.0.0.exe');
async function fingerprint(file, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}
async function payloadFingerprint(entry) {
  const child = spawn(require('7zip-bin').path7za, ['e', '-so', installer, entry],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'close');
  const hash = createHash('sha256');
  let size = 0, stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  for await (const chunk of child.stdout) { size += chunk.length; hash.update(chunk); }
  const [code] = await exited;
  assert.equal(code, 0, stderr); assert.ok(size > 0, 'installer entry missing: ' + entry);
  return { entry, size, sha256: hash.digest('hex') };
}
async function main() {
  const manifest = require('../apps/desktop/package.json');
  assert.equal(manifest.version, '2.0.1'); assert.equal(manifest.build.appId, 'com.cove.app');
  assert.equal(manifest.build.productName, 'Cove'); assert.equal(manifest.coveBuildFlavor, undefined);
  const archive = path.join(output, 'win-unpacked/resources/app.asar');
  const packed = JSON.parse(asar.extractFile(archive, 'package.json'));
  assert.equal(packed.name, 'cove-client'); assert.equal(packed.version, '2.0.1'); assert.equal(packed.coveBuildFlavor, undefined);
  const metadata = yaml.load(fs.readFileSync(path.join(output, 'latest.yml'), 'utf8'));
  assert.equal(metadata.version, '2.0.1'); assert.equal(metadata.files[0].url, path.basename(installer));
  assert.equal(metadata.files[0].size, fs.statSync(installer).size);
  assert.equal(await fingerprint(installer, 'sha512', 'base64'), metadata.files[0].sha512);
  const payload = [];
  for (const entry of ['Cove.exe', 'resources\\app.asar', 'resources\\remote-input-helper.exe',
    'resources\\annotation-window-helper.exe', 'resources\\application-audio-helper.exe']) {
    const row = await payloadFingerprint(entry);
    const unpacked = path.join(output, 'win-unpacked', entry);
    assert.equal(row.size, fs.statSync(unpacked).size);
    assert.equal(row.sha256, await fingerprint(unpacked));
    payload.push(row);
  }
  const native = spawnSync(path.join(output, 'win-unpacked/resources/remote-input-helper.exe'), ['0'],
    { windowsHide: true, encoding: 'utf8', timeout: 3000,
      input: '{"type":"noop","seq":1}\n{"type":"stop"}\n{"type":"noop","seq":2}\n' });
  assert.equal(native.status, 0, native.stderr || native.error?.message);
  assert.deepEqual(native.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)), [{ ready: true }, { seq: 1 }]);
  const rollbackSha256 = await fingerprint(rollback);
  assert.equal(rollbackSha256, '6a80c3ca1237cde6f13887dbc668d6f7df3a20e9c2783547ac52ac4475233115');
  const liveFile = path.join(root, 'runtime/remote-input-2.0.1-live-version-policy.json');
  const policy = JSON.parse(fs.readFileSync(liveFile, 'utf8'));
  assert.equal(policy.minimumClientVersion, '2.0.0'); assert.equal(policy.requiredClientProtocol, 3);
  assert.equal(policy.upgradeRequired, false);
  const smoke = JSON.parse(fs.readFileSync(path.join(root, unifiedCandidate ? 'runtime/remote-input-unified-packaged-smoke.json' : rawInputCandidate ? 'runtime/remote-input-raw-packaged-smoke.json' : 'runtime/remote-input-packaged-smoke.json'), 'utf8'));
  assert.equal(smoke.archiveSha256, payload.find(row => row.entry === 'resources\\app.asar').sha256);
  assert.equal(smoke.actualPackagedExecutableStarted, true); assert.equal(smoke.helpersExited, true);
  if(unifiedCandidate) {
    assert.equal(smoke.accountPasswordBridgeVerified, true);
    assert.equal(smoke.accountPasswordsOSCryptoVerified, true);
    const files=asar.listPackage(archive);
    const frontend=files.filter(name=>/index-.*\.js$/.test(name)).map(name=>asar.extractFile(archive,name.slice(1)).toString()).join('\n');
    const styles=files.filter(name=>/index-.*\.css$/.test(name)).map(name=>asar.extractFile(archive,name.slice(1)).toString()).join('\n');
    assert.ok(frontend.includes('pointerrawupdate'));
    assert.equal(frontend.includes('remote-control-frame'),false);
    assert.ok(styles.includes('body:has(.share-view.screen-maximized) .cove-window-titlebar{display:none}'));
    for(const file of ['account-password-ipc.js','account-password-store.js'])
      assert.equal(createHash('sha256').update(asar.extractFile(archive,'dist-electron/'+file)).digest('hex'),await fingerprint(path.join(root,'apps/desktop/dist-electron',file)));
  }
  const report = { verifiedAt: new Date().toISOString(), appId: manifest.build.appId, productName: manifest.build.productName,
    packageName: packed.name, version: packed.version,
    sourceFixCommits: unifiedCandidate ? ['d4c18a4', '76992b2', '74331dc'] : rawInputCandidate ? ['d4c18a4', '76992b2'] : ['d4c18a4', '152bfce'],
    importedDesktopPasswordSource: unifiedCandidate ? '01a06308da0006b59c1427f3e01cc984190d33a9' : null,
    rawInputCandidate, unifiedCandidate, sourceHead: process.env.COVE_CANDIDATE_SOURCE_HEAD ?? null,
    installer: { path: installer, size: fs.statSync(installer).size, sha256: await fingerprint(installer), sha512: metadata.files[0].sha512 },
    rollback: { path: rollback, size: fs.statSync(rollback).size, version: '2.0.0', sha256: rollbackSha256,
      source: 'https://github.com/LumineTraveller/Cove/releases/download/v2.0.0/Cove-Setup-2.0.0.exe', publishedDigestMatched: true },
    installerPayloadMatchedUnpacked: payload, packedProductionNativeNoopStopPassed: true,
    liveVersionPolicy: { url: 'http://39.106.95.59:3001/api/version', requestedVersion: '2.0.1', requestedPlatform: 'desktop',
      requestedProtocol: 3, observedAt: fs.statSync(liveFile).mtime.toISOString(), policy },
    packagedSmoke: smoke, installed: false, published: false, serverChanged: false, mobileChanged: false };
  fs.writeFileSync(path.join(root, unifiedCandidate ? 'runtime/remote-input-unified-artifact.json' : rawInputCandidate ? 'runtime/remote-input-raw-artifact.json' : 'runtime/remote-input-2.0.1-artifact.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ verifiedAt: report.verifiedAt, installer: report.installer, rollback: report.rollback,
    payloadEntriesMatched: payload.length, liveVersionAccepted: true, packagedStartupAndRevokePassed: true }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
