import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNativeCanvasFrameSink,
  createNativeCanvasCpuFramePreparer,
  createNativeCanvasAdmissionScheduler,
  getNativeCanvasFrameFailureCode,
  NativeCanvasFrameSinkError,
  type NativeCanvasFrameDropReason,
  type NativeCanvasFrameResult,
  type NativeCanvasFrameSinkPlatform,
} from '../src/features/media/screen/nativeCanvasFrameSink';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

type TestFrame = VideoFrame & { closes: number; input?: VideoFrame };

function frame(timestamp: number, input = false, overrides: Record<string, unknown> = {}): TestFrame {
  return {
    timestamp, format: input ? 'BGRA' : 'NV12',
    codedWidth: 1920, codedHeight: 1080, displayWidth: 1920, displayHeight: 1080,
    colorSpace: input
      ? { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true }
      : { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
    closes: 0,
    close() { this.closes++; },
    ...overrides,
  } as unknown as TestFrame;
}

function fixture(hooks: {
  draw?(frame: VideoFrame): void;
  prime?(): void;
  prepare?(): void | Promise<void>;
  write?(): void;
  onWritten?(): void;
  onDropped?(): void;
  settleReadOnCancel?: boolean;
} = {}) {
  let time = 0;
  let disposed = false;
  let failureHandler: ((error: unknown) => void) | undefined;
  let waiting: ReturnType<typeof deferred<ReadableStreamReadResult<VideoFrame>>> | undefined;
  const calls = { reads: 0, primes: 0, cancels: 0, releases: 0, disposes: 0 };
  const tasks: { task(): void; cancelled: boolean }[] = [];
  const draws: VideoFrame[] = [];
  const preparedFrames: TestFrame[] = [];
  const writes: { frame: VideoFrame; completion: ReturnType<typeof deferred<void>> }[] = [];
  const written: { writeMs: number; queueAgeMs: number }[] = [];
  const dropped: NativeCanvasFrameDropReason[] = [];
  const failures: unknown[] = [];
  const platform: NativeCanvasFrameSinkPlatform = {
    reader: {
      read() {
        assert.equal(waiting, undefined, 'at most one read may be outstanding');
        calls.reads++;
        waiting = deferred<ReadableStreamReadResult<VideoFrame>>();
        return waiting.promise;
      },
      cancel() {
        calls.cancels++;
        if (hooks.settleReadOnCancel !== false) {
          const current = waiting;
          waiting = undefined;
          current?.resolve({ done: true, value: undefined });
        }
        return Promise.resolve();
      },
      releaseLock() { calls.releases++; },
    },
    prime() { calls.primes++; hooks.prime?.(); },
    draw(input) { draws.push(input); hooks.draw?.(input); },
    async prepare(output, timestamp) {
      await hooks.prepare?.();
      if (disposed) return null;
      const prepared = frame(timestamp);
      prepared.input = output;
      preparedFrames.push(prepared);
      return prepared;
    },
    schedule(task) {
      assert.equal(tasks.filter(value => !value.cancelled).length, 0, 'at most one admission task');
      const entry = { task, cancelled: false };
      tasks.push(entry);
      return () => { entry.cancelled = true; };
    },
    dispose() { disposed = true; calls.disposes++; },
    setFailureHandler(handler) { failureHandler = handler; },
  };
  const sink = createNativeCanvasFrameSink({
    width: 1920, height: 1080, fps: 100,
    now: () => time,
    createPlatform: () => platform,
    writer: {
      write(output) {
        hooks.write?.();
        const completion = deferred();
        writes.push({ frame: output, completion });
        return completion.promise;
      },
    },
    onWritten(writeMs, queueAgeMs) { written.push({ writeMs, queueAgeMs }); hooks.onWritten?.(); },
    onDropped(reason) { dropped.push(reason); hooks.onDropped?.(); },
    onFailure(error) { failures.push(error); },
  });
  return {
    sink, calls, tasks, draws, preparedFrames, writes, written, dropped, failures, platform,
    at(value: number) { time = value; },
    now: () => time,
    reportPlatformFailure(error: unknown) { failureHandler?.(error); },
    submit(timestamp: number) { const input = frame(timestamp, true); return { input, result: sink.submit(input, timestamp) }; },
    emit(output: VideoFrame) {
      assert.ok(waiting, 'reader must be waiting for an output');
      const current = waiting;
      waiting = undefined;
      current.resolve({ done: false, value: output });
    },
    finishRead(error?: unknown) {
      assert.ok(waiting);
      const current = waiting;
      waiting = undefined;
      if (error) current.reject(error);
      else current.resolve({ done: true, value: undefined });
    },
    runTask(includeCancelled = false) {
      let next = tasks.shift();
      while (next?.cancelled && !includeCancelled) next = tasks.shift();
      assert.ok(next, 'an admission must have queued its own task');
      next.task();
    },
    async prime() {
      const black = frame(100);
      this.emit(black);
      assert.equal(await sink.ready, true);
      await flush();
      assert.equal(black.closes, 1);
      return black;
    },
    async output(timestamp: number) {
      const output = frame(timestamp);
      this.emit(output);
      await flush();
      return output;
    },
  };
}

test('prime consumes the initial output before native draw, and admission needs a new task', async t => {
  const f = fixture();
  t.after(() => f.sink.stop());
  assert.deepEqual(f.calls, { reads: 1, primes: 1, cancels: 0, releases: 0, disposes: 0 });
  const first = f.submit(11);
  let result: NativeCanvasFrameResult | undefined;
  void first.result.then(value => { result = value; });
  await flush();
  assert.equal(result, undefined);
  assert.equal(f.tasks.length, 0);
  await f.prime();
  assert.equal(f.draws.length, 0, 'prime/output microtasks must not draw native input');
  assert.equal(f.tasks.length, 1);
  assert.equal(f.writes.length, 0, 'black prime never reaches the generator');
  f.runTask();
  assert.equal(await first.result, 'drawn');
  assert.deepEqual(f.draws, [first.input]);
  assert.equal(first.input.closes, 0);
});

test('draw releases caller input; Canvas output closes before write and the CPU frame waits', async t => {
  const f = fixture();
  t.after(() => f.sink.stop());
  await f.prime();
  const first = f.submit(12_345);
  f.runTask();
  assert.equal(await first.result, 'drawn');
  assert.equal(f.writes.length, 0);
  const output = await f.output(200);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].frame.timestamp, 12_345, 'generator clock must stay on the native clock');
  assert.equal(f.preparedFrames[0].input, output);
  assert.equal(output.closes, 1);
  assert.equal(f.preparedFrames[0].closes, 0);
  assert.equal(first.input.closes, 0);
  f.at(7);
  f.writes[0].completion.resolve();
  await flush();
  assert.equal(output.closes, 1);
  assert.equal(f.preparedFrames[0].closes, 1);
  assert.deepEqual(f.written, [{ writeMs: 7, queueAgeMs: 0 }]);
});

