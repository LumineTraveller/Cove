import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as childProcess from 'node:child_process';
import * as util from 'node:util';
import * as path from 'node:path';
import { PcmChunkQueue } from '../electron/pcmChunkQueue';

function harness(legacy = false) {
  const intervalDelays: number[] = [];
  let tick = () => {};
  let callback = (_: Buffer) => {};
  const callbacks: ((chunk: Buffer) => void)[] = [];
  let stops = 0;
  const sent: any[][] = [];
  let destroyed = false;
  const owner = { send(...args: any[]) { sent.push(args); }, isDestroyed: () => destroyed };
  const compiled = ts.transpileModule(readFileSync(new URL('../electron/application-audio.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports: any = {};
  runInNewContext(compiled, { exports, Buffer, Uint8Array, console,
    process: { platform: 'win32', env: legacy ? { COVE_AUDIO_LATENCY_PROFILE: 'legacy' } : {} },
    setInterval(fn: () => void, delay: number) { tick = fn; intervalDelays.push(delay); return 1; }, clearInterval() { tick = () => {}; },
    require(name: string) {
      if (name === 'child_process') return childProcess;
      if (name === 'util') return util;
      if (name === 'node:path') return path;
      if (name === 'electron') return { app: { isPackaged: false } };
      if (name === './pcmChunkQueue') return { PcmChunkQueue };
      if (name === 'loopback-capture') return { LoopbackCapture: class {
        start(_pid: number, _include: boolean, cb: (chunk: Buffer) => void) { callback = cb; callbacks.push(cb); }
        stop() { stops++; }
      } };
      throw new Error(name);
    },
  });
  const controller = new exports.ApplicationAudioCaptureController('test:chunk');
  const start = () => controller.startExcludingProcess(owner, 1234);
  start();
  return { controller, owner, sent, intervalDelays, start, callbacks, get stops() { return stops; },
    push: (frames: number, byte: number) => callback(Buffer.alloc(frames * 4, byte)),
    tick: () => tick(), destroy: () => { destroyed = true; },
  };
}

test('adaptive capture flushes at 10 ms with one credit and drops stale pending PCM during UI stalls', () => {
  const h = harness();
  assert.deepEqual(h.intervalDelays, [10]);
  h.push(480, 1); h.tick();
  const firstSequence = h.sent[0][2];
  assert.equal(h.sent.length, 1);
  for (let i = 0; i < 100; i++) { h.push(480, i + 2); h.tick(); }
  assert.equal(h.sent.length, 1, 'a blocked renderer must not grow IPC messages');
  h.controller.acknowledge({}, firstSequence);
  h.controller.acknowledge(h.owner, firstSequence + 1);
  assert.equal(h.sent.length, 1);
  h.controller.acknowledge(h.owner, firstSequence);
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1][1].byteLength, 5760 * 4);
  assert.ok(h.sent[1][1].slice(-1920).every((v: number) => v === 101));
});

test('late ACK and old native callback after stop/restart cannot mutate the new capture', () => {
  const h = harness();
  h.push(480, 1); h.tick();
  const old = h.sent[0][2];
  h.controller.stop(); h.start();
  h.callbacks[0](Buffer.alloc(480 * 4, 9)); h.tick();
  assert.equal(h.sent.length, 1, 'old native callbacks must not enter new capture');
  h.push(480, 2); h.tick();
  const current = h.sent[1][2];
  assert.notEqual(current, old);
  h.push(480, 3);
  h.controller.acknowledge(h.owner, old);
  assert.equal(h.sent.length, 2);
  h.controller.acknowledge(h.owner, current);
  assert.equal(h.sent.length, 3);
  h.destroy(); h.tick();
  assert.equal(h.stops, 2);
});

test('legacy profile preserves 40 ms transport and requires no ACK', () => {
  const h = harness(true);
  assert.deepEqual(h.intervalDelays, [40]);
  h.push(480, 1); h.tick(); h.push(480, 2); h.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[0].length, 2);
});
