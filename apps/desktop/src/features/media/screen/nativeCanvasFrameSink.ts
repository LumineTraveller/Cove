export type NativeCanvasFrameResult = 'drawn' | 'superseded' | 'expired' | 'stopped';
export type NativeCanvasFrameDropReason = 'superseded' | 'expired';
export type NativeCanvasFrameFailureCode =
  'prime_timeout' | 'capture_timeout' | 'copy_timeout' | 'write_timeout' |
  'copy_failed' | 'write_failed' | 'input_contract' | 'output_contract' |
  'unexpected_output' | 'reader_failed' | 'setup_failed' | 'callback_failed' | 'capture_failed';
export type NativeCanvasFramePhase = 'prime' | 'capture' | 'copy' | 'write' | 'idle' | 'stopped';
export interface NativeCanvasFrameSinkSnapshot {
  readonly phase: NativeCanvasFramePhase;
  readonly inputs: number;
  /** Calls to the synchronous draw boundary, including a call which throws. */
  readonly draws: number;
  readonly totalDrawMs: number;
  readonly maxDrawMs: number;
  /** Total deliveries, including a packet already in flight when stop runs. */
  readonly rawOutputs: number;
  readonly primedOutputs: number;
  readonly duplicateOutputs: number;
  readonly regressedOutputs: number;
  readonly capturesCompleted: number;
  /** Draw invocation to accepted fresh output delivery; excludes the prime. */
  readonly totalCaptureMs: number;
  readonly maxCaptureMs: number;
  /** Successful preparation/write settlement while the operation is still live. */
  readonly copiesCompleted: number;
  /** Successful live preparation wall time, including CPU frame construction. */
  readonly totalCopyMs: number;
  readonly maxCopyMs: number;
  readonly writesCompleted: number;
  readonly admissionDeferrals: number;
  /** Dispatch-to-reader-delivery gap; a dispatch may still discard an aged input. */
  readonly minObservedAdmissionGapMs: number | null;
  readonly pendingInputs: 0 | 1;
  readonly admissionTaskPending: boolean;
  readonly failureCode: NativeCanvasFrameFailureCode | null;
  readonly failurePhase: NativeCanvasFramePhase | null;
}
const FAILURE_CODES: ReadonlySet<unknown> = new Set<NativeCanvasFrameFailureCode>([
  'prime_timeout', 'capture_timeout', 'copy_timeout', 'write_timeout', 'copy_failed', 'write_failed',
  'input_contract', 'output_contract', 'unexpected_output', 'reader_failed', 'setup_failed',
  'callback_failed', 'capture_failed',
]);

export class NativeCanvasFrameSinkError extends Error {
  constructor(readonly code: NativeCanvasFrameFailureCode) {
    super(code);
    this.name = 'NativeCanvasFrameSinkError';
  }
}

/** Only fixed codes are safe for diagnostics; never expose a raw DOM error message. */
export function getNativeCanvasFrameFailureCode(error: unknown): NativeCanvasFrameFailureCode | 'unknown' {
  return error instanceof NativeCanvasFrameSinkError && FAILURE_CODES.has(error.code) ? error.code : 'unknown';
}

function failure(error: unknown, fallback: NativeCanvasFrameFailureCode): NativeCanvasFrameSinkError {
  const code = getNativeCanvasFrameFailureCode(error);
  return new NativeCanvasFrameSinkError(code === 'unknown' ? fallback : code);
}

/** The private Canvas track must have no sink other than this reader. */
export interface NativeCanvasFrameSinkPlatform {
  reader: Pick<ReadableStreamDefaultReader<VideoFrame>, 'read' | 'cancel' | 'releaseLock'>;
  /** requestFrame() and the black draw occur in the same synchronous task. */
  prime(): void;
  /** requestFrame() precedes drawImage(); this call must not retain the input. */
  draw(frame: VideoFrame): void;
  /** Real copy settlement precedes construction. null means disposed during copy. */
  prepare(frame: VideoFrame, timestamp: number): Promise<VideoFrame | null>;
  /** One asynchronous task, never a microtask or a recurring frame timer. */
  schedule(task: () => void): () => void;
  /** Browser-only asynchronous scheduler faults terminate the owning sink. */
  setFailureHandler?(handler: (error: unknown) => void): void;
  admissionSnapshot?(): Readonly<{ deferrals: number; minObservedGapMs: number | null }>;
  /** Stop owned tracks and remove the Canvas. Does not touch the caller's writer. */
  dispose(): void;
}

