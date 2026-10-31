const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { configureAutoUpdater } = require('../dist-electron/updater-core.js');
const { UpdateSettingsStore, normalizeUpdateServerUrl } = require('../dist-electron/update-settings.js');
const { discoverUpdateSources } = require('../dist-electron/update-sources.js');
const { BoundedUpdateProvider } = require('../dist-electron/update-provider.js');
const { guardUpdateDownloadTransport } = require('../dist-electron/update-download-transport.js');

const cloud = { id: 'cloud', label: '更新服务器', version: '2.2.0', feedUrl: 'https://updates.example.test/cove/releases/v2.2.0/', latencyMs: 1 };
const github = { id: 'github', label: 'GitHub', version: '2.2.0', feedUrl: 'https://github.com/LumineTraveller/Cove/releases/download/v2.2.0/', latencyMs: 1 };
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const updater = new EventEmitter();
  const feeds = [];
  const timers = [];
  updater.setFeedURL = value => feeds.push(value);
  updater.quitAndInstall = () => assert.fail('This test must never install');
  updater.setCheckSignal = signal => { updater.checkSignal = signal; };
  updater.checkForUpdates = async () => { updater.emit('update-not-available', { version: '2.1.1' }); };
  const controller = configureAutoUpdater({ updater, isPackaged: true,
    getWindow: () => null, publishState: () => {}, logger: { info() {}, warn() {}, error() {} },
    scheduleOnce: callback => { timers.push(callback); return {}; },
    scheduleRepeating: callback => { timers.push(callback); return {}; }, clearScheduled() {},
    resolveSources: async url => url ? [cloud] : [github], ...options });
  return { updater, controller, feeds, timers };
}

test('update settings persist in their own userData file across controller restarts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-update-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new UpdateSettingsStore(dir);
  const h = harness({ downloadBaseUrl: store.load().serverUrl, saveServerUrl: url => store.save(url) });
  assert.deepEqual(h.controller.getSettings(), { serverUrl: '', automaticEnabled: false });
  assert.equal(h.controller.saveSettings(' https://updates.example.test/cove/ ').ok, true);
  h.controller.dispose();
  const restartedStore = new UpdateSettingsStore(dir);
  const restarted = harness({ downloadBaseUrl: restartedStore.load().serverUrl });
  assert.deepEqual(restarted.controller.getSettings(), { serverUrl: 'https://updates.example.test/cove', automaticEnabled: true });
  assert.deepEqual(fs.readdirSync(dir), ['update-settings.json']);
  restarted.controller.dispose();
});

test('configuration validation rejects unsafe input without mutating the saved configuration', t => {
  let writes = 0;
  const h = harness({ saveServerUrl: () => writes++ });
  t.after(() => h.controller.dispose());
  for (const value of [null, {}, ['https://example.test'], 'http://example.test', 'http://127.0.0.1',
    'https://user:secret@example.test', 'https://example.test?secret=x', 'https://example.test#x', 'https://example.test?', 'https://example.test#', 'https://@example.test',
    'file:///tmp/update.exe', 'https://example.test\\bad', 'https://exa\nmple.test', 'x'.repeat(2049)]) {
    assert.equal(h.controller.saveSettings(value).ok, false, String(value));
  }
  assert.equal(writes, 0);
  assert.equal(normalizeUpdateServerUrl('http://127.0.0.1:3210', true), 'http://127.0.0.1:3210');
  assert.equal(normalizeUpdateServerUrl('http://example.test', true), null);
  assert.equal(normalizeUpdateServerUrl('https://updates.example.test/cove/'), 'https://updates.example.test/cove');
});

test('invalid or corrupt disk settings disable automatic requests, and failed writes preserve memory', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-update-settings-invalid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'update-settings.json');
  const store = new UpdateSettingsStore(dir);
  for (const content of ['broken', JSON.stringify({ schema: 1, serverUrl: 'http://example.test' }), 'x'.repeat(4097)]) {
    fs.writeFileSync(file, content);
    assert.deepEqual(store.load(), { serverUrl: '', automaticEnabled: false });
  }
  const h = harness({ saveServerUrl: () => { throw new Error('disk unavailable'); } });
  t.after(() => h.controller.dispose());
  assert.equal(h.controller.saveSettings('https://updates.example.test').ok, false);
  assert.deepEqual(h.controller.getSettings(), { serverUrl: '', automaticEnabled: false });
});

