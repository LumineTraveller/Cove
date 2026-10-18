import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createInstallationIntegrityController, type InstallationIntegrityOptions } from '../electron/installation-integrity';

const version = '2.0.2';
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const releaseUrl = `https://api.github.com/repos/LumineTraveller/Cove/releases/tags/v${version}`;
const assetUrl = (name: string) => `https://github.com/LumineTraveller/Cove/releases/download/v${version}/${name}`;
const manifestName = `Cove-Integrity-${version}-win32-x64.json`;
const installerName = `Cove-Setup-${version}.exe`;
const installer = Buffer.from('an inert installer fixture, never executed');
const response = (data: string | Buffer, headers?: Record<string, string>) => new Response(data, { status: 200, headers });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('expected fixture operation did not reach its checkpoint');
}

function fixture(t: TestContext) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'cove-integrity-test-'));
  const installRoot = path.join(root, 'install');
  const userDataDir = path.join(root, 'userdata');
  const cacheRoot = path.join(root, 'repair-cache');
  fs.mkdirSync(path.join(installRoot, 'resources'), { recursive: true });
  fs.mkdirSync(userDataDir);
  const original = Buffer.from('managed executable fixture');
  fs.writeFileSync(path.join(installRoot, 'Cove.exe'), original);
  fs.writeFileSync(path.join(userDataDir, 'keep-private.txt'), 'must never change');
  const manifest: any = { schemaVersion: 1, version, platform: 'win32', arch: 'x64',
    files: [{ path: 'Cove.exe', size: original.length, sha256: sha(original) }] };
  let manifestBytes = Buffer.from(JSON.stringify(manifest));
  const asset = (name: string, data: Buffer, id: number) => ({ id, name, state: 'uploaded', size: data.length,
    digest: `sha256:${sha(data)}`, browser_download_url: assetUrl(name) });
  const release: any = { tag_name: `v${version}`, draft: false, prerelease: false,
    assets: [asset(manifestName, manifestBytes, 1), asset(installerName, installer, 2)] };
  const requests: string[] = [];
  const states: any[] = [];
  let openCount = 0;
  let quitCount = 0;
  const created: ReturnType<typeof createInstallationIntegrityController>[] = [];
  let override: ((url: string, init?: RequestInit) => Promise<Response | undefined>) | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    assert.equal(init?.redirect, 'manual');
    const replacement = await override?.(url, init);
    if (replacement) return replacement;
    if (url === releaseUrl) return response(JSON.stringify(release));
    if (url === assetUrl(manifestName)) return response(manifestBytes);
    if (url === assetUrl(installerName)) return response(installer);
    throw new Error('unexpected fixture URL');
  };
  function setManifest(value: any) {
    manifestBytes = Buffer.from(JSON.stringify(value));
    const index = release.assets.findIndex((item: any) => item.name === manifestName);
    release.assets[index] = asset(manifestName, manifestBytes, 1);
  }
  function create(extra: Partial<InstallationIntegrityOptions> = {}) {
    const controller = createInstallationIntegrityController({ isPackaged: true, platform: 'win32', arch: 'x64', version,
      installRoot, userDataDir, cacheRoot, fetchImpl, publishState: state => states.push(state),
      isExternalBusy: () => false, confirmInstall: async () => true, markDownloadedFile: async () => {}, verifyDownloadedFile: () => true,
      openInstaller: async file => { assert.equal(path.extname(file), '.exe'); openCount++; return true; },
      quit: () => { quitCount++; }, ...extra });
    created.push(controller);
    return controller;
  }
  const cachedFile = () => path.join(cacheRoot, fs.readdirSync(cacheRoot).find(name => name.startsWith('repair-'))!, installerName);
  t.after(() => {
    for (const controller of created) controller.dispose();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.match(path.basename(resolved), /^cove-integrity-test-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, installRoot, userDataDir, cacheRoot, original, manifest, release, requests, states, create, setManifest, cachedFile,
    intercept: (handler: typeof override) => { override = handler; }, opens: () => openCount, quits: () => quitCount };
}

test('development, other operating systems and architectures never inspect or download', async t => {
  const f = fixture(t);
  for (const options of [{ isPackaged: false }, { platform: 'linux' }, { arch: 'arm64' }, { version: '2.0.2-beta' }]) {
    const controller = f.create(options);
    assert.equal((await controller.checkNow()).status, 'disabled');
    assert.equal((await controller.downloadRepair()).status, 'disabled');
    assert.equal(await controller.launchRepair(), false);
  }
  assert.deepEqual(f.requests, []);
});

test('official exact-version manifest checks only listed files and publishes detached relative details', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.installRoot, 'unlisted.bin'), 'unrelated');
  const controller = f.create();
  const state = await controller.checkNow();
  assert.equal(state.status, 'healthy');
  assert.equal(state.checkedFiles, 1);
  assert.equal(state.repairAvailable, true);
  assert.deepEqual(f.requests, [releaseUrl, assetUrl(manifestName)]);
  state.issues!.push({ path: 'fake', kind: 'missing' });
  assert.deepEqual(controller.getState().issues, []);
  assert.equal(JSON.stringify(f.states).includes(f.root), false);
  assert.equal(JSON.stringify(f.states).includes('https:'), false);
  assert.equal(fs.readFileSync(path.join(f.userDataDir, 'keep-private.txt'), 'utf8'), 'must never change');
});

