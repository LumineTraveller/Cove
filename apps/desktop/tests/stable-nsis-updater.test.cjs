const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { gzipSync } = require('node:zlib');
const test = require('node:test');
const { CancellationToken } = require('builder-util-runtime');
const { NodeHttpExecutor } = require('builder-util/out/nodeHttpExecutor');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
const { StableNsisUpdater, safeDownloadDiagnostic } = require('../dist-electron/stable-nsis-updater.js');
const { acquireUpdateCacheLock } = require('../dist-electron/update-cache-safety.js');

const sha512 = value => createHash('sha512').update(value).digest('base64');
const map = checksums => gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0,
  checksums, sizes: [4, 4, 4] }] }));

// Preserve ElectronHttpExecutor's real full-download/DigestTransform code while
// adapting only request creation to Node's loopback transport in this fixture.
class LoopbackElectronExecutor extends ElectronHttpExecutor {
  constructor() { super(null); this.node = new NodeHttpExecutor(); }
  createRequest(options, callback) {
    if (!options.headers?.range) return this.node.createRequest(options, callback);
    // Adapt Node's 302 response to Electron's redirect/followRedirect contract;
    // the real upstream differential downloader owns URL/header handling.
    const request = new EventEmitter();
    let active;
    const open = () => {
      active = this.node.createRequest({ ...options, headers: { ...options.headers } }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          request.emit('redirect', response.statusCode, 'GET', response.headers.location);
        } else callback(response);
      });
      active.on('error', error => request.emit('error', error));
      active.on('socket', socket => request.emit('socket', socket));
      active.end();
    };
    request.end = open;
    request.followRedirect = open;
    request.abort = () => active?.destroy();
    return request;
  }
}

async function fixture(t, behavior = 'correct') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-native-updater-test-'));
  const cache = path.join(root, 'cove-test-cache');
  fs.mkdirSync(path.join(cache, 'pending'), { recursive: true });
  const oldBytes = Buffer.from('AAAABBBBCCCC');
  const newBytes = Buffer.from('AAAAXXXXCCCC');
  const oldMap = map(['a', 'b', 'c']);
  const newMap = behavior === 'invalid-map' ? gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0,
    checksums: ['a', 'x', 'c'], sizes: [4, 4, 3] }] })) : map(['a', 'x', 'c']);
  fs.writeFileSync(path.join(cache, 'installer.exe'), oldBytes);
  fs.writeFileSync(path.join(cache, 'current.blockmap'), oldMap);
  fs.writeFileSync(path.join(cache, 'cove-baseline.json'), JSON.stringify({ schema: 1, version: '2.1.0',
    sha512: sha512(oldBytes), size: oldBytes.length, blockmapSha512: sha512(oldMap) }));
  const config = path.join(root, 'app-update.yml');
  fs.writeFileSync(config, 'updaterCacheDirName: cove-test-cache\n');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, range: req.headers.range });
    if (req.url.endsWith('.blockmap')) {
      const bytes = req.url.includes('2.1.0') ? oldMap : newMap;
      res.writeHead(200, { 'Content-Length': bytes.length });
      res.end(bytes);
      return;
    }
    if (req.headers.range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
      assert.ok(match, req.headers.range);
      const start = Number(match[1]);
      const end = Number(match[2]);
      assert.equal(start, 4);
      assert.equal(end, 7);
      if (behavior === 'redirect-range' && !req.url.startsWith('/asset/')) {
        res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/asset/Cove-Setup-2.1.1.exe?X-Amz-Signature=fixture` });
        res.end(); return;
      }
      if (behavior === '416') { res.writeHead(416); res.end(); return; }
      if (behavior === 'ignore-range') {
        res.writeHead(200, { 'Content-Length': newBytes.length }); res.end(newBytes); return;
      }
      if (behavior === 'corrupt-range') {
        res.writeHead(206, { 'Content-Length': 4, 'Content-Range': 'bytes 4-7/12' }); res.end('YYYY'); return;
      }
      if (behavior === 'truncated-range') {
        res.writeHead(206, { 'Content-Length': 4, 'Content-Range': 'bytes 4-7/12' });
        res.write('XX'); setImmediate(() => res.destroy()); return;
      }
      res.writeHead(206, { 'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${newBytes.length}` });
      res.end(newBytes.subarray(start, end + 1));
      return;
    }
    const bytes = behavior === 'corrupt-full' ? Buffer.from('invalid full') : newBytes;
    res.writeHead(200, { 'Content-Length': bytes.length });
    res.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^cove-native-updater-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const quitHandlers = [];
  const app = { version: '2.1.0', name: 'cove-test', isPackaged: true, appUpdateConfigPath: config,
    userDataPath: root, baseCachePath: root, whenReady: async () => {}, relaunch() {}, quit() { throw new Error('Tests must not quit an app'); },
    onQuit: handler => quitHandlers.push(handler) };
  const updater = new StableNsisUpdater(null, app);
  updater.httpExecutor = new LoopbackElectronExecutor();
  const logs = [];
  updater.logger = { info: x => logs.push(x), warn: x => logs.push(x), error: x => logs.push(x) };
  const modes = [];
  updater.setDownloadModeListener(mode => modes.push(mode));
  const info = { version: '2.1.1', files: [{ url: 'Cove-Setup-2.1.1.exe', size: newBytes.length, sha512: sha512(newBytes) }] };
  const fileInfo = { url: new URL(`${base}/v2.1.1/Cove-Setup-2.1.1.exe`), info: info.files[0] };
  const provider = { isUseMultipleRangeRequest: false, resolveFiles: () => [fileInfo], getBlockMapFiles: () => [
    new URL(`${base}/v2.1.0/Cove-Setup-2.1.0.exe.blockmap`), new URL(`${fileInfo.url}.blockmap`),
  ] };
  const token = new CancellationToken();
  const options = { updateInfoAndProvider: { info, provider }, requestHeaders: { 'Accept-Encoding': 'identity' },
    cancellationToken: token, disableWebInstaller: true, disableDifferentialDownload: false };
  const ready = [];
  updater.on('update-downloaded', event => ready.push(event));
  return { root, cache, oldBytes, newBytes, oldMap, newMap, updater, modes, logs, options, requests, ready, token, quitHandlers };
}

