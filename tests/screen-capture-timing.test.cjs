'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { analyzeCaptureTiming, parseLogLine, resolveRunDirectory, statistics } = require('../tooling/analyze-screen-capture-timing.cjs');

const start = Date.UTC(2026, 9, 28, 12);
const result = (samples = [{ at: start }, { at: start + 1000 }], offset = 0) => ({
  environment: { logTimezoneOffsetMinutes: offset }, cases: [{ config: { source: 'native' }, samples }],
});
const line = (ms, message, pid = 10, tid = 20) => `[${pid}:${tid === null ? '' : tid + ':'}1028/1200${String(Math.floor(ms / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}:VERBOSE2:desktop_capture_device.cc(1)] ${message}`;
const segment = (ms, pid = 10, tid = 20) => [
  line(ms, 'CaptureFrame(is_refresh_frame=0)', pid, tid),
  line(ms + 3, 'OnCaptureResult [SUCCESS]', pid, tid),
  line(ms + 5, 'ScheduleNextCaptureFrame [last_capture_duration=5]', pid, tid),
  line(ms + 5, '  capture_period=10', pid, tid),
  line(ms + 5, '  timer(dT=5)', pid, tid),
];

test('matches complete native segments and their timing labels within UTC sample windows', () => {
  const measured = analyzeCaptureTiming(result(), segment(100).join('\n')).cases[0];
  assert.equal(measured.counts.matchedSegments, 1);
  assert.deepEqual(measured.rows[0], { pid: '10', threadId: '20', startAt: start + 100,
    callbackAt: start + 103, scheduleAt: start + 105, captureToCallbackMs: 3,
    callbackToScheduleMs: 2, wallclockTotalMs: 5, loggedDurationMs: 5, capturePeriodMs: 10,
    timerDelayMs: 5, observedStartIntervalMs: null, previousScheduledPeriodMs: null,
    wallclockStartIntervalExcessMs: null, previousSegmentStartLine: null,
    startLine: 1, callbackLine: 2, scheduleLine: 3, periodLine: 4, timerLine: 5 });
  assert.equal(measured.summary.captureToCallbackMs.median, 3);
});

test('isolates interleaved PID/TID contexts and never borrows another callback', () => {
  const log = [line(100, 'CaptureFrame(is_refresh_frame=0)'),
    line(101, 'OnCaptureResult [SUCCESS]', 10, 21),
    ...segment(110, 11, 20),
    line(120, 'ScheduleNextCaptureFrame [last_capture_duration=20]')].join('\n');
  const measured = analyzeCaptureTiming(result(), log).cases[0];
  assert.equal(measured.counts.matchedSegments, 1);
  assert.equal(measured.rows[0].pid, '11');
  assert.equal(measured.counts.unmatchedCallbacks, 1);
  assert.equal(measured.counts.incompleteSegments, 1);
});

test('excludes warmup, cleanup, refresh, failed, zero-hertz and overlapping captures', () => {
  const log = [...segment(0), ...segment(100),
    line(200, 'CaptureFrame(is_refresh_frame=1)'), line(201, 'OnCaptureResult [SUCCESS][RRF]'),
    line(202, 'ScheduleNextCaptureFrame [last_capture_duration=2]'),
    line(300, 'CaptureFrame(is_refresh_frame=0)'), line(301, 'OnCaptureResult [ERROR]'),
    line(302, 'ScheduleNextCaptureFrame [last_capture_duration=2]'),
    line(400, 'CaptureFrame(is_refresh_frame=0)'), line(401, 'OnCaptureResult [SUCCESS][0Hz]'),
    line(402, 'ScheduleNextCaptureFrame [last_capture_duration=2]'),
    line(500, 'CaptureFrame(is_refresh_frame=0)'), line(501, 'CaptureFrame(is_refresh_frame=0)'),
    line(502, 'OnCaptureResult [SUCCESS]'), line(503, 'OnCaptureResult [SUCCESS]'),
    line(504, 'ScheduleNextCaptureFrame [last_capture_duration=4]'),
    line(505, 'ScheduleNextCaptureFrame [last_capture_duration=4]'), ...segment(998)].join('\n');
  const measured = analyzeCaptureTiming(result([{ at: start + 10 }, { at: start + 1000 }]), log).cases[0];
  assert.equal(measured.counts.matchedSegments, 1);
  assert.equal(measured.counts.excludedRefresh, 1);
  assert.equal(measured.counts.excludedFailure, 1);
  assert.equal(measured.counts.excludedZeroHertz, 1);
  assert.equal(measured.counts.overlappingStarts, 1);
  assert.equal(measured.counts.excludedAmbiguousSegments, 2);
  assert.equal(measured.counts.incompleteSegments, 1);
});

