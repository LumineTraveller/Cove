import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  tryNativeScreenCapture,
  getNativeScreenCaptureDiagnostics,
  getLastNativeScreenCaptureAttempt,
  type NativeScreenBridge,
  type NativeScreenCaptureOptions,
} from '../src/features/media/screen/nativeScreenCapture';
import type { NativeScreenFrame, NativeScreenStartResult } from '../electron/native-screen-capture-protocol';
import type { NativeFrameWorkerCommand } from '../src/features/media/screen/nativeFrameWorkerProtocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function replaceGlobal(context: TestContext, name: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  });
}

class FakeTrack extends EventTarget {
  readyState = 'live';
  contentHint = '';
  stops = 0;
  settings: MediaTrackSettings = { width: 2560, height: 1440, displaySurface: 'monitor' };
  getSettings() { return this.settings; }
  stop() { this.stops++; this.readyState = 'ended'; }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getVideoTracks() { return this.tracks; }
  getAudioTracks() { return []; }
  getTracks() { return this.tracks; }
}

class FakeFrame {
  displayWidth = 1920;
  displayHeight = 1080;
  timestamp = 1_000;
  closes = 0;
  close() { this.closes++; }
}

type FrameCallback = Parameters<NativeScreenBridge['onFrame']>[1];

test('experimental Canvas preference does not replace an unqualified color contract', async context => {
  for (const colorSpace of [undefined, 'bt601-limited'] as const) {
    await context.test(String(colorSpace), async child => {
      const f = fixture(child);
      Object.assign(f.bridge, { preferredFrameSink: 'canvas' });
      f.options.colorSpace = colorSpace;
      const { candidate } = await f.ready();
      assert.equal(getNativeScreenCaptureDiagnostics(candidate.stream.getVideoTracks()[0])?.frameSink, 'generator');
      assert.equal(f.writes.length, 1);
      candidate.stop();
    });
  }
});

test('unavailable experimental Canvas setup preserves published stock without faulting native', async context => {
  const f = fixture(context);
  Object.assign(f.bridge, { preferredFrameSink: 'canvas' });
  f.options.colorSpace = 'bt709-limited';
  // This Node fixture deliberately has no browser Canvas/Processor boundary.
  const pending = tryNativeScreenCapture(f.stream, f.options);
  await f.flush();
  assert.equal(await pending, null);
  assert.equal(f.stock.stops, 0);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.stopFaults, [undefined]);
  assert.equal(getLastNativeScreenCaptureAttempt()?.stopReason, 'setup_error');
});

function fixture(context: TestContext) {
  const controller = new AbortController();
  const stock = new FakeTrack();
  const stream = new FakeStream([stock]) as unknown as MediaStream;
  const native: FakeTrack[] = [];
  const writes: FakeFrame[] = [];
  const stopRequests: string[] = [];
  const stopFaults: Parameters<NativeScreenBridge['stop']>[1][] = [];
  const stopArgumentCounts: number[] = [];
  const events: string[] = [];
  let activeFrame: FrameCallback | undefined;
  let lastFrame: FrameCallback | undefined;
  let activeEnded: ((reason: string) => void) | undefined;
  let lastEnded: ((reason: string) => void) | undefined;
  let requestId = '';
  let current = true;
  let aborts = 0;
  let releases = 0;
  let result: NativeScreenStartResult = { ok: true, sessionId: 'session-1', width: 1920, height: 1080 };
  let startImplementation = async () => result;
  let writeImplementation: (frame: FakeFrame) => Promise<void> = async () => {};
  let populateSettings = true;
  const bridge: NativeScreenBridge = {
    supported: true,
    start: async (id, options) => {
      requestId = id;
      events.push('start');
      assert.deepEqual(options, { maxWidth: 1920, maxHeight: 1080, fps: 120,
        ...(captureOptions.colorSpace ? { colorSpace: captureOptions.colorSpace } : {}) });
      return startImplementation();
    },
    stop: async (...args) => {
      stopRequests.push(args[0]); stopFaults.push(args[1]); stopArgumentCounts.push(args.length);
      return true;
    },
    onFrame: (_id, callback) => {
      events.push('subscribe-frame'); activeFrame = lastFrame = callback;
      return () => { events.push('unsubscribe-frame'); activeFrame = undefined; };
    },
    onEnded: (_id, callback) => {
      events.push('subscribe-ended'); activeEnded = lastEnded = callback;
      return () => { events.push('unsubscribe-ended'); activeEnded = undefined; };
    },
  };
  class FakeGenerator extends FakeTrack {
    writable = { getWriter: () => ({
      write: async (frame: FakeFrame) => {
        writes.push(frame);
        await writeImplementation(frame);
        if (populateSettings) this.settings = { width: 1920, height: 1080 };
      },
      abort: async () => { aborts++; },
      releaseLock: () => { releases++; },
    }) };
    constructor(options: unknown) {
      super();
      assert.deepEqual(options, { kind: 'video' });
      this.settings = {};
      native.push(this);
    }
  }
  replaceGlobal(context, 'window', { coveNativeScreen: bridge });
  replaceGlobal(context, 'MediaStream', FakeStream);
  replaceGlobal(context, 'MediaStreamTrackGenerator', FakeGenerator);
  context.after(() => controller.abort());
  const captureOptions: NativeScreenCaptureOptions = {
    maxWidth: 1920, maxHeight: 1080, fps: 120, nativeResolution: false, contentHint: 'motion',
    isCurrent: () => current, signal: controller.signal,
  };
  async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
  function metadata(patch: Partial<NativeScreenFrame> = {}): NativeScreenFrame {
    return { requestId, sessionId: 'session-1', slot: 0, serial: 1, width: 1920, height: 1080,
      timestamp: 1_000, refresh: false, ...patch };
  }
  async function frame(patch: Partial<NativeScreenFrame> = {}, value = new FakeFrame(), late = false) {
    await (late ? lastFrame : activeFrame)?.(value as unknown as VideoFrame, metadata(patch));
    return value;
  }
  async function ready() {
    const pending = tryNativeScreenCapture(stream, captureOptions);
    await flush();
    const firstFrame = await frame();
    const candidate = await pending;
    assert.ok(candidate);
    return { candidate, firstFrame };
  }
  return {
    bridge, stock, stream, native, writes, stopRequests, stopFaults, stopArgumentCounts, events, options: captureOptions, controller,
    flush, metadata, frame, ready,
    get aborts() { return aborts; }, get releases() { return releases; },
    get requestId() { return requestId; },
    get frameCallback() { return lastFrame; },
    get endedCallback() { return lastEnded; },
    setCurrent(value: boolean) { current = value; },
    setStart(value: () => Promise<NativeScreenStartResult>) { startImplementation = value; },
    setResult(value: NativeScreenStartResult) { result = value; },
    setWrite(value: (frame: FakeFrame) => Promise<void>) { writeImplementation = value; },
    setPopulateSettings(value: boolean) { populateSettings = value; },
    ended(late = false) { (late ? lastEnded : activeEnded)?.('device-lost'); },
  };
}

