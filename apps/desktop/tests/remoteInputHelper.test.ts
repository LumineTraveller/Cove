import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

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

test('native warmup injects nothing; a stubbed OS boundary preserves drag, wheel, keys and stop release order',
  { skip: process.platform !== 'win32' }, () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../electron/remote-input-helper.cs', import.meta.url)), 'utf8');
    const nativeBoundary = '[DllImport("user32.dll", SetLastError = true)]\n    private static extern uint SendInput(uint count, INPUT[] inputs, int size);';
    const normalized = source.replace(/\r\n/g, '\n');
    assert.equal(normalized.split(nativeBoundary).length, 2, 'exactly one OS input boundary must be replaced');
    // The fixture records native dispatch into stdout instead of injecting any
    // system input. It also omits the global hardware hook in this test binary.
    const stubbed = normalized.replace(nativeBoundary, `private static uint SendInput(uint count, INPUT[] inputs, int size) {
        var input = inputs[0];
        var record = new { injected = new { type = input.type,
            flags = input.type == 0 ? input.U.mi.dwFlags : input.U.ki.dwFlags,
            x = input.U.mi.dx, y = input.U.mi.dy, key = input.U.ki.wVk } };
        Console.WriteLine(new JavaScriptSerializer().Serialize(record));
        return count;
    }`).replace('        StartMouseActivityHook();', '        // No global hook in this owned fixture.');
    const artifacts = fileURLToPath(new URL('../../../runtime/', import.meta.url));
    fs.mkdirSync(artifacts, { recursive: true });
    const temp = fs.mkdtempSync(path.join(artifacts, 'cove-native-input-fixture-'));
    try {
      const fixtureSource = path.join(temp, 'fixture.cs');
      const executable = path.join(temp, 'fixture.exe');
      fs.writeFileSync(fixtureSource, stubbed);
      const compiler = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
      const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/optimize+', '/platform:x64',
        `/out:${executable}`, '/reference:System.Web.Extensions.dll', '/reference:System.Windows.Forms.dll', fixtureSource],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
      const run = (messages: object[]) => {
        const child = spawnSync(executable, ['0'], { input: messages.map(message => JSON.stringify(message)).join('\n') + '\n',
          encoding: 'utf8', windowsHide: true, timeout: 3000 });
        assert.equal(child.status, 0, child.stderr);
        return child.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      };
      assert.deepEqual(run([{ type: 'stop' }]), [{ ready: true }], 'readiness warmup must never inject a pointer/key');
      const messages = [
        { type: 'pointer', x: .25, y: .5 },
        { type: 'button', button: 'left', down: true, x: .25, y: .5 },
        { type: 'pointer', x: .5, y: .6 },
        { type: 'wheel', deltaY: 120, x: .5, y: .6 },
        { type: 'key', code: 'ShiftLeft', down: true },
        { type: 'button', button: 'left', down: false, x: .5, y: .6 },
        { type: 'key', code: 'ShiftLeft', down: false },
        { type: 'pointer', x: .75, y: .25 },
      ].map((input, i) => ({ ...input, seq: i + 1 }));
      const output = run([...messages, { type: 'stop' }, { type: 'pointer', x: 1, y: 1, seq: 9 }]);
      assert.deepEqual(output.filter(row => row.seq).map(row => row.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
      const injected = output.filter(row => row.injected).map(row => row.injected);
      assert.deepEqual(injected.map(row => [row.type, row.flags]), [
        [0, 0x8001], [0, 0x8001], [0, 2], [0, 0x8001], [0, 0x8001], [0, 0x800],
        [1, 0], [0, 0x8001], [0, 4], [1, 2], [0, 0x8001],
      ]);
      assert.equal(injected[0].x, 16384); assert.equal(injected[0].y, 32768);
      const held = run([{ type: 'key', code: 'ShiftLeft', down: true, seq: 1 },
        { type: 'button', button: 'left', down: true, x: .5, y: .5, seq: 2 }, { type: 'stop' },
        { type: 'pointer', x: 1, y: 1, seq: 3 }]);
      assert.deepEqual(held.filter(row => row.seq).map(row => row.seq), [1, 2]);
      assert.deepEqual(held.filter(row => row.injected).slice(-2).map(row => [row.injected.type, row.injected.flags]),
        [[1, 2], [0, 4]], 'stop releases held key and mouse button before exiting');
      // A rejected real OS boundary must produce a failure, never a successful
      // consumption ACK. The fixture remains a recorder and injects nothing.
      const rejectedSource = stubbed.replace('private static uint SendInput(',
        'private static bool RejectOnce = true;\n    private static uint SendInput(')
        .replace('return count;', 'if (RejectOnce) { RejectOnce = false; return 0; } return count;');
      const rejectedPath = path.join(temp, 'rejected.cs');
      const rejectedExecutable = path.join(temp, 'rejected.exe');
      fs.writeFileSync(rejectedPath, rejectedSource);
      const rejectedBuild = spawnSync(compiler, ['/nologo', '/target:exe', '/optimize+', '/platform:x64',
        `/out:${rejectedExecutable}`, '/reference:System.Web.Extensions.dll', '/reference:System.Windows.Forms.dll', rejectedPath],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      assert.equal(rejectedBuild.status, 0, rejectedBuild.stdout + rejectedBuild.stderr);
      const rejectedChild = spawnSync(rejectedExecutable, ['0'], { input: [
        { type: 'key', code: 'ShiftLeft', down: true, seq: 1 },
        { type: 'pointer', x: .75, y: .25, seq: 2 },
      ].map(message => JSON.stringify(message)).join('\n') + '\n',
        encoding: 'utf8', windowsHide: true, timeout: 3000 });
      assert.equal(rejectedChild.status, 0, rejectedChild.stderr);
      const rejected = rejectedChild.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.equal(rejected.filter(row => row.seq).length, 0);
      assert.deepEqual(rejected.filter(row => row.error), [{ error: true }]);
      assert.deepEqual(rejected.filter(row => row.injected).map(row => [row.injected.type, row.injected.flags]),
        [[1, 0], [1, 2]], 'failed press stops input and still attempts a held-key release');
      fs.writeFileSync(rejectedPath, stubbed.replace('return count;',
        'return input.type == 1 && input.U.ki.dwFlags == 2 && input.U.ki.wVk == 0xA0 ? 0U : count;'));
      const releaseBuild = spawnSync(compiler, ['/nologo', '/target:exe', '/optimize+', '/platform:x64',
        `/out:${rejectedExecutable}`, '/reference:System.Web.Extensions.dll', '/reference:System.Windows.Forms.dll', rejectedPath],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      assert.equal(releaseBuild.status, 0, releaseBuild.stdout + releaseBuild.stderr);
      const releaseFailure = spawnSync(rejectedExecutable, ['0'], { input: [
        { type: 'key', code: 'ShiftLeft', down: true, seq: 1 },
        { type: 'key', code: 'ControlLeft', down: true, seq: 2 },
        { type: 'button', button: 'left', down: true, x: .5, y: .5, seq: 3 },
        { type: 'stop' },
      ].map(message => JSON.stringify(message)).join('\n') + '\n',
        encoding: 'utf8', windowsHide: true, timeout: 3000 });
      assert.equal(releaseFailure.status, 0);
      const released = releaseFailure.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.deepEqual(released.filter(row => row.error), [{ error: true }]);
      assert.deepEqual(released.filter(row => row.injected).slice(-3).map(row => [row.injected.type, row.injected.flags]),
        [[1, 2], [1, 2], [0, 4]], 'one rejected key release must not skip another key or the mouse release');
    } finally {
      // Retain this small fixture beside the other diagnostic evidence. The
      // active cleanup inventory is read-only and owns any later removal.
    }
  });
