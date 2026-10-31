'use strict';
const fs = require('node:fs');
const path = require('node:path');
const TRACE_CATEGORIES = Object.freeze(['webrtc', 'media', 'disabled-by-default-webrtc',
  'disabled-by-default-video_and_image_capture', 'gpu.capture']);
const SOURCE_BASIS = 'Electron v44.0.0 contentTracing/TraceConfig; Chromium 152.0.7977.54 DesktopCaptureDevice, VideoFrameConverter, video_util, WebRtcVideoFrameAdapter, FrameSinkVideoCapturerImpl, SkiaOutputSurfaceImplOnGpu and TaskAnnotator TRACE_EVENT sites.';

function captureTraceOptions(processIds, categories) {
  const ids = [...new Set(processIds)];
  if (!ids.length || ids.some(pid => !Number.isInteger(pid) || pid <= 0)) throw Error('Owned trace process IDs are required');
  const available = new Set(categories.flatMap(category => category.split(',')));
  const included = TRACE_CATEGORIES.filter(category => available.has(category));
  if (!included.length) throw Error('No reviewed capture trace category is available');
  return { recording_mode: 'record-until-full', trace_buffer_size_in_kb: 32768,
    enable_argument_filter: true, included_process_ids: ids,
    included_categories: included, excluded_categories: ['*'] };
}

function sanitizeCaptureTrace(trace, ownedProcessIds) {
  if (!Array.isArray(trace.traceEvents)) throw Error('Expected Chromium JSON traceEvents');
  const processNames = {}, threadNames = {};
  const safeName = value => typeof value === 'string' && /^[A-Za-z0-9_.() :+\-]{1,120}$/.test(value) ? value : null;
  const owned = ownedProcessIds ? new Set(ownedProcessIds) : null;
  const events = trace.traceEvents.filter(event => !owned || owned.has(event.pid)).map(event => {
    if (event.ph === 'M' && event.name === 'process_name' && safeName(event.args?.name)) processNames[event.pid] = event.args.name;
    if (event.ph === 'M' && event.name === 'thread_name' && safeName(event.args?.name)) threadNames[event.pid + ':' + event.tid] = event.args.name;
    const clean = {};
    for (const key of ['cat', 'name', 'ph', 'ts', 'dur', 'pid', 'tid', 'tts', 'tdur', 'ttdur', 'id', 'scope', 's', 'bp']) {
      const value = event[key];
      if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'string') clean[key] = value;
    }
    if (typeof clean.name === 'string' && /https?:|file:|token=|sdp=/i.test(clean.name)) clean.name = 'REDACTED_EVENT_NAME';
    if (event.id2 && typeof event.id2 === 'object') {
      clean.id2 = Object.fromEntries(['local', 'global'].filter(key => typeof event.id2[key] === 'number' ||
        typeof event.id2[key] === 'string' && /^(?:0x)?[a-fA-F0-9]+$/.test(event.id2[key])).map(key => [key, event.id2[key]]));
    }
    // No args, URLs, labels, command lines, screenshots, or arbitrary metadata.
    return clean;
  });
  return { traceEvents: events, processNames, threadNames,
    sanitization: { argumentsRemoved: true, onlyReviewedMetadataNamesRetained: true,
      ownedProcessIds: ownedProcessIds ?? null, sourceBasis: SOURCE_BASIS } };
}

// Chromium exports through a random UUID.tmp before moving to the requested
// path. Inspect only this launcher-owned run, after Electron has exited (or
// after the underlying stop promise completed), so no exporter can write late.
function cleanupOwnedTraceExports(directory, processIds) {
  const ownedDirectory = fs.realpathSync(directory), records = [];
  const candidateName = name => name === 'capture-trace.raw.json' || /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.tmp$/i.test(name);
  for (const name of fs.readdirSync(ownedDirectory).filter(candidateName)) {
    const file = path.join(ownedDirectory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(fs.realpathSync(file)) !== ownedDirectory) throw Error('Trace export left its owned run');
    const record = { name, bytes: stat.size, completeJson: false, sanitized: false, removed: false };
    const bytes = fs.readFileSync(file);
    if (name !== 'capture-trace.raw.json' && bytes.length && !/"traceEvents"\s*:/.test(bytes.subarray(0, 256).toString('utf8'))) {
      records.push({ ...record, ignoredUnrecognizedHeader: true }); continue;
    }
    try {
      let trace; try { trace = JSON.parse(bytes.toString('utf8')); record.completeJson = true; } catch { record.reason = 'Incomplete exporter JSON; no partial event reconstruction'; }
      if (trace) {
        const safe = sanitizeCaptureTrace(trace, processIds), safeName = 'capture-trace-recovered.json';
        fs.writeFileSync(path.join(ownedDirectory, safeName), JSON.stringify(safe));
        const summary = analyzeCaptureTrace(safe);
        fs.writeFileSync(path.join(ownedDirectory, 'capture-trace-recovered-summary.json'), JSON.stringify(summary, null, 2) + '\n');
        record.sanitized = true; record.file = safeName; record.summaryFile = 'capture-trace-recovered-summary.json';
      }
    } finally { fs.unlinkSync(file); record.removed = !fs.existsSync(file); records.push(record); }
  }
  return { at: new Date().toISOString(), records, rawFileRetained: fs.readdirSync(ownedDirectory).some(candidateName) };
}