test('native 6.8.9 protected hooks reconstruct only the changed bytes and preserve the installed cache pair', async t => {
  assert.equal(require('electron-updater/package.json').version, '6.8.9', 'Review native hook contracts before changing this dependency');
  const f = await fixture(t);
  const files = await f.updater.doDownloadUpdate(f.options);
  assert.deepEqual(fs.readFileSync(files[0]), f.newBytes);
  assert.deepEqual(f.requests.filter(r => r.range).map(r => r.range), ['bytes=4-7']);
  assert.equal(f.requests.some(r => r.path.endsWith('.exe') && !r.range), false, 'Must not silently download a full installer');
  assert.equal(f.ready.length, 1);
  assert.equal(f.modes.at(-1).differentialOutcome, 'completed');
  assert.deepEqual(fs.readFileSync(path.join(f.cache, 'installer.exe')), f.oldBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.cache, 'current.blockmap')), f.oldMap);
  assert.deepEqual(fs.readFileSync(path.join(f.cache, 'cove-next.blockmap')), f.newMap);
  assert.equal(fs.existsSync(path.join(f.cache, 'cove-update.lock')), false);
});

test('native Electron redirect contract preserves the exact single Range and verifies reconstructed bytes', async t => {
  const f = await fixture(t, 'redirect-range');
  const files = await f.updater.doDownloadUpdate(f.options);
  assert.deepEqual(fs.readFileSync(files[0]), f.newBytes);
  assert.deepEqual(f.requests.filter(r => r.range).map(r => r.range), ['bytes=4-7', 'bytes=4-7']);
  assert.ok(f.requests.some(r => r.path.startsWith('/asset/')));
  assert.equal(f.modes.at(-1).differentialOutcome, 'completed');
  assert.doesNotMatch(f.logs.join('\n'), /X-Amz-Signature|fixture/);
});

