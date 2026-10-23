import './helpers/presenceToneAssets.cjs';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useScreenPublishing, type useScreenPublishingDependencies } from '../src/features/media/screen/useScreenPublishing';
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
  const track = {
    readyState: 'live', contentHint: '', onended: null,
    getSettings: () => ({ width: 1920, height: 1080 }),
    getConstraints: () => ({}), getCapabilities: () => ({}), stop() { this.readyState = 'ended'; },
  };
  const stream = { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] };
  replace('navigator', { mediaDevices: { getDisplayMedia: async () => { captures++; return stream; } } });
  replace('window', { alert: (message: string) => alerts.push(message) });
  replace('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  const ref = () => ({ current: null });
  const noop = () => {};
  const deps = {
    mediaGeneration: { current: 0 },
    inVoice: true, get isSharing() { return sharing; },
    screenPreset: '1080p', fps: 60, screenGameMode: false, screenNativeResolution: false,
    screenCompatibilityMode: compatibilityMode, shareAudio: false,
    setScreenPreset: noop, setFps: noop, setShareAudio: noop, setScreenGameMode: noop,
    setScreenNativeResolution: noop, setScreenCompatibilityMode: noop,
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
  return { api, alerts, produced, captures: () => captures, sharing: () => sharing,
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

test('an active share cannot pretend replaceTrack changed its codec mode', async t => {
  const f = fixture(t, false, ['video/AV1', 'video/VP8']);
  await f.api.startScreenShare();
  await f.api.updateScreenShare(undefined, undefined, undefined, undefined, undefined, true);
  assert.equal(f.captures(), 1);
  assert.equal(f.produced.length, 1);
  assert.equal(f.sharing(), true);
  assert.match(f.alerts[0], /停止/);
});

test('compatibility is opt-in before capture and read-only while an existing share is edited', () => {
  const noop = () => {};
  for (const editing of [false, true]) {
    const markup = renderToStaticMarkup(createElement(ScreenShareSettingsV2, {
      preset: '1080p', fps: 60, audio: false, gameMode: false, nativeResolution: false,
      compatibilityMode: editing, editing,
      onPreset: noop, onFps: noop, onAudio: noop, onGameMode: noop, onNativeResolution: noop,
      onCompatibilityMode: noop, confirmLabel: '共享', onConfirm: noop, onCancel: noop,
    }));
    const input = markup.match(/<input[^>]*aria-label="兼容观看（VP8）"[^>]*>/)?.[0];
    assert.ok(input);
    assert.equal(input.includes('checked='), editing);
    assert.equal(input.includes('disabled='), editing);
    if (editing) assert.match(markup, /停止当前共享后可更改编码模式/);
  }
});