test('a burst retains one newest pending input and waits for write settlement plus a task', async t => {
  const f = fixture();
  t.after(() => f.sink.stop());
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  assert.equal(await first.result, 'drawn');
  const second = f.submit(2);
  f.at(1);
  const third = f.submit(3);
  assert.equal(await second.result, 'superseded');
  assert.equal(second.input.closes, 0);
  await f.output(200);
  assert.equal(f.tasks.length, 0);
  f.at(5);
  f.writes[0].completion.resolve();
  await flush();
  assert.deepEqual(f.draws, [first.input]);
  assert.equal(f.tasks.length, 1);
  f.at(8);
  f.runTask();
  assert.equal(await third.result, 'drawn');
  assert.deepEqual(f.draws, [first.input, third.input]);
  await f.output(300);
  f.writes[1].completion.resolve();
  await flush();
  assert.deepEqual(f.dropped, ['superseded']);
  assert.deepEqual(f.written, [{ writeMs: 4, queueAgeMs: 0 }, { writeMs: 0, queueAgeMs: 7 }]);
});

test('a queued task also keeps one latest frame when multiple arrivals precede the draw', async t => {
  const f = fixture();
  t.after(() => f.sink.stop());
  await f.prime();
  const first = f.submit(1);
  const second = f.submit(2);
  const third = f.submit(3);
  assert.deepEqual(await Promise.all([first.result, second.result]), ['superseded', 'superseded']);
  assert.equal(f.tasks.length, 1);
  f.runTask();
  assert.equal(await third.result, 'drawn');
  assert.deepEqual(f.draws, [third.input]);
  assert.equal(first.input.closes + second.input.closes + third.input.closes, 0);
});

test('pending age starts at arrival and is checked again in the admission task', async t => {
  const f = fixture();
  t.after(() => f.sink.stop());
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  await first.result;
  f.at(5);
  const second = f.submit(2);
  await f.output(200);
  f.at(15);
  f.writes[0].completion.resolve();
  await flush();
  f.at(26);
  f.runTask();
  assert.equal(await second.result, 'expired');
  assert.deepEqual(f.draws, [first.input]);
  assert.deepEqual(f.dropped, ['expired']);
  assert.equal(second.input.closes, 0);
});

test('an input exactly two frame periods old remains admissible', async t => {
  const f = fixture();
  t.after(() => f.sink.stop());
  await f.prime();
  const first = f.submit(1);
  f.at(20);
  f.runTask();
  assert.equal(await first.result, 'drawn');
  await f.output(200);
  f.writes[0].completion.resolve();
  await flush();
  assert.deepEqual(f.written, [{ writeMs: 0, queueAgeMs: 20 }]);
});

test('old, duplicate and prime timestamps never mint capture or write credits', async t => {
  const f = fixture();
  t.after(() => f.sink.stop());
  await f.prime();
  for (const timestamp of [99, 100, 0]) assert.equal((await f.output(timestamp)).closes, 1);
  const first = f.submit(1);
  f.runTask();
  await first.result;
  const second = f.submit(2);
  for (const timestamp of [100, 99]) assert.equal((await f.output(timestamp)).closes, 1);
  assert.equal(f.writes.length, 0);
  await f.output(200);
  for (const timestamp of [200, 100]) assert.equal((await f.output(timestamp)).closes, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.tasks.length, 0);
  assert.deepEqual(f.failures, []);
  f.writes[0].completion.resolve();
  await flush();
  f.runTask();
  assert.equal(await second.result, 'drawn');
  assert.equal(f.draws.length, 2);
});

