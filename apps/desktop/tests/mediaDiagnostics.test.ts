import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useMediaDiagnostics, type useMediaDiagnosticsDependencies } from '../src/features/media/diagnostics/useMediaDiagnostics';
import { bindFramePresentation, readFramePresentation } from '../src/features/media/diagnostics/framePresentation';
import { EMPTY_STATS, type MediaStats } from '../src/features/media/desktopMediaSupport';
import { createScreenEncodingPlan } from '../src/features/media/screen/screenCapture';
import {
  diagnosticTrackSettings,
  diagnosticSenderParameters,
  diagnosticPacketLoss,
  diagnosticVideoCounters,
  intervalLossPercent,
  mediaDiagnosticSessionKey,
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
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 120 }),
  }) as unknown as MediaStreamTrack;
  const report = new Map([['outbound', {
    id: 'outbound', type: 'outbound-rtp', kind: 'video', timestamp: 1_000,
    framesEncoded: 120, framesSent: 120, bytesSent: 1_000,
  }]]) as unknown as RTCStatsReport;
  const producer = { id: 'producer-1', track, getStats: async () => report };
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
    screenEncodingPlan: null,
  } as unknown as useMediaDiagnosticsDependencies;
  return {
    deps, producer, track, history, updates, serverSampleStarted,
    holdServerSample: () => { holdServerSample = true; },
    finishServerSample: () => finishServerSample(),
  };
}

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
