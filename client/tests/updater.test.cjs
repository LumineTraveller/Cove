const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const test = require('node:test');
const { configureAutoUpdater } = require('../dist-electron/updater-core.js');
const { compareReleaseVersions, discoverUpdateSources } = require('../dist-electron/update-sources.js');

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
  assert.deepEqual(h.controller.getState(), { status: 'error', version: undefined, message: 'offline' });

  h.controller.dispose();
  assert.equal(h.cleared.length, 2);
  assert.equal(h.updater.listenerCount('update-available'), 0);
  assert.equal(h.progress.at(-1), -1);
});
