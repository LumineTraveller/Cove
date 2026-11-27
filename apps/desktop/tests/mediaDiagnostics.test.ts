import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiagnosticsOverlayV2 } from '../src/features/media/diagnostics/DiagnosticsOverlayV2';
import { useMediaDiagnostics, type useMediaDiagnosticsDependencies } from '../src/features/media/diagnostics/useMediaDiagnostics';
import { bindFramePresentation, readFramePresentation } from '../src/features/media/diagnostics/framePresentation';
import { EMPTY_STATS, type MediaStats } from '../src/features/media/desktopMediaSupport';
import { createScreenEncodingPlan } from '../src/features/media/screen/screenCapture';
import {
  diagnoseFrameRate,
  diagnosticTrackSettings,
  diagnosticSenderParameters,
  diagnosticPacketLoss,
  diagnosticVideoCounters,
  intervalLossPercent,
  mediaDiagnosticSessionKey,
  nativeFrameCounterRates,
  shouldAcceptMediaDiagnosticSample,
  videoCounterRates,
  videoCounterSample,
} from '../src/features/media/diagnostics/mediaDiagnostics';

test('export metadata excludes device identifiers, RTCP identities and unbounded wire strings', () => {
  const secret = 'private-device-token-SDP';
  const track = diagnosticTrackSettings({ width: 640, height: 480, frameRate: 30,
    deviceId: secret, groupId: secret, displaySurface: 'window', noiseSuppression: true });
  const sender = diagnosticSenderParameters({ encodings: [{ active: true, maxBitrate: 1000, rid: secret }],
    codecs: [{ mimeType: 'video/VP8', clockRate: 90000, sdpFmtpLine: secret, payloadType: 96 }],
    rtcp: { cname: secret }, transactionId: secret, headerExtensions: [] } as any);
  assert.equal(track?.width, 640);
  assert.equal(sender?.encodings[0].maxBitrate, 1000);
  assert.ok(!JSON.stringify({ track, sender }).includes(secret));
  assert.equal(diagnosticTrackSettings({ width: NaN })?.width, undefined);
  assert.equal(diagnosticTrackSettings({ displaySurface: { toString: () => 'window', deviceId: secret } } as any)?.displaySurface, undefined);
  assert.equal(diagnosticTrackSettings({ displaySurface: new String('window') } as any)?.displaySurface, undefined);
});

test('diagnostic packet loss uses sender feedback without masking missing samples', () => {
  const stats = { role: 'sender' as const, loss: 0, remoteLoss: 4 };
  assert.equal(diagnosticPacketLoss(stats), 4);
  assert.equal(diagnosticPacketLoss({ ...stats, remoteLoss: null }), null);
  assert.equal(diagnosticPacketLoss({ ...stats, role: 'receiver', loss: 2 }), 2);
  assert.equal(diagnosticPacketLoss({ ...stats, role: 'idle' }), null);
});

test('videoCounterRates derives kbps and stage fps from monotonic counters', () => {
  const previous = videoCounterSample({
    id: 'outbound-video', timestamp: 1_000, bytesSent: 1_000_000, packetsSent: 1_000,
    framesCaptured: 100, framesEncoded: 90, framesSent: 90,
    retransmittedBytesSent: 10_000, nackCount: 2, pliCount: 1, firCount: 0,
    totalEncodeTime: 0.9, qpSum: 2_700,
  });
  const current = videoCounterSample({
    id: 'outbound-video', timestamp: 2_000, bytesSent: 1_750_000, packetsSent: 1_500,
    framesCaptured: 160, framesEncoded: 140, framesSent: 140,
    retransmittedBytesSent: 20_000, nackCount: 7, pliCount: 3, firCount: 1,
    totalEncodeTime: 1.65, qpSum: 4_100,
  });

  const rates = videoCounterRates(current, previous);
  assert.equal(rates.bitrateKbps, 6_000);
  assert.equal(rates.captureFps, 60);
  assert.equal(rates.encodeFps, 50);
  assert.equal(rates.sendFps, 50);
  assert.equal(rates.retransmitKbps, 80);
  assert.equal(rates.nackPerSecond, 5);
  assert.equal(rates.pliPerSecond, 2);
  assert.equal(rates.firPerSecond, 1);
  assert.equal(rates.encodeTimeMs, 15);
  assert.equal(rates.averageQp, 28);
});

test('videoCounterRates rejects reset counters instead of reporting a false spike', () => {
  const previous = videoCounterSample({ id: 'video', timestamp: 2_000, bytesSent: 50_000 });
  const current = videoCounterSample({ id: 'video', timestamp: 3_000, bytesSent: 10_000 });
  assert.equal(videoCounterRates(current, previous).bitrateKbps, null);
});