for (const behavior of ['ignore-range', 'corrupt-range', '416', 'truncated-range', 'invalid-map']) {
  test(`native ${behavior} response falls back visibly and still verifies the full installer`, async t => {
    const f = await fixture(t, behavior);
    const files = await f.updater.doDownloadUpdate(f.options);
    assert.deepEqual(fs.readFileSync(files[0]), f.newBytes);
    const fallback = f.modes.find(mode => mode.differentialOutcome === 'fallback');
    assert.equal(fallback.downloadMode, 'full');
    assert.ok(fallback.fallbackCode.startsWith('COVE_DIFFERENTIAL_'));
    assert.equal(Object.hasOwn(fallback, 'fallbackDetail'), false);
    assert.equal(f.modes.some(mode => mode.differentialOutcome === 'completed'), false);
    assert.equal(f.requests.some(r => r.path.endsWith('.exe') && !r.range), true);
    assert.equal(f.ready.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(f.cache, 'current.blockmap')), f.oldMap);
    assert.equal(fs.existsSync(path.join(f.cache, 'cove-update.lock')), false);
    if (behavior === 'invalid-map') {
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.cache, 'cove-next-baseline.json'))).blockmapSha512, undefined);
      assert.equal(fs.existsSync(path.join(f.cache, 'pending/current.blockmap')), false);
      assert.ok(f.logs.some(log => log.includes('optional next blockmap ignored')));
    }
  });
}

test('missing baseline reports a precise full fallback before blockmap requests; invalid full content never becomes ready', async t => {
  const f = await fixture(t, 'corrupt-full');
  fs.unlinkSync(path.join(f.cache, 'installer.exe'));
  await assert.rejects(f.updater.doDownloadUpdate(f.options), /checksum mismatch/i);
  assert.equal(f.modes.at(-1).fallbackCode, 'ENOENT');
  assert.equal(f.requests.some(r => r.path.endsWith('.blockmap')), false);
  assert.equal(f.ready.length, 0);
  assert.equal(fs.existsSync(path.join(f.cache, 'cove-update.lock')), false);
});

test('cache lock excludes a second updater before native pending cleanup and is released after cancellation', async t => {
  const f = await fixture(t);
  const release = await acquireUpdateCacheLock(f.cache);
  fs.writeFileSync(path.join(f.cache, 'pending/keep.txt'), 'keep');
  await assert.rejects(f.updater.doDownloadUpdate(f.options), { code: 'COVE_CACHE_BUSY' });
  assert.equal(fs.readFileSync(path.join(f.cache, 'pending/keep.txt'), 'utf8'), 'keep');
  await release();
  f.token.cancel();
  await assert.rejects(f.updater.doDownloadUpdate(f.options));
  assert.equal(f.ready.length, 0);
  assert.equal(fs.existsSync(path.join(f.cache, 'cove-update.lock')), false);
});

test('ready waits for native tail; automatic quit cannot run an installer during cache finalization', async t => {
  const f = await fixture(t);
  const nativeTail = f.updater.dispatchUpdateDownloaded.bind(f.updater);
  let sawTail = false;
  f.updater.dispatchUpdateDownloaded = event => {
    nativeTail(event);
    assert.equal(f.ready.length, 0, 'Native early event must remain private');
    assert.equal(f.updater.doInstall({ isSilent: true, isForceRunAfter: false, isAdminRightsRequired: false }), false);
    assert.equal(fs.existsSync(path.join(f.cache, 'cove-next-baseline.json')), true);
    sawTail = true;
  };
  f.updater.on('update-downloaded', () => {
    assert.equal(sawTail, true);
    assert.equal(fs.existsSync(path.join(f.cache, 'pending/current.blockmap')), false);
  });
  await f.updater.doDownloadUpdate(f.options);
  assert.equal(f.ready.length, 1);
  assert.equal(f.quitHandlers.length, 1);
  assert.ok(f.logs.some(log => log.includes('handoff blocked')));
});

