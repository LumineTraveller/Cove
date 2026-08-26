import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRtpStat, summarizeTransportStat } from '../src/mediaDiagnostics';

test('summarizeTransportStat exposes ingress, egress and BWE in kbps', () => {
  const value = summarizeTransportStat({
    transportId: 'transport-1', timestamp: 123,
    recvBitrate: 6_000_000, sendBitrate: 2_500_000,
    rtpRecvBitrate: 5_800_000, rtpSendBitrate: 2_400_000,
    rtxRecvBitrate: 40_000, rtxSendBitrate: 80_000,
    availableIncomingBitrate: 7_000_000, availableOutgoingBitrate: 4_000_000,
    rtpPacketLossReceived: 1.5, rtpPacketLossSent: 2.5,
    iceSelectedTuple: { protocol: 'udp' }, iceState: 'completed', dtlsState: 'connected',
  });
  assert.equal(value?.rtpRecvBitrateKbps, 5_800);
  assert.equal(value?.rtpSendBitrateKbps, 2_400);
  assert.equal(value?.availableIncomingKbps, 7_000);
  assert.equal(value?.protocol, 'UDP');
});

test('summarizeRtpStat keeps packet feedback and converts RTT', () => {
  const value = summarizeRtpStat({
    timestamp: 456, kind: 'video', mimeType: 'video/AV1', bitrate: 950_000,
    packetsLost: 12, fractionLost: 3, jitter: 7,
    packetsDiscarded: 1, packetsRetransmitted: 20, packetsRepaired: 8,
    nackCount: 4, pliCount: 2, firCount: 1, roundTripTime: 0.057, score: 8,
  });
  assert.equal(value.bitrateKbps, 950);
  assert.equal(value.roundTripTimeMs, 57);
  assert.equal(value.score, 8);
});
