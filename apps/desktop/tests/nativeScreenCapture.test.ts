import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  tryNativeScreenCapture,
  getNativeScreenCaptureDiagnostics,
  type NativeScreenBridge,
  type NativeScreenCaptureOptions,
} from '../src/features/media/screen/nativeScreenCapture';
import type { NativeScreenFrame, NativeScreenStartResult } from '../electron/native-screen-capture-protocol';

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
      assert.deepEqual(options, { maxWidth: 1920, maxHeight: 1080, fps: 120 });
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
  const options: NativeScreenCaptureOptions = {
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
    const pending = tryNativeScreenCapture(stream, options);
    await flush();
    const firstFrame = await frame();
    const candidate = await pending;
    assert.ok(candidate);
    return { candidate, firstFrame };
  }
  return {
    bridge, stock, stream, native, writes, stopRequests, stopFaults, stopArgumentCounts, events, options, controller,
    flush, metadata, frame, ready,
    get aborts() { return aborts; }, get releases() { return releases; },
    get requestId() { return requestId; },
    setCurrent(value: boolean) { current = value; },
    setStart(value: () => Promise<NativeScreenStartResult>) { startImplementation = value; },
    setResult(value: NativeScreenStartResult) { result = value; },
    setWrite(value: (frame: FakeFrame) => Promise<void>) { writeImplementation = value; },
    setPopulateSettings(value: boolean) { populateSettings = value; },
    ended(late = false) { (late ? lastEnded : activeEnded)?.('device-lost'); },
  };
}

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
  for (const reason of ['abort', 'stock', 'stop', 'timeout', 'superseded']) {
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
  const f = fixture(context);
  const start = deferred<NativeScreenStartResult>();
  f.setStart(() => start.promise);
  const pending = tryNativeScreenCapture(f.stream, f.options);
  let resolved = false;
  void pending.then(() => { resolved = true; });
  context.mock.timers.tick(1_499);
  await f.flush();
  assert.equal(resolved, false);
  context.mock.timers.tick(1);
  assert.equal(await pending, null);
  assert.equal(f.stopRequests.length, 1);
  start.resolve({ ok: true, sessionId: 'late-session', width: 1920, height: 1080 });
  await f.flush();
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

test('concurrent frames are dropped while a single write is pending and all frame callbacks close', async (context) => {
  const f = fixture(context);
  const { candidate } = await f.ready();
  const write = deferred<void>();
  f.setWrite(() => write.promise);
  const first = Object.assign(new FakeFrame(), { timestamp: 2_000 });
  const pending = f.frame({ serial: 2, timestamp: 2_000 }, first);
  await f.flush();
  for (let serial = 3; serial < 100; serial++) {
    const value = Object.assign(new FakeFrame(), { timestamp: serial * 1_000 });
    await f.frame({ serial, timestamp: value.timestamp, slot: serial % 3 }, value);
    assert.equal(value.closes, 1);
  }
  assert.equal(f.writes.length, 2, 'one initial and one in-flight write, with no queued writes');
  const busyDiagnostics = getNativeScreenCaptureDiagnostics(candidate.stream.getVideoTracks()[0]);
  assert.equal(busyDiagnostics?.framesReceived, 99);
  assert.equal(busyDiagnostics?.framesWritten, 1);
  assert.equal(busyDiagnostics?.framesDroppedWhileBusy, 97);
  assert.equal(first.closes, 0);
  write.resolve();
  await pending;
  assert.equal(first.closes, 1);
  assert.equal(getNativeScreenCaptureDiagnostics(candidate.stream.getVideoTracks()[0])?.framesWritten, 2);
  candidate.stop();
});

test('diagnostics count validated frames and successful write time, returning detached snapshots', async (context) => {
  let now = 0;
  replaceGlobal(context, 'performance', { now: () => now });
  const f = fixture(context);
  const { candidate } = await f.ready();
  const track = candidate.stream.getVideoTracks()[0];
  assert.equal(getNativeScreenCaptureDiagnostics(f.stock as unknown as MediaStreamTrack), null);
  assert.deepEqual(getNativeScreenCaptureDiagnostics(track), {
    backend: 'native-gpu', framesReceived: 1, refreshFrames: 0, framesWritten: 1,
    framesDroppedWhileBusy: 0, totalWriteMs: 0, maxWriteMs: 0,
  });
  f.setWrite(async () => { now += 7.5; });
  await f.frame({ serial: 2, timestamp: 2_000, refresh: true }, Object.assign(new FakeFrame(), { timestamp: 2_000 }));
  f.setWrite(async () => { now += 12; });
  await f.frame({ serial: 3, timestamp: 3_000 }, Object.assign(new FakeFrame(), { timestamp: 3_000 }));
  await f.frame({ serial: 3, timestamp: 3_000 }, Object.assign(new FakeFrame(), { timestamp: 3_000 }));
  await f.frame({ serial: 4, slot: 3 });
  const snapshot = getNativeScreenCaptureDiagnostics(track)!;
  assert.deepEqual(snapshot, {
    backend: 'native-gpu', framesReceived: 3, refreshFrames: 1, framesWritten: 3,
    framesDroppedWhileBusy: 0, totalWriteMs: 19.5, maxWriteMs: 12,
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
