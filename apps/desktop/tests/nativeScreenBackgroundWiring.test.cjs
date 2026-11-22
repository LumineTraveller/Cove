'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise main's real configuration; controller tests cover lease lifetimes.
const source = fs.readFileSync(path.join(__dirname, '../electron/main.ts'), 'utf8');
const start = source.indexOf('const nativeScreenCapture = new NativeScreenCaptureController({');
assert.ok(start >= 0);
const end = source.indexOf('\n});', start);
assert.ok(end > start);
const factory = source.slice(start, end + 4);

for (const isPackaged of [false, true]) {
  for (const enabled of [false, true]) {
    test(`native capture retains renderer scheduling only while enabled (packaged=${isPackaged}, enabled=${enabled})`, () => {
      let configuration;
      vm.runInNewContext(factory, {
        NativeScreenCaptureController: class { constructor(value) { configuration = value; } },
        nativeCaptureEnabled: enabled, nativeTimingEnabled: false, nativeTimingLogger: undefined,
        screenHardwareAv1Enabled: enabled,
        nativeCompletionPreference: undefined,
        process: { env: {}, resourcesPath: '/isolated-resources' },
        app: { isPackaged }, path, __dirname: '/isolated-electron',
      });
      assert.equal(configuration.keepRendererActive, enabled);
      assert.equal(configuration.enabled, enabled);
      assert.equal(configuration.allowCpuNv12, enabled);
      assert.equal(configuration.pixelFormat, 'bgra');
      assert.equal(configuration.storage, 'gpu');
      assert.equal(configuration.timing, false);
    });
  }
}
