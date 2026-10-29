import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeWorkerFrameSink, type NativeFrameWorkerPort } from '../src/features/media/screen/nativeWorkerFrameSink';
import type { NativeFrameWorkerCommand } from '../src/features/media/screen/nativeFrameWorkerProtocol';

class FakeWorker extends EventTarget implements NativeFrameWorkerPort {
  posts: { message: NativeFrameWorkerCommand; transfer: Transferable[] }[] = [];
  terminations = 0;
  throwType = '';
  postMessage(message: NativeFrameWorkerCommand, transfer: Transferable[]) {
    if (message.type === this.throwType) throw new Error('Deliberate transfer failure');
    this.posts.push({ message, transfer });
  }
  terminate() { this.terminations++; }
  emit(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })); }
}

function fixture(worker = new FakeWorker()) {
  let nextTimer = 0;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  const writes: unknown[] = [];
  const drops: string[] = [];
  const failures: string[] = [];
  const writable = new WritableStream<VideoFrame>();
  const sink = createNativeWorkerFrameSink({
    writable, width: 1920, height: 1080, fps: 120, startupTimeoutMs: 700,
    generation: 'generation-1', createWorker: () => worker,
    schedule(callback, delayMs) { const id = ++nextTimer; timers.set(id, { callback, delayMs }); return id as unknown as ReturnType<typeof setTimeout>; },
    unschedule(timer) { timers.delete(timer as unknown as number); },
    onWritten: value => writes.push(value), onDropped: value => drops.push(value), onFailure: value => failures.push(value),
  });
  function fire(delayMs: number) {
    const timer = [...timers].find(([, value]) => value.delayMs === delayMs);
    assert.ok(timer, `Expected ${delayMs} ms timer`);
    timers.delete(timer[0]); timer[1].callback();
  }
  const frame = () => ({ close() {} }) as unknown as VideoFrame;
  function emit(type: string, extra: Record<string, unknown> = {}) { worker.emit({ type, generation: 'generation-1', ...extra }); }
  const written = (sequence: number, extra: Record<string, unknown> = {}) => emit('ack', {
    sequence, result: 'written', timing: { writeMs: 2, queueAgeMs: 3, idleMs: 4 }, ...extra,
  });
  return { worker, sink, writable, writes, drops, failures, timers, frame, emit, written, fire };
}

test('transfers the unlocked writable once and requires Worker readiness', async () => {
  const f = fixture();
  assert.equal(f.worker.posts.length, 1);
  assert.equal(f.worker.posts[0].message.type, 'init');
  assert.deepEqual(f.worker.posts[0].transfer, [f.writable]);
  assert.equal(f.writable.locked, false, 'Fake port must never call getWriter in Window');
  assert.equal(await f.sink.submit(f.frame()), 'superseded');
  assert.equal(f.worker.posts.length, 1);
  f.emit('ready'); await f.sink.ready;
  assert.equal(f.timers.size, 0);
  const frame = f.frame();
  const submitted = f.sink.submit(frame);
  assert.equal(f.worker.posts[1].message.type, 'frame');
  assert.deepEqual(f.worker.posts[1].transfer, [frame]);
  f.written(1);
  assert.equal(await submitted, 'written');
  assert.deepEqual(f.writes, [{ writeMs: 2, queueAgeMs: 3, idleMs: 4 }]);
  assert.equal(f.sink.snapshot().acknowledged, 1);
  assert.equal(f.sink.snapshot().beforeReadyDrops, 1);
  f.sink.stop(); f.emit('stopped');
  assert.equal(f.worker.terminations, 1); assert.equal(f.timers.size, 0);
});

test('caps outstanding transferred frames at the unchanged three-slot pool', async () => {
  const f = fixture(); f.emit('ready'); await f.sink.ready;
  const pending = [f.sink.submit(f.frame()), f.sink.submit(f.frame()), f.sink.submit(f.frame())];
  assert.equal(await f.sink.submit(f.frame()), 'superseded');
  assert.equal(f.worker.posts.length, 4, 'One init plus at most three transferred frames');
  assert.equal(f.sink.snapshot().maxPending, 3); assert.equal(f.sink.snapshot().capacityDrops, 1);
  f.emit('ack', { sequence: 2, result: 'superseded' });
  f.written(1); f.written(3);
  assert.deepEqual(await Promise.all(pending), ['written', 'superseded', 'written']);
  assert.equal(f.timers.size, 0);
  f.sink.stop(); f.fire(250);
});

