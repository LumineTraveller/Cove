import { createNativeFrameWriteQueue } from './nativeFrameWriteQueue';
import {
  NATIVE_WORKER_MAX_PENDING,
  isNativeWorkerGeneration,
  isNativeWorkerSequence,
  type NativeFrameWorkerEvent,
  type NativeFrameWorkerFailure,
  type NativeFrameWorkerTiming,
} from './nativeFrameWorkerProtocol';

/** Only handle metadata and ownership here; never read, copy or reconstruct pixels. */
export interface NativeFrameWorkerFrame {
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly timestamp: number | null;
  close(): void;
}

export interface NativeFrameWorkerRuntimeOptions<T extends NativeFrameWorkerFrame> {
  now(): number;
  isFrame(value: unknown): value is T;
  post(event: NativeFrameWorkerEvent): void;
}

interface Writer<T> {
  write(frame: T): PromiseLike<void> | void;
  abort(): PromiseLike<void> | void;
  releaseLock(): void;
}

interface FrameEntry<T> {
  frame: T;
  sequence: number;
  idleMs: number;
  timing?: NativeFrameWorkerTiming;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function acquireWriter<T>(value: unknown): Writer<T> {
  if (!record(value) || typeof value.getWriter !== 'function') throw new TypeError();
  const writer: unknown = value.getWriter();
  if (!record(writer) || typeof writer.write !== 'function' ||
      typeof writer.abort !== 'function' || typeof writer.releaseLock !== 'function') throw new TypeError();
  return writer as unknown as Writer<T>;
}

/** Every runtime is single-use, including when init fails or stop precedes init. */
export function createNativeFrameWorkerRuntime<T extends NativeFrameWorkerFrame>(
  options: NativeFrameWorkerRuntimeOptions<T>,
) {
  let phase: 'new' | 'running' | 'stopping' | 'stopped' = 'new';
  let generation: string | undefined;
  let width = 0, height = 0, lastSequence = 0;
  let writable: unknown;
  let writer: Writer<T> | undefined;
  let queue: ReturnType<typeof createNativeFrameWriteQueue<FrameEntry<T>>> | undefined;
  let activeEntry: FrameEntry<T> | undefined;
  let lastCompletedAt: number | undefined;
  const held = new Set<T>();
  const closed = new WeakSet<T>();
  const discardedWritables = new WeakSet<object>();
  const writerCleanup = new WeakMap<Writer<T>, Promise<void>>();

  function close(frame: T): void {
    held.delete(frame);
    if (closed.has(frame)) return;
    closed.add(frame);
    try { frame.close(); } catch { /* Continue closing the other owned frames. */ }
  }

  function abortAndRelease(acquired: Writer<T>, finished?: () => void): void {
    const previous = writerCleanup.get(acquired);
    if (previous) { if (finished) void previous.then(finished); return; }
    let aborted: PromiseLike<void> | void = undefined;
    try { aborted = acquired.abort(); } catch { /* Release even after synchronous abort failure. */ }
    const cleanup = Promise.resolve(aborted).catch(() => {}).then(() => {
      try { acquired.releaseLock(); } catch { /* The writer may already be detached. */ }
    });
    writerCleanup.set(acquired, cleanup);
    if (finished) void cleanup.then(finished);
  }

  function stop(): void {
    if (phase === 'stopping' || phase === 'stopped') return;
    phase = 'stopping';
    queue?.stop();
    activeEntry = undefined;
    // submit() settles synchronously, but its reactions run later. Close now,
    // without waiting for an in-flight native write or for its abort promise.
    for (const frame of held) close(frame);
    const acquired = writer;
    writer = undefined;
    const finished = () => {
      phase = 'stopped';
      if (generation) {
        try { options.post({ type: 'stopped', generation }); } catch { /* No retry after teardown. */ }
      }
    };
    if (acquired) abortAndRelease(acquired, finished);
    else void Promise.resolve().then(finished);
  }

  function fail(reason: NativeFrameWorkerFailure): void {
    if (phase === 'stopping' || phase === 'stopped') return;
    stop();
    // Without a valid init generation the Window's startup deadline owns failure.
    if (generation) {
      try { options.post({ type: 'failed', generation, reason }); } catch { /* Fixed, bounded failure reporting. */ }
    }
  }

  function post(event: NativeFrameWorkerEvent): void {
    try { options.post(event); } catch { fail('message'); }
  }

  function closeIncoming(value: unknown): void {
    if (options.isFrame(value)) close(value);
    else if (record(value) && options.isFrame(value.frame)) close(value.frame);
  }

  function disposeUnclaimedWritable(value: unknown): void {
    if (!record(value) || !('writable' in value) || value.writable === writable) return;
    if (!record(value.writable) || discardedWritables.has(value.writable)) return;
    discardedWritables.add(value.writable);
    try { abortAndRelease(acquireWriter<T>(value.writable)); } catch { /* Invalid or already locked. */ }
  }

  function init(value: Record<string, unknown>): void {
    if (phase !== 'new') {
      closeIncoming(value);
      disposeUnclaimedWritable(value);
      fail('protocol');
      return;
    }
    if (isNativeWorkerGeneration(value.generation)) generation = value.generation;
    if (!generation || !positiveInteger(value.width) || value.width < 2 || value.width > 4096 ||
        !positiveInteger(value.height) || value.height < 2 || value.height > 2560 ||
        typeof value.fps !== 'number' || ![30, 60, 120].includes(value.fps) ||
        !onlyKeys(value, ['type', 'generation', 'writable', 'width', 'height', 'fps'])) {
      closeIncoming(value);
      disposeUnclaimedWritable(value);
      fail('init');
      return;
    }
    width = value.width;
    height = value.height;
    try {
      writer = acquireWriter<T>(value.writable);
      writable = value.writable;
      queue = createNativeFrameWriteQueue<FrameEntry<T>>({
        now: options.now,
        maxPendingAgeMs: 2000 / value.fps,
        write(entry) {
          activeEntry = entry;
          entry.idleMs = lastCompletedAt === undefined ? 0 : Math.max(0, options.now() - lastCompletedAt);
          if (!writer) throw new TypeError();
          return Promise.resolve(writer.write(entry.frame));
        },
        onWritten(writeMs, queueAgeMs) {
          if (!activeEntry) throw new TypeError();
          activeEntry.timing = { writeMs, queueAgeMs, idleMs: activeEntry.idleMs };
          lastCompletedAt = options.now();
          activeEntry = undefined;
        },
        onFailure: () => fail('write'),
      });
      phase = 'running';
      post({ type: 'ready', generation });
    } catch {
      fail('init');
    }
  }

  function frame(value: Record<string, unknown>): void {
    const incoming = value.frame;
    if (phase === 'stopping' || phase === 'stopped') {
      closeIncoming(value);
      return;
    }
    if (phase !== 'running' || value.generation !== generation ||
        !onlyKeys(value, ['type', 'generation', 'sequence', 'frame']) ||
        !isNativeWorkerSequence(value.sequence) || value.sequence <= lastSequence ||
        !options.isFrame(incoming) || incoming.displayWidth !== width || incoming.displayHeight !== height ||
        typeof incoming.timestamp !== 'number' || !Number.isFinite(incoming.timestamp) || incoming.timestamp < 0 ||
        held.has(incoming) || closed.has(incoming) || held.size >= NATIVE_WORKER_MAX_PENDING) {
      closeIncoming(value);
      disposeUnclaimedWritable(value);
      fail('protocol');
      return;
    }
    lastSequence = value.sequence;
    held.add(incoming);
    const entry: FrameEntry<T> = { frame: incoming, sequence: value.sequence, idleMs: 0 };
    const acceptedGeneration = generation!;
    void queue!.submit(entry).then(result => {
      close(incoming);
      post({ type: 'ack', generation: acceptedGeneration, sequence: entry.sequence, result,
        ...(result === 'written' ? { timing: entry.timing! } : {}) });
    }).catch(() => {
      close(incoming);
      fail('write');
    });
  }

  function handleMessage(value: unknown): void {
    try {
      if (phase === 'stopping' || phase === 'stopped') {
        closeIncoming(value);
        disposeUnclaimedWritable(value);
        return;
      }
      if (!record(value)) { closeIncoming(value); fail('protocol'); return; }
      if (value.type === 'init') { init(value); return; }
      if (value.type === 'frame') { frame(value); return; }
      closeIncoming(value);
      disposeUnclaimedWritable(value);
      if (value.type === 'stop' && phase === 'running' && value.generation === generation &&
          onlyKeys(value, ['type', 'generation'])) stop();
      else fail('protocol');
    } catch {
      try { closeIncoming(value); disposeUnclaimedWritable(value); } catch { /* Hostile metadata accessor. */ }
      fail('protocol');
    }
  }

  return { handleMessage, handleMessageError: () => fail('message'), stop };
}
