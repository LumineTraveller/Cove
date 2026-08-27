const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const test = require('node:test');
const { configureAutoUpdater } = require('../dist-electron/updater-core.js');
const { compareReleaseVersions, discoverUpdateSources } = require('../dist-electron/update-sources.js');
const { formatTransferPercent, transferPercent, updateWaitWarning, updateStepIndex } = require('../dist-electron/update-state.js');

const githubSource = {
  id: 'github', label: 'GitHub', version: '0.7.0',
  feedUrl: 'https://github.com/LumineTraveller/Cove/releases/download/v0.7.0/', latencyMs: 30,
};
const giteeSource = {
  id: 'gitee', label: 'Gitee', version: '0.7.0',
  feedUrl: 'https://gitee.com/LumineTraveller/Cove/releases/download/v0.7.0/', latencyMs: 10,
};

test('compiled Electron adapter imports electron-updater at runtime', () => {
  assert.doesNotThrow(() => require('../dist-electron/updater.js'));
});

test('compiled updater exposes only the in-app IPC bridge and no OS notification prompt', () => {
  const adapter = fs.readFileSync(require.resolve('../dist-electron/updater.js'), 'utf8');
  const preload = fs.readFileSync(require.resolve('../dist-electron/preload.js'), 'utf8');
  assert.doesNotMatch(adapter, /Notification|showMessageBox/);
  assert.match(preload, /cove:update:check/);
  assert.match(preload, /cove:update:install/);
  assert.match(preload, /cove:update:open-log/);
});

test('compiled Electron main keeps WGC capture without diagnostic file logging', () => {
  const main = fs.readFileSync(require.resolve('../dist-electron/main.js'), 'utf8');
  const wgc = main.indexOf("appendSwitch('enable-features', 'AllowWgcScreenCapturer')");
  const ready = main.search(/\.whenReady\(\)\.then/);
  assert.ok(wgc >= 0, 'WGC desktop capture feature is missing');
  assert.ok(ready > wgc, 'WGC feature must be applied before app.whenReady()');
  assert.doesNotMatch(main, /webrtc-max-cpu-consumption-percentage/);
  assert.doesNotMatch(main, /enable-logging|log-file|vmodule|chromium-screen-capture|media-diagnostics|cove:diagnostics:/);
  const preload = fs.readFileSync(require.resolve('../dist-electron/preload.js'), 'utf8');
  assert.doesNotMatch(preload, /coveDiagnostics|cove:diagnostics:/);
});

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = false;
    this.autoInstallOnAppQuit = false;
    this.allowPrerelease = true;
    this.logger = null;
    this.checkCount = 0;
    this.installCalls = [];
    this.feedCalls = [];
    this.checkErrors = [];
  }

  async checkForUpdates() {
    this.checkCount += 1;
    const error = this.checkErrors.shift();
    if (error) throw error;
    return null;
  }

  setFeedURL(options) {
    this.feedCalls.push(options);
  }

  quitAndInstall(...args) {
    this.installCalls.push(args);
  }
}

function createHarness(overrides = {}) {
  const updater = new FakeUpdater();
  const once = [];
  const repeating = [];
  const cleared = [];
  const progress = [];
  const states = [];
  const logs = [];
  const window = {
    isDestroyed: () => false,
    setProgressBar: value => progress.push(value),
  };

  const controller = configureAutoUpdater({
    updater,
    isPackaged: true,
    getWindow: () => window,
    publishState: state => states.push(state),
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
    scheduleOnce: (callback, delayMs) => {
      const timer = { callback, delayMs, unrefCalled: false, unref() { this.unrefCalled = true; } };
      once.push(timer);
      return timer;
    },
    scheduleRepeating: (callback, delayMs) => {
      const timer = { callback, delayMs, unrefCalled: false, unref() { this.unrefCalled = true; } };
      repeating.push(timer);
      return timer;
    },
    clearScheduled: timer => cleared.push(timer),
    resolveSources: async () => [githubSource],
    ...overrides,
  });

  return { updater, controller, once, repeating, cleared, progress, states, logs };
}