test('Windows short directory spellings canonicalize without relaxing link or profile isolation', async t => {
  const f = fixture(t);
  const alias = `${f.root}-short-spelling`;
  const remap = (file: fs.PathLike) => typeof file === 'string' && (file === alias || file.startsWith(alias + path.sep))
    ? f.root + file.slice(alias.length) : file;
  const lstat = fs.lstatSync;
  const realpath = fs.realpathSync.native;
  t.mock.method(fs, 'lstatSync', (file: fs.PathLike, options: any) => lstat(remap(file), options));
  t.mock.method(fs.realpathSync, 'native', (file: fs.PathLike, options: any) => realpath(remap(file), options));
  const controller = f.create({ installRoot: path.join(alias, 'install'), userDataDir: path.join(alias, 'userdata'),
    cacheRoot: path.join(alias, 'repair-cache'), confirmInstall: async () => false });
  assert.equal((await controller.checkNow()).status, 'healthy');
  assert.equal((await controller.downloadRepair()).status, 'downloaded');
  assert.equal(await controller.launchRepair(), false);
  assert.equal(f.opens(), 0);
  const forbidden = f.create({ cacheRoot: path.join(alias, 'userdata', 'repair') });
  assert.equal((await forbidden.downloadRepair()).errorCode, 'UNSAFE_PATH');
  assert.equal(fs.existsSync(path.join(f.userDataDir, 'repair')), false);
  assert.equal(fs.readFileSync(path.join(f.userDataDir, 'keep-private.txt'), 'utf8'), 'must never change');
});