test('missing frame counters need two samples while a measured zero is valid', () => {
  const missing = videoCounterSample({ id: 'video', timestamp: 1_000 });
  const first = videoCounterSample({ id: 'video', timestamp: 2_000, framesEncoded: 500 });
  const stalled = videoCounterSample({ id: 'video', timestamp: 3_000, framesEncoded: 500 });
  assert.equal(videoCounterRates(first, missing).encodeFps, null);
  assert.equal(videoCounterRates(stalled, first).encodeFps, 0);
  assert.equal(videoCounterRates(stalled, videoCounterSample({ id: 'video', framesEncoded: 500 })).encodeFps, null);
});

test('diagnosis separates encoding, RTP sending and decoding gaps and respects the current frame cap', () => {
  const rates = { captureFps: 60, encodeFps: 38, sendFps: 27, receiveFps: 27, decodeFps: 13 };
  assert.deepEqual(diagnoseFrameRate(rates, true, 60), {
    status: 'limited', gaps: [
      { stage: 'encode', referenceFps: 60, observedFps: 38 },
      { stage: 'send', referenceFps: 38, observedFps: 27 },
    ],
  });
  assert.deepEqual(diagnoseFrameRate(rates, false, null), {
    status: 'limited', gaps: [{ stage: 'decode', referenceFps: 27, observedFps: 13 }],
  });
  assert.deepEqual(diagnoseFrameRate({ ...rates, receiveFps: 0, decodeFps: 0, bitrateKbps: 2900 }, false, null),
    { status: 'awaiting-complete-frame' });
  assert.deepEqual(diagnoseFrameRate({ ...rates, receiveFps: 0, decodeFps: 0, bitrateKbps: 0 }, false, null),
    { status: 'pending' });
  assert.deepEqual(diagnoseFrameRate({ ...rates, captureFps: 60, encodeFps: 15, sendFps: 14 }, true, 15),
    { status: 'steady' });
  assert.deepEqual(diagnoseFrameRate({ ...rates, captureFps: null, encodeFps: 25, sendFps: 25 }, true, 60),
    { status: 'pending' });
  assert.deepEqual(diagnoseFrameRate({ ...rates, captureFps: 0, encodeFps: 0, sendFps: 0 }, true, 60), {
    status: 'limited', gaps: [{ stage: 'encoder-input', referenceFps: 60, observedFps: 0 }],
  });
});

test('native frames reaching the track at full speed expose a separate WebRTC input bottleneck', () => {
  const previous = { timestamp: 5_000, framesReceived: 180, framesWritten: 177 };
  const current = { timestamp: 6_000, framesReceived: 240, framesWritten: 236 };
  const native = nativeFrameCounterRates(current, previous);
  const rates = { captureFps: 24, encodeFps: 24, sendFps: 24, receiveFps: null, decodeFps: null };
  assert.deepEqual(native, { receivedFps: 60, writtenFps: 59 });
  assert.deepEqual(diagnoseFrameRate(rates, true, 60, native), {
    status: 'limited', gaps: [{ stage: 'encoder-input', referenceFps: 59, observedFps: 24 }],
  });
  assert.deepEqual(diagnoseFrameRate(rates, true, 60, { receivedFps: 60, writtenFps: 24 }), {
    status: 'limited', gaps: [{ stage: 'delivery', referenceFps: 60, observedFps: 24 }],
  });
  assert.deepEqual(nativeFrameCounterRates({ timestamp: 7_000, framesReceived: 4, framesWritten: 3 }, current),
    { receivedFps: null, writtenFps: null });
});

test('intervalLossPercent uses interval deltas', () => {
  assert.equal(intervalLossPercent(25, 975, { lost: 5, packets: 495 }), 4);
  assert.equal(intervalLossPercent(25, 995, { lost: 5, packets: 495 }, true), 4);
  assert.equal(intervalLossPercent(25, 975, null), null);
});

test('diagnostic session exists only while sharing or actively watching', () => {
  assert.equal(mediaDiagnosticSessionKey('producer-1', null), 'sender:producer-1');
  assert.equal(mediaDiagnosticSessionKey(null, 'peer-1'), 'receiver:peer-1');
  assert.equal(mediaDiagnosticSessionKey(null, null), null);
});

test('late async samples are discarded after sharing or watching stops', () => {
  const captured = mediaDiagnosticSessionKey('producer-1', null);
  assert.equal(shouldAcceptMediaDiagnosticSample(true, captured, captured), true);
  assert.equal(shouldAcceptMediaDiagnosticSample(true, captured, null), false);
  assert.equal(shouldAcceptMediaDiagnosticSample(false, captured, captured), false);
  assert.equal(shouldAcceptMediaDiagnosticSample(
    true,
    mediaDiagnosticSessionKey(null, 'peer-1'),
    mediaDiagnosticSessionKey(null, 'peer-2'),
  ), false);
});