test('a new timestamp without a drawn request retires the sink and cancels a queued task', async () => {
  const f = fixture();
  await f.prime();
  const pending = f.submit(1);
  const output = await f.output(200);
  assert.equal(await pending.result, 'stopped');
  assert.equal(output.closes, 1);
  assert.equal(f.failures.length, 1);
  assert.equal(f.calls.disposes, 1);
  f.runTask(true);
  assert.equal(f.draws.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(await f.sink.submit(frame(2, true), 2), 'stopped');
});

test('a second new output during a write faults without releasing the in-flight references early', async () => {
  const f = fixture();
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  await first.result;
  const output = await f.output(200);
  const pending = f.submit(2);
  const extra = await f.output(201);
  assert.equal(await pending.result, 'stopped');
  assert.equal(extra.closes, 1);
  assert.equal(output.closes, 1);
  assert.equal(f.preparedFrames[0].closes, 0);
  assert.equal(f.writes.length, 1);
  assert.equal(f.failures.length, 1);
  f.writes[0].completion.resolve();
  await flush();
  assert.equal(output.closes, 1);
  assert.equal(f.preparedFrames[0].closes, 1);
  assert.deepEqual(f.written, []);
  assert.equal(f.tasks.length, 0);
});

test('stop during prime settles queued inputs and late read callbacks cannot revive work', async () => {
  const f = fixture({ settleReadOnCancel: false });
  const pending = f.submit(1);
  f.sink.stop();
  f.sink.stop();
  assert.equal(await f.sink.ready, false);
  assert.equal(await pending.result, 'stopped');
  const late = frame(100);
  f.emit(late);
  await flush();
  assert.equal(late.closes, 1);
  assert.deepEqual(f.calls, { reads: 1, primes: 1, cancels: 1, releases: 1, disposes: 1 });
  assert.equal(f.draws.length + f.writes.length + f.tasks.length, 0);
  assert.deepEqual(f.failures, []);
  assert.equal(pending.input.closes, 0);
});

test('stop preserves writing references through a late successful settlement', async () => {
  const f = fixture();
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  await first.result;
  const output = await f.output(200);
  const pending = f.submit(2);
  const readsBeforeStop = f.calls.reads;
  f.sink.stop();
  assert.equal(await pending.result, 'stopped');
  assert.equal(output.closes, 1);
  assert.equal(f.preparedFrames[0].closes, 0);
  f.writes[0].completion.resolve();
  await flush();
  assert.equal(output.closes + f.preparedFrames[0].closes, 2);
  assert.equal(f.calls.reads, readsBeforeStop);
  assert.deepEqual(f.written, []);
  assert.deepEqual(f.failures, []);
  assert.equal(f.tasks.length, 0);
});

test('late write rejection after stop is consumed and closes references only at settlement', async () => {
  const f = fixture();
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  await first.result;
  const output = await f.output(200);
  f.sink.stop();
  assert.equal(output.closes, 1);
  assert.equal(f.preparedFrames[0].closes, 0);
  f.writes[0].completion.reject(new Error('late writer rejection'));
  await flush();
  assert.equal(output.closes, 1);
  assert.equal(f.preparedFrames[0].closes, 1);
  assert.deepEqual(f.failures, []);
});

test('stop during real copy keeps Canvas output alive, then forbids construction and write', async () => {
  const copy = deferred();
  const f = fixture({ prepare: () => copy.promise });
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  await first.result;
  const output = await f.output(200);
  const pending = f.submit(2);
  assert.equal(output.closes, 0);
  f.sink.stop();
  assert.equal(await pending.result, 'stopped');
  assert.equal(output.closes, 0, 'stop cannot close a copyTo source early');
  copy.resolve();
  await flush();
  assert.equal(output.closes, 1);
  assert.equal(f.preparedFrames.length + f.writes.length + f.tasks.length, 0);
  assert.deepEqual(f.failures, []);
});

test('late copy rejection after stop is consumed and releases the source only at settlement', async () => {
  const copy = deferred();
  const f = fixture({ prepare: () => copy.promise });
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  await first.result;
  const output = await f.output(200);
  f.sink.stop();
  assert.equal(output.closes, 0);
  copy.reject(new Error('private DOM detail'));
  await flush();
  assert.equal(output.closes, 1);
  assert.equal(f.preparedFrames.length + f.writes.length, 0);
  assert.deepEqual(f.failures, []);
});

test('duplicate output during copy grants no credit, while an extra new output retires the sink', async () => {
  const copy = deferred();
  const f = fixture({ prepare: () => copy.promise });
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  await first.result;
  const output = await f.output(200);
  const pending = f.submit(2);
  assert.equal((await f.output(200)).closes, 1);
  assert.deepEqual(f.failures, []);
  assert.equal(f.tasks.length + f.writes.length, 0);
  assert.equal((await f.output(201)).closes, 1);
  assert.equal(await pending.result, 'stopped');
  assert.deepEqual(f.failures.map(getNativeCanvasFrameFailureCode), ['unexpected_output']);
  assert.equal(output.closes, 0);
  copy.resolve();
  await flush();
  assert.equal(output.closes, 1);
  assert.equal(f.writes.length, 0);
});

test('the shared Canvas frame is closed before writer.write is called', async t => {
  let output!: TestFrame;
  const f = fixture({ write() { assert.equal(output.closes, 1); } });
  t.after(() => f.sink.stop());
  await f.prime();
  const first = f.submit(55);
  f.runTask();
  await first.result;
  output = frame(200);
  f.emit(output);
  await flush();
  assert.equal(f.writes.length, 1);
  assert.notEqual(f.writes[0].frame, output);
  assert.equal(f.writes[0].frame.timestamp, 55);
  f.writes[0].completion.resolve();
  await flush();
});

test('reentrant stop during draw, preparation or writer call never starts subsequent work', async () => {
  for (const phase of ['draw', 'prepare', 'write'] as const) {
    let f!: ReturnType<typeof fixture>;
    f = fixture({ [phase]() { f.sink.stop(); } });
    await f.prime();
    const first = f.submit(1);
    f.runTask();
    assert.equal(await first.result, phase === 'draw' ? 'stopped' : 'drawn');
    assert.equal(first.input.closes, 0);
    if (phase !== 'draw') {
      const output = await f.output(200);
      if (phase === 'write') {
        assert.equal(output.closes, 1);
        assert.equal(f.preparedFrames[0].closes, 0);
        f.writes[0].completion.resolve();
        await flush();
      } else {
        assert.equal(f.writes.length, 0);
      }
      assert.equal(output.closes, 1);
      assert.equal(f.preparedFrames[0]?.closes ?? 0, phase === 'prepare' ? 0 : 1);
    }
    assert.equal(f.calls.disposes, 1);
    assert.equal(f.tasks.length, 0);
    assert.deepEqual(f.written, []);
    assert.deepEqual(f.failures, []);
  }
});

test('throwing admission cancellation cannot prevent settling inputs or disposing resources', async () => {
  const f = fixture();
  await f.prime();
  const schedule = f.platform.schedule;
  f.platform.schedule = task => {
    const cancel = schedule(task);
    return () => { cancel(); throw new Error('cancel callback'); };
  };
  const pending = f.submit(1);
  f.sink.stop();
  assert.equal(await pending.result, 'stopped');
  f.runTask(true);
  await flush();
  assert.equal(f.draws.length, 0);
  assert.equal(f.calls.cancels, 1);
  assert.equal(f.calls.disposes, 1);
  assert.deepEqual(f.failures, []);
});

test('write rejection retires once, closes both owned frames and settles queued inputs', async () => {
  const f = fixture();
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  await first.result;
  const output = await f.output(200);
  const pending = f.submit(2);
  const failure = new Error('writer rejection');
  f.writes[0].completion.reject(failure);
  assert.equal(await pending.result, 'stopped');
  await flush();
  assert.deepEqual(f.failures.map(getNativeCanvasFrameFailureCode), ['write_failed']);
  assert.equal(output.closes, 1);
  assert.equal(f.preparedFrames[0].closes, 1);
  assert.equal(f.calls.disposes, 1);
});

test('writer and preparation failures release only module-owned frames', async () => {
  for (const phase of ['write', 'prepare'] as const) {
    const failure = new Error(phase);
    const f = fixture({ [phase]() { throw failure; } });
    await f.prime();
    const first = f.submit(1);
    f.runTask();
    await first.result;
    const output = await f.output(200);
    assert.deepEqual(f.failures.map(getNativeCanvasFrameFailureCode), [phase === 'write' ? 'write_failed' : 'copy_failed']);
    assert.equal(output.closes, 1);
    if (phase === 'write') assert.equal(f.preparedFrames[0].closes, 1);
    assert.equal(first.input.closes, 0);
    assert.equal(f.writes.length, 0);
  }
});

test('draw and prime failures settle submissions without closing input frames', async () => {
  const drawFailure = new Error('draw');
  const f = fixture({ draw() { throw drawFailure; } });
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  assert.equal(await first.result, 'stopped');
  assert.equal(first.input.closes, 0);
  assert.deepEqual(f.failures.map(getNativeCanvasFrameFailureCode), ['capture_failed']);
  const primeFailure = new Error('prime');
  const g = fixture({ prime() { throw primeFailure; } });
  assert.equal(await g.sink.ready, false);
  assert.equal(await g.submit(1).result, 'stopped');
  assert.deepEqual(g.failures.map(getNativeCanvasFrameFailureCode), ['setup_failed']);
});

test('prime timeout retires at the fixed deadline without any native draw', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const pending = f.submit(1);
  t.mock.timers.tick(1499);
  assert.equal(f.failures.length, 0);
  t.mock.timers.tick(1);
  assert.equal(await f.sink.ready, false);
  assert.equal(await pending.result, 'stopped');
  assert.equal(f.failures.length, 1);
  assert.equal(f.calls.disposes, 1);
  assert.equal(f.draws.length, 0);
});

test('stale output does not extend the absolute capture timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  await first.result;
  const pending = f.submit(2);
  t.mock.timers.tick(1000);
  await f.output(100);
  t.mock.timers.tick(500);
  assert.equal(await pending.result, 'stopped');
  assert.equal(f.failures.length, 1);
  assert.equal(f.writes.length, 0);
});