export interface NativeCanvasFrameSinkOptions {
  width: number;
  height: number;
  fps: number;
  writer: { write(frame: VideoFrame): Promise<void> };
  now?(): number;
  onWritten?(writeMs: number, queueAgeMs: number): void;
  onDropped?(reason: NativeCanvasFrameDropReason): void;
  onFailure?(error: unknown): void;
  /** CPU tests can substitute the small browser boundary without global DOM mocks. */
  createPlatform?(width: number, height: number): NativeCanvasFrameSinkPlatform;
}

interface Input {
  frame: VideoFrame;
  timestamp: number;
  queuedAt: number;
  resolve(result: NativeCanvasFrameResult): void;
}

interface Active {
  timestamp: number;
  queueAgeMs: number;
  phase: 'capture' | 'copy' | 'write';
  drawStartedAt: number;
}

type ProcessorConstructor = new (options: { track: MediaStreamTrack; maxBufferSize: number }) => {
  readable: ReadableStream<VideoFrame>;
};

const COMPLETION_TIMEOUT_MS = 1_500;
const MAX_COPY_BYTES = 16 * 1024 * 1024;
const CANVAS_MIN_ADMISSION_GAP_MS = 2;

/**
 * Chromium 152's on-request listener inherits the automatic listener's 1 ms
 * minimum gap from its last capture callback. A too-early draw has no retry.
 * Reader delivery happens after that callback; wait 2 ms from this observable
 * boundary, spending only an already queued admission. Every draw still runs
 * in a MessageChannel task, including after a one-shot delay.
 */
export function createNativeCanvasAdmissionScheduler(options: {
  now(): number;
  postTask(id: number): void;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(id: number): void;
  onFailure(error: NativeCanvasFrameSinkError): void;
}) {
  let stopped = false;
  let notBefore = -Infinity;
  let nextId = 0;
  let scheduled: { id: number; task(): void } | undefined;
  let taskPosted = false;
  let timer: number | undefined;
  let timerGeneration = 0;
  let deferrals = 0;
  let minObservedGapMs: number | null = null;

  function clearTimer(): void {
    timerGeneration++;
    if (timer !== undefined) {
      try { options.clearTimer(timer); } catch { /* Generations still retire a late wake. */ }
    }
    timer = undefined;
  }

  function postTask(id: number): void {
    taskPosted = true;
    options.postTask(id);
  }

  function delay(id: number, waitMs: number): void {
    const generation = ++timerGeneration;
    timer = options.setTimer(() => {
      if (stopped || scheduled?.id !== id || generation !== timerGeneration) return;
      timerGeneration++;
      timer = undefined;
      // Recheck and any re-arm happen in a MessageChannel task. This avoids
      // nesting timers when the clock fires early or another output moves it.
      try { postTask(id); } catch { reportFailure(); }
    }, Math.ceil(waitMs));
  }

  function dispatch(id: unknown): void {
    const current = scheduled;
    if (stopped || !current || current.id !== id || !taskPosted) return;
    taskPosted = false;
    try {
      const currentTime = options.now();
      const remainingMs = notBefore - currentTime;
      if (remainingMs > 0) {
        deferrals++;
        delay(current.id, remainingMs);
        return;
      }
      if (Number.isFinite(notBefore)) {
        const gapMs = Math.max(0, currentTime - notBefore + CANVAS_MIN_ADMISSION_GAP_MS);
        minObservedGapMs = Math.min(minObservedGapMs ?? Infinity, gapMs);
      }
      scheduled = undefined;
      current.task();
    } catch {
      reportFailure();
    }
  }

  function schedule(task: () => void): () => void {
    if (stopped || scheduled) throw new NativeCanvasFrameSinkError('capture_failed');
    const id = ++nextId;
    scheduled = { id, task };
    try { postTask(id); }
    catch {
      stop();
      throw new NativeCanvasFrameSinkError('capture_failed');
    }
    return () => {
      if (scheduled?.id !== id) return;
      scheduled = undefined;
      taskPosted = false;
      clearTimer();
    };
  }

  function noteOutput(): void {
    if (!stopped) notBefore = options.now() + CANVAS_MIN_ADMISSION_GAP_MS;
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    scheduled = undefined;
    taskPosted = false;
    clearTimer();
  }

  function reportFailure(): void {
    if (stopped) return;
    stop();
    try { options.onFailure(new NativeCanvasFrameSinkError('capture_failed')); }
    catch { /* The scheduler is already retired. */ }
  }

  function snapshot() { return Object.freeze({ deferrals, minObservedGapMs }); }

  return { schedule, dispatch, noteOutput, stop, snapshot };
}