test('development builds do not contact the update service', async () => {
  const updater = new FakeUpdater();
  let scheduled = false;
  const controller = configureAutoUpdater({
    updater,
    isPackaged: false,
    getWindow: () => null,
    publishState: () => undefined,
    logger: console,
    scheduleOnce: () => { scheduled = true; return {}; },
    scheduleRepeating: () => { scheduled = true; return {}; },
  });

  assert.equal(controller.enabled, false);
  await controller.checkNow();
  assert.equal(updater.checkCount, 0);
  assert.equal(scheduled, false);
  assert.equal(controller.getState().status, 'disabled');
  assert.equal(controller.installNow(), false);
});

test('packaged builds configure automatic checks and downloads', async () => {
  const h = createHarness();
  assert.equal(h.controller.enabled, true);
  assert.equal(h.updater.autoDownload, true);
  assert.equal(h.updater.autoInstallOnAppQuit, true);
  assert.equal(h.updater.allowPrerelease, false);
  assert.equal(h.once[0].delayMs, 10_000);
  assert.equal(h.repeating[0].delayMs, 4 * 60 * 60 * 1_000);
  assert.equal(h.once[0].unrefCalled, true);
  assert.equal(h.repeating[0].unrefCalled, true);

  await h.once[0].callback();
  assert.equal(h.updater.checkCount, 1);
  assert.equal(h.updater.feedCalls[0].url, githubSource.feedUrl);
});

test('release discovery selects the newest version, then the faster mirror', async () => {
  const fetchImpl = async input => {
    const url = String(input);
    const tag_name = url.includes('gitee.com') ? 'v0.7.1' : 'v0.7.0';
    return new Response(JSON.stringify({ tag_name }), { status: 200 });
  };
  const sources = await discoverUpdateSources(fetchImpl, 1_000);
  assert.deepEqual(sources.map(source => [source.id, source.version]), [['gitee', '0.7.1'], ['github', '0.7.0']]);
  assert.equal(compareReleaseVersions('0.7.0', '0.6.9') > 0, true);
  assert.match(sources[0].feedUrl, /gitee\.com\/LumineTraveller\/Cove\/releases\/download\/v0\.7\.1\/$/);
});

test('a failed primary source automatically falls back to the other release mirror', async () => {
  const h = createHarness({ resolveSources: async () => [giteeSource, githubSource] });
  h.updater.checkErrors.push(new Error('gitee offline'));
  await h.controller.checkNow();
  assert.equal(h.updater.checkCount, 2);
  assert.deepEqual(h.updater.feedCalls.map(call => call.url), [giteeSource.feedUrl, githubSource.feedUrl]);
  assert.equal(h.controller.getState().sourceLabel, 'GitHub');
});

test('update events publish in-app state, progress and user-triggered install', async () => {
  const h = createHarness();
  h.updater.emit('update-available', { version: '0.5.2' });
  h.updater.emit('download-progress', { percent: 42.5 });
  h.updater.emit('update-downloaded', { version: '0.5.2' });

  assert.deepEqual(h.states.map(state => state.status), ['available', 'downloading', 'downloaded']);
  assert.equal(h.states[1].percent, 42.5);
  assert.equal(h.controller.getState().status, 'downloaded');
  assert.ok(h.progress.includes(0.425));
  assert.ok(h.progress.includes(-1));
  assert.deepEqual(h.updater.installCalls, []);
  await h.controller.checkNow();
  assert.equal(h.updater.checkCount, 0, 'a downloaded update must remain installable instead of starting another check');
  assert.equal(h.controller.installNow(), true);
  assert.deepEqual(h.updater.installCalls, [[true, true]]);
});