test('capture-through-write timeout never pretends to cancel a GPU write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  await first.result;
  t.mock.timers.tick(500);
  const output = await f.output(200);
  const pending = f.submit(2);
  t.mock.timers.tick(999);
  assert.equal(f.failures.length, 0);
  t.mock.timers.tick(1);
  assert.equal(await pending.result, 'stopped');
  assert.equal(f.failures.length, 1);
  assert.equal(output.closes, 1);
  assert.equal(f.preparedFrames[0].closes, 0);
  f.writes[0].completion.resolve();
  await flush();
  assert.equal(output.closes + f.preparedFrames[0].closes, 2);
  assert.deepEqual(f.written, []);
  assert.equal(f.tasks.length, 0);
});

test('the original draw deadline covers a pending copy and never releases it early', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const copy = deferred();
  const f = fixture({ prepare: () => copy.promise });
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  await first.result;
  t.mock.timers.tick(1000);
  const output = await f.output(200);
  const pending = f.submit(2);
  t.mock.timers.tick(499);
  assert.deepEqual(f.failures, []);
  t.mock.timers.tick(1);
  assert.equal(await pending.result, 'stopped');
  assert.deepEqual(f.failures.map(getNativeCanvasFrameFailureCode), ['copy_timeout']);
  assert.equal(output.closes, 0);
  copy.resolve();
  await flush();
  assert.equal(output.closes, 1);
  assert.equal(f.preparedFrames.length + f.writes.length, 0);
});

test('capture then copy then write share one deadline without stage renewal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const copy = deferred();
  const f = fixture({ prepare: () => copy.promise });
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  await first.result;
  t.mock.timers.tick(500);
  const output = await f.output(200);
  t.mock.timers.tick(600);
  copy.resolve();
  await flush();
  assert.equal(output.closes, 1);
  assert.equal(f.writes.length, 1);
  t.mock.timers.tick(399);
  assert.deepEqual(f.failures, []);
  t.mock.timers.tick(1);
  assert.deepEqual(f.failures.map(getNativeCanvasFrameFailureCode), ['write_timeout']);
  assert.equal(f.preparedFrames[0].closes, 0);
  f.writes[0].completion.resolve();
  await flush();
  assert.equal(f.preparedFrames[0].closes, 1);
  assert.deepEqual(f.written, []);
});

test('input format, geometry, color and timestamp failures retire before admission', async () => {
  for (const override of [
    { format: 'NV12' }, { codedWidth: 1918 }, { displayHeight: 1078 },
    { colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'rgb', fullRange: true } },
    { colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: false } },
    { timestamp: 2 },
  ]) {
    const f = fixture();
    const input = frame(1, true, override);
    assert.equal(await f.sink.submit(input, 1), 'stopped');
    assert.equal(await f.sink.ready, false);
    assert.equal(f.failures.length, 1);
    assert.equal(input.closes, 0);
    assert.equal(f.draws.length + f.tasks.length, 0);
  }
});

test('output format, geometry, color and timestamp failures fail closed, including prime', async () => {
  for (const override of [
    { format: 'I420' }, { codedHeight: 1078 }, { displayWidth: 1918 },
    { colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'smpte170m', fullRange: false } },
    { colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: true } },
    { timestamp: -1 }, { timestamp: NaN },
  ]) {
    const f = fixture();
    const pending = f.submit(1);
    const output = frame(100, false, override);
    f.emit(output);
    assert.equal(await f.sink.ready, false);
    assert.equal(await pending.result, 'stopped');
    assert.equal(output.closes, 1);
    assert.equal(f.failures.length, 1);
    assert.equal(f.writes.length, 0);
  }
});

test('reader rejection and unexpected end retire the sink without fresh work', async () => {
  for (const failure of [undefined, new Error('read failure')]) {
    const f = fixture();
    const pending = f.submit(1);
    f.finishRead(failure);
    assert.equal(await pending.result, 'stopped');
    assert.equal(await f.sink.ready, false);
    assert.equal(f.failures.length, 1);
    assert.equal(f.calls.disposes, 1);
    assert.equal(f.draws.length + f.writes.length, 0);
  }
});

test('onWritten reentrancy replaces pending input while admission still needs a new task', async t => {
  let f!: ReturnType<typeof fixture>;
  let reentrant: ReturnType<typeof f.submit> | undefined;
  f = fixture({ onWritten() { reentrant ??= f.submit(3); } });
  t.after(() => f.sink.stop());
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  await first.result;
  const second = f.submit(2);
  await f.output(200);
  f.writes[0].completion.resolve();
  assert.equal(await second.result, 'superseded');
  await flush();
  assert.equal(f.draws.length, 1);
  assert.equal(f.tasks.length, 1);
  f.runTask();
  assert.equal(await reentrant!.result, 'drawn');
  assert.deepEqual(f.draws.map(value => value.timestamp), [1, 3]);
});

test('diagnostic callback errors retire once and do not strand queued input', async () => {
  for (const phase of ['onWritten', 'onDropped'] as const) {
    const failure = new Error(phase);
    const f = fixture({ [phase]() { throw failure; } });
    await f.prime();
    const first = f.submit(1);
    f.runTask();
    await first.result;
    const pending = f.submit(2);
    if (phase === 'onDropped') {
      const newest = f.submit(3);
      assert.equal(await pending.result, 'superseded');
      assert.equal(await newest.result, 'stopped');
    } else {
      await f.output(200);
      f.writes[0].completion.resolve();
      assert.equal(await pending.result, 'stopped');
    }
    assert.deepEqual(f.failures.map(getNativeCanvasFrameFailureCode), ['callback_failed']);
    assert.equal(f.calls.disposes, 1);
  }
});

test('invalid geometry or rate fails before creating any browser resources', () => {
  let factories = 0;
  for (const override of [
    { width: 1 }, { width: 1919 }, { width: NaN }, { height: 1079 },
    { fps: 0 }, { fps: -1 }, { fps: Infinity }, { fps: NaN },
  ]) {
    assert.throws(() => createNativeCanvasFrameSink({
      width: 1920, height: 1080, fps: 120, ...override,
      writer: { write: async () => {} },
      createPlatform() { factories++; throw new Error('should not run'); },
    }), RangeError);
  }
  assert.equal(factories, 0);
});

