import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Windows helper starts, acknowledges consumption and stops without consuming later input', { skip: process.platform !== 'win32' }, () => {
  const build = spawnSync(process.execPath, [fileURLToPath(new URL('../electron/build-remote-input.cjs', import.meta.url))], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  assert.equal(build.status, 0, build.stderr || build.error?.message);
  const executable = fileURLToPath(new URL('../build/remote-input-helper.exe', import.meta.url));
  // Unknown input types are intentional no-ops. Never move the user's pointer
  // or inject a key/button while validating the native process protocol.
  for (const [input, expected] of [
    [[{ type: 'noop', seq: 1 }, { type: 'stop' }, { type: 'noop', seq: 2 }], [{ ready: true }, { seq: 1 }]],
    [[{ type: 'noop', seq: 1 }], [{ ready: true }, { seq: 1 }]],
  ] as const) {
    const run = spawnSync(executable, [String(process.pid)], {
      input: input.map(message => JSON.stringify(message)).join('\n') + '\n',
      encoding: 'utf8', windowsHide: true, timeout: 3000,
    });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    assert.deepEqual(run.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)), expected);
  }
});