test('isolates other generations, duplicate ACKs and late ACKs after stop', async () => {
  const f = fixture(); f.emit('ready'); await f.sink.ready;
  const first = f.sink.submit(f.frame());
  f.worker.emit({ type: 'failed', generation: 'older-generation', reason: 'write' });
  f.written(1); assert.equal(await first, 'written'); f.written(1);
  assert.equal(f.writes.length, 1); assert.equal(f.sink.snapshot().ignoredMessages, 2);
  const second = f.sink.submit(f.frame()); f.sink.stop();
  assert.equal(await second, 'stopped');
  f.written(2); f.emit('ready');
  assert.equal(f.writes.length, 1); assert.deepEqual(f.failures, []);
  f.emit('stopped'); f.emit('stopped'); f.sink.stop();
  assert.equal(f.worker.terminations, 1); assert.equal(f.timers.size, 0);
});

test('readiness timeout fails once and bounded termination does not wait for a Worker', async () => {
  const f = fixture();
  f.fire(700);
  await assert.rejects(f.sink.ready, /timeout/);
  assert.deepEqual(f.failures, ['timeout']);
  assert.equal(f.sink.snapshot().failure, 'timeout');
  assert.equal(await f.sink.submit(f.frame()), 'stopped');
  assert.equal(f.worker.posts.at(-1)?.message.type, 'stop');
  f.fire(250); assert.equal(f.worker.terminations, 1); assert.equal(f.timers.size, 0);
});

test('cancel before readiness synchronously settles and removes its startup timer', async () => {
  const f = fixture(); f.sink.stop();
  await assert.rejects(f.sink.ready, /stopped/);
  assert.equal(f.sink.snapshot().state, 'stopping');
  assert.deepEqual(f.failures, []);
  f.emit('ready'); assert.equal(f.sink.snapshot().state, 'stopping');
  f.emit('stopped'); assert.equal(f.timers.size, 0);
});

test('stalled write ACK fails boundedly, settling all waiters and discarding late results', async () => {
  const f = fixture(); f.emit('ready'); await f.sink.ready;
  const submissions = [f.sink.submit(f.frame()), f.sink.submit(f.frame())];
  f.fire(1500);
  assert.deepEqual(await Promise.all(submissions), ['stopped', 'stopped']);
  assert.equal(f.sink.snapshot().pending, 0); assert.deepEqual(f.failures, ['timeout']);
  f.written(1); f.worker.dispatchEvent(new Event('error'));
  assert.equal(f.writes.length, 0); assert.deepEqual(f.failures, ['timeout']);
  f.fire(250); assert.equal(f.timers.size, 0);
});

test('rejects malformed current ACK timing without reporting a successful write', async () => {
  for (const timing of [undefined, { writeMs: -1, queueAgeMs: 0, idleMs: 0 }, { writeMs: NaN, queueAgeMs: 0, idleMs: 0 }]) {
    const f = fixture(); f.emit('ready'); await f.sink.ready;
    const pending = f.sink.submit(f.frame()); f.written(1, { timing });
    assert.equal(await pending, 'stopped'); assert.equal(f.writes.length, 0);
    assert.deepEqual(f.failures, ['protocol']); f.fire(250);
  }
});

test('Worker init rejection, event errors and fixed failures remain bounded', async () => {
  for (const event of ['error', 'messageerror', 'init-failure'] as const) {
    const f = fixture();
    if (event === 'init-failure') f.emit('failed', { reason: 'init' });
    else f.worker.dispatchEvent(new Event(event));
    await assert.rejects(f.sink.ready);
    assert.equal(f.failures.length, 1); f.fire(250);
    assert.equal(f.timers.size, 0);
  }
});

test('postMessage failures cannot leave readiness or frame ACK waiters alive', async () => {
  const worker = new FakeWorker(); worker.throwType = 'init';
  assert.throws(() => fixture(worker), /init/); assert.equal(worker.terminations, 1);
  const f = fixture(); f.emit('ready'); await f.sink.ready;
  f.worker.throwType = 'frame';
  assert.equal(await f.sink.submit(f.frame()), 'stopped');
  assert.deepEqual(f.failures, ['message']); f.fire(250);
  assert.equal(f.timers.size, 0);
});

test('invalid setup and locked writable are rejected before Worker construction', () => {
  let created = 0;
  const options = { writable: new WritableStream<VideoFrame>(), width: 1920, height: 1080, fps: 120,
    startupTimeoutMs: 1500, onWritten() {}, onDropped() {}, onFailure() {},
    createWorker() { created++; return new FakeWorker(); } };
  assert.throws(() => createNativeWorkerFrameSink({ ...options, startupTimeoutMs: 0 }));
  assert.throws(() => createNativeWorkerFrameSink({ ...options, startupTimeoutMs: 1501 }));
  assert.throws(() => createNativeWorkerFrameSink({ ...options, width: 99999 }));
  const writer = options.writable.getWriter();
  assert.throws(() => createNativeWorkerFrameSink(options)); writer.releaseLock();
  assert.equal(created, 0);
});
