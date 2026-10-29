import type { NativeFrameWriteResult } from './nativeFrameWriteQueue';
import {
  NATIVE_WORKER_ACK_TIMEOUT_MS, NATIVE_WORKER_MAX_PENDING, NATIVE_WORKER_STOP_TIMEOUT_MS,
  isNativeWorkerGeneration, isNativeWorkerResult, isNativeWorkerTiming,
  type NativeFrameWorkerCommand, type NativeFrameWorkerFailure, type NativeFrameWorkerTiming,
} from './nativeFrameWorkerProtocol';

export interface NativeFrameWorkerPort {
  postMessage(message: NativeFrameWorkerCommand, transfer: Transferable[]): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: Event) => void): void;
  terminate(): void;
}

export interface NativeWorkerFrameSinkSnapshot {
  state: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';
  pending: number;
  maxPending: number;
  submitted: number;
  acknowledged: number;
  capacityDrops: number;
  beforeReadyDrops: number;
  ignoredMessages: number;
  failure: NativeFrameWorkerFailure | null;
}

interface Options {
  writable: WritableStream<VideoFrame>;
  width: number;
  height: number;
  fps: number;
  startupTimeoutMs: number;
  onWritten(timing: NativeFrameWorkerTiming): void;
  onDropped(reason: 'superseded' | 'expired' | 'stopped'): void;
  onFailure(reason: NativeFrameWorkerFailure): void;
  /** Dependency injection for CPU protocol/lifetime tests, never a renderer API. */
  createWorker?(): NativeFrameWorkerPort;
  generation?: string;
  schedule?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  unschedule?(timer: ReturnType<typeof setTimeout>): void;
}

/** Vite emits this module as a separate asset. No Blob, eval or relaxed CSP. */
function createBundledWorker(): NativeFrameWorkerPort {
  return new Worker(new URL('./nativeFrameWorker.ts', import.meta.url), {
    type: 'module', name: 'cove-native-frame-writer',
  }) as NativeFrameWorkerPort;
}

/**
 * Owns only Worker control and outstanding ACKs. The Window owns the source track
 * and closes its frame wrapper after submit settles. Transferred frames are owned
 * and closed by the Worker. An ACK never authorizes imported GPU slot reuse.
 */
