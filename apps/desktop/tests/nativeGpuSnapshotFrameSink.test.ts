import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNativeGpuSnapshotFrameSink,
  getNativeGpuSnapshotFrameFailureCode,
  NativeGpuSnapshotFrameSinkError,
  type NativeGpuSnapshotFramePlatform,
} from '../src/features/media/screen/nativeGpuSnapshotFrameSink';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function flush() { for (let index = 0; index < 8; ++index) await Promise.resolve(); }

type Frame = VideoFrame & { closes: number };
function frame(timestamp: number, overrides: Record<string, unknown> = {}): Frame {
  return {
    timestamp, format: 'BGRA', codedWidth: 1920, codedHeight: 1080,
    displayWidth: 1920, displayHeight: 1080, closes: 0,
    close() { this.closes++; }, ...overrides,
  } as unknown as Frame;
}
type Timer = { callback(): void; milliseconds: number; cleared: boolean };
function fixture(hooks: {
  snapshot?(input: VideoFrame, timestamp: number): VideoFrame | void;
  write?(output: VideoFrame): void;
  onWritten?(): void;
  onDropped?(): void;
  onFailure?(): void;
  setTimer?(): void;
} = {}) {
  let time = 0, disposes = 0;
  const snapshots: { input: VideoFrame; output: Frame; timestamp: number }[] = [];
  const writes: { frame: VideoFrame; completion: ReturnType<typeof deferred> }[] = [];
  const written: { writeMs: number; queueAgeMs: number }[] = [];
  const dropped: string[] = [];
  const failures: unknown[] = [];
  const timers: Timer[] = [];
  const platform: NativeGpuSnapshotFramePlatform = {
    snapshot(input, timestamp) {
      const output = (hooks.snapshot?.(input, timestamp) ?? frame(timestamp)) as Frame;
      snapshots.push({ input, output, timestamp });
      return output;
    },
    dispose() { disposes++; },
  };
  const sink = createNativeGpuSnapshotFrameSink({
    width: 1920, height: 1080, fps: 100, now: () => time,
    createPlatform: () => platform,
    writer: { write(output) {
      hooks.write?.(output);
      const completion = deferred(); writes.push({ frame: output, completion });
      return completion.promise;
    } },
    setTimer(callback, milliseconds) {
      const timer: Timer = { callback, milliseconds, cleared: false }; timers.push(timer);
      hooks.setTimer?.(); return timer;
    },
    clearTimer(handle) { (handle as Timer).cleared = true; },
    onWritten(writeMs, queueAgeMs) { written.push({ writeMs, queueAgeMs }); hooks.onWritten?.(); },
    onDropped(reason) { dropped.push(reason); hooks.onDropped?.(); },
    onFailure(error) { failures.push(error); hooks.onFailure?.(); },
  });
  return {
    sink, snapshots, writes, written, dropped, failures, timers,
    at(value: number) { time = value; }, disposes: () => disposes,
    submit(timestamp: number, overrides: Record<string, unknown> = {}) {
      const input = frame(timestamp, overrides); return { input, result: sink.submit(input, timestamp) };
    },
  };
}

test('source settles after its independent snapshot while the real write still owns the output', async t => {
  const f = fixture(); t.after(() => f.sink.stop());
  const first = f.submit(10);
  assert.equal(await first.result, 'snapshotted');
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.writes.length, 1);
  assert.notEqual(f.writes[0].frame, first.input);
  assert.equal(f.writes[0].frame.timestamp, 10);
  assert.equal(first.input.closes, 0, 'the caller alone owns the imported input');
  assert.equal(f.snapshots[0].output.closes, 0, 'callback settlement is not write completion');
  assert.equal(f.sink.snapshot().writeActive, true);
  assert.equal(f.sink.snapshot().writesCompleted, 0);
  f.at(7); f.writes[0].completion.resolve(); await flush();
  assert.equal(f.snapshots[0].output.closes, 1);
  assert.equal(f.sink.snapshot().writesCompleted, 1);
  assert.deepEqual(f.written, [{ writeMs: 7, queueAgeMs: 0 }]);
});

