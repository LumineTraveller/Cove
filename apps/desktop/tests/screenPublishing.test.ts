import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useScreenPublishing, type useScreenPublishingDependencies } from '../src/features/media/screen/useScreenPublishing';
import { useScreenAnalysis, type useScreenAnalysisDependencies } from '../src/features/media/screen/useScreenAnalysis';
import { useMediaDiagnostics, type useMediaDiagnosticsDependencies } from '../src/features/media/diagnostics/useMediaDiagnostics';
import { createScreenEncodingPlan, type ScreenFps, type ScreenPreset, type ScreenActivity } from '../src/features/media/screen/screenCapture';
import type { NativeScreenBridge } from '../src/features/media/screen/nativeScreenCapture';

function renderHook<T>(hook: () => T): T {
  let value: T | undefined;
  function Probe() { value = hook(); return null; }
  renderToStaticMarkup(createElement(Probe));
  return value!;
}

function replaceGlobal(context: { after: (cleanup: () => void) => void }, name: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  });
}

test('real publishing hooks carry selected 120 through normal/game start and source update', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  replaceGlobal(context, 'requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  const captures: DisplayMediaStreamOptions[] = [];
  const produced: Record<string, any>[] = [];
  const activities: unknown[][] = [];
  const guards: unknown[][] = [];
  const analyses: unknown[][] = [];
  let analysisStops = 0;
  let replacements = 0;
  const tracks = Array.from({ length: 4 }, () => ({
    readyState: 'live', contentHint: '', onended: null,
    getSettings: () => ({ width: 2560, height: 1600, frameRate: 60 }),
    getConstraints: () => ({}), getCapabilities: () => ({}),
    stop() { this.readyState = 'ended'; },
  }));
  const streams = tracks.map((track) => ({ getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] }));
  replaceGlobal(context, 'navigator', { mediaDevices: { getDisplayMedia: async (constraints: DisplayMediaStreamOptions) => {
    captures.push(constraints); return streams[captures.length - 1];
  } } });
  replaceGlobal(context, 'window', { alert: (message: string) => { throw new Error(message); } });
  let senderParameters: RTCRtpSendParameters = {
    transactionId: 'same-sender', codecs: [], headerExtensions: [], rtcp: {},
    encodings: [{ rid: 'screen', active: true, maxFramerate: 60 }],
  };
  const producer = {
    id: 'same-screen-producer', closed: false, appData: {}, track: tracks[0],
    replaceTrack: async ({ track }: { track: typeof tracks[0] }) => { replacements++; producer.track = track; },
    rtpSender: {
      getParameters: () => senderParameters,
      setParameters: async (parameters: RTCRtpSendParameters) => { senderParameters = parameters; },
    },
  };
  const screenProducer = { current: null };
  const localScreenRef = { current: null };
  const analysis = renderHook(() => useScreenAnalysis({
    screenProducer, localScreenRef,
    screenRampGuardUntil: { current: 0 }, screenRampTimer: { current: null },
    screenActivityRef: { current: 'active' }, setScreenActivity: () => {}, setScreenEncodingPlan: () => {},
    screenAnalysisTimer: { current: null }, screenAnalysisVideo: { current: null }, screenAnalysisCanvas: { current: null },
    previousScreenSample: { current: null }, activityCandidate: { current: { value: 'active', count: 0 } },
  } as unknown as useScreenAnalysisDependencies));
  context.after(() => analysis.clearScreenRampGuard());
  const state = { sharing: false, fps: 30, preset: '720p', gameMode: false, nativeResolution: false, audio: false };
  const deps = {
    mediaGeneration: { current: 0 },
    inVoice: true, get isSharing() { return state.sharing; },
    get fps() { return state.fps; }, get screenPreset() { return state.preset; },
    get screenGameMode() { return state.gameMode; }, get screenNativeResolution() { return state.nativeResolution; },
    get shareAudio() { return state.audio; },
    setFps: (value: number) => { state.fps = value; },
    setScreenPreset: (value: string) => { state.preset = value; },
    setScreenGameMode: (value: boolean) => { state.gameMode = value; },
    setScreenNativeResolution: (value: boolean) => { state.nativeResolution = value; },
    setShareAudio: (value: boolean) => { state.audio = value; },
    setIsSharing: (value: boolean) => { state.sharing = value; }, setLocalScreen: () => {},
    localScreenRef, videoCounterPrev: { current: null }, remoteLossPrev: { current: null },
    screenProducer, screenAudioProducer: { current: null }, screenDemandActiveRef: { current: true },
    socket: { id: 'sender', emit: () => { throw new Error('update must preserve producer'); } },
    deviceRef: { current: { rtpCapabilities: { codecs: [] } } },
    sendTransport: { current: { produce: async (options: Record<string, any>) => { produced.push(options); return producer; } } },
    armScreenRampGuard: (preset: ScreenPreset, fps: ScreenFps, native: boolean) => {
      guards.push([preset, fps, native]); analysis.armScreenRampGuard(preset, fps, native);
    },
    applyScreenActivity: (preset: ScreenPreset, fps: ScreenFps, activity: ScreenActivity, native: boolean) => {
      activities.push([preset, fps, activity, native]); analysis.applyScreenActivity(preset, fps, activity, native);
    },
    startScreenAnalysis: (...args: unknown[]) => { analyses.push(args); },
    stopScreenAnalysis: () => { analysisStops++; analysis.stopScreenAnalysis(); },
  } as unknown as useScreenPublishingDependencies;
  const publishing = renderHook(() => useScreenPublishing(deps));
  await publishing.startScreenShare('1080p', 120, false, false, true);
  assert.equal(state.sharing, true);
  assert.equal(state.fps, 120);
  assert.deepEqual(captures[0], { video: { frameRate: { ideal: 120, max: 120 } }, audio: false });
  assert.equal(produced[0].encodings[0].maxFramerate, 120);
  assert.equal(produced[0].encodings[0].maxBitrate, 200_000_000);
  assert.equal(produced[0].encodings[0].scaleResolutionDownBy, 1);
  assert.equal(produced[0].codecOptions.videoGoogleStartBitrate, 10_000);
  assert.equal(produced[0].codecOptions.videoGoogleMaxBitrate, 200_000);
  assert.deepEqual(activities[0], ['1080p', 120, 'active', true]);
  assert.deepEqual(analyses[0].slice(1), ['1080p', 120, true]);
  await publishing.updateScreenShare('1080p', 120, false, true, false);
  assert.deepEqual(captures[1], { video: { frameRate: { ideal: 120, max: 120 }, width: { max: 1920 }, height: { max: 1080 } }, audio: false });
  assert.equal(produced.length, 1);
  assert.equal(replacements, 1);
  assert.equal(state.fps, 120);
  assert.equal(state.preset, '1080p');
  assert.equal(state.nativeResolution, false);
  assert.deepEqual(activities[1], ['1080p', 120, 'motion', false]);
  assert.deepEqual(guards, [['1080p', 120, true], ['1080p', 120, false]], 'source update replaces old startup callback preferences');
  assert.equal(analysisStops, 1, 'game mode keeps the selected cadence without idle analysis');
  assert.equal(analyses.length, 1);
  assert.equal(producer.appData.maxFps, 120);
  assert.equal(tracks[0].readyState, 'ended');
  assert.equal(senderParameters.encodings[0].maxFramerate, 120, 'real analysis hook updates the RTP sender too');
  assert.equal(senderParameters.encodings[0].maxBitrate, 200_000_000);
  await publishing.updateScreenShare('720p', 60, false, true, false);
  assert.equal(senderParameters.encodings[0].maxFramerate, 60);
  context.mock.timers.tick(4_000);
  await publishing.updateScreenShare('1080p', 120, false, false, true);
  context.mock.timers.tick(1_000);
  assert.equal(senderParameters.encodings[0].maxFramerate, 120, 'the old 60 FPS timer must be canceled');
  assert.equal(senderParameters.encodings[0].scaleResolutionDownBy, 1);
  context.mock.timers.tick(4_000);
  assert.equal(senderParameters.encodings[0].maxFramerate, 120, 'the replacement guard retains the new FPS');
  assert.equal(senderParameters.encodings[0].scaleResolutionDownBy, 1, 'the replacement guard retains native resolution');
  assert.equal(senderParameters.transactionId, 'same-sender');
});

