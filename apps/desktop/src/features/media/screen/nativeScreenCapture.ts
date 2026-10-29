import type {
  NativeScreenFrame,
  NativeScreenOptions,
  NativeScreenStartResult,
} from '../../../../electron/native-screen-capture-protocol';
import { nativeScreenFailureReason, type NativeScreenFailureReason } from '../../../../electron/native-screen-capture-diagnostics';
import { createNativeFrameWriteQueue } from './nativeFrameWriteQueue';
import { createNativeCanvasFrameSink, getNativeCanvasFrameFailureCode, type NativeCanvasFrameSinkSnapshot } from './nativeCanvasFrameSink';
import { createNativeWorkerFrameSink, type NativeWorkerFrameSinkSnapshot } from './nativeWorkerFrameSink';

export interface NativeScreenBridge {
  readonly supported: boolean;
  readonly preferredFrameSink?: 'canvas' | 'worker';
  start(requestId: string, options: NativeScreenOptions): Promise<NativeScreenStartResult>;
  stop(requestId: string, fault?: 'renderer_failed' | 'receiver_failed'): Promise<boolean>;
  onFrame(requestId: string, callback: (frame: VideoFrame, metadata: NativeScreenFrame) => Promise<void>): () => void;
  onEnded(requestId: string, callback: (reason: string) => void): () => void;
}

export interface NativeCaptureCandidate {
  stream: MediaStream;
  /** The publisher owns releasing stock after its replaceTrack transaction succeeds. */
  commit(): void;
  stop(): void;
}

export interface NativeScreenCaptureOptions extends NativeScreenOptions {
  nativeResolution: boolean;
  contentHint: string;
  isCurrent(): boolean;
  signal: AbortSignal;
}

export interface NativeScreenCaptureDiagnostics {
  backend: 'native-gpu';
  frameSink: 'generator' | 'canvas' | 'worker';
  pixelFormat: 'bgra' | 'nv12';
  frameStorage: 'gpu' | 'cpu';
  framesReceived: number;
  refreshFrames: number;
  framesWritten: number;
  framesDroppedWhileBusy: number;
  totalWriteMs: number;
  maxWriteMs: number;
  framesDroppedExpired: number;
  totalQueueAgeMs: number;
  maxQueueAgeMs: number;
  totalWriteIdleMs: number;
  maxWriteIdleMs: number;
  writesOverFramePeriod: number;
  /** On-demand aggregate observation; never populated by per-frame allocation. */
  canvas?: NativeCanvasFrameSinkSnapshot;
  worker?: NativeWorkerFrameSinkSnapshot;
}

const captureDiagnostics = new WeakMap<MediaStreamTrack, NativeScreenCaptureDiagnostics>();
const canvasDiagnostics = new WeakMap<MediaStreamTrack, () => NativeCanvasFrameSinkSnapshot>();
const workerDiagnostics = new WeakMap<MediaStreamTrack, () => NativeWorkerFrameSinkSnapshot>();

/** Aggregate metadata only. A caller cannot mutate the live counters. */
export function getNativeScreenCaptureDiagnostics(track: MediaStreamTrack): NativeScreenCaptureDiagnostics | null {
  const diagnostics = captureDiagnostics.get(track);
  if (!diagnostics) return null;
  const canvas = canvasDiagnostics.get(track)?.();
  const worker = workerDiagnostics.get(track)?.();
  return { ...diagnostics, ...(canvas ? { canvas } : {}), ...(worker ? { worker } : {}) };
}

export type NativeScreenCaptureAttemptPhase =
  'starting' | 'helper-ready' | 'frame-written' | 'settings-ready' | 'committed' | 'stopped';
export type NativeScreenCaptureStopReason =
  'deadline_timeout' | 'abort' | 'stock_ended' | 'not_current' | 'native_ended' | 'frame_error' |
  'normal_stop' | 'start_rejected' | 'invalid_start_result' | 'start_error' | 'setup_error' | 'ineligible';
