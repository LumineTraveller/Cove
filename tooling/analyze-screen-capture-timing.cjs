'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NOTES = [
  'Segments are elapsed wallclock between log statements, not thread CPU time or isolated graphics API/converter cost.',
  'Millisecond log timestamps and duration labels are truncated; 0 ms means below log resolution, not zero cost.',
  'Only regular successful non-0Hz captures wholly inside the measured sample window enter the timing summary; refresh, failed, overlapping and incomplete captures are excluded.',
  'Matching uses the logged PID and TID. If the log format omits TID, thread identity is unknown and PID-only matching is explicitly reported.',
  'Start-interval excess compares consecutive matched regular captures with the previous logged period; it includes wallclock scheduling and dispatch effects, not isolated timer lateness.',
  'Electron process CPU samples are reported separately; their sum is not whole-host CPU utilization or capture-thread CPU time.',
  'Event counts describe matching stamped log messages; they are not unique OS-frame counts or proof that unlogged failures were absent.',
];

function statistics(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const quantile = q => sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null;
  return { count: sorted.length, min: sorted[0] ?? null, median: quantile(0.5),
    p95: quantile(0.95), max: sorted.at(-1) ?? null,
    mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null };
}

function validOffset(value) {
  return Number.isInteger(value) && value >= -840 && value <= 840;
}

function parseLogLine(line, lineNumber) {
  const stamp = line.match(/^\[(\d+)(?::(\d+))?:(\d{2})(\d{2})\/(\d{2})(\d{2})(\d{2})\.(\d{3}):/);
  if (!stamp) return null;
  const event = { pid: stamp[1], threadId: stamp[2] ?? null,
    local: stamp.slice(3).map(Number), line: lineNumber };
  let match;
  if ((match = line.match(/CaptureFrame\(is_refresh_frame=([01])\)/))) {
    return { ...event, kind: 'start', refresh: match[1] === '1' };
  }
  if (line.includes('OnCaptureResult [SUCCESS]')) {
    return { ...event, kind: 'callback', success: true, zeroHertz: line.includes('[0Hz]') };
  }
  if (line.includes('OnCaptureResult [ERROR]')) return { ...event, kind: 'callback', success: false };
  if ((match = line.match(/ScheduleNextCaptureFrame \[last_capture_duration=(\d+(?:\.\d+)?)/))) {
    return { ...event, kind: 'schedule', duration: Number(match[1]) };
  }
  if ((match = line.match(/\bcapture_period=(\d+(?:\.\d+)?)/))) {
    return { ...event, kind: 'period', value: Number(match[1]) };
  }
  if ((match = line.match(/\btimer\(dT=(-?\d+(?:\.\d+)?)/))) {
    return { ...event, kind: 'timer', value: Number(match[1]) };
  }
  if (/Failed to capture \d+ frames\s+within\s+\d+ milliseconds/.test(line)) {
    return { ...event, kind: 'dxgiInitializationTimeout' };
  }
  if (line.includes('Duplication failed')) return { ...event, kind: 'duplicationFailure' };
  return null;
}

// Chromium labels omit the year. Select the closest valid year to this case's
// sample midpoint, also covering captures spanning midnight on New Year's Eve.
function eventTime(event, midpoint, timezoneOffsetMinutes) {
  const [month, day, hour, minute, second, millisecond] = event.local;
  const year = new Date(midpoint).getUTCFullYear();
  const candidates = [];
  for (const candidateYear of [year - 1, year, year + 1]) {
    const local = Date.UTC(candidateYear, month - 1, day, hour, minute, second, millisecond);
    const date = new Date(local);
    if (date.getUTCMonth() + 1 === month && date.getUTCDate() === day &&
        hour < 24 && minute < 60 && second < 60) candidates.push(local + timezoneOffsetMinutes * 60000);
  }
  return candidates.sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint))[0] ?? null;
}

function cpuSummary(samples) {
  const rows = samples.map(sample => {
    const metrics = sample.cpu;
    const complete = Array.isArray(metrics) && metrics.length > 0 &&
      metrics.every(metric => Number.isFinite(metric?.cpu?.percentCPUUsage));
    return { at: Number.isFinite(sample.at) ? sample.at : null, reportedProcesses: Array.isArray(metrics) ? metrics.length : null,
      percentCPUUsageSum: complete ? metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0) : null };
  });
  return { scope: 'Sum of Electron app.getAppMetrics().cpu.percentCPUUsage reporting values per sample; process identities are not present in the fixture CPU rows.',
    sampleSums: statistics(rows.map(row => row.percentCPUUsageSum)), samples: rows,
    wholeHostCpuUsage: null, nativeCaptureThreadCpuTimeMs: null, pureConverterCpuTimeMs: null };
}

