import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useScreenPublishing, type useScreenPublishingDependencies } from '../src/features/media/screen/useScreenPublishing';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

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
  const observer = new EventEmitter();
  return { id, closed: false, closes: 0, appData: {}, observer,
    track: null as ReturnType<typeof stream>['track'] | null, pause() {},
    close() { this.closed = true; this.closes++; observer.emit('close'); },
    async replaceTrack({ track }: { track: ReturnType<typeof stream>['track'] }) { this.track = track; } };
}

function fixture(t: TestContext) {
  const replace = (name: string, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  };
  const alerts: string[] = [], events: any[] = [], produced: any[] = [];
  const captureRequests: DisplayMediaStreamOptions[] = [];
  let sharing = false, captures = 0, sequence = 0;
  let capture = async () => stream();
  let startAudio = async (_isCurrent?: () => boolean) => {};
  let closeAudio = () => {};
  let publish = async (options: any) => {
    const value = producer(`producer-${++sequence}`);
    value.track = options.track;
    return value;
  };
  replace('navigator', { mediaDevices: { getDisplayMedia: (options: DisplayMediaStreamOptions) => {
    captureRequests.push(options); captures++; return capture();
  } } });
  replace('window', { alert: (message: string) => alerts.push(message), coveScreenAudio: {} });
  replace('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  const ref = () => ({ current: null as any });
  const noop = () => {};
  const mediaGeneration = { current: 0 }, screenProducer = ref(), screenAudioProducer = ref(), localScreenRef = ref();
  const sendTransport = { current: { produce: async (options: any) => { produced.push(options); return publish(options); } } as any };
  const settings = { preset: '720p', fps: 30, gameMode: false, nativeResolution: false, audio: false };
  const deps = {
    inVoice: true, get isSharing() { return sharing; }, mediaGeneration,
    screenPreset: '720p', fps: 30, screenGameMode: false, screenNativeResolution: false,
    screenCompatibilityMode: false, get shareAudio() { return settings.audio; },
    setScreenPreset: (value: string) => { settings.preset = value; },
    setFps: (value: number) => { settings.fps = value; }, setShareAudio: (value: boolean) => { settings.audio = value; },
    setScreenGameMode: (value: boolean) => { settings.gameMode = value; },
    setScreenNativeResolution: (value: boolean) => { settings.nativeResolution = value; }, setScreenCompatibilityMode: noop,
    setLocalScreen: noop, setScreenEncodingPlan: noop, setScreenViewerCount: noop, setScreenActivity: noop, setStats: noop,
    setIsSharing: (value: boolean) => { sharing = value; },
    localScreenRef, screenProducer, sendTransport, videoCounterPrev: ref(), remoteLossPrev: ref(),
    screenAudioProducer, screenAudioUnsubscribe: ref(), screenAudioPipeline: ref(),
    watchingScreenPeerRef: ref(), screenDemandActiveRef: { current: true }, screenActivityRef: { current: 'active' },
    socket: { id: 'desktop', connected: true, emit: (...args: any[]) => events.push(args) }, roomId: 'room',
    deviceRef: { current: { rtpCapabilities: { codecs: [] }, sendRtpCapabilities: { codecs: [] } } },
    armScreenRampGuard: noop, applyScreenActivity: noop, stopScreenAnalysis: noop, startScreenAnalysis: noop,
    startScreenAudio: (isCurrent?: () => boolean) => startAudio(isCurrent), clearScreenRampGuard: noop, closeScreenAudio: () => closeAudio(),
    clearAvailableScreens: noop, clearRemoteApplicationAudios: noop,
  } as unknown as useScreenPublishingDependencies;
  let api!: ReturnType<typeof useScreenPublishing>;
  function Probe() { api = useScreenPublishing(deps); return null; }
  renderToStaticMarkup(createElement(Probe));
  return { api, alerts, events, produced, captureRequests, settings, mediaGeneration, screenProducer, screenAudioProducer, localScreenRef, sendTransport,
    captures: () => captures, sharing: () => sharing,
    capture: (next: typeof capture) => { capture = next; }, publish: (next: typeof publish) => { publish = next; },
    startAudio: (next: typeof startAudio) => { startAudio = next; }, closeAudio: (next: typeof closeAudio) => { closeAudio = next; } };
}

test('changing screen source keeps audio ownership, while audio toggles and stop release the producer', async t => {
  const f = fixture(t);
  let starts = 0, closes = 0;
  f.startAudio(async () => { starts++; f.screenAudioProducer.current = producer(`audio-${starts}`); });
  f.closeAudio(() => { closes++; f.screenAudioProducer.current?.close(); f.screenAudioProducer.current = null; });
  await f.api.startScreenShare('720p', 30, true);
  const firstAudio = f.screenAudioProducer.current;
  assert.ok(firstAudio);
  assert.equal(f.settings.audio, true);
  await f.api.updateScreenShare('1080p', 30, true);
  assert.equal(f.screenAudioProducer.current, firstAudio, 'replacing video keeps the audio producer');
  assert.equal(starts, 1);
  assert.equal(closes, 0);
  await f.api.updateScreenShare('1080p', 30, false);
  assert.equal(firstAudio.closed, true);
  assert.equal(f.screenAudioProducer.current, null);
  assert.equal(f.settings.audio, false);
  await f.api.updateScreenShare('1080p', 30, true);
  assert.ok(f.screenAudioProducer.current);
  assert.equal(starts, 2);
  assert.equal(f.settings.audio, true);
  f.api.stopScreenShare();
  assert.equal(f.screenAudioProducer.current, null);
  assert.equal(closes, 2);
});

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

test('updates acquire immediately but commit in call order when capture results arrive backwards', async t => {
  const f = fixture(t), original = stream(), first = stream(), last = stream();
  f.capture(async () => original);
  await f.api.startScreenShare();
  const active = f.screenProducer.current;
  const firstCapture = deferred<ReturnType<typeof stream>>(), lastCapture = deferred<ReturnType<typeof stream>>();
  let captures = 0;
  f.capture(() => ++captures === 1 ? firstCapture.promise : lastCapture.promise);
  const firstUpdate = f.api.updateScreenShare('540p', 120);
  const lastUpdate = f.api.updateScreenShare('1080p', 60);
  assert.equal(captures, 2, 'both capture requests retain the originating user activation');
  lastCapture.resolve(last);
  await flush();
  const beforeFirstCapture = f.localScreenRef.current;
  firstCapture.resolve(first);
  await Promise.all([firstUpdate, lastUpdate]);
  assert.equal(beforeFirstCapture, original, 'a later ready capture must not jump an earlier update');
  assert.equal(f.screenProducer.current, active);
  assert.equal(f.localScreenRef.current, last);
  assert.equal(active.track, last.track);
  assert.equal(original.track.stops, 1);
  assert.equal(first.track.stops, 1);
  assert.equal(last.track.stops, 0);
  assert.equal(f.settings.preset, '1080p');
  assert.equal(f.settings.fps, 60);
  assert.deepEqual(f.alerts, []);
});

test('a ready update waits for an in-flight replacement without stopping the attached track', async t => {
  const f = fixture(t), original = stream(), first = stream(), last = stream();
  f.capture(async () => original);
  await f.api.startScreenShare();
  const active = f.screenProducer.current;
  const replacing = deferred<void>(), replacements: unknown[] = [];
  active.replaceTrack = async ({ track }: { track: typeof first.track }) => {
    replacements.push(track);
    active.track = track;
    if (track === first.track) await replacing.promise;
  };
  f.capture(async () => first);
  const firstUpdate = f.api.updateScreenShare('540p', 120);
  await flush();
  f.capture(async () => last);
  const lastUpdate = f.api.updateScreenShare('1080p', 60);
  await flush();
  const replacementsWhilePending = replacements.slice();
  const attachedWhilePending = active.track;
  const firstStopsWhilePending = first.track.stops;
  replacing.resolve();
  await Promise.all([firstUpdate, lastUpdate]);
  assert.deepEqual(replacementsWhilePending, [first.track]);
  assert.equal(attachedWhilePending, first.track);
  assert.equal(firstStopsWhilePending, 0);
  assert.deepEqual(replacements, [first.track, last.track]);
  assert.equal(f.localScreenRef.current, last);
  assert.equal(active.track, last.track);
  assert.equal(original.track.stops, 1);
  assert.equal(first.track.stops, 1);
  assert.equal(last.track.stops, 0);
});

test('stop releases ready queued candidates before a pending replacement completes and a new session can update', async t => {
  const f = fixture(t), original = stream(), pending = stream(), queued = stream(), current = stream(), newest = stream();
  f.capture(async () => original);
  await f.api.startScreenShare();
  const oldProducer = f.screenProducer.current, replacing = deferred<void>();
  oldProducer.replaceTrack = async ({ track }: { track: typeof pending.track }) => {
    oldProducer.track = track;
    await replacing.promise;
  };
  f.capture(async () => pending);
  const firstUpdate = f.api.updateScreenShare('540p', 120);
  await flush();
  f.capture(async () => queued);
  const queuedUpdate = f.api.updateScreenShare('1080p', 60);
  await flush();
  f.api.stopScreenShare();
  const candidateStopsAtStop = [pending.track.stops, queued.track.stops];
  f.capture(async () => current);
  await f.api.startScreenShare();
  const active = f.screenProducer.current;
  f.capture(async () => newest);
  let newUpdateFinished = false;
  const newUpdate = f.api.updateScreenShare('1440p', 120, false, true, true).then(() => { newUpdateFinished = true; });
  await flush();
  const finishedBeforeOldReplacement = newUpdateFinished;
  replacing.resolve();
  await Promise.all([firstUpdate, queuedUpdate, newUpdate]);
  assert.deepEqual(candidateStopsAtStop, [1, 1], 'stop owns every uncommitted candidate, even behind a pending replacement');
  assert.equal(finishedBeforeOldReplacement, true, 'new sessions do not share the old pending queue');
  assert.equal(f.screenProducer.current, active);
  assert.equal(f.localScreenRef.current, newest);
  assert.equal(active.track, newest.track);
  assert.equal(newest.track.stops, 0);
  assert.equal(current.track.stops, 1);
  assert.equal(pending.track.stops, 1);
  assert.equal(queued.track.stops, 1);
  assert.equal(f.settings.preset, '1440p');
  assert.equal(f.settings.nativeResolution, true);
  assert.deepEqual(f.alerts, []);
});

test('leaving closes ready queued captures while a previous capture is still pending', async t => {
  const f = fixture(t), original = stream(), late = stream(), queued = stream();
  f.capture(async () => original);
  await f.api.startScreenShare();
  const active = f.screenProducer.current, pendingCapture = deferred<ReturnType<typeof stream>>();
  f.capture(() => pendingCapture.promise);
  const firstUpdate = f.api.updateScreenShare('540p', 120);
  f.capture(async () => queued);
  const queuedUpdate = f.api.updateScreenShare('1080p', 60);
  await flush();
  f.mediaGeneration.current++;
  active.close();
  f.screenProducer.current = null;
  f.sendTransport.current = null;
  f.localScreenRef.current?.getTracks().forEach((track: typeof original.track) => track.stop());
  f.localScreenRef.current = null;
  const queuedStopsAtLeave = queued.track.stops;
  pendingCapture.resolve(late);
  await Promise.all([firstUpdate, queuedUpdate]);
  assert.equal(queuedStopsAtLeave, 1, 'producer close releases candidates without waiting for the old picker');
  assert.equal(late.track.stops, 1);
  assert.equal(queued.track.stops, 1);
  assert.equal(f.screenProducer.current, null);
  assert.equal(f.localScreenRef.current, null);
  assert.deepEqual(f.alerts, []);
});

test('canceling a later capture preserves the successful earlier update', async t => {
  const f = fixture(t), original = stream(), first = stream();
  f.capture(async () => original);
  await f.api.startScreenShare();
  const active = f.screenProducer.current, firstCapture = deferred<ReturnType<typeof stream>>();
  f.capture(() => firstCapture.promise);
  const firstUpdate = f.api.updateScreenShare('540p', 120);
  f.capture(async () => { throw new DOMException('picker canceled', 'NotAllowedError'); });
  const canceledUpdate = f.api.updateScreenShare('1080p', 60);
  await flush();
  firstCapture.resolve(first);
  await Promise.all([firstUpdate, canceledUpdate]);
  assert.equal(f.screenProducer.current, active);
  assert.equal(f.localScreenRef.current, first);
  assert.equal(active.track, first.track);
  assert.equal(original.track.stops, 1);
  assert.equal(first.track.stops, 0);
  assert.equal(f.settings.preset, '540p');
  assert.equal(f.settings.fps, 120);
  assert.deepEqual(f.alerts, []);
});

test('a failed replacement releases only its candidate and a later update can still commit', async t => {
  const f = fixture(t), original = stream(), failed = stream(), last = stream();
  f.capture(async () => original);
  await f.api.startScreenShare();
  const active = f.screenProducer.current, lastCapture = deferred<ReturnType<typeof stream>>();
  active.replaceTrack = async ({ track }: { track: typeof failed.track }) => {
    if (track === failed.track) throw new Error('replace failed');
    active.track = track;
  };
  f.capture(async () => failed);
  const failedUpdate = f.api.updateScreenShare('540p', 120);
  f.capture(() => lastCapture.promise);
  const lastUpdate = f.api.updateScreenShare('1080p', 60);
  await failedUpdate;
  const beforeLast = f.localScreenRef.current;
  const originalStopsBeforeLast = original.track.stops;
  lastCapture.resolve(last);
  await lastUpdate;
  assert.equal(beforeLast, original);
  assert.equal(originalStopsBeforeLast, 0);
  assert.equal(failed.track.stops, 1);
  assert.equal(f.localScreenRef.current, last);
  assert.equal(active.track, last.track);
  assert.equal(original.track.stops, 1);
  assert.equal(last.track.stops, 0);
  assert.equal(f.alerts.length, 1);
});

test('the committed track ending during audio startup stops the share and releases a queued capture', async t => {
  const f = fixture(t), original = stream(), current = stream(), queued = stream();
  f.capture(async () => original);
  await f.api.startScreenShare();
  const active = f.screenProducer.current, pendingAudio = deferred<void>();
  f.startAudio(() => pendingAudio.promise);
  f.capture(async () => current);
  const firstUpdate = f.api.updateScreenShare('540p', 120, true);
  await flush();
  f.capture(async () => queued);
  const queuedUpdate = f.api.updateScreenShare('1080p', 60, false);
  await flush();
  current.track.readyState = 'ended';
  current.track.onended?.();
  const stoppedWhileAudioPending = !f.sharing();
  const queuedStopsWhileAudioPending = queued.track.stops;
  pendingAudio.resolve();
  await Promise.all([firstUpdate, queuedUpdate]);
  assert.equal(stoppedWhileAudioPending, true);
  assert.equal(queuedStopsWhileAudioPending, 1);
  assert.equal(active.closed, true);
  assert.equal(f.screenProducer.current, null);
  assert.equal(f.localScreenRef.current, null);
  assert.equal(current.track.stops, 1);
  assert.equal(queued.track.stops, 1);
  assert.deepEqual(f.alerts, []);
});

test('initial capture ending during audio startup closes its publication before a new share starts', async t => {
  const f = fixture(t), ended = stream(), current = stream(), pendingAudio = deferred<void>();
  f.startAudio(() => pendingAudio.promise);
  f.capture(async () => ended);
  const oldStart = f.api.startScreenShare('540p', 120, true);
  await flush();
  const oldProducer = f.screenProducer.current;
  ended.track.readyState = 'ended';
  ended.track.onended?.();
  const closedWhileAudioPending = oldProducer.closed;
  const publicationWhileAudioPending = f.screenProducer.current;
  const streamWhileAudioPending = f.localScreenRef.current;
  f.capture(async () => current);
  await f.api.startScreenShare('1080p', 60, false);
  const active = f.screenProducer.current;
  pendingAudio.resolve();
  await oldStart;
  assert.equal(closedWhileAudioPending, true);
  assert.equal(publicationWhileAudioPending, null);
  assert.equal(streamWhileAudioPending, null);
  assert.notEqual(active, oldProducer);
  assert.equal(f.screenProducer.current, active);
  assert.equal(f.localScreenRef.current, current);
  assert.equal(active.closed, false);
  assert.equal(current.track.stops, 0);
  assert.equal(f.sharing(), true);
  assert.deepEqual(f.alerts, []);
});

test('publishing hooks bound preset capture dimensions and keep native capture unconstrained', async t => {
  const f = fixture(t);
  await f.api.startScreenShare('540p', 120, false, false, false);
  await f.api.updateScreenShare('1080p', 120, false, false, false);
  await f.api.updateScreenShare('1080p', 120, false, false, true);
  f.api.stopScreenShare();
  await f.api.startScreenShare('1080p', 60, false, false, false);
  assert.deepEqual(f.captureRequests, [
    { video: { frameRate: { ideal: 120, max: 120 }, width: { max: 960 }, height: { max: 540 } }, audio: false },
    { video: { frameRate: { ideal: 120, max: 120 }, width: { max: 1920 }, height: { max: 1080 } }, audio: false },
    { video: { frameRate: { ideal: 120, max: 120 } }, audio: false },
    { video: { frameRate: { ideal: 60, max: 60 }, width: { max: 1920 }, height: { max: 1080 } }, audio: false },
  ]);
  assert.deepEqual(f.alerts, []);
});
