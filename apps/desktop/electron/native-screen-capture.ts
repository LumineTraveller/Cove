import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { sharedTexture, type WebContents, type WebFrameMain, type SharedTextureImported } from 'electron';
import { createNativeCpuFrameDelivery, type NativeCpuFrameDelivery, type NativeCpuDeliveryScheduling } from './native-screen-cpu-delivery';
import { createNativeCpuBufferPipeline, type NativeCpuBufferPipeline, type NativeCpuOwnership,
  type NativeCpuPipelineCounters } from './native-screen-cpu-buffer-pipeline';
import { createNativeScreenHelperTimingCollector, type NativeScreenHelperTiming } from './native-screen-capture-timing';
import { acquireNativeScreenRendererActivity } from './native-screen-renderer-activity';
import {
  NATIVE_SCREEN_POOL_SIZE, NATIVE_SCREEN_START_TIMEOUT_MS, NATIVE_SCREEN_STOP_TIMEOUT_MS,
  validNativeScreenOptions, validNativeScreenRequestId,
  type NativeScreenFrame, type NativeScreenOptions, type NativeScreenSourceSelection, type NativeScreenStartResult, type NativeScreenColorSpace,
  type NativeScreenRegion,
} from './native-screen-capture-protocol';

const MAX_LINE_BYTES = 8 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_STDIN_BYTES = 4 * 1024;
const MAX_SESSIONS = 2;
const MAX_REQUEST_IDS = 4096;
const SELECTION_LIFETIME_MS = 10_000;
const CAPTURE_STALL_TIMEOUT_MS = 5_000;
const TIMING_BUCKET_LIMITS_MS = [1, 2, 4, 1000 / 120, 1000 / 60, 1000 / 30];
const gpuNv12ColorSpace = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited' } as const;
type TimingStage = 'import' | 'transfer' | 'reference';
interface TimingMetric { count: number; totalMs: number; maxMs: number; buckets: number[] }
function emptyTimingMetric(): TimingMetric { return { count: 0, totalMs: 0, maxMs: 0, buckets: Array(7).fill(0) }; }
type FailureCode = 'helper_unavailable' | 'helper_failed' | 'invalid_protocol' | 'start_timeout' |
  'import_failed' | 'transfer_failed' | 'release_failed' | 'capture_stalled' | 'target_unavailable' | 'stopped' |
  'renderer_failed' | 'receiver_failed' | 'cpu_frame_failed' | 'cpu_ack_timeout';
interface Ready { width: number; height: number; sourceWidth: number; sourceHeight: number; pixelFormat: 'bgra' | 'nv12'; storage: 'gpu' | 'cpu'; colorSpace?: NativeScreenColorSpace }
export interface NativeScreenHandleBridge {
  supportsCpuFrames?: boolean;
  supportsCachedCpuFrames?: boolean;
  supportsCachedCpuFramesInto?: boolean;
  openChild(pid: number): NativeScreenChildHandleBridge;
}
interface NativeScreenChildHandleBridge {
  duplicate(handle: Buffer): { handle: Buffer; close(): void };
  readFrame?(handle: Buffer, expectedBytes: number): ArrayBuffer;
  readFrameCached?(slot: number, handle: Buffer, expectedBytes: number): ArrayBuffer;
  readFrameCachedInto?(slot: number, handle: Buffer, target: ArrayBuffer): void;
  readFrameCachedRowsInto?(slot: number, handle: Buffer, target: ArrayBuffer, width: number, height: number,
    y: number, rows: number): void;
  cpuSeconds?(): number;
  close(): void;
}
interface Lease {
  metadata: NativeScreenFrame;
  createdAt?: number;
  imported?: SharedTextureImported;
  mainReleased: boolean;
  importAcknowledged: boolean;
  transferSettled: boolean;
  transferComplete: boolean;
  permitSent: boolean;
  referencesReleased: boolean;
  credited: boolean;
  cachedFrameSent?: boolean;
  transferTimer?: ReturnType<typeof setTimeout>;
  referenceTimer?: ReturnType<typeof setTimeout>;
}
interface CachedTexture {
  handle: bigint;
  texture: Electron.SharedTextureImportedSubtle;
  transfer: Electron.SharedTextureTransfer;
}
interface Session {
  target: WebContents;
  frame: WebFrameMain;
  requestId: string;
  sessionId: string;
  options: NativeScreenOptions;
  selection: NativeScreenSourceSelection;
  storage: Ready['storage'];
  pixelFormat: Ready['pixelFormat'];
  cpuOwnership: NativeCpuOwnership;
  packedScreenCapture: boolean;
  child: ChildProcessWithoutNullStreams;
  childHandles?: NativeScreenChildHandleBridge;
  childHandlesClosed: boolean;
  active: boolean;
  closed: boolean;
  notified: boolean;
  ready?: Ready;
  lastSerial: number;
  lastTimestamp: number;
  pending: Buffer;
  leases: Map<number, Lease>;
  cachedTextures?: Map<number, CachedTexture>;
  cachedDrainTimer?: ReturnType<typeof setTimeout>;
  cpuDelivery?: NativeCpuFrameDelivery;
  cpuPipeline?: NativeCpuBufferPipeline;
  cpuBuffers?: Map<number, ArrayBuffer>;
  resolveStart: (result: NativeScreenStartResult) => void;
  startTimer?: ReturnType<typeof setTimeout>;
  stopTimer?: ReturnType<typeof setTimeout>;
  healthTimer?: ReturnType<typeof setTimeout>;
  stopPromise: Promise<void>;
  resolveStop: () => void;
  detach: () => void;
  releaseRendererActivity?: () => void;
}

function integer(value: unknown, low: number, high: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= low && (value as number) <= high;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cpuFrameRegion(value: unknown, width: number, height: number): NativeScreenRegion | undefined {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(part => integer(part, 0, 4096) && part % 2 === 0))
    return;
  const [x, y, w, h] = value as number[];
  if (!w || !h || x + w > width || y + h > height || h * 2 >= height) return;
  return [x, y, w, h];
}