const TIMING_FIELDS = ['captureToCallbackMs', 'callbackToScheduleMs', 'wallclockTotalMs',
  'loggedDurationMs', 'capturePeriodMs', 'timerDelayMs', 'observedStartIntervalMs', 'wallclockStartIntervalExcessMs'];

function analyzeCase(measured, index, events, offset) {
  const samples = Array.isArray(measured.samples) ? measured.samples : [];
  const times = samples.map(sample => sample.at);
  const validWindow = times.length >= 2 && times.every(Number.isFinite) &&
    times.every((at, position) => position === 0 || at > times[position - 1]);
  const sampleWindow = validWindow ? { start: times[0], end: times.at(-1) } : null;
  const counts = { regularStarts: 0, refreshStarts: 0, successfulCallbacks: 0, failedCallbacks: 0,
    schedules: 0, overlappingStarts: 0, duplicateCallbacks: 0, unmatchedCallbacks: 0,
    excludedRefresh: 0, excludedFailure: 0, excludedZeroHertz: 0, excludedAmbiguousSegments: 0, incompleteSegments: 0,
    invalidClockSegments: 0, matchedSegments: 0, pidOnlyMatchedSegments: 0,
    dxgiInitializationTimeouts: 0, duplicationFailures: 0 };
  const rows = [], contexts = new Map();
  if (sampleWindow && offset !== null && measured.config?.source === 'native') {
    const midpoint = (sampleWindow.start + sampleWindow.end) / 2;
    for (const event of events) {
      const at = eventTime(event, midpoint, offset);
      if (at === null || at < sampleWindow.start || at > sampleWindow.end) continue;
      const key = `${event.pid}:${event.threadId ?? 'unknown'}`;
      let context = contexts.get(key);
      if (!context) { context = { active: null, lastRow: null }; contexts.set(key, context); }
      if (event.kind === 'dxgiInitializationTimeout') { counts.dxgiInitializationTimeouts++; continue; }
      if (event.kind === 'duplicationFailure') { counts.duplicationFailures++; continue; }
      if (event.kind === 'start') {
        counts[event.refresh ? 'refreshStarts' : 'regularStarts']++;
        const previousRow = context.lastRow;
        context.lastRow = null;
        if (context.active) {
          counts.overlappingStarts++;
          context.active = { ambiguousDepth: (context.active.ambiguousDepth ?? 1) + 1 };
        } else context.active = { start: event, at, callback: null, previousRow };
      } else if (event.kind === 'callback') {
        counts[event.success ? 'successfulCallbacks' : 'failedCallbacks']++;
        if (!context.active) { context.lastRow = null; counts.unmatchedCallbacks++; continue; }
        if (context.active.ambiguousDepth) continue;
        if (context.active.callback) {
          counts.duplicateCallbacks++;
          context.active = { ambiguousDepth: 1 };
        } else context.active.callback = { event, at };
      } else if (event.kind === 'schedule') {
        counts.schedules++;
        context.lastRow = null;
        const active = context.active;
        if (!active) continue;
        if (active.ambiguousDepth) {
          counts.excludedAmbiguousSegments++;
          if (--active.ambiguousDepth === 0) context.active = null;
          continue;
        }
        context.active = null;
        if (active.start.refresh) { counts.excludedRefresh++; continue; }
        if (!active.callback) { counts.incompleteSegments++; continue; }
        if (!active.callback.event.success) { counts.excludedFailure++; continue; }
        if (active.callback.event.zeroHertz) { counts.excludedZeroHertz++; continue; }
        if (active.callback.at < active.at || at < active.callback.at) { counts.invalidClockSegments++; continue; }
        const row = { pid: event.pid, threadId: event.threadId, startAt: active.at,
          callbackAt: active.callback.at, scheduleAt: at,
          captureToCallbackMs: active.callback.at - active.at,
          callbackToScheduleMs: at - active.callback.at, wallclockTotalMs: at - active.at,
          loggedDurationMs: event.duration, capturePeriodMs: null, timerDelayMs: null,
          observedStartIntervalMs: active.previousRow ? active.at - active.previousRow.startAt : null,
          previousScheduledPeriodMs: active.previousRow?.capturePeriodMs ?? null,
          wallclockStartIntervalExcessMs: active.previousRow?.capturePeriodMs !== null && active.previousRow?.capturePeriodMs !== undefined
            ? active.at - active.previousRow.startAt - active.previousRow.capturePeriodMs : null,
          previousSegmentStartLine: active.previousRow?.startLine ?? null,
          startLine: active.start.line, callbackLine: active.callback.event.line, scheduleLine: event.line,
          periodLine: null, timerLine: null };
        rows.push(row); context.lastRow = row;
      } else if (context.lastRow && event.value >= 0) {
        if (event.kind === 'period') { context.lastRow.capturePeriodMs = event.value; context.lastRow.periodLine = event.line; }
        if (event.kind === 'timer') { context.lastRow.timerDelayMs = event.value; context.lastRow.timerLine = event.line; }
      }
    }
    counts.incompleteSegments += [...contexts.values()].reduce((sum, context) => sum +
      (context.active ? context.active.ambiguousDepth ?? 1 : 0), 0);
  }
  counts.matchedSegments = rows.length;
  counts.pidOnlyMatchedSegments = rows.filter(row => row.threadId === null).length;
  const warnings = [];
  if (!sampleWindow) warnings.push('A complete strictly increasing sample timestamp window is unavailable.');
  if (offset === null) warnings.push('Log timezone offset is unavailable; no log events were aligned. Supply --log-timezone-offset-minutes using Date.getTimezoneOffset() convention.');
  if (counts.pidOnlyMatchedSegments) warnings.push('The matched log rows omit TID; same-thread identity cannot be established.');
  return { index, config: measured.config ?? null, sampleWindow,
    alignmentAvailable: Boolean(sampleWindow && offset !== null), counts, warnings,
    summary: Object.fromEntries(TIMING_FIELDS.map(field => [field, statistics(rows.map(row => row[field]))])),
    cpu: cpuSummary(samples), rows };
}