test('errors are non-fatal and dispose clears schedules and listeners', () => {
  const h = createHarness();
  h.updater.emit('error', new Error('offline'));
  assert.equal(h.progress.at(-1), -1);
  assert.equal(h.logs.some(entry => entry[0] === 'error'), true);
  assert.equal(h.controller.getState().status, 'error');
  assert.equal(h.controller.getState().errorDetail, 'offline');
  assert.match(h.controller.getState().message, /检查更新失败/);
  assert.equal(updateStepIndex(h.controller.getState()), 0);

  h.controller.dispose();
  assert.equal(h.cleared.length, 2);
  assert.equal(h.updater.listenerCount('update-available'), 0);
  assert.equal(h.progress.at(-1), -1);
});

test('transfer percentage never rounds an incomplete download to 100%', () => {
  assert.equal(formatTransferPercent(99.5), '99.5%');
  assert.equal(formatTransferPercent(99.999), '99.9%');
  assert.equal(formatTransferPercent(100), '100%');
  assert.equal(transferPercent({ percent: 100, transferred: 995, total: 1000 }), 99.5);
  assert.equal(transferPercent({ percent: NaN }), 0);
});

test('100% means finalizing, not installable; duplicates do not hide a long wait', async () => {
  let clock = 1_000;
  const h = createHarness({ now: () => clock });
  h.updater.emit('update-available', { version: '0.8.1' });
  h.updater.emit('download-progress', { percent: 100, transferred: 995, total: 1000, bytesPerSecond: 50 });
  assert.equal(h.controller.getState().status, 'downloading');
  assert.equal(h.controller.getState().bytesPerSecond, 50);
  clock = 2_000;
  h.updater.emit('download-progress', { percent: 100, transferred: 1000, total: 1000 });
  assert.equal(h.controller.getState().status, 'finalizing');
  assert.equal(h.controller.installNow(), false);
  await h.controller.checkNow();
  assert.equal(h.updater.checkCount, 0);
  clock = 32_000;
  h.updater.emit('download-progress', { percent: 100, transferred: 1000, total: 1000 });
  assert.equal(h.controller.getState().lastActivityAt, 2_000);
  assert.match(updateWaitWarning(h.controller.getState(), clock), /30 秒.*尚未收到安装就绪确认/);
  h.updater.emit('update-downloaded', { version: '0.8.1' });
  assert.equal(updateWaitWarning(h.controller.getState(), clock + 90_000), null);
  assert.equal(h.controller.installNow(), true);
  assert.equal(h.controller.getState().status, 'installing');
  assert.equal(h.controller.getState().lastActivityAt, clock);
  assert.equal(h.controller.installNow(), false);
  assert.equal(h.updater.installCalls.length, 1);
  h.updater.emit('download-progress', { percent: 50 });
  assert.equal(h.controller.getState().status, 'installing', 'late progress must not replace the install state');
});

test('cached installers can become ready without any progress events', () => {
  const h = createHarness();
  h.updater.emit('update-available', { version: '0.8.1' });
  h.updater.emit('update-downloaded', { version: '0.8.1' });
  assert.equal(h.controller.getState().status, 'downloaded');
  assert.equal(h.controller.installNow(), true);
});

test('a differential download can fall back to a full transfer after 100%', () => {
  const h = createHarness();
  h.updater.emit('update-available', { version: '0.8.1' });
  h.updater.emit('download-progress', { percent: 100, transferred: 100, total: 100 });
  h.updater.emit('download-progress', { percent: 10, transferred: 100, total: 1000 });
  assert.equal(h.controller.getState().status, 'downloading');
  assert.equal(h.controller.getState().total, 1000);
  assert.equal(h.controller.installNow(), false);
});

test('validation failure retains failed stage, transfer metrics and raw error', () => {
  const h = createHarness();
  h.updater.emit('update-available', { version: '0.8.1' });
  h.updater.emit('download-progress', { percent: 100, transferred: 1000, total: 1000 });
  const error = Object.assign(new Error('sha512 checksum mismatch'), { code: 'ERR_CHECKSUM_MISMATCH' });
  h.updater.emit('error', error);
  const state = h.controller.getState();
  assert.equal(state.status, 'error');
  assert.equal(state.failedStage, 'finalizing');
  assert.equal(state.errorDetail, error.message);
  assert.equal(state.errorCode, error.code);
  assert.equal(state.transferred, 1000);
  assert.equal(updateStepIndex(state), 3);
  assert.equal(h.controller.installNow(), false);
});