function preparationFixture(hooks: { construct?(): void; bytes?: number } = {}) {
  const copies: { buffer: ArrayBuffer; completion: ReturnType<typeof deferred<PlaneLayout[]>> }[] = [];
  const constructed: { buffer: ArrayBuffer; init: VideoFrameBufferInit; bytes: number[]; frame: TestFrame }[] = [];
  const preparer = createNativeCanvasCpuFramePreparer(4, 4, (buffer, init) => {
    hooks.construct?.();
    const result = frame(init.timestamp, false, {
      codedWidth: init.codedWidth, codedHeight: init.codedHeight,
      displayWidth: init.displayWidth, displayHeight: init.displayHeight,
    });
    constructed.push({ buffer, init, bytes: Array.from(new Uint8Array(buffer)), frame: result });
    return result;
  });
  const source = frame(100, false, {
    codedWidth: 4, codedHeight: 4, displayWidth: 4, displayHeight: 4,
    allocationSize(...args: unknown[]) {
      assert.equal(args.length, 0, 'allocationSize keeps the actual format');
      return hooks.bytes ?? 24;
    },
    copyTo(...args: unknown[]) {
      assert.equal(args.length, 1, 'copyTo must omit format/conversion options');
      assert.ok(args[0] instanceof ArrayBuffer);
      const buffer = args[0];
      new Uint8Array(buffer).fill(77 + copies.length);
      const completion = deferred<PlaneLayout[]>();
      copies.push({ buffer, completion });
      return completion.promise;
    },
  });
  const layout = [{ offset: 0, stride: 4 }, { offset: 16, stride: 4 }];
  return { preparer, source, copies, constructed, layout };
}

test('CPU preparation constructs from raw bytes with native media timestamp and actual NV12 layout', async () => {
  const f = preparationFixture();
  const preparing = f.preparer.prepare(f.source, 9_876_543);
  assert.equal(f.constructed.length, 0);
  assert.equal(f.source.closes, 0);
  f.copies[0].completion.resolve(f.layout);
  const prepared = await preparing;
  assert.equal(prepared, f.constructed[0].frame);
  assert.notEqual(prepared, f.source);
  const { buffer, init, bytes } = f.constructed[0];
  assert.equal(buffer, f.copies[0].buffer);
  assert.equal(buffer.byteLength, 24, 'ordinary reusable AB remains attached');
  assert.deepEqual(init, {
    format: 'NV12', codedWidth: 4, codedHeight: 4, displayWidth: 4, displayHeight: 4,
    timestamp: 9_876_543, layout: f.layout,
    colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
  });
  assert.ok(!('transfer' in init), 'constructor performs its CPU copy so the AB can be reused');
  assert.deepEqual(bytes, Array(24).fill(77));
  assert.equal(f.source.closes, 0, 'the sink, rather than the preparer, closes the Canvas source');
  f.preparer.dispose();
  assert.deepEqual(Array.from(new Uint8Array(buffer)), Array(24).fill(0));
  assert.deepEqual(bytes, Array(24).fill(77), 'the simulated CPU constructor copied independently');
});

test('one ordinary AB is reused only after each real copy and CPU construction settles', async () => {
  const f = preparationFixture();
  const first = f.preparer.prepare(f.source, 1);
  await assert.rejects(f.preparer.prepare(f.source, 2), error => getNativeCanvasFrameFailureCode(error) === 'copy_failed');
  assert.equal(f.copies.length, 1);
  f.copies[0].completion.resolve(f.layout);
  await first;
  const second = f.preparer.prepare(f.source, 2);
  assert.equal(f.copies[1].buffer, f.copies[0].buffer);
  f.copies[1].completion.resolve(f.layout);
  await second;
  assert.deepEqual(f.constructed[0].bytes, Array(24).fill(77));
  assert.deepEqual(f.constructed[1].bytes, Array(24).fill(78));
  f.preparer.dispose();
});

test('preparer disposal cannot erase a pending destination or construct after late copy success', async () => {
  const f = preparationFixture();
  const preparing = f.preparer.prepare(f.source, 1);
  const buffer = f.copies[0].buffer;
  f.preparer.dispose();
  f.preparer.dispose();
  assert.deepEqual(Array.from(new Uint8Array(buffer)), Array(24).fill(77));
  assert.equal(await f.preparer.prepare(f.source, 2), null);
  assert.equal(f.copies.length, 1);
  f.copies[0].completion.resolve(f.layout);
  assert.equal(await preparing, null);
  assert.equal(f.constructed.length, 0);
  assert.deepEqual(Array.from(new Uint8Array(buffer)), Array(24).fill(0));
  assert.equal(f.source.closes, 0);
});

test('late rejected copy erases a retired destination only after real rejection', async () => {
  const f = preparationFixture();
  const preparing = f.preparer.prepare(f.source, 1);
  const buffer = f.copies[0].buffer;
  f.preparer.dispose();
  assert.equal(new Uint8Array(buffer)[0], 77);
  f.copies[0].completion.reject(new Error('sensitive DOM internals'));
  await assert.rejects(preparing, error => {
    assert.equal(getNativeCanvasFrameFailureCode(error), 'copy_failed');
    assert.equal((error as Error).message, 'copy_failed');
    return true;
  });
  assert.deepEqual(Array.from(new Uint8Array(buffer)), Array(24).fill(0));
  assert.equal(f.constructed.length, 0);
});

test('CPU constructor failure is reported safely without pretending construction succeeded', async () => {
  const f = preparationFixture({ construct() { throw new Error('private constructor failure'); } });
  const preparing = f.preparer.prepare(f.source, 1);
  f.copies[0].completion.resolve(f.layout);
  await assert.rejects(preparing, error => getNativeCanvasFrameFailureCode(error) === 'copy_failed');
  assert.equal(f.constructed.length, 0);
  assert.equal(f.source.closes, 0);
  f.preparer.dispose();
  assert.equal(new Uint8Array(f.copies[0].buffer)[0], 0);
});

test('disposal reentrancy during a CPU constructor closes its result and returns no frame', async () => {
  let f!: ReturnType<typeof preparationFixture>;
  f = preparationFixture({ construct() { f.preparer.dispose(); } });
  const preparing = f.preparer.prepare(f.source, 1);
  f.copies[0].completion.resolve(f.layout);
  assert.equal(await preparing, null);
  assert.equal(f.constructed[0].frame.closes, 1);
  assert.equal(new Uint8Array(f.copies[0].buffer)[0], 0);
});

test('padded NV12 planes preserve their offsets and strides in the CPU constructor', async () => {
  const f = preparationFixture({ bytes: 40 });
  const layout = [{ offset: 4, stride: 6 }, { offset: 28, stride: 6 }];
  const preparing = f.preparer.prepare(f.source, 1);
  f.copies[0].completion.resolve(layout);
  await preparing;
  assert.deepEqual(f.constructed[0].init.layout, layout);
  assert.equal(f.constructed[0].buffer.byteLength, 40);
  f.preparer.dispose();
});