test('screen analysis skips matching updates while preserving desired state and track hints', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const info = context.mock.method(console, 'info', () => {});
  let hint = '';
  const hintWrites: string[] = [];
  const track = {
    get contentHint() { return hint; },
    set contentHint(value: string) { hint = value; hintWrites.push(value); },
    getSettings: () => ({ width: 1920, height: 1080 }),
  };
  let parameters: RTCRtpSendParameters = {
    transactionId: 'screen-sender', codecs: [], headerExtensions: [], rtcp: {},
    degradationPreference: 'maintain-resolution',
    encodings: [{ rid: 'screen', active: true, maxBitrate: 200_000_000, maxFramerate: 120, scaleResolutionDownBy: 1 }],
  };
  let reads = 0;
  const submissions: RTCRtpSendParameters[] = [];
  const producer = { track, rtpSender: {
    getParameters: () => { reads += 1; return parameters; },
    setParameters: (next: RTCRtpSendParameters) => { submissions.push(next); parameters = next; return Promise.resolve(); },
  } };
  const activityRef = { current: 'motion' as ScreenActivity };
  const activities: ScreenActivity[] = [];
  const plans: ReturnType<typeof createScreenEncodingPlan>[] = [];
  const analysis = renderHook(() => useScreenAnalysis({
    screenProducer: { current: producer }, localScreenRef: { current: null },
    screenRampGuardUntil: { current: 0 }, screenRampTimer: { current: null },
    screenActivityRef: activityRef,
    setScreenActivity: (activity: ScreenActivity) => { activities.push(activity); },
    setScreenEncodingPlan: (plan: ReturnType<typeof createScreenEncodingPlan>) => { plans.push(plan); },
    screenAnalysisTimer: { current: null }, screenAnalysisVideo: { current: null }, screenAnalysisCanvas: { current: null },
    previousScreenSample: { current: null }, activityCandidate: { current: { value: 'active', count: 0 } },
  } as unknown as useScreenAnalysisDependencies));

  analysis.armScreenRampGuard('1080p', 120, true);
  analysis.applyScreenActivity('1080p', 120, 'active', true);
  context.mock.timers.tick(5_000);
  analysis.applyScreenActivity('1080p', 120, 'motion', true);
  assert.equal(reads, 3);
  assert.equal(submissions.length, 0);
  assert.deepEqual(hintWrites, ['detail', 'motion']);
  assert.deepEqual(activities, ['active', 'active', 'motion']);
  assert.equal(activityRef.current, 'motion');
  assert.equal(plans.length, 3);
  assert.ok(plans.every((plan) => plan.fps === 120 && plan.degradationPreference === 'maintain-resolution'));
  assert.equal(info.mock.callCount(), 0, 'skipped updates must not log a successful submission');

  parameters = { ...parameters, encodings: [{ ...parameters.encodings[0], maxFramerate: 60 }] };
  analysis.applyScreenActivity('1080p', 120, 'motion', true);
  await flushPublishing();
  assert.equal(submissions.length, 1, 'a real sender change must still be submitted');
  assert.equal(submissions[0].encodings[0].maxFramerate, 120);
  assert.deepEqual(hintWrites, ['detail', 'motion']);
  assert.deepEqual(activities, ['active', 'active', 'motion', 'motion']);
  assert.equal(info.mock.callCount(), 1, 'only the submitted update logs success');
});

