import { nativeScreenFailureReason } from './native-screen-capture-diagnostics';

const HELPER_PREFIX = 'COVE_NATIVE_CAPTURE_TIMING ';
const HELPER_COUNTS = ['ticks', 'missedTicks', 'acquireSuccess', 'acquireTimeout', 'noPresent', 'noSlot',
  'sourcePresents', 'pointerOnly', 'accumulatedFrames', 'maxAccumulatedFrames', 'newFrames', 'refreshFrames',
  'openSlotCreditWaitUs', 'periodUs', 'elapsedUs', 'readinessRetries', 'readinessExpired', 'readinessCancelled',
  'readinessSlotWaitWindows', 'readinessPresentWaitWindows', 'readinessRecoveredSlot', 'readinessRecoveredPresent',
  'cpuMapAttempts', 'cpuMapStillDrawing', 'cpuMapCancelled', 'cpuMapTimeouts'] as const;
const HELPER_STAGES = ['acquire', 'draw', 'gpuWait', 'gpuFlush', 'gpuQuery', 'frameRelease', 'output',
  'tickWork', 'tickLateness', 'timerWait', 'timerOvershoot', 'slotCreditWait', 'cpuReadback',
  'gpuFenceCheck', 'gpuEventArm', 'gpuEventWait', 'cpuMapWait', 'acquireSuccessWait', 'acquireTimeoutWait'] as const;
const BROKER_COUNTS = ['sessions', 'activeSessions', 'helpers', 'imports', 'pendingReferences', 'busySlots',
  'started', 'stopped', 'frames', 'refreshFrames', 'transferredFrames', 'releasedFrames'] as const;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const duration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

interface HelperStage { count: number; totalUs: number; maxUs: number }
interface Residence extends HelperStage { buckets: readonly number[] }
export interface NativeScreenHelperTiming {
  schemaVersion: 1;
  final: boolean;
  selectedCompletion?: 'query' | 'fence';
  selectedAcquireMode?: 'timeout' | 'poll';
  counts: Readonly<Partial<Record<typeof HELPER_COUNTS[number], number>>>;
  stages: Readonly<Partial<Record<typeof HELPER_STAGES[number], Readonly<HelperStage>>>>;
  leaseResidence?: Readonly<Residence>;
  importedResidence?: Readonly<Residence>;
}

/** Copy fixed numeric aggregates only. Unknown helper text never reaches a log. */
export function nativeScreenHelperTiming(value: unknown): Readonly<NativeScreenHelperTiming> | null {
  if (!record(value) || value.schemaVersion !== 1) return null;
  const counts: Partial<Record<typeof HELPER_COUNTS[number], number>> = {};
  const stages: Partial<Record<typeof HELPER_STAGES[number], Readonly<HelperStage>>> = {};
  for (const key of HELPER_COUNTS) if (count(value[key])) counts[key] = value[key];
  if (record(value.stages)) {
    for (const key of HELPER_STAGES) {
      const stage = value.stages[key];
      if (record(stage) && count(stage.count) && count(stage.totalUs) && count(stage.maxUs))
        stages[key] = Object.freeze({ count: stage.count, totalUs: stage.totalUs, maxUs: stage.maxUs });
    }
  }
  if (!Object.keys(counts).length || !Object.keys(stages).length) return null;
  const safe: NativeScreenHelperTiming = { schemaVersion: 1, final: value.final === true,
    counts: Object.freeze(counts), stages: Object.freeze(stages) };
  if (value.selectedCompletion === 'query' || value.selectedCompletion === 'fence') safe.selectedCompletion = value.selectedCompletion;
  if (value.selectedAcquireMode === 'timeout' || value.selectedAcquireMode === 'poll') safe.selectedAcquireMode = value.selectedAcquireMode;
  for (const key of ['leaseResidence', 'importedResidence'] as const) {
    const residence = value[key];
    if (record(residence) && count(residence.count) && count(residence.totalUs) && count(residence.maxUs) &&
        Array.isArray(residence.buckets) && residence.buckets.length === 7 && residence.buckets.every(count))
      safe[key] = Object.freeze({ count: residence.count, totalUs: residence.totalUs, maxUs: residence.maxUs,
        buckets: Object.freeze([...residence.buckets]) });
  }
  return Object.freeze(safe);
}

/** One bounded partial line, no raw-line retention, and no effect on media on any observer error. */
export function createNativeScreenHelperTimingCollector(onSample: (sample: Readonly<NativeScreenHelperTiming>) => void) {
  let pending = '', pendingBytes = 0, discarding = false, rejected = 0, samples = 0, closed = false;
  const maximumLineBytes = 16_384, maximumChunkBytes = 65_536;
  return {
    write(chunk: Uint8Array) {
      if (closed) return;
      try {
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > maximumChunkBytes) {
          pending = ''; pendingBytes = 0; discarding = true; rejected++; return;
        }
        const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8');
        let offset = 0;
        while (offset < text.length) {
          const newline = text.indexOf('\n', offset), end = newline < 0 ? text.length : newline;
          if (!discarding) {
            const part = text.slice(offset, end), bytes = Buffer.byteLength(part, 'utf8');
            if (pendingBytes + bytes > maximumLineBytes) { pending = ''; pendingBytes = 0; discarding = true; rejected++; }
            else { pending += part; pendingBytes += bytes; }
          }
          if (newline < 0) break;
          if (!discarding && pending.startsWith(HELPER_PREFIX)) {
            try {
              const safe = nativeScreenHelperTiming(JSON.parse(pending.slice(HELPER_PREFIX.length)));
              if (safe) {
                samples++;
                try { void Promise.resolve(onSample(safe)).catch(() => {}); } catch { /* No media callback is called. */ }
              }
              else rejected++;
            } catch { rejected++; }
          }
          pending = ''; pendingBytes = 0; discarding = false; offset = newline + 1;
        }
      } catch { pending = ''; pendingBytes = 0; discarding = true; rejected++; }
    },
    close() { closed = true; pending = ''; pendingBytes = 0; },
    snapshot() { return { samples, rejected, pendingCharacters: pending.length, pendingBytes, closed }; },
  };
}