function workerFixture(context: TestContext) {
  const f = fixture(context);
  const workers: FakeCaptureWorker[] = [];
  class FakeCaptureWorker extends EventTarget {
    posts: NativeFrameWorkerCommand[] = [];
    generation = '';
    terminations = 0;
    constructor(url: URL, options: WorkerOptions) {
      super(); assert.match(url.href, /nativeFrameWorker\.ts$/); assert.equal(options.type, 'module');
      workers.push(this);
    }
    postMessage(message: NativeFrameWorkerCommand, transfer: Transferable[]) {
      this.posts.push(message);
      if (message.type === 'init') {
        this.generation = message.generation; assert.deepEqual(transfer, [message.writable]);
      }
      if (message.type === 'frame') assert.deepEqual(transfer, [message.frame]);
      if (message.type === 'stop') queueMicrotask(() => this.emit('stopped'));
    }
    terminate() { this.terminations++; }
    emit(type: string, extra: Record<string, unknown> = {}) {
      this.dispatchEvent(new MessageEvent('message', { data: { type, generation: this.generation, ...extra } }));
    }
    written(sequence: number) {
      f.native[0].settings = { width: 1920, height: 1080 };
      this.emit('ack', { sequence, result: 'written', timing: { writeMs: 2, queueAgeMs: 3, idleMs: 4 } });
    }
  }
  replaceGlobal(context, 'Worker', FakeCaptureWorker);
  Object.assign(f.bridge, { preferredFrameSink: 'worker' });
  return Object.assign(f, { workers });
}

test('opt-in Worker transfers once, leaves the Window writer unlocked and preserves the published track contract', async context => {
  const f = workerFixture(context);
  const pending = tryNativeScreenCapture(f.stream, f.options); await f.flush();
  assert.equal(f.workers.length, 1); assert.equal(f.writes.length, 0);
  const worker = f.workers[0];
  worker.emit('ready'); await f.flush();
  const frame = new FakeFrame(); const received = f.frame({}, frame); await f.flush();
  assert.equal(frame.closes, 0, 'Callback awaits Worker result; preload credit is still separate');
  assert.equal(worker.posts.filter(message => message.type === 'frame').length, 1);
  worker.written(1); await received;
  const candidate = await pending; assert.ok(candidate); candidate.commit();
  const diagnostics = getNativeScreenCaptureDiagnostics(candidate.stream.getVideoTracks()[0]);
  assert.equal(diagnostics?.frameSink, 'worker'); assert.equal(diagnostics?.framesWritten, 1);
  assert.equal(diagnostics?.totalWriteMs, 2); assert.equal(diagnostics?.totalQueueAgeMs, 3);
  assert.equal(diagnostics?.totalWriteIdleMs, 4); assert.equal(diagnostics?.worker?.pending, 0);
  assert.equal(frame.closes, 1); assert.equal(f.writes.length, 0);
  candidate.stop(); await f.flush();
  assert.equal(worker.terminations, 1); assert.equal(f.native[0].stops, 1);
  assert.equal(f.stock.stops, 0); assert.deepEqual(f.stopFaults, [undefined]);
  assert.equal(f.aborts, 0, 'Window must not abort a writer transferred to Worker');
});

test('unavailable bundled Worker setup retains stock and does not poison the native fault circuit', async context => {
  const f = fixture(context); Object.assign(f.bridge, { preferredFrameSink: 'worker' });
  replaceGlobal(context, 'Worker', undefined);
  assert.equal(await tryNativeScreenCapture(f.stream, f.options), null);
  assert.equal(f.stock.stops, 0); assert.equal(f.writes.length, 0);
  assert.deepEqual(f.stopFaults, [undefined]);
  assert.equal(getLastNativeScreenCaptureAttempt()?.stopReason, 'setup_error');
});

test('Worker readiness shares the remaining total startup deadline and late ready cannot revive it', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0; replaceGlobal(context, 'performance', { now: () => now });
  const f = workerFixture(context); const start = deferred<NativeScreenStartResult>();
  f.setStart(() => start.promise);
  const pending = tryNativeScreenCapture(f.stream, f.options);
  now = 1000; context.mock.timers.tick(1000);
  start.resolve({ ok: true, sessionId: 'session-1', width: 1920, height: 1080 }); await f.flush();
  assert.equal(f.workers.length, 1);
  now = 1500; context.mock.timers.tick(500); await f.flush();
  assert.equal(await pending, null); assert.equal(f.native[0].stops, 1); assert.equal(f.stock.stops, 0);
  const worker = f.workers[0]; worker.emit('ready');
  const frame = await f.frame({}, new FakeFrame(), true);
  assert.equal(frame.closes, 1); assert.equal(f.writes.length, 0);
  assert.deepEqual(f.stopFaults, [undefined]); assert.equal(worker.terminations, 1);
});

test('cancel during Worker initialization synchronously preserves stock and retires late messages', async context => {
  const f = workerFixture(context);
  const pending = tryNativeScreenCapture(f.stream, f.options); await f.flush();
  f.controller.abort(); assert.equal(await pending, null); await f.flush();
  f.workers[0].emit('ready'); f.workers[0].written(1);
  assert.equal(f.native[0].stops, 1); assert.equal(f.stock.stops, 0);
  assert.equal(f.workers[0].terminations, 1); assert.deepEqual(f.stopFaults, [undefined]);
});

test('stop during Worker write settles the callback and cannot publish a late ACK', async context => {
  const f = workerFixture(context);
  const pending = tryNativeScreenCapture(f.stream, f.options); await f.flush();
  const worker = f.workers[0]; worker.emit('ready'); await f.flush();
  const frame = new FakeFrame(); const received = f.frame({}, frame); await f.flush();
  f.controller.abort(); await received; assert.equal(await pending, null);
  worker.written(1); await f.flush();
  assert.equal(frame.closes, 1); assert.equal(f.native[0].stops, 1);
  assert.equal(getNativeScreenCaptureDiagnostics(f.native[0] as unknown as MediaStreamTrack)?.framesWritten, 0);
  assert.equal(f.stock.stops, 0); assert.equal(worker.terminations, 1);
});

test('Worker error after commit follows existing safe sharing teardown once', async context => {
  const f = workerFixture(context);
  const pending = tryNativeScreenCapture(f.stream, f.options); await f.flush();
  const worker = f.workers[0]; worker.emit('ready'); await f.flush();
  const received = f.frame(); await f.flush(); worker.written(1); await received;
  const candidate = await pending; assert.ok(candidate); candidate.commit();
  let ended = 0; f.native[0].addEventListener('ended', () => ended++);
  worker.dispatchEvent(new Event('error')); await f.flush(); worker.dispatchEvent(new Event('error'));
  assert.equal(ended, 1); assert.equal(f.native[0].stops, 1);
  assert.equal(f.stock.stops, 0); assert.deepEqual(f.stopFaults, ['renderer_failed']);
  assert.equal(worker.terminations, 1);
});