test('screen analysis preserves unavailable sender and error handling behavior', async (context) => {
  const warnings: unknown[] = [];
  const info = context.mock.method(console, 'info', () => {});
  context.mock.method(console, 'warn', (_message, error) => { warnings.push(error); });
  let hint = '';
  const hintWrites: string[] = [];
  const track = {
    get contentHint() { return hint; },
    set contentHint(value: string) { hint = value; hintWrites.push(value); },
    getSettings: () => ({ width: 1920, height: 1080 }),
  };
  const producer = { track, rtpSender: undefined as unknown };
  const screenProducer = { current: producer as typeof producer | null };
  const activities: ScreenActivity[] = [];
  const activityRef = { current: 'static' as ScreenActivity };
  const analysis = renderHook(() => useScreenAnalysis({
    screenProducer, localScreenRef: { current: { getVideoTracks: () => [track] } },
    screenRampGuardUntil: { current: 0 }, screenRampTimer: { current: null },
    screenActivityRef: activityRef, setScreenActivity: (activity: ScreenActivity) => { activities.push(activity); },
    setScreenEncodingPlan: () => {}, screenAnalysisTimer: { current: null },
    screenAnalysisVideo: { current: null }, screenAnalysisCanvas: { current: null },
    previousScreenSample: { current: null }, activityCandidate: { current: { value: 'active', count: 0 } },
  } as unknown as useScreenAnalysisDependencies));

  analysis.applyScreenActivity('1080p', 120, 'active', true);
  let emptySubmissions = 0;
  producer.rtpSender = { getParameters: () => undefined, setParameters: () => { emptySubmissions += 1; } };
  analysis.applyScreenActivity('1080p', 120, 'static', true);
  assert.equal(emptySubmissions, 0);
  assert.deepEqual(warnings, []);

  const getFailure = new Error('getParameters failed');
  producer.rtpSender = { getParameters: () => { throw getFailure; } };
  analysis.applyScreenActivity('1080p', 120, 'motion', true);
  const stale: RTCRtpSendParameters = {
    transactionId: 'screen-sender', codecs: [], headerExtensions: [], rtcp: {},
    degradationPreference: 'maintain-resolution',
    encodings: [{ maxBitrate: 200_000_000, maxFramerate: 15, scaleResolutionDownBy: 1 }],
  };
  const syncFailure = new Error('setParameters threw');
  producer.rtpSender = { getParameters: () => stale, setParameters: () => { throw syncFailure; } };
  analysis.applyScreenActivity('1080p', 120, 'active', true);
  const asyncFailure = new Error('setParameters rejected');
  producer.rtpSender = { getParameters: () => stale, setParameters: () => Promise.reject(asyncFailure) };
  analysis.applyScreenActivity('1080p', 120, 'motion', true);
  await flushPublishing();

  screenProducer.current = null;
  analysis.applyScreenActivity('1080p', 120, 'active', true);
  assert.deepEqual(warnings, [getFailure, syncFailure, asyncFailure]);
  assert.equal(info.mock.callCount(), 0);
  assert.deepEqual(activities, ['active', 'static', 'motion', 'active', 'motion', 'active']);
  assert.equal(activityRef.current, 'active');
  assert.deepEqual(hintWrites, ['detail', 'motion', 'detail', 'motion', 'detail']);
});