function statistics(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const q = fraction => sorted.length ? sorted[Math.floor((sorted.length - 1) * fraction)] : null;
  return { count: sorted.length, total: sorted.reduce((a, b) => a + b, 0),
    median: q(.5), p95: q(.95), max: sorted.at(-1) ?? null };
}
function unionDuration(intervals) {
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]); let total = 0, start = null, end = null;
  for (const [a, b] of sorted) { if (start === null) { start = a; end = b; }
    else if (a <= end) end = Math.max(end, b); else { total += end - start; start = a; end = b; } }
  return start === null ? 0 : total + end - start;
}
function nativeSegments(slices, threadNames) {
  const contains = (outer, inner) => outer.pid === inner.pid && outer.tid === inner.tid &&
    outer.ts <= inner.ts && outer.ts + outer.duration >= inner.ts + inner.duration;
  const known = slices.filter(slice => slice.kind === 'thread-slice' &&
    threadNames?.[slice.pid + ':' + slice.tid] === 'desktopCaptureThread');
  const converters = known.filter(slice => slice.name === 'ConvertAndScale');
  const candidate = known.filter(slice => slice.cat === 'webrtc' &&
    ['operator()', 'CaptureFrame'].includes(slice.name) && converters.some(child => contains(slice, child)));
  const outermost = candidate.filter((slice, index) => !candidate.some((parent, other) => other !== index &&
    contains(parent, slice) && (parent.duration > slice.duration || parent.ts < slice.ts || other < index)));
  const rows = outermost.map(parent => {
    const conversion = converters.filter(child => contains(parent, child));
    const delivery = known.filter(child => contains(parent, child) && /^VideoCaptureDeviceClient::OnIncoming/.test(child.name));
    const cpuUnion = children => children.length && children.every(child => Number.isFinite(child.tts) && Number.isFinite(child.threadDuration))
      ? unionDuration(children.map(child => [child.tts, child.tts + child.threadDuration])) / 1000 : null;
    const cpu = Number.isFinite(parent.threadDuration) ? parent.threadDuration / 1000 : null;
    const knownCpu = cpuUnion([...conversion, ...delivery]);
    return { elapsedMs: parent.duration / 1000, threadCpuMs: cpu,
      elapsedMinusThreadCpuMs: cpu === null ? null : parent.duration / 1000 - cpu,
      conversionWallMs: unionDuration(conversion.map(child => [child.ts, child.ts + child.duration])) / 1000,
      conversionThreadCpuMs: cpuUnion(conversion),
      residualThreadCpuMs: cpu === null || knownCpu === null ? null : cpu - knownCpu };
  });
  const fields = ['elapsedMs', 'threadCpuMs', 'elapsedMinusThreadCpuMs', 'conversionWallMs', 'conversionThreadCpuMs', 'residualThreadCpuMs'];
  return { count: rows.length,
    mapping: 'Only desktopCaptureThread outermost webrtc CaptureFrame/operator() spans containing ConvertAndScale; operator() is the locked Chromium TRACE macro lambda name.',
    summary: Object.fromEntries(fields.map(key => { const values = rows.map(row => row[key]).filter(Number.isFinite); const stats = statistics(values); return [key, { ...stats, mean: values.length ? stats.total / values.length : null }]; })),
    negativeElapsedMinusCpuCount: rows.filter(row => row.elapsedMinusThreadCpuMs !== null && row.elapsedMinusThreadCpuMs < 0).length,
    notes: ['Elapsed minus thread CPU includes scheduling and other waits; it is not pure GPU execution time.',
      'Converter/delivery nested CPU intervals are unioned before subtracting. Residual includes other native work and instrumentation, not an exclusive DXGI API measurement.',
      'Trace is startup-only with profiling overhead; it is not a normal throughput or stability acceptance result.'] };
}
function analyzeCaptureTrace(trace) {
  const events = trace.traceEvents ?? [], stacks = new Map(), asyncStarts = new Map(), slices = [], unmatched = { threadEnds: 0, asyncEnds: 0 };
  function complete(start, end, kind) {
    const duration = end.ts - start.ts;
    if (!Number.isFinite(duration) || duration < 0) return;
    slices.push({ ...start, duration, kind, threadDuration: kind === 'thread-slice' &&
      Number.isFinite(start.tts) && Number.isFinite(end.tts) ? end.tts - start.tts : null });
  }
  const asyncKey = event => [event.cat, event.name, event.scope ?? '', event.id2?.global !== undefined ? 'global' : event.pid,
    event.id2?.global ?? event.id2?.local ?? event.id].join('|');
  for (const event of events) {
    const key = event.pid + ':' + event.tid;
    if (event.ph === 'X' && Number.isFinite(event.dur)) slices.push({ ...event, duration: event.dur,
      threadDuration: Number.isFinite(event.tdur ?? event.ttdur) ? event.tdur ?? event.ttdur : null, kind: 'thread-slice' });
    else if (event.ph === 'B') { if (!stacks.has(key)) stacks.set(key, []); stacks.get(key).push(event); }
    else if (event.ph === 'E') { const start = stacks.get(key)?.pop(); if (start) complete(start, event, 'thread-slice'); else unmatched.threadEnds++; }
    else if (event.ph === 'b') asyncStarts.set(asyncKey(event), event);
    else if (event.ph === 'e') { const start = asyncStarts.get(asyncKey(event)); if (start) { complete(start, event, 'async-lifetime'); asyncStarts.delete(asyncKey(event)); } else unmatched.asyncEnds++; }
  }
  const groups = new Map(), threads = new Map();
  for (const slice of slices) {
    const key = [slice.pid, slice.tid, slice.kind, slice.cat, slice.name].join('|');
    if (!groups.has(key)) groups.set(key, { pid: slice.pid, tid: slice.tid, kind: slice.kind, category: slice.cat,
      name: slice.name, threadName: trace.threadNames?.[slice.pid + ':' + slice.tid] ?? null, wall: [], cpu: [] });
    const group = groups.get(key); group.wall.push(slice.duration / 1000);
    if (slice.kind === 'thread-slice' && Number.isFinite(slice.threadDuration) && slice.threadDuration >= 0) group.cpu.push(slice.threadDuration / 1000);
    const threadKey = slice.pid + ':' + slice.tid;
    if (!threads.has(threadKey)) threads.set(threadKey, { pid: slice.pid, tid: slice.tid,
      name: trace.threadNames?.[threadKey] ?? null, wall: [], cpu: [] });
    if (slice.kind === 'thread-slice') {
      const thread = threads.get(threadKey); thread.wall.push([slice.ts, slice.ts + slice.duration]);
      if (Number.isFinite(slice.tts) && Number.isFinite(slice.threadDuration) && slice.threadDuration >= 0)
        thread.cpu.push([slice.tts, slice.tts + slice.threadDuration]);
    }
  }
  const summarized = [...groups.values()].map(({ wall, cpu, ...group }) => ({ ...group,
    inclusiveWallMs: statistics(wall), inclusiveThreadCpuMs: cpu.length ? statistics(cpu) : null }));
  return { scope: 'Profiling with trace overhead, not normal FPS; all durations are milliseconds.',
    sourceBasis: SOURCE_BASIS, eventCount: events.length, completedSliceCount: slices.length,
    threadCpuFieldsPresent: events.some(event => Number.isFinite(event.tts) || Number.isFinite(event.tdur) || Number.isFinite(event.ttdur)),
    capturePathMarkers: events.filter(event => ['UsingVizFrameSinkCapturer', 'UsingDesktopCapturer'].includes(event.name)).map(({ name, pid, tid, ts }) => ({ name, pid, tid, ts })),
    unmatched: { ...unmatched, threadBegins: [...stacks.values()].reduce((sum, stack) => sum + stack.length, 0), asyncBegins: asyncStarts.size },
    nativeCaptureSegments: nativeSegments(slices, trace.threadNames),
    threads: [...threads.values()].map(({ wall, cpu, ...thread }) => ({ ...thread,
      recordedWallUnionMs: unionDuration(wall) / 1000, recordedThreadCpuUnionMs: cpu.length ? unionDuration(cpu) / 1000 : null })),
    captureAndTaskSlices: summarized.filter(group => /captur|convert|scal|readback|mapframe|copyoutput|runtask|taskqueue|frameinuse|blit/i.test(group.name)).sort((a, b) => b.inclusiveWallMs.total - a.inclusiveWallMs.total),
    topSlices: summarized.sort((a, b) => b.inclusiveWallMs.total - a.inclusiveWallMs.total).slice(0, 80),
    notes: ['Nested inclusive durations overlap and must not be summed as total CPU or end-to-end latency.',
      'Async capture/frame lifetimes are wallclock only, never thread CPU.',
      'Thread CPU is unknown when tts/tdur are absent. CPU unions cover only recorded spans, not the whole process or host.',
      'ConvertAndScale combines scaling/color conversion; no independent driver/libyuv CPU stopwatch is inferred.',
      'UsingDesktopCapturer does not alone identify DXGI, GDI or WGC; UsingVizFrameSinkCapturer identifies the Viz capture route.'] };
}

if (require.main === module) {
  const input = process.argv[2]; if (!input) throw Error('Usage: node tooling/analyze-screen-performance-trace.cjs <sanitized-trace.json> [summary.json]');
  const trace = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (trace.sanitization?.argumentsRemoved !== true) throw Error('Analyze only the sanitized capture trace');
  const summary = analyzeCaptureTrace(trace), output = JSON.stringify(summary, null, 2) + '\n';
  if (process.argv[3]) fs.writeFileSync(process.argv[3], output); else process.stdout.write(output);
}
module.exports = { TRACE_CATEGORIES, captureTraceOptions, sanitizeCaptureTrace, analyzeCaptureTrace, cleanupOwnedTraceExports };
