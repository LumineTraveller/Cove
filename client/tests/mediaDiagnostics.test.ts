import test from 'node:test';
import assert from 'node:assert/strict';
import {
  intervalLossPercent,
  mediaDiagnosticSessionKey,
  shouldPersistMediaDiagnosticSample,
  videoCounterRates,
  videoCounterSample,
} from '../src/mediaDiagnostics';

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
  assert.equal(shouldPersistMediaDiagnosticSample(true, captured, captured), true);
  assert.equal(shouldPersistMediaDiagnosticSample(true, captured, null), false);
  assert.equal(shouldPersistMediaDiagnosticSample(false, captured, captured), false);
  assert.equal(shouldPersistMediaDiagnosticSample(
    true,
    mediaDiagnosticSessionKey(null, 'peer-1'),
    mediaDiagnosticSessionKey(null, 'peer-2'),
  ), false);
});