test('diagnostic export reports selected 120 in game mode and keeps actual track cadence distinct', async (context) => {
  let exported: Blob | undefined;
  context.mock.method(URL, 'createObjectURL', (blob: Blob) => { exported = blob; return 'blob:test'; });
  context.mock.method(URL, 'revokeObjectURL', () => {});
  replaceGlobal(context, 'navigator', { userAgent: 'Cove synthetic regression' });
  replaceGlobal(context, 'document', { createElement: () => ({ href: '', download: '', click() {} }) });
  const plan = createScreenEncodingPlan({ preset: '1080p', maxFps: 120, activity: 'motion' });
  const deps = {
    fps: 120, screenPreset: '1080p', screenGameMode: true, screenNativeResolution: false,
    screenEncodingPlan: plan, diagnosticHistory: { current: [] },
    roomId: 'isolated-room', socket: { id: 'sender' },
    screenProducer: { current: {
      track: { getSettings: () => ({ frameRate: 60 }) },
      rtpSender: { getParameters: () => ({ encodings: [{ maxFramerate: 120 }] }) },
    } },
  } as unknown as useMediaDiagnosticsDependencies;
  renderHook(() => useMediaDiagnostics(deps)).exportMediaDiagnostics();
  const payload = JSON.parse(await exported!.text());
  assert.equal(payload.screen.requestedFps, 120);
  assert.equal(payload.screen.encodingPlan.fps, 120);
  assert.equal(payload.screen.senderParameters.encodings[0].maxFramerate, 120);
  assert.equal(payload.screen.trackSettings.frameRate, 60, 'requested FPS must not masquerade as measured capability');
  assert.equal(payload.screen.configuredMaxBitrate, 200_000_000);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flushPublishing = () => new Promise<void>(resolve => setImmediate(resolve));

class PublishingTrack extends EventTarget {
  readyState = 'live'; contentHint = ''; stops = 0;
  onended: (() => void) | null = null;
  getSettings() { return { width: 1280, height: 720, displaySurface: 'monitor' }; }
  getConstraints() { return {}; }
  getCapabilities() { return {}; }
  stop() { if (this.readyState !== 'ended') { this.stops++; this.readyState = 'ended'; } }
  override dispatchEvent(event: Event) {
    const result = super.dispatchEvent(event);
    if (event.type === 'ended') this.onended?.();
    return result;
  }
}

class PublishingStream {
  constructor(readonly tracks: PublishingTrack[] = [new PublishingTrack()]) {}
  getVideoTracks() { return this.tracks; }
  getAudioTracks() { return []; }
  getTracks() { return this.tracks; }
}

function nativePublishingFixture(context: Parameters<typeof replaceGlobal>[0]) {
  const captures: PublishingStream[] = [], native: PublishingTrack[] = [], replacements: PublishingTrack[] = [];
  const requests: string[] = [], stoppedRequests: string[] = [], alerts: string[] = [], produced: any[] = [];
  const frameCallbacks = new Map<string, Parameters<NativeScreenBridge['onFrame']>[1]>();
  const endedCallbacks = new Map<string, (reason: string) => void>();
  const events: string[] = [], analyses: unknown[][] = [];
  let sharing = false;
  let capture = async () => new PublishingStream();
  let startAudio = async () => {};
  let nativeStart = async () => ({ ok: true, sessionId: 'native-session', width: 1280, height: 720 } as const);
  const observer = new EventEmitter();
  const parameters = {
    transactionId: 'original', encodings: [{ scaleResolutionDownBy: 1, maxFramerate: 15, maxBitrate: 200_000_000 }],
    degradationPreference: 'maintain-resolution', codecs: [{ mimeType: 'video/H264' }],
  };
  const producer = {
    id: 'one-producer', closed: false, observer, appData: {} as any, track: null as PublishingTrack | null,
    pause() {}, close() { this.closed = true; observer.emit('close'); },
    rtpSender: { getParameters: () => parameters },
    async replaceTrack({ track }: { track: PublishingTrack }) { replacements.push(track); this.track = track; },
  };
  let publish = async (options: any) => { producer.track = options.track; return producer; };
  const bridge: NativeScreenBridge = {
    supported: true,
    start: async (requestId) => { events.push('native-start'); requests.push(requestId); return nativeStart(); },
    stop: async (requestId) => { stoppedRequests.push(requestId); return true; },
    onFrame: (id, callback) => { frameCallbacks.set(id, callback); return () => frameCallbacks.delete(id); },
    onEnded: (id, callback) => { endedCallbacks.set(id, callback); return () => endedCallbacks.delete(id); },
  };
  class Generator extends PublishingTrack {
    writable = { getWriter: () => ({ write: async () => {}, abort: async () => {}, releaseLock() {} }) };
    constructor(_options: unknown) { super(); native.push(this); }
  }
  replaceGlobal(context, 'window', { coveNativeScreen: bridge, coveScreenAudio: {}, alert: (value: string) => alerts.push(value) });
  replaceGlobal(context, 'MediaStream', PublishingStream);
  replaceGlobal(context, 'MediaStreamTrackGenerator', Generator);
  replaceGlobal(context, 'requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  replaceGlobal(context, 'navigator', { mediaDevices: { getDisplayMedia: () => {
    events.push('stock-capture'); const result = capture(); result.then(value => captures.push(value), () => {}); return result;
  } } });
  const localScreenRef = { current: null as MediaStream | null }, screenProducer = { current: null as any };
  let encodingPlan = { ...createScreenEncodingPlan({ preset: '720p', maxFps: 120, activity: 'static' }), degradationPreference: 'maintain-resolution' };
  const noop = () => {};
  const deps = {
    inVoice: true, get isSharing() { return sharing; }, mediaGeneration: { current: 0 },
    screenPreset: '720p', fps: 120, screenGameMode: false, screenNativeResolution: false, screenCompatibilityMode: false, shareAudio: false,
    localScreenRef, screenProducer, screenDemandActiveRef: { current: true }, screenAudioProducer: { current: null },
    screenAudioUnsubscribe: { current: null }, screenAudioPipeline: { current: null },
    videoCounterPrev: { current: null }, remoteLossPrev: { current: null }, watchingScreenPeerRef: { current: null },
    screenActivityRef: { current: 'static' }, socket: { id: 'sender', emit: noop }, roomId: 'room',
    deviceRef: { current: { sendRtpCapabilities: { codecs: [] } } },
    sendTransport: { current: { produce: async (options: any) => { events.push('produce'); produced.push(options); return publish(options); } } },
    setIsSharing: (value: boolean) => { events.push(`sharing-${value}`); sharing = value; },
    setLocalScreen: noop, setScreenPreset: noop, setFps: noop, setShareAudio: noop, setScreenGameMode: noop,
    setScreenNativeResolution: noop, setScreenCompatibilityMode: noop, setScreenViewerCount: noop, setScreenActivity: noop, setStats: noop,
    setScreenEncodingPlan: (value: any) => { encodingPlan = typeof value === 'function' ? value(encodingPlan) : value; },
    armScreenRampGuard: noop, applyScreenActivity: noop, clearScreenRampGuard: noop, stopScreenAnalysis: noop,
    startScreenAnalysis: (...args: unknown[]) => { analyses.push(args); },
    startScreenAudio: () => startAudio(), closeScreenAudio: noop, clearAvailableScreens: noop, clearRemoteApplicationAudios: noop,
  } as unknown as useScreenPublishingDependencies;
  const api = renderHook(() => useScreenPublishing(deps));
  context.after(() => api.stopScreenShare());
  return {
    api, bridge, producer, localScreenRef, screenProducer, captures, native, replacements, requests, stoppedRequests, alerts,
    produced, events, parameters, analyses, sharing: () => sharing, plan: () => encodingPlan,
    capture: (value: typeof capture) => { capture = value; }, publish: (value: typeof publish) => { publish = value; },
    startAudio: (value: typeof startAudio) => { startAudio = value; }, nativeStart: (value: typeof nativeStart) => { nativeStart = value; },
    async frame(requestId = requests.at(-1)!) {
      await flushPublishing();
      await frameCallbacks.get(requestId)?.({ displayWidth: 1280, displayHeight: 720, timestamp: 1000, close() {} } as VideoFrame,
        { requestId, sessionId: 'native-session', slot: 0, serial: 1, width: 1280, height: 720, timestamp: 1000, refresh: false });
      await flushPublishing();
    },
    ended(requestId = requests.at(-1)!) { endedCallbacks.get(requestId)?.('device-lost'); },
  };
}