function closeFrame(frame: VideoFrame): void {
  try { frame.close(); } catch { /* Continue releasing the other owned references. */ }
}

function validateLayout(layout: PlaneLayout[], width: number, height: number, bytes: number): void {
  if (!Array.isArray(layout) || layout.length !== 2) throw new NativeCanvasFrameSinkError('output_contract');
  const ranges = layout.map((plane, index) => {
    if (!plane || !Number.isSafeInteger(plane.offset) || plane.offset < 0 ||
        !Number.isSafeInteger(plane.stride) || plane.stride < width)
      throw new NativeCanvasFrameSinkError('output_contract');
    const rows = index === 0 ? height : height / 2;
    const end = plane.offset + plane.stride * (rows - 1) + width;
    if (!Number.isSafeInteger(end) || end > bytes) throw new NativeCanvasFrameSinkError('output_contract');
    return { start: plane.offset, end };
  });
  if (ranges[0].start < ranges[1].end && ranges[1].start < ranges[0].end)
    throw new NativeCanvasFrameSinkError('output_contract');
}

/**
 * One ordinary reusable AB plus the constructor's CPU pixel copy. No transfer or
 * zero-copy claim. The caller owns the source frame through prepare settlement.
 * This small boundary also permits direct CPU tests without a synthetic DOM.
 */
export function createNativeCanvasCpuFramePreparer(
  width: number,
  height: number,
  createFrame: (buffer: ArrayBuffer, init: VideoFrameBufferInit) => VideoFrame =
    (buffer, init) => new VideoFrame(buffer, init),
) {
  const minimumBytes = width * height * 1.5;
  if (!Number.isSafeInteger(width) || width < 2 || width % 2 !== 0 ||
      !Number.isSafeInteger(height) || height < 2 || height % 2 !== 0 ||
      !Number.isSafeInteger(minimumBytes) || minimumBytes > MAX_COPY_BYTES)
    throw new RangeError('Invalid Canvas copy dimensions');
  const maximumBytes = Math.min(MAX_COPY_BYTES, width * height * 4);
  let buffer: ArrayBuffer | undefined;
  let copying = false;
  let disposed = false;
  function erase(): void {
    if (buffer) new Uint8Array(buffer).fill(0);
    buffer = undefined;
  }
  function dispose(): void {
    disposed = true;
    // copyTo still owns its destination until the actual promise settles.
    if (!copying) erase();
  }
  async function prepare(frame: VideoFrame, timestamp: number): Promise<VideoFrame | null> {
    if (disposed) return null;
    if (copying) throw new NativeCanvasFrameSinkError('copy_failed');
    copying = true;
    try {
      if (!Number.isSafeInteger(timestamp) || timestamp < 0)
        throw new NativeCanvasFrameSinkError('input_contract');
      const color = frame.colorSpace;
      if (frame.format !== 'NV12' || frame.codedWidth !== width || frame.codedHeight !== height ||
          frame.displayWidth !== width || frame.displayHeight !== height || color.primaries !== 'bt709' ||
          color.transfer !== 'bt709' || color.matrix !== 'bt709' || color.fullRange !== false)
        throw new NativeCanvasFrameSinkError('output_contract');
      const bytes = frame.allocationSize();
      if (!Number.isSafeInteger(bytes) || bytes < minimumBytes || bytes > maximumBytes)
        throw new NativeCanvasFrameSinkError('output_contract');
      if (!buffer || buffer.byteLength !== bytes) {
        erase();
        buffer = new ArrayBuffer(bytes);
      }
      // Preserve the actual NV12 plane layout: no copyTo format conversion.
      const layout = await frame.copyTo(buffer);
      if (disposed) return null;
      validateLayout(layout, width, height, bytes);
      // Buffer constructor establishes the native media timestamp as well as
      // the JS handle timestamp; cloning a Canvas frame does not establish both.
      const prepared = createFrame(buffer, {
        format: 'NV12', codedWidth: width, codedHeight: height,
        displayWidth: width, displayHeight: height, timestamp, layout,
        colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
      });
      if (disposed) { closeFrame(prepared); return null; }
      return prepared;
    } catch (error) { throw failure(error, 'copy_failed'); }
    finally {
      copying = false;
      if (disposed) erase();
    }
  }
  return { prepare, dispose };
}

