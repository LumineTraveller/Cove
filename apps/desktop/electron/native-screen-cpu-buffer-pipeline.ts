import { performance } from 'node:perf_hooks';
import { NATIVE_SCREEN_POOL_SIZE, type NativeScreenFrame, type NativeScreenColorSpace } from './native-screen-capture-protocol';
import type { NativeCpuFrameDelivery, NativeCpuFrameDeliveryScheduler, NativeCpuFrameDeliverySnapshot,
  NativeCpuFrameFailure, NativeCpuFrameTimingStage, NativeCpuScreenFrame } from './native-screen-cpu-delivery';

export type NativeCpuOwnership = 'final-ack' | 'copy-complete';
export type NativeCpuPipelineCounter = 'sourceCopied' | 'sourceDiscarded' | 'sourceReleased' | 'mainSent' | 'finalAck' |
  'pendingSuperseded' | 'pendingExpired';
export type NativeCpuPipelineCounters = Record<NativeCpuPipelineCounter, number>;
export interface NativeCpuBufferPipelineOptions {
  requestId: string;
  sessionId: string;
  width: number;
  height: number;
  colorSpace: NativeScreenColorSpace;
  fps: 30 | 60 | 120;
  /** Synchronously fills this ordinary main-owned AB; native cache keys use metadata.slot. */
  readFrame(handle: Buffer, target: ArrayBuffer, metadata: NativeCpuScreenFrame): void;
  /** Sends imported then released for this exact source, including explicit discard. */
  releaseSource(metadata: NativeCpuScreenFrame, disposition: 'copied' | 'discarded'): boolean;
  send(metadata: NativeCpuScreenFrame, data: ArrayBuffer): void;
  onFinalAck(metadata: NativeCpuScreenFrame): boolean;
  onFailure(code: NativeCpuFrameFailure): void;
  now?(): number;
  scheduler?: NativeCpuFrameDeliveryScheduler;
  onTiming?(stage: NativeCpuFrameTimingStage, durationMs: number): void;
  /** Anonymous cumulative diagnostics; exceptions cannot alter ownership. */
  onCounter?(counter: NativeCpuPipelineCounter): void;
}
export interface NativeCpuBufferPipelineSnapshot extends NativeCpuFrameDeliverySnapshot, NativeCpuPipelineCounters {
  ownership: 'copy-complete';
  activeNativeLeases: number;
  mainBuffersInUse: number;
  allocatedBuffers: number;
  pendingFrames: number;
}
export interface NativeCpuBufferPipeline extends NativeCpuFrameDelivery {
  snapshot(): NativeCpuBufferPipelineSnapshot;
}
interface FrameLease {
  metadata: NativeCpuScreenFrame;
  createdAt: number;
  handle?: Buffer;
  timer?: ReturnType<typeof setTimeout>;
  pendingTimer?: ReturnType<typeof setTimeout>;
  buffer?: MainBuffer;
  sent: boolean;
}
interface MainBuffer { data?: ArrayBuffer; lease?: FrameLease }
const ACK_TIMEOUT_MS = 1_500;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/**
 * CPU-only two-pool ownership. A successful synchronous copy retires the native
 * source; a final renderer ACK retires only its independently indexed main AB.
 * No native mapping/object is owned here. IPC/browser clones are outside these pools.
 */
