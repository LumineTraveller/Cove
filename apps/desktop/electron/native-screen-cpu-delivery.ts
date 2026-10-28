import { performance } from 'node:perf_hooks';
import { NATIVE_SCREEN_POOL_SIZE, type NativeScreenFrame, type NativeScreenColorSpace } from './native-screen-capture-protocol';

export type NativeCpuScreenFrame = NativeScreenFrame & { pixelFormat: 'nv12'; storage: 'cpu'; colorSpace: NativeScreenColorSpace };
export type NativeCpuFrameFailure = 'cpu_frame_failed' | 'cpu_ack_timeout';
export type NativeCpuFrameTimingStage = 'import' | 'transfer' | 'reference';

export interface NativeCpuFrameDeliveryOptions {
  requestId: string;
  sessionId: string;
  width: number;
  height: number;
  colorSpace: NativeScreenColorSpace;
  /** Copies a verified child's mapping into an independent ArrayBuffer, using validated immutable lease metadata. */
  readFrame(handle: Buffer, expectedBytes: number, metadata: NativeCpuScreenFrame): ArrayBuffer;
  onImported(metadata: NativeCpuScreenFrame): boolean;
  send(metadata: NativeCpuScreenFrame, data: ArrayBuffer): void;
  onReleased(metadata: NativeCpuScreenFrame): boolean;
  onFailure(code: NativeCpuFrameFailure): void;
  now?(): number;
  onTiming?(stage: NativeCpuFrameTimingStage, durationMs: number): void;
}

export interface NativeCpuFrameDeliverySnapshot {
  inFlight: number;
  stopped: boolean;
  frames: number;
  released: number;
  expectedBytes: number;
}

export interface NativeCpuFrameDelivery {
  deliver(metadata: NativeScreenFrame, handle: Buffer): void;
  acknowledge(metadata: unknown): boolean;
  stop(): void;
  snapshot(): NativeCpuFrameDeliverySnapshot;
}

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const ACK_TIMEOUT_MS = 1_500;

