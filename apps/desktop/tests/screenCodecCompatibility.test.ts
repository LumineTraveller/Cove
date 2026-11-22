import './helpers/presenceToneAssets.cjs';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useScreenPublishing, type useScreenPublishingDependencies } from '../src/features/media/screen/useScreenPublishing';
import type { NativeScreenBridge } from '../src/features/media/screen/nativeScreenCapture';
import { ScreenShareSettingsV2 } from '../src/features/media/screen/ScreenShareSettingsV2';

function fixture(t: TestContext, compatibilityMode: boolean, sendCodecs: string[], receiveCodecs = sendCodecs) {
  const replace = (name: string, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  };
  const alerts: string[] = [];
  const produced: any[] = [];
  let captures = 0;
  let sharing = false;
  let produceError: Error | undefined;
  const testWindow = { alert: (message: string) => alerts.push(message),
    coveNativeScreen: undefined as { supported: boolean; hardwareAv1Encoding: boolean } | undefined };
  const track = Object.assign(new EventTarget(), {
    readyState: 'live', contentHint: '', onended: null,
    getSettings: (): MediaTrackSettings => ({ width: 1920, height: 1080 }),
    getConstraints: () => ({}), getCapabilities: () => ({}), stop() { this.readyState = 'ended'; },
  });
  const stream = { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] };
  replace('navigator', { mediaDevices: { getDisplayMedia: async () => { captures++; return stream; } } });
  replace('window', testWindow);
  replace('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  const ref = () => ({ current: null });
  const noop = () => {};
  const deps = {
    mediaGeneration: { current: 0 },
    inVoice: true, get isSharing() { return sharing; },
    screenPreset: '1080p', fps: 60, screenGameMode: false, screenNativeResolution: false,
    screenCompatibilityMode: compatibilityMode, screenGpuEncoding: false, shareAudio: false,
    setScreenPreset: noop, setFps: noop, setShareAudio: noop, setScreenGameMode: noop,
    setScreenNativeResolution: noop, setScreenCompatibilityMode: noop, setScreenGpuEncoding: noop,
    setLocalScreen: noop, setScreenEncodingPlan: noop, setScreenViewerCount: noop, setScreenActivity: noop, setStats: noop,
    setIsSharing: (value: boolean) => { sharing = value; },
    localScreenRef: ref(), videoCounterPrev: ref(), remoteLossPrev: ref(), screenProducer: ref(),
    screenAudioProducer: ref(), screenAudioUnsubscribe: ref(), screenAudioPipeline: ref(),
    watchingScreenPeerRef: ref(), screenDemandActiveRef: { current: true }, screenActivityRef: { current: 'active' },
    socket: { id: 'desktop', emit: noop }, roomId: 'room',
    deviceRef: { current: {
      sendRtpCapabilities: { codecs: sendCodecs.map(mimeType => ({ mimeType })) },
      rtpCapabilities: { codecs: receiveCodecs.map(mimeType => ({ mimeType })) },
    } },
    sendTransport: { current: { produce: async (options: any) => {
      produced.push(options);
      if (produceError) throw produceError;
      return { id: 'screen', closed: false, appData: options.appData, pause: noop, close: noop };
    } } },
    armScreenRampGuard: noop, applyScreenActivity: noop, stopScreenAnalysis: noop, startScreenAnalysis: noop,
    startScreenAudio: async () => {}, clearScreenRampGuard: noop, closeScreenAudio: noop,
    clearAvailableScreens: noop, clearRemoteApplicationAudios: noop,
  } as unknown as useScreenPublishingDependencies;
  let api!: ReturnType<typeof useScreenPublishing>;
  function Probe() { api = useScreenPublishing(deps); return null; }
  renderToStaticMarkup(createElement(Probe));
  return { api, alerts, produced, track, replace, captures: () => captures, sharing: () => sharing,
    enableEncodingOption: () => { testWindow.coveNativeScreen = { supported: false, hardwareAv1Encoding: true }; },
    failProduce: () => { produceError = new Error('encoder unavailable'); } };
}