test('stock publication and audio complete before native preparation; native never blocks sharing startup', async context => {
  const f = nativePublishingFixture(context), published = deferred<typeof f.producer>(), audio = deferred<void>();
  f.publish(() => published.promise);
  f.startAudio(() => audio.promise);
  const start = f.api.startScreenShare('720p', 120, true);
  await flushPublishing();
  assert.equal(f.requests.length, 0);
  assert.equal(f.produced[0].track, f.captures[0].getVideoTracks()[0]);
  published.resolve(f.producer);
  await flushPublishing();
  assert.equal(f.requests.length, 0, 'native preparation also waits for the existing audio startup stage');
  audio.resolve();
  await start;
  const stock = f.captures[0].getVideoTracks()[0];
  const oldStockEnded = stock.onended!;
  assert.equal(f.sharing(), true);
  assert.equal(f.localScreenRef.current, f.captures[0]);
  assert.equal(stock.stops, 0);
  assert.ok(f.events.indexOf('sharing-true') < f.events.indexOf('native-start'));
  const senderBefore = structuredClone(f.parameters);
  await f.frame();
  assert.equal(f.produced.length, 1);
  assert.deepEqual(f.replacements, [f.native[0]]);
  assert.equal(f.localScreenRef.current?.getVideoTracks()[0], f.native[0]);
  assert.equal(stock.stops, 1);
  assert.equal(f.plan().fps, 15, 'upgrading dimensions retains the current static cadence');
  assert.deepEqual(f.parameters, senderBefore, 'upgrading capture does not mutate encoder policy');
  assert.equal(f.analyses.length, 2);
  oldStockEnded();
  assert.equal(f.sharing(), true, 'a queued ended event from retired stock cannot stop native');
});