export function nativeScreenBrokerTiming(value: unknown) {
  if (!record(value)) return null;
  const safe: RecordValue = {};
  for (const key of BROKER_COUNTS) if (count(value[key])) safe[key] = value[key];
  safe.disabled = value.disabled === true;
  safe.pixelFormat = value.pixelFormat === 'bgra' || value.pixelFormat === 'nv12' ? value.pixelFormat : null;
  safe.frameStorage = value.frameStorage === 'gpu' || value.frameStorage === 'cpu' ? value.frameStorage : null;
  safe.failureReason = value.failureCode === null ? null : nativeScreenFailureReason(value.failureCode);
  safe.lastEndReason = value.lastEndReason === null ? null : nativeScreenFailureReason(value.lastEndReason);
  const timing: RecordValue = {};
  if (record(value.timing)) for (const name of ['import', 'transfer', 'reference']) {
    const stage = value.timing[name];
    if (!record(stage) || !count(stage.count) || !duration(stage.totalMs) || !duration(stage.maxMs) ||
        !Array.isArray(stage.buckets) || stage.buckets.length !== 7 || !stage.buckets.every(count)) continue;
    timing[name] = { count: stage.count, totalMs: stage.totalMs, maxMs: stage.maxMs, buckets: [...stage.buckets] };
  }
  safe.timing = timing;
  return safe;
}

interface TimerHandle { unref?(): unknown }
interface TimingLoggerOptions {
  snapshot(): unknown;
  log(value: unknown): void;
  now?(): number;
  setInterval?(callback: () => void, milliseconds: number): TimerHandle;
  clearInterval?(handle: TimerHandle): void;
}

/** Opt-in main-process observer: at most 120 output attempts / ten minutes, then stop observing only. */
export function createNativeScreenTimingLogger(options: TimingLoggerOptions) {
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const clearTimer = options.clearInterval ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>));
  const maximumRecords = 120, maximumDurationMs = 600_000;
  let interval: TimerHandle | undefined, startedAt: number | undefined, stopped = false, records = 0;
  let latestHelper: { captureNumber: number; sample: Readonly<NativeScreenHelperTiming> } | null = null;
  const output = (value: unknown) => {
    records++;
    try { void Promise.resolve(options.log(value)).catch(() => {}); } catch { /* Logging is never capture policy. */ }
  };
  function stop() {
    stopped = true;
    if (interval) { try { clearTimer(interval); } catch { /* Observer cleanup only. */ } interval = undefined; }
    latestHelper = null;
  }
  function tick() {
    if (stopped || startedAt === undefined) return;
    try {
      const endedAt = now();
      if (!duration(endedAt) || endedAt < startedAt) throw new Error('observer_clock');
      const elapsedMs = Math.round(endedAt - startedAt);
      if (records >= maximumRecords - 1 || elapsedMs >= maximumDurationMs) {
        output({ event: 'limited', limited: true, elapsedMs,
          reason: elapsedMs >= maximumDurationMs ? 'time_limit' : 'record_limit',
          recordLimit: maximumRecords, durationLimitMs: maximumDurationMs });
        stop(); return;
      }
      const broker = nativeScreenBrokerTiming(options.snapshot());
      output({ event: 'sample', limited: false, elapsedMs, broker,
        helperCaptureNumber: latestHelper?.captureNumber ?? null,
        helperMatchesLatestStart: Boolean(latestHelper && broker?.started === latestHelper.captureNumber),
        helper: latestHelper?.sample ?? null });
    } catch {
      output({ event: 'limited', limited: true, reason: 'observer_error', recordLimit: maximumRecords,
        durationLimitMs: maximumDurationMs });
      stop();
    }
  }
  return {
    start() {
      if (stopped || startedAt !== undefined) return;
      try {
        const value = now();
        if (!duration(value)) { stop(); return; }
        startedAt = value;
        interval = setTimer(tick, 5_000); interval.unref?.();
      } catch { stop(); }
    },
    helper(sample: Readonly<NativeScreenHelperTiming>, captureNumber: number) {
      if (stopped || !count(captureNumber) || captureNumber === 0 ||
          (latestHelper && captureNumber < latestHelper.captureNumber)) return;
      try {
        const safe = nativeScreenHelperTiming({ ...sample.counts, schemaVersion: sample.schemaVersion,
          final: sample.final, selectedCompletion: sample.selectedCompletion, selectedAcquireMode: sample.selectedAcquireMode,
          stages: sample.stages, leaseResidence: sample.leaseResidence, importedResidence: sample.importedResidence });
        if (safe) latestHelper = { captureNumber, sample: safe };
      } catch { /* A malformed observation never changes capture. */ }
    },
    stop,
    state() { return { started: startedAt !== undefined, stopped, records, retainedHelperSamples: latestHelper ? 1 : 0 }; },
  };
}
