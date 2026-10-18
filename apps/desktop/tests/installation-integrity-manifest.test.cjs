'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const afterSign = require('../tools/generate-installation-integrity.cjs');
const { generateInstallationIntegrity, assertSafeRelativePath, EMBEDDED_MANIFEST_PATH } = afterSign;

function pe(machine = 0x8664) {
  const result = Buffer.alloc(256);
  result.write('MZ');
  result.writeUInt32LE(0x80, 0x3c);
  result.write('PE\0\0', 0x80);
  result.writeUInt16LE(machine, 0x84);
  return result;
}

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-integrity-manifest-test-'));
  const root = path.join(temp, 'payload');
  const output = path.join(temp, 'output');
  fs.mkdirSync(root);
  fs.mkdirSync(output);
  t.after(() => {
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), fs.realpathSync.native(temp));
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    assert.match(path.basename(temp), /^cove-integrity-manifest-test-/);
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const write = (relative, content = relative) => {
    const destination = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  };
  write('Cove.exe', pe());
  for (const file of [
    'ffmpeg.dll', 'icudtl.dat', 'resources.pak', 'version', 'locales/en-US.pak',
    'resources/app.asar', 'resources/app-update.yml', 'resources/default_app.asar',
    'resources/annotation-window-helper.exe', 'resources/remote-input-helper.exe',
    'resources/application-audio-helper.exe', 'resources/elevate.exe',
    'resources/app.asar.unpacked/node_modules/loopback-capture/build/Release/capture.node',
  ]) write(file);
  const options = { appOutDir: root, outputDir: output, version: '2.0.3', platform: 'win32', arch: 'x64' };
  return { root, output, write, options };
}