function copyCpuFrameRows(frame: ArrayBuffer, patch: ArrayBuffer, width: number, height: number, region: NativeScreenRegion) {
  const [, y, , rows] = region;
  // Full-width row bands cost two bulk copies, even when the changed area is narrow.
  const yStart = y * width, yBytes = rows * width;
  const uvStart = (height + y / 2) * width;
  const full = new Uint8Array(frame), part = new Uint8Array(patch);
  part.set(full.subarray(yStart, yStart + yBytes), 0);
  part.set(full.subarray(uvStart, uvStart + yBytes / 2), yBytes);
}

/** Owns only children it creates. Renderer IPC never provides a texture handle. */
export class NativeScreenCaptureController {
  private readonly sessions = new Set<Session>();
  private readonly requestIds = new Set<string>();
  private readonly retainedLeases = new Set<Lease>();
  private selection?: NativeScreenSourceSelection;
  private disabledAfterFailure = false;
  private failureCode: FailureCode | null = null;
  private started = 0;
  private stopped = 0;
  private frames = 0;
  private refreshFrames = 0;
  private transferredFrames = 0;
  private releasedFrames = 0;
  private textureImports = 0;
  private cpuPatchedFrames = 0;
  private cpuPatchedBytes = 0;
  private cpuSourceBytes = 0;
  private lastEndReason: FailureCode | null = null;
  private handles?: NativeScreenHandleBridge;
  private readonly timing = { import: emptyTimingMetric(), transfer: emptyTimingMetric(), reference: emptyTimingMetric() };
  private readonly cpuOwnershipCounters: NativeCpuPipelineCounters = { sourceCopied: 0, sourceDiscarded: 0,
    sourceReleased: 0, mainSent: 0, finalAck: 0, pendingSuperseded: 0, pendingExpired: 0 };

  constructor(private readonly config: { enabled: boolean; helperPath: string; handles?: NativeScreenHandleBridge; timing?: boolean; onHelperTiming?: (sample: Readonly<NativeScreenHelperTiming>, captureNumber: number) => void; pixelFormat?: 'bgra' | 'nv12'; storage?: 'gpu' | 'cpu'; completion?: 'query' | 'fence'; cpuDeliveryScheduling?: NativeCpuDeliveryScheduling; cpuOwnership?: NativeCpuOwnership; keepRendererActive?: boolean; reuseGpuTextures?: boolean; preferPackedScreenCapture?: () => boolean; cpuPatches?: boolean; allowGpuNv12?: boolean; allowCpuNv12?: boolean }) {
    this.handles = config.handles;
  }

  noteStockSelection(selection: NativeScreenSourceSelection): void {
    this.selection = { ...selection };
  }