function createBrowserPlatform(width: number, height: number): NativeCanvasFrameSinkPlatform {
  const Processor = (globalThis as typeof globalThis & {
    MediaStreamTrackProcessor?: ProcessorConstructor;
  }).MediaStreamTrackProcessor;
  if (typeof document === 'undefined' || !Processor || typeof VideoFrame !== 'function')
    throw new NativeCanvasFrameSinkError('setup_failed');

  const canvas = document.createElement('canvas');
  const preparer = createNativeCanvasCpuFramePreparer(width, height);
  let stream: MediaStream | undefined;
  let channel: MessageChannel | undefined;
  let admission: ReturnType<typeof createNativeCanvasAdmissionScheduler> | undefined;
  let failureHandler: ((error: unknown) => void) | undefined;
  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    preparer.dispose();
    admission?.stop();
    failureHandler = undefined;
    channel?.port1.close();
    channel?.port2.close();
    for (const track of stream?.getTracks() ?? []) {
      try { track.stop(); } catch { /* Retire the remaining owned resources. */ }
    }
    canvas.remove();
    canvas.width = canvas.height = 0;
  }
  try {
    canvas.width = width;
    canvas.height = height;
    // No video element, animation timer, DOM visibility or rAF dependency.
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
    if (!context) throw new Error('Canvas context unavailable');
    const attributes = context.getContextAttributes();
    if (attributes.alpha !== false || attributes.willReadFrequently !== false)
      throw new Error('Canvas context attributes mismatch');
    stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
    if (!track || typeof track.requestFrame !== 'function') throw new Error('Canvas requestFrame unavailable');
    track.contentHint = 'detail';
    channel = new MessageChannel();
    const scheduler = createNativeCanvasAdmissionScheduler({
      now: () => performance.now(),
      postTask: id => channel!.port2.postMessage(id),
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: id => window.clearTimeout(id),
      onFailure: error => failureHandler?.(error),
    });
    admission = scheduler;
    channel.port1.onmessage = event => scheduler.dispatch(event.data);
    const reader = new Processor({ track, maxBufferSize: 1 }).readable.getReader();
    return {
      reader: {
        read() {
          return reader.read().then(packet => {
            if (!packet.done) scheduler.noteOutput();
            return packet;
          });
        },
        cancel: reason => reader.cancel(reason),
        releaseLock: () => reader.releaseLock(),
      },
      prime() {
        track.requestFrame();
        context.fillStyle = '#000000';
        context.fillRect(0, 0, width, height);
      },
      draw(frame) { track.requestFrame(); context.drawImage(frame, 0, 0, width, height); },
      prepare: preparer.prepare,
      schedule: scheduler.schedule,
      setFailureHandler(handler) { failureHandler = handler; },
      admissionSnapshot: scheduler.snapshot,
      dispose,
    };
  } catch (error) {
    dispose();
    throw failure(error, 'setup_failed');
  }
}