test('inventories final Electron, app.asar, helpers and unpacked native packages with exact identity', async t => {
  const { root, options } = fixture(t);
  const result = await generateInstallationIntegrity(options);
  assert.deepEqual(Object.keys(result.manifest), ['schemaVersion', 'version', 'platform', 'arch', 'files']);
  assert.equal(result.manifest.schemaVersion, 1);
  assert.equal(result.manifest.version, '2.0.3');
  assert.equal(result.manifest.platform, 'win32');
  assert.equal(result.manifest.arch, 'x64');
  assert.equal(path.basename(result.assetPath), 'Cove-Integrity-2.0.3-win32-x64.json');
  assert.equal(result.embeddedPath, path.join(root, 'resources', 'cove-integrity.json'));
  assert.deepEqual(fs.readFileSync(result.assetPath), fs.readFileSync(result.embeddedPath));
  assert.ok(result.manifest.files.some(file => file.path.endsWith('capture.node')));
  assert.ok(result.manifest.files.some(file => file.path === 'resources/elevate.exe'));
  assert.deepEqual(result.manifest.files.map(file => file.path), result.manifest.files.map(file => file.path).sort());
  for (const file of result.manifest.files) {
    assert.deepEqual(Object.keys(file), ['path', 'size', 'sha256']);
    const bytes = fs.readFileSync(path.join(root, ...file.path.split('/')));
    assert.equal(file.size, bytes.length);
    assert.equal(file.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(file.path.includes('\\'), false);
  }
});

test('never self-hashes or includes user data, voice packs, caches, uninstallers or shortcuts', async t => {
  const { write, options } = fixture(t);
  for (const file of [
    EMBEDDED_MANIFEST_PATH, '.cove/accounts.json', 'userData/settings.json',
    'Cache/data', 'soundpacks/user-voice.wav', 'resources/userData/chats.db',
    'Uninstall Cove.exe', 'Cove.lnk', 'accounts.json', 'settings.json', 'chat.db',
  ]) write(file, 'PRIVATE DO NOT HASH');
  const first = await generateInstallationIntegrity(options);
  assert.equal(first.manifest.files.length, 14);
  assert.ok(first.manifest.files.every(file => file.path !== EMBEDDED_MANIFEST_PATH));
  const second = await generateInstallationIntegrity(options);
  assert.deepEqual(first.manifest, second.manifest);
});

test('refuses unexpected root/resource files that could contain personal data', async t => {
  const { root, write, options } = fixture(t);
  write('personal.txt', 'PRIVATE');
  await assert.rejects(generateInstallationIntegrity(options), /possible user data/);
  fs.unlinkSync(path.join(root, 'personal.txt'));
  write('resources/private.json', 'PRIVATE');
  await assert.rejects(generateInstallationIntegrity(options), /possible user data/);
});

test('retains version code in unpacked dependencies whose names resemble caches', async t => {
  const { write, options } = fixture(t);
  write('resources/app.asar.unpacked/node_modules/cache/index.js', 'version code');
  const { manifest } = await generateInstallationIntegrity(options);
  assert.ok(manifest.files.some(file => file.path.endsWith('/cache/index.js')));
});

test('refuses unsupported platform/architecture, mislabeled PE architecture and malformed version', async t => {
  const { write, options } = fixture(t);
  for (const changed of [{ platform: 'darwin' }, { arch: 'arm64' }, { arch: 'ia32' }, { version: '../2.0.3' }]) {
    await assert.rejects(generateInstallationIntegrity({ ...options, ...changed }), /only win32\/x64|exact official/);
  }
  write('Cove.exe', pe(0xaa64));
  await assert.rejects(generateInstallationIntegrity(options), /Windows x64/);
});

test('refuses missing mandatory helpers instead of describing a partial release', async t => {
  const { root, options } = fixture(t);
  fs.unlinkSync(path.join(root, 'resources', 'application-audio-helper.exe'));
  await assert.rejects(generateInstallationIntegrity(options), /Missing required version payload/);
});

test('rejects traversal, alternate streams, ambiguous Windows names and unnormalized paths', () => {
  for (const value of ['', '..', '../Cove.exe', '/Cove.exe', 'a/../b', 'a\\b', 'C:/Cove.exe',
    'a//b', 'a./b', 'a /b', 'CON', 'nul.txt', 'LPT1.log', 'CONIN$', 'CONOUT$', 'COM\u00b9', 'LPT\u00b9',
    'resources/app.asar:stream', 'a/\u0000b', 'e\u0301', 'a'.repeat(256), `${'a'.repeat(254)}/`.repeat(5)]) {
    assert.throws(() => assertSafeRelativePath(value), /Unsafe installation path/);
  }
  assert.equal(assertSafeRelativePath('resources/app.asar.unpacked/node_modules/@scope/native.node'),
    'resources/app.asar.unpacked/node_modules/@scope/native.node');
});

test('rejects case-fold duplicates before reading the second entry', async t => {
  const { root, options } = fixture(t);
  const original = fs.readdirSync;
  fs.readdirSync = function (directory, ...args) {
    const values = original.call(this, directory, ...args);
    return directory === root ? ['Cove.exe', 'COVE.EXE', ...values.filter(value => value !== 'Cove.exe')] : values;
  };
  try {
    await assert.rejects(generateInstallationIntegrity(options), /Duplicate case-insensitive/);
  } finally {
    fs.readdirSync = original;
  }
});

test('rejects junctions/symbolic links, including excluded data paths', async t => {
  const { root, output, options } = fixture(t);
  const linked = path.join(root, 'userData');
  fs.symlinkSync(output, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(generateInstallationIntegrity(options), /Symbolic links and junctions/);
});

test('rejects a linked payload root and output inside the payload', async t => {
  const { root, output, options } = fixture(t);
  await assert.rejects(generateInstallationIntegrity({ ...options, outputDir: path.join(root, 'resources') }), /outside/);
  const linked = path.join(output, 'linked-payload');
  fs.symlinkSync(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(generateInstallationIntegrity({ ...options, appOutDir: linked }), /Symbolic links and junctions/);
});

test('afterSign prepares the same memoized NSIS elevate helper before hashing', async t => {
  const { root, output, options } = fixture(t);
  const elevated = path.join(root, 'resources', 'elevate.exe');
  fs.unlinkSync(elevated);
  let prepared = false;
  const helper = { async copy(appOutDir) {
    assert.equal(appOutDir, root);
    if (!prepared) fs.writeFileSync(elevated, 'final signed NSIS elevate helper');
    prepared = true;
  } };
  const target = { name: 'nsis', packageHelper: { elevateHelper: helper } };
  await afterSign({ appOutDir: root, outDir: output, electronPlatformName: 'win32', arch: 1,
    packager: { appInfo: { version: options.version } }, targets: [target] });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'cove-integrity.json'), 'utf8'));
  const record = manifest.files.find(file => file.path === 'resources/elevate.exe');
  await helper.copy(root, target); // NSIS packArch's later call preserves the hashed bytes.
  assert.equal(record.sha256, crypto.createHash('sha256').update(fs.readFileSync(elevated)).digest('hex'));
});