test('canonical directory spelling never legitimizes a junction used as the installation root', async t => {
  const f = fixture(t);
  const linked = path.join(f.root, 'linked-install');
  fs.symlinkSync(f.installRoot, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const controller = f.create({ installRoot: linked });
  assert.equal((await controller.checkNow()).errorCode, 'UNSAFE_PATH');
  assert.equal((await controller.downloadRepair()).errorCode, 'UNSAFE_INSTALL_PATH');
  assert.equal(f.requests.includes(assetUrl(installerName)), false);
});

test('missing and modified managed files remain distinct', async t => {
  const f = fixture(t);
  f.setManifest({ ...f.manifest, files: [...f.manifest.files, { path: 'resources/missing.asar', size: 3, sha256: sha('abc') }] });
  fs.writeFileSync(path.join(f.installRoot, 'Cove.exe'), 'modified');
  const state = await f.create().checkNow();
  assert.equal(state.status, 'damaged');
  assert.deepEqual(state.issues, [{ path: 'Cove.exe', kind: 'modified' }, { path: 'resources/missing.asar', kind: 'missing' }]);
});

test('permission failures cannot be reported as damage or health', async t => {
  const f = fixture(t);
  const promises = require('node:fs/promises');
  const originalOpen = promises.open;
  t.mock.method(promises, 'open', async (file: string, ...args: any[]) => {
    if (file === path.join(f.installRoot, 'Cove.exe')) throw Object.assign(new Error('private path'), { code: 'EACCES' });
    return originalOpen(file, ...args);
  });
  const state = await f.create().checkNow();
  assert.equal(state.status, 'unavailable');
  assert.equal(state.errorCode, 'UNREADABLE_FILES');
  assert.deepEqual(state.issues, [{ path: 'Cove.exe', kind: 'unreadable' }]);
});

test('hard links and directory junctions into user data are unsafe, with no user data changes', async t => {
  const f = fixture(t);
  const linked = path.join(f.installRoot, 'linked.exe');
  fs.linkSync(path.join(f.installRoot, 'Cove.exe'), linked);
  fs.symlinkSync(f.userDataDir, path.join(f.installRoot, 'private'), 'junction');
  f.setManifest({ ...f.manifest, files: [
    { path: 'linked.exe', size: f.original.length, sha256: sha(f.original) },
    { path: 'private/keep-private.txt', size: 17, sha256: sha('must never change') },
  ] });
  const state = await f.create().checkNow();
  assert.equal(state.status, 'damaged');
  assert.deepEqual(state.issues?.map(issue => issue.kind), ['unsafe', 'unsafe']);
  assert.equal(state.repairAvailable, false);
  assert.equal(fs.readFileSync(path.join(f.userDataDir, 'keep-private.txt'), 'utf8'), 'must never change');
});

test('file replacement between lstat and open is detected', async t => {
  const f = fixture(t);
  const promises = require('node:fs/promises');
  const originalOpen = promises.open;
  let replaced = false;
  t.mock.method(promises, 'open', async (file: string, ...args: any[]) => {
    const handle = await originalOpen(file, ...args);
    if (!replaced && file === path.join(f.installRoot, 'Cove.exe')) {
      replaced = true;
      fs.renameSync(file, `${file}.old`);
      fs.writeFileSync(file, f.original);
    }
    return handle;
  });
  const state = await f.create().checkNow();
  assert.equal(state.status, 'damaged');
  assert.equal(state.issues?.[0].kind, 'unsafe');
});

test('manifest traversal, Windows aliases, ADS, self-reference and duplicate case are rejected before scanning', async t => {
  const f = fixture(t);
  const invalid = ['../userdata/keep-private.txt', '/absolute', 'C:/Windows/test', 'resources\\app.asar',
    'Cove.exe:Zone.Identifier', 'CON', 'COM1.txt', 'LPT¹.txt', 'CONIN$', 'CONOUT$', 'trailing.', 'folder /test',
    'resources//file', 'resources/./file', 'resources/cove-integrity.json', 'sessions/token.json', 'runtime/dev-data',
    'userData/secret', 'Logs/private', 'Cache/database', 'Local Storage/secret', '.aws/credentials',
    'resources/sessions/token.json', 'resources/accounts.json', 'resources/app.asar.unpacked/userData/token',
    'account.sqlite', 'settings.json', '.env', 'Uninstall Cove.exe'];
  for (const name of invalid) {
    f.setManifest({ ...f.manifest, files: [{ path: name, size: 0, sha256: sha('') }] });
    const state = await f.create().checkNow();
    assert.equal(state.status, 'unavailable', name);
    assert.equal(state.errorCode, 'INVALID_MANIFEST', name);
    assert.equal(state.checkedFiles, undefined, name);
  }
  f.setManifest({ ...f.manifest, files: [f.manifest.files[0], { ...f.manifest.files[0], path: 'cove.EXE' }] });
  assert.equal((await f.create().checkNow()).errorCode, 'INVALID_MANIFEST');
});

test('manifest schema, version, architecture and advertised digest are mandatory', async t => {
  const f = fixture(t);
  for (const extra of [{ schemaVersion: 2 }, { version: '9.9.9' }, { arch: 'arm64' }, { platform: 'linux' }]) {
    f.setManifest({ ...f.manifest, ...extra });
    assert.equal((await f.create().checkNow()).errorCode, 'INVALID_MANIFEST');
  }
  f.setManifest(f.manifest);
  f.release.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  assert.equal((await f.create().checkNow()).errorCode, 'MANIFEST_DIGEST_MISMATCH');
});

test('official release state, tag, exact asset URL, size and API SHA-256 are mandatory', async t => {
  const f = fixture(t);
  const initial = JSON.stringify(f.release);
  const mutations = [
    (r: any) => { r.tag_name = 'v9.9.9'; }, (r: any) => { r.draft = true; }, (r: any) => { r.prerelease = true; },
    (r: any) => { r.assets[0].state = 'new'; }, (r: any) => { delete r.assets[0].digest; },
    (r: any) => { r.assets[0].size = 4 * 1024 * 1024 + 1; },
    (r: any) => { r.assets[0].browser_download_url = 'https://attacker.invalid/manifest'; },
    (r: any) => { r.assets.push(r.assets[0]); },
  ];
  for (const mutate of mutations) {
    Object.assign(f.release, JSON.parse(initial));
    mutate(f.release);
    assert.equal((await f.create().checkNow()).errorCode, 'INVALID_RELEASE');
  }
});

test('old releases without a manifest are unavailable and direct recovery to the official release page', async t => {
  const f = fixture(t);
  f.release.assets.shift();
  const controller = f.create();
  const state = await controller.checkNow();
  assert.equal(state.status, 'unavailable');
  assert.equal(state.errorCode, 'MANIFEST_UNAVAILABLE');
  assert.equal(state.repairAvailable, false);
  assert.equal((await controller.downloadRepair()).errorCode, 'REPAIR_PREFLIGHT_UNAVAILABLE');
  assert.equal(f.requests.includes(assetUrl(installerName)), false);
  assert.equal(await controller.launchRepair(), false);
});

test('offline responses never imply healthy or damaged', async t => {
  const f = fixture(t);
  f.intercept(async () => { throw new Error('network contains a private URL/token'); });
  const state = await f.create().checkNow();
  assert.equal(state.status, 'unavailable');
  assert.equal(state.errorCode, 'NETWORK');
  assert.equal(JSON.stringify(state).includes('token'), false);
});

test('redirects reject untrusted, plaintext and userinfo locations', async t => {
  const f = fixture(t);
  for (const location of ['https://attacker.invalid/payload', 'http://github.com/payload',
    'https://name:secret@github.com/payload', 'https://github.com.attacker.invalid/payload']) {
    f.intercept(async url => url === assetUrl(manifestName) ? new Response(null, { status: 302, headers: { location } }) : undefined);
    const state = await f.create().checkNow();
    assert.equal(state.errorCode, 'UNTRUSTED_URL', location);
    assert.equal(f.requests.includes(location), false);
  }
});

test('trusted signed redirects work without exposing or persisting transient URLs', async t => {
  const f = fixture(t);
  const signed = 'https://release-assets.githubusercontent.com/asset?sig=never-persist-this';
  f.intercept(async url => {
    if (url === assetUrl(installerName)) return new Response(null, { status: 302, headers: { location: signed } });
    if (url === signed) return response(installer);
  });
  assert.equal((await f.create().downloadRepair()).status, 'downloaded');
  assert.equal(JSON.stringify(f.states).includes('never-persist'), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.cachedFile())), [installerName]);
});

