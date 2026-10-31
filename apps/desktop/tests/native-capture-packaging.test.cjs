'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const childProcess = require('node:child_process');
const desktop = require('../package.json');

function loadHook(spawn) {
  const hookPath = require.resolve('../tools/prepare-native-screen-capture.cjs');
  const original = childProcess.spawnSync;
  try {
    childProcess.spawnSync = spawn;
    delete require.cache[hookPath];
    return require(hookPath);
  } finally {
    childProcess.spawnSync = original;
  }
}

test('Windows packages place both native resources beside each other', () => {
  const resources = desktop.build.win.extraResources;
  for (const name of ['native-screen-capture-helper.exe', 'native-screen-handles.node']) {
    const entries = resources.filter(entry => entry.to === name);
    assert.equal(entries.length, 1, name);
    assert.equal(entries[0].from, `build/${name}`);
  }
  assert.equal(desktop.build.beforePack, 'tools/prepare-native-screen-capture.cjs');
});

test('every Windows x64 package rebuilds and CPU-tests both native resources', async () => {
  const calls = [];
  const hook = loadHook((command, args) => { calls.push({ command, args }); return { status: 0 }; });
  await hook({ electronPlatformName: 'win32', arch: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.equal(path.basename(calls[0].args[0]), 'build-native-screen-capture.cjs');
  assert.equal(path.basename(calls[0].args[calls[0].args.indexOf('--output') + 1]), 'native-screen-capture-helper.exe');
  assert.equal(path.basename(calls[0].args[calls[0].args.indexOf('--handles-output') + 1]), 'native-screen-handles.node');
  assert.ok(calls[0].args.includes('--self-test'));
});

test('a failed build or unsupported Windows architecture stops packaging', async () => {
  const hook = loadHook(() => ({ status: 1 }));
  await assert.rejects(hook({ electronPlatformName: 'win32', arch: 1 }), /build or CPU self-test failed/);
  await assert.rejects(hook({ electronPlatformName: 'win32', arch: 3 }), /Windows x64/);
  await hook({ electronPlatformName: 'darwin', arch: 3 });
});