test('installation exceptions and synchronous error events remain visible', () => {
  for (const event of [false, true]) {
    const h = createHarness();
    h.updater.emit('update-downloaded', { version: '0.8.1' });
    h.updater.quitAndInstall = () => {
      const error = new Error('installer could not start');
      if (event) h.updater.emit('error', error);
      else throw error;
    };
    assert.equal(h.controller.installNow(), false);
    assert.equal(h.controller.getState().failedStage, 'installing');
    assert.match(h.controller.getState().errorDetail, /could not start/);
  }
});

test('errors during source probing are not lost, including rejected automatic downloads', async () => {
  for (const emitError of [false, true]) {
    const h = createHarness();
    h.updater.checkForUpdates = async () => {
      h.updater.emit('update-available', { version: '0.8.1' });
      h.updater.emit('download-progress', { percent: 100 });
      const error = new Error('download validation failed');
      if (emitError) h.updater.emit('error', error);
      return { downloadPromise: Promise.reject(error) };
    };
    await h.controller.checkNow();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.controller.getState().status, 'error');
    assert.equal(h.controller.getState().failedStage, 'finalizing');
    assert.match(h.controller.getState().errorDetail, /validation failed/);
    h.controller.dispose();
  }
});

test('fallback waits for failed download cleanup and clears old transfer metrics', async () => {
  const h = createHarness({ resolveSources: async () => [giteeSource, githubSource] });
  let rejectDownload;
  let cleaned = false;
  h.updater.checkForUpdates = async () => {
    h.updater.checkCount++;
    h.updater.emit('update-available', { version: '0.8.1' });
    if (h.updater.checkCount === 1) return {
      downloadPromise: new Promise((_, reject) => { rejectDownload = reject; })
        .catch(error => { h.updater.emit('error', error); throw error; })
        .finally(() => { cleaned = true; }),
    };
    assert.equal(cleaned, true);
    return { downloadPromise: Promise.resolve() };
  };
  await h.controller.checkNow();
  h.updater.emit('download-progress', { percent: 100, transferred: 1000, total: 1000 });
  rejectDownload(new Error('gitee checksum failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.updater.checkCount, 2);
  assert.equal(h.controller.getState().sourceLabel, 'GitHub');
  assert.equal(h.controller.getState().status, 'available');
  assert.equal(h.controller.getState().transferred, undefined);
  assert.equal(h.controller.getState().percent, 0);
  h.updater.emit('update-downloaded', { version: '0.8.1' });
  assert.equal(h.controller.getState().status, 'downloaded');
});

test('a disposed controller ignores rejected pending downloads', async () => {
  const h = createHarness();
  let rejectDownload;
  h.updater.checkForUpdates = async () => {
    h.updater.emit('update-available', { version: '0.8.1' });
    return { downloadPromise: new Promise((_, reject) => { rejectDownload = reject; }) };
  };
  await h.controller.checkNow();
  h.controller.dispose();
  const count = h.states.length;
  rejectDownload(new Error('late failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.states.length, count);
});

test('wait notices distinguish stalls, preparation and installer handoff', () => {
  assert.equal(updateWaitWarning({ status: 'downloading', lastActivityAt: 0 }, 29_999), null);
  assert.match(updateWaitWarning({ status: 'downloading', lastActivityAt: 0 }, 30_000), /没有新增下载数据/);
  assert.match(updateWaitWarning({ status: 'available', stageStartedAt: 0 }, 30_000), /尚未收到后续进展/);
  assert.match(updateWaitWarning({ status: 'installing', stageStartedAt: 0 }, 15_000), /尚未退出/);
});
