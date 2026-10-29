import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNativeFrameWorkerRuntime,
  type NativeFrameWorkerFrame,
} from '../src/features/media/screen/nativeFrameWorkerRuntime';
import type { NativeFrameWorkerEvent } from '../src/features/media/screen/nativeFrameWorkerProtocol';

const generation = 'runtime-test-generation';
type Ack = Extract<NativeFrameWorkerEvent, { type: 'ack' }>;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Only promise reactions advance here. No real clock, timers, browser or GPU is used.
async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

class FakeFrame implements NativeFrameWorkerFrame {
  closes = 0;
  readonly codedWidth: number;
  readonly codedHeight: number;
  constructor(
    readonly displayWidth = 1920,
    readonly displayHeight = 1080,
    readonly timestamp: number | null = 0,
    codedPadding = 0,
  ) {
    this.codedWidth = displayWidth + codedPadding;
    this.codedHeight = displayHeight + codedPadding;
  }
  close() { this.closes++; }
}

function fixture() {
  let time = 0;
  let getWriterError: unknown;
  let writeError: unknown;
  let abortError: unknown;
  let postFailures = 0;
  let acquisitions = 0;
  let aborts = 0;
  let releases = 0;
  let writerLocked = false;
  const events: NativeFrameWorkerEvent[] = [];
  const postAttempts: NativeFrameWorkerEvent[] = [];
  const writes: { frame: FakeFrame; completion: ReturnType<typeof deferred> }[] = [];
  const abort = deferred();
  const writer = {
    write(frame: FakeFrame) {
      if (writeError !== undefined) throw writeError;
      const completion = deferred();
      writes.push({ frame, completion });
      return completion.promise;
    },
    abort() {
      aborts++;
      if (abortError !== undefined) throw abortError;
      return abort.promise;
    },
    releaseLock() { releases++; writerLocked = false; },
  };
  const writable = {
    getWriter() {
      acquisitions++;
      if (getWriterError !== undefined) throw getWriterError;
      if (writerLocked) throw new TypeError('writer already acquired');
      writerLocked = true;
      return writer;
    },
  };
  const runtime = createNativeFrameWorkerRuntime<FakeFrame>({
    now: () => time,
    isFrame: (value: unknown): value is FakeFrame => value instanceof FakeFrame,
    post(event) {
      postAttempts.push(event);
      if (postFailures > 0) { postFailures--; throw new Error('post failed'); }
      events.push(event);
    },
  });
  const init = (overrides: Record<string, unknown> = {}) => runtime.handleMessage({
    type: 'init', generation, writable, width: 1920, height: 1080, fps: 120, ...overrides,
  });
  const send = (frame: unknown, sequence = 1, overrides: Record<string, unknown> = {}) => runtime.handleMessage({
    type: 'frame', generation, sequence, frame, ...overrides,
  });
  return {
    runtime, init, send, events, postAttempts, writes, abort, writer, writable,
    acks: () => events.filter((event): event is Ack => event.type === 'ack'),
    failures: () => events.filter(event => event.type === 'failed'),
    counts: () => ({ acquisitions, aborts, releases }),
    at(value: number) { time = value; },
    throwGetWriter(error = new Error('getWriter failed')) { getWriterError = error; },
    throwWrite(error = new Error('write failed synchronously')) { writeError = error; },
    throwAbort(error = new Error('abort failed synchronously')) { abortError = error; },
    failPosts(count = 1) { postFailures = count; },
  };
}

function assertFailure(f: ReturnType<typeof fixture>, reason: 'init' | 'protocol' | 'write' | 'message') {
  assert.deepEqual(f.failures(), [{ type: 'failed', generation, reason }]);
}

test('init accepts the host geometry boundaries and all three supported frame rates', async () => {
  for (const [width, height, fps] of [[2, 2, 30], [1920, 1080, 60], [4096, 2560, 120]]) {
    const f = fixture();
    const longestGeneration = 'g'.repeat(96);
    f.init({ generation: longestGeneration, width, height, fps });
    assert.deepEqual(f.events, [{ type: 'ready', generation: longestGeneration }]);
    assert.deepEqual(f.counts(), { acquisitions: 1, aborts: 0, releases: 0 });
    f.runtime.stop();
    f.abort.resolve();
    await flush();
    assert.deepEqual(f.events.at(-1), { type: 'stopped', generation: longestGeneration });
  }
});