test('blank configuration makes zero automatic requests while both manual GitHub actions remain usable', async t => {
  const calls = [];
  const h = harness({ resolveSources: async (url, signal) => { calls.push(url); return [github]; } });
  t.after(() => h.controller.dispose());
  await h.timers[0](); await h.timers[1]();
  await h.controller.checkAutomatically();
  assert.deepEqual(calls, []);
  await h.controller.checkNow();
  await h.controller.checkGithub();
  assert.deepEqual(calls, ['', '']);
  assert.deepEqual(h.feeds.map(feed => feed.url), [github.feedUrl, github.feedUrl]);
  assert.equal(h.controller.getSettings().automaticEnabled, false);
});

test('manual GitHub checks bypass a configured server without replacing persistent settings', async t => {
  const calls = [];
  const h = harness({ downloadBaseUrl: 'https://updates.example.test/cove',
    resolveSources: async url => { calls.push(url); return [github]; } });
  t.after(() => h.controller.dispose());
  await h.controller.checkGithub();
  assert.deepEqual(calls, ['']);
  assert.equal(h.controller.getSettings().serverUrl, 'https://updates.example.test/cove');
});

test('a settings change aborts pending discovery and a late old result cannot set a feed', async t => {
  let release;
  let oldSignal;
  const calls = [];
  const h = harness({ downloadBaseUrl: 'https://old.example.test', resolveSources: (url, signal) => {
    calls.push(url);
    if (url.includes('old.')) { oldSignal = signal; return new Promise(resolve => { release = resolve; }); }
    return Promise.resolve([github]);
  } });
  t.after(() => h.controller.dispose());
  const oldCheck = h.controller.checkNow();
  assert.equal(h.controller.saveSettings('https://new.example.test').ok, true);
  assert.equal(oldSignal.aborted, true);
  const nextCheck = h.controller.checkNow();
  release([cloud]);
  await Promise.all([oldCheck, nextCheck]);
  assert.deepEqual(calls, ['https://old.example.test', 'https://new.example.test']);
  assert.deepEqual(h.feeds.map(feed => feed.url), [github.feedUrl]);
});

test('a settings change cancels native metadata checks before a new feed begins', async t => {
  let entered = false;
  const h = harness({ downloadBaseUrl: 'https://old.example.test' });
  t.after(() => h.controller.dispose());
  h.updater.checkForUpdates = () => {
    entered = true;
    const signal = h.updater.checkSignal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      h.updater.emit('error', new Error('obsolete metadata aborted'));
      reject(new Error('obsolete metadata aborted'));
    }, { once: true }));
  };
  const pending = h.controller.checkNow();
  await tick();
  assert.equal(entered, true);
  assert.equal(h.controller.saveSettings('https://new.example.test').ok, true);
  await pending;
  assert.equal(h.controller.getState().status, 'idle');
  assert.equal(h.feeds.length, 1);
});

test('a source change during download or readiness cannot change the feed, cache, or saved URL', async t => {
  let writes = 0;
  const h = harness({ downloadBaseUrl: 'https://updates.example.test/cove', saveServerUrl: () => writes++ });
  t.after(() => h.controller.dispose());
  h.updater.checkForUpdates = async () => { h.updater.emit('update-available', { version: '2.2.0' }); };
  await h.controller.checkNow();
  for (const status of ['available', 'downloading', 'finalizing', 'downloaded']) {
    if (status === 'downloading') h.updater.emit('download-progress', { percent: 40 });
    if (status === 'finalizing') h.updater.emit('download-progress', { percent: 100 });
    if (status === 'downloaded') h.updater.emit('update-downloaded', { version: '2.2.0' });
    assert.equal(h.controller.getState().status, status);
    assert.equal(h.controller.saveSettings('https://other.example.test').ok, false);
    assert.equal(h.controller.getSettings().serverUrl, 'https://updates.example.test/cove');
    assert.equal(h.feeds.length, 1);
  }
  assert.equal(writes, 0);
  assert.equal(h.updater.disableDifferentialDownload, false);
});