function analyzeCaptureTiming(result, log, options = {}) {
  const explicit = options.logTimezoneOffsetMinutes;
  if (explicit !== undefined && !validOffset(explicit)) throw Error('Invalid log timezone offset');
  const recorded = result.environment?.logTimezoneOffsetMinutes;
  const offset = explicit ?? (validOffset(recorded) ? recorded : null);
  const events = log.split(/\r?\n/).map((line, index) => parseLogLine(line, index + 1)).filter(Boolean);
  return { schemaVersion: 1, notes: NOTES, logTimezoneOffsetMinutes: offset,
    offsetConvention: 'Date.getTimezoneOffset(): UTC minus local time, e.g. UTC+08:00 is -480.',
    offsetSource: explicit !== undefined ? 'explicit-cli-option' : offset !== null ? 'result.environment.logTimezoneOffsetMinutes' : null,
    cases: (Array.isArray(result.cases) ? result.cases : []).map((measured, index) => analyzeCase(measured, index, events, offset)) };
}

function resolveRunDirectory(repositoryRoot, argument) {
  const run = path.resolve(repositoryRoot, argument);
  const relative = path.relative(path.join(repositoryRoot, 'runtime'), run);
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || !/^fps-(?:candidate|validation-[a-z0-9-]{1,60})$/.test(parts[0]) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,159}$/.test(parts[1])) {
    throw Error('Run directory must be runtime/fps-candidate/<run> or runtime/fps-validation-<label>/<run>');
  }
  return run;
}

function analyzeRunDirectory(repositoryRoot, argument, options = {}) {
  const root = fs.realpathSync(repositoryRoot);
  const run = resolveRunDirectory(root, argument);
  if (fs.realpathSync(run) !== run) throw Error('Run directory must not resolve through a symbolic link or junction');
  const read = name => {
    const file = path.join(run, name);
    if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile()) throw Error(`Unsafe input file: ${name}`);
    if (fs.statSync(file).size > 64 * 1024 * 1024) throw Error(`Input exceeds 64 MiB: ${name}`);
    return fs.readFileSync(file, 'utf8');
  };
  const analysis = analyzeCaptureTiming(JSON.parse(read('result.json')), read('native-capture.log'), options);
  const output = path.join(run, 'native-timing.json');
  const outputStat = fs.lstatSync(output, { throwIfNoEntry: false });
  if (outputStat && (!outputStat.isFile() || fs.realpathSync(output) !== output)) throw Error('Unsafe output file');
  fs.writeFileSync(output, JSON.stringify(analysis, null, 2) + '\n');
  return { output, analysis };
}

function main(args) {
  const usage = 'Usage: node tooling/analyze-screen-capture-timing.cjs runtime/fps-*/<run> [--log-timezone-offset-minutes -480]';
  if (![1, 3].includes(args.length) || (args.length === 3 && args[1] !== '--log-timezone-offset-minutes')) throw Error(usage);
  const options = args.length === 3 ? { logTimezoneOffsetMinutes: Number(args[2]) } : {};
  const { output, analysis } = analyzeRunDirectory(path.resolve(__dirname, '..'), args[0], options);
  console.log(JSON.stringify({ output, logTimezoneOffsetMinutes: analysis.logTimezoneOffsetMinutes,
    cases: analysis.cases.map(({ rows, cpu, ...measured }) => ({ ...measured, cpuSampleSums: cpu.sampleSums })) }, null, 2));
}

module.exports = { analyzeCaptureTiming, analyzeRunDirectory, parseLogLine, resolveRunDirectory, statistics };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