test('installer hash, advertised length, byte bounds and MOTW failures prohibit launch and clean only owned files', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.cacheRoot);
  fs.writeFileSync(path.join(f.cacheRoot, 'existing-user-file'), 'keep');
  const cases = [
    { body: Buffer.from('x'.repeat(installer.length)), expected: 'INSTALLER_DIGEST_MISMATCH' },
    { body: installer.subarray(1), expected: 'SIZE_MISMATCH' },
    { body: Buffer.concat([installer, Buffer.from('x')]), expected: 'SIZE_MISMATCH' },
    { body: installer, headers: { 'content-length': String(installer.length + 1) }, expected: 'SIZE_MISMATCH' },
  ];
  for (const entry of cases) {
    f.intercept(async url => url === assetUrl(installerName) ? response(entry.body, entry.headers) : undefined);
    const controller = f.create();
    assert.equal((await controller.downloadRepair()).errorCode, entry.expected);
    assert.equal(await controller.launchRepair(), false);
    assert.deepEqual(fs.readdirSync(f.cacheRoot), ['existing-user-file']);
  }
  f.intercept(undefined);
  const controller = f.create({ markDownloadedFile: async () => { throw new Error('ADS disabled'); } });
  assert.equal((await controller.downloadRepair()).errorCode, 'MOTW_FAILED');
  assert.equal(await controller.launchRepair(), false);
  assert.deepEqual(fs.readdirSync(f.cacheRoot), ['existing-user-file']);
  assert.equal(f.opens(), 0);
  assert.equal(f.quits(), 0);
});

