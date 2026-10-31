import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNativeFrameWriteQueue,
  type NativeFrameDropReason,
  type NativeFrameWriteResult,
} from '../src/features/media/screen/nativeFrameWriteQueue';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() { for (let index = 0; index < 4; index++) await Promise.resolve(); }

function fixture(maxPendingAgeMs = 20) {
  let time = 0;
  const writes: { frame: number; completion: ReturnType<typeof deferred> }[] = [];
  const written: { durationMs: number; queueAgeMs: number }[] = [];
  const dropped: NativeFrameDropReason[] = [];
  const failures: unknown[] = [];
  const queue = createNativeFrameWriteQueue({
    maxPendingAgeMs,
    now: () => time,
    write(frame: number) {
      const completion = deferred();
      writes.push({ frame, completion });
      return completion.promise;
    },
    onWritten: (durationMs, queueAgeMs) => written.push({ durationMs, queueAgeMs }),
    onDropped: reason => dropped.push(reason),
    onFailure: error => failures.push(error),
  });
  return { queue, writes, written, dropped, failures, at(value: number) { time = value; } };
}

test('submit stays pending until its active write finishes', async () => {
  const f = fixture();
  let result: NativeFrameWriteResult | undefined;
  const submitted = f.queue.submit(1).then(value => { result = value; return value; });
  assert.deepEqual(f.writes.map(value => value.frame), [1]);
  await flush();
  assert.equal(result, undefined);
  f.at(7);
  f.writes[0].completion.resolve();
  assert.equal(await submitted, 'written');
  assert.deepEqual(f.written, [{ durationMs: 7, queueAgeMs: 0 }]);
});

test('a burst retains one latest frame and drains it without another arrival', async () => {
  const f = fixture();
  const first = f.queue.submit(1);
  f.at(1);
  const second = f.queue.submit(2);
  f.at(2);
  const third = f.queue.submit(3);
  assert.equal(await second, 'superseded');
  assert.deepEqual(f.writes.map(value => value.frame), [1]);
  f.at(9);
  f.writes[0].completion.resolve();
  assert.equal(await first, 'written');
  assert.deepEqual(f.writes.map(value => value.frame), [1, 3]);
  assert.deepEqual(f.dropped, ['superseded']);
  f.at(14);
  f.writes[1].completion.resolve();
  assert.equal(await third, 'written');
  assert.deepEqual(f.written, [
    { durationMs: 9, queueAgeMs: 0 },
    { durationMs: 5, queueAgeMs: 7 },
  ]);
});

test('pending age is measured from arrival and expired frames are never written', async () => {
  const f = fixture(16);
  const first = f.queue.submit(1);
  f.at(5);
  const pending = f.queue.submit(2);
  f.at(22);
  f.writes[0].completion.resolve();
  assert.equal(await first, 'written');
  assert.equal(await pending, 'expired');
  assert.deepEqual(f.writes.map(value => value.frame), [1]);
  assert.deepEqual(f.dropped, ['expired']);
  const next = f.queue.submit(3);
  assert.deepEqual(f.writes.map(value => value.frame), [1, 3]);
  f.writes[1].completion.resolve();
  assert.equal(await next, 'written');
});

test('a frame exactly at the maximum age may still be written', async () => {
  const f = fixture(16);
  const first = f.queue.submit(1);
  f.at(3);
  const pending = f.queue.submit(2);
  f.at(19);
  f.writes[0].completion.resolve();
  await first;
  assert.deepEqual(f.writes.map(value => value.frame), [1, 2]);
  f.writes[1].completion.resolve();
  assert.equal(await pending, 'written');
});

test('stop immediately settles active and pending submissions and forbids late work', async () => {
  const f = fixture();
  const first = f.queue.submit(1);
  const pending = f.queue.submit(2);
  f.queue.stop();
  f.queue.stop();
  assert.deepEqual(await Promise.all([first, pending, f.queue.submit(3)]), ['stopped', 'stopped', 'stopped']);
  f.writes[0].completion.resolve();
  await flush();
  assert.deepEqual(f.writes.map(value => value.frame), [1]);
  assert.deepEqual(f.written, []);
  assert.deepEqual(f.dropped, []);
  assert.deepEqual(f.failures, []);
});

test('a late rejection after stop is consumed without callbacks or new work', async () => {
  const f = fixture();
  const first = f.queue.submit(1);
  const pending = f.queue.submit(2);
  f.queue.stop();
  f.writes[0].completion.reject(new Error('late write failure'));
  assert.deepEqual(await Promise.all([first, pending]), ['stopped', 'stopped']);
  await flush();
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.failures, []);
});

test('write rejection reports once and settles all submissions as stopped', async () => {
  const f = fixture();
  const first = f.queue.submit(1);
  const pending = f.queue.submit(2);
  const failure = new Error('write failed');
  f.writes[0].completion.reject(failure);
  assert.deepEqual(await Promise.all([first, pending]), ['stopped', 'stopped']);
  assert.deepEqual(f.failures, [failure]);
  assert.equal(await f.queue.submit(3), 'stopped');
  f.queue.stop();
  assert.equal(f.failures.length, 1);
});

test('synchronous write failure stops the queue and reports once', async () => {
  const failures: unknown[] = [];
  const failure = new Error('synchronous write failure');
  const queue = createNativeFrameWriteQueue<number>({
    write: () => { throw failure; }, now: () => 0, maxPendingAgeMs: 20,
    onFailure: error => failures.push(error),
  });
  assert.equal(await queue.submit(1), 'stopped');
  assert.equal(await queue.submit(2), 'stopped');
  assert.deepEqual(failures, [failure]);
});

test('reentrant submission during completion stays behind the active write', async () => {
  const completion = deferred();
  const writes: number[] = [];
  const results: Promise<NativeFrameWriteResult>[] = [];
  const queue = createNativeFrameWriteQueue<number>({
    write: frame => { writes.push(frame); return frame === 1 ? completion.promise : Promise.resolve(); },
    now: () => 0, maxPendingAgeMs: 20,
    onWritten: () => { if (writes.length === 1) results.push(queue.submit(3)); },
  });
  const first = queue.submit(1);
  const second = queue.submit(2);
  completion.resolve();
  assert.equal(await first, 'written');
  assert.equal(await second, 'superseded');
  assert.equal(await results[0], 'written');
  assert.deepEqual(writes, [1, 3]);
});

test('the queue never owns frame close or release operations', async () => {
  const frame = { closes: 0, close() { this.closes++; } };
  const queue = createNativeFrameWriteQueue<typeof frame>({
    write: async () => {}, now: () => 0, maxPendingAgeMs: 20,
  });
  assert.equal(await queue.submit(frame), 'written');
  queue.stop();
  assert.equal(frame.closes, 0);
});

test('invalid pending age limits fail before accepting frames', () => {
  for (const maxPendingAgeMs of [-1, NaN, Infinity]) {
    assert.throws(() => createNativeFrameWriteQueue({
      write: async () => {}, now: () => 0, maxPendingAgeMs,
    }), RangeError);
  }
});
