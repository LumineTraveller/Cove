const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { prepareDifferentialBaseline, stageNextBaseline } = require('../dist-electron/differential-baseline.js');
const { acquireUpdateCacheLock } = require('../dist-electron/update-cache-safety.js');

const sha512 = data => createHash('sha512').update(data).digest('base64');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-baseline-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^cove-baseline-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const contents = Buffer.from('AAAABBBBCCCC');
  const blockmap = gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0,
    checksums: ['a', 'b', 'c'], sizes: [4, 4, 4] }] }));
  const version = '2.1.1';
  const record = { schema: 1, version, sha512: sha512(contents), size: contents.length };
  fs.mkdirSync(path.join(root, 'pending'));
  fs.writeFileSync(path.join(root, 'installer.exe'), contents);
  fs.writeFileSync(path.join(root, 'current.blockmap'), blockmap);
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  let recovery = 0;
  let maps = 0;
  const prepare = overrides => prepareDifferentialBaseline({ cacheDir: root, installedVersion: version,
    installerFileName: 'installer.exe', recoverIdentity: async () => { recovery++; return record; },
    downloadOldBlockmap: async () => { maps++; return blockmap; }, ...overrides });
  return { root, version, contents, blockmap, record, write, prepare, get recovery() { return recovery; }, get maps() { return maps; } };
}

test('verified local baseline avoids manifest and blockmap network recovery', async t => {
  const f = fixture(t);
  f.write('cove-baseline.json', { ...f.record, blockmapSha512: sha512(f.blockmap) });
  await f.prepare();
  assert.equal(f.recovery, 0);
  assert.equal(f.maps, 0);
});

test('exact installed-version pending metadata bootstraps EXE identity but not an unbound root map', async t => {
  const f = fixture(t);
  f.write('pending/update-info.json', { fileName: `Cove-Setup-${f.version}.exe`, sha512: f.record.sha512 });
  fs.writeFileSync(path.join(f.root, 'current.blockmap'), 'a newer version map from the old updater');
  await f.prepare();
  assert.equal(f.recovery, 0);
  assert.equal(f.maps, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'current.blockmap')), f.blockmap);
});

test('missing or newer-version identity uses bounded caller recovery rather than guessing', async t => {
  const f = fixture(t);
  f.write('pending/update-info.json', { fileName: 'Cove-Setup-2.1.2.exe', sha512: f.record.sha512 });
  await f.prepare();
  assert.equal(f.recovery, 1);
  assert.equal(f.maps, 1);
});

test('missing, corrupted and changed installers never enter differential reconstruction', async t => {
  const f = fixture(t);
  f.write('cove-baseline.json', f.record);
  fs.writeFileSync(path.join(f.root, 'installer.exe'), 'AAAABBBBZZZZ');
  await assert.rejects(f.prepare(), { code: 'COVE_BASELINE_MISMATCH' });
  assert.equal(f.maps, 0);
  fs.unlinkSync(path.join(f.root, 'installer.exe'));
  await assert.rejects(f.prepare(), { code: 'ENOENT' });
  fs.writeFileSync(path.join(f.root, 'installer.exe'), f.contents);
  await assert.rejects(f.prepare({ downloadOldBlockmap: async () => {
    fs.writeFileSync(path.join(f.root, 'installer.exe'), 'AAAABBBBZZZZ');
    return f.blockmap;
  } }), { code: 'COVE_BASELINE_CHANGED' });
});

