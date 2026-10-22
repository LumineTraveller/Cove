const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeMediaDiagnostics, distribution } = require('../tooling/analyze-media-diagnostics.cjs');

test('offline desktop summary keeps RTT units, excludes private fields and does not infer end-to-end latency', () => {
  const result = analyzeMediaDiagnostics({ roomId: 'private', socketId: 'secret', samples: [
    { stats: { role: 'sender', rtt: 10, sendFps: 60, bitrate: 1000 } },
    { stats: { role: 'sender', rtt: 30, sendFps: 30, bitrate: 2000 } },
    { stats: { rtt: -1, bitrate: Infinity } },
  ] });
  assert.equal(result.rttMs.mean, 20);
  assert.equal(result.videoFps.min, 30);
  assert.equal(result.endToEndLatencyMs, null);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('Android RTT is one selected pair on the active transport, not an aggregate of unrelated pairs', () => {
  const result = analyzeMediaDiagnostics({ platform: 'android', stage: { watching: true }, samples: [
    { transport: 'send', type: 'candidate-pair', values: { currentRoundTripTime: 1 } },
    { transport: 'receive', type: 'candidate-pair', selected: true, values: { currentRoundTripTime: 0.015 } },
  ] });
  assert.equal(result.rttMs.mean, 15);
  assert.equal(result.rttMs.count, 1);
});
test('missing, invalid and oversized inputs never fabricate zero measurements', () => {
  assert.equal(distribution([undefined, NaN, -1]).median, null);
  assert.equal(analyzeMediaDiagnostics({ samples: [] }).rttMs.count, 0);
  assert.throws(() => analyzeMediaDiagnostics({ samples: new Array(10_001) }));
});