test('Worker preference never changes CPU NV12 ownership or writer semantics', async context => {
  const f = workerFixture(context); f.options.colorSpace = 'bt709-limited';
  f.setResult({ ok: true, sessionId: 'session-1', width: 1920, height: 1080, pixelFormat: 'nv12', storage: 'cpu' });
  const pending = tryNativeScreenCapture(f.stream, f.options); await f.flush();
  const frame = Object.assign(new FakeFrame(), { format: 'NV12', colorSpace: {
    primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false,
  } });
  await f.frame({ pixelFormat: 'nv12', storage: 'cpu' }, frame);
  const candidate = await pending; assert.ok(candidate);
  assert.equal(f.workers.length, 0); assert.equal(f.writes.length, 1);
  assert.equal(getNativeScreenCaptureDiagnostics(candidate.stream.getVideoTracks()[0])?.frameSink, 'generator');
  candidate.stop(); await f.flush(); assert.equal(f.aborts, 1);
});

test('disabled, unsupported and ineligible sources retain stock without starting native', async (context) => {
  const f = fixture(context);
  for (const displaySurface of ['window', 'browser', undefined]) {
    f.stock.settings.displaySurface = displaySurface;
    assert.equal(await tryNativeScreenCapture(f.stream, f.options), null);
  }
  f.stock.settings.displaySurface = 'monitor';
  f.options.nativeResolution = true;
  assert.equal(await tryNativeScreenCapture(f.stream, f.options), null);
  f.options.nativeResolution = false;
  (f.bridge as { supported: boolean }).supported = false;
  assert.equal(await tryNativeScreenCapture(f.stream, f.options), null);
  (f.bridge as { supported: boolean }).supported = true;
  replaceGlobal(context, 'MediaStreamTrackGenerator', undefined);
  assert.equal(await tryNativeScreenCapture(f.stream, f.options), null);
  assert.equal(f.native.length, 0);
  assert.equal(f.stopRequests.length, 0);
  assert.equal(f.stock.stops, 0);
});

test('first written frame yields a live hinted candidate and commit never stops stock', async (context) => {
  const f = fixture(context);
  const { candidate, firstFrame } = await f.ready();
  assert.deepEqual(f.events.slice(0, 3), ['subscribe-frame', 'subscribe-ended', 'start']);
  assert.equal(f.native[0].contentHint, 'motion');
  assert.equal(firstFrame.closes, 1);
  assert.equal(candidate.stream.getVideoTracks()[0], f.native[0]);
  candidate.commit();
  candidate.commit();
  assert.equal(f.stock.stops, 0);
  f.stock.end();
  assert.equal(f.native[0].readyState, 'live', 'stock ended listener is removed on commit');
  f.setCurrent(false);
  f.controller.abort();
  await f.frame({ serial: 2, timestamp: 2_000 }, Object.assign(new FakeFrame(), { timestamp: 2_000 }));
  assert.equal(f.native[0].readyState, 'live', 'a new preparation cannot cancel the committed predecessor');
  candidate.stop();
  candidate.stop();
  candidate.stream.getVideoTracks()[0].stop();
  await f.flush();
  assert.equal(f.native[0].stops, 1);
  assert.equal(f.aborts, 1);
  assert.equal(f.releases, 1);
  assert.deepEqual(f.stopRequests, [f.requestId]);
  assert.deepEqual(f.stopFaults, [undefined]);
  assert.deepEqual(f.stopArgumentCounts, [1], 'normal stop omits the fault argument');
});

test('NV12 candidate preserves explicit limited BT709 frame metadata and uses the same bounded writer', async context => {
  const f = fixture(context);
  f.setResult({ ok: true, sessionId: 'session-1', width: 1920, height: 1080, pixelFormat: 'nv12' });
  const pending = tryNativeScreenCapture(f.stream, f.options); await f.flush();
  const frame = Object.assign(new FakeFrame(), { format: 'NV12', colorSpace: {
    primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false,
  } });
  await f.frame({ pixelFormat: 'nv12' }, frame);
  const candidate = await pending; assert.ok(candidate); candidate.commit();
  assert.equal(frame.closes, 1); assert.equal(f.writes.length, 1);
  assert.equal(getNativeScreenCaptureDiagnostics(candidate.stream.getVideoTracks()[0])?.pixelFormat, 'nv12');
  candidate.stop(); assert.equal(f.stock.stops, 0);
});

test('CPU NV12 delivery stays on the existing producer candidate contract and declares its storage', async context => {
  const f = fixture(context);
  f.options.colorSpace = 'bt709-limited';
  f.setResult({ ok: true, sessionId: 'session-1', width: 1920, height: 1080, pixelFormat: 'nv12', storage: 'cpu' });
  const pending = tryNativeScreenCapture(f.stream, f.options); await f.flush();
  const frame = Object.assign(new FakeFrame(), { format: 'NV12', colorSpace: {
    primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false,
  } });
  await f.frame({ pixelFormat: 'nv12', storage: 'cpu' }, frame);
  const candidate = await pending; assert.ok(candidate); candidate.commit();
  assert.equal(frame.closes, 1); assert.equal(f.writes.length, 1);
  assert.equal(getNativeScreenCaptureDiagnostics(candidate.stream.getVideoTracks()[0])?.frameStorage, 'cpu');
  candidate.stop(); assert.equal(f.stock.stops, 0);
});

test('CPU BT601 validates session, per-frame contract and actual SMPTE170M before writing', async context => {
  const f = fixture(context);
  f.options.colorSpace = 'bt601-limited';
  f.setResult({ ok: true, sessionId: 'session-1', width: 1920, height: 1080,
    pixelFormat: 'nv12', storage: 'cpu', colorSpace: 'bt601-limited' });
  const pending = tryNativeScreenCapture(f.stream, f.options); await f.flush();
  const makeFrame = () => Object.assign(new FakeFrame(), { format: 'NV12', colorSpace: {
    primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false,
  } });
  await f.frame({ pixelFormat: 'nv12', storage: 'cpu', colorSpace: 'bt601-limited' }, makeFrame());
  const candidate = await pending; assert.ok(candidate); candidate.commit();
  assert.equal(f.writes.length, 1);
  const changed = makeFrame(); changed.timestamp = 2000;
  await f.frame({ serial: 2, timestamp: 2000, pixelFormat: 'nv12', storage: 'cpu', colorSpace: 'bt709-limited' }, changed);
  assert.equal(f.writes.length, 1); assert.equal(changed.closes, 1);
  assert.deepEqual(f.stopFaults, ['renderer_failed']); assert.equal(f.stock.stops, 0);
});