test('one active output and one latest original input bound a burst without making unused snapshots', async t => {
  const f = fixture(); t.after(() => f.sink.stop());
  const first = f.submit(1); await first.result;
  f.at(1); const second = f.submit(2);
  f.at(2); const third = f.submit(3);
  assert.equal(await second.result, 'superseded');
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.sink.snapshot().pendingInputs, 1);
  assert.equal(second.input.closes, 0);
  f.at(8); f.writes[0].completion.resolve();
  assert.equal(await third.result, 'snapshotted');
  assert.deepEqual(f.snapshots.map(value => value.timestamp), [1, 3]);
  assert.equal(f.writes.length, 2);
  assert.equal(f.sink.snapshot().pendingInputs, 0);
  assert.equal(third.input.closes, 0);
  assert.deepEqual(f.dropped, ['superseded']);
  f.at(11); f.writes[1].completion.resolve(); await flush();
  assert.deepEqual(f.written, [{ writeMs: 8, queueAgeMs: 0 }, { writeMs: 3, queueAgeMs: 6 }]);
});

test('pending age expires before snapshot and the exact two-period boundary remains admissible', async t => {
  const expired = fixture(); t.after(() => expired.sink.stop());
  await expired.submit(1).result;
  expired.at(5); const pending = expired.submit(2);
  expired.at(26); expired.writes[0].completion.resolve();
  assert.equal(await pending.result, 'expired');
  assert.equal(expired.snapshots.length, 1);
  assert.deepEqual(expired.dropped, ['expired']);
  assert.equal(pending.input.closes, 0);
  const exact = fixture(); t.after(() => exact.sink.stop());
  await exact.submit(1).result;
  exact.at(5); const admitted = exact.submit(2);
  exact.at(25); exact.writes[0].completion.resolve();
  assert.equal(await admitted.result, 'snapshotted');
  assert.equal(exact.snapshots.length, 2);
  exact.writes[1].completion.resolve(); await flush();
});

test('stop settles only pending source ownership and late write completion closes once without promotion', async () => {
  const f = fixture(); await f.submit(1).result;
  const pending = f.submit(2);
  f.sink.stop(); f.sink.stop();
  assert.equal(await pending.result, 'stopped');
  assert.equal(f.disposes(), 1);
  assert.equal(f.snapshots[0].output.closes, 0);
  assert.equal(pending.input.closes, 0);
  assert.equal(await f.submit(3).result, 'stopped');
  f.writes[0].completion.resolve(); await flush();
  assert.equal(f.snapshots[0].output.closes, 1);
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.sink.snapshot().writesCompleted, 0);
  assert.deepEqual(f.written, []);
});

test('late rejection after stop is observed without reporting or reviving the retired generation', async () => {
  const f = fixture(); await f.submit(1).result;
  f.sink.stop(); f.writes[0].completion.reject(new Error('private')); await flush();
  assert.equal(f.snapshots[0].output.closes, 1);
  assert.deepEqual(f.failures, []);
  assert.equal(f.disposes(), 1);
});

test('write timeout retires admission but does not close a still-owned output or invent a completion', async () => {
  const f = fixture(); await f.submit(1).result;
  const pending = f.submit(2);
  const deadline = f.timers.find(timer => !timer.cleared)!;
  assert.equal(deadline.milliseconds, 1500);
  deadline.callback(); deadline.callback();
  assert.equal(await pending.result, 'stopped');
  assert.equal(f.failures.length, 1);
  assert.equal(getNativeGpuSnapshotFrameFailureCode(f.failures[0]), 'write_timeout');
  assert.equal(f.snapshots[0].output.closes, 0);
  assert.equal(f.sink.snapshot().writesCompleted, 0);
  f.writes[0].completion.resolve(); await flush();
  assert.equal(f.snapshots[0].output.closes, 1);
  assert.equal(f.snapshots.length, 1);
  assert.deepEqual(f.written, []);
});

test('snapshot wall time shares the same completion budget and a timed-out snapshot is never written', async t => {
  let partial!: ReturnType<typeof fixture>;
  partial = fixture({ snapshot() { partial.at(150); } }); t.after(() => partial.sink.stop());
  await partial.submit(1).result;
  assert.equal(partial.timers.find(timer => !timer.cleared)?.milliseconds, 1350);
  assert.equal(partial.sink.snapshot().totalSnapshotMs, 150);
  assert.equal(partial.sink.snapshot().maxSnapshotMs, 150);
  partial.writes[0].completion.resolve(); await flush();
  let timeout!: ReturnType<typeof fixture>;
  timeout = fixture({ snapshot() { timeout.at(1500); } }); t.after(() => timeout.sink.stop());
  const source = timeout.submit(1);
  assert.equal(await source.result, 'stopped');
  assert.equal(timeout.snapshots[0].output.closes, 1);
  assert.equal(source.input.closes, 0);
  assert.equal(timeout.writes.length, 0);
  assert.equal(getNativeGpuSnapshotFrameFailureCode(timeout.failures[0]), 'snapshot_timeout');
});