export function createNativeCpuBufferPipeline(options: NativeCpuBufferPipelineOptions): NativeCpuBufferPipeline {
  const { requestId, sessionId, width, height, colorSpace, fps } = options;
  const expectedBytes = width * height * 3 / 2;
  if (typeof requestId !== 'string' || !requestId || typeof sessionId !== 'string' || !sessionId ||
      (colorSpace !== 'bt601-limited' && colorSpace !== 'bt709-limited') || ![30, 60, 120].includes(fps))
    throw new TypeError('CPU buffer pipeline contract is invalid');
  if (!positiveInteger(width) || !positiveInteger(height) || width % 2 || height % 2 ||
      !Number.isSafeInteger(expectedBytes) || expectedBytes > MAX_FRAME_BYTES)
    throw new RangeError('CPU NV12 frame geometry is invalid');
  const now = options.now ?? (() => performance.now());
  const scheduler = options.scheduler ?? { setImmediate, clearImmediate };
  const maxPendingAgeMs = 2_000 / fps; // Main-arrival age, not end-to-end capture age.
  const native = new Map<number, FrameLease>();
  const main = new Map<number, FrameLease>();
  const buffers: MainBuffer[] = Array.from({ length: NATIVE_SCREEN_POOL_SIZE }, () => ({}));
  const counters: NativeCpuPipelineCounters = { sourceCopied: 0, sourceDiscarded: 0, sourceReleased: 0,
    mainSent: 0, finalAck: 0, pendingSuperseded: 0, pendingExpired: 0 };
  let pending: FrameLease | undefined;
  let scheduled: { handle?: ReturnType<typeof setImmediate> } | undefined;
  let stopped = false, draining = false, lastSerial = 0, lastTimestamp = 0;

  function count(counter: NativeCpuPipelineCounter): void {
    counters[counter]++;
    try { options.onCounter?.(counter); } catch { /* Diagnostics own no credits. */ }
  }
  function eraseHandle(lease: FrameLease): void { lease.handle?.fill(0); lease.handle = undefined; }
  function nativeLive(lease: FrameLease): boolean { return !stopped && native.get(lease.metadata.slot) === lease; }
  function mainLive(lease: FrameLease): boolean { return !stopped && main.get(lease.metadata.serial) === lease; }
  function stop(): void {
    if (stopped) return;
    stopped = true;
    const old = scheduled; scheduled = undefined;
    try { if (old?.handle) scheduler.clearImmediate(old.handle); } catch { /* Identity still cancels late callbacks. */ }
    for (const lease of new Set([...native.values(), ...main.values()])) {
      clearTimeout(lease.timer); clearTimeout(lease.pendingTimer); eraseHandle(lease);
    }
    native.clear(); main.clear(); pending = undefined;
    for (const buffer of buffers) { buffer.lease = undefined; buffer.data = undefined; }
  }
  function fail(code: NativeCpuFrameFailure): void {
    if (stopped) return;
    stop();
    try { options.onFailure(code); } catch { /* The session owner handles native teardown. */ }
  }
  function withinDeadline(lease: FrameLease): boolean {
    const elapsed = now() - lease.createdAt;
    if (stopped) return false;
    if (elapsed >= ACK_TIMEOUT_MS) { fail('cpu_ack_timeout'); return false; }
    return true;
  }
  function valid(frame: NativeCpuScreenFrame): boolean {
    return frame.requestId === requestId && frame.sessionId === sessionId &&
      Number.isInteger(frame.slot) && frame.slot >= 0 && frame.slot < NATIVE_SCREEN_POOL_SIZE &&
      positiveInteger(frame.serial) && positiveInteger(frame.timestamp) && frame.width === width && frame.height === height &&
      typeof frame.refresh === 'boolean' && frame.pixelFormat === 'nv12' && frame.storage === 'cpu' && frame.colorSpace === colorSpace;
  }
  function snapshotFrame(value: unknown): NativeCpuScreenFrame | undefined {
    if (!value || typeof value !== 'object') return;
    const frame = value as NativeCpuScreenFrame;
    const metadata: NativeCpuScreenFrame = { requestId: frame.requestId, sessionId: frame.sessionId,
      slot: frame.slot, serial: frame.serial, timestamp: frame.timestamp, width: frame.width, height: frame.height,
      refresh: frame.refresh, pixelFormat: frame.pixelFormat, storage: frame.storage, colorSpace: frame.colorSpace };
    return valid(metadata) ? Object.freeze(metadata) : undefined;
  }
  function releaseSource(lease: FrameLease, disposition: 'copied' | 'discarded', reason?: 'superseded' | 'expired'): boolean {
    if (!nativeLive(lease)) return false;
    // Supersede and freshness expiry must not erase an already-overdue total watchdog.
    if (disposition === 'discarded' && (!withinDeadline(lease) || !nativeLive(lease))) return false;
    // Invalidate every read capability BEFORE external commands can reenter.
    native.delete(lease.metadata.slot); eraseHandle(lease);
    if (pending === lease) pending = undefined;
    clearTimeout(lease.pendingTimer); lease.pendingTimer = undefined;
    if (disposition === 'discarded') {
      clearTimeout(lease.timer); lease.timer = undefined;
      count('sourceDiscarded');
      if (reason) count(reason === 'superseded' ? 'pendingSuperseded' : 'pendingExpired');
    }
    if (stopped) return false;
    const accepted = options.releaseSource(lease.metadata, disposition);
    if (accepted) count('sourceReleased');
    else if (!stopped) fail('cpu_frame_failed');
    return accepted && !stopped;
  }
  function expirePending(lease: FrameLease): void {
    if (!nativeLive(lease) || pending !== lease) return;
    try {
      const age = now() - lease.createdAt;
      if (!nativeLive(lease) || pending !== lease) return;
      if (age >= ACK_TIMEOUT_MS) { fail('cpu_ack_timeout'); return; }
      if (age < maxPendingAgeMs) {
        lease.pendingTimer = setTimeout(() => expirePending(lease), Math.max(1, Math.ceil(maxPendingAgeMs - age)));
        lease.pendingTimer.unref(); return;
      }
      releaseSource(lease, 'discarded', 'expired');
    } catch { fail('cpu_frame_failed'); }
  }
  function recordTiming(stage: NativeCpuFrameTimingStage, startedAt: number): void {
    if (!options.onTiming || stopped) return;
    const duration = now() - startedAt;
    if (!stopped) options.onTiming(stage, duration);
  }
  function drain(): void {
    const lease = pending;
    if (!lease || !nativeLive(lease)) return;
    if (!withinDeadline(lease) || !nativeLive(lease) || pending !== lease) return;
    const age = now() - lease.createdAt;
    if (!nativeLive(lease) || pending !== lease) return;
    if (age >= maxPendingAgeMs) { releaseSource(lease, 'discarded', 'expired'); return; }
    const buffer = buffers.find(value => !value.lease);
    if (!buffer) return;
    // Reserve independently of helper slot, before read/source commands/send can reenter.
    pending = undefined; clearTimeout(lease.pendingTimer); lease.pendingTimer = undefined;
    buffer.lease = lease; lease.buffer = buffer; main.set(lease.metadata.serial, lease);
    const data = buffer.data ??= new ArrayBuffer(expectedBytes);
    if (data.byteLength !== expectedBytes) { fail('cpu_frame_failed'); return; }
    try { options.readFrame(lease.handle!, data, lease.metadata); }
    finally { eraseHandle(lease); }
    if (!nativeLive(lease) || !mainLive(lease)) return;
    if (data.byteLength !== expectedBytes) { fail('cpu_frame_failed'); return; }
    count('sourceCopied');
    if (!nativeLive(lease) || !mainLive(lease) || !withinDeadline(lease) || !nativeLive(lease)) return;
    if (!releaseSource(lease, 'copied') || !mainLive(lease)) return;
    recordTiming('import', lease.createdAt);
    if (!mainLive(lease) || !withinDeadline(lease) || !mainLive(lease)) return;
    const startedAt = now();
    if (!mainLive(lease) || startedAt - lease.createdAt >= ACK_TIMEOUT_MS) {
      if (!stopped) fail('cpu_ack_timeout'); return;
    }
    lease.sent = true; // A synchronous receiver is allowed to ACK this exact serial.
    options.send(lease.metadata, data);
    count('mainSent');
    recordTiming('transfer', startedAt);
  }
  function scheduleNext(): void {
    if (stopped || draining || scheduled || !pending || !buffers.some(value => !value.lease)) return;
    const token: { handle?: ReturnType<typeof setImmediate> } = {};
    scheduled = token;
    try {
      token.handle = scheduler.setImmediate(() => {
        if (stopped || scheduled !== token) return;
        scheduled = undefined; draining = true;
        try { drain(); } catch { fail('cpu_frame_failed'); }
        finally { draining = false; scheduleNext(); }
      });
      if (stopped || scheduled !== token) scheduler.clearImmediate(token.handle);
    } catch { fail('cpu_frame_failed'); }
  }
  function deliver(value: NativeScreenFrame, handle: Buffer): void {
    if (stopped) return;
    try {
      const metadata = snapshotFrame(value);
      if (stopped) return;
      const createdAt = now();
      if (stopped) return;
      if (!metadata || metadata.serial <= lastSerial || metadata.timestamp <= lastTimestamp ||
          native.has(metadata.slot) || native.size >= NATIVE_SCREEN_POOL_SIZE || !Buffer.isBuffer(handle) || handle.length !== 8 ||
          handle.readBigUInt64LE() === 0n || handle.readBigUInt64LE() === 0xffffffffffffffffn) {
        fail('cpu_frame_failed'); return;
      }
      const lease: FrameLease = { metadata, createdAt, handle: Buffer.from(handle), sent: false };
      native.set(metadata.slot, lease); lastSerial = metadata.serial; lastTimestamp = metadata.timestamp;
      lease.timer = setTimeout(() => {
        if (nativeLive(lease) || mainLive(lease)) fail('cpu_ack_timeout');
      }, ACK_TIMEOUT_MS); lease.timer.unref();
      lease.pendingTimer = setTimeout(() => expirePending(lease), Math.ceil(maxPendingAgeMs)); lease.pendingTimer.unref();
      const previous = pending; pending = lease;
      if (previous) releaseSource(previous, 'discarded', 'superseded');
      scheduleNext();
    } catch { fail('cpu_frame_failed'); }
  }
  function acknowledge(value: unknown): boolean {
    if (stopped) return false;
    let lease: FrameLease | undefined;
    try {
      const metadata = snapshotFrame(value);
      if (!metadata || stopped) return false;
      lease = main.get(metadata.serial);
      if (!lease?.sent || metadata.slot !== lease.metadata.slot || metadata.timestamp !== lease.metadata.timestamp ||
          metadata.refresh !== lease.metadata.refresh) return false;
    } catch { return false; }
    try {
      if (!mainLive(lease) || !withinDeadline(lease) || !mainLive(lease)) return false;
      const duration = now() - lease.createdAt;
      if (!mainLive(lease)) return false;
      if (duration >= ACK_TIMEOUT_MS) { fail('cpu_ack_timeout'); return false; }
      main.delete(lease.metadata.serial); clearTimeout(lease.timer); lease.timer = undefined;
      if (lease.buffer?.lease === lease) lease.buffer.lease = undefined;
      count('finalAck');
      if (stopped) return true;
      const accepted = options.onFinalAck(lease.metadata);
      if (!accepted && !stopped) { fail('cpu_frame_failed'); return false; }
      if (!stopped) {
        options.onTiming?.('reference', duration);
        scheduleNext();
      }
      return accepted;
    } catch { fail('cpu_frame_failed'); return false; }
  }
  return { deliver, acknowledge, stop, snapshot: () => ({ ownership: 'copy-complete', ...counters,
    inFlight: main.size, stopped, frames: counters.mainSent, released: counters.finalAck, expectedBytes,
    activeNativeLeases: native.size, mainBuffersInUse: main.size,
    allocatedBuffers: buffers.filter(value => value.data).length, pendingFrames: pending ? 1 : 0 }) };
}