async function localMetadata(t, behavior) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    if (req.url.startsWith('/server/') && behavior === 'timeout') return;
    if (req.url.startsWith('/server/') && behavior === '404') { res.writeHead(404); res.end(); return; }
    if (req.url.startsWith('/server/') && behavior === 'large') { res.end('x'.repeat(65537)); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ tag_name: req.url.startsWith('/server/') && behavior === 'stale' ? 'v2.1.0' : 'v2.2.0' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Keep production URL validation intact; only this fixture maps requests to
  // loopback. No real GitHub/custom server is contacted.
  const fetchImpl = (input, init) => fetch(`${origin}/${String(input).includes('api.github.com') ? 'github' : 'server'}/latest.json`, init);
  return { calls, fetchImpl };
}

for (const behavior of ['correct', 'timeout', '404', 'stale', 'large']) {
  test(`server discovery ${behavior}: server first, GitHub only when needed`, async t => {
    const fixture = await localMetadata(t, behavior);
    const sources = await discoverUpdateSources('https://updates.example.test/cove', fixture.fetchImpl,
      100, Date.now, { currentVersion: '2.1.1' });
    assert.deepEqual(fixture.calls, behavior === 'correct' ? ['/server/latest.json'] : ['/server/latest.json', '/github/latest.json']);
    assert.deepEqual(sources.map(source => source.id), [behavior === 'correct' ? 'cloud' : 'github']);
  });
}

test('server installer metadata/asset failure discovers GitHub lazily and retains differential mode', async t => {
  for (const failure of ['manifest', 'installer']) {
    const calls = [];
    const h = harness({ downloadBaseUrl: 'https://updates.example.test', resolveSources: async url => {
      calls.push(url); return url ? [cloud] : [github];
    } });
    t.after(() => h.controller.dispose());
    let rejectDownload;
    h.updater.checkForUpdates = async () => {
      if (h.feeds.length === 1) {
        if (failure === 'manifest') throw new Error('HTTP 404 latest.yml');
        h.updater.emit('update-available', { version: cloud.version });
        return { downloadPromise: new Promise((resolve, reject) => { rejectDownload = reject; }) };
      }
      h.updater.emit('update-available', { version: github.version });
    };
    await h.controller.checkNow();
    if (failure === 'installer') {
      assert.deepEqual(calls, ['https://updates.example.test']);
      rejectDownload(new Error('HTTP 404 installer.exe'));
      await tick(); await tick();
    }
    assert.deepEqual(calls, ['https://updates.example.test', '']);
    assert.deepEqual(h.feeds.map(feed => feed.url), [cloud.feedUrl, github.feedUrl]);
    assert.deepEqual(h.feeds.map(feed => feed.expectedVersion), [cloud.version, github.version]);
    assert.equal(h.updater.disableDifferentialDownload, false);
  }
});

