import assert from 'node:assert/strict';
import test from 'node:test';
import { rtcSecondsToMilliseconds, MEDIA_TIMING_DEFINITIONS } from '../src/mediaMetrics';

test('WebRTC seconds convert to RTT milliseconds without inventing missing or invalid values', () => {
  assert.equal(rtcSecondsToMilliseconds(0.0123), 12.3);
  assert.equal(rtcSecondsToMilliseconds(0), 0);
  for (const value of [undefined, null, -1, NaN, Infinity, Number.MAX_VALUE, '0.02']) {
    assert.equal(rtcSecondsToMilliseconds(value), null);
  }
  assert.equal(MEDIA_TIMING_DEFINITIONS.endToEndLatency.measured, false);
});
