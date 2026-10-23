import test from 'node:test';
import assert from 'node:assert/strict';
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
