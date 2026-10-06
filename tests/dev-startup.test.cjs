const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');

test('development launcher hides background processes but shows Electron', () => {
  const calls = [];
  function mockRequire(name) {
    if (name === 'node:child_process') return {
      spawn(command, parameters, options) {
        calls.push({command, parameters, options});
        const child = new EventEmitter();
        child.exitCode = null;
        return child;
      },
      spawnSync() { return {status: 0}; },
    };
    if (name === 'node:fs') return {mkdirSync() {}};
    return require(name);
  }
  mockRequire.resolve = require.resolve;
  const tooling = path.resolve(__dirname, '../tooling');
  vm.runInNewContext(fs.readFileSync(path.join(tooling, 'dev.cjs'), 'utf8'), {
    require: mockRequire,
    __dirname: tooling,
    console,
    process: {
      argv: [process.execPath, 'tooling/dev.cjs', '--electron'],
      execPath: process.execPath,
      platform: 'win32',
      env: {},
      on() {},
    },
  });
  assert.equal(calls.length, 3);
  assert.ok(calls[0].parameters.includes('watch'));
  assert.equal(calls[0].options.windowsHide, true);
  assert.ok(calls[1].parameters.some(value => value.endsWith('vite.js')));
  assert.equal(calls[1].options.windowsHide, true);
  assert.match(calls[2].command, /electron(?:\.exe)?$/);
  assert.equal(calls[2].options.windowsHide, false);
  assert.equal(calls[2].options.env.COVE_DESKTOP_DATA_DIR, path.resolve(__dirname, '../runtime/desktop'));
});