test('selected 30 FPS starts one live stock publication without native preparation', async context => {
  const f = nativePublishingFixture(context);
  await f.api.startScreenShare('720p', 30);
  await flushPublishing();
  const stock = f.captures[0].getVideoTracks()[0];
  assert.equal(f.sharing(), true);
  assert.equal(f.produced.length, 1);
  assert.equal(f.produced[0].encodings[0].maxFramerate, 30);
  assert.equal(f.producer.track, stock);
  assert.equal(f.localScreenRef.current, f.captures[0]);
  assert.equal(stock.readyState, 'live');
  assert.equal(stock.stops, 0);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.native, []);
  assert.deepEqual(f.replacements, []);
  assert.deepEqual(f.alerts, []);
});

test('updating native 120 FPS to 30 FPS replaces it with live stock and releases the native session', async context => {
  const f = nativePublishingFixture(context);
  await f.api.startScreenShare('720p', 120);
  await f.frame();
  const native = f.native[0], requestId = f.requests[0];
  assert.equal(native.readyState, 'live');
  assert.equal(f.producer.track, native);
  await f.api.updateScreenShare('720p', 30);
  await flushPublishing();
  const stock = f.captures[1].getVideoTracks()[0];
  assert.equal(f.sharing(), true);
  assert.equal(f.produced.length, 1);
  assert.equal(f.screenProducer.current, f.producer);
  assert.equal(f.producer.track, stock);
  assert.equal(f.producer.appData.maxFps, 30);
  assert.equal(f.localScreenRef.current, f.captures[1]);
  assert.equal(stock.readyState, 'live');
  assert.equal(stock.stops, 0);
  assert.equal(native.readyState, 'ended');
  assert.equal(native.stops, 1);
  assert.ok(f.stoppedRequests.includes(requestId));
  assert.equal(f.requests.length, 1, 'the 30 FPS update cannot start another native session');
  assert.equal(f.native.length, 1);
  assert.deepEqual(f.replacements, [native, stock]);
  assert.deepEqual(f.alerts, []);
});