test('raw diagnostic counters retain queue windows while excluding identifiers and absent values', () => {
  const result = diagnosticVideoCounters({ timestamp: 1000, framesEncoded: 0, framesSent: 0,
    totalPacketSendDelay: 1.25, jitterBufferDelay: 3.5, jitterBufferEmittedCount: 60,
    totalEncodeTime: Number.NaN, id: 'private-id', address: 'private-address',
    password: 'synthetic-secret', }, { timestamp: 999, frames: 10, trackIdentifier: 'private-track' });
  assert.equal(result.rtp.timestamp, 1000);
  assert.equal(result.rtp.framesEncoded, 0);
  assert.equal(result.rtp.totalPacketSendDelay, 1.25);
  assert.equal(result.rtp.jitterBufferDelay, 3.5);
  assert.equal(result.rtp.jitterBufferEmittedCount, 60);
  assert.equal(result.rtp.framesDropped, null);
  assert.equal(result.rtp.totalEncodeTime, null);
  assert.equal(result.mediaSource.timestamp, 999);
  assert.equal(result.mediaSource.frames, 10);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(diagnosticVideoCounters().rtp.framesEncoded, null);
});

type DiagnosticsApi = ReturnType<typeof useMediaDiagnostics>;

// React's server renderer supports render-phase updates, so useRef/useCallback
// retain their real React identity across these CPU-only dependency replacements.
function renderDiagnostics(
  dependencies: useMediaDiagnosticsDependencies[],
  onRender?: (api: DiagnosticsApi, render: number) => void,
) {
  const renders: DiagnosticsApi[] = [];
  function Probe() {
    const [render, setRender] = useState(0);
    const api = useMediaDiagnostics(dependencies[render]);
    renders.push(api);
    onRender?.(api, render);
    if (render + 1 < dependencies.length) setRender(render + 1);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return renders;
}

function diagnosticCollectorFixture() {
  const track = Object.assign(new EventTarget(), {
    readyState: 'live', contentHint: 'detail',
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 120, displaySurface: 'monitor' }),
  }) as unknown as MediaStreamTrack;
  const outbound = {
    id: 'outbound', type: 'outbound-rtp', kind: 'video', timestamp: 1_000,
    framesEncoded: 120, framesSent: 120, bytesSent: 1_000,
    mediaSourceId: 'source', qualityLimitationReason: 'none',
  };
  const source = { id: 'source', type: 'media-source', kind: 'video', frames: 120 };
  const report = new Map<string, object>([['outbound', outbound], ['source', source]]) as unknown as RTCStatsReport;
  const producer = { id: 'producer-1', track, paused: false, getStats: async () => report };
  const history: useMediaDiagnosticsDependencies['diagnosticHistory'] = { current: [] };
  const updates: MediaStats[] = [];
  let holdServerSample = false;
  let finishServerSample = () => {};
  let notifyServerSample!: () => void;
  const serverSampleStarted = new Promise<void>(resolve => { notifyServerSample = resolve; });
  const deps = {
    statsCollecting: { current: false }, statsEnabled: true, statsEnabledRef: { current: true },
    screenProducer: { current: producer }, watchingScreenPeerRef: { current: null },
    videoCounterPrev: { current: null }, receiveLossPrev: { current: null }, remoteLossPrev: { current: null },
    sendTransport: { current: null }, recvTransport: { current: null }, consumers: { current: new Map() },
    diagnosticHistory: history, setStats: (stats: MediaStats) => updates.push(stats),
    socket: {
      id: 'socket-1', timeout() { return this; },
      emit(_event: string, _payload: unknown, callback: (error: Error | null, value: unknown) => void) {
        finishServerSample = () => callback(null, null);
        notifyServerSample();
        if (!holdServerSample) finishServerSample();
      },
    },
    screenEncodingPlan: null, fps: 120,
  } as unknown as useMediaDiagnosticsDependencies;
  return {
    deps, producer, track, history, updates, serverSampleStarted, outbound, source,
    holdServerSample: () => { holdServerSample = true; },
    finishServerSample: () => finishServerSample(),
  };
}

