import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { RemoteInputQueue } from '../electron/remote-input-queue';
import type { RemoteInputController } from '../electron/remote-control';

// Run the production controller with fake process pipes: no Windows input is
// injected, and readiness/exit ordering can be controlled deterministically.
const compiled = ts.transpileModule(fs.readFileSync(new URL('../electron/remote-control.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const children: ReturnType<typeof child>[] = [];
  const failures: string[] = [];
  function child() {
    const writes: any[] = [];
    const stdin = Object.assign(new EventEmitter(), {
      writableLength: 0,
      write(line: string) { writes.push(JSON.parse(line)); return true; },
      end(line: string) { writes.push(JSON.parse(line)); },
    });
    const proc = Object.assign(new EventEmitter(), {
      stdin, stdout: new EventEmitter(), stderr: { resume() {} },
      exitCode: null as number | null, killed: false,
      kill() { proc.killed = true; },
      ready() { proc.stdout.emit('data', Buffer.from('{"ready":true}\n')); },
      ack(seq: number) { proc.stdout.emit('data', Buffer.from(`${JSON.stringify({ seq })}\n`)); },
      close() { proc.exitCode = 0; proc.emit('exit', 0); proc.emit('close', 0); },
      writes,
    });
    children.push(proc);
    return proc;
  }
  const module = { exports: {} as { RemoteInputController: new (onFailure: (reason: string) => void) => RemoteInputController } };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    require: (name: string) => {
      if (name === 'electron') return { app: { isPackaged: false, getAppPath: () => '/app' } };
      if (name === 'child_process') return { spawn: child };
      if (name === 'fs') return { existsSync: () => true };
      if (name === 'path') return path;
      if (name === './remote-input-queue') return { RemoteInputQueue };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { platform: 'win32', pid: 123 }, Buffer,
    setTimeout, clearTimeout,
  });
  const controller = new module.exports.RemoteInputController(reason => failures.push(reason));
  t.after(() => { controller.stop(); children.forEach(proc => proc.close()); });
  return { controller, children, failures };
}

const key = { type: 'key' as const, code: 'KeyA', down: true };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('controller buffers until ready and revocation discards pending input without restarting', async t => {
  const h = harness(t);
  const ready = h.controller.setActive('session-one');
  const proc = h.children[0];
  assert.equal(h.controller.send('session-one', key), true);
  assert.equal(proc.writes.length, 0);
  proc.ready();
  assert.equal(await ready, true);
  assert.equal(proc.writes[0].seq, 1);
  h.controller.send('session-one', { ...key, down: false });
  await h.controller.setActive(null);
  proc.ack(1);
  proc.stdin.emit('drain');
  assert.deepEqual(proc.writes, [{ ...key, seq: 1 }, { type: 'stop' }]);
  assert.equal(h.controller.send('session-one', key), false);
  proc.close();
  assert.equal(h.children.length, 1);
  assert.equal(h.failures.length, 0);
});

test('new helper cannot inject until the old helper has finished releasing its pressed state', async t => {
  const h = harness(t);
  const first = h.controller.setActive('session-one');
  h.children[0].ready();
  assert.equal(await first, true);
  h.controller.send('session-one', key);
  const second = h.controller.setActive('session-two');
  const next = h.children[1];
  h.controller.send('session-two', key);
  next.ready();
  await flush();
  assert.equal(next.writes.length, 0);
  assert.deepEqual(h.children[0].writes.at(-1), { type: 'stop' });
  h.children[0].close();
  assert.equal(await second, true);
  assert.equal(next.writes[0].seq, 1);
  assert.equal(h.failures.length, 0);
});

test('stop before ready rejects the pending activation and late ready cannot inject', async t => {
  const h = harness(t);
  const ready = h.controller.setActive('session-one');
  const proc = h.children[0];
  h.controller.send('session-one', key);
  h.controller.stop();
  proc.ready();
  assert.equal(await ready, false);
  assert.deepEqual(proc.writes, [{ type: 'stop' }]);
});

test('helper timeout, execution failure and late EPIPE fail closed exactly once', async t => {
  const h = harness(t);
  const first = h.controller.setActive('session-one');
  t.mock.timers.tick(2000);
  assert.equal(await first, false);
  assert.equal(h.failures.length, 1);
  h.children[0].stdin.emit('error', new Error('EPIPE'));
  h.children[0].close();
  const second = h.controller.setActive('session-two');
  h.children[1].ready();
  assert.equal(await second, true);
  h.children[1].stdout.emit('data', Buffer.from('{"error":true}\n'));
  assert.equal(h.controller.send('session-two', key), false);
  h.children[1].stdin.emit('error', new Error('EPIPE'));
  assert.equal(h.failures.length, 2);
});