test('native confirmation is mandatory, cancellation preserves download, and successful launch alone quits', async t => {
  const f = fixture(t);
  let confirmed = false;
  let dialogs = 0;
  const controller = f.create({ confirmInstall: async () => { dialogs++; return confirmed; } });
  await controller.downloadRepair();
  assert.equal(await controller.launchRepair(), false);
  assert.equal(controller.getState().status, 'downloaded');
  assert.equal(fs.existsSync(f.cachedFile()), true);
  assert.equal(f.opens(), 0);
  confirmed = true;
  assert.equal(await controller.launchRepair(), true);
  assert.equal(dialogs, 2);
  assert.equal(f.opens(), 1);
  assert.equal(f.quits(), 1);
});

test('concurrent launch clicks share one locked confirmation; failed OS launch never quits', async t => {
  const f = fixture(t);
  const confirmation = deferred<boolean>();
  let dialogs = 0;
  const controller = f.create({ confirmInstall: () => { dialogs++; return confirmation.promise; }, openInstaller: async () => false });
  await controller.downloadRepair();
  const first = controller.launchRepair();
  await until(() => dialogs === 1);
  assert.equal(controller.isBusy(), true);
  assert.equal(controller.getState().status, 'confirming');
  assert.equal(await controller.launchRepair(), false);
  confirmation.resolve(true);
  assert.equal(await first, false);
  assert.equal(dialogs, 1);
  assert.equal(controller.getState().errorCode, 'LAUNCH_FAILED');
  assert.equal(f.quits(), 0);
});

test('installer tampering before and during confirmation is detected before OS launch', async t => {
  for (const during of [false, true]) {
    const f = fixture(t);
    let dialogs = 0;
    const controller = f.create({ confirmInstall: async () => {
      dialogs++;
      if (during) fs.writeFileSync(f.cachedFile(), 'tampered during confirmation');
      return true;
    } });
    await controller.downloadRepair();
    if (!during) fs.writeFileSync(f.cachedFile(), 'tampered before confirmation');
    assert.equal(await controller.launchRepair(), false);
    assert.equal(dialogs, during ? 1 : 0);
    assert.equal(f.opens(), 0);
    assert.equal(f.quits(), 0);
  }
});

test('updater activity before start or during confirmation prevents overlap', async t => {
  const f = fixture(t);
  let busy = true;
  const controller = f.create({ isExternalBusy: () => busy, confirmInstall: async () => { busy = true; return true; } });
  assert.equal((await controller.downloadRepair()).errorCode, 'BUSY');
  assert.deepEqual(f.requests, []);
  busy = false;
  await controller.downloadRepair();
  assert.equal(await controller.launchRepair(), false);
  assert.equal(controller.getState().errorCode, 'BUSY');
  assert.equal(f.opens(), 0);
});

test('cancelled network work and disposed controllers cannot publish late results', async t => {
  const f = fixture(t);
  const stalled = deferred<Response>();
  let requested = false;
  f.intercept(async url => { if (url === releaseUrl) { requested = true; return stalled.promise; } });
  const controller = f.create();
  const checking = controller.checkNow();
  await until(() => requested);
  await controller.cancel();
  const count = f.states.length;
  stalled.resolve(response(JSON.stringify(f.release)));
  await checking;
  assert.equal(f.states.length, count);
  assert.equal(controller.getState().status, 'idle');

  const next = deferred<Response>();
  f.intercept(async () => next.promise);
  const downloading = controller.downloadRepair();
  controller.dispose();
  const disposedCount = f.states.length;
  next.resolve(response(JSON.stringify(f.release)));
  await downloading;
  assert.equal(f.states.length, disposedCount);
  assert.equal(fs.existsSync(f.cacheRoot), false);
});