  async start(target: WebContents, requestId: string, options: NativeScreenOptions): Promise<NativeScreenStartResult> {
    if (!validNativeScreenRequestId(requestId) || !validNativeScreenOptions(options))
      return { ok: false, reason: 'invalid_request' };
    const requireCpuNv12 = options.cpuNv12 === true;
    if (requireCpuNv12 && (!this.config.allowCpuNv12 || process.versions.electron !== '44.0.0'))
      return { ok: false, reason: 'unavailable' };
    // GPU NV12 is limited to a host that explicitly selects the lab route.
    if (this.config.pixelFormat === 'nv12' && this.config.storage !== 'cpu' &&
        (this.config.allowGpuNv12 !== true || process.versions.electron !== '44.0.0'))
      return { ok: false, reason: 'unsupported_pixel_format' };
    // Unknown codecs cannot select a safe CPU YUV conversion. Reject before
    // loading/opening the handle bridge or consuming the stock selection.
    if (this.config.storage === 'cpu' && options.colorSpace === undefined)
      return { ok: false, reason: 'color_space_required' };
    if (!this.config.enabled || this.disabledAfterFailure || process.platform !== 'win32' || process.arch !== 'x64' ||
      !/^44\./.test(process.versions.electron || '') || typeof sharedTexture?.importSharedTexture !== 'function' ||
      typeof sharedTexture?.sendSharedTexture !== 'function') return { ok: false, reason: 'unavailable' };
    if (!this.handles) {
      try { this.handles = require(path.join(path.dirname(this.config.helperPath), 'native-screen-handles.node')) as NativeScreenHandleBridge; }
      catch { return { ok: false, reason: 'unavailable' }; }
    }
    if (typeof this.handles?.openChild !== 'function') return { ok: false, reason: 'unavailable' };
    if (this.config.storage === 'cpu' && (this.config.pixelFormat !== 'nv12' || this.handles.supportsCpuFrames !== true))
      return { ok: false, reason: 'unavailable' };
    if (this.config.storage === 'cpu' && this.config.cpuOwnership === 'copy-complete' && this.handles.supportsCachedCpuFramesInto !== true)
      return { ok: false, reason: 'unavailable' };
    const canDeliverCpuNv12 = this.handles.supportsCpuFrames === true && this.handles.supportsCachedCpuFramesInto === true;
    if (requireCpuNv12 && !canDeliverCpuNv12) return { ok: false, reason: 'unavailable' };
    if (this.requestIds.has(requestId)) return { ok: false, reason: 'duplicate_request' };
    if (this.requestIds.size >= MAX_REQUEST_IDS || this.sessions.size >= MAX_SESSIONS)
      return { ok: false, reason: 'busy' };
    if (target.isDestroyed()) return { ok: false, reason: 'target_unavailable' };
    const selection = this.selection;
    // Main's actual stock choice is a one-use capability, including an ineligible choice.
    this.selection = undefined;
    const age = selection ? Date.now() - selection.selectedAt : NaN;
    if (!selection || !/^screen:\d+:\d+$/.test(selection.sourceId) || selection.displayCount !== 1 ||
      !selection.displayId || selection.displayId !== selection.primaryDisplayId ||
      !Number.isFinite(age) || age < 0 || age > SELECTION_LIFETIME_MS ||
      !integer(selection.sourceWidth, 2, 16384) || !integer(selection.sourceHeight, 2, 16384) ||
      selection.sourceWidth < selection.sourceHeight) return { ok: false, reason: 'source_ineligible' };
    const packedScreenCapture = requireCpuNv12 || (process.versions.electron === '44.0.0' && this.config.storage !== 'cpu' &&
      options.colorSpace === 'bt709-limited' && options.fps === 120 &&
      options.maxWidth >= 1728 && options.maxWidth <= 1920 && options.maxHeight === 1080 &&
      integer(selection.sourceWidth, 2558, 2562) && integer(selection.sourceHeight, 1598, 1602) &&
      canDeliverCpuNv12 && this.config.preferPackedScreenCapture?.() === true);
    const storage = packedScreenCapture ? 'cpu' : this.config.storage ?? 'gpu';
    const pixelFormat = packedScreenCapture ? 'nv12' : this.config.pixelFormat ?? 'bgra';
    const cpuOwnership = packedScreenCapture ? 'copy-complete' : this.config.cpuOwnership ?? 'final-ack';
    this.requestIds.add(requestId);
    let frame: WebFrameMain;
    let child: ChildProcessWithoutNullStreams;
    try {
      frame = target.mainFrame;
      child = spawn(this.config.helperPath, ['--owner-pid', String(process.pid),
        '--max-width', String(options.maxWidth), '--max-height', String(options.maxHeight), '--fps', String(options.fps),
        ...(pixelFormat === 'nv12' ? ['--pixel-format', 'nv12'] : []),
        ...(storage === 'cpu' ? ['--frame-storage', 'cpu', '--color-space', options.colorSpace!] : []),
        ...(this.config.completion ? ['--completion', this.config.completion] : [])],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      this.disable('helper_unavailable');
      return { ok: false, reason: 'helper_unavailable' };
    }
    let resolveStart!: Session['resolveStart'];
    const result = new Promise<NativeScreenStartResult>(resolve => { resolveStart = resolve; });
    let resolveStop!: () => void;
    const stopPromise = new Promise<void>(resolve => { resolveStop = resolve; });
    const session: Session = { target, frame, child, requestId, sessionId: randomUUID(), options: { ...options }, selection,
      storage, pixelFormat, cpuOwnership, packedScreenCapture,
      active: true, closed: false, notified: false, childHandlesClosed: false, lastSerial: 0, lastTimestamp: 0, pending: Buffer.alloc(0),
      leases: new Map(), resolveStart, stopPromise, resolveStop, detach: () => {} };
    if (this.config.reuseGpuTextures && process.versions.electron === '44.0.0' && storage !== 'cpu' &&
        typeof sharedTexture.subtle?.importSharedTexture === 'function')
      session.cachedTextures = new Map();
    this.sessions.add(session);
    this.started++;
    const captureNumber = this.started;
    let timingCollector: ReturnType<typeof createNativeScreenHelperTimingCollector> | undefined;
    if (this.config.timing && this.config.onHelperTiming) {
      try {
        timingCollector = createNativeScreenHelperTimingCollector(sample => {
          try { void Promise.resolve(this.config.onHelperTiming?.(sample, captureNumber)).catch(() => {}); }
          catch { /* Observer only. */ }
        });
      } catch { /* Keep the normal stderr-drain path if observation cannot start. */ }
    }
    const timingData = timingCollector ? (chunk: Buffer) => {
      try { timingCollector?.write(chunk); } catch { /* Never turn diagnostic parsing into capture failure. */ }
    } : undefined;
    const failed = () => { if (session.active) this.retire(session, 'helper_failed', true); };
    const closed = () => {
      if (session.active) this.retire(session, 'helper_failed', true);
      this.finish(session);
    };
    const data = (chunk: Buffer) => this.receive(session, chunk);
    const destroy = () => this.retire(session, 'target_unavailable', false);
    const navigation = (_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame) destroy();
    };
    child.stdout.on('data', data);
    child.stdout.on('end', failed);
    child.stdout.on('error', failed);
    child.stderr.on('error', failed);
    // Default: drain without retention. Opt-in: bounded fixed numeric summaries only.
    if (timingData) {
      try { child.stderr.on('data', timingData); }
      catch { timingCollector?.close(); timingCollector = undefined; child.stderr.resume(); }
    } else child.stderr.resume();
    child.stdin.on('error', failed);
    child.on('error', failed);
    child.once('close', closed);
    target.on('destroyed', destroy);
    target.on('render-process-gone', destroy);
    target.on('did-start-navigation', navigation);
    session.detach = () => {
      child.stdout.off('data', data).off('end', failed).off('error', failed);
      child.stderr.off('error', failed);
      if (timingData) child.stderr.off('data', timingData);
      timingCollector?.close();
      child.stdin.off('error', failed);
      child.off('error', failed).off('close', closed);
      target.off('destroyed', destroy).off('render-process-gone', destroy).off('did-start-navigation', navigation);
    };
    // Explicit experiment only. Acquire after validation/spawn and teardown
    // listeners, so startup failure and every normal retirement release it.
    if (this.config.keepRendererActive === true)
      session.releaseRendererActivity = acquireNativeScreenRendererActivity(target);
    session.startTimer = setTimeout(() => this.retire(session, 'start_timeout', true), NATIVE_SCREEN_START_TIMEOUT_MS);
    session.startTimer.unref();
    try { session.childHandles = this.handles.openChild(child.pid!); }
    catch { this.retire(session, 'helper_unavailable', true); }
    if (session.active && storage === 'cpu' && cpuOwnership !== 'copy-complete' &&
        typeof session.childHandles?.readFrame !== 'function')
      this.retire(session, 'helper_unavailable', true);
    if (session.active && storage === 'cpu' && cpuOwnership === 'copy-complete' &&
        typeof session.childHandles?.readFrameCachedInto !== 'function') this.retire(session, 'helper_unavailable', true);
    return result;
  }

  async stop(target: WebContents, requestId: string, fault?: 'renderer_failed' | 'receiver_failed'): Promise<boolean> {
    if (fault !== undefined && fault !== 'renderer_failed' && fault !== 'receiver_failed') return false;
    const session = [...this.sessions].find(value => value.target === target && value.requestId === requestId);
    if (!session) return false;
    this.retire(session, fault ?? 'stopped', fault !== undefined);
    await session.stopPromise;
    return true;
  }

