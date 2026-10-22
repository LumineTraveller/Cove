import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useScreenPublishing, type useScreenPublishingDependencies } from '../src/features/media/screen/useScreenPublishing';
import { useScreenAnalysis, type useScreenAnalysisDependencies } from '../src/features/media/screen/useScreenAnalysis';
import { useMediaDiagnostics, type useMediaDiagnosticsDependencies } from '../src/features/media/diagnostics/useMediaDiagnostics';
import { createScreenEncodingPlan, type ScreenFps, type ScreenPreset, type ScreenActivity } from '../src/features/media/screen/screenCapture';

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
  assert.deepEqual(captures[1], { video: { frameRate: { ideal: 120, max: 120 } }, audio: false });
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
