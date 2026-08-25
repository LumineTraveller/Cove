const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { configureAutoUpdater } = require('../dist-electron/updater-core.js');

test('compiled Electron adapter imports electron-updater at runtime', () => {
  assert.doesNotThrow(() => require('../dist-electron/updater.js'));
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
  }

  async checkForUpdates() {
    this.checkCount += 1;
    return null;
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
  const notifications = [];
  const prompts = [];
  const logs = [];
  const window = {
    isDestroyed: () => false,
    setProgressBar: value => progress.push(value),
  };

  const controller = configureAutoUpdater({
    updater,
    isPackaged: true,
    getWindow: () => window,
    notify: (title, body) => notifications.push({ title, body }),
    promptInstall: async version => {
      prompts.push(version);
      return true;
    },
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
    ...overrides,
  });

  return { updater, controller, once, repeating, cleared, progress, notifications, prompts, logs };
}

test('development builds do not contact the update service', async () => {
  const updater = new FakeUpdater();
  let scheduled = false;
  const controller = configureAutoUpdater({
    updater,
    isPackaged: false,
    getWindow: () => null,
    notify: () => undefined,
    promptInstall: async () => false,
    logger: console,
    scheduleOnce: () => { scheduled = true; return {}; },
    scheduleRepeating: () => { scheduled = true; return {}; },
  });

  assert.equal(controller.enabled, false);
  await controller.checkNow();
  assert.equal(updater.checkCount, 0);
  assert.equal(scheduled, false);
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
});

test('update events drive notification, progress and silent restart install', async () => {
  const h = createHarness();
  h.updater.emit('update-available', { version: '0.5.2' });
  h.updater.emit('download-progress', { percent: 42.5 });
  h.updater.emit('update-downloaded', { version: '0.5.2' });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(h.notifications, [{
    title: 'Cove 0.5.2 可用',
    body: '正在后台下载更新，不会中断当前语音或共享。',
  }]);
  assert.ok(h.progress.includes(0.425));
  assert.ok(h.progress.includes(-1));
  assert.deepEqual(h.prompts, ['0.5.2']);
  assert.deepEqual(h.updater.installCalls, [[true, true]]);
});

test('errors are non-fatal and dispose clears schedules and listeners', () => {
  const h = createHarness();
  h.updater.emit('error', new Error('offline'));
  assert.equal(h.progress.at(-1), -1);
  assert.equal(h.logs.some(entry => entry[0] === 'error'), true);

  h.controller.dispose();
  assert.equal(h.cleared.length, 2);
  assert.equal(h.updater.listenerCount('update-available'), 0);
  assert.equal(h.progress.at(-1), -1);
});
