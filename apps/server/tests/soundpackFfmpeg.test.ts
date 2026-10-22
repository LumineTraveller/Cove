import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createSoundpackFfmpegRunner } from '../src/features/soundpacks/soundpackFfmpeg';

function fixture(options: { timeoutMs?: number; maxReportBytes?: number } = {}) {
  let kills = 0;
  let spawnOptions: any;
  let args: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(), kill: (signal: string) => { assert.equal(signal, 'SIGKILL'); kills++; return true; },
  });
  const run = createSoundpackFfmpegRunner({ ...options, spawnProcess: ((_exe: string, arguments_: string[], config: unknown) => {
    args = arguments_; spawnOptions = config; return child;
  }) as never });
  return { run, child, kills: () => kills, args: () => args, options: () => spawnOptions };
}

test('FFmpeg runs hidden without stdin/shell and returns bounded stderr after close', async () => {
  const f = fixture();
  const result = f.run(['-i', 'fixture.wav', '-f', 'null', '-']);
  assert.equal(f.options().windowsHide, true);
  assert.deepEqual(f.options().stdio, ['ignore', 'ignore', 'pipe']);
  assert.equal(f.options().shell, undefined);
  assert.ok(f.args().includes('-nostdin'));
  assert.ok(f.args().includes('-filter_threads'));
  f.child.stderr.emit('data', Buffer.from('report'));
  f.child.emit('close', 0);
  assert.equal(await result, 'report');
  assert.equal(f.kills(), 0);
});

test('abort kills once and waits for close even if FFmpeg reports success afterwards', async () => {
  const f = fixture(); const controller = new AbortController();
  let settled = false;
  const result = f.run([], controller.signal);
  result.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(result, (error: any) => error.code === 'SOUNDPACK_CANCELLED');
  controller.abort(); controller.abort();
  await Promise.resolve();
  assert.equal(f.kills(), 1);
  assert.equal(settled, false);
  f.child.emit('close', 0);
  await rejected;
});

test('process timeout and report overflow kill before releasing their caller', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timed = fixture({ timeoutMs: 50 });
  const timedResult = timed.run([]);
  const timeoutRejected = assert.rejects(timedResult, (error: any) => error.code === 'SOUNDPACK_PROCESSING_TIMEOUT');
  t.mock.timers.tick(50);
  assert.equal(timed.kills(), 1);
  timed.child.emit('close', null); await timeoutRejected;
  const overflow = fixture({ maxReportBytes: 8 });
  const overflowResult = overflow.run([]);
  const overflowRejected = assert.rejects(overflowResult, /输出过多/);
  overflow.child.stderr.emit('data', Buffer.alloc(9));
  overflow.child.stderr.emit('data', Buffer.alloc(20));
  assert.equal(overflow.kills(), 1);
  overflow.child.emit('close', null); await overflowRejected;
});

test('spawn errors and decode failures retain a useful error and clear deadlines', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const missing = fixture();
  const missingResult = missing.run([]);
  const missingRejected = assert.rejects(missingResult, /fixture missing/);
  missing.child.emit('error', new Error('fixture missing'));
  missing.child.emit('close', -1); await missingRejected;
  const invalid = fixture();
  const invalidResult = invalid.run([]);
  const invalidRejected = assert.rejects(invalidResult, /invalid fixture/);
  invalid.child.stderr.emit('data', Buffer.from('frame details\ninvalid fixture\n'));
  invalid.child.emit('close', 1); await invalidRejected;
  t.mock.timers.tick(60_000);
  assert.equal(missing.kills(), 0);
  assert.equal(invalid.kills(), 0);
});

test('an already aborted operation never creates a process', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.run([], controller.signal), (error: any) => error.code === 'SOUNDPACK_CANCELLED');
  assert.deepEqual(f.args(), []);
});