test('cancelling an installer stream removes its partial and cannot resurrect downloaded state', async t => {
  const f = fixture(t);
  let streamStarted = false;
  f.intercept(async url => url === assetUrl(installerName) ? new Response(new ReadableStream({
    start(controller) { streamStarted = true; controller.enqueue(installer.subarray(0, 4)); },
  })) : undefined);
  const controller = f.create();
  const downloading = controller.downloadRepair();
  await until(() => streamStarted && !!controller.getState().progress);
  await controller.cancel();
  await downloading;
  assert.equal(controller.getState().status, 'idle');
  assert.deepEqual(fs.readdirSync(f.cacheRoot), []);
  assert.equal(await controller.launchRepair(), false);
});

test('cancelling a pending confirmation ignores a later approval and preserves the verified installer', async t => {
  const f = fixture(t);
  const confirmation = deferred<boolean>();
  let dialog = false;
  const controller = f.create({ confirmInstall: () => { dialog = true; return confirmation.promise; } });
  await controller.downloadRepair();
  const launching = controller.launchRepair();
  await until(() => dialog);
  await controller.cancel();
  const stateCount = f.states.length;
  assert.equal(controller.isBusy(), true);
  assert.equal(controller.getState().status, 'confirming');
  assert.equal(await controller.launchRepair(), false, 'the original native dialog still owns the lock');
  assert.equal((await controller.downloadRepair()).status, 'confirming');
  confirmation.resolve(true);
  assert.equal(await launching, false);
  assert.equal(f.states.length, stateCount + 1, 'publish restored state only after the native dialog closes');
  assert.equal(controller.isBusy(), false);
  assert.equal(controller.getState().status, 'downloaded');
  assert.equal(fs.existsSync(f.cachedFile()), true);
  assert.equal(f.opens(), 0);
});

test('cancel during cache directory creation removes its empty owned directory before returning', async t => {
  const f = fixture(t);
  const promises = require('node:fs/promises');
  const originalMkdtemp = promises.mkdtemp;
  const controller = f.create();
  t.mock.method(promises, 'mkdtemp', async (...args: any[]) => {
    const directory = await originalMkdtemp(...args);
    await controller.cancel();
    return directory;
  });
  assert.equal((await controller.downloadRepair()).status, 'idle');
  assert.deepEqual(fs.readdirSync(f.cacheRoot), []);
  assert.equal(f.requests.includes(assetUrl(installerName)), false);
});

test('cancel during exclusive file creation cleans the owned partial and preserves existing cache files', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.cacheRoot);
  fs.writeFileSync(path.join(f.cacheRoot, 'unrelated'), 'keep');
  const promises = require('node:fs/promises');
  const originalOpen = promises.open;
  const controller = f.create();
  t.mock.method(promises, 'open', async (file: string, ...args: any[]) => {
    const handle = await originalOpen(file, ...args);
    if (file.endsWith(installerName) && file.startsWith(f.cacheRoot)) await controller.cancel();
    return handle;
  });
  assert.equal((await controller.downloadRepair()).status, 'idle');
  assert.deepEqual(fs.readdirSync(f.cacheRoot), ['unrelated']);
  assert.equal(f.requests.includes(assetUrl(installerName)), false);
});

