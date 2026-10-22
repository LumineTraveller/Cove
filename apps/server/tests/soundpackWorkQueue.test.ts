import assert from 'node:assert/strict';
import test from 'node:test';
import { SoundpackWorkQueue } from '../src/features/soundpacks/soundpackWorkQueue';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test('one bounded FIFO queue covers whole multi-step jobs and rejects excess work', async () => {
  const queue = new SoundpackWorkQueue({ concurrency: 2, maxQueued: 1 });
  const gates = [deferred(), deferred(), deferred()];
  const started: number[] = [];
  const work = (i: number) => queue.run(async () => { started.push(i); await gates[i].promise; return i; });
  const first = work(0), second = work(1), third = work(2);
  await assert.rejects(work(3), code('SOUNDPACK_QUEUE_FULL'));
  await flush();
  assert.deepEqual(started, [0, 1]);
  gates[1].resolve(); await second; await flush();
  assert.deepEqual(started, [0, 1, 2]);
  gates[0].resolve(); gates[2].resolve();
  assert.deepEqual(await Promise.all([first, third]), [0, 2]);
});

test('cancelling queued work removes it without starting it or leaving a stale queue slot', async () => {
  const queue = new SoundpackWorkQueue({ concurrency: 1, maxQueued: 1 });
  const gate = deferred();
  const running = queue.run(() => gate.promise);
  const controller = new AbortController();
  let cancelledRan = false;
  const cancelled = queue.run(async () => { cancelledRan = true; }, { signal: controller.signal });
  const rejected = assert.rejects(cancelled, code('SOUNDPACK_CANCELLED'));
  controller.abort(); await rejected;
  const replacement = queue.run(async () => 'replacement');
  gate.resolve(); await running;
  assert.equal(await replacement, 'replacement');
  assert.equal(cancelledRan, false);
});

test('running cancellation holds its slot until the worker has released its process and files', async () => {
  const queue = new SoundpackWorkQueue({ concurrency: 1, maxQueued: 1 });
  const released = deferred();
  const controller = new AbortController();
  let workerSignal!: AbortSignal;
  let nextStarted = false;
  const running = queue.run(async signal => { workerSignal = signal; await released.promise; }, { signal: controller.signal });
  const rejected = assert.rejects(running, code('SOUNDPACK_CANCELLED'));
  const next = queue.run(async () => { nextStarted = true; });
  await flush(); controller.abort(); await flush();
  assert.equal(workerSignal.aborted, true);
  assert.equal(nextStarted, false);
  released.resolve(); await rejected; await next;
  assert.equal(nextStarted, true);
});

test('queue wait and execution deadlines are independent and do not extend on later arrivals', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = new SoundpackWorkQueue({ concurrency: 1, maxQueued: 2, maxWaitMs: 100, timeoutMs: 300 });
  const released = deferred();
  let workerSignal!: AbortSignal;
  const running = queue.run(async signal => { workerSignal = signal; await released.promise; });
  const runningRejected = assert.rejects(running, code('SOUNDPACK_PROCESSING_TIMEOUT'));
  const queued = queue.run(async () => assert.fail('expired queued job must not execute'));
  const waitRejected = assert.rejects(queued, code('SOUNDPACK_QUEUE_TIMEOUT'));
  await flush();
  t.mock.timers.tick(100); await waitRejected;
  assert.equal(workerSignal.aborted, false);
  t.mock.timers.tick(200);
  assert.equal(workerSignal.aborted, true);
  released.resolve(); await runningRejected;
  assert.equal(await queue.run(async () => 'usable'), 'usable');
});

test('already cancelled work never invokes the worker and worker failures release the queue', async () => {
  const queue = new SoundpackWorkQueue({ concurrency: 1, maxQueued: 0 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(queue.run(async () => assert.fail('cancelled'), { signal: controller.signal }), code('SOUNDPACK_CANCELLED'));
  await assert.rejects(queue.run(async () => { throw new Error('fixture failure'); }), /fixture failure/);
  assert.equal(await queue.run(async () => 1), 1);
});