test('native startup failure preserves stock and a successful stock source update can upgrade later', async context => {
  const f = nativePublishingFixture(context);
  f.nativeStart(async () => { throw new Error('native unavailable'); });
  await f.api.startScreenShare();
  await flushPublishing();
  const firstStock = f.captures[0].getVideoTracks()[0];
  assert.equal(f.sharing(), true);
  assert.equal(firstStock.stops, 0);
  assert.deepEqual(f.replacements, []);
  f.nativeStart(async () => ({ ok: true, sessionId: 'native-session', width: 1280, height: 720 }));
  await f.api.updateScreenShare('1080p', 120);
  const updatedStock = f.captures[1].getVideoTracks()[0];
  assert.equal(f.localScreenRef.current, f.captures[1]);
  assert.equal(updatedStock.stops, 0);
  await f.frame();
  assert.equal(f.produced.length, 1);
  assert.deepEqual(f.replacements, [updatedStock, f.native[1]]);
  assert.equal(updatedStock.stops, 1);
  assert.deepEqual(f.alerts, []);
});

test('new source requests and stop cancel pending native preparation immediately', async context => {
  const f = nativePublishingFixture(context);
  await f.api.startScreenShare();
  const oldRequest = f.requests[0];
  const update = f.api.updateScreenShare('1080p', 120);
  assert.equal(f.native[0].readyState, 'ended');
  assert.ok(f.stoppedRequests.includes(oldRequest));
  await update;
  assert.equal(f.requests.length, 2);
  f.api.stopScreenShare();
  assert.equal(f.native[1].readyState, 'ended');
  assert.ok(f.stoppedRequests.includes(f.requests[1]));
  await f.frame(oldRequest);
  assert.equal(f.screenProducer.current, null);
  assert.equal(f.localScreenRef.current, null);
});