test('time spent setting up the deadline cannot admit a writer after the absolute budget expires', async () => {
  let f!: ReturnType<typeof fixture>;
  f = fixture({ setTimer() { f.at(1500); } });
  const source = f.submit(1);
  assert.equal(await source.result, 'snapshotted', 'the source snapshot really completed before the delay');
  assert.equal(f.writes.length, 0);
  assert.equal(f.snapshots[0].output.closes, 1);
  assert.equal(source.input.closes, 0);
  assert.equal(f.sink.snapshot().writesCompleted, 0);
  assert.equal(getNativeGpuSnapshotFrameFailureCode(f.failures[0]), 'write_timeout');
  assert.equal(f.timers[0].cleared, true);
  f.timers[0].callback();
  assert.equal(f.failures.length, 1);
  f.sink.stop();
});

test('snapshot and synchronous writer failures settle callbacks and close only owned outputs', async t => {
  const snapshot = fixture({ snapshot() { throw new Error('private'); } }); t.after(() => snapshot.sink.stop());
  const original = snapshot.submit(1);
  assert.equal(await original.result, 'stopped');
  assert.equal(original.input.closes, 0);
  assert.equal(snapshot.writes.length, 0);
  assert.equal(getNativeGpuSnapshotFrameFailureCode(snapshot.failures[0]), 'snapshot_failed');
  const writer = fixture({ write() { throw new Error('private'); } }); t.after(() => writer.sink.stop());
  const snapshotted = writer.submit(2); await snapshotted.result;
  assert.equal(writer.snapshots[0].output.closes, 1);
  assert.equal(snapshotted.input.closes, 0);
  assert.equal(writer.writes.length, 0);
  assert.equal(getNativeGpuSnapshotFrameFailureCode(writer.failures[0]), 'write_failed');
});

test('asynchronous write rejection closes once, stops pending input and exposes only a fixed failure code', async () => {
  const f = fixture(); await f.submit(1).result;
  const pending = f.submit(2);
  f.writes[0].completion.reject(new Error('private credentials')); await flush();
  assert.equal(await pending.result, 'stopped');
  assert.equal(f.snapshots[0].output.closes, 1);
  assert.equal(f.failures.length, 1);
  assert.equal(getNativeGpuSnapshotFrameFailureCode(f.failures[0]), 'write_failed');
  assert.equal(JSON.stringify(f.sink.snapshot()).includes('private'), false);
  assert.equal(f.sink.snapshot().writesCompleted, 0);
  f.sink.stop();
});

test('source timestamps and geometry are validated before a snapshot; equal timestamps preserve the source value', async t => {
  for (const overrides of [{ timestamp: -1 }, { displayWidth: 1280 }, { codedHeight: 720 }]) {
    const f = fixture(); t.after(() => f.sink.stop());
    const input = f.submit(1, overrides);
    assert.equal(await input.result, 'stopped');
    assert.equal(f.snapshots.length, 0);
    assert.equal(input.input.closes, 0);
    assert.equal(getNativeGpuSnapshotFrameFailureCode(f.failures[0]), 'input_contract');
  }
  const f = fixture(); t.after(() => f.sink.stop());
  await f.submit(10).result;
  const same = f.submit(10); f.writes[0].completion.resolve();
  assert.equal(await same.result, 'snapshotted');
  assert.equal(f.snapshots[1].output.timestamp, 10);
  f.writes[1].completion.resolve(); await flush();
  assert.equal(await f.submit(9).result, 'stopped');
  assert.equal(getNativeGpuSnapshotFrameFailureCode(f.failures[0]), 'input_contract');
  for (const timestamp of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = fixture(); t.after(() => invalid.sink.stop());
    const input = invalid.submit(timestamp);
    assert.equal(await input.result, 'stopped');
    assert.equal(invalid.snapshots.length, 0);
    assert.equal(getNativeGpuSnapshotFrameFailureCode(invalid.failures[0]), 'input_contract');
  }
});

