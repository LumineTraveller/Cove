import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  tryNativeScreenCapture,
  observeNativeFrameStability,
  getNativeScreenCaptureDiagnostics,
  type NativeScreenBridge,
} from '../src/features/media/screen/nativeScreenCapture';
import type { NativeScreenFrame } from '../electron/native-screen-capture-protocol';

function replaceGlobal(context: TestContext, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  });
}

class Track extends EventTarget {
  readyState = 'live';
  contentHint = '';
  stops = 0;
  settings: MediaTrackSettings = { width: 1920, height: 1080, displaySurface: 'monitor' };
  getSettings() { return this.settings; }
  stop() { this.stops++; this.readyState = 'ended'; }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}

class Stream {
  constructor(readonly tracks: Track[]) {}
  getVideoTracks() { return this.tracks; }
  getAudioTracks() { return []; }
}

function fixture(context: TestContext) {
  let now = 1_000;
  let writes = 0;
  let closes = 0;
  let bridgeStops = 0;
  const tracks: Track[] = [];
  const requests: string[] = [];
  const serials = new Map<string, number>();
  const callbacks = new Map<string, Parameters<NativeScreenBridge['onFrame']>[1]>();
  const priorCallbacks = new Map<string, Parameters<NativeScreenBridge['onFrame']>[1]>();
  const ended = new Map<string, (reason: string) => void>();
  const controllers: AbortController[] = [];
  const candidates: { stop(): void }[] = [];
  const bridge: NativeScreenBridge = {
    supported: true,
    start: async requestId => {
      requests.push(requestId);
      serials.set(requestId, 0);
      return { ok: true, sessionId: 'fixture-session', width: 1920, height: 1080 };
    },
    stop: async () => { bridgeStops++; return true; },
    onFrame: (id, callback) => {
      callbacks.set(id, callback); priorCallbacks.set(id, callback);
      return () => { callbacks.delete(id); };
    },
    onEnded: (id, callback) => {
      ended.set(id, callback);
      return () => { ended.delete(id); };
    },
  };
  class Generator extends Track {
    writable = { getWriter: () => ({
      write: async () => { writes++; this.settings = { width: 1920, height: 1080 }; },
      abort: async () => {}, releaseLock: () => {},
    }) };
    constructor() { super(); this.settings = {}; tracks.push(this); }
  }
  replaceGlobal(context, 'window', { coveNativeScreen: bridge });
  replaceGlobal(context, 'MediaStream', Stream);
  replaceGlobal(context, 'MediaStreamTrackGenerator', Generator);
  replaceGlobal(context, 'performance', { now: () => now });
  context.after(() => {
    for (const candidate of candidates) candidate.stop();
    for (const controller of controllers) controller.abort();
  });
  async function flush() { for (let n = 0; n < 8; n++) await Promise.resolve(); }
  async function send(timestampUs: number, options: {
    requestId?: string; metadata?: Partial<NativeScreenFrame>; late?: boolean; wallDelta?: number;
  } = {}) {
    const requestId = options.requestId ?? requests.at(-1)!;
    const serial = (serials.get(requestId) ?? 0) + 1;
    serials.set(requestId, serial);
    now += options.wallDelta ?? 8.333;
    const metadata: NativeScreenFrame = {
      requestId, sessionId: 'fixture-session', width: 1920, height: 1080,
      slot: 0, serial, timestamp: timestampUs, refresh: false, ...options.metadata,
    };
    const frame = {
      displayWidth: 1920, displayHeight: 1080, timestamp: timestampUs,
      close() { closes++; },
    } as unknown as VideoFrame;
    await (options.late ? priorCallbacks : callbacks).get(requestId)?.(frame, metadata);
  }
  async function ready(commit = true) {
    const controller = new AbortController(); controllers.push(controller);
    const stock = new Track();
    const pending = tryNativeScreenCapture(new Stream([stock]) as unknown as MediaStream, {
      maxWidth: 1920, maxHeight: 1080, fps: 120, nativeResolution: false,
      contentHint: 'motion', isCurrent: () => true, signal: controller.signal,
    });
    await flush();
    const requestId = requests.at(-1)!;
    await send(1_000, { requestId });
    const candidate = await pending;
    assert.ok(candidate);
    candidates.push(candidate);
    if (commit) candidate.commit();
    const track = candidate.stream.getVideoTracks()[0];
    return { candidate, track, requestId, controller, stock };
  }
  return {
    ready, send, tracks, callbacks, ended,
    get now() { return now; },
    get writes() { return writes; },
    get closes() { return closes; },
    get bridgeStops() { return bridgeStops; },
  };
}