interface Lease {
  metadata: NativeCpuScreenFrame;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
  sent: boolean;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * Owns only CPU-delivery metadata and timers, never native mappings, handles or pixel buffers.
 * Copying/importing is not a slot credit: only the renderer's matching final ack can release
 * a slot. Stop/failure deliberately leaves helper slot retirement to the session owner.
 */
export function createNativeCpuFrameDelivery(options: NativeCpuFrameDeliveryOptions): NativeCpuFrameDelivery {
  const { requestId, sessionId, width, height, colorSpace } = options;
  if (typeof requestId !== 'string' || !requestId || typeof sessionId !== 'string' || !sessionId)
    throw new TypeError('CPU frame delivery requires a request and session');
  if (colorSpace !== 'bt601-limited' && colorSpace !== 'bt709-limited')
    throw new TypeError('CPU frame delivery requires a color space');
  const expectedBytes = width * height * 3 / 2;
  if (!positiveInteger(width) || !positiveInteger(height) || width % 2 || height % 2 ||
      !Number.isSafeInteger(expectedBytes) || expectedBytes > MAX_FRAME_BYTES)
    throw new RangeError('CPU NV12 frame geometry is invalid');

  const now = options.now ?? (() => performance.now());
  const leases = new Map<number, Lease>();
  let stopped = false;
  let lastSerial = 0;
  let lastTimestamp = 0;
  let frames = 0;
  let released = 0;

  function stop(): void {
    if (stopped) return;
    stopped = true;
    for (const lease of leases.values()) clearTimeout(lease.timer);
    leases.clear();
  }

  function fail(code: NativeCpuFrameFailure): void {
    if (stopped) return;
    stop();
    try { options.onFailure(code); } catch { /* Cleanup already completed; the owner handles teardown. */ }
  }

  function live(lease: Lease): boolean {
    return !stopped && leases.get(lease.metadata.slot) === lease;
  }

  function expired(lease: Lease): boolean {
    if (now() - lease.createdAt < ACK_TIMEOUT_MS) return false;
    fail('cpu_ack_timeout');
    return true;
  }

  function validFrame(value: unknown): value is NativeCpuScreenFrame {
    if (!value || typeof value !== 'object') return false;
    const frame = value as NativeCpuScreenFrame;
    return frame.requestId === requestId && frame.sessionId === sessionId &&
      Number.isInteger(frame.slot) && frame.slot >= 0 && frame.slot < NATIVE_SCREEN_POOL_SIZE &&
      positiveInteger(frame.serial) && positiveInteger(frame.timestamp) &&
      frame.width === width && frame.height === height && typeof frame.refresh === 'boolean' &&
      frame.pixelFormat === 'nv12' && frame.storage === 'cpu' && frame.colorSpace === colorSpace;
  }

  function deliver(value: NativeScreenFrame, handle: Buffer): void {
    if (stopped) return;
    try {
      if (!validFrame(value) || value.serial <= lastSerial || value.timestamp <= lastTimestamp ||
          leases.has(value.slot) || leases.size >= NATIVE_SCREEN_POOL_SIZE ||
          !Buffer.isBuffer(handle) || handle.length !== 8) {
        fail('cpu_frame_failed');
        return;
      }
      // Snapshot the validated wire metadata so later caller mutation cannot alter the lease.
      const metadata: NativeCpuScreenFrame = Object.freeze({ requestId, sessionId, slot: value.slot,
        serial: value.serial, width, height, timestamp: value.timestamp, refresh: value.refresh,
        pixelFormat: 'nv12', storage: 'cpu', colorSpace });
      const createdAt = now();
      const lease: Lease = { metadata, createdAt, sent: false,
        timer: setTimeout(() => { if (live(lease)) fail('cpu_ack_timeout'); }, ACK_TIMEOUT_MS) };
      lease.timer.unref();
      leases.set(metadata.slot, lease);
      lastSerial = metadata.serial;
      lastTimestamp = metadata.timestamp;

      // The native reader supplies an independent exact-sized copy. Do not retain or recopy it.
      const data = options.readFrame(handle, expectedBytes, metadata);
      if (!live(lease)) return;
      if (!(data instanceof ArrayBuffer) || data.byteLength !== expectedBytes) {
        fail('cpu_frame_failed');
        return;
      }
      if (expired(lease)) return;
      options.onTiming?.('import', now() - createdAt);
      if (!live(lease) || expired(lease)) return;
      const imported = options.onImported(metadata);
      if (!live(lease)) return;
      if (!imported) { fail('cpu_frame_failed'); return; }
      if (expired(lease)) return;

      const transferStartedAt = now();
      // Mark sent before invoking the transport: a synchronous receiver can legitimately ack.
      lease.sent = true;
      options.send(metadata, data);
      frames++;
      // Transfer measures this synchronous transport call; reference covers the renderer's ack.
      if (!stopped) options.onTiming?.('transfer', now() - transferStartedAt);
    } catch { fail('cpu_frame_failed'); }
  }

  function acknowledge(value: unknown): boolean {
    if (stopped) return false;
    // Malformed/stale renderer input is ignored, never a reason to release or end this session.
    let lease: Lease | undefined;
    try {
      if (!validFrame(value)) return false;
      lease = leases.get(value.slot);
      if (!lease?.sent) return false;
      const expected = lease.metadata;
      if (value.serial !== expected.serial || value.timestamp !== expected.timestamp ||
          value.refresh !== expected.refresh) return false;
    } catch { return false; }
    try {
      if (!live(lease) || expired(lease)) return false;
      const durationMs = now() - lease.createdAt;
      // Unknown metadata accessors and the injected clock can reenter session teardown too.
      if (!live(lease)) return false;
      // Remove first so duplicate/reentrant acks cannot credit the same slot twice.
      clearTimeout(lease.timer);
      leases.delete(lease.metadata.slot);
      const accepted = options.onReleased(lease.metadata);
      if (accepted) released++;
      if (stopped) return accepted;
      if (!accepted) { fail('cpu_frame_failed'); return false; }
      options.onTiming?.('reference', durationMs);
      return true;
    } catch { fail('cpu_frame_failed'); return false; }
  }

  return { deliver, acknowledge, stop,
    snapshot: () => ({ inFlight: leases.size, stopped, frames, released, expectedBytes }) };
}