test('next map is staged without replacing the installed map and promoted only with matching version and EXE', async t => {
  const f = fixture(t);
  f.write('cove-baseline.json', { ...f.record, blockmapSha512: sha512(f.blockmap) });
  const nextContents = Buffer.from('AAAAXXXXCCCC');
  const nextMap = gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0,
    checksums: ['a', 'x', 'c'], sizes: [4, 4, 4] }] }));
  const nextRecord = { schema: 1, version: '2.1.2', sha512: sha512(nextContents), size: nextContents.length };
  fs.writeFileSync(path.join(f.root, 'pending/current.blockmap'), nextMap);
  stageNextBaseline(f.root, nextRecord);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'current.blockmap')), f.blockmap);
  assert.equal(fs.existsSync(path.join(f.root, 'pending/current.blockmap')), false);
  await assert.rejects(f.prepare({ installedVersion: '2.1.2' }), { code: 'COVE_BASELINE_MISMATCH' });
  fs.writeFileSync(path.join(f.root, 'installer.exe'), nextContents);
  await f.prepare({ installedVersion: '2.1.2' });
  assert.equal(f.recovery, 0);
  assert.equal(f.maps, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'current.blockmap')), nextMap);
});

test('corrupt map is fetched again; invalid map or cancellation leaves existing baseline intact', async t => {
  const f = fixture(t);
  f.write('cove-baseline.json', { ...f.record, blockmapSha512: sha512(f.blockmap) });
  fs.writeFileSync(path.join(f.root, 'current.blockmap'), 'corrupt');
  await f.prepare();
  assert.equal(f.maps, 1);
  await assert.rejects(f.prepare({ checkCancelled: () => { throw new Error('cancelled'); } }), /cancelled/);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'installer.exe')), f.contents);
  f.write('cove-baseline.json', f.record);
  await assert.rejects(f.prepare({ downloadOldBlockmap: async () => gzipSync(JSON.stringify({ version: '2', files: [] })) }));
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'current.blockmap')), f.blockmap);
});

test('linked baseline and redirected cache directories are rejected', async t => {
  const f = fixture(t);
  fs.linkSync(path.join(f.root, 'installer.exe'), path.join(f.root, 'linked.exe'));
  await assert.rejects(f.prepare(), { code: 'COVE_CACHE_UNSAFE' });
  fs.unlinkSync(path.join(f.root, 'linked.exe'));
  const redirect = path.join(f.root, 'redirect');
  fs.symlinkSync(f.root, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.prepare({ cacheDir: redirect }), { code: 'COVE_CACHE_UNSAFE' });
});

test('kernel cache lock rejects simultaneous owners and repeated release cannot unlock a new owner', async t => {
  const f = fixture(t);
  const release = await acquireUpdateCacheLock(f.root);
  await assert.rejects(acquireUpdateCacheLock(f.root), { code: 'COVE_CACHE_BUSY' });
  await release();
  const again = await acquireUpdateCacheLock(f.root);
  await release();
  await assert.rejects(acquireUpdateCacheLock(f.root), { code: 'COVE_CACHE_BUSY' });
  await again();
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(acquireUpdateCacheLock(f.root, cancelled.signal), { code: 'COVE_UPDATE_CANCELLED' });
  const inFlight = new AbortController();
  const acquiring = acquireUpdateCacheLock(f.root, inFlight.signal);
  inFlight.abort();
  await assert.rejects(acquiring, { code: 'COVE_UPDATE_CANCELLED' });
  await new Promise(resolve => setImmediate(resolve));
  const afterCancel = await acquireUpdateCacheLock(f.root);
  await afterCancel();
});

test('a real updater process excludes competitors and a crash releases the kernel lock', { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const modulePath = require.resolve('../dist-electron/update-cache-safety.js');
  const script = `const {acquireUpdateCacheLock}=require(process.argv[1]);
    acquireUpdateCacheLock(process.argv[2]).then(()=>{process.stdout.write('locked\\n');setInterval(()=>{},1000);})
    .catch(()=>process.exit(2));`;
  const child = spawn(process.execPath, ['-e', script, modulePath, f.root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Child did not acquire IPC lock')), 5_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.once('data', bytes => { clearTimeout(timer); assert.match(bytes.toString(), /locked/); resolve(); });
    child.once('exit', code => { clearTimeout(timer); if (code !== null) reject(new Error(`Child exited ${code}`)); });
  });
  await assert.rejects(acquireUpdateCacheLock(f.root), { code: 'COVE_CACHE_BUSY' });
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  const release = await acquireUpdateCacheLock(f.root);
  await release();
});