  acknowledgeCpuFrame(target: WebContents, metadata: unknown): boolean {
    if (!record(metadata)) return false;
    const session = [...this.sessions].find(value => value.active && value.target === target &&
      value.requestId === metadata.requestId && value.sessionId === metadata.sessionId && value.ready?.storage === 'cpu');
    return session?.cpuDelivery?.acknowledge(metadata) ?? false;
  }

  acknowledgeGpuFrame(target: WebContents, frame: WebFrameMain | null, metadata: unknown): void {
    if (!record(metadata) || !integer(metadata.slot, 0, NATIVE_SCREEN_POOL_SIZE - 1)) return;
    const session = [...this.sessions].find(value => value.target === target && value.frame === frame &&
      value.requestId === metadata.requestId && value.sessionId === metadata.sessionId);
    const lease = session?.leases.get(metadata.slot);
    if (!session?.cachedTextures || !lease?.cachedFrameSent || lease.referencesReleased ||
        lease.metadata.serial !== metadata.serial || lease.metadata.timestamp !== metadata.timestamp) return;
    lease.referencesReleased = true;
    clearTimeout(lease.referenceTimer);
    this.recordTiming('reference', lease.createdAt);
    this.transferredFrames++;
    this.releasedFrames++;
    if (!session.active || this.command(session, `released ${metadata.slot} ${metadata.serial}\n`))
      session.leases.delete(metadata.slot);
    if (!session.active && session.leases.size === 0) {
      this.releaseCachedTextures(session);
    }
  }

  gpuProcessGone(): void {
    for (const session of this.sessions) {
      if (!session.cachedTextures) continue;
      this.retire(session, 'import_failed', true);
      this.releaseCachedTextures(session);
    }
  }

  reset(): void {
    this.selection = undefined;
    for (const session of this.sessions) this.retire(session, 'stopped', false);
  }

  /** Test-main diagnostics only: no handles, source identifiers or content. */
  snapshot() {
    const sessions = [...this.sessions];
    const leases = new Set([...this.retainedLeases, ...sessions.flatMap(value => [...value.leases.values()])]);
    const active = sessions.filter(value => value.active);
    const current = active[0] ?? sessions[0];
    const storage = current?.storage ?? this.config.storage;
    const cpuOwnership = storage === 'cpu' ? current?.cpuOwnership ?? this.config.cpuOwnership ?? 'final-ack' : 'final-ack';
    let helperCpuSeconds: number | null = null;
    if (active.length === 1 && active[0].childHandles?.cpuSeconds) {
      try {
        const value = active[0].childHandles.cpuSeconds();
        if (Number.isFinite(value) && value >= 0) helperCpuSeconds = value;
      } catch { /* Diagnostics cannot change capture or cleanup behavior. */ }
    }
    return { sessions: sessions.length, activeSessions: active.length, helperCpuSeconds,
      keepRendererActive: this.config.keepRendererActive === true,
      rendererActivityLeases: sessions.filter(value => value.releaseRendererActivity !== undefined).length,
      cpuDeliveryScheduling: cpuOwnership === 'copy-complete' ? 'yield' : storage === 'cpu' ? this.config.cpuDeliveryScheduling ?? 'immediate' : 'immediate',
      cpuOwnership, ...this.cpuOwnershipCounters,
      cpuPatchedFrames: this.cpuPatchedFrames, cpuPatchedBytes: this.cpuPatchedBytes, cpuSourceBytes: this.cpuSourceBytes,
      activeNativeLeases: sessions.reduce((sum, value) => sum + (value.cpuPipeline?.snapshot().activeNativeLeases ?? value.cpuDelivery?.snapshot().inFlight ?? 0), 0),
      mainBuffersInUse: sessions.reduce((sum, value) => sum + (value.cpuPipeline?.snapshot().mainBuffersInUse ?? value.cpuDelivery?.snapshot().inFlight ?? 0), 0),
      pendingFrames: sessions.reduce((sum, value) => sum + (value.cpuPipeline?.snapshot().pendingFrames ?? 0), 0),
      pixelFormat: active.length === 1 ? active[0].ready?.pixelFormat ?? null : null,
      frameStorage: active.length === 1 ? active[0].ready?.storage ?? null : null,
      cpuFramesInFlight: sessions.reduce((sum, value) => sum + (value.cpuDelivery?.snapshot().inFlight ?? 0), 0),
      cpuFrameBuffers: sessions.reduce((sum, value) => sum + (value.cpuPipeline?.snapshot().allocatedBuffers ?? value.cpuBuffers?.size ?? 0), 0),
      helpers: sessions.filter(value => !value.closed).length,
      childHandles: sessions.filter(value => value.childHandles && !value.childHandlesClosed).length,
      imports: [...leases].filter(value => value.imported && !value.mainReleased).length +
        sessions.reduce((sum, value) => sum + (value.cachedTextures?.size ?? 0), 0),
      pendingReferences: [...leases].filter(value => (value.imported || value.cachedFrameSent) && !value.referencesReleased).length,
      busySlots: sessions.reduce((sum, value) => sum + value.leases.size + (value.cpuPipeline?.snapshot().activeNativeLeases ?? value.cpuDelivery?.snapshot().inFlight ?? 0), 0), started: this.started, stopped: this.stopped,
      frames: this.frames, refreshFrames: this.refreshFrames, transferredFrames: this.transferredFrames,
      releasedFrames: this.releasedFrames, textureImports: this.textureImports, lastEndReason: this.lastEndReason,
      disabled: this.disabledAfterFailure, failureCode: this.failureCode,
      timing: this.config.timing ? Object.fromEntries(Object.entries(this.timing).map(([name, metric]) =>
        [name, { ...metric, buckets: [...metric.buckets] }])) : null };
  }

  private recordTiming(stage: TimingStage, startedAt: number | undefined): void {
    if (startedAt === undefined) return;
    this.recordDuration(stage, performance.now() - startedAt);
  }

  private recordDuration(stage: TimingStage, elapsed: number): void {
    if (!this.config.timing) return;
    if (!Number.isFinite(elapsed) || elapsed < 0) return;
    const metric = this.timing[stage];
    metric.count++; metric.totalMs += elapsed; metric.maxMs = Math.max(metric.maxMs, elapsed);
    const bucket = TIMING_BUCKET_LIMITS_MS.findIndex(limit => elapsed <= limit);
    metric.buckets[bucket < 0 ? TIMING_BUCKET_LIMITS_MS.length : bucket]++;
  }