test('native frame stability is unavailable for stock tracks and ended native tracks', async context => {
  const f = fixture(context);
  assert.equal(observeNativeFrameStability(new Track() as unknown as MediaStreamTrack), null);
  const { candidate, track } = await f.ready();
  const observer = observeNativeFrameStability(track);
  assert.ok(observer);
  candidate.stop();
  assert.equal(observeNativeFrameStability(track), null);
  assert.equal(observer.snapshot(f.now).sampleCount, 0);
  assert.equal(observer.snapshot(f.now).lowFps, null);
  observer.dispose(); observer.dispose();
});

test('sampling is opt-in and helper timestamps, rather than callback scheduling, determine intervals', async context => {
  const f = fixture(context);
  const { track } = await f.ready();
  for (let n = 1; n <= 20; n++) await f.send(1_000 + n * 8_333);
  const observer = observeNativeFrameStability(track);
  assert.ok(observer);
  assert.equal(observer.snapshot(f.now).sampleCount, 0, 'Old frames are not retrospectively sampled');
  for (let n = 21; n <= 121; n++)
    await f.send(1_000 + n * 8_333, { wallDelta: n % 2 ? 1 : 20 });
  const snapshot = observer.snapshot(f.now);
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.sampleCount, 100);
  assert.ok(Math.abs(snapshot.lowFps! - 120.0048) < 0.01);
  assert.equal(getNativeScreenCaptureDiagnostics(track)?.framesReceived, 122);
  assert.equal(f.writes, 122);
  assert.equal(f.closes, 122, 'Observation retains no GPU frame');
  observer.dispose();
});

test('only fully validated metadata reaches stability observers', async context => {
  const f = fixture(context);
  const { track, requestId } = await f.ready();
  const observer = observeNativeFrameStability(track);
  assert.ok(observer);
  await f.send(10_000);
  await f.send(20_000, { metadata: { requestId: 'stale-request' } });
  await f.send(30_000, { metadata: { sessionId: 'stale-session' } });
  await f.send(40_000, { metadata: { serial: 1 } });
  await f.send(50_000, { metadata: { slot: 99 } });
  assert.equal(observer.snapshot(f.now).sampleCount, 0);
  await f.send(60_000, { requestId });
  assert.equal(observer.snapshot(f.now).sampleCount, 1);
  assert.equal(getNativeScreenCaptureDiagnostics(track)?.framesReceived, 3);
  await f.send(70_000, { metadata: { width: 1280 } });
  assert.equal(observeNativeFrameStability(track), null, 'Existing malformed-frame teardown still runs');
  assert.equal(observer.snapshot(f.now).sampleCount, 0);
});

test('independent observers release only their own window and can restart without old samples', async context => {
  const f = fixture(context);
  const { track } = await f.ready();
  const first = observeNativeFrameStability(track)!;
  const second = observeNativeFrameStability(track)!;
  await f.send(10_000); await f.send(20_000);
  assert.equal(first.snapshot(f.now).sampleCount, 1);
  assert.equal(second.snapshot(f.now).sampleCount, 1);
  first.dispose(); first.dispose();
  await f.send(30_000);
  assert.equal(first.snapshot(f.now).sampleCount, 0);
  assert.equal(second.snapshot(f.now).sampleCount, 2);
  const replacement = observeNativeFrameStability(track)!;
  first.dispose();
  await f.send(40_000); await f.send(50_000);
  assert.equal(replacement.snapshot(f.now).sampleCount, 1);
  assert.equal(second.snapshot(f.now).sampleCount, 4);
  second.dispose(); replacement.dispose();
});

test('stop and late callbacks retire statistics while preserving native frame release', async context => {
  const f = fixture(context);
  const { candidate, track, requestId } = await f.ready();
  const observer = observeNativeFrameStability(track)!;
  await f.send(10_000); await f.send(20_000);
  candidate.stop();
  const beforeWrites = f.writes, beforeCloses = f.closes;
  await f.send(30_000, { requestId, late: true });
  assert.equal(f.writes, beforeWrites);
  assert.equal(f.closes, beforeCloses + 1);
  assert.equal(observer.snapshot(f.now).sampleCount, 0);
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.ended.size, 0);
  observer.dispose();
});

test('precommit cancellation resets the observer and old track end cannot erase a successor', async context => {
  const f = fixture(context);
  const first = await f.ready(false);
  const oldObserver = observeNativeFrameStability(first.track)!;
  await f.send(10_000); await f.send(20_000);
  first.controller.abort();
  assert.equal(oldObserver.snapshot(f.now).sampleCount, 0);
  const next = await f.ready();
  const nextObserver = observeNativeFrameStability(next.track)!;
  await f.send(10_000); await f.send(20_000);
  f.tracks[0].end(); oldObserver.dispose();
  await f.send(30_000);
  assert.equal(nextObserver.snapshot(f.now).sampleCount, 2);
  assert.ok(observeNativeFrameStability(next.track));
  next.candidate.stop();
  assert.equal(nextObserver.snapshot(f.now).sampleCount, 0);
});