test('explicit compatibility selects negotiated VP8 without changing resolution or FPS', async t => {
  const f = fixture(t, true, ['video/AV1', 'video/VP9', 'video/VP8']);
  await f.api.startScreenShare();
  assert.equal(f.sharing(), true);
  assert.equal(f.produced.length, 1);
  assert.equal(f.produced[0].codec.mimeType, 'video/VP8');
  assert.equal(f.produced[0].appData.compatibilityMode, true);
  assert.equal(f.produced[0].encodings[0].maxFramerate, 60);
  assert.equal(f.produced[0].encodings[0].scaleResolutionDownBy, 1);
});

test('publication uses send capabilities rather than asymmetric receive capabilities', async t => {
  const f = fixture(t, true, ['video/VP8'], ['video/AV1']);
  await f.api.startScreenShare();
  assert.equal(f.produced[0]?.codec.mimeType, 'video/VP8');
});

test('compatibility rejects absent VP8 before screen capture and never silently publishes another codec', async t => {
  const f = fixture(t, true, ['video/AV1', 'video/VP9']);
  await f.api.startScreenShare();
  assert.equal(f.captures(), 0);
  assert.equal(f.produced.length, 0);
  assert.equal(f.sharing(), false);
  assert.match(f.alerts[0], /VP8/);
});

test('receive-only VP8 support is not accepted as a sending capability', async t => {
  const f = fixture(t, true, ['video/AV1'], ['video/VP8']);
  await f.api.startScreenShare();
  assert.equal(f.captures(), 0);
  assert.equal(f.produced.length, 0);
  assert.match(f.alerts[0], /VP8/);
});

test('a failed compatibility encoder does not fall back to AV1 or browser auto', async t => {
  const f = fixture(t, true, ['video/AV1', 'video/VP9', 'video/VP8']);
  f.failProduce();
  await f.api.startScreenShare();
  assert.equal(f.produced.length, 1);
  assert.equal(f.produced[0].codec.mimeType, 'video/VP8');
  assert.equal(f.sharing(), false);
  assert.equal(f.alerts.length, 1);
});

test('default publishing preserves its AV1 preference', async t => {
  const f = fixture(t, false, ['video/AV1', 'video/VP9', 'video/VP8']);
  await f.api.startScreenShare();
  assert.equal(f.produced[0]?.codec.mimeType, 'video/AV1');
});

test('GPU encoding off selects the software AV1 mode without changing the requested frame rate', async t => {
  const f = fixture(t, false, ['video/AV1', 'video/VP9']);
  f.enableEncodingOption();
  await f.api.startScreenShare();
  assert.equal(f.produced[0].appData.gpuEncoding, false);
  assert.equal(f.produced[0].encodings[0].scalabilityMode, 'L1T2');
  assert.equal(f.produced[0].encodings[0].maxFramerate, 60);
  assert.equal(f.produced[0].encodings[0].scaleResolutionDownBy, 1);
});