test('CPU startup rejects missing codec contract and BT601/BT709 mismatch without writing', async context => {
  for (const [requested, announced] of [[undefined, 'bt709-limited'], ['bt601-limited', undefined],
    ['bt601-limited', 'bt709-limited'], ['bt709-limited', 'bt601-limited']] as const) {
    await context.test(`${requested}/${announced}`, async subcontext => {
      const f = fixture(subcontext); f.options.colorSpace = requested;
      f.setResult({ ok: true, sessionId: 'session-1', width: 1920, height: 1080,
        pixelFormat: 'nv12', storage: 'cpu', colorSpace: announced });
      assert.equal(await tryNativeScreenCapture(f.stream, f.options), null);
      assert.equal(f.writes.length, 0); assert.equal(f.stock.stops, 0);
      assert.deepEqual(f.stopFaults, [undefined]);
    });
  }
});

test('CPU rejects actual frame color metadata differing from its declared matrix', async context => {
  for (const component of ['primaries', 'transfer', 'matrix', 'fullRange']) {
    await context.test(component, async subcontext => {
      const f = fixture(subcontext); f.options.colorSpace = 'bt601-limited';
      f.setResult({ ok: true, sessionId: 'session-1', width: 1920, height: 1080,
        pixelFormat: 'nv12', storage: 'cpu', colorSpace: 'bt601-limited' });
      const pending = tryNativeScreenCapture(f.stream, f.options); await f.flush();
      const value = Object.assign(new FakeFrame(), { format: 'NV12', colorSpace: {
        primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false,
        [component]: component === 'fullRange' ? true : 'bt709',
      } });
      await f.frame({ pixelFormat: 'nv12', storage: 'cpu', colorSpace: 'bt601-limited' }, value);
      assert.equal(await pending, null); assert.equal(f.writes.length, 0); assert.equal(value.closes, 1);
      assert.deepEqual(f.stopFaults, ['renderer_failed']);
    });
  }
});

test('negotiated NV12 rejects missing format, wrong planes or changed color metadata before writing', async context => {
  for (const invalid of ['missing-metadata', 'wrong-format', 'wrong-matrix', 'full-range']) {
    await context.test(invalid, async subcontext => {
      const f = fixture(subcontext);
      f.setResult({ ok: true, sessionId: 'session-1', width: 1920, height: 1080, pixelFormat: 'nv12' });
      const pending = tryNativeScreenCapture(f.stream, f.options); await f.flush();
      const value = Object.assign(new FakeFrame(), { format: invalid === 'wrong-format' ? 'BGRA' : 'NV12',
        colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: invalid === 'wrong-matrix' ? 'bt601' : 'bt709',
          fullRange: invalid === 'full-range' } });
      await f.frame(invalid === 'missing-metadata' ? {} : { pixelFormat: 'nv12' }, value);
      assert.equal(await pending, null); assert.equal(value.closes, 1); assert.equal(f.writes.length, 0);
      assert.deepEqual(f.stopFaults, ['renderer_failed']); assert.equal(f.stock.stops, 0);
    });
  }
});

test('startup failure, rejected first write and invalid generated settings preserve stock', async (context) => {
  for (const mode of ['start', 'write', 'settings']) {
    await context.test(mode, async (subcontext) => {
      subcontext.mock.timers.enable({ apis: ['setTimeout'] });
      const f = fixture(subcontext);
      if (mode === 'start') f.setResult({ ok: false, reason: 'unavailable' });
      if (mode === 'write') f.setWrite(async () => { throw new Error('writer rejected'); });
      if (mode === 'settings') f.setPopulateSettings(false);
      const pending = tryNativeScreenCapture(f.stream, f.options);
      await f.flush();
      const value = mode !== 'start' ? await f.frame() : undefined;
      if (mode === 'settings') subcontext.mock.timers.tick(1_500);
      assert.equal(await pending, null);
      assert.equal(value?.closes ?? 1, 1);
      assert.equal(f.native[0].readyState, 'ended');
      assert.equal(f.stock.readyState, 'live');
      assert.equal(f.stock.stops, 0);
      assert.deepEqual(f.stopRequests, [f.requestId]);
      assert.deepEqual(f.stopFaults, [mode === 'write' ? 'renderer_failed' : undefined]);
      assert.deepEqual(f.stopArgumentCounts, [mode === 'write' ? 2 : 1]);
    });
  }
});

test('first write may resolve before settings; startup polls real settings without holding frames', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(context);
  f.setPopulateSettings(false);
  const pending = tryNativeScreenCapture(f.stream, f.options);
  let resolved = false;
  void pending.then(() => { resolved = true; });
  await f.flush();
  const first = await f.frame();
  assert.equal(first.closes, 1, 'settings readiness does not retain the import or block its release');
  assert.equal(resolved, false);
  const second = await f.frame({ serial: 2, timestamp: 2_000 }, Object.assign(new FakeFrame(), { timestamp: 2_000 }));
  assert.equal(second.closes, 1);
  assert.equal(f.writes.length, 2, 'a settings poll does not serialize or throttle subsequent frame writes');
  context.mock.timers.tick(25);
  await f.flush();
  assert.equal(resolved, false);
  f.native[0].settings = { width: 1920, height: 1080 };
  context.mock.timers.tick(5);
  const candidate = await pending;
  assert.ok(candidate);
  assert.equal(f.native[0].readyState, 'live');
  assert.equal(f.stock.stops, 0);
  candidate.commit();
  // Once first readiness is established, transiently stale settings do not
  // invalidate correctly sized frames or create a per-frame poll.
  f.native[0].settings = {};
  const third = await f.frame({ serial: 3, timestamp: 3_000 }, Object.assign(new FakeFrame(), { timestamp: 3_000 }));
  context.mock.timers.tick(2_000);
  assert.equal(third.closes, 1);
  assert.equal(f.native[0].readyState, 'live');
  assert.equal(f.stopRequests.length, 0);
  candidate.stop();
});

