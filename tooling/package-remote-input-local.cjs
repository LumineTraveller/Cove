// Local artifact only: preserve formal Cove identity, never publish/install.
const path = require('node:path');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const appDir = path.resolve(__dirname, '../apps/desktop');
const localRequire = createRequire(path.join(appDir, 'package.json'));
const manifest = localRequire('./package.json');
assert.equal(manifest.version, '2.0.1');
assert.equal(manifest.build.appId, 'com.cove.app');
assert.equal(manifest.build.productName, 'Cove');
assert.equal(manifest.coveBuildFlavor, undefined);
const { build, Platform, Arch } = localRequire('electron-builder');
build({ projectDir: appDir, targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  publish: 'never', config: {
    electronDist: path.join(appDir, 'node_modules/electron/dist'),
    directories: { output: 'dist-app-remote-input-2.0.1' },
  },
}).then(artifacts => console.log(JSON.stringify({ localArtifacts: artifacts }, null, 2)))
  .catch(error => { console.error(error); process.exitCode = 1; });