test('low encoder input is shown in the panel and export even with WebRTC quality reason none', async () => {
  const f = diagnosticCollectorFixture();
  const plan = createScreenEncodingPlan({ preset: '1080p', maxFps: 60, activity: 'motion' });
  const [api] = renderDiagnostics([{ ...f.deps, screenEncodingPlan: plan }]);
  await api.collectStats();
  assert.deepEqual(f.updates.at(-1)?.frameRateDiagnosis, { status: 'pending' });

  f.outbound.timestamp += 1005;
  f.source.frames += 25;
  f.outbound.framesEncoded += 24;
  f.outbound.framesSent += 24;
  await api.collectStats();
  const stats = f.updates.at(-1)!;
  assert.equal(stats.qualityLimitation, 'none');
  assert.deepEqual(stats.frameRateDiagnosis, {
    status: 'limited', gaps: [{ stage: 'encoder-input', referenceFps: 60, observedFps: 24.9 }],
  });
  assert.equal(f.history.current.at(-1)?.stats.frameRateDiagnosis, stats.frameRateDiagnosis);
  assert.equal(stats.captureBackend, 'chromium');
  const rtc = { stats, localScreen: {} as MediaStream, screenEncodingPlan: plan } as
    ComponentProps<typeof DiagnosticsOverlayV2>['rtc'];
  const html = renderToStaticMarkup(createElement(DiagnosticsOverlayV2, {
    rtc, compact: false, onToggleCompact() {},
  }));
  assert.match(html, /帧率受限 · WebRTC 编码前输入<\/span><b>24\.9 \/ 60 fps/);
  assert.match(html, /采集后端<\/span><b>Chromium/);
  assert.doesNotMatch(html, /\bnone\b/);

  f.producer.paused = true;
  f.outbound.timestamp += 1_000;
  await api.collectStats();
  assert.deepEqual(f.updates.at(-1)?.frameRateDiagnosis, { status: 'paused' });

  f.producer.paused = false;
  f.outbound.timestamp += 1_000;
  await api.collectStats();
  assert.deepEqual(f.updates.at(-1)?.frameRateDiagnosis, { status: 'pending' });
});

test('the retained collector reads replacement render getters for each history entry', async () => {
  const f = diagnosticCollectorFixture();
  const plan = createScreenEncodingPlan({ preset: '1080p', maxFps: 120, activity: 'motion' });
  const initial = { ...f.deps, get screenEncodingPlan() { return null; } };
  const latest = { ...f.deps, get screenEncodingPlan() { return plan; } };
  const [first, second] = renderDiagnostics([initial, latest]);
  assert.equal(first.collectStats, second.collectStats, 'render updates keep the timer callback stable');
  await first.collectStats();
  assert.equal(f.history.current.length, 1);
  assert.equal(f.history.current[0].encodingPlan, plan);
  assert.equal(f.history.current[0].trackSettings?.frameRate, 120);
  assert.equal(f.deps.statsCollecting.current, false);
});

test('a collection already awaiting RTC stats reads the current render context at completion', async () => {
  const f = diagnosticCollectorFixture();
  const plan = createScreenEncodingPlan({ preset: '720p', maxFps: 60, activity: 'active' });
  const latest = { ...f.deps, get screenEncodingPlan() { return plan; } };
  let collection: Promise<void> | undefined;
  renderDiagnostics([f.deps, latest], (api, render) => {
    if (render === 0) collection = api.collectStats();
  });
  await collection;
  assert.equal(f.history.current.length, 1);
  assert.equal(f.history.current[0].encodingPlan, plan);
  assert.equal(f.deps.statsCollecting.current, false);
});

test('pending collections still discard disabled and replaced sessions and release their lock', async () => {
  for (const change of ['disabled', 'session-replaced'] as const) {
    const f = diagnosticCollectorFixture();
    f.holdServerSample();
    const [api] = renderDiagnostics([f.deps]);
    const collection = api.collectStats();
    await f.serverSampleStarted;
    if (change === 'disabled') f.deps.statsEnabledRef.current = false;
    else f.producer.id = 'producer-2';
    f.finishServerSample();
    await collection;
    assert.equal(f.history.current.length, 0, change);
    assert.equal(f.updates.at(-1), EMPTY_STATS, change);
    assert.equal(f.deps.statsCollecting.current, false, change);
  }
});

test('a same-producer track replacement does not attach the retired presentation observation', async context => {
  const f = diagnosticCollectorFixture();
  const stream = Object.assign(new EventTarget(), { getVideoTracks: () => [f.track] });
  const video = Object.assign(new EventTarget(), {
    ownerDocument: Object.assign(new EventTarget(), { hidden: false }),
    srcObject: stream, paused: false, ended: false,
    requestVideoFrameCallback: () => 1, cancelVideoFrameCallback: () => {},
  });
  context.after(bindFramePresentation(video as unknown as HTMLVideoElement, stream as unknown as MediaStream));
  assert.ok(readFramePresentation(f.track), 'the old track has an actual presentation observation');
  f.holdServerSample();
  const [api] = renderDiagnostics([f.deps]);
  const collection = api.collectStats();
  await f.serverSampleStarted;
  f.producer.track = Object.assign(new EventTarget(), { readyState: 'live' }) as unknown as MediaStreamTrack;
  f.finishServerSample();
  await collection;
  assert.equal(f.history.current.length, 1);
  assert.equal(f.history.current[0].stats.presentationStability, null);
  assert.equal(f.history.current[0].stats.nativeDeliveryStability, null);
  assert.equal(f.deps.statsCollecting.current, false);
});