  private disable(reason: FailureCode): void {
    this.disabledAfterFailure = true;
    this.failureCode = reason;
  }

  private receive(session: Session, chunk: Buffer): void {
    if (!session.active) return;
    if (!Buffer.isBuffer(chunk) || chunk.length > MAX_CHUNK_BYTES || session.pending.length + chunk.length > MAX_CHUNK_BYTES) {
      this.retire(session, 'invalid_protocol', true); return;
    }
    session.pending = Buffer.concat([session.pending, chunk]);
    while (session.active) {
      const end = session.pending.indexOf(10);
      if (end < 0) {
        if (session.pending.length > MAX_LINE_BYTES) this.retire(session, 'invalid_protocol', true);
        return;
      }
      if (end > MAX_LINE_BYTES) { this.retire(session, 'invalid_protocol', true); return; }
      const line = session.pending.subarray(0, end);
      session.pending = session.pending.subarray(end + 1);
      let message: unknown;
      try { message = JSON.parse(line.toString('utf8')); }
      catch { this.retire(session, 'invalid_protocol', true); return; }
      if (!record(message)) { this.retire(session, 'invalid_protocol', true); return; }
      if (message.type === 'ready') this.ready(session, message);
      else if (message.type === 'frame') this.frame(session, message);
      else if (message.type === 'error' || message.type === 'done') this.retire(session, 'helper_failed', true);
      else this.retire(session, 'invalid_protocol', true);
    }
  }

  private ready(session: Session, message: Record<string, unknown>): void {
    const bgra = message.protocol === 2 && (message.pixelFormat === undefined || message.pixelFormat === 'bgra');
    // Protocol-4 peers predating this contract emitted only BT709. An absent
    // declaration can never satisfy a BT601 request.
    const cpuColorSpace = message.colorSpace === undefined ? 'bt709-limited' : message.colorSpace;
    const cpu = message.protocol === 4 && message.storage === 'cpu' && message.pixelFormat === 'nv12' &&
      (cpuColorSpace === 'bt601-limited' || cpuColorSpace === 'bt709-limited') && cpuColorSpace === session.options.colorSpace;
    const nv12 = cpu || (message.protocol === 3 && message.pixelFormat === 'nv12' && message.colorSpace === 'bt709-limited');
    const pixelFormat = nv12 ? 'nv12' : 'bgra';
    const storage = cpu ? 'cpu' : 'gpu';
    if (session.ready || (!bgra && !nv12) || pixelFormat !== session.pixelFormat ||
      storage !== session.storage || (!cpu && message.storage !== undefined) ||
      message.poolSize !== NATIVE_SCREEN_POOL_SIZE || message.cursorSupported !== true ||
      !integer(message.sourceWidth, 2, 16384) || !integer(message.sourceHeight, 2, 16384) ||
      message.sourceWidth < message.sourceHeight || Math.abs(message.sourceWidth - session.selection.sourceWidth!) > 2 ||
      Math.abs(message.sourceHeight - session.selection.sourceHeight!) > 2) {
      this.retire(session, 'invalid_protocol', true); return;
    }
    const scale = Math.min(1, session.options.maxWidth / message.sourceWidth, session.options.maxHeight / message.sourceHeight);
    const width = Math.floor((message.sourceWidth * scale + 1e-9) / 2) * 2;
    const height = Math.floor((message.sourceHeight * scale + 1e-9) / 2) * 2;
    if (width < 2 || height < 2 || message.width !== width || message.height !== height) {
      this.retire(session, 'invalid_protocol', true); return;
    }
    session.ready = { width, height, sourceWidth: message.sourceWidth, sourceHeight: message.sourceHeight, pixelFormat, storage,
      ...(cpu ? { colorSpace: cpuColorSpace as NativeScreenColorSpace } : {}) };
    if (cpu && session.cpuOwnership === 'copy-complete') {
      const useCpuPatches = session.packedScreenCapture && this.config.cpuPatches === true;
      const readRowsDirectly = useCpuPatches && typeof session.childHandles?.readFrameCachedRowsInto === 'function';
      const fullBytes = width * height * 3 / 2;
      let previousPatchSerial: number | undefined;
      let patchBuffer: ArrayBuffer | undefined;
      session.cpuPipeline = createNativeCpuBufferPipeline({ requestId: session.requestId, sessionId: session.sessionId,
        width, height, colorSpace: session.ready.colorSpace!, fps: session.options.fps,
        reuseSerializedBuffer: useCpuPatches,
        frameBytes: readRowsDirectly ? ({ update, serial }) =>
          update && previousPatchSerial === serial - 1 ? width * update[3] * 3 / 2 : fullBytes : undefined,
        readFrame: (handle, target, metadata) => {
          if (!session.active || session.childHandlesClosed) throw new Error('inactive_session');
          if (target.byteLength === fullBytes) session.childHandles!.readFrameCachedInto!(metadata.slot, handle, target);
          else {
            const [, y, , rows] = metadata.update!;
            session.childHandles!.readFrameCachedRowsInto!(metadata.slot, handle, target, width, height, y, rows);
          }
          this.cpuSourceBytes += target.byteLength;
        },
        // One write preserves command order without waiting to submit a second write.
        // Pipe delivery is still a byte stream; errors retire the session as before.
        releaseSource: metadata => this.command(session,
          `imported ${metadata.slot} ${metadata.serial}\nreleased ${metadata.slot} ${metadata.serial}\n`),
        send: (metadata, data) => {
          if (!session.active) throw new Error('inactive_session');
          const region = useCpuPatches ? metadata.update : undefined;
          if (region && previousPatchSerial === metadata.serial - 1) {
            const patchBytes = width * region[3] * 3 / 2;
            if (data.byteLength === fullBytes) {
              if (patchBuffer?.byteLength !== patchBytes) patchBuffer = new ArrayBuffer(patchBytes);
              copyCpuFrameRows(data, patchBuffer, width, height, region);
              data = patchBuffer;
            }
            session.frame.send('cove:native-screen:cpu-frame', metadata, data, previousPatchSerial);
            this.cpuPatchedFrames++; this.cpuPatchedBytes += patchBytes;
          } else {
            // A gap or a full desktop update invalidates the renderer's reference.
            patchBuffer = undefined;
            if (region) session.frame.send('cove:native-screen:cpu-frame', metadata, data, 0);
            else session.frame.send('cove:native-screen:cpu-frame', metadata, data);
          }
          previousPatchSerial = region ? metadata.serial : undefined;
          this.frames++; if (metadata.refresh) this.refreshFrames++;
        },
        onFinalAck: () => {
          if (!session.active) return false;
          this.transferredFrames++; this.releasedFrames++; return true;
        },
        onFailure: code => this.retire(session, code, true),
        onCounter: counter => { this.cpuOwnershipCounters[counter]++; },
        ...(this.config.timing ? { onTiming: (stage: TimingStage, duration: number) => this.recordDuration(stage, duration) } : {}),
      });
      session.cpuDelivery = session.cpuPipeline;
    } else if (cpu) {
      session.cpuDelivery = createNativeCpuFrameDelivery({ requestId: session.requestId, sessionId: session.sessionId, width, height,
        colorSpace: session.ready.colorSpace!,
        deliveryScheduling: this.config.cpuDeliveryScheduling,
        readFrame: (handle, byteLength, metadata) => {
          const childHandles = session.childHandles!;
          if (this.handles?.supportsCachedCpuFramesInto === true && typeof childHandles.readFrameCachedInto === 'function') {
            // The delivery lease prevents slot reuse until the renderer has consumed
            // its independent IPC clone. Keep only three main-owned buffers per session.
            const buffers = session.cpuBuffers ??= new Map();
            let buffer = buffers.get(metadata.slot);
            if (!buffer) { buffer = new ArrayBuffer(byteLength); buffers.set(metadata.slot, buffer); }
            childHandles.readFrameCachedInto(metadata.slot, handle, buffer);
            this.cpuOwnershipCounters.sourceCopied++;
            return buffer;
          }
          const data = this.handles?.supportsCachedCpuFrames === true && typeof childHandles.readFrameCached === 'function'
            ? childHandles.readFrameCached(metadata.slot, handle, byteLength)
            : childHandles.readFrame!(handle, byteLength);
          this.cpuOwnershipCounters.sourceCopied++; return data;
        },
        onImported: metadata => {
          if (!this.command(session, `imported ${metadata.slot} ${metadata.serial}\n`)) return false;
          this.frames++; if (metadata.refresh) this.refreshFrames++; return true;
        },
        send: (metadata, data) => {
          if (!session.active) throw new Error('inactive_session');
          session.frame.send('cove:native-screen:cpu-frame', metadata, data);
          this.cpuOwnershipCounters.mainSent++;
        },
        onReleased: metadata => {
          if (!this.command(session, `released ${metadata.slot} ${metadata.serial}\n`)) return false;
          this.cpuOwnershipCounters.sourceReleased++; this.cpuOwnershipCounters.finalAck++;
          this.transferredFrames++; this.releasedFrames++; return true;
        },
        onFailure: code => this.retire(session, code, true),
        ...(this.config.timing ? { onTiming: (stage: TimingStage, duration: number) => this.recordDuration(stage, duration) } : {}),
      });
    }
    clearTimeout(session.startTimer); session.startTimer = undefined;
    this.watchHealth(session);
    session.resolveStart({ ok: true, sessionId: session.sessionId, width, height, ...(nv12 ? { pixelFormat: 'nv12' as const } : {}),
      ...(session.packedScreenCapture ? { preferredContentHint: 'detail' as const } : {}),
      ...(cpu ? { storage: 'cpu' as const, colorSpace: session.ready.colorSpace! } : {}) });
  }