test('invalid NV12 plane count, stride, offset, overlap and extent are rejected before construction', async () => {
  for (const layout of [
    [], [{ offset: 0, stride: 4 }],
    [{ offset: 0, stride: 4 }, { offset: 16, stride: 4 }, { offset: 20, stride: 4 }],
    [{ offset: -1, stride: 4 }, { offset: 16, stride: 4 }],
    [{ offset: NaN, stride: 4 }, { offset: 16, stride: 4 }],
    [{ offset: 0.5, stride: 4 }, { offset: 16, stride: 4 }],
    [{ offset: 0, stride: 3 }, { offset: 16, stride: 4 }],
    [{ offset: 0, stride: 4 }, { offset: 16, stride: 3 }],
    [{ offset: 0, stride: 4 }, { offset: 15, stride: 4 }],
    [{ offset: 0, stride: 4 }, { offset: 17, stride: 4 }],
    [{ offset: 0, stride: Number.MAX_SAFE_INTEGER }, { offset: 16, stride: 4 }],
  ]) {
    const f = preparationFixture();
    const preparing = f.preparer.prepare(f.source, 1);
    f.copies[0].completion.resolve(layout);
    await assert.rejects(preparing, error => getNativeCanvasFrameFailureCode(error) === 'output_contract');
    assert.equal(f.constructed.length, 0);
    f.preparer.dispose();
  }
});

test('unsafe, undersized, geometry-excessive or over-16MiB allocations never start a copy', async () => {
  for (const bytes of [0, 23, 24.5, NaN, Infinity, 65, 16 * 1024 * 1024 + 1, Number.MAX_SAFE_INTEGER]) {
    const f = preparationFixture({ bytes });
    await assert.rejects(f.preparer.prepare(f.source, 1), error => getNativeCanvasFrameFailureCode(error) === 'output_contract');
    assert.equal(f.copies.length + f.constructed.length, 0);
    f.preparer.dispose();
  }
  assert.throws(() => createNativeCanvasCpuFramePreparer(4096, 4096), RangeError);
});

test('exported CPU preparation enforces format, geometry and color before copy', async () => {
  for (const overrides of [
    { format: 'I420' }, { codedWidth: 6 }, { displayHeight: 2 },
    { colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'smpte170m', fullRange: false } },
  ]) {
    const f = preparationFixture();
    Object.assign(f.source, overrides);
    await assert.rejects(f.preparer.prepare(f.source, 1), error => getNativeCanvasFrameFailureCode(error) === 'output_contract');
    assert.equal(f.copies.length, 0);
    f.preparer.dispose();
  }
});

test('diagnostics expose fixed codes without raw DOM messages or runtime-injected code strings', async () => {
  const f = fixture({ prepare() { throw new Error('private DOM message with sensitive content'); } });
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  await first.result;
  await f.output(200);
  assert.equal((f.failures[0] as Error).message, 'copy_failed');
  assert.equal(getNativeCanvasFrameFailureCode(f.failures[0]), 'copy_failed');
  assert.equal(getNativeCanvasFrameFailureCode(new Error('private message')), 'unknown');
  const error = new NativeCanvasFrameSinkError('write_failed');
  Object.assign(error, { code: 'untrusted arbitrary message' });
  assert.equal(getNativeCanvasFrameFailureCode(error), 'unknown');
});

const emptyStageStats = {
  totalDrawMs: 0, maxDrawMs: 0, capturesCompleted: 0, totalCaptureMs: 0,
  maxCaptureMs: 0, totalCopyMs: 0, maxCopyMs: 0,
  admissionDeferrals: 0, minObservedAdmissionGapMs: null,
};

test('snapshot starts with zero counters and is detached, frozen and entirely flat', async () => {
  const f = fixture();
  const initial = f.sink.snapshot();
  assert.deepEqual(initial, {
    ...emptyStageStats,
    phase: 'prime', inputs: 0, draws: 0, rawOutputs: 0, primedOutputs: 0,
    duplicateOutputs: 0, regressedOutputs: 0, copiesCompleted: 0, writesCompleted: 0,
    pendingInputs: 0, admissionTaskPending: false, failureCode: null, failurePhase: null,
  });
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(Reflect.set(initial, 'inputs', 99), false);
  assert.equal(Reflect.set(initial, 'frame', frame(99)), false);
  assert.ok(Object.values(initial).every(value => value === null || ['number', 'string', 'boolean'].includes(typeof value)));
  assert.notEqual(f.sink.snapshot(), initial);
  await f.prime();
  assert.equal(initial.rawOutputs, 0, 'earlier snapshots cannot change when live counters change');
  assert.equal(initial.phase, 'prime');
  assert.deepEqual({ ...f.sink.snapshot(), rawOutputs: 0, primedOutputs: 0, phase: 'prime' }, initial);
  f.sink.stop();
});

test('snapshot distinguishes queued admission, capture, copy, write and successful idle', async () => {
  const copy = deferred();
  const f = fixture({ prepare: () => copy.promise });
  await f.prime();
  assert.equal(f.sink.snapshot().phase, 'idle');
  const first = f.submit(123_456_789);
  assert.equal(f.sink.snapshot().pendingInputs, 1);
  assert.equal(f.sink.snapshot().admissionTaskPending, true);
  assert.equal(f.sink.snapshot().draws, 0);
  f.runTask();
  await first.result;
  assert.equal(f.sink.snapshot().phase, 'capture');
  assert.equal(f.sink.snapshot().draws, 1);
  assert.equal(f.sink.snapshot().pendingInputs, 0);
  assert.equal(f.sink.snapshot().admissionTaskPending, false);
  await f.output(200);
  assert.equal(f.sink.snapshot().phase, 'copy');
  assert.equal(f.sink.snapshot().copiesCompleted, 0);
  copy.resolve();
  await flush();
  assert.equal(f.sink.snapshot().phase, 'write');
  assert.equal(f.sink.snapshot().copiesCompleted, 1);
  assert.equal(f.sink.snapshot().writesCompleted, 0);
  f.writes[0].completion.resolve();
  await flush();
  assert.deepEqual(f.sink.snapshot(), {
    ...emptyStageStats, capturesCompleted: 1,
    phase: 'idle', inputs: 1, draws: 1, rawOutputs: 2, primedOutputs: 1,
    duplicateOutputs: 0, regressedOutputs: 0, copiesCompleted: 1, writesCompleted: 1,
    pendingInputs: 0, admissionTaskPending: false, failureCode: null, failurePhase: null,
  });
  assert.equal(JSON.stringify(f.sink.snapshot()).includes('123456789'), false, 'no native timestamp may appear');
  f.sink.stop();
});

test('failure snapshot separates duplicate and regressed output from a missing output', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  await f.prime();
  const first = f.submit(1);
  f.runTask();
  await first.result;
  await f.output(100);
  await f.output(99);
  const pending = f.submit(2);
  t.mock.timers.tick(1500);
  assert.equal(await pending.result, 'stopped');
  const snapshot = f.sink.snapshot();
  assert.deepEqual(snapshot, {
    ...emptyStageStats,
    phase: 'stopped', inputs: 2, draws: 1, rawOutputs: 3, primedOutputs: 1,
    duplicateOutputs: 1, regressedOutputs: 1, copiesCompleted: 0, writesCompleted: 0,
    pendingInputs: 0, admissionTaskPending: false, failureCode: 'capture_timeout', failurePhase: 'capture',
  });
  assert.equal(Object.isFrozen(snapshot), true);
});

