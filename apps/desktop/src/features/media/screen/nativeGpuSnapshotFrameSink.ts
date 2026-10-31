export type NativeGpuSnapshotFrameResult = 'snapshotted' | 'superseded' | 'expired' | 'stopped';
export type NativeGpuSnapshotFrameDropReason = 'superseded' | 'expired';
export type NativeGpuSnapshotFrameFailureCode = 'setup_failed' | 'input_contract' | 'snapshot_failed' |
  'snapshot_timeout' | 'output_contract' | 'write_failed' | 'write_timeout' | 'callback_failed';

const FAILURE_CODES: ReadonlySet<unknown> = new Set<NativeGpuSnapshotFrameFailureCode>([
  'setup_failed', 'input_contract', 'snapshot_failed', 'snapshot_timeout', 'output_contract',
  'write_failed', 'write_timeout', 'callback_failed',
]);

export class NativeGpuSnapshotFrameSinkError extends Error {
  constructor(readonly code: NativeGpuSnapshotFrameFailureCode) {
    super(code); this.name = 'NativeGpuSnapshotFrameSinkError';
  }
}

export function getNativeGpuSnapshotFrameFailureCode(error: unknown): NativeGpuSnapshotFrameFailureCode | 'unknown' {
  return error instanceof NativeGpuSnapshotFrameSinkError && FAILURE_CODES.has(error.code) ? error.code : 'unknown';
}

/** Synchronous bitmap snapshot only; this is not a GPU completion acknowledgment. */
export interface NativeGpuSnapshotFramePlatform {
  snapshot(input: VideoFrame, timestamp: number): VideoFrame;
  dispose(): void;
}

export interface NativeGpuSnapshotFrameSinkSnapshot {
  readonly inputs: number;
  readonly snapshots: number;
  readonly writesCompleted: number;
  readonly sourceSettled: number;
  readonly totalSnapshotMs: number;
  readonly maxSnapshotMs: number;
  readonly totalWriteMs: number;
  readonly maxWriteMs: number;
  readonly pendingInputs: 0 | 1;
  readonly writeActive: boolean;
  readonly stopped: boolean;
  readonly failureCode: NativeGpuSnapshotFrameFailureCode | null;
}

export interface NativeGpuSnapshotFrameSinkOptions {
  width: number;
  height: number;
  fps: number;
  writer: { write(frame: VideoFrame): Promise<void> };
  now?(): number;
  onWritten?(writeMs: number, queueAgeMs: number): void;
  onDropped?(reason: NativeGpuSnapshotFrameDropReason): void;
  onFailure?(error: unknown): void;
  createPlatform?(width: number, height: number): NativeGpuSnapshotFramePlatform;
  setTimer?(callback: () => void, milliseconds: number): unknown;
  clearTimer?(handle: unknown): void;
}

function createBrowserPlatform(width: number, height: number): NativeGpuSnapshotFramePlatform {
  if (typeof OffscreenCanvas !== 'function' || typeof VideoFrame !== 'function')
    throw new NativeGpuSnapshotFrameSinkError('setup_failed');
  const canvas = new OffscreenCanvas(width, height);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true; canvas.width = canvas.height = 0;
  };
  try {
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: false, colorSpace: 'srgb' });
    if (!context) throw new NativeGpuSnapshotFrameSinkError('setup_failed');
    const attributes = (context as OffscreenCanvasRenderingContext2D & {
      getContextAttributes?(): CanvasRenderingContext2DSettings;
    }).getContextAttributes?.();
    if (!attributes || attributes.alpha !== false || attributes.willReadFrequently !== false || attributes.colorSpace !== 'srgb')
      throw new NativeGpuSnapshotFrameSinkError('setup_failed');
    return {
      snapshot(input, timestamp) {
        if (disposed) throw new NativeGpuSnapshotFrameSinkError('snapshot_failed');
        context.drawImage(input, 0, 0, width, height);
        return new VideoFrame(canvas, { timestamp });
      },
      dispose,
    };
  } catch {
    dispose();
    throw new NativeGpuSnapshotFrameSinkError('setup_failed');
  }
}