  private frame(session: Session, message: Record<string, unknown>): void {
    if (!session.ready || !integer(message.slot, 0, NATIVE_SCREEN_POOL_SIZE - 1) || session.leases.has(message.slot) ||
      !integer(message.serial, 1, Number.MAX_SAFE_INTEGER) || message.serial <= session.lastSerial ||
      !integer(message.timestamp, 1, Number.MAX_SAFE_INTEGER) || message.timestamp <= session.lastTimestamp ||
      message.width !== session.ready.width || message.height !== session.ready.height || typeof message.refresh !== 'boolean' ||
      (session.ready.pixelFormat === 'nv12' ? message.pixelFormat !== 'nv12' :
        (message.pixelFormat !== undefined && message.pixelFormat !== 'bgra')) ||
      (session.ready.storage === 'cpu' ? message.storage !== 'cpu' || message.byteLength !== session.ready.width * session.ready.height * 3 / 2 : message.storage !== undefined) ||
      (session.ready.storage === 'cpu' && (message.colorSpace === undefined ? 'bt709-limited' : message.colorSpace) !== session.ready.colorSpace) ||
      typeof message.handle !== 'string' || !/^0x[0-9a-f]{1,16}$/i.test(message.handle) ||
      BigInt(message.handle) === 0n || BigInt(message.handle) === 0xffffffffffffffffn) {
      this.retire(session, 'invalid_protocol', true); return;
    }
    const update = this.config.cpuPatches && session.packedScreenCapture && !message.refresh
      ? cpuFrameRegion(message.update, session.ready.width, session.ready.height) : undefined;
    const metadata: NativeScreenFrame = { requestId: session.requestId, sessionId: session.sessionId, slot: message.slot,
      serial: message.serial, width: session.ready.width, height: session.ready.height,
      timestamp: message.timestamp, refresh: message.refresh,
      ...(session.ready.pixelFormat === 'nv12' ? { pixelFormat: 'nv12' as const } : {}),
      ...(session.ready.storage === 'cpu' ? { storage: 'cpu' as const, colorSpace: session.ready.colorSpace! } : {}),
      ...(update ? { update } : {}) };
    if (session.ready.storage === 'cpu') {
      session.lastSerial = metadata.serial; session.lastTimestamp = metadata.timestamp;
      this.watchHealth(session);
      const handle = Buffer.alloc(8); handle.writeBigUInt64LE(BigInt(message.handle));
      try { session.cpuDelivery!.deliver(metadata, handle); }
      finally { handle.fill(0); }
      return;
    }
    const lease: Lease = { metadata, createdAt: this.config.timing ? performance.now() : undefined,
      mainReleased: false, importAcknowledged: false, transferSettled: false,
      transferComplete: false, permitSent: false, referencesReleased: false, credited: false };
    session.leases.set(metadata.slot, lease);
    session.lastSerial = metadata.serial;
    session.lastTimestamp = metadata.timestamp;
    this.watchHealth(session);
    if (session.cachedTextures) {
      this.sendCachedGpuFrame(session, lease, BigInt(message.handle));
      return;
    }
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(BigInt(message.handle));
    let owned: ReturnType<NativeScreenChildHandleBridge['duplicate']> | undefined;
    try {
      // The wire handle is local to our owned child. This bridge creates exactly
      // one temporary main-table handle; Electron imports its separate duplicate.
      owned = session.childHandles!.duplicate(handle);
      if (!Buffer.isBuffer(owned.handle) || owned.handle.length !== 8 || owned.handle.readBigUInt64LE() === 0n)
        throw new Error('invalid_owned_handle');
      lease.imported = sharedTexture.importSharedTexture({ textureInfo: { handle: { ntHandle: owned.handle },
        codedSize: { width: metadata.width, height: metadata.height }, pixelFormat: session.ready.pixelFormat, timestamp: metadata.timestamp,
        ...(session.ready.pixelFormat === 'nv12' ? { colorSpace: gpuNv12ColorSpace } : {}) },
      allReferencesReleased: () => {
        this.recordTiming('reference', lease.createdAt);
        this.releasedFrames++;
        lease.referencesReleased = true;
        clearTimeout(lease.referenceTimer); lease.referenceTimer = undefined;
        this.credit(session, lease);
        this.cleanupLease(session, lease);
      } });
      this.textureImports++;
    } catch {
      this.retire(session, 'import_failed', true); return;
    } finally {
      handle.fill(0);
      try { owned?.close(); }
      catch { this.retire(session, 'import_failed', true); }
      if (Buffer.isBuffer(owned?.handle)) owned.handle.fill(0);
    }
    this.recordTiming('import', lease.createdAt);
    this.retainedLeases.add(lease);
    if (!session.active) { lease.transferSettled = true; this.releaseMain(session, lease); return; }
    if (!lease.referencesReleased) {
      lease.referenceTimer = setTimeout(() => this.retire(session, 'capture_stalled', true), CAPTURE_STALL_TIMEOUT_MS);
      lease.referenceTimer.unref();
    }
    if (!this.command(session, `imported ${metadata.slot} ${metadata.serial}\n`)) {
      lease.transferSettled = true; this.releaseMain(session, lease); return;
    }
    lease.importAcknowledged = true;
    this.frames++;
    if (metadata.refresh) this.refreshFrames++;
    // Keep the importing reference until the transfer has actually settled.
    lease.transferTimer = setTimeout(() => this.retire(session, 'transfer_failed', true), NATIVE_SCREEN_START_TIMEOUT_MS);
    lease.transferTimer.unref();
    let transfer: Promise<void>;
    const transferStartedAt = this.config.timing ? performance.now() : undefined;
    try { transfer = sharedTexture.sendSharedTexture({ frame: session.frame, importedSharedTexture: lease.imported }, metadata); }
    catch { transfer = Promise.reject(new Error('transfer_failed')); }
    void Promise.resolve(transfer).then(() => {
      lease.transferSettled = true;
      lease.transferComplete = true;
      this.recordTiming('transfer', transferStartedAt);
      this.transferredFrames++;
      this.releaseMain(session, lease);
      // Address the original frame: a navigation must never redirect an old permit.
      try { session.frame.send('cove:native-screen:release-permit', metadata); lease.permitSent = true; }
      catch { if (session.active) this.retire(session, 'target_unavailable', false); }
      this.credit(session, lease);
    }, () => {
      lease.transferSettled = true;
      this.releaseMain(session, lease);
      this.retire(session, 'transfer_failed', true);
    }).finally(() => {
      clearTimeout(lease.transferTimer); lease.transferTimer = undefined;
      this.cleanupLease(session, lease);
    });
  }