test('settings polls share the original deadline and cannot revive a cancelled startup', async (context) => {
  for (const reason of ['abort', 'stock', 'stop', 'timeout', 'superseded'] as const) {
    await context.test(reason, async (subcontext) => {
      subcontext.mock.timers.enable({ apis: ['setTimeout'] });
      const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
      const setTimer = setTimeout;
      const clearTimer = clearTimeout;
      replaceGlobal(subcontext, 'setTimeout', (callback: () => void, delay: number) => {
        const id = setTimer(() => { pendingTimers.delete(id); callback(); }, delay);
        pendingTimers.add(id);
        return id;
      });
      replaceGlobal(subcontext, 'clearTimeout', (id: ReturnType<typeof setTimeout>) => {
        pendingTimers.delete(id);
        clearTimer(id);
      });
      const f = fixture(subcontext);
      f.setPopulateSettings(false);
      const pending = tryNativeScreenCapture(f.stream, f.options);
      await f.flush();
      const frame = await f.frame();
      assert.equal(pendingTimers.size, 2, 'only the original deadline and one startup settings poll are pending');
      if (reason === 'abort') f.controller.abort();
      if (reason === 'stock') f.stock.end();
      if (reason === 'stop') f.native[0].stop();
      if (reason === 'superseded') { f.setCurrent(false); subcontext.mock.timers.tick(5); }
      if (reason === 'timeout') subcontext.mock.timers.tick(1_500);
      assert.equal(await pending, null);
      assert.equal(getLastNativeScreenCaptureAttempt()?.stopReason, {
        abort: 'abort', stock: 'stock_ended', stop: 'normal_stop', timeout: 'deadline_timeout', superseded: 'not_current',
      }[reason]);
      assert.equal(pendingTimers.size, 0, 'stop cancels both the settings poll and the original deadline');
      f.native[0].settings = { width: 1920, height: 1080 };
      // Advancing beyond every cancelled poll must not restart or commit it.
      subcontext.mock.timers.tick(3_000);
      await f.flush();
      assert.equal(frame.closes, 1);
      assert.equal(f.native[0].stops, 1);
      assert.equal(f.stopRequests.length, 1);
      assert.deepEqual(f.stopFaults, [undefined], 'startup cancellation/timeout must not disable native');
      assert.deepEqual(f.stopArgumentCounts, [1]);
      assert.equal(f.stock.stops, 0);
    });
  }
});

test('a late first write gets only the remainder of the original readiness deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(context);
  f.setPopulateSettings(false);
  const pending = tryNativeScreenCapture(f.stream, f.options);
  await f.flush();
  context.mock.timers.tick(1_490);
  await f.frame();
  context.mock.timers.tick(10);
  assert.equal(await pending, null);
  assert.equal(f.stock.stops, 0);
  assert.equal(f.stopRequests.length, 1);
});

test('the total 1500ms deadline also bounds an unresolved start and retires late success', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  replaceGlobal(context, 'performance', { now: () => now });
  const f = fixture(context);
  const start = deferred<NativeScreenStartResult>();
  f.setStart(() => start.promise);
  const pending = tryNativeScreenCapture(f.stream, f.options);
  let resolved = false;
  void pending.then(() => { resolved = true; });
  now = 1_499; context.mock.timers.tick(1_499);
  await f.flush();
  assert.equal(resolved, false);
  now = 1_500; context.mock.timers.tick(1);
  assert.equal(await pending, null);
  const timedOut = getLastNativeScreenCaptureAttempt()!;
  assert.equal(timedOut.phase, 'stopped'); assert.equal(timedOut.stopReason, 'deadline_timeout');
  assert.equal(timedOut.elapsedMs, 1_500); assert.equal(timedOut.helperResponseMs, null);
  assert.equal(f.stopRequests.length, 1);
  now = 1_575;
  start.resolve({ ok: true, sessionId: 'late-session', width: 1920, height: 1080 });
  await f.flush();
  const lateResponse = getLastNativeScreenCaptureAttempt()!;
  assert.equal(lateResponse.phase, 'stopped'); assert.equal(lateResponse.stopReason, 'deadline_timeout');
  assert.equal(lateResponse.elapsedMs, 1_500); assert.equal(lateResponse.helperResponseMs, 1_575);
  assert.equal(lateResponse.helperResponseDurationMs, 1_575); assert.equal(lateResponse.helperResponseOk, true);
  assert.equal(timedOut.helperResponseMs, null, 'earlier snapshots never change when late IPC results arrive');
  assert.deepEqual(f.stopRequests, [f.requestId, f.requestId]);
  assert.deepEqual(f.stopFaults, [undefined, undefined], 'timeout and late start cleanup are ordinary cancellation');
  const late = await f.frame({}, new FakeFrame(), true);
  assert.equal(late.closes, 1);
  assert.equal(f.writes.length, 0);
  assert.equal(f.stock.stops, 0);
});

test('the first write cannot extend the start deadline or retain an imported frame after cancel', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(context);
  const write = deferred<void>();
  f.setWrite(() => write.promise);
  const pending = tryNativeScreenCapture(f.stream, f.options);
  await f.flush();
  const value = new FakeFrame();
  const frame = f.frame({}, value);
  await f.flush();
  assert.equal(value.closes, 0);
  context.mock.timers.tick(1_500);
  assert.equal(await pending, null);
  await frame;
  assert.equal(value.closes, 1);
  assert.equal(f.native[0].readyState, 'ended');
  write.resolve();
  await f.flush();
  assert.equal(f.stock.stops, 0);
});

test('abort, stock ending and superseded intent cancel native without stopping stock', async (context) => {
  for (const reason of ['abort', 'stock', 'superseded']) {
    await context.test(reason, async (subcontext) => {
      const f = fixture(subcontext);
      const pending = tryNativeScreenCapture(f.stream, f.options);
      await f.flush();
      if (reason === 'abort') f.controller.abort();
      if (reason === 'stock') f.stock.end();
      if (reason === 'superseded') { f.setCurrent(false); await f.frame(); }
      assert.equal(await pending, null);
      assert.equal(f.native[0].readyState, 'ended');
      assert.equal(f.stock.stops, 0);
      assert.equal(f.stopRequests.length, 1);
      assert.deepEqual(f.stopFaults, [undefined]);
      assert.deepEqual(f.stopArgumentCounts, [1]);
    });
  }
});

test('candidate failure before commit only ends native; committed failure dispatches ended after cleanup', async (context) => {
  for (const commit of [false, true]) {
    await context.test(String(commit), async (subcontext) => {
      const f = fixture(subcontext);
      const { candidate } = await f.ready();
      let ended = 0;
      f.native[0].addEventListener('ended', () => {
        ended++;
        assert.equal(f.native[0].readyState, 'ended');
        assert.equal(f.stopRequests.length, 1);
        assert.ok(f.events.includes('unsubscribe-frame'));
      });
      if (commit) candidate.commit();
      f.ended();
      f.ended(true);
      candidate.commit();
      candidate.stop();
      assert.equal(f.native[0].readyState, 'ended');
      assert.equal(ended, Number(commit));
      assert.equal(f.stock.stops, 0);
      assert.equal(f.stopRequests.length, 1);
      assert.deepEqual(f.stopFaults, ['renderer_failed'], 'unexpected helper ending is faulted even before commit');
      assert.deepEqual(f.stopArgumentCounts, [2]);
    });
  }
});

test('returned candidates remain cancellable until commit and cannot revive after stock ending', async (context) => {
  for (const reason of ['stock', 'abort']) {
    await context.test(reason, async (subcontext) => {
      const f = fixture(subcontext);
      const { candidate } = await f.ready();
      let ended = 0;
      f.native[0].addEventListener('ended', () => { ended++; });
      if (reason === 'stock') f.stock.end();
      else f.controller.abort();
      candidate.commit();
      assert.equal(candidate.stream.getVideoTracks()[0].readyState, 'ended');
      assert.equal(ended, 0, 'an uncommitted native candidate cannot tear down the stock publication');
      assert.equal(f.stopRequests.length, 1);
      assert.deepEqual(f.stopFaults, [undefined]);
      assert.equal(f.stock.stops, 0);
    });
  }
});