test('cache file permission failure cleans the directory recorded before the failed open', async t => {
  const f = fixture(t);
  const promises = require('node:fs/promises');
  const originalOpen = promises.open;
  t.mock.method(promises, 'open', async (file: string, ...args: any[]) => {
    if (file.endsWith(installerName) && file.startsWith(f.cacheRoot)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return originalOpen(file, ...args);
  });
  const controller = f.create();
  assert.equal((await controller.downloadRepair()).errorCode, 'PERMISSION');
  assert.deepEqual(fs.readdirSync(f.cacheRoot), []);
});

test('repair cache cannot create files under the installation or user data directory', async t => {
  const f = fixture(t);
  for (const cacheRoot of [path.join(f.installRoot, 'repair-cache'), path.join(f.userDataDir, 'repair-cache')]) {
    const controller = f.create({ cacheRoot });
    assert.equal((await controller.downloadRepair()).errorCode, 'UNSAFE_PATH');
    assert.equal(fs.existsSync(cacheRoot), false);
  }
});

test('cancel cannot release the maintenance lock after the OS launch request has committed', async t => {
  const f = fixture(t);
  const opening = deferred<boolean>();
  let attempted = false;
  const controller = f.create({ openInstaller: () => { attempted = true; return opening.promise; } });
  await controller.downloadRepair();
  const launched = controller.launchRepair();
  await until(() => attempted);
  assert.equal((await controller.cancel()).status, 'launching');
  assert.equal(controller.isBusy(), true);
  assert.equal((await controller.downloadRepair()).status, 'launching');
  opening.resolve(true);
  assert.equal(await launched, true);
  assert.equal(f.quits(), 1);
  assert.equal(controller.isBusy(), true, 'successful handoff retains maintenance lock until disposal');
  assert.equal(await controller.launchRepair(), false);
  assert.equal((await controller.checkNow()).status, 'launching');
  controller.dispose();
  assert.equal(controller.isBusy(), false);
});

test('synchronous state callback replacement after verification is blocked by the final launch guard', async t => {
  const f = fixture(t);
  const controller = f.create({ publishState: state => {
    f.states.push(state);
    if (state.status === 'launching') {
      const file = f.cachedFile();
      fs.renameSync(file, `${file}.replaced`);
      fs.writeFileSync(file, installer);
    }
  } });
  await controller.downloadRepair();
  assert.equal(await controller.launchRepair(), false);
  assert.equal(controller.getState().errorCode, 'INSTALLER_CHANGED');
  assert.equal(f.opens(), 0);
  assert.equal(f.quits(), 0);
});

test('same-length tampering and hard-link replacement during confirmation cannot launch', async t => {
  for (const hardLink of [false, true]) {
    const f = fixture(t);
    const controller = f.create({ confirmInstall: async () => {
      const file = f.cachedFile();
      if (hardLink) {
        fs.renameSync(file, `${file}.original`);
        fs.linkSync(path.join(f.userDataDir, 'keep-private.txt'), file);
      } else fs.writeFileSync(file, Buffer.alloc(installer.length, 0x78));
      return true;
    } });
    await controller.downloadRepair();
    assert.equal(await controller.launchRepair(), false);
    assert.equal(f.opens(), 0);
    assert.equal(f.quits(), 0);
  }
});

test('default Windows Internet zone marker is present and must remain ZoneId=3 through confirmation', async t => {
  if (process.platform !== 'win32') return t.skip('Windows ADS verification requires NTFS');
  for (const change of ['keep', 'remove', 'lower']) {
    const f = fixture(t);
    const controller = f.create({ markDownloadedFile: undefined, verifyDownloadedFile: undefined,
      confirmInstall: async () => {
        const marker = `${f.cachedFile()}:Zone.Identifier`;
        assert.equal(fs.readFileSync(marker, 'utf8'), '[ZoneTransfer]\r\nZoneId=3\r\n');
        if (change === 'remove') fs.unlinkSync(marker);
        if (change === 'lower') fs.writeFileSync(marker, '[ZoneTransfer]\r\nZoneId=0\r\n');
        return true;
      } });
    assert.equal((await controller.downloadRepair()).status, 'downloaded');
    assert.equal(await controller.launchRepair(), change === 'keep');
    assert.equal(f.opens(), change === 'keep' ? 1 : 0);
    assert.equal(f.quits(), change === 'keep' ? 1 : 0);
    if (change !== 'keep') assert.equal(controller.getState().errorCode, 'MOTW_FAILED');
  }
});

test('manifest item size, total size, empty inventory and malformed digest are bounded before any managed file read', async t => {
  const f = fixture(t);
  const entry = f.manifest.files[0];
  const inventories = [[], [{ ...entry, size: -1 }], [{ ...entry, size: Number.MAX_SAFE_INTEGER }],
    [{ ...entry, sha256: 'bad' }],
    Array.from({ length: 5 }, (_, index) => ({ ...entry, path: `large-${index}.bin`, size: 16 * 1024 * 1024 * 1024 }))];
  for (const files of inventories) {
    f.setManifest({ ...f.manifest, files });
    const state = await f.create().checkNow();
    assert.equal(state.errorCode, 'INVALID_MANIFEST');
    assert.equal(state.checkedFiles, undefined);
  }
});

test('a stalled official metadata body times out and cancels its reader', async t => {
  const f = fixture(t);
  let cancelled = 0;
  const started = deferred<void>();
  f.intercept(async url => url === releaseUrl ? new Response(new ReadableStream({
    start() { started.resolve(undefined); }, cancel() { cancelled++; },
  })) : undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = f.create();
  const checking = controller.checkNow();
  await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(30001);
  assert.equal((await checking).errorCode, 'TIMEOUT');
  assert.equal(controller.getState().status, 'unavailable');
  assert.equal(cancelled, 1);
});

test('a stalled installer stream times out and removes only its owned partial', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.cacheRoot);
  fs.writeFileSync(path.join(f.cacheRoot, 'keep'), 'unrelated');
  let cancelled = 0;
  const progress = deferred<void>();
  f.intercept(async url => url === assetUrl(installerName) ? new Response(new ReadableStream({
    start(controller) { controller.enqueue(installer.subarray(0, 4)); }, cancel() { cancelled++; },
  })) : undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = f.create({ publishState: state => { if (state.progress) progress.resolve(undefined); } });
  const downloading = controller.downloadRepair();
  await progress.promise;
  t.mock.timers.tick(15 * 60 * 1000 + 1);
  assert.equal((await downloading).errorCode, 'TIMEOUT');
  assert.equal(cancelled, 1);
  assert.deepEqual(fs.readdirSync(f.cacheRoot), ['keep']);
  assert.equal(await controller.launchRepair(), false);
});

test('repair refuses existing installation junctions and hard links before downloading the installer', async t => {
  for (const unsafe of ['resources', 'locales', 'Cove.exe', 'Uninstall Cove.exe']) {
    const f = fixture(t);
    const target = path.join(f.installRoot, unsafe);
    if (unsafe.endsWith('.exe')) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      fs.linkSync(path.join(f.userDataDir, 'keep-private.txt'), target);
    } else {
      if (fs.existsSync(target)) fs.rmdirSync(target);
      fs.symlinkSync(f.userDataDir, target, 'junction');
    }
    const controller = f.create();
    const state = await controller.downloadRepair();
    assert.equal(state.errorCode, 'UNSAFE_INSTALL_PATH', unsafe);
    assert.equal(state.repairAvailable, false, unsafe);
    assert.equal(f.requests.includes(assetUrl(installerName)), false, unsafe);
    assert.equal(fs.existsSync(f.cacheRoot), false, unsafe);
    assert.equal(fs.readFileSync(path.join(f.userDataDir, 'keep-private.txt'), 'utf8'), 'must never change');
  }
});