  private sendCachedGpuFrame(session: Session, lease: Lease, handleValue: bigint): void {
    const { metadata } = lease;
    const cache = session.cachedTextures!;
    let cached = cache.get(metadata.slot);
    if (cached && cached.handle !== handleValue) {
      this.retire(session, 'invalid_protocol', true);
      return;
    }
    if (!cached) {
      const handle = Buffer.alloc(8);
      handle.writeBigUInt64LE(handleValue);
      let owned: ReturnType<NativeScreenChildHandleBridge['duplicate']> | undefined;
      let texture: Electron.SharedTextureImportedSubtle | undefined;
      try {
        owned = session.childHandles!.duplicate(handle);
        if (!Buffer.isBuffer(owned.handle) || owned.handle.length !== 8 || owned.handle.readBigUInt64LE() === 0n)
          throw new Error('invalid_owned_handle');
        texture = sharedTexture.subtle.importSharedTexture({
          handle: { ntHandle: owned.handle }, pixelFormat: session.pixelFormat,
          codedSize: { width: metadata.width, height: metadata.height },
          ...(session.pixelFormat === 'nv12' ? { colorSpace: gpuNv12ColorSpace } : {}),
        });
        cached = { handle: handleValue, texture, transfer: texture.startTransferSharedTexture() };
        cache.set(metadata.slot, cached);
        this.textureImports++;
        this.recordTiming('import', lease.createdAt);
      } catch {
        try { texture?.release(); } catch { /* No frame can use this texture. */ }
        this.retire(session, 'import_failed', true);
        return;
      } finally {
        handle.fill(0);
        try { owned?.close(); } catch { this.retire(session, 'import_failed', true); }
        if (Buffer.isBuffer(owned?.handle)) owned.handle.fill(0);
      }
    }
    if (!this.command(session, `imported ${metadata.slot} ${metadata.serial}\n`)) return;
    this.frames++;
    if (metadata.refresh) this.refreshFrames++;
    lease.referenceTimer = setTimeout(() => this.retire(session, 'capture_stalled', true), CAPTURE_STALL_TIMEOUT_MS);
    lease.referenceTimer.unref();
    try {
      session.frame.send('cove:native-screen:cached-gpu-frame', metadata, cached.transfer);
      lease.cachedFrameSent = true;
    }
    catch { this.retire(session, 'transfer_failed', true); }
  }