interface Input {
  frame: VideoFrame;
  timestamp: number;
  queuedAt: number;
  settled: boolean;
  resolve(result: NativeGpuSnapshotFrameResult): void;
}
interface Operation {
  source?: Input;
  output?: VideoFrame;
  outputClosed: boolean;
  deadlineAt: number;
  queueAgeMs: number;
  writeStartedAt: number;
}
const COMPLETION_TIMEOUT_MS = 1_500;
const RGB_FORMATS: ReadonlySet<unknown> = new Set(['RGBA', 'RGBX', 'BGRA', 'BGRX', null]);

/**
 * Opt-in canvas-owned bitmap snapshots. One write is active and only the latest
 * original input may wait. The caller owns every source frame; its submit result
 * settles after the real draw/snapshot or discard, independently of writer time.
 * The sink owns snapshot handles until real write settlement, including at stop.
 * Electron's allReferencesReleased remains the only native texture reuse barrier.
 * Neither JS bounds nor write settlement prove a bound on browser GPU resources.
 */
export function createNativeGpuSnapshotFrameSink(options: NativeGpuSnapshotFrameSinkOptions) {
  if (!Number.isSafeInteger(options.width) || !Number.isSafeInteger(options.height) ||
      options.width < 2 || options.height < 2 || options.width > 4096 || options.height > 2560 ||
      !Number.isFinite(options.fps) || options.fps <= 0 || options.fps > 120)
    throw new RangeError('Invalid GPU snapshot dimensions or rate');
  const platform = (options.createPlatform ?? createBrowserPlatform)(options.width, options.height);
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const maxPendingAgeMs = 2 * 1000 / options.fps;
  let stopped = false;
  let pending: Input | undefined;
  let active: Operation | undefined;
  let timer: unknown;
  let lastTimestamp = -1;
  let failureCode: NativeGpuSnapshotFrameFailureCode | null = null;
  const counts = { inputs: 0, snapshots: 0, writesCompleted: 0, sourceSettled: 0,
    totalSnapshotMs: 0, maxSnapshotMs: 0, totalWriteMs: 0, maxWriteMs: 0 };

  function settle(input: Input, result: NativeGpuSnapshotFrameResult): void {
    if (input.settled) return;
    input.settled = true; counts.sourceSettled++; input.resolve(result);
  }
  function clearDeadline(): void {
    if (timer !== undefined) { try { clearTimer(timer); } catch { /* A late callback still checks its operation. */ } }
    timer = undefined;
  }
  function closeOutput(operation: Operation): void {
    if (operation.outputClosed || !operation.output) return;
    operation.outputClosed = true;
    try { operation.output.close(); } catch { /* All other owned resources still retire. */ }
    operation.output = undefined;
  }
  function stop(): void {
    if (stopped) return;
    stopped = true; clearDeadline();
    if (pending) settle(pending, 'stopped');
    pending = undefined;
    if (active?.source) settle(active.source, 'stopped');
    // An in-flight writer retains its output until its actual settlement.
    active = undefined;
    try { platform.dispose(); } catch { /* Source callbacks have already settled. */ }
  }
  function fail(error: unknown, fallback: NativeGpuSnapshotFrameFailureCode): void {
    if (stopped) return;
    const known = getNativeGpuSnapshotFrameFailureCode(error);
    failureCode = known === 'unknown' ? fallback : known;
    stop();
    try { options.onFailure?.(new NativeGpuSnapshotFrameSinkError(failureCode)); }
    catch { /* A reporter cannot revive capture or leak a callback. */ }
  }
  function drop(input: Input, reason: NativeGpuSnapshotFrameDropReason): void {
    settle(input, reason);
    try { options.onDropped?.(reason); } catch (error) { fail(error, 'callback_failed'); }
  }
  function validGeometry(frame: VideoFrame): boolean {
    return frame.codedWidth === options.width && frame.codedHeight === options.height &&
      frame.displayWidth === options.width && frame.displayHeight === options.height;
  }
  function drain(): void {
    if (stopped || active || !pending) return;
    const input = pending; pending = undefined;
    const queueAgeMs = Math.max(0, now() - input.queuedAt);
    if (queueAgeMs > maxPendingAgeMs) { drop(input, 'expired'); drain(); return; }
    const startedAt = now();
    const operation: Operation = { source: input, outputClosed: false,
      deadlineAt: startedAt + COMPLETION_TIMEOUT_MS, queueAgeMs, writeStartedAt: 0 };
    active = operation;
    let output: VideoFrame | undefined;
    try {
      output = platform.snapshot(input.frame, input.timestamp);
      // A platform must return a distinct snapshot handle. Never close a
      // malformed alias, because the caller still owns the original input.
      if (output !== input.frame) operation.output = output;
      if (stopped || active !== operation) {
        closeOutput(operation); settle(input, 'stopped'); return;
      }
      if (!output || output === input.frame || !validGeometry(output) ||
          output.timestamp !== input.timestamp || !RGB_FORMATS.has(output.format))
        throw new NativeGpuSnapshotFrameSinkError('output_contract');
      const snapshotMs = Math.max(0, now() - startedAt);
      if (snapshotMs >= COMPLETION_TIMEOUT_MS) throw new NativeGpuSnapshotFrameSinkError('snapshot_timeout');
      counts.snapshots++; counts.totalSnapshotMs += snapshotMs;
      counts.maxSnapshotMs = Math.max(counts.maxSnapshotMs, snapshotMs);
      // Resolve the native listener only after the snapshot exists. It does
      // not grant a native slot credit or claim the GPU read has completed.
      settle(input, 'snapshotted'); operation.source = undefined;
      operation.writeStartedAt = now();
      if (operation.writeStartedAt >= operation.deadlineAt)
        throw new NativeGpuSnapshotFrameSinkError('write_timeout');
      timer = setTimer(() => {
        if (!stopped && active === operation) fail(undefined, 'write_timeout');
      }, Math.max(0, operation.deadlineAt - operation.writeStartedAt));
      if (stopped || active !== operation) { clearDeadline(); closeOutput(operation); return; }
      if (now() >= operation.deadlineAt) throw new NativeGpuSnapshotFrameSinkError('write_timeout');
      let written: Promise<void>;
      try { written = options.writer.write(output); }
      catch (error) { closeOutput(operation); fail(error, 'write_failed'); return; }
      // Both reactions are always installed. Stop/timeout cannot replace real
      // write settlement, and a late rejection cannot become unhandled.
      void Promise.resolve(written).then(() => {
        closeOutput(operation);
        if (stopped || active !== operation) return;
        clearDeadline();
        const writeMs = Math.max(0, now() - operation.writeStartedAt);
        counts.writesCompleted++; counts.totalWriteMs += writeMs;
        counts.maxWriteMs = Math.max(counts.maxWriteMs, writeMs);
        try { options.onWritten?.(writeMs, operation.queueAgeMs); }
        catch (error) { fail(error, 'callback_failed'); return; }
        // Keep active during the callback so reentrant input stays bounded.
        if (stopped || active !== operation) return;
        active = undefined; drain();
      }, error => {
        closeOutput(operation);
        if (!stopped && active === operation) fail(error, 'write_failed');
      }).catch(error => { fail(error, 'callback_failed'); });
    } catch (error) {
      closeOutput(operation); settle(input, 'stopped'); fail(error, 'snapshot_failed');
    }
  }
  function submit(frame: VideoFrame, timestamp: number): Promise<NativeGpuSnapshotFrameResult> {
    if (stopped) return Promise.resolve('stopped');
    let resolve!: Input['resolve'];
    const result = new Promise<NativeGpuSnapshotFrameResult>(res => { resolve = res; });
    const input: Input = { frame, timestamp, queuedAt: now(), settled: false, resolve };
    counts.inputs++;
    try {
      if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp < lastTimestamp ||
          frame.timestamp !== timestamp || !validGeometry(frame))
        throw new NativeGpuSnapshotFrameSinkError('input_contract');
      lastTimestamp = timestamp;
      const previous = pending; pending = input;
      if (previous) drop(previous, 'superseded');
      drain();
    } catch (error) { settle(input, 'stopped'); fail(error, 'input_contract'); }
    return result;
  }
  function snapshot(): NativeGpuSnapshotFrameSinkSnapshot {
    return Object.freeze({ ...counts, pendingInputs: stopped || !pending ? 0 : 1,
      writeActive: !stopped && active !== undefined, stopped, failureCode });
  }
  return { submit, stop, snapshot };
}