test('same-instance cached EXE is rehashed, corrupt pending file is invalidated, and a retry downloads safely', async t => {
  const f = await fixture(t);
  const [installer] = await f.updater.doDownloadUpdate(f.options);
  fs.writeFileSync(installer, 'ZZZZYYYYXXXX');
  await assert.rejects(f.updater.doDownloadUpdate(f.options), { code: 'ERR_CHECKSUM_MISMATCH' });
  assert.equal(f.ready.length, 1, 'Corrupt same-size cache must not produce a second ready event');
  assert.equal(fs.existsSync(installer), false, 'Only the corrupt pending installer is invalidated');
  assert.equal(f.updater.doInstall({ isSilent: true, isForceRunAfter: false }), false, 'A previously registered quit handler cannot install after failed finalization');
  assert.deepEqual(fs.readFileSync(path.join(f.cache, 'installer.exe')), f.oldBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.cache, 'current.blockmap')), f.oldMap);
  const [retried] = await f.updater.doDownloadUpdate(f.options);
  assert.deepEqual(fs.readFileSync(retried), f.newBytes);
  assert.equal(f.ready.length, 2);
});

test('a changed installer after readiness is refused synchronously before any OS handoff', async t => {
  const f = await fixture(t);
  const [installer] = await f.updater.doDownloadUpdate(f.options);
  const errors = [];
  f.updater.on('error', error => errors.push(error));
  f.updater.spawnLog = () => { throw new Error('Must not launch a changed installer'); };
  fs.writeFileSync(installer, 'ZZZZYYYYXXXX');
  assert.equal(f.updater.doInstall({ isSilent: true, isForceRunAfter: false }), false);
  assert.equal(errors.at(-1).code, 'COVE_INSTALLER_CHANGED');
});

test('baseline diagnostics remove signed URLs, credentials, user paths, stacks and excess length', () => {
  const result = safeDownloadDiagnostic("Error: https://user:secret@example.test/download.exe?token=secret ENOENT 'C:\\Users\\Name\\AppData\\installer.exe'\n at internal stack");
  assert.doesNotMatch(result, /secret|Name|Users|internal stack|\?token/);
  assert.match(result, /https:\/\/example.test\/download.exe/);
  assert.ok(safeDownloadDiagnostic('x'.repeat(1000)).length <= 512);
});

test('identity recovery accepts only exact official versioned metadata and parent cancellation propagates', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.updater.httpExecutor.downloadToBuffer = async url => {
    calls++;
    assert.equal(url.href, 'https://cove.luxe/releases/v2.1.0/latest.yml');
    return Buffer.from(`version: 2.1.0\nfiles:\n  - url: Cove-Setup-2.1.0.exe\n    size: 12\n    sha512: ${sha512(f.oldBytes)}\n`);
  };
  const recovered = await f.updater.recoverIdentity(new URL('https://cove.luxe/releases/v2.1.0/Cove-Setup-2.1.0.exe.blockmap'), f.options);
  assert.equal(recovered.sha512, sha512(f.oldBytes));
  await assert.rejects(f.updater.recoverIdentity(new URL('https://cove.luxe:8443/releases/v2.1.0/Cove-Setup-2.1.0.exe.blockmap'), f.options), { code: 'COVE_BASELINE_UNVERIFIED' });
  await assert.rejects(f.updater.recoverIdentity(new URL('https://custom.example/releases/v2.1.0/Cove-Setup-2.1.0.exe.blockmap'), f.options), { code: 'COVE_BASELINE_UNVERIFIED' });
  assert.equal(calls, 1, 'Disallowed recovery URLs must not receive a request');
  f.updater.httpExecutor.downloadToBuffer = async () => Buffer.from('version: 2.1.9\nfiles: []\n');
  await assert.rejects(f.updater.recoverIdentity(new URL('https://cove.luxe/releases/v2.1.0/Cove-Setup-2.1.0.exe.blockmap'), f.options), { code: 'COVE_BASELINE_UNVERIFIED' });
  f.updater.httpExecutor.downloadToBuffer = async (_url, options) => options.cancellationToken.createPromise(() => {});
  const pending = f.updater.boundedBuffer(new URL('https://cove.luxe/test'), f.options);
  f.token.cancel();
  await assert.rejects(pending, { name: 'Error', message: 'cancelled' });
});