test('afterSign fails closed for a changed NSIS contract or wrong architecture', async () => {
  await assert.rejects(afterSign({ electronPlatformName: 'win32', arch: 3 }), /only win32\/x64/);
  await assert.rejects(afterSign({ electronPlatformName: 'win32', arch: 1, targets: [{ name: 'nsis' }] }), /supported electron-builder NSIS/);
  await afterSign({ electronPlatformName: 'darwin' });
});

test('afterSign rejects a linked resources directory before NSIS can write through it', async t => {
  const { root, output, options } = fixture(t);
  const resources = path.join(root, 'resources');
  assert.equal(path.relative(root, resources), 'resources');
  fs.rmSync(resources, { recursive: true });
  fs.symlinkSync(output, resources, process.platform === 'win32' ? 'junction' : 'dir');
  let copies = 0;
  await assert.rejects(afterSign({ appOutDir: root, outDir: output, electronPlatformName: 'win32', arch: 1,
    packager: { appInfo: { version: options.version } },
    targets: [{ name: 'nsis', packageHelper: { elevateHelper: { async copy() { copies += 1; } } } }],
  }), /Symbolic links and junctions/);
  assert.equal(copies, 0);
});

test('afterSign rejects a linked elevate destination before invoking the NSIS copy helper', async t => {
  const { root, output, options } = fixture(t);
  const elevate = path.join(root, 'resources', 'elevate.exe');
  fs.unlinkSync(elevate);
  fs.symlinkSync(output, elevate, process.platform === 'win32' ? 'junction' : 'dir');
  let copies = 0;
  await assert.rejects(afterSign({ appOutDir: root, outDir: output, electronPlatformName: 'win32', arch: 1,
    packager: { appInfo: { version: options.version } },
    targets: [{ name: 'nsis', packageHelper: { elevateHelper: { async copy() { copies += 1; } } } }],
  }), /Symbolic links and junctions/);
  assert.equal(copies, 0);
});

test('rejects hard-linked manifest destinations without modifying the external file', async t => {
  const { root, output, options } = fixture(t);
  const sentinel = path.join(path.dirname(root), 'external-sentinel');
  fs.writeFileSync(sentinel, 'EXTERNAL PRIVATE FILE');
  const embedded = path.join(root, 'resources', 'cove-integrity.json');
  fs.linkSync(sentinel, embedded);
  await assert.rejects(generateInstallationIntegrity(options), /Hard links are forbidden/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'EXTERNAL PRIVATE FILE');
  fs.unlinkSync(embedded);
  const asset = path.join(output, 'Cove-Integrity-2.0.3-win32-x64.json');
  fs.linkSync(sentinel, asset);
  await assert.rejects(generateInstallationIntegrity(options), /Hard links are forbidden/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'EXTERNAL PRIVATE FILE');
});

test('rejects hard-linked version payloads instead of inventorying external data', async t => {
  const { root, options } = fixture(t);
  const sentinel = path.join(path.dirname(root), 'external-sentinel');
  fs.writeFileSync(sentinel, 'EXTERNAL PRIVATE FILE');
  const runtime = path.join(root, 'ffmpeg.dll');
  fs.unlinkSync(runtime);
  fs.linkSync(sentinel, runtime);
  await assert.rejects(generateInstallationIntegrity(options), /Hard links are forbidden/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'EXTERNAL PRIVATE FILE');
  assert.equal(fs.existsSync(path.join(root, 'resources', 'cove-integrity.json')), false);
});

test('afterSign rejects a hard-linked elevate destination before invoking the NSIS helper', async t => {
  const { root, output, options } = fixture(t);
  const sentinel = path.join(path.dirname(root), 'external-sentinel');
  fs.writeFileSync(sentinel, 'EXTERNAL PRIVATE FILE');
  const elevate = path.join(root, 'resources', 'elevate.exe');
  fs.unlinkSync(elevate);
  fs.linkSync(sentinel, elevate);
  let copies = 0;
  await assert.rejects(afterSign({ appOutDir: root, outDir: output, electronPlatformName: 'win32', arch: 1,
    packager: { appInfo: { version: options.version } },
    targets: [{ name: 'nsis', packageHelper: { elevateHelper: { async copy() { copies += 1; } } } }],
  }), /Hard links are forbidden/);
  assert.equal(copies, 0);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'EXTERNAL PRIVATE FILE');
});