test('the publisher track.stop path releases the committed session without a synthetic ended', async (context) => {
  const f = fixture(context);
  const { candidate } = await f.ready();
  candidate.commit();
  let ended = 0;
  f.native[0].addEventListener('ended', () => { ended++; });
  candidate.stream.getVideoTracks()[0].stop();
  candidate.stream.getVideoTracks()[0].stop();
  candidate.stop();
  await f.flush();
  assert.equal(f.native[0].stops, 1);
  assert.equal(f.stopRequests.length, 1);
  assert.equal(f.aborts, 1);
  assert.equal(ended, 0);
  assert.deepEqual(f.stopFaults, [undefined]);
  assert.deepEqual(f.stopArgumentCounts, [1]);
});

test('writer failure after commit ends sharing once', async (context) => {
  const f = fixture(context);
  const { candidate } = await f.ready();
  candidate.commit();
  let ended = 0;
  f.native[0].addEventListener('ended', () => { ended++; });
  f.setWrite(async () => { throw new Error('device removed'); });
  const frame = await f.frame({ serial: 2, timestamp: 2_000 }, Object.assign(new FakeFrame(), { timestamp: 2_000 }));
  assert.equal(frame.closes, 1);
  assert.equal(ended, 1);
  assert.equal(f.stopRequests.length, 1);
  assert.deepEqual(f.stopFaults, ['renderer_failed']);
  assert.deepEqual(f.stopArgumentCounts, [2]);
});

test('an unexpected committed track ending reports a renderer fault exactly once', async (context) => {
  const f = fixture(context);
  const { candidate } = await f.ready();
  candidate.commit();
  f.native[0].end();
  candidate.stop();
  f.native[0].stop();
  assert.equal(f.native[0].readyState, 'ended');
  assert.deepEqual(f.stopFaults, ['renderer_failed']);
  assert.deepEqual(f.stopArgumentCounts, [2]);
});

test('a frame storm retains only one active and the latest pending frame, then drains without waiting for another capture', async (context) => {
  replaceGlobal(context, 'performance', { now: () => 0 });
  const f = fixture(context);
  const { candidate } = await f.ready();
  const write = deferred<void>();
  f.setWrite(() => write.promise);
  const first = Object.assign(new FakeFrame(), { timestamp: 2_000 });
  const pending = f.frame({ serial: 2, timestamp: 2_000 }, first);
  await f.flush();
  const queued: { value: FakeFrame; completed: Promise<FakeFrame> }[] = [];
  for (let serial = 3; serial < 100; serial++) {
    const value = Object.assign(new FakeFrame(), { timestamp: serial * 1_000 });
    queued.push({ value, completed: f.frame({ serial, timestamp: value.timestamp, slot: serial % 3 }, value) });
    await f.flush();
    assert.equal(value.closes, 0, 'latest pending frame remains owned until written or replaced');
    if (queued.length > 1) assert.equal(queued.at(-2)!.value.closes, 1);
  }
  assert.equal(f.writes.length, 2, 'one initial and one active write; pending frames never enter the writable queue');
  const busyDiagnostics = getNativeScreenCaptureDiagnostics(candidate.stream.getVideoTracks()[0]);
  assert.equal(busyDiagnostics?.framesReceived, 99);
  assert.equal(busyDiagnostics?.framesWritten, 1);
  assert.equal(busyDiagnostics?.framesDroppedWhileBusy, 96);
  assert.equal(first.closes, 0);
  write.resolve();
  await Promise.all([pending, ...queued.map(entry => entry.completed)]);
  assert.equal(first.closes, 1);
  assert.equal(f.writes.length, 3);
  assert.equal(f.writes[2], queued.at(-1)!.value);
  assert.ok(queued.every(entry => entry.value.closes === 1));
  assert.equal(getNativeScreenCaptureDiagnostics(candidate.stream.getVideoTracks()[0])?.framesWritten, 3);
  candidate.stop();
});

test('stopping sharing closes active and pending callback frames and a late write cannot publish the pending frame', async context => {
  const f = fixture(context); const { candidate } = await f.ready(); candidate.commit();
  const write = deferred<void>(); f.setWrite(() => write.promise);
  const active = Object.assign(new FakeFrame(), { timestamp: 2_000 });
  const pending = Object.assign(new FakeFrame(), { timestamp: 3_000 });
  const callbacks = [f.frame({ serial: 2, timestamp: 2_000 }, active), f.frame({ serial: 3, timestamp: 3_000, slot: 1 }, pending)];
  await f.flush(); assert.equal(f.writes.length, 2);
  candidate.stop(); await Promise.all(callbacks);
  assert.equal(active.closes, 1); assert.equal(pending.closes, 1);
  write.resolve(); await f.flush();
  assert.equal(f.writes.length, 2); assert.deepEqual(f.stopFaults, [undefined]);
});

test('one failed active write retires pending frames and emits one committed sharing fault', async context => {
  const f = fixture(context); const { candidate } = await f.ready(); candidate.commit();
  const write = deferred<void>(); f.setWrite(() => write.promise);
  const active = Object.assign(new FakeFrame(), { timestamp: 2_000 });
  const pending = Object.assign(new FakeFrame(), { timestamp: 3_000 });
  let ended = 0; candidate.stream.getVideoTracks()[0].addEventListener('ended', () => ended++);
  const callbacks = [f.frame({ serial: 2, timestamp: 2_000 }, active), f.frame({ serial: 3, timestamp: 3_000, slot: 1 }, pending)];
  await f.flush(); write.reject(new Error('conversion failed')); await Promise.all(callbacks);
  assert.equal(active.closes, 1); assert.equal(pending.closes, 1);
  assert.equal(f.writes.length, 2); assert.equal(ended, 1);
  assert.deepEqual(f.stopFaults, ['renderer_failed']); candidate.stop();
});