test('an installation directory changed to a junction while the native confirmation is open blocks handoff', async t => {
  const f = fixture(t);
  const controller = f.create({ confirmInstall: async () => {
    fs.symlinkSync(f.userDataDir, path.join(f.installRoot, 'locales'), 'junction');
    return true;
  } });
  assert.equal((await controller.downloadRepair()).status, 'downloaded');
  assert.equal(await controller.launchRepair(), false);
  assert.equal(controller.getState().errorCode, 'UNSAFE_INSTALL_PATH');
  assert.equal(controller.getState().repairAvailable, false);
  assert.equal(f.opens(), 0);
  assert.equal(f.quits(), 0);
});

test('final launch guard checks every official inventory parent without recursively scanning', async t => {
  const f = fixture(t);
  const native = path.join(f.installRoot, 'resources', 'app.asar.unpacked', 'native');
  fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(native, 'addon.node'), 'fixture native bytes');
  f.setManifest({ ...f.manifest, files: [...f.manifest.files,
    { path: 'resources/app.asar.unpacked/native/addon.node', size: 20, sha256: sha('fixture native bytes') }] });
  const controller = f.create({ publishState: state => {
    if (state.status === 'launching') {
      fs.renameSync(native, `${native}.original`);
      fs.symlinkSync(f.userDataDir, native, 'junction');
    }
  } });
  assert.equal((await controller.downloadRepair()).status, 'downloaded');
  assert.equal(await controller.launchRepair(), false);
  assert.equal(controller.getState().errorCode, 'UNSAFE_INSTALL_PATH');
  assert.equal(f.opens(), 0);
  assert.equal(f.quits(), 0);
  assert.equal(fs.readFileSync(path.join(f.userDataDir, 'keep-private.txt'), 'utf8'), 'must never change');
});