test('metadata provider aborts its fetch and rejects index/manifest version skew', async () => {
  const abort = new AbortController();
  let requestSignal;
  const fetchImpl = (url, options) => {
    requestSignal = options.signal;
    return new Promise((resolve, reject) => requestSignal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  };
  const options = { provider: 'custom', url: cloud.feedUrl, expectedVersion: cloud.version,
    getCheckSignal: () => abort.signal, fetchImpl };
  const updater = { channel: null, isAddNoCacheQuery: false };
  const runtime = { executor: {}, platform: 'win32', isUseMultipleRangeRequest: false };
  const provider = new BoundedUpdateProvider(options, updater, runtime);
  const pending = provider.getLatestVersion();
  abort.abort();
  await assert.rejects(pending, /cancel/i);
  assert.equal(requestSignal.aborted, true);
  const skewed = new BoundedUpdateProvider({ ...options, getCheckSignal: () => null,
    fetchImpl: async () => new Response('version: 2.1.0\nfiles: []\n') }, updater, runtime);
  await assert.rejects(skewed.getLatestVersion(), /different versions/);
});

test('settings IPC accepts only the owned window and exact argument shapes', async () => {
  const vm = require('node:vm');
  const compiled = fs.readFileSync(require.resolve('../dist-electron/main.js'), 'utf8');
  const start = compiled.indexOf('electron_1.ipcMain.handle("cove:update:get-settings"');
  const end = compiled.indexOf('electron_1.ipcMain.handle("cove:update:get-state"', start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map();
  const sender = {};
  const calls = [];
  vm.runInNewContext(compiled.slice(start, end), {
    electron_1: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
    mainWindow: { webContents: sender }, integritySender: event => event.sender === sender && event.senderFrame === sender, integrityController: { isBusy: () => false },
    unavailableUpdateState: { status: 'disabled' },
    updaterController: {
      getSettings: () => ({ serverUrl: '', automaticEnabled: false }),
      saveSettings: value => { calls.push(['save', value]); return { ok: true }; },
      checkGithub: () => calls.push(['github']),
      checkAutomatically: () => calls.push(['automatic']),
    },
  });
  const save = handlers.get('cove:update:save-settings');
  assert.equal(save({ sender: {} }, 'https://example.test').ok, false);
  assert.equal(save({ sender, senderFrame: sender }, { url: 'https://example.test', path: 'C:\\installer.exe' }).ok, false);
  assert.equal(save({ sender, senderFrame: sender }, 'https://example.test', 'C:\\installer.exe').ok, false);
  for (const channel of ['cove:update:check-github', 'cove:update:check-automatically']) {
    handlers.get(channel)({ sender: {} });
    handlers.get(channel)({ sender, senderFrame: sender }, 'https://attacker.test/installer.exe');
  }
  assert.deepEqual(calls, []);
  assert.equal(save({ sender, senderFrame: sender }, 'https://example.test').ok, true);
  handlers.get('cove:update:check-github')({ sender, senderFrame: sender });
  handlers.get('cove:update:check-automatically')({ sender, senderFrame: sender });
  assert.deepEqual(calls, [['save', 'https://example.test'], ['github'], ['automatic']]);
});

test('clearing a previously enabled configuration blocks renderer automatic checks immediately', async t => {
  const calls = [];
  const h = harness({ downloadBaseUrl: 'https://updates.example.test', resolveSources: async url => {
    calls.push(url); return [github];
  } });
  t.after(() => h.controller.dispose());
  assert.equal(h.controller.getSettings().automaticEnabled, true);
  assert.equal(h.controller.saveSettings('').ok, true);
  await h.controller.checkAutomatically();
  await h.timers[0](); await h.timers[1]();
  assert.deepEqual(calls, []);
  await h.controller.checkGithub();
  assert.deepEqual(calls, ['']);
});

test('an error event cannot permit feed switching while a download promise is still unwinding', async t => {
  let finish;
  const h = harness({ resolveSources: async () => [github] });
  t.after(() => h.controller.dispose());
  h.updater.checkForUpdates = async () => {
    h.updater.emit('update-available', { version: '2.2.0' });
    return { downloadPromise: new Promise(resolve => { finish = resolve; }) };
  };
  await h.controller.checkGithub();
  h.updater.emit('error', new Error('download tail has not settled'));
  assert.equal(h.controller.getState().status, 'error');
  assert.equal(h.controller.saveSettings('https://other.example.test').ok, false);
  await h.controller.checkGithub();
  assert.equal(h.feeds.length, 1);
  finish(); await tick();
  assert.equal(h.controller.saveSettings('https://other.example.test').ok, true);
});

test('manifest HTTPS redirects support signed GitHub assets, reject downgrade and bound streaming bytes', async () => {
  const runtime = { executor: {}, platform: 'win32', isUseMultipleRangeRequest: false };
  const updater = { channel: null, isAddNoCacheQuery: false };
  const base = { provider: 'custom', url: github.feedUrl, expectedVersion: github.version, getCheckSignal: () => null };
  const calls = [];
  const provider = new BoundedUpdateProvider({ ...base, fetchImpl: async (url, options) => {
    calls.push(String(url));
    assert.equal(options.redirect, 'manual');
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/fixture/latest.yml?signature=local' } })
      : new Response('version: 2.2.0\nfiles: []\n');
  } }, updater, runtime);
  assert.equal((await provider.getLatestVersion()).version, '2.2.0');
  assert.equal(calls.length, 2);
  for (const redirect of ['http://example.test/latest.yml', 'https://user:secret@example.test/latest.yml']) {
    const unsafe = new BoundedUpdateProvider({ ...base,
      fetchImpl: async () => new Response(null, { status: 302, headers: { Location: redirect } }) }, updater, runtime);
    await assert.rejects(unsafe.getLatestVersion(), /Unsafe/);
  }
  let cancelled = false;
  let pulls = 0;
  const large = new BoundedUpdateProvider({ ...base, fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(70 * 1024)); },
    cancel() { cancelled = true; },
  })) }, updater, runtime);
  await assert.rejects(large.getLatestVersion(), /too large/);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3, `Streaming limit should stop promptly, got ${pulls} pulls`);
  for (const asset of ['http://example.test/setup.exe', 'https://user:secret@example.test/setup.exe']) {
    assert.throws(() => provider.resolveFiles({ version: '2.2.0', files: [{ url: asset, sha512: 'fixture' }] }), /HTTPS/);
    assert.throws(() => provider.resolveFiles({ version: '2.2.0', files: [{ url: 'setup.exe', sha512: 'fixture' }],
      packages: { [process.arch]: { path: asset, sha512: 'fixture', size: 12 } } }), /web installer/);
  }
});