test('GPU publishing uses the native monitor dimensions when the stock track has no size yet', async t => {
  const f = fixture(t, false, ['video/AV1']);
  f.track.getSettings = () => ({ displaySurface: 'monitor' });
  const dimensions = { width: 1728, height: 1080 };
  class NativeTrack extends EventTarget {
    readyState = 'live';
    writable = new WritableStream();
    getSettings() { return dimensions; }
    getConstraints() { return {}; }
    getCapabilities() { return {}; }
    stop() { this.readyState = 'ended'; }
  }
  class NativeStream {
    constructor(private readonly tracks: NativeTrack[]) {}
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks; }
    getAudioTracks() { return []; }
  }
  f.replace('MediaStreamTrackGenerator', NativeTrack);
  f.replace('MediaStream', NativeStream);

  const format = { pixelFormat: 'nv12' as const, storage: 'cpu' as const, colorSpace: 'bt709-limited' as const };
  const frame = {
    displayWidth: dimensions.width, displayHeight: dimensions.height, format: 'NV12', timestamp: 1000,
    colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
    close() {},
  } as unknown as VideoFrame;
  let receiveFrame: Parameters<NativeScreenBridge['onFrame']>[1] | undefined;
  const bridge: NativeScreenBridge = {
    supported: true, hardwareAv1Encoding: true,
    async start(requestId, options) {
      assert.deepEqual(options, { maxWidth: 1920, maxHeight: 1080, fps: 60, cpuNv12: true, colorSpace: 'bt709-limited' });
      const sessionId = 'native-session';
      setImmediate(() => void receiveFrame?.(frame, {
        requestId, sessionId, ...dimensions, ...format, slot: 0, serial: 1, timestamp: frame.timestamp, refresh: false,
      }));
      return { ok: true, sessionId, ...dimensions, ...format };
    },
    async stop() { return true; },
    onFrame(_requestId, listener) { receiveFrame = listener; return () => { receiveFrame = undefined; }; },
    onEnded() { return () => {}; },
  };
  Object.assign(window, { coveNativeScreen: bridge });
  const capabilityQueries: MediaEncodingConfiguration[] = [];
  Object.assign(navigator, { mediaCapabilities: {
    async encodingInfo(config: MediaEncodingConfiguration) {
      capabilityQueries.push(config);
      return { supported: true, powerEfficient: true, smooth: true };
    },
  } });

  try {
    await f.api.startScreenShare('1080p', 60, false, true, false, false, true);
    assert.deepEqual(f.alerts, []);
    assert.equal(f.sharing(), true);
    assert.equal(capabilityQueries[0].video?.width, dimensions.width);
    assert.equal(capabilityQueries[0].video?.height, dimensions.height);
    const [publication] = f.produced;
    assert.equal(publication.appData.outputWidth, dimensions.width);
    assert.equal(publication.appData.outputHeight, dimensions.height);
    assert.equal(publication.encodings[0].scalabilityMode, 'L1T1');
    assert.equal(publication.encodings[0].maxFramerate, 60);
    assert.equal(publication.encodings[0].scaleResolutionDownBy, 1);
  } finally {
    f.api.stopScreenShare();
  }
});

test('an unsupported GPU encoding request cannot silently start a software share', async t => {
  const f = fixture(t, false, ['video/AV1']);
  assert.equal(await f.api.startScreenShare(undefined, undefined, undefined, undefined, undefined, false, true), false);
  assert.equal(f.captures(), 0);
  assert.equal(f.produced.length, 0);
  assert.match(f.alerts[0], /GPU 编码/);
});

test('an active share cannot pretend replaceTrack changed its codec mode', async t => {
  const f = fixture(t, false, ['video/AV1', 'video/VP8']);
  await f.api.startScreenShare();
  await f.api.updateScreenShare(undefined, undefined, undefined, undefined, undefined, true);
  assert.equal(f.captures(), 1);
  assert.equal(f.produced.length, 1);
  assert.equal(f.sharing(), true);
  assert.match(f.alerts[0], /停止/);
});

test('the share dialog leaves compatibility selection in capture settings', () => {
  const noop = () => {};
  const markup = renderToStaticMarkup(createElement(ScreenShareSettingsV2, {
    preset: '1080p', fps: 60, audio: false, gameMode: false, nativeResolution: false, gpuEncoding: false,
    onPreset: noop, onFps: noop, onAudio: noop, onGameMode: noop, onNativeResolution: noop, onGpuEncoding: noop,
    confirmLabel: '共享', onConfirm: noop, onCancel: noop,
  }));
  assert.doesNotMatch(markup, /兼容观看|VP8/);
  assert.match(markup, /分辨率/);
  assert.match(markup, /帧率/);
  assert.match(markup, /共享电脑音频/);
  assert.match(markup, /共享电脑音频[\s\S]*采用GPU编码[\s\S]*<button class="primary-wide/);
});
