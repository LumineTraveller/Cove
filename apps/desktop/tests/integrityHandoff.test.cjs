const assert = require('node:assert/strict');
const test = require('node:test');
const { handoffRepairInstaller } = require('../dist-electron/installation-integrity-handoff.js');

test('a normal quit during pending OS handoff cannot launch a queued update installer', async () => {
  let autoInstallOnQuit = true;
  let complete;
  let updaterLaunches = 0;
  const pending = handoffRepairInstaller('inert-fixture.exe', {
    suspendAutoInstall: () => {
      const previous = autoInstallOnQuit;
      autoInstallOnQuit = false;
      return () => { autoInstallOnQuit = previous; };
    },
    openPath: file => {
      assert.equal(file, 'inert-fixture.exe');
      assert.equal(autoInstallOnQuit, false);
      return new Promise(resolve => { complete = resolve; });
    },
  });
  // Model electron-updater's app.once('quit') hook before openPath resolves.
  if (autoInstallOnQuit) updaterLaunches++;
  assert.equal(updaterLaunches, 0);
  complete('');
  assert.equal(await pending, true);
  assert.equal(autoInstallOnQuit, false);
});

test('a rejected or failed OS handoff restores the ordinary updater quit policy', async () => {
  for (const throws of [false, true]) {
    let restored = 0;
    const accepted = await handoffRepairInstaller('inert-fixture.exe', {
      suspendAutoInstall: () => () => { restored++; },
      openPath: async () => { if (throws) throw new Error('fixture'); return 'OS declined'; },
    });
    assert.equal(accepted, false);
    assert.equal(restored, 1);
  }
});