test('native download guards preserve signed HTTPS Range redirects and settle unsafe redirects through error', () => {
  const executor = {
    createRequest(options) {
      const request = new EventEmitter();
      request.abort = () => { request.aborted = true; };
      return request;
    },
    addRedirectHandlers(request, options, reject, count, handler) {
      request.on('redirect', (status, method, url) => {
        const target = new URL(url);
        handler({ ...options, protocol: target.protocol, hostname: target.hostname });
      });
    },
  };
  guardUpdateDownloadTransport(executor);
  const range = { protocol: 'https:', hostname: 'github.com', headers: { range: 'bytes=4-7' } };
  const request = executor.createRequest(range, () => {});
  const errors = [];
  let followed = 0;
  request.on('error', error => errors.push(error));
  request.on('redirect', () => followed++);
  request.emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/a.exe?signature=local');
  assert.equal(followed, 1);
  assert.equal(range.headers.range, 'bytes=4-7');
  request.emit('redirect', 302, 'GET', 'http://example.test/a.exe');
  assert.equal(followed, 1);
  assert.equal(errors.length, 1);
  assert.equal(request.aborted, true);
  assert.throws(() => executor.createRequest({ protocol: 'http:', hostname: 'example.test' }, () => {}), /Unsafe/);
  let options = { protocol: 'https:', hostname: 'github.com' };
  let blocked = 0;
  for (let index = 0; index < 6; index++) {
    const current = executor.createRequest(options, () => {});
    current.on('error', () => blocked++);
    executor.addRedirectHandlers(current, options, () => {}, 0, next => { options = next; });
    current.emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/a.exe?signature=local');
  }
  assert.equal(blocked, 1, 'The sixth redirect must not continue a reconstructed full-download chain');
});


test('Cove accepts complete offline NSIS metadata and rejects web packages before update availability', async () => {
  const manifest = { version: '2.2.0', files: [{ url: 'Cove-Setup-2.2.0.exe', sha512: 'fixture', size: 12 }] };
  const runtime = { executor: {}, platform: 'win32', isUseMultipleRangeRequest: false };
  const updater = { channel: null, isAddNoCacheQuery: false };
  let content = manifest;
  const provider = new BoundedUpdateProvider({ provider: 'custom', url: cloud.feedUrl,
    expectedVersion: cloud.version, getCheckSignal: () => null,
    fetchImpl: async () => new Response(JSON.stringify(content)) }, updater, runtime);
  const complete = await provider.getLatestVersion();
  assert.equal(provider.resolveFiles(complete)[0].url.href, `${cloud.feedUrl}Cove-Setup-2.2.0.exe`);
  content = { ...manifest, packages: { [process.arch]: {
    path: 'https://updates.example.test/package.7z', size: 12, sha512: 'fixture', blockMapSize: 4,
  } } };
  await assert.rejects(provider.getLatestVersion(), /complete NSIS installer.*web installer/);
  assert.throws(() => provider.resolveFiles(content), /complete NSIS installer.*web installer/);
});