test('invalid init geometry, rate or writable fails before accepting frames', async () => {
  const invalid = [
    ...[0, 1, -1, 1.5, 4097, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1920'].map(width => ({ width })),
    ...[0, 1, -1, 1.5, 2561, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1080'].map(height => ({ height })),
    ...[0, -1, NaN, Infinity, Number.MIN_VALUE, 29, 30.1, 100, 240, 1000, '120'].map(fps => ({ fps })),
    { writable: null }, { writable: {} }, { writable: { getWriter: 1 } },
    { unexpected: 'must not be forwarded' },
  ];
  for (const value of invalid) {
    const f = fixture();
    assert.doesNotThrow(() => f.init(value));
    assertFailure(f, 'init');
    assert.equal(f.writes.length, 0);
    assert.equal(f.events.some(event => event.type === 'ready'), false);
    const late = new FakeFrame();
    f.send(late);
    assert.equal(late.closes, 1);
    await flush();
    assert.equal(f.acks().length, 0);
  }
});

test('invalid generation closes the runtime without echoing invalid input', async () => {
  for (const invalid of ['', 'g'.repeat(97), null, 42, {}, undefined]) {
    const f = fixture();
    f.init({ generation: invalid });
    f.init();
    const late = new FakeFrame();
    f.send(late);
    f.runtime.stop();
    await flush();
    assert.deepEqual(f.postAttempts, []);
    assert.equal(f.counts().aborts, 1);
    assert.equal(late.closes, 1);
    f.abort.resolve();
    await flush();
    assert.equal(f.counts().releases, 1);
  }
});

test('getWriter throwing fails init without leaking or trying to release an unacquired writer', async () => {
  const f = fixture();
  f.throwGetWriter();
  assert.doesNotThrow(() => f.init());
  await flush();
  assertFailure(f, 'init');
  assert.deepEqual(f.counts(), { acquisitions: 1, aborts: 0, releases: 0 });
  assert.equal(f.events.some(event => event.type === 'ready'), false);
});

test('duplicate init retains the original generation and cleans both independently acquired writers', async () => {
  const f = fixture();
  let secondAcquisitions = 0;
  let secondAborts = 0;
  let secondReleases = 0;
  f.init();
  f.init({ generation: 'replacement-generation', writable: { getWriter() {
    secondAcquisitions++;
    return {
      write: async () => {}, abort: async () => { secondAborts++; }, releaseLock() { secondReleases++; },
    };
  } } });
  assertFailure(f, 'protocol');
  assert.equal(secondAcquisitions, 1);
  assert.equal(secondAborts, 1);
  assert.deepEqual(f.counts(), { acquisitions: 1, aborts: 1, releases: 0 });
  f.abort.resolve();
  await flush();
  assert.deepEqual(f.counts(), { acquisitions: 1, aborts: 1, releases: 1 });
  assert.equal(secondReleases, 1);
  assert.deepEqual(f.events.at(-1), { type: 'stopped', generation });
});

test('repeated init with the already acquired writable cannot abort or release its writer twice', async () => {
  const f = fixture();
  f.init();
  f.init(); f.init();
  assertFailure(f, 'protocol');
  assert.deepEqual(f.counts(), { acquisitions: 1, aborts: 1, releases: 0 });
  f.abort.resolve();
  await flush();
  assert.deepEqual(f.counts(), { acquisitions: 1, aborts: 1, releases: 1 });
});

test('frame ACK and wrapper close wait for the active write promise', async () => {
  const f = fixture();
  f.init();
  const frame = new FakeFrame();
  f.send(frame);
  assert.deepEqual(f.writes.map(entry => entry.frame), [frame]);
  await flush();
  assert.equal(frame.closes, 0);
  assert.deepEqual(f.acks(), []);
  f.at(7);
  f.writes[0].completion.resolve();
  assert.deepEqual(f.acks(), []);
  await flush();
  assert.equal(frame.closes, 1);
  assert.deepEqual(f.acks(), [{ type: 'ack', generation, sequence: 1, result: 'written', timing: { writeMs: 7, queueAgeMs: 0, idleMs: 0 } }]);
});

test('burst supersedes only the waiting frame and drains the newest frame', async () => {
  const f = fixture();
  f.init();
  const frames = [new FakeFrame(), new FakeFrame(), new FakeFrame()];
  f.send(frames[0], 1);
  f.at(1); f.send(frames[1], 2);
  f.at(2); f.send(frames[2], 3);
  assert.equal(frames[1].closes, 0);
  assert.deepEqual(f.acks(), []);
  await flush();
  assert.equal(frames[1].closes, 1);
  assert.deepEqual(f.acks(), [{ type: 'ack', generation, sequence: 2, result: 'superseded' }]);
  f.at(9); f.writes[0].completion.resolve();
  await flush();
  assert.deepEqual(f.writes.map(entry => entry.frame), [frames[0], frames[2]]);
  f.at(14); f.writes[1].completion.resolve();
  await flush();
  assert.deepEqual(frames.map(frame => frame.closes), [1, 1, 1]);
  assert.deepEqual(f.acks().filter(event => event.result === 'written').map(event => ({ sequence: event.sequence, timing: event.timing })), [
    { sequence: 1, timing: { writeMs: 9, queueAgeMs: 0, idleMs: 0 } },
    { sequence: 3, timing: { writeMs: 5, queueAgeMs: 7, idleMs: 0 } },
  ]);
});

test('pending frames expire after two frame periods and exact boundary age remains valid', async () => {
  const limit = 2000 / 60;
  for (const age of [limit, limit + 0.001]) {
    const f = fixture();
    f.init({ fps: 60 });
    const first = new FakeFrame(), pending = new FakeFrame();
    f.send(first, 1);
    f.send(pending, 2);
    f.at(age); f.writes[0].completion.resolve();
    await flush();
    if (age === limit) {
      assert.deepEqual(f.writes.map(entry => entry.frame), [first, pending]);
      f.writes[1].completion.resolve();
      await flush();
      assert.equal(f.acks().find(event => event.sequence === 2)?.result, 'written');
    } else {
      assert.deepEqual(f.writes.map(entry => entry.frame), [first]);
      assert.deepEqual(f.acks().find(event => event.sequence === 2), { type: 'ack', generation, sequence: 2, result: 'expired' });
    }
    assert.equal(pending.closes, 1);
  }
});

test('the held-frame cap includes a superseded promise before its close microtask', async () => {
  const f = fixture();
  f.init();
  const frames = [new FakeFrame(), new FakeFrame(), new FakeFrame(), new FakeFrame()];
  frames.forEach((frame, index) => f.send(frame, index + 1));
  assertFailure(f, 'protocol');
  assert.deepEqual(frames.map(frame => frame.closes), [1, 1, 1, 1]);
  assert.equal(f.writes.length, 1);
  assert.equal(f.counts().aborts, 1);
  f.writes[0].completion.resolve();
  f.abort.resolve();
  await flush();
  assert.deepEqual(frames.map(frame => frame.closes), [1, 1, 1, 1]);
  assert.equal(f.acks().some(event => event.result === 'written'), false);
});

test('settled superseded wrappers release capacity after their close microtask', async () => {
  const f = fixture();
  f.init();
  const frames = [new FakeFrame(), new FakeFrame(), new FakeFrame(), new FakeFrame()];
  f.send(frames[0], 1); f.send(frames[1], 2); f.send(frames[2], 3);
  await flush();
  f.send(frames[3], 4);
  await flush();
  assert.deepEqual(f.failures(), []);
  f.writes[0].completion.resolve();
  await flush();
  assert.deepEqual(f.writes.map(entry => entry.frame), [frames[0], frames[3]]);
  f.writes[1].completion.resolve();
  await flush();
  assert.deepEqual(frames.map(frame => frame.closes), [1, 1, 1, 1]);
});

test('frame validation closes branded malformed frames and seals the runtime', async () => {
  const malformed = [
    () => ({ frame: new FakeFrame(1919, 1080) }),
    () => ({ frame: new FakeFrame(1920, 1079) }),
    ...[null, -1, NaN, Infinity, '0'].map(timestamp => () => ({ frame: new FakeFrame(1920, 1080, timestamp as number) })),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(sequence => () => ({ frame: new FakeFrame(), sequence })),
    () => ({ frame: new FakeFrame(), generation: 'stale-generation' }),
  ];
  for (const create of malformed) {
    const f = fixture();
    f.init();
    const value = create();
    f.runtime.handleMessage({ type: 'frame', generation, sequence: 1, ...value });
    assertFailure(f, 'protocol');
    assert.equal(value.frame.closes, 1);
    assert.equal(f.writes.length, 0);
    const late = new FakeFrame();
    f.send(late, 2);
    assert.equal(late.closes, 1);
    f.abort.resolve();
    await flush();
    assert.deepEqual(f.acks(), []);
  }
});

test('the injected brand predicate rejects frame-shaped plain objects', async () => {
  const f = fixture();
  f.init();
  f.send({ displayWidth: 1920, displayHeight: 1080, timestamp: 0, close() {} });
  assertFailure(f, 'protocol');
  assert.equal(f.writes.length, 0);
  f.abort.resolve();
  await flush();
});

test('sequences must increase across written and dropped frames', async () => {
  for (const duplicate of [1, 2]) {
    const f = fixture();
    f.init();
    const first = new FakeFrame(), second = new FakeFrame(), repeated = new FakeFrame();
    f.send(first, 1); f.send(second, 2);
    f.send(repeated, duplicate);
    assertFailure(f, 'protocol');
    assert.deepEqual([first, second, repeated].map(frame => frame.closes), [1, 1, 1]);
    f.abort.resolve();
    await flush();
  }
});

test('stop closes active and pending wrappers synchronously before abort settles', async () => {
  const f = fixture();
  f.init();
  const active = new FakeFrame(), pending = new FakeFrame();
  f.send(active, 1); f.send(pending, 2);
  f.runtime.stop(); f.runtime.stop();
  assert.deepEqual([active.closes, pending.closes], [1, 1]);
  assert.deepEqual(f.counts(), { acquisitions: 1, aborts: 1, releases: 0 });
  await flush();
  assert.equal(f.events.some(event => event.type === 'stopped'), false);
  assert.deepEqual(f.acks(), [
    { type: 'ack', generation, sequence: 1, result: 'stopped' },
    { type: 'ack', generation, sequence: 2, result: 'stopped' },
  ]);
  const late = new FakeFrame();
  const postsBeforeLate = f.postAttempts.length;
  f.send(late, 3);
  assert.equal(late.closes, 1);
  assert.equal(f.postAttempts.length, postsBeforeLate);
  f.abort.resolve();
  await flush();
  assert.deepEqual(f.counts(), { acquisitions: 1, aborts: 1, releases: 1 });
  assert.deepEqual(f.events.at(-1), { type: 'stopped', generation });
  f.writes[0].completion.resolve();
  await flush();
  assert.deepEqual([active.closes, pending.closes], [1, 1]);
  assert.equal(f.writes.length, 1);
  assert.equal(f.events.filter(event => event.type === 'stopped').length, 1);
});

test('late write rejection after stop is consumed without write failure or a second close', async () => {
  const f = fixture();
  f.init();
  const frame = new FakeFrame();
  f.send(frame);
  f.runtime.stop();
  f.writes[0].completion.reject(new Error('late native failure'));
  f.abort.resolve();
  await flush();
  assert.equal(frame.closes, 1);
  assert.deepEqual(f.failures(), []);
  assert.equal(f.acks().some(event => event.result === 'written'), false);
  assert.equal(f.counts().releases, 1);
});

test('abort rejection and synchronous abort throw still release the lock and report stopped', async () => {
  for (const synchronous of [false, true]) {
    const f = fixture();
    f.init();
    if (synchronous) f.throwAbort();
    assert.doesNotThrow(() => f.runtime.stop());
    if (!synchronous) f.abort.reject(new Error('abort rejected'));
    await flush();
    assert.deepEqual(f.counts(), { acquisitions: 1, aborts: 1, releases: 1 });
    assert.deepEqual(f.events.at(-1), { type: 'stopped', generation });
    f.runtime.stop();
    assert.equal(f.counts().releases, 1);
  }
});

test('synchronous and asynchronous write failures close all held frames and report once', async () => {
  for (const synchronous of [false, true]) {
    const f = fixture();
    f.init();
    const frames = [new FakeFrame(), new FakeFrame()];
    if (synchronous) f.throwWrite();
    assert.doesNotThrow(() => f.send(frames[0], 1));
    f.send(frames[1], 2);
    if (!synchronous) f.writes[0].completion.reject(new Error('write rejected'));
    await flush();
    assertFailure(f, 'write');
    assert.deepEqual(frames.map(frame => frame.closes), [1, 1]);
    assert.equal(f.acks().some(event => event.result === 'written'), false);
    assert.equal(f.counts().aborts, 1);
    f.abort.resolve();
    await flush();
    assert.equal(f.counts().releases, 1);
    assert.equal(f.failures().length, 1);
  }
});

test('messageerror seals the runtime, closes held frames and performs cooperative stop', async () => {
  const f = fixture();
  f.init();
  const frame = new FakeFrame();
  f.send(frame);
  f.runtime.handleMessageError(); f.runtime.handleMessageError();
  assertFailure(f, 'message');
  assert.equal(frame.closes, 1);
  assert.equal(f.counts().aborts, 1);
  f.abort.resolve();
  await flush();
  assert.equal(f.counts().releases, 1);
});

test('ready post failure attempts a fixed message failure without throwing or retaining the writer', async () => {
  const f = fixture();
  f.failPosts();
  assert.doesNotThrow(() => f.init());
  assert.deepEqual(f.postAttempts.slice(0, 2), [
    { type: 'ready', generation }, { type: 'failed', generation, reason: 'message' },
  ]);
  assertFailure(f, 'message');
  assert.equal(f.counts().aborts, 1);
  f.abort.resolve();
  await flush();
  assert.equal(f.counts().releases, 1);
});

test('ACK post failure cannot retain a frame and a failed failure post cannot recurse', async () => {
  const f = fixture();
  f.init();
  const frame = new FakeFrame();
  f.send(frame);
  f.failPosts(2);
  f.writes[0].completion.resolve();
  await flush();
  assert.equal(frame.closes, 1);
  assert.deepEqual(f.postAttempts.filter(event => event.type === 'failed'), [{ type: 'failed', generation, reason: 'message' }]);
  assert.equal(f.counts().aborts, 1);
  f.abort.resolve();
  await flush();
  assert.equal(f.counts().releases, 1);
  assert.equal(f.postAttempts.length, 4);
});

test('metrics use the Worker clock and only written ACKs carry timing', async () => {
  const f = fixture();
  f.init();
  f.at(10); f.send(new FakeFrame(1920, 1080, 9e15), 1);
  f.at(17); f.writes[0].completion.resolve();
  await flush();
  f.at(30); f.send(new FakeFrame(1920, 1080, 0), 2);
  f.at(35); f.writes[1].completion.resolve();
  await flush();
  assert.deepEqual(f.acks(), [
    { type: 'ack', generation, sequence: 1, result: 'written', timing: { writeMs: 7, queueAgeMs: 0, idleMs: 0 } },
    { type: 'ack', generation, sequence: 2, result: 'written', timing: { writeMs: 5, queueAgeMs: 0, idleMs: 13 } },
  ]);
  for (const event of f.events) {
    if (event.type === 'ack' && event.result === 'written') {
      assert.deepEqual(Object.keys(event.timing!).sort(), ['idleMs', 'queueAgeMs', 'writeMs']);
      assert.ok(Object.values(event.timing!).every(value => Number.isFinite(value) && value >= 0));
    } else assert.equal('timing' in event, false);
  }
});

test('stop before init is idempotent and late init or frames cannot revive the runtime', async () => {
  const f = fixture();
  f.runtime.stop(); f.runtime.stop();
  f.init();
  const frame = new FakeFrame();
  f.send(frame);
  f.runtime.handleMessageError();
  f.abort.resolve();
  await flush();
  assert.equal(frame.closes, 1);
  assert.deepEqual(f.postAttempts, []);
  assert.deepEqual(f.counts(), { acquisitions: 1, aborts: 1, releases: 1 });
});

test('display dimensions match the sink while coded padding is allowed', async () => {
  const f = fixture();
  f.init();
  const frame = new FakeFrame(1920, 1080, 0, 16);
  f.send(frame);
  assert.deepEqual(f.failures(), []);
  assert.deepEqual(f.writes.map(entry => entry.frame), [frame]);
  f.writes[0].completion.resolve();
  await flush();
  assert.equal(f.acks()[0]?.result, 'written');
  assert.equal(frame.closes, 1);
});

test('wire stop closes held frames once and ignores repeated stop and late frames', async () => {
  const f = fixture();
  f.init();
  const frame = new FakeFrame();
  f.send(frame);
  f.runtime.handleMessage({ type: 'stop', generation });
  f.runtime.handleMessage({ type: 'stop', generation });
  assert.equal(frame.closes, 1);
  assert.equal(f.counts().aborts, 1);
  const late = new FakeFrame();
  f.send(late, 2);
  assert.equal(late.closes, 1);
  f.abort.resolve();
  await flush();
  assert.deepEqual(f.failures(), []);
  assert.deepEqual(f.events.at(-1), { type: 'stopped', generation });
  assert.equal(f.acks().some(event => event.sequence === 2), false);
});

test('unknown commands and mismatched stop generations close transferred frames and fail closed', async () => {
  for (const command of [
    { type: 'other', generation },
    { type: 'stop', generation: 'stale-generation' },
    { type: 'stop', generation },
  ]) {
    const f = fixture();
    f.init();
    const frame = new FakeFrame();
    f.runtime.handleMessage({ ...command, frame });
    assert.equal(frame.closes, 1);
    assertFailure(f, 'protocol');
    assert.equal(f.writes.length, 0);
    f.abort.resolve();
    await flush();
    assert.equal(f.counts().releases, 1);
  }
});