test('diagnostics count validated frames and successful write time, returning detached snapshots', async (context) => {
  let now = 0;
  replaceGlobal(context, 'performance', { now: () => now });
  const f = fixture(context);
  const { candidate } = await f.ready();
  const track = candidate.stream.getVideoTracks()[0];
  assert.equal(getNativeScreenCaptureDiagnostics(f.stock as unknown as MediaStreamTrack), null);
  assert.deepEqual(getNativeScreenCaptureDiagnostics(track), {
    backend: 'native-gpu', frameSink: 'generator', pixelFormat: 'bgra', frameStorage: 'gpu', framesReceived: 1, refreshFrames: 0, framesWritten: 1,
    framesDroppedWhileBusy: 0, totalWriteMs: 0, maxWriteMs: 0,
    framesDroppedExpired: 0, totalQueueAgeMs: 0, maxQueueAgeMs: 0,
    totalWriteIdleMs: 0, maxWriteIdleMs: 0, writesOverFramePeriod: 0,
  });
  f.setWrite(async () => { now += 7.5; });
  await f.frame({ serial: 2, timestamp: 2_000, refresh: true }, Object.assign(new FakeFrame(), { timestamp: 2_000 }));
  f.setWrite(async () => { now += 12; });
  await f.frame({ serial: 3, timestamp: 3_000 }, Object.assign(new FakeFrame(), { timestamp: 3_000 }));
  await f.frame({ serial: 3, timestamp: 3_000 }, Object.assign(new FakeFrame(), { timestamp: 3_000 }));
  await f.frame({ serial: 4, slot: 3 });
  const snapshot = getNativeScreenCaptureDiagnostics(track)!;
  assert.deepEqual(snapshot, {
    backend: 'native-gpu', frameSink: 'generator', pixelFormat: 'bgra', frameStorage: 'gpu', framesReceived: 3, refreshFrames: 1, framesWritten: 3,
    framesDroppedWhileBusy: 0, totalWriteMs: 19.5, maxWriteMs: 12,
    framesDroppedExpired: 0, totalQueueAgeMs: 0, maxQueueAgeMs: 0,
    totalWriteIdleMs: 0, maxWriteIdleMs: 0, writesOverFramePeriod: 1,
  });
  snapshot.framesReceived = 10_000;
  snapshot.totalWriteMs = -1;
  assert.equal(getNativeScreenCaptureDiagnostics(track)?.framesReceived, 3);
  assert.equal(getNativeScreenCaptureDiagnostics(track)?.totalWriteMs, 19.5);
  f.setWrite(async () => { now += 100; throw new Error('write-failed'); });
  await f.frame({ serial: 4, timestamp: 4_000 }, Object.assign(new FakeFrame(), { timestamp: 4_000 }));
  assert.equal(getNativeScreenCaptureDiagnostics(track)?.framesReceived, 4);
  assert.equal(getNativeScreenCaptureDiagnostics(track)?.framesWritten, 3);
  assert.equal(getNativeScreenCaptureDiagnostics(track)?.totalWriteMs, 19.5);
  candidate.stop();
});

test('unknown sessions, wrong requests, invalid slots and stale serials never reach the writer', async (context) => {
  const f = fixture(context);
  const start = deferred<NativeScreenStartResult>();
  f.setStart(() => start.promise);
  const pending = tryNativeScreenCapture(f.stream, f.options);
  const early = await f.frame();
  assert.equal(early.closes, 1);
  assert.equal(f.writes.length, 0);
  start.resolve({ ok: true, sessionId: 'session-1', width: 1920, height: 1080 });
  await f.flush();
  for (const patch of [
    { requestId: 'another-request' }, { sessionId: 'old-session' }, { slot: -1 }, { slot: 3 },
    { slot: 0.5 }, { serial: 0 }, { serial: Number.NaN }, { timestamp: -1 },
  ]) {
    const value = await f.frame(patch);
    assert.equal(value.closes, 1);
  }
  assert.equal(f.writes.length, 0);
  await f.frame();
  const candidate = await pending;
  assert.ok(candidate);
  const duplicate = await f.frame();
  assert.equal(duplicate.closes, 1);
  assert.equal(f.writes.length, 1);
  candidate.stop();
});

test('changed frame geometry safely retires the native session', async (context) => {
  const f = fixture(context);
  const { candidate } = await f.ready();
  candidate.commit();
  let ended = 0;
  f.native[0].addEventListener('ended', () => { ended++; });
  const frame = await f.frame({ serial: 2 }, Object.assign(new FakeFrame(), { displayWidth: 1280 }));
  assert.equal(frame.closes, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.native[0].readyState, 'ended');
  assert.equal(ended, 1);
  assert.equal(f.stock.stops, 0);
  assert.deepEqual(f.stopFaults, ['renderer_failed']);
  assert.deepEqual(f.stopArgumentCounts, [2]);
});

test('startup attempt snapshots retain stage times without exposing identifiers or mutable state', async context => {
  let now = 10;
  replaceGlobal(context, 'performance', { now: () => now });
  const f = fixture(context);
  const start = deferred<NativeScreenStartResult>(); f.setStart(() => start.promise);
  const pending = tryNativeScreenCapture(f.stream, f.options);
  const starting = getLastNativeScreenCaptureAttempt()!;
  assert.equal(starting.phase, 'starting'); assert.equal(starting.bridgeStartMs, 0);
  assert.equal(starting.helperResponseMs, null); assert.equal(starting.stopReason, null);
  assert.equal(starting.startFailureReason, null); assert.equal(starting.backendEndReason, null);
  assert.ok(Object.isFrozen(starting));
  assert.throws(() => Object.assign(starting, { phase: 'stopped' }), TypeError);
  assert.deepEqual(Object.keys(starting).sort(), [
    'phase', 'elapsedMs', 'bridgeStartMs', 'helperResponseMs', 'helperResponseDurationMs', 'helperResponseOk',
    'startFailureReason', 'backendEndReason',
    'firstFrameMs', 'firstWriteMs', 'settingsReadyMs', 'committedMs', 'stoppedMs', 'stopReason',
  ].sort(), 'only fixed stage metadata is exposed');
  now = 40; start.resolve({ ok: true, sessionId: 'session-1', width: 1920, height: 1080 });
  await f.flush();
  const helperReady = getLastNativeScreenCaptureAttempt()!;
  assert.equal(helperReady.phase, 'helper-ready'); assert.equal(helperReady.helperResponseMs, 30);
  assert.equal(helperReady.helperResponseDurationMs, 30); assert.equal(helperReady.helperResponseOk, true);
  assert.equal(starting.phase, 'starting'); assert.equal(starting.helperResponseMs, null);
  const write = deferred<void>(); f.setWrite(() => write.promise);
  now = 50; const frame = f.frame(); await f.flush();
  assert.equal(getLastNativeScreenCaptureAttempt()?.firstFrameMs, 40);
  assert.equal(getLastNativeScreenCaptureAttempt()?.firstWriteMs, null);
  now = 55; write.resolve(); await frame;
  const candidate = await pending; assert.ok(candidate);
  const ready = getLastNativeScreenCaptureAttempt()!;
  assert.equal(ready.phase, 'settings-ready'); assert.equal(ready.firstWriteMs, 45);
  assert.equal(ready.settingsReadyMs, 45);
  now = 60; candidate.commit();
  assert.equal(getLastNativeScreenCaptureAttempt()?.phase, 'committed');
  assert.equal(getLastNativeScreenCaptureAttempt()?.committedMs, 50);
  now = 70; candidate.stop();
  const stopped = getLastNativeScreenCaptureAttempt()!;
  assert.equal(stopped.phase, 'stopped'); assert.equal(stopped.stopReason, 'normal_stop');
  assert.equal(stopped.stoppedMs, 60); assert.equal(stopped.elapsedMs, 60);
  now = 100;
  assert.deepEqual(getLastNativeScreenCaptureAttempt(), stopped, 'the terminal elapsed time remains fixed');
  assert.equal(ready.phase, 'settings-ready'); assert.equal(helperReady.firstFrameMs, null);
});