export function createNativeWorkerFrameSink(options: Options) {
  if (!Number.isInteger(options.width) || options.width < 2 || options.width > 4096 ||
      !Number.isInteger(options.height) || options.height < 2 || options.height > 2560 ||
      ![30, 60, 120].includes(options.fps) ||
      !Number.isFinite(options.startupTimeoutMs) || options.startupTimeoutMs <= 0 ||
      options.startupTimeoutMs > NATIVE_WORKER_ACK_TIMEOUT_MS || options.writable.locked) {
    throw new Error('Invalid native Worker sink setup');
  }
  const generation = options.generation ?? `writer_${crypto.randomUUID()}`;
  if (!isNativeWorkerGeneration(generation)) throw new Error('Invalid native Worker generation');
  const worker = (options.createWorker ?? createBundledWorker)();
  const schedule = options.schedule ?? setTimeout;
  const unschedule = options.unschedule ?? clearTimeout;
  const counters: NativeWorkerFrameSinkSnapshot = {
    state: 'starting', pending: 0, maxPending: 0, submitted: 0, acknowledged: 0,
    capacityDrops: 0, beforeReadyDrops: 0, ignoredMessages: 0, failure: null,
  };
  const pending = new Map<number, { resolve(result: NativeFrameWriteResult): void; timer: ReturnType<typeof setTimeout> }>();
  let sequence = 0;
  let terminated = false;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // A cancellation may win before its caller has attached an await handler.
  void ready.catch(() => {});

  function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
    if (timer !== undefined) unschedule(timer);
  }
  function settlePending() {
    for (const entry of pending.values()) { clearTimer(entry.timer); entry.resolve('stopped'); }
    pending.clear(); counters.pending = 0;
  }
  function terminate() {
    if (terminated) return;
    terminated = true;
    clearTimer(readyTimer); clearTimer(stopTimer);
    readyTimer = stopTimer = undefined;
    for (const type of ['message', 'error', 'messageerror'] as const) worker.removeEventListener(type, listeners[type]);
    try { worker.terminate(); } catch { /* The track owner still stops its source. */ }
    if (counters.state !== 'failed') counters.state = 'stopped';
  }
  function requestStop() {
    // This is cooperative abort first, bounded terminate second. The caller must
    // separately stop the Window-owned Generator track even if this Worker hangs.
    try { worker.postMessage({ type: 'stop', generation }, []); } catch { terminate(); return; }
    if (!terminated) stopTimer = schedule(terminate, NATIVE_WORKER_STOP_TIMEOUT_MS);
  }
  function fail(reason: NativeFrameWorkerFailure) {
    if (terminated || counters.state === 'failed' || counters.state === 'stopping' || counters.state === 'stopped') return;
    counters.state = 'failed'; counters.failure = reason;
    clearTimer(readyTimer); readyTimer = undefined;
    rejectReady(new Error(`Native Worker ${reason}`));
    settlePending();
    requestStop();
    try { options.onFailure(reason); } catch { /* A reporting hook cannot retain frames. */ }
  }
  function onMessage(event: Event) {
    const data: unknown = (event as MessageEvent).data;
    if (!data || typeof data !== 'object') { fail('protocol'); return; }
    const message = data as Record<string, unknown>;
    if (message.generation !== generation) { counters.ignoredMessages++; return; }
    if (message.type === 'stopped') {
      if (counters.state === 'stopping' || counters.state === 'failed') terminate();
      else fail('protocol');
      return;
    }
    if (counters.state === 'stopping' || counters.state === 'stopped' || counters.state === 'failed') {
      counters.ignoredMessages++; return;
    }
    if (message.type === 'ready') {
      if (counters.state !== 'starting') { counters.ignoredMessages++; return; }
      counters.state = 'ready'; clearTimer(readyTimer); readyTimer = undefined; resolveReady(); return;
    }
    if (message.type === 'failed') {
      const reason = message.reason;
      fail(reason === 'init' || reason === 'protocol' || reason === 'write' || reason === 'message' || reason === 'timeout' ? reason : 'protocol');
      return;
    }
    if (message.type !== 'ack' || counters.state !== 'ready' ||
        !Number.isSafeInteger(message.sequence) || Number(message.sequence) <= 0) {
      fail('protocol'); return;
    }
    const entry = pending.get(message.sequence as number);
    if (!entry) { counters.ignoredMessages++; return; }
    if (!isNativeWorkerResult(message.result) ||
        (message.result === 'written' ? !isNativeWorkerTiming(message.timing) : message.timing !== undefined)) {
      fail('protocol'); return;
    }
    clearTimer(entry.timer); pending.delete(message.sequence as number);
    counters.pending = pending.size; counters.acknowledged++;
    try {
      if (message.result === 'written') options.onWritten(message.timing as NativeFrameWorkerTiming);
      else options.onDropped(message.result);
    } catch { /* Aggregate observers cannot change ownership. */ }
    entry.resolve(message.result);
  }
  const listeners = { message: onMessage, error: () => fail('message'), messageerror: () => fail('message') };
  for (const type of ['message', 'error', 'messageerror'] as const) worker.addEventListener(type, listeners[type]);
  readyTimer = schedule(() => fail('timeout'), options.startupTimeoutMs);
  try {
    // Do not getWriter() in the Window. Transfer directly once to the final Worker.
    worker.postMessage({ type: 'init', generation, writable: options.writable,
      width: options.width, height: options.height, fps: options.fps }, [options.writable]);
  } catch {
    clearTimer(readyTimer); readyTimer = undefined;
    counters.state = 'failed'; counters.failure = 'init';
    rejectReady(new Error('Native Worker init'));
    terminate();
    throw new Error('Native Worker init');
  }

  function submit(frame: VideoFrame): Promise<NativeFrameWriteResult> {
    if (counters.state !== 'ready') {
      if (counters.state === 'starting') {
        counters.beforeReadyDrops++; options.onDropped('superseded'); return Promise.resolve('superseded');
      }
      return Promise.resolve('stopped');
    }
    if (pending.size >= NATIVE_WORKER_MAX_PENDING) {
      counters.capacityDrops++; options.onDropped('superseded'); return Promise.resolve('superseded');
    }
    const frameSequence = ++sequence;
    return new Promise<NativeFrameWriteResult>(resolve => {
      const timer = schedule(() => fail('timeout'), NATIVE_WORKER_ACK_TIMEOUT_MS);
      pending.set(frameSequence, { resolve, timer });
      counters.submitted++; counters.pending = pending.size; counters.maxPending = Math.max(counters.maxPending, pending.size);
      try { worker.postMessage({ type: 'frame', generation, sequence: frameSequence, frame }, [frame]); }
      catch { fail('message'); }
    });
  }
  function stop() {
    if (terminated || counters.state === 'stopped' || counters.state === 'stopping' || counters.state === 'failed') return;
    counters.state = 'stopping';
    clearTimer(readyTimer); readyTimer = undefined;
    rejectReady(new Error('Native Worker stopped'));
    settlePending(); requestStop();
  }
  return { ready, submit, stop, snapshot: (): NativeWorkerFrameSinkSnapshot => ({ ...counters }) };
}