test('compares consecutive matched starts with the previous logged period as wallclock excess', () => {
  const measured = analyzeCaptureTiming(result(), [...segment(100), ...segment(112), ...segment(125)].join('\n')).cases[0];
  assert.equal(measured.summary.observedStartIntervalMs.count, 2);
  assert.equal(measured.summary.observedStartIntervalMs.mean, 12.5);
  assert.equal(measured.summary.wallclockStartIntervalExcessMs.mean, 2.5);
  assert.equal(measured.rows[1].previousSegmentStartLine, 1);
});

test('uses recorded or explicit timezone offsets, leaving unknown alignment and CPU costs null', () => {
  const localLog = segment(100).join('\n').replaceAll('1028/1200', '1028/2000');
  assert.equal(analyzeCaptureTiming(result(undefined, -480), localLog).cases[0].counts.matchedSegments, 1);
  const unknown = result(); delete unknown.environment.logTimezoneOffsetMinutes;
  const missing = analyzeCaptureTiming(unknown, localLog);
  assert.equal(missing.logTimezoneOffsetMinutes, null);
  assert.equal(missing.cases[0].summary.wallclockTotalMs.median, null);
  assert.equal(missing.cases[0].cpu.nativeCaptureThreadCpuTimeMs, null);
  assert.equal(analyzeCaptureTiming(unknown, localLog, { logTimezoneOffsetMinutes: -480 }).cases[0].counts.matchedSegments, 1);
  assert.throws(() => analyzeCaptureTiming(unknown, localLog, { logTimezoneOffsetMinutes: 841 }));
});

test('reports missing TID, zero-resolution durations, CPU reporting sums and engine failures honestly', () => {
  const log = [line(100, 'CaptureFrame(is_refresh_frame=0)', 10, null),
    line(100, 'OnCaptureResult [SUCCESS]', 10, null),
    line(100, 'ScheduleNextCaptureFrame [last_capture_duration=0]', 10, null),
    line(150, 'Failed to capture 5 frames within 500 milliseconds.'), line(151, 'Duplication failed')].join('\n');
  const samples = [{ at: start, cpu: [{ type: 'Browser', cpu: { percentCPUUsage: 2 } }, { type: 'GPU', cpu: { percentCPUUsage: 3 } }] },
    { at: start + 1000, cpu: [{ type: 'Browser', cpu: {} }] }];
  const measured = analyzeCaptureTiming(result(samples), log).cases[0];
  assert.equal(measured.rows[0].threadId, null);
  assert.equal(measured.summary.wallclockTotalMs.median, 0);
  assert.equal(measured.summary.capturePeriodMs.median, null);
  assert.equal(measured.counts.pidOnlyMatchedSegments, 1);
  assert.equal(measured.counts.dxgiInitializationTimeouts, 1);
  assert.equal(measured.counts.duplicationFailures, 1);
  assert.equal(measured.cpu.sampleSums.mean, 5);
  assert.equal(measured.cpu.samples[1].percentCPUUsageSum, null);
  assert.ok(measured.warnings.some(message => message.includes('omit TID')));
});

test('handles New Year rollover and rejects malformed timestamps and non-native cases', () => {
  const rollover = result([{ at: Date.UTC(2026, 11, 31, 23, 59, 59) }, { at: Date.UTC(2027, 0, 1, 0, 0, 1) }]);
  const log = segment(100).join('\n').replaceAll('1028/1200', '0101/0000');
  assert.equal(analyzeCaptureTiming(rollover, log).cases[0].counts.matchedSegments, 1);
  assert.equal(analyzeCaptureTiming(result(), log.replaceAll('0101/0000', '0231/1200')).cases[0].counts.matchedSegments, 0);
  const generated = result(); generated.cases[0].config.source = 'generated';
  assert.equal(analyzeCaptureTiming(generated, segment(100).join('\n')).cases[0].counts.matchedSegments, 0);
  assert.equal(parseLogLine('unstructured text', 1), null);
  assert.equal(statistics([]).p95, null);
});

test('runtime guard permits only one run inside the benchmark namespaces', () => {
  const root = path.resolve('capture-timing-test-root');
  assert.equal(resolveRunDirectory(root, 'runtime/fps-candidate/zero-copy-Ab1234'), path.join(root, 'runtime/fps-candidate/zero-copy-Ab1234'));
  assert.doesNotThrow(() => resolveRunDirectory(root, 'runtime/fps-validation-efficiency-20261028/baseline-Ab1234'));
  for (const argument of ['runtime', 'runtime/fps-candidate', 'runtime/fps-candidate/a/b',
    'runtime/fps-other/run', 'runtime/fps-candidate/../../outside', '../runtime/fps-candidate/run']) {
    assert.throws(() => resolveRunDirectory(root, argument));
  }
});