/**
 * Experimental pinned-Chromium Canvas conversion route. One explicit
 * request/draw produces at most one new capture timestamp in the pinned runtime;
 * this is not a general public Canvas pending-work guarantee. Prime consumes
 * the initial refresh before native admission, and the Canvas track never escapes.
 * Runtime qualification must separately establish downstream ownership/throughput.
 *
 * submit() never owns or closes its input. A 'drawn' result lets the caller close
 * it immediately after drawImage(). The Canvas frame survives the real CPU copy,
 * then closes before writer.write; only the independent CPU frame survives write.
 */
export function createNativeCanvasFrameSink(options: NativeCanvasFrameSinkOptions) {
  if (!Number.isSafeInteger(options.width) || options.width < 2 || options.width % 2 !== 0 ||
      !Number.isSafeInteger(options.height) || options.height < 2 || options.height % 2 !== 0 ||
      options.width * options.height * 1.5 > MAX_COPY_BYTES ||
      !Number.isFinite(options.fps) || options.fps <= 0)
    throw new RangeError('Invalid Canvas frame dimensions or rate');

  const platform = (options.createPlatform ?? createBrowserPlatform)(options.width, options.height);
  const now = options.now ?? (() => performance.now());
  const maxPendingAgeMs = 2 * 1000 / options.fps;
  let stopped = false;
  let primed = false;
  let lastOutputTimestamp = -1;
  let pending: Input | undefined;
  // Only metadata remains here after the synchronous draw, never its GPU input.
  let active: Active | undefined;
  let cancelAdmission: (() => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const counts = {
    inputs: 0, draws: 0, rawOutputs: 0, primedOutputs: 0, duplicateOutputs: 0,
    regressedOutputs: 0, copiesCompleted: 0, writesCompleted: 0,
    totalDrawMs: 0, maxDrawMs: 0, capturesCompleted: 0, totalCaptureMs: 0,
    maxCaptureMs: 0, totalCopyMs: 0, maxCopyMs: 0,
  };
  let failureCode: NativeCanvasFrameFailureCode | null = null;
  let failurePhase: NativeCanvasFramePhase | null = null;
  let resolveReady!: (ready: boolean) => void;
  const ready = new Promise<boolean>(resolve => { resolveReady = resolve; });

  function phase(): NativeCanvasFramePhase {
    return stopped ? 'stopped' : !primed ? 'prime' : active?.phase ?? 'idle';
  }

  /** Flat, detached, bounded metadata only; no source identifiers or frame content. */
  function snapshot(): NativeCanvasFrameSinkSnapshot {
    const admissionStats = platform.admissionSnapshot?.();
    return Object.freeze<NativeCanvasFrameSinkSnapshot>({
      phase: phase(), ...counts,
      admissionDeferrals: admissionStats?.deferrals ?? 0,
      minObservedAdmissionGapMs: admissionStats?.minObservedGapMs ?? null,
      pendingInputs: stopped || !pending ? 0 : 1,
      admissionTaskPending: !stopped && cancelAdmission !== undefined,
      failureCode, failurePhase,
    });
  }

  function clearDeadline(): void {
    if (deadline !== undefined) clearTimeout(deadline);
    deadline = undefined;
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearDeadline();
    try { cancelAdmission?.(); } catch { /* Continue settling inputs and owned resources. */ }
    cancelAdmission = undefined;
    resolveReady(false);
    pending?.resolve('stopped');
    pending = undefined;
    active = undefined;
    // Cancellation retires future reads. Real copy/write settlement still owns
    // its source/destination references, even after this lifecycle has stopped.
    try {
      void Promise.resolve(platform.reader.cancel()).catch(() => {}).finally(() => {
        try { platform.reader.releaseLock(); } catch { /* A late read may still be retiring. */ }
      });
    } catch { /* dispose still stops the track if cancellation failed. */ }
    try { platform.dispose(); } catch { /* All submissions are already settled. */ }
  }

  function fail(error: unknown, fallback: NativeCanvasFrameFailureCode): void {
    if (stopped) return;
    const diagnostic = failure(error, fallback);
    failureCode = diagnostic.code;
    failurePhase = phase();
    stop();
    try { options.onFailure?.(diagnostic); } catch { /* Fault reporting cannot revive the sink. */ }
  }

  function armDeadline(): void {
    clearDeadline();
    deadline = setTimeout(() => {
      const code = !primed ? 'prime_timeout' : active?.phase === 'copy' ? 'copy_timeout' :
        active?.phase === 'write' ? 'write_timeout' : 'capture_timeout';
      fail(undefined, code);
    }, COMPLETION_TIMEOUT_MS);
  }

  function drop(input: Input, reason: NativeCanvasFrameDropReason): void {
    input.resolve(reason);
    try { options.onDropped?.(reason); } catch (error) { fail(error, 'callback_failed'); }
  }

  function drain(): void {
    if (stopped || !primed || active || !pending) return;
    const input = pending;
    pending = undefined;
    const queueAgeMs = Math.max(0, now() - input.queuedAt);
    if (queueAgeMs > maxPendingAgeMs) {
      drop(input, 'expired');
      scheduleDrain();
      return;
    }
    const operation: Active = { timestamp: input.timestamp, queueAgeMs, phase: 'capture', drawStartedAt: now() };
    active = operation;
    armDeadline();
    const drawStartedAt = now();
    operation.drawStartedAt = drawStartedAt;
    try {
      counts.draws++;
      try { platform.draw(input.frame); }
      finally {
        const drawMs = Math.max(0, now() - drawStartedAt);
        counts.totalDrawMs += drawMs;
        counts.maxDrawMs = Math.max(counts.maxDrawMs, drawMs);
      }
      input.resolve(stopped ? 'stopped' : 'drawn');
    } catch (error) {
      input.resolve('stopped');
      fail(error, 'capture_failed');
    }
  }

  function scheduleDrain(): void {
    if (stopped || !primed || active || !pending || cancelAdmission) return;
    try {
      cancelAdmission = platform.schedule(() => {
        cancelAdmission = undefined;
        drain();
      });
    } catch (error) { fail(error, 'capture_failed'); }
  }

  function validGeometry(frame: VideoFrame): boolean {
    return frame.codedWidth === options.width && frame.codedHeight === options.height &&
      frame.displayWidth === options.width && frame.displayHeight === options.height;
  }

  async function prepareAndWrite(output: VideoFrame, operation: Active): Promise<void> {
    let prepared: VideoFrame | null = null;
    let outputClosed = false;
    let wrote = false;
    let startedAt = 0;
    try {
      const copyStartedAt = now();
      prepared = await platform.prepare(output, operation.timestamp);
      const copyMs = Math.max(0, now() - copyStartedAt);
      // This releases the shared Canvas image before the generator can retain
      // anything. A CPU buffer constructor, rather than a clone, isolates it.
      closeFrame(output);
      outputClosed = true;
      if (stopped || active !== operation) return;
      if (!prepared) throw new NativeCanvasFrameSinkError('copy_failed');
      const color = prepared.colorSpace;
      if (prepared.format !== 'NV12' || !validGeometry(prepared) || prepared.timestamp !== operation.timestamp ||
          color.primaries !== 'bt709' || color.transfer !== 'bt709' || color.matrix !== 'bt709' || color.fullRange !== false)
        throw new NativeCanvasFrameSinkError('output_contract');
      counts.copiesCompleted++;
      counts.totalCopyMs += copyMs;
      counts.maxCopyMs = Math.max(counts.maxCopyMs, copyMs);
      operation.phase = 'write';
      startedAt = now();
      // No timeout race: retain the CPU frame until this actual write settles.
      await options.writer.write(prepared);
      wrote = true;
      if (!stopped && active === operation) counts.writesCompleted++;
    } catch (error) {
      fail(error, operation.phase === 'write' ? 'write_failed' : 'copy_failed');
    } finally {
      if (!outputClosed) closeFrame(output);
      if (prepared) closeFrame(prepared);
    }
    if (!wrote || stopped || active !== operation) return;
    clearDeadline();
    try { options.onWritten?.(Math.max(0, now() - startedAt), operation.queueAgeMs); }
    catch (error) { fail(error, 'callback_failed'); return; }
    // Reentrant submissions during onWritten stay behind this operation.
    if (stopped || active !== operation) return;
    active = undefined;
    scheduleDrain();
  }

  function acceptOutput(output: VideoFrame): void {
    // Delivery is a total count, including a packet already in flight at stop.
    counts.rawOutputs++;
    const receivedAt = now();
    let copying = false;
    try {
      if (stopped) return;
      const color = output.colorSpace;
      if (output.format !== 'NV12' || !validGeometry(output) ||
          color.primaries !== 'bt709' || color.transfer !== 'bt709' ||
          color.matrix !== 'bt709' || color.fullRange !== false ||
          !Number.isSafeInteger(output.timestamp) || output.timestamp < 0)
        throw new NativeCanvasFrameSinkError('output_contract');
      if (stopped) return;
      if (!primed) {
        counts.primedOutputs++;
        primed = true;
        lastOutputTimestamp = output.timestamp;
        clearDeadline();
        resolveReady(true);
        return;
      }
      // Initial/refresh/old timestamps never release an admission or start a write.
      if (output.timestamp <= lastOutputTimestamp) {
        if (output.timestamp === lastOutputTimestamp) counts.duplicateOutputs++;
        else counts.regressedOutputs++;
        return;
      }
      const operation = active;
      if (!operation || operation.phase !== 'capture')
        throw new NativeCanvasFrameSinkError('unexpected_output');
      lastOutputTimestamp = output.timestamp;
      const captureMs = Math.max(0, receivedAt - operation.drawStartedAt);
      counts.capturesCompleted++;
      counts.totalCaptureMs += captureMs;
      counts.maxCaptureMs = Math.max(counts.maxCaptureMs, captureMs);
      operation.phase = 'copy';
      copying = true;
      void prepareAndWrite(output, operation);
    } catch (error) {
      fail(error, 'output_contract');
    } finally {
      if (!copying) closeFrame(output);
    }
  }

  async function readOutputs(): Promise<void> {
    try {
      while (!stopped) {
        const packet = await platform.reader.read();
        if (packet.done) {
          if (!stopped) fail(undefined, 'reader_failed');
          return;
        }
        acceptOutput(packet.value);
        // Prime/output disposal completes before another native draw is admitted.
        scheduleDrain();
      }
    } catch (error) { fail(error, 'reader_failed'); }
  }

  function submit(frame: VideoFrame, metadataTimestamp: number): Promise<NativeCanvasFrameResult> {
    if (stopped) return Promise.resolve('stopped');
    counts.inputs++;
    try {
      const color = frame.colorSpace;
      if (!Number.isSafeInteger(metadataTimestamp) || metadataTimestamp < 0 ||
          frame.timestamp !== metadataTimestamp || frame.format !== 'BGRA' || !validGeometry(frame) ||
          color.primaries !== 'bt709' || color.transfer !== 'iec61966-2-1' ||
          color.matrix !== 'rgb' || color.fullRange !== true)
        throw new NativeCanvasFrameSinkError('input_contract');
    } catch (error) {
      fail(error, 'input_contract');
      return Promise.resolve('stopped');
    }
    let resolve!: Input['resolve'];
    const result = new Promise<NativeCanvasFrameResult>(res => { resolve = res; });
    const previous = pending;
    pending = { frame, timestamp: metadataTimestamp, queuedAt: now(), resolve };
    if (previous) drop(previous, 'superseded');
    scheduleDrain();
    return result;
  }

  // Setup, Processor attachment and prime all share the creating task. Do not
  // yield until prime has coalesced the track's initial automatic refresh.
  try {
    platform.setFailureHandler?.(error => fail(error, 'capture_failed'));
    if (!stopped) {
      armDeadline();
      void readOutputs();
      platform.prime();
    }
  } catch (error) { fail(error, 'setup_failed'); }
  return { ready, submit, stop, snapshot };
}