test('snapshot must be a separate correctly timestamped frame and an aliased input is never closed', async t => {
  for (const overrides of [{ timestamp: 99 }, { codedWidth: 1280 }, { displayHeight: 720 }]) {
    const f = fixture({ snapshot(_input, timestamp) { return frame(timestamp, overrides); } });
    t.after(() => f.sink.stop());
    const input = f.submit(1);
    assert.equal(await input.result, 'stopped');
    assert.equal(f.snapshots[0].output.closes, 1);
    assert.equal(input.input.closes, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(getNativeGpuSnapshotFrameFailureCode(f.failures[0]), 'output_contract');
  }
  const alias = fixture({ snapshot(input) { return input; } }); t.after(() => alias.sink.stop());
  const input = alias.submit(1);
  assert.equal(await input.result, 'stopped');
  assert.equal(input.input.closes, 0);
  assert.equal(alias.writes.length, 0);
  assert.equal(getNativeGpuSnapshotFrameFailureCode(alias.failures[0]), 'output_contract');
});

test('stale timer callbacks cannot fail a subsequent output', async t => {
  const f = fixture(); t.after(() => f.sink.stop());
  await f.submit(1).result;
  const previousDeadline = f.timers[0];
  f.writes[0].completion.resolve(); await flush();
  assert.equal(previousDeadline.cleared, true);
  await f.submit(2).result;
  previousDeadline.callback();
  assert.equal(f.failures.length, 0);
  assert.equal(f.sink.snapshot().writeActive, true);
  f.writes[1].completion.resolve(); await flush();
  assert.equal(f.sink.snapshot().writesCompleted, 2);
});

test('reentrant onWritten submission retains the latest pending input and cannot start parallel writes', async t => {
  let reentrant: ReturnType<ReturnType<typeof fixture>['submit']> | undefined;
  let f!: ReturnType<typeof fixture>;
  f = fixture({ onWritten() { if (!reentrant) reentrant = f.submit(3); } }); t.after(() => f.sink.stop());
  await f.submit(1).result;
  const oldPending = f.submit(2);
  f.writes[0].completion.resolve(); await flush();
  assert.equal(await oldPending.result, 'superseded');
  assert.equal(await reentrant!.result, 'snapshotted');
  assert.deepEqual(f.snapshots.map(value => value.timestamp), [1, 3]);
  assert.equal(f.writes.length, 2);
  f.writes[1].completion.resolve(); await flush();
});

test('stop reentered during snapshot closes its unsubmitted output and leaves source ownership with caller', async () => {
  let f!: ReturnType<typeof fixture>;
  f = fixture({ snapshot(_input, timestamp) { f.sink.stop(); return frame(timestamp); } });
  const input = f.submit(1);
  assert.equal(await input.result, 'stopped');
  assert.equal(f.snapshots[0].output.closes, 1);
  assert.equal(input.input.closes, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.disposes(), 1);
});

test('observer failures cannot strand callbacks and the fixed-code whitelist does not leak arbitrary text', async () => {
  const f = fixture({ onFailure() { throw new Error('private'); }, write() { throw new Error('private'); } });
  await f.submit(1).result;
  assert.equal(f.snapshots[0].output.closes, 1);
  assert.equal(await f.submit(2).result, 'stopped');
  assert.equal(getNativeGpuSnapshotFrameFailureCode(new Error('write_failed')), 'unknown');
  assert.equal(getNativeGpuSnapshotFrameFailureCode(new NativeGpuSnapshotFrameSinkError('write_timeout')), 'write_timeout');
  f.sink.stop();
});

test('onWritten and onDropped faults settle the latest pending input and stop further admission', async t => {
  const written = fixture({ onWritten() { throw new Error('private'); } }); t.after(() => written.sink.stop());
  await written.submit(1).result;
  const waiting = written.submit(2);
  written.writes[0].completion.resolve(); await flush();
  assert.equal(await waiting.result, 'stopped');
  assert.equal(getNativeGpuSnapshotFrameFailureCode(written.failures[0]), 'callback_failed');
  assert.equal(written.snapshots.length, 1);
  const dropped = fixture({ onDropped() { throw new Error('private'); } }); t.after(() => dropped.sink.stop());
  await dropped.submit(1).result;
  const superseded = dropped.submit(2);
  const latest = dropped.submit(3);
  assert.equal(await superseded.result, 'superseded');
  assert.equal(await latest.result, 'stopped');
  assert.equal(getNativeGpuSnapshotFrameFailureCode(dropped.failures[0]), 'callback_failed');
  assert.equal(dropped.snapshots[0].output.closes, 0);
  dropped.writes[0].completion.resolve(); await flush();
  assert.equal(dropped.snapshots[0].output.closes, 1);
});