export interface NativeScreenCaptureAttempt {
  phase: NativeScreenCaptureAttemptPhase;
  /** All stage times are elapsed from this attempt's entry, except the explicit duration. */
  elapsedMs: number;
  bridgeStartMs: number | null;
  helperResponseMs: number | null;
  helperResponseDurationMs: number | null;
  helperResponseOk: boolean | null;
  startFailureReason: NativeScreenFailureReason | null;
  backendEndReason: NativeScreenFailureReason | null;
  firstFrameMs: number | null;
  firstWriteMs: number | null;
  settingsReadyMs: number | null;
  committedMs: number | null;
  stoppedMs: number | null;
  stopReason: NativeScreenCaptureStopReason | null;
  /** Failure-only, fixed aggregate metadata; never a frame, timestamp or identifier. */
  canvasFailure?: Readonly<{ code: ReturnType<typeof getNativeCanvasFrameFailureCode>; snapshot: NativeCanvasFrameSinkSnapshot | null }>;
}
type CaptureAttemptState = Omit<NativeScreenCaptureAttempt, 'elapsedMs'> & { startedAt: number };
let lastCaptureAttempt: CaptureAttemptState | undefined;

/** One bounded attempt, without source or session identifiers. Each read is detached and frozen. */
export function getLastNativeScreenCaptureAttempt(): Readonly<NativeScreenCaptureAttempt> | null {
  if (!lastCaptureAttempt) return null;
  const { startedAt, ...snapshot } = lastCaptureAttempt;
  return Object.freeze({ ...snapshot, elapsedMs: snapshot.stoppedMs ?? Math.max(0, performance.now() - startedAt) });
}

type GeneratorTrack = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type GeneratorConstructor = new (options: { kind: 'video' }) => GeneratorTrack;

const START_TIMEOUT_MS = 1_500;
const POOL_SIZE = 3;
const SETTINGS_POLL_MS = 5;

function validDimensions(width: number, height: number, options: NativeScreenOptions): boolean {
  return Number.isInteger(width) && Number.isInteger(height) &&
    width >= 2 && height >= 2 && width <= options.maxWidth && height <= options.maxHeight;
}