test('producer close cancels native preparation without awaiting a helper frame', async context => {
  const f = nativePublishingFixture(context);
  await f.api.startScreenShare();
  f.producer.close();
  assert.equal(f.native[0].readyState, 'ended');
  assert.ok(f.stoppedRequests.includes(f.requests[0]));
  await f.frame();
  assert.deepEqual(f.replacements, []);
});

test('overlapping source updates remain ordered and only the latest intent prepares native', async context => {
  const f = nativePublishingFixture(context), first = deferred<PublishingStream>(), last = deferred<PublishingStream>();
  await f.api.startScreenShare();
  f.capture(() => first.promise);
  const firstUpdate = f.api.updateScreenShare('1080p', 120);
  f.capture(() => last.promise);
  const lastUpdate = f.api.updateScreenShare('1440p', 120);
  const firstStock = new PublishingStream(), lastStock = new PublishingStream();
  first.resolve(firstStock);
  await firstUpdate;
  assert.equal(f.requests.length, 1, 'an earlier ordered update cannot revive its superseded native intent');
  last.resolve(lastStock);
  await lastUpdate;
  assert.equal(f.requests.length, 2);
  assert.equal(f.localScreenRef.current, lastStock);
  assert.deepEqual(f.replacements, [firstStock.getVideoTracks()[0], lastStock.getVideoTracks()[0]]);
  await f.frame();
  assert.equal(f.localScreenRef.current?.getVideoTracks()[0], f.native[1]);
  assert.equal(f.produced.length, 1);
});

test('canceling a new stock picker retains the committed native predecessor', async context => {
  const f = nativePublishingFixture(context);
  await f.api.startScreenShare();
  await f.frame();
  const native = f.native[0], picker = deferred<PublishingStream>();
  f.capture(() => picker.promise);
  const update = f.api.updateScreenShare();
  assert.equal(native.readyState, 'live');
  picker.reject(new DOMException('picker canceled', 'NotAllowedError'));
  await update;
  assert.equal(native.readyState, 'live');
  assert.equal(f.localScreenRef.current?.getVideoTracks()[0], native);
  assert.deepEqual(f.alerts, []);
  f.ended();
  assert.equal(f.sharing(), false, 'native faults run the ordinary publication teardown');
  assert.equal(f.screenProducer.current, null);
  assert.equal(f.requests.length, 1, 'fault teardown never automatically reacquires capture');
});

test('unsupported native bridge and native-resolution sharing preserve the original stock path', async context => {
  const f = nativePublishingFixture(context);
  Object.assign(f.bridge, { supported: false });
  await f.api.startScreenShare();
  assert.equal(f.native.length, 0);
  Object.assign(f.bridge, { supported: true });
  await f.api.updateScreenShare('1080p', 120, false, false, true);
  assert.equal(f.native.length, 0);
  assert.equal(f.produced.length, 1);
  assert.equal(f.replacements.length, 1);
  assert.deepEqual(f.requests, []);
});