test('stop cancels queued admission in snapshot and a late task never adds draws', async () => {
  const f = fixture();
  await f.prime();
  const pending = f.submit(1);
  assert.equal(f.sink.snapshot().admissionTaskPending, true);
  f.sink.stop();
  assert.equal(await pending.result, 'stopped');
  const terminal = f.sink.snapshot();
  assert.equal(terminal.phase, 'stopped');
  assert.equal(terminal.pendingInputs, 0);
  assert.equal(terminal.admissionTaskPending, false);
  f.runTask(true);
  assert.deepEqual(f.sink.snapshot(), terminal);
});

test('late successful copy and write settlement do not add live completion counters', async () => {
  for (const stage of ['copy', 'write'] as const) {
    const copy = deferred();
    const f = fixture(stage === 'copy' ? { prepare: () => copy.promise } : {});
    await f.prime();
    const first = f.submit(1);
    f.runTask();
    await first.result;
    await f.output(200);
    f.sink.stop();
    const terminal = f.sink.snapshot();
    if (stage === 'copy') copy.resolve();
    else f.writes[0].completion.resolve();
    await flush();
    assert.deepEqual(f.sink.snapshot(), terminal);
    assert.equal(terminal.copiesCompleted, stage === 'copy' ? 0 : 1);
    assert.equal(terminal.writesCompleted, 0);
    assert.equal(terminal.failureCode, null);
    assert.equal(terminal.failurePhase, null);
  }
});

test('late delivered output is counted without changing terminal phase or preparing work', async () => {
  const f = fixture({ settleReadOnCancel: false });
  f.sink.stop();
  const terminal = f.sink.snapshot();
  const late = frame(100);
  f.emit(late);
  await flush();
  assert.equal(late.closes, 1);
  assert.deepEqual(f.sink.snapshot(), { ...terminal, rawOutputs: 1 });
  assert.equal(terminal.rawOutputs, 0, 'a saved failure snapshot remains detached');
  assert.equal(f.writes.length + f.preparedFrames.length, 0);
});