test('late responses, frames and ended callbacks from a predecessor cannot overwrite the current attempt', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  replaceGlobal(context, 'performance', { now: () => now });
  const f = fixture(context);
  const oldStart = deferred<NativeScreenStartResult>(); f.setStart(() => oldStart.promise);
  const oldPending = tryNativeScreenCapture(f.stream, f.options);
  const oldFrameCallback = f.frameCallback!; const oldEndedCallback = f.endedCallback!;
  const oldMetadata = f.metadata();
  now = 1_500; context.mock.timers.tick(1_500);
  assert.equal(await oldPending, null);
  const oldSnapshot = getLastNativeScreenCaptureAttempt()!;
  assert.equal(oldSnapshot.stopReason, 'deadline_timeout');
  const newStart = deferred<NativeScreenStartResult>(); f.setStart(() => newStart.promise);
  now = 1_505; const newPending = tryNativeScreenCapture(f.stream, f.options);
  now = 1_510;
  oldStart.resolve({ ok: true, sessionId: 'session-1', width: 1920, height: 1080 });
  await f.flush();
  const oldFrame = new FakeFrame();
  await oldFrameCallback(oldFrame as unknown as VideoFrame, oldMetadata); oldEndedCallback('device-lost');
  assert.equal(oldFrame.closes, 1);
  const current = getLastNativeScreenCaptureAttempt()!;
  assert.equal(current.phase, 'starting'); assert.equal(current.elapsedMs, 5);
  assert.equal(current.helperResponseMs, null); assert.equal(current.firstFrameMs, null);
  assert.equal(current.stopReason, null); assert.equal(oldSnapshot.helperResponseMs, null);
  assert.equal(current.startFailureReason, null); assert.equal(current.backendEndReason, null);
  now = 1_600; newStart.resolve({ ok: true, sessionId: 'session-1', width: 1920, height: 1080 });
  await f.flush(); await f.frame();
  const candidate = await newPending; assert.ok(candidate);
  assert.equal(getLastNativeScreenCaptureAttempt()?.helperResponseMs, 95);
  assert.equal(getLastNativeScreenCaptureAttempt()?.phase, 'settings-ready');
  candidate.stop();
});

test('a rejected native start retains only the fixed failure reason and preserves stock', async context => {
  const f = fixture(context);
  f.setResult({ ok: false, reason: 'source_ineligible' });
  assert.equal(await tryNativeScreenCapture(f.stream, f.options), null);
  const attempt = getLastNativeScreenCaptureAttempt()!;
  assert.equal(attempt.stopReason, 'start_rejected');
  assert.equal(attempt.helperResponseOk, false);
  assert.equal(attempt.startFailureReason, 'source_ineligible');
  assert.equal(attempt.backendEndReason, null);
  assert.equal(f.stock.stops, 0);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.stopFaults, [undefined]);
});

test('unknown start rejection text is not retained in diagnostic snapshots', async context => {
  const f = fixture(context);
  const privateText = 'driver detail /private/source?token=secret';
  f.setResult({ ok: false, reason: privateText });
  assert.equal(await tryNativeScreenCapture(f.stream, f.options), null);
  const attempt = getLastNativeScreenCaptureAttempt()!;
  assert.equal(attempt.startFailureReason, 'unknown_failure');
  assert.equal(attempt.stopReason, 'start_rejected');
  assert.equal(JSON.stringify(attempt).includes(privateText), false);
  assert.equal(JSON.stringify(attempt).includes('secret'), false);
});

test('backend termination retains a fixed reason without changing committed failure cleanup', async context => {
  const f = fixture(context);
  const { candidate } = await f.ready(); candidate.commit();
  let ended = 0;
  candidate.stream.getVideoTracks()[0].addEventListener('ended', () => ended++);
  const onEnded = f.endedCallback!;
  onEnded('capture_stalled');
  const attempt = getLastNativeScreenCaptureAttempt()!;
  assert.equal(attempt.stopReason, 'native_ended');
  assert.equal(attempt.startFailureReason, null);
  assert.equal(attempt.backendEndReason, 'capture_stalled');
  assert.equal(ended, 1);
  assert.deepEqual(f.stopFaults, ['renderer_failed']);
  onEnded('helper_failed'); candidate.stop();
  assert.deepEqual(getLastNativeScreenCaptureAttempt(), attempt, 'late backend events cannot replace the terminal reason');
  assert.equal(ended, 1);
  assert.deepEqual(f.stopFaults, ['renderer_failed']);
});

test('unknown backend termination text is reduced to the fixed fallback code', async context => {
  const f = fixture(context);
  const { candidate } = await f.ready(); candidate.commit();
  const privateText = 'capture failed at /private/source?token=secret';
  f.endedCallback!(privateText);
  const attempt = getLastNativeScreenCaptureAttempt()!;
  assert.equal(attempt.backendEndReason, 'unknown_failure');
  assert.equal(attempt.stopReason, 'native_ended');
  assert.equal(JSON.stringify(attempt).includes('secret'), false);
  assert.equal(f.stock.stops, 0);
  assert.deepEqual(f.stopFaults, ['renderer_failed']);
});

test('a successor attempt is not polluted by late predecessor rejection or backend reason', async context => {
  replaceGlobal(context, 'performance', { now: () => 0 });
  const f = fixture(context);
  const oldStart = deferred<NativeScreenStartResult>(); f.setStart(() => oldStart.promise);
  const oldController = new AbortController();
  const oldPending = tryNativeScreenCapture(f.stream, { ...f.options, signal: oldController.signal });
  const oldEnded = f.endedCallback!;
  oldController.abort();
  assert.equal(await oldPending, null);
  const predecessor = getLastNativeScreenCaptureAttempt()!;
  assert.equal(predecessor.startFailureReason, null);
  assert.equal(predecessor.backendEndReason, null);

  f.setStart(async () => ({ ok: true, sessionId: 'session-1', width: 1920, height: 1080 }));
  const { candidate } = await f.ready();
  const successor = getLastNativeScreenCaptureAttempt()!;
  oldStart.resolve({ ok: false, reason: 'helper_unavailable' });
  oldEnded('capture_stalled');
  await f.flush();
  assert.deepEqual(getLastNativeScreenCaptureAttempt(), successor);
  assert.equal(predecessor.startFailureReason, null, 'a detached earlier snapshot never changes');
  assert.equal(predecessor.backendEndReason, null);
  assert.equal(successor.startFailureReason, null);
  assert.equal(successor.backendEndReason, null);
  assert.equal(f.stock.stops, 0);
  candidate.stop();
});
