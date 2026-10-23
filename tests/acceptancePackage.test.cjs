'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { copyDependencies, assertPhysicalTree, hashTree, verifyReleaseGate } = require('../tooling/package-acceptance-windows.cjs');
const { privateAddress, readConfig, cleanRuntimeEnvironment, within } = require('../tooling/acceptance/portable-common.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-acceptance-package-'));
  t.after(() => {
    assert.ok(within(os.tmpdir(), fs.realpathSync(directory)));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function pkg(directory, name, dependencies, code) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js', dependencies }));
  fs.writeFileSync(path.join(directory, 'index.js'), code);
}
test('portable dependency copies execute from their own tree, including conflicting nested dependencies', t => {
  const directory = fixture(t); const source = path.join(directory, 'source'); const target = path.join(directory, 'portable');
  pkg(source, 'fixture', {}, '');
  pkg(path.join(source, 'node_modules/alpha'), 'alpha', { beta: '*' }, "module.exports = require('beta');");
  pkg(path.join(source, 'node_modules/beta'), 'beta', {}, 'module.exports = 1;');
  pkg(path.join(source, 'node_modules/second'), 'second', { beta: '*' }, "module.exports = require('beta');");
  pkg(path.join(source, 'node_modules/second/node_modules/beta'), 'beta', {}, 'module.exports = 2;');
  const inventory = copyDependencies(source, ['alpha', 'second'], path.join(target, 'node_modules'));
  const local = createRequire(path.join(target, 'package.json'));
  assert.equal(local('alpha'), 1); assert.equal(local('second'), 2);
  assert.ok(local.resolve('alpha').startsWith(target));
  assert.equal(inventory.length, 4);
  assertPhysicalTree(target);
  assert.notEqual(fs.realpathSync(path.join(target, 'node_modules/alpha')), fs.realpathSync(path.join(source, 'node_modules/alpha')));
});
test('portable state and network configuration reject public addresses and invalid ports', t => {
  const directory = fixture(t);
  const config = { flavor: 'cove-acceptance-20261023', httpPort: 33991, mediaPort: 41990, announceAddress: '127.0.0.1', listenHost: '127.0.0.1' };
  const write = value => fs.writeFileSync(path.join(directory, 'acceptance.config.json'), JSON.stringify(value));
  write(config); assert.ok(within(directory, readConfig(directory).state));
  write({ ...config, announceAddress: '8.8.8.8' }); assert.throws(() => readConfig(directory), /public servers are blocked/);
  write({ ...config, mediaPort: 80 }); assert.throws(() => readConfig(directory), /Invalid acceptance mediaPort/);
  for (const address of ['localhost', '127.0.0.1', '[::1]', '10.3.0.1', '192.168.1.2', '172.16.0.2', '172.31.1.4']) assert.equal(privateAddress(address), true);
  for (const address of ['172.32.0.1', '172.15.0.1', 'cove.luxe', 'example.com', '8.8.8.8']) assert.equal(privateAddress(address), false);
});
test('acceptance launch environment drops native module and preload redirections', () => {
  const env = cleanRuntimeEnvironment({ NODE_OPTIONS: '--require unwanted.js', NODE_PATH: 'outside', ELECTRON_RUN_AS_NODE: '1', MEDIASOUP_WORKER_BIN: 'outside.exe', PATH: 'normal' });
  assert.deepEqual(env, { PATH: 'normal' });
});
test('artifact hashes exclude mutable acceptance state', t => {
  const directory = fixture(t);
  fs.writeFileSync(path.join(directory, 'app.js'), 'module.exports=1;');
  fs.mkdirSync(path.join(directory, 'acceptance-data'));
  fs.writeFileSync(path.join(directory, 'acceptance-data/account.json'), 'test-private-data');
  const inventory = hashTree(directory);
  assert.equal(inventory.length, 1); assert.equal(inventory[0].path, 'app.js');
  assert.match(inventory[0].sha256, /^[a-f\d]{64}$/);
});
test('final packaging refuses a missing automatic-update or installer-repair gate', t => {
  const directory = fixture(t);
  fs.mkdirSync(path.join(directory, 'dist-electron'));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ coveBuildFlavor: 'network-lab', coveAcceptance: { appId: 'com.cove.acceptance.20261023' } }));
  const main = "const isNetworkLabBuild = buildFlavor === 'network-lab'; updaterController = isNetworkLabBuild ? null : startAutoUpdater(); integrity({isPackaged: app.isPackaged && !isNetworkLabBuild});";
  fs.writeFileSync(path.join(directory, 'dist-electron/main.js'), main);
  assert.equal(verifyReleaseGate(directory).status, 'disabled');
  fs.writeFileSync(path.join(directory, 'dist-electron/main.js'), main.replace('isNetworkLabBuild ? null :', ''));
  assert.throws(() => verifyReleaseGate(directory), /release gate could not be verified/);
});