function admissionFixture(hooks: {
  postTask?(): void;
  setTimer?(): void;
  onFailure?(error: unknown): void;
} = {}) {
  let time = 0;
  let nextTimer = 0;
  let maxTasks = 0;
  let maxTimers = 0;
  const tasks: number[] = [];
  const timers = new Map<number, { callback(): void; delayMs: number }>();
  const firedTimers: (() => void)[] = [];
  const failures: unknown[] = [];
  const scheduler = createNativeCanvasAdmissionScheduler({
    now: () => time,
    postTask(id) {
      hooks.postTask?.();
      tasks.push(id);
      maxTasks = Math.max(maxTasks, tasks.length);
      assert.equal(timers.size, 0, 'task and delay timer must not overlap');
    },
    setTimer(callback, delayMs) {
      hooks.setTimer?.();
      const id = ++nextTimer;
      timers.set(id, { callback, delayMs });
      maxTimers = Math.max(maxTimers, timers.size);
      assert.equal(tasks.length, 0, 'a delayed admission must no longer have a posted task');
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    onFailure(error) { failures.push(error); hooks.onFailure?.(error); },
  });
  return {
    scheduler, tasks, timers, firedTimers, failures,
    at(value: number) { time = value; },
    now: () => time,
    bounds() { return { maxTasks, maxTimers }; },
    runTask() {
      assert.equal(tasks.length, 1);
      scheduler.dispatch(tasks.shift());
    },
    fireTimer() {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value!;
      timers.delete(id);
      firedTimers.push(timer.callback);
      timer.callback();
      return timer;
    },
  };
}

test('Browser admission gate delays prime-adjacent input until 2 ms without losing its one task', () => {
  const f = admissionFixture();
  let draws = 0;
  f.scheduler.noteOutput(); // The actual black-prime reader delivery.
  f.at(0.25);
  f.scheduler.schedule(() => { draws++; });
  assert.equal(draws, 0);
  f.runTask();
  assert.equal(draws, 0);
  assert.equal(f.timers.size, 1);
  assert.equal(f.tasks.length, 0);
  f.at(2);
  f.fireTimer();
  assert.equal(draws, 0, 'a timer only posts the original MessageChannel admission');
  f.runTask();
  assert.equal(draws, 1);
  assert.deepEqual(f.bounds(), { maxTasks: 1, maxTimers: 1 });
  assert.deepEqual(f.scheduler.snapshot(), { deferrals: 1, minObservedGapMs: 2 });
  assert.equal(f.timers.size + f.tasks.length, 0);
});

test('Browser admission gate also protects input less than 1 ms after a later output', () => {
  const f = admissionFixture();
  const drawTimes: number[] = [];
  f.scheduler.noteOutput();
  f.at(8.33);
  f.scheduler.schedule(() => { drawTimes.push(f.now()); });
  f.runTask();
  assert.equal(f.timers.size, 0, 'ordinary 120 fps admission needs no delay');
  f.at(8.8);
  f.scheduler.noteOutput();
  f.at(9.1);
  f.scheduler.schedule(() => { drawTimes.push(f.now()); });
  f.runTask();
  assert.equal(drawTimes.length, 1);
  f.at(10.8);
  f.fireTimer();
  f.runTask();
  assert.deepEqual(drawTimes, [8.33, 10.8]);
  assert.deepEqual(f.bounds(), { maxTasks: 1, maxTimers: 1 });
});

test('Browser admission gate rechecks an early timer and late output before drawing', () => {
  const f = admissionFixture();
  let draws = 0;
  f.scheduler.noteOutput();
  f.scheduler.schedule(() => { draws++; });
  f.runTask();
  f.at(1.5);
  const early = f.fireTimer();
  assert.equal(early.delayMs, 2);
  assert.equal(f.timers.size, 0, 'an early timer must return to a MessageChannel task');
  assert.equal(f.tasks.length, 1);
  f.runTask();
  assert.equal(f.timers.size, 1);
  assert.equal(f.tasks.length + draws, 0);
  f.at(2);
  f.fireTimer();
  assert.equal(f.tasks.length, 1);
  // Another actual delivery can move the boundary while that task is queued.
  f.at(2.1);
  f.scheduler.noteOutput();
  f.runTask();
  assert.equal(draws, 0);
  f.at(4.1);
  f.fireTimer();
  f.runTask();
  assert.equal(draws, 1);
  assert.deepEqual(f.bounds(), { maxTasks: 1, maxTimers: 1 });
});

test('Browser admission cancellation and stop prevent late timer or port callbacks from drawing', () => {
  for (const stop of [false, true]) {
    const f = admissionFixture();
    let draws = 0;
    f.scheduler.noteOutput();
    const cancel = f.scheduler.schedule(() => { draws++; });
    const id = f.tasks[0];
    f.runTask();
    const callback = f.timers.values().next().value!.callback;
    if (stop) f.scheduler.stop();
    else cancel();
    assert.equal(f.timers.size, 0);
    f.at(100);
    callback();
    f.scheduler.dispatch(id);
    assert.equal(draws, 0);
    assert.equal(f.tasks.length + f.timers.size, 0);
    f.scheduler.stop();
    f.scheduler.stop();
    assert.throws(() => f.scheduler.schedule(() => { draws++; }));
  }
});

test('Browser admission stop also guards an already posted port task', () => {
  const f = admissionFixture();
  let draws = 0;
  f.scheduler.schedule(() => { draws++; });
  f.scheduler.stop();
  f.runTask();
  assert.equal(draws, 0);
  assert.equal(f.tasks.length + f.timers.size, 0);
});

test('Browser admission has one task or timer, and output deliveries never create admission credits', () => {
  const f = admissionFixture();
  let draws = 0;
  for (let index = 0; index < 20; index++) {
    f.at(index * 8.33);
    f.scheduler.noteOutput();
    assert.equal(f.tasks.length + f.timers.size, 0);
    f.scheduler.schedule(() => { draws++; });
    assert.throws(() => f.scheduler.schedule(() => { draws++; }));
    f.runTask();
    assert.throws(() => f.scheduler.schedule(() => { draws++; }));
    f.at(index * 8.33 + 2.001);
    f.fireTimer();
    assert.equal(f.timers.size, 0);
    f.runTask();
    assert.equal(draws, index + 1);
    assert.equal(f.tasks.length + f.timers.size, 0);
  }
  assert.deepEqual(f.bounds(), { maxTasks: 1, maxTimers: 1 });
  f.scheduler.stop();
});

test('asynchronous admission transport failures stop the sink once and release its pending input', async () => {
  for (const stage of ['setTimer', 'timerPost'] as const) {
    const f = fixture();
    await f.prime();
    let posts = 0;
    const a = admissionFixture({
      setTimer() { if (stage === 'setTimer') throw new Error('private timer failure'); },
      postTask() { if (++posts === 2 && stage === 'timerPost') throw new Error('private post failure'); },
      onFailure: error => f.reportPlatformFailure(error),
    });
    const dispose = f.platform.dispose;
    f.platform.dispose = () => { a.scheduler.stop(); dispose(); };
    f.platform.schedule = a.scheduler.schedule;
    f.platform.admissionSnapshot = a.scheduler.snapshot;
    a.scheduler.noteOutput();
    const pending = f.submit(1);
    a.runTask();
    let lateTimer: (() => void) | undefined;
    if (stage === 'timerPost') {
      lateTimer = a.timers.values().next().value!.callback;
      a.at(2);
      a.fireTimer();
    }
    assert.equal(await pending.result, 'stopped');
    assert.deepEqual(f.failures.map(getNativeCanvasFrameFailureCode), ['capture_failed']);
    assert.deepEqual(a.failures.map(getNativeCanvasFrameFailureCode), ['capture_failed']);
    assert.equal((f.failures[0] as Error).message, 'capture_failed');
    assert.equal(f.calls.disposes, 1);
    assert.equal(f.sink.snapshot().failureCode, 'capture_failed');
    assert.equal(f.sink.snapshot().failurePhase, 'idle');
    assert.equal(f.sink.snapshot().admissionDeferrals, 1);
    assert.equal(f.sink.snapshot().pendingInputs, 0);
    assert.equal(f.sink.snapshot().admissionTaskPending, false);
    lateTimer?.();
    a.scheduler.dispatch(1);
    f.sink.stop();
    assert.equal(f.draws.length + f.writes.length + a.tasks.length + a.timers.size, 0);
    assert.equal(f.failures.length, 1, 'late callbacks cannot report the same fault again');
    assert.equal(pending.input.closes, 0, 'the caller still owns the discarded input');
  }
});

test('an early timer always rechecks and re-arms from a port task rather than another timer', () => {
  const f = admissionFixture();
  let draws = 0;
  f.scheduler.noteOutput();
  f.scheduler.schedule(() => { draws++; });
  f.runTask();
  for (let index = 0; index < 8; index++) {
    f.at(index / 10);
    f.fireTimer();
    assert.equal(f.timers.size, 0);
    assert.equal(f.tasks.length, 1);
    assert.equal(draws, 0);
    f.runTask();
    assert.equal(f.timers.size, 1);
  }
  f.at(2);
  f.fireTimer();
  f.runTask();
  assert.equal(draws, 1);
  assert.deepEqual(f.bounds(), { maxTasks: 1, maxTimers: 1 });
  assert.equal(f.scheduler.snapshot().deferrals, 9);
});

test('bounded timings distinguish synchronous draw, fast capture and slow CPU preparation', async () => {
  const copies = [deferred(), deferred()];
  let copyIndex = 0;
  let drawCost = 1.5;
  let f!: ReturnType<typeof fixture>;
  f = fixture({
    draw() { f.at(f.now() + drawCost); },
    prepare: () => copies[copyIndex++].promise,
  });
  await f.prime();
  assert.equal(f.sink.snapshot().capturesCompleted, 0, 'prime is excluded from capture timings');
  f.at(10);
  const first = f.submit(1);
  f.runTask();
  await first.result;
  f.at(12);
  await f.output(200);
  assert.equal(f.sink.snapshot().capturesCompleted, 1);
  assert.equal(f.sink.snapshot().totalCaptureMs, 2);
  assert.equal(f.sink.snapshot().copiesCompleted, 0);
  f.at(42);
  copies[0].resolve();
  await flush();
  f.at(42.25);
  f.writes[0].completion.resolve();
  await flush();
  assert.equal(f.sink.snapshot().totalDrawMs, 1.5);
  assert.equal(f.sink.snapshot().totalCopyMs, 30);
  assert.equal(f.written[0].writeMs, 0.25, 'writer timing stays separate from CPU prepare');

  drawCost = 0.1;
  f.at(50);
  const second = f.submit(2);
  f.runTask();
  await second.result;
  f.at(50.5);
  await f.output(300);
  f.at(51.5);
  copies[1].resolve();
  await flush();
  f.at(51.75);
  f.writes[1].completion.resolve();
  await flush();
  const snapshot = f.sink.snapshot();
  assert.equal(snapshot.capturesCompleted, 2);
  assert.equal(snapshot.copiesCompleted, 2);
  assert.equal(snapshot.writesCompleted, 2);
  for (const [actual, expected] of [
    [snapshot.totalDrawMs, 1.6], [snapshot.maxDrawMs, 1.5],
    [snapshot.totalCaptureMs, 2.5], [snapshot.maxCaptureMs, 2],
    [snapshot.totalCopyMs, 31], [snapshot.maxCopyMs, 30],
  ]) assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, received ${actual}`);
  assert.equal(Object.isFrozen(snapshot), true);
  f.sink.stop();
});
