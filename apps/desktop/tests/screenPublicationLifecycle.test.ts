import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useScreenPublishing, type useScreenPublishingDependencies } from '../src/features/media/screen/useScreenPublishing';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function stream() {
  const track = {
    readyState: 'live', contentHint: '', onended: null as (() => void) | null, stops: 0,
    getSettings: () => ({ width: 1280, height: 720 }),
    getConstraints: () => ({}), getCapabilities: () => ({}),
    stop() { this.stops++; this.readyState = 'ended'; },
  };
  return { track, getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] };
}

function producer(id: string) {
  return { id, closed: false, closes: 0, appData: {}, pause() {},
    close() { this.closed = true; this.closes++; }, replaceTrack: async (_: unknown) => {} };
}

function fixture(t: TestContext) {
  const replace = (name: string, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  };
  const alerts: string[] = [], events: any[] = [], produced: any[] = [];
  let sharing = false, captures = 0, sequence = 0;
  let capture = async () => stream();
  let publish = async (_: any) => producer(`producer-${++sequence}`);
  replace('navigator', { mediaDevices: { getDisplayMedia: () => { captures++; return capture(); } } });
  replace('window', { alert: (message: string) => alerts.push(message) });
  replace('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  const ref = () => ({ current: null as any });
  const noop = () => {};
  const mediaGeneration = { current: 0 }, screenProducer = ref(), localScreenRef = ref();
  const sendTransport = { current: { produce: async (options: any) => { produced.push(options); return publish(options); } } as any };
  const deps = {
    inVoice: true, get isSharing() { return sharing; }, mediaGeneration,
    screenPreset: '720p', fps: 30, screenGameMode: false, screenNativeResolution: false,
    screenCompatibilityMode: false, shareAudio: false,
    setScreenPreset: noop, setFps: noop, setShareAudio: noop, setScreenGameMode: noop,
    setScreenNativeResolution: noop, setScreenCompatibilityMode: noop,
    setLocalScreen: noop, setScreenEncodingPlan: noop, setScreenViewerCount: noop, setScreenActivity: noop, setStats: noop,
    setIsSharing: (value: boolean) => { sharing = value; },
    localScreenRef, screenProducer, sendTransport, videoCounterPrev: ref(), remoteLossPrev: ref(),
    screenAudioProducer: ref(), screenAudioUnsubscribe: ref(), screenAudioPipeline: ref(),
    watchingScreenPeerRef: ref(), screenDemandActiveRef: { current: true }, screenActivityRef: { current: 'active' },
    socket: { id: 'desktop', connected: true, emit: (...args: any[]) => events.push(args) }, roomId: 'room',
    deviceRef: { current: { rtpCapabilities: { codecs: [] }, sendRtpCapabilities: { codecs: [] } } },
    armScreenRampGuard: noop, applyScreenActivity: noop, stopScreenAnalysis: noop, startScreenAnalysis: noop,
    startScreenAudio: async () => {}, clearScreenRampGuard: noop, closeScreenAudio: noop,
    clearAvailableScreens: noop, clearRemoteApplicationAudios: noop,
  } as unknown as useScreenPublishingDependencies;
  let api!: ReturnType<typeof useScreenPublishing>;
  function Probe() { api = useScreenPublishing(deps); return null; }
  renderToStaticMarkup(createElement(Probe));
  return { api, alerts, events, produced, mediaGeneration, screenProducer, localScreenRef, sendTransport,
    captures: () => captures, sharing: () => sharing,
    capture: (next: typeof capture) => { capture = next; }, publish: (next: typeof publish) => { publish = next; } };
}

test('leaving while the picker is pending releases only the late captured track without publishing', async t => {
  const f = fixture(t), pending = deferred<ReturnType<typeof stream>>(), late = stream();
  f.capture(() => pending.promise);
  const start = f.api.startScreenShare();
  f.mediaGeneration.current++;
  f.sendTransport.current = null;
  pending.resolve(late);
  await start;
  assert.equal(f.produced.length, 0);
  assert.equal(late.track.readyState, 'ended');
  assert.equal(f.sharing(), false);
  assert.deepEqual(f.alerts, []);
});

test('a picker result from an old voice generation cannot publish on the replacement transport', async t => {
  const f = fixture(t), pending = deferred<ReturnType<typeof stream>>(), late = stream();
  f.capture(() => pending.promise);
  const start = f.api.startScreenShare();
  f.mediaGeneration.current++;
  let replacementPublishes = 0;
  f.sendTransport.current = { produce: async () => { replacementPublishes++; return producer('new-room'); } };
  pending.resolve(late);
  await start;
  assert.equal(replacementPublishes, 0);
  assert.equal(late.track.readyState, 'ended');
  assert.equal(f.screenProducer.current, null);
});

test('a new voice session can start sharing before its old picker returns', async t => {
  const f = fixture(t), pending = deferred<ReturnType<typeof stream>>(), late = stream(), current = stream();
  f.capture(() => pending.promise);
  const oldStart = f.api.startScreenShare();
  f.mediaGeneration.current++;
  f.sendTransport.current = { produce: async () => producer('new-room') };
  f.capture(async () => current);
  await f.api.startScreenShare();
  const captures = f.captures(), active = f.screenProducer.current;
  pending.resolve(late);
  await oldStart;
  assert.equal(captures, 2);
  assert.equal(active?.id, 'new-room');
  assert.equal(f.screenProducer.current, active);
  assert.equal(current.track.readyState, 'live');
  assert.equal(late.track.readyState, 'ended');
});

test('stop then start wins over the old picker result and its cleanup cannot stop the new share', async t => {
  const f = fixture(t), pending = deferred<ReturnType<typeof stream>>(), late = stream(), current = stream();
  f.capture(() => pending.promise);
  const oldStart = f.api.startScreenShare();
  f.api.stopScreenShare();
  f.capture(async () => current);
  await f.api.startScreenShare();
  const active = f.screenProducer.current;
  pending.resolve(late);
  await oldStart;
  assert.equal(f.produced.length, 1);
  assert.equal(f.screenProducer.current, active);
  assert.equal(f.localScreenRef.current, current);
  assert.equal(current.track.readyState, 'live');
  assert.equal(active.closes, 0);
  assert.equal(late.track.readyState, 'ended');
  assert.equal(f.sharing(), true);
});

test('a late producer is closed as its own resource without replacing or closing a newer producer', async t => {
  const f = fixture(t), pending = deferred<ReturnType<typeof producer>>(), oldProducer = producer('old');
  f.publish(() => pending.promise);
  const oldStart = f.api.startScreenShare();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.produced.length, 1);
  f.api.stopScreenShare();
  f.publish(async () => producer('current'));
  await f.api.startScreenShare();
  const active = f.screenProducer.current;
  pending.resolve(oldProducer);
  await oldStart;
  assert.equal(oldProducer.closed, true);
  assert.equal(active.closed, false);
  assert.equal(f.screenProducer.current, active);
  assert.equal(f.sharing(), true);
});