/** Attempt an upgrade of an already published stock stream, without acquiring another source. */
export async function tryNativeScreenCapture(
  stockStream: MediaStream,
  options: NativeScreenCaptureOptions,
): Promise<NativeCaptureCandidate | null> {
  // Async callbacks retain this attempt only; a late predecessor cannot replace
  // the single current diagnostic record installed by a newer invocation.
  const attempt: CaptureAttemptState = {
    startedAt: performance.now(), phase: 'starting', bridgeStartMs: null,
    helperResponseMs: null, helperResponseDurationMs: null, helperResponseOk: null,
    startFailureReason: null, backendEndReason: null,
    firstFrameMs: null, firstWriteMs: null, settingsReadyMs: null, committedMs: null,
    stoppedMs: null, stopReason: null,
  };
  lastCaptureAttempt = attempt;
  const attemptElapsed = () => Math.max(0, performance.now() - attempt.startedAt);
  function finishAttempt(reason: NativeScreenCaptureStopReason) {
    if (attempt.stoppedMs !== null) return;
    attempt.phase = 'stopped'; attempt.stopReason = reason; attempt.stoppedMs = attemptElapsed();
  }
  let bridge: NativeScreenBridge;
  let stockTrack: MediaStreamTrack;
  let track: GeneratorTrack;
  let stream: MediaStream;
  let writer: WritableStreamDefaultWriter<VideoFrame> | undefined;
  try {
    const candidateBridge = typeof window === 'undefined' ? undefined :
      (window as Window & { coveNativeScreen?: NativeScreenBridge }).coveNativeScreen;
    const Generator = (globalThis as typeof globalThis & { MediaStreamTrackGenerator?: GeneratorConstructor }).MediaStreamTrackGenerator;
    const selectedTrack = stockStream.getVideoTracks()[0];
    if (!candidateBridge?.supported || !Generator || typeof MediaStream !== 'function' || options.nativeResolution) {
      finishAttempt('ineligible'); return null;
    }
    if (options.signal.aborted) { finishAttempt('abort'); return null; }
    if (!options.isCurrent()) { finishAttempt('not_current'); return null; }
    if (selectedTrack && selectedTrack.readyState !== 'live') { finishAttempt('stock_ended'); return null; }
    if (!selectedTrack ||
        selectedTrack.getSettings().displaySurface !== 'monitor' ||
        !Number.isInteger(options.maxWidth) || options.maxWidth < 2 || options.maxWidth > 4096 ||
        !Number.isInteger(options.maxHeight) || options.maxHeight < 2 || options.maxHeight > 2560 ||
        ![30, 60, 120].includes(options.fps)) { finishAttempt('ineligible'); return null; }
    bridge = candidateBridge;
    stockTrack = selectedTrack;
    track = new Generator({ kind: 'video' });
    try {
      track.contentHint = options.contentHint;
      stream = new MediaStream([track]);
      // A Worker preference must transfer the unlocked writable directly once.
      // Every other route retains its existing Window writer.
      if (bridge.preferredFrameSink !== 'worker') writer = track.writable.getWriter();
    } catch {
      track.stop();
      finishAttempt('setup_error');
      return null;
    }
  } catch {
    finishAttempt('setup_error');
    return null;
  }

  const diagnostics: NativeScreenCaptureDiagnostics = {
    backend: 'native-gpu', frameSink: 'generator', pixelFormat: 'bgra', frameStorage: 'gpu', framesReceived: 0, refreshFrames: 0, framesWritten: 0,
    framesDroppedWhileBusy: 0, totalWriteMs: 0, maxWriteMs: 0,
    framesDroppedExpired: 0, totalQueueAgeMs: 0, maxQueueAgeMs: 0,
    totalWriteIdleMs: 0, maxWriteIdleMs: 0, writesOverFramePeriod: 0,
  };
  captureDiagnostics.set(track, diagnostics);
  const requestId = `native_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
  let session: Extract<NativeScreenStartResult, { ok: true }> | undefined;
  let stopped = false;
  let committed = false;
  let ready = false;
  let lastWriteCompletedAt: number | undefined;
  let canvasSink: ReturnType<typeof createNativeCanvasFrameSink> | undefined;
  let workerSink: ReturnType<typeof createNativeWorkerFrameSink> | undefined;
  let workerReady = false;
  let startIssued = false;
  let lastSerial = 0;
  let lastTimestamp = -1;
  let unsubscribeFrame = () => {};
  let unsubscribeEnded = () => {};
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let settingsPoll: ReturnType<typeof setTimeout> | undefined;
  let resolveCandidate!: (candidate: NativeCaptureCandidate | null) => void;
  const outcome = new Promise<NativeCaptureCandidate | null>((resolve) => { resolveCandidate = resolve; });
  const originalStop = track.stop.bind(track);
  let currentStopReason: NativeScreenCaptureStopReason = 'not_current';

  function stopBridge(unexpected = false) {
    try {
      const stopping = unexpected ? bridge.stop(requestId, 'renderer_failed') : bridge.stop(requestId);
      void stopping.catch(() => {});
    } catch { /* Cleanup must remain synchronous. */ }
  }

  function current(): boolean {
    // A new picker/intent may be cancelled. Keep its published predecessor alive
    // until the publisher has actually replaced it and calls track.stop().
    if (committed) return true;
    try {
      if (options.signal.aborted) { currentStopReason = 'abort'; return false; }
      if (!options.isCurrent()) { currentStopReason = 'not_current'; return false; }
      if (stockTrack.readyState !== 'live') { currentStopReason = 'stock_ended'; return false; }
      return true;
    } catch {
      currentStopReason = 'not_current';
      return false;
    }
  }

  function stop(unexpected = false, reason: NativeScreenCaptureStopReason = 'normal_stop') {
    if (stopped) return;
    stopped = true;
    finishAttempt(reason);
    writeQueue.stop();
    canvasSink?.stop();
    workerSink?.stop();
    if (deadline !== undefined) clearTimeout(deadline);
    if (settingsPoll !== undefined) clearTimeout(settingsPoll);
    settingsPoll = undefined;
    options.signal.removeEventListener('abort', onCancelled);
    stockTrack.removeEventListener('ended', onCancelled);
    track.removeEventListener('ended', onTrackEnded);
    try { unsubscribeFrame(); } catch { /* Continue releasing the other resources. */ }
    try { unsubscribeEnded(); } catch { /* Continue releasing the other resources. */ }
    try { originalStop(); } catch { /* Still release the helper if a track is already invalid. */ }
    // Do not block stock fallback on an IPC or WritableStream promise.
    if (writer) {
      const ownedWriter = writer;
      try {
        void ownedWriter.abort().catch(() => {}).finally(() => {
          try { ownedWriter.releaseLock(); } catch { /* A browser may already have released it. */ }
        });
      } catch {
        try { ownedWriter.releaseLock(); } catch { /* No owned writer remains usable. */ }
      }
    }
    if (startIssued) stopBridge(unexpected);
    resolveCandidate(null);
    // stop() itself does not fire ended. Existing sharing teardown handles this fault.
    if (unexpected && committed) track.dispatchEvent(new Event('ended'));
  }

  function onCancelled(event: Event) { stop(false, event.type === 'abort' ? 'abort' : 'stock_ended'); }
  function onTrackEnded() { stop(true, 'native_ended'); }

  function onWritten(writeMs: number, queueAgeMs: number) {
    if (!stopped && attempt.firstWriteMs === null) {
      attempt.firstWriteMs = attemptElapsed(); attempt.phase = 'frame-written';
    }
    diagnostics.framesWritten++;
    diagnostics.totalWriteMs += writeMs;
    diagnostics.maxWriteMs = Math.max(diagnostics.maxWriteMs, writeMs);
    diagnostics.totalQueueAgeMs += queueAgeMs;
    diagnostics.maxQueueAgeMs = Math.max(diagnostics.maxQueueAgeMs, queueAgeMs);
    if (writeMs > 1000 / options.fps) diagnostics.writesOverFramePeriod++;
    lastWriteCompletedAt = performance.now();
  }
  function onDropped(reason: 'superseded' | 'expired' | 'stopped') {
    diagnostics.framesDroppedWhileBusy++;
    if (reason === 'expired') diagnostics.framesDroppedExpired++;
  }
  function writeFrame(frame: VideoFrame): Promise<void> {
    if (lastWriteCompletedAt !== undefined) {
      const idleMs = Math.max(0, performance.now() - lastWriteCompletedAt);
      diagnostics.totalWriteIdleMs += idleMs;
      diagnostics.maxWriteIdleMs = Math.max(diagnostics.maxWriteIdleMs, idleMs);
    }
    if (!writer) return Promise.reject(new Error('Native Window writer unavailable'));
    return writer.write(frame);
  }
  const writeQueue = createNativeFrameWriteQueue<VideoFrame>({
    now: () => performance.now(),
    maxPendingAgeMs: 2 * 1000 / options.fps,
    write: writeFrame,
    onWritten,
    onDropped,
    onFailure(error) {
      console.warn('[native-screen] frame_write_error', error instanceof Error ? error.name : 'unknown');
      stop(true, 'frame_error');
    },
  });

  function checkFirstFrameSettings() {
    if (stopped || ready || !session) return;
    if (!current()) { stop(false, currentStopReason); return; }
    if (track.readyState !== 'live') { stop(true, 'native_ended'); return; }
    try {
      const settings = track.getSettings();
      if (settings.width === session.width && settings.height === session.height) {
        ready = true;
        attempt.settingsReadyMs = attemptElapsed(); attempt.phase = 'settings-ready';
        if (deadline !== undefined) clearTimeout(deadline);
        if (settingsPoll !== undefined) clearTimeout(settingsPoll);
        settingsPoll = undefined;
        resolveCandidate(candidate);
      } else if (settingsPoll === undefined) {
        // Electron publishes generator settings asynchronously after write()
        // resolves. This startup-only poll shares the original total deadline;
        // frame callbacks can keep writing and releasing their references.
        settingsPoll = setTimeout(() => {
          settingsPoll = undefined;
          checkFirstFrameSettings();
        }, SETTINGS_POLL_MS);
      }
    } catch {
      stop(true, 'frame_error');
    }
  }

  const candidate: NativeCaptureCandidate = {
    stream,
    commit() {
      if (stopped || !ready || track.readyState !== 'live') return;
      if (!current()) { stop(false, currentStopReason); return; }
      committed = true;
      if (attempt.committedMs === null) attempt.committedMs = attemptElapsed();
      attempt.phase = 'committed';
      options.signal.removeEventListener('abort', onCancelled);
      stockTrack.removeEventListener('ended', onCancelled);
    },
    stop() { stop(); },
  };
  async function onFrame(frame: VideoFrame, metadata: NativeScreenFrame): Promise<void> {
    try {
      if (stopped) return;
      if (attempt.firstFrameMs === null) attempt.firstFrameMs = attemptElapsed();
      if (!current()) { stop(false, currentStopReason); return; }
      // The start response establishes the only accepted session; never buffer early frames.
      if (!session || metadata.requestId !== requestId || metadata.sessionId !== session.sessionId) return;
      if (!Number.isInteger(metadata.slot) || metadata.slot < 0 || metadata.slot >= POOL_SIZE ||
          !Number.isSafeInteger(metadata.serial) || metadata.serial <= lastSerial ||
          !Number.isSafeInteger(metadata.timestamp) || metadata.timestamp < 0 || metadata.timestamp < lastTimestamp ||
          typeof metadata.refresh !== 'boolean') return;
      const pixelFormat = session.pixelFormat ?? 'bgra';
      const colorSpace = session.storage === 'cpu' ? session.colorSpace : 'bt709-limited';
      const matrix = colorSpace === 'bt601-limited' ? 'smpte170m' : 'bt709';
      const formatMatches = (metadata.pixelFormat ?? 'bgra') === pixelFormat && metadata.storage === session.storage &&
        (session.storage !== 'cpu' || (metadata.colorSpace === undefined ? 'bt709-limited' : metadata.colorSpace) === colorSpace) &&
        (pixelFormat !== 'nv12' || (frame.format === 'NV12' && frame.colorSpace.primaries === matrix &&
          frame.colorSpace.transfer === matrix && frame.colorSpace.matrix === matrix && frame.colorSpace.fullRange === false));
      if (!formatMatches || metadata.width !== session.width || metadata.height !== session.height ||
          frame.displayWidth !== session.width || frame.displayHeight !== session.height ||
          frame.timestamp !== metadata.timestamp) {
        console.warn('[native-screen] frame_metadata_error', {
          width: frame.displayWidth, height: frame.displayHeight, timestampMatches: frame.timestamp === metadata.timestamp,
          expectedWidth: session.width, expectedHeight: session.height,
          formatMatches,
        });
        stop(true, 'frame_error'); return;
      }
      lastSerial = metadata.serial;
      lastTimestamp = metadata.timestamp;
      diagnostics.framesReceived++;
      if (metadata.refresh) diagnostics.refreshFrames++;
      if (canvasSink) {
        // submit settles after draw (or discard), so the source import can be
        // retired independently of the one bounded Canvas conversion/write.
        await canvasSink.submit(frame, metadata.timestamp);
        return;
      }
      if (workerSink) {
        // The ACK releases this callback only. Imported texture credit still
        // waits for preload's permit and Electron allReferencesReleased.
        if (await workerSink.submit(frame) !== 'written') return;
        if (stopped) return;
        if (!current()) { stop(false, currentStopReason); return; }
        if (track.readyState !== 'live') { stop(true, 'native_ended'); return; }
        if (!ready) checkFirstFrameSettings();
        return;
      }
      // Retain only the latest pending frame while one conversion/write runs.
      // The callback stays pending until written, superseded or cancelled, so
      // preload and allReferencesReleased still own the actual GPU slot credit.
      if (await writeQueue.submit(frame) !== 'written') return;
      if (stopped) return;
      if (!current()) { stop(false, currentStopReason); return; }
      if (track.readyState !== 'live') { stop(true, 'native_ended'); return; }
      // Metadata and actual frame geometry stay checked above on every frame.
      // Settings may lag; they are only a prerequisite for initial readiness.
      if (!ready) checkFirstFrameSettings();
    } catch (error) {
      console.warn('[native-screen] frame_write_error', error instanceof Error ? error.name : 'unknown');
      stop(true, 'frame_error');
    } finally {
      try { frame.close(); } catch { /* Always settle the preload's frame-release barrier. */ }
    }
  }

  try {
    // Existing publisher stop paths must also release the helper and writer.
    track.stop = () => stop();
    deadline = setTimeout(() => stop(false, 'deadline_timeout'),
      bridge.preferredFrameSink === 'worker' ? Math.max(0, START_TIMEOUT_MS - attemptElapsed()) : START_TIMEOUT_MS);
    options.signal.addEventListener('abort', onCancelled, { once: true });
    stockTrack.addEventListener('ended', onCancelled, { once: true });
    track.addEventListener('ended', onTrackEnded, { once: true });
    unsubscribeFrame = bridge.onFrame(requestId, onFrame);
    if (stopped) unsubscribeFrame();
    unsubscribeEnded = bridge.onEnded(requestId, (reason) => {
      if (!stopped) attempt.backendEndReason = nativeScreenFailureReason(reason);
      stop(true, 'native_ended');
    });
    if (stopped) unsubscribeEnded();
    if (stopped || !current()) { stop(false, currentStopReason); return outcome; }
    startIssued = true;
    attempt.bridgeStartMs = attemptElapsed();
    void bridge.start(requestId, { maxWidth: options.maxWidth, maxHeight: options.maxHeight, fps: options.fps,
      ...(options.colorSpace ? { colorSpace: options.colorSpace } : {}) }).then((result) => {
      attempt.helperResponseMs = attemptElapsed();
      attempt.helperResponseDurationMs = Math.max(0, attempt.helperResponseMs - attempt.bridgeStartMs!);
      attempt.helperResponseOk = result.ok === true;
      if (!result.ok) attempt.startFailureReason = nativeScreenFailureReason(result.reason);
      // A helper may finish starting after the cancellation IPC. Retire that late session too.
      if (stopped) { if (result.ok) stopBridge(); return; }
      if (!current()) { stop(false, currentStopReason); return; }
      if (!result.ok || typeof result.sessionId !== 'string' || !result.sessionId ||
          (result.pixelFormat !== undefined && result.pixelFormat !== 'bgra' && result.pixelFormat !== 'nv12') ||
          (result.storage !== undefined && (result.storage !== 'cpu' || result.pixelFormat !== 'nv12')) ||
          (result.colorSpace !== undefined && result.colorSpace !== 'bt601-limited' && result.colorSpace !== 'bt709-limited') ||
          (result.storage === 'cpu' && ((result.colorSpace ?? 'bt709-limited') !== options.colorSpace)) ||
          (result.storage !== 'cpu' && result.colorSpace !== undefined) ||
          !validDimensions(result.width, result.height, options)) {
        stop(false, result.ok ? 'invalid_start_result' : 'start_rejected'); return;
      }
      session = { ...result, ...(result.storage === 'cpu' ? { colorSpace: result.colorSpace ?? 'bt709-limited' } : {}) };
      attempt.phase = 'helper-ready';
      diagnostics.pixelFormat = result.pixelFormat ?? 'bgra';
      diagnostics.frameStorage = result.storage ?? 'gpu';
      if (bridge.preferredFrameSink === 'worker') {
        if (result.storage === undefined && (result.pixelFormat ?? 'bgra') === 'bgra') {
          try {
            workerSink = createNativeWorkerFrameSink({
              writable: track.writable, width: result.width, height: result.height, fps: options.fps,
              startupTimeoutMs: START_TIMEOUT_MS - attemptElapsed(),
              onWritten(timing) {
                if (stopped) return;
                diagnostics.totalWriteIdleMs += timing.idleMs;
                diagnostics.maxWriteIdleMs = Math.max(diagnostics.maxWriteIdleMs, timing.idleMs);
                onWritten(timing.writeMs, timing.queueAgeMs);
              },
              onDropped,
              onFailure(reason) {
                console.warn('[native-screen] worker_frame_error', reason);
                stop(workerReady, workerReady ? 'frame_error' : 'setup_error');
              },
            });
            diagnostics.frameSink = 'worker';
            workerDiagnostics.set(track, workerSink.snapshot);
            void workerSink.ready.then(() => { workerReady = true; }, () => {});
            if (stopped) workerSink.stop();
          } catch {
            stop(false, 'setup_error');
          }
        } else {
          // CPU NV12 and unqualified formats keep the existing Window writer.
          try { writer = track.writable.getWriter(); }
          catch { stop(false, 'setup_error'); }
        }
      }
      // This route preserves the already-published AV1/BT709 contract. VP8's
      // verified CPU601 path and every unqualified format retain their writer.
      if (bridge.preferredFrameSink === 'canvas' && options.colorSpace === 'bt709-limited' &&
          result.storage === undefined && (result.pixelFormat ?? 'bgra') === 'bgra') {
        try {
          canvasSink = createNativeCanvasFrameSink({
            width: result.width, height: result.height, fps: options.fps, writer: { write: writeFrame },
            onWritten(writeMs, queueAgeMs) {
              if (stopped) return;
              onWritten(writeMs, queueAgeMs);
              if (!ready) checkFirstFrameSettings();
            },
            onDropped,
            onFailure(error) {
              const code = getNativeCanvasFrameFailureCode(error);
              attempt.canvasFailure = Object.freeze({ code, snapshot: canvasSink?.snapshot() ?? null });
              console.warn('[native-screen] canvas_frame_error', code);
              stop(true, 'frame_error');
            },
          });
          diagnostics.frameSink = 'canvas';
          canvasDiagnostics.set(track, canvasSink.snapshot);
          if (stopped) canvasSink.stop();
        } catch {
          stop(false, 'setup_error');
        }
      }
    }).catch(() => {
      if (attempt.helperResponseMs === null) {
        attempt.helperResponseMs = attemptElapsed();
        attempt.helperResponseDurationMs = Math.max(0, attempt.helperResponseMs - attempt.bridgeStartMs!);
      }
      if (attempt.helperResponseOk === null) attempt.helperResponseOk = false;
      stop(false, 'start_error');
    });
  } catch {
    stop(false, 'setup_error');
  }
  return outcome;
}