  private releaseCachedTextures(session: Session): void {
    if (!session.cachedTextures) return;
    clearTimeout(session.cachedDrainTimer);
    session.cachedDrainTimer = undefined;
    session.leases.clear();
    for (const { texture } of session.cachedTextures.values()) {
      try { texture.release(); } catch { this.disable('release_failed'); }
    }
    session.cachedTextures.clear();
    if (session.closed) this.sessions.delete(session);
  }

  private releaseMain(session: Session, lease: Lease): void {
    if (lease.mainReleased || !lease.imported || !lease.transferSettled) return;
    lease.mainReleased = true;
    try { lease.imported.release(); }
    catch { this.retire(session, 'release_failed', true); }
    this.cleanupLease(session, lease);
  }

  private cleanupLease(session: Session, lease: Lease): void {
    if (lease.transferSettled && lease.mainReleased && lease.referencesReleased) this.retainedLeases.delete(lease);
    if (!session.active && session.leases.get(lease.metadata.slot) === lease &&
      (!lease.imported || (lease.transferSettled && lease.mainReleased && lease.referencesReleased)))
      session.leases.delete(lease.metadata.slot);
    if (session.closed && session.leases.size === 0) this.sessions.delete(session);
  }

  private watchHealth(session: Session): void {
    // Preserve the last-frame deadline without allocating a timer on every frame.
    if (session.healthTimer) { session.healthTimer.refresh(); return; }
    session.healthTimer = setTimeout(() => this.retire(session, 'capture_stalled', true), CAPTURE_STALL_TIMEOUT_MS);
    session.healthTimer.unref();
  }

  private credit(session: Session, lease: Lease): void {
    if (!session.active || session.closed || session.leases.get(lease.metadata.slot) !== lease || lease.credited ||
      !lease.importAcknowledged || !lease.transferComplete || !lease.mainReleased || !lease.permitSent || !lease.referencesReleased) return;
    lease.credited = true;
    if (this.command(session, `released ${lease.metadata.slot} ${lease.metadata.serial}\n`)) session.leases.delete(lease.metadata.slot);
  }

  private command(session: Session, line: string): boolean {
    if (!session.active || session.closed) return false;
    try {
      if (session.child.stdin.destroyed || session.child.stdin.writableLength > MAX_STDIN_BYTES) throw new Error('pipe_closed');
      session.child.stdin.write(line);
      return true;
    } catch { this.retire(session, 'helper_failed', true); return false; }
  }

  private retire(session: Session, reason: FailureCode, failed: boolean): void {
    if (!session.active) return;
    session.active = false;
    const releaseRendererActivity = session.releaseRendererActivity;
    session.releaseRendererActivity = undefined;
    releaseRendererActivity?.();
    session.cpuDelivery?.stop();
    session.cpuBuffers?.clear();
    session.cpuBuffers = undefined;
    this.lastEndReason = reason;
    this.stopped++;
    if (failed) this.disable(reason);
    clearTimeout(session.startTimer); session.startTimer = undefined;
    clearTimeout(session.healthTimer); session.healthTimer = undefined;
    if (session.childHandles && !session.childHandlesClosed) {
      session.childHandlesClosed = true;
      try { session.childHandles.close(); }
      catch { if (failed) this.disable('release_failed'); }
    }
    session.pending = Buffer.alloc(0);
    session.resolveStart({ ok: false, reason });
    if (!session.notified) {
      session.notified = true;
      try { session.frame.send('cove:native-screen:ended', { requestId: session.requestId, sessionId: session.sessionId, reason }); }
      catch { /* Target teardown already owns renderer references. */ }
    }
    for (const lease of session.leases.values()) {
      clearTimeout(lease.transferTimer); lease.transferTimer = undefined;
      clearTimeout(lease.referenceTimer); lease.referenceTimer = undefined;
      if (!session.cachedTextures) this.releaseMain(session, lease);
      else if (!lease.cachedFrameSent || lease.referencesReleased) session.leases.delete(lease.metadata.slot);
    }
    if (session.cachedTextures) {
      // Stop returns no further slot credits. Keep the imports until queued
      // renderer transfers finish, with a deadline for detached renderers.
      if (session.leases.size === 0 || session.target.isDestroyed()) this.releaseCachedTextures(session);
      else {
        session.cachedDrainTimer = setTimeout(() => this.releaseCachedTextures(session), NATIVE_SCREEN_START_TIMEOUT_MS);
        session.cachedDrainTimer.unref();
      }
    }
    try {
      if (!session.child.stdin.destroyed && session.child.exitCode === null && session.child.signalCode === null)
        session.child.stdin.end('stop\n');
    } catch { /* kill deadline below still owns this child */ }
    session.stopTimer = setTimeout(() => {
      if (!session.closed && session.child.exitCode === null && session.child.signalCode === null) {
        try { session.child.kill(); } catch { /* No process outside this session is ever signalled. */ }
      }
      // The child keeps its error guards and counts against the cap until close.
      session.resolveStop();
    }, NATIVE_SCREEN_STOP_TIMEOUT_MS);
    session.stopTimer.unref();
  }

  private finish(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.startTimer); clearTimeout(session.stopTimer);
    session.startTimer = undefined; session.stopTimer = undefined;
    session.detach();
    session.pending = Buffer.alloc(0);
    if (!session.cachedTextures) {
      for (const lease of session.leases.values()) {
        this.releaseMain(session, lease);
        this.cleanupLease(session, lease);
      }
    }
    if (session.leases.size === 0) this.sessions.delete(session);
    session.resolveStop();
  }
}