test('late replaceTrack completion cannot restore the previous capture over a new share', async t => {
  const f = fixture(t), first = stream(), late = stream(), current = stream();
  f.capture(async () => first);
  await f.api.startScreenShare();
  const pending = deferred<void>();
  f.screenProducer.current.replaceTrack = () => pending.promise;
  f.capture(async () => late);
  const update = f.api.updateScreenShare();
  await new Promise(resolve => setImmediate(resolve));
  f.api.stopScreenShare();
  f.capture(async () => current);
  await f.api.startScreenShare();
  const active = f.screenProducer.current;
  pending.resolve();
  await update;
  assert.equal(f.localScreenRef.current, current);
  assert.equal(f.screenProducer.current, active);
  assert.equal(current.track.readyState, 'live');
  assert.equal(late.track.readyState, 'ended');
  assert.equal(f.sharing(), true);
});

test('a queued ended event for a previous track cannot stop the new share', async t => {
  const f = fixture(t), first = stream();
  f.capture(async () => first);
  await f.api.startScreenShare();
  const ended = first.track.onended!;
  f.api.stopScreenShare();
  f.capture(async () => stream());
  await f.api.startScreenShare();
  const active = f.screenProducer.current;
  ended();
  assert.equal(f.screenProducer.current, active);
  assert.equal(active.closed, false);
  assert.equal(f.sharing(), true);
});

test('repeated start while the same picker is pending does not request another capture', async t => {
  const f = fixture(t), pending = deferred<ReturnType<typeof stream>>();
  f.capture(() => pending.promise);
  const first = f.api.startScreenShare();
  const second = f.api.startScreenShare();
  assert.equal(f.captures(), 1);
  pending.resolve(stream());
  await Promise.all([first, second]);
  assert.equal(f.produced.length, 1);
});
