const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { createGiteeInstallerCache } = require('../dist-electron/gitee-installer-cache.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-gitee-cache-test-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^cove-gitee-cache-test-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const cache = path.join(root, 'cove-client-updater');
  const pending = path.join(cache, 'pending');
  fs.mkdirSync(pending, { recursive: true });
  const version = '0.8.3';
  const fileName = `Cove-Setup-${version}.exe`;
  const contents = Buffer.from('verified installer fixture');
  const sha512 = createHash('sha512').update(contents).digest('base64');
  const metadata = { fileName, sha512 };
  fs.writeFileSync(path.join(pending, fileName), contents);
  fs.writeFileSync(path.join(pending, 'update-info.json'), JSON.stringify(metadata));
  fs.writeFileSync(path.join(cache, 'installer.exe'), contents);
  fs.writeFileSync(path.join(cache, 'current.blockmap'), 'block map');
  fs.writeFileSync(path.join(pending, 'current.blockmap'), 'block map');
  const logs = [];
  const logger = { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) };
  const create = (installedVersion = version, delay = async () => {}) => createGiteeInstallerCache({
    localAppData: root, installedVersion, logger, delay,
  });
  const info = { version, downloadedFile: path.join(pending, fileName) };
  const exists = relative => fs.existsSync(path.join(cache, relative));
  return { root, cache, pending, version, fileName, contents, metadata, info, create, exists, logs };
}

test('Gitee download is retained until the new version runs, then both installer copies are removed', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.pending, 'unrelated.txt'), 'keep');
  fs.writeFileSync(path.join(f.root, 'manual-setup.exe'), 'keep');
  const oldApp = f.create('0.8.2');
  oldApp.remember(f.info, 'gitee');
  assert.equal(f.exists(`pending/${f.fileName}`), true, 'download completion must not remove the installer');
  await oldApp.cleanupInstalledUpdate();
  assert.equal(f.exists(`pending/${f.fileName}`), true, 'failed installation / old-version restart must preserve the file');
  await f.create().cleanupInstalledUpdate();
  for (const file of [`pending/${f.fileName}`, 'installer.exe', 'current.blockmap', 'pending/current.blockmap', 'pending/update-info.json', 'pending/cove-gitee-cleanup.json']) {
    assert.equal(f.exists(file), false, file);
  }
  assert.equal(f.exists('pending/unrelated.txt'), true);
  assert.equal(fs.existsSync(path.join(f.root, 'manual-setup.exe')), true);
  await f.create().cleanupInstalledUpdate(); // idempotent
});

test('GitHub installs and unmarked caches remain untouched', async t => {
  const f = fixture(t);
  const manager = f.create();
  manager.remember(f.info, 'github');
  await manager.cleanupInstalledUpdate();
  assert.equal(f.exists('pending/cove-gitee-cleanup.json'), false);
  assert.equal(f.exists(`pending/${f.fileName}`), true);
  assert.equal(f.exists('installer.exe'), true);
});

test('an unrelated differential baseline is not removed with the Gitee installer', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cache, 'installer.exe'), 'different GitHub baseline');
  const manager = f.create();
  manager.remember(f.info, 'gitee');
  await manager.cleanupInstalledUpdate();
  assert.equal(f.exists(`pending/${f.fileName}`), false);
  assert.equal(f.exists('installer.exe'), true);
  assert.equal(f.exists('current.blockmap'), true);
});

test('newer pending metadata and changed installer content prevent cleanup', async t => {
  const f = fixture(t);
  const manager = f.create();
  manager.remember(f.info, 'gitee');
  fs.writeFileSync(path.join(f.pending, 'update-info.json'), JSON.stringify({ ...f.metadata, fileName: 'Cove-Setup-0.8.4.exe' }));
  await manager.cleanupInstalledUpdate();
  assert.equal(f.exists(`pending/${f.fileName}`), true);
  fs.writeFileSync(path.join(f.pending, 'update-info.json'), JSON.stringify(f.metadata));
  fs.writeFileSync(f.info.downloadedFile, 'changed after verification');
  await manager.cleanupInstalledUpdate();
  assert.equal(f.exists(`pending/${f.fileName}`), true);
  assert.equal(f.exists('pending/cove-gitee-cleanup.json'), true);
});

test('out-of-cache downloaded paths and malicious cleanup filenames are ignored', async t => {
  const f = fixture(t);
  const manager = f.create();
  manager.remember({ ...f.info, downloadedFile: path.join(f.root, f.fileName) }, 'gitee');
  assert.equal(f.exists('pending/cove-gitee-cleanup.json'), false);
  manager.remember(f.info, 'gitee');
  const markerPath = path.join(f.pending, 'cove-gitee-cleanup.json');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  fs.writeFileSync(markerPath, JSON.stringify({ ...marker, fileName: '../../victim.exe' }));
  await manager.cleanupInstalledUpdate();
  assert.equal(f.exists(`pending/${f.fileName}`), true);
  fs.writeFileSync(markerPath, '{broken');
  await assert.doesNotReject(manager.cleanupInstalledUpdate());
  assert.equal(f.exists('installer.exe'), true);
});

test('redirected cache directories are never cleaned', async t => {
  const f = fixture(t);
  const manager = f.create();
  manager.remember(f.info, 'gitee');
  const outside = path.join(f.root, 'outside-pending');
  fs.renameSync(f.pending, outside);
  fs.symlinkSync(outside, f.pending, process.platform === 'win32' ? 'junction' : 'dir');
  await manager.cleanupInstalledUpdate();
  assert.equal(fs.existsSync(path.join(outside, f.fileName)), true);
  assert.equal(f.exists('installer.exe'), true);
});

test('linked installer files are not eligible for cleanup', async t => {
  const f = fixture(t);
  const manager = f.create();
  manager.remember(f.info, 'gitee');
  const otherLink = path.join(f.root, 'manual-download.exe');
  fs.linkSync(f.info.downloadedFile, otherLink);
  await manager.cleanupInstalledUpdate();
  assert.equal(f.exists(`pending/${f.fileName}`), true);
  assert.equal(fs.existsSync(otherLink), true);
  assert.equal(f.exists('pending/cove-gitee-cleanup.json'), true);
});

test('a briefly locked installer is retried; permanent failure preserves the marker', async t => {
  const f = fixture(t);
  let retries = 0;
  const manager = f.create(f.version, async () => { retries++; });
  manager.remember(f.info, 'gitee');
  const originalUnlink = fs.unlinkSync;
  let locks = 1;
  const mock = t.mock.method(fs, 'unlinkSync', file => {
    if (file === f.info.downloadedFile && locks-- > 0) throw Object.assign(new Error('installer still running'), { code: 'EBUSY' });
    return originalUnlink(file);
  });
  try {
    await manager.cleanupInstalledUpdate();
    assert.equal(retries, 1);
    assert.equal(f.exists(`pending/${f.fileName}`), false);
    fs.writeFileSync(f.info.downloadedFile, f.contents);
    fs.writeFileSync(path.join(f.pending, 'update-info.json'), JSON.stringify(f.metadata));
    manager.remember(f.info, 'gitee');
    locks = 10;
    await manager.cleanupInstalledUpdate();
    assert.equal(f.exists(`pending/${f.fileName}`), true);
    assert.equal(f.exists('pending/cove-gitee-cleanup.json'), true);
  } finally { mock.mock.restore(); }
});
