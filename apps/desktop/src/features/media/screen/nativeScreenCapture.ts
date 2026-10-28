import type {
  NativeScreenFrame,
  NativeScreenOptions,
  NativeScreenStartResult,
} from '../../../../electron/native-screen-capture-protocol';

export interface NativeScreenBridge {
  readonly supported: boolean;
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
  framesReceived: number;
  refreshFrames: number;
  framesWritten: number;
  framesDroppedWhileBusy: number;
  totalWriteMs: number;
  maxWriteMs: number;
}

const captureDiagnostics = new WeakMap<MediaStreamTrack, NativeScreenCaptureDiagnostics>();

/** Aggregate metadata only. A caller cannot mutate the live counters. */
export function getNativeScreenCaptureDiagnostics(track: MediaStreamTrack): NativeScreenCaptureDiagnostics | null {
  const diagnostics = captureDiagnostics.get(track);
  return diagnostics ? { ...diagnostics } : null;
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
  let bridge: NativeScreenBridge;
  let stockTrack: MediaStreamTrack;
  let track: GeneratorTrack;
  let stream: MediaStream;
  let writer: WritableStreamDefaultWriter<VideoFrame>;
  try {
    const candidateBridge = typeof window === 'undefined' ? undefined :
      (window as Window & { coveNativeScreen?: NativeScreenBridge }).coveNativeScreen;
    const Generator = (globalThis as typeof globalThis & { MediaStreamTrackGenerator?: GeneratorConstructor }).MediaStreamTrackGenerator;
    const selectedTrack = stockStream.getVideoTracks()[0];
    if (!candidateBridge?.supported || !Generator || typeof MediaStream !== 'function' ||
        options.nativeResolution || options.signal.aborted || !options.isCurrent() ||
        !selectedTrack || selectedTrack.readyState !== 'live' ||
        selectedTrack.getSettings().displaySurface !== 'monitor' ||
        !Number.isInteger(options.maxWidth) || options.maxWidth < 2 || options.maxWidth > 4096 ||
        !Number.isInteger(options.maxHeight) || options.maxHeight < 2 || options.maxHeight > 2560 ||
        ![30, 60, 120].includes(options.fps)) return null;
    bridge = candidateBridge;
    stockTrack = selectedTrack;
    track = new Generator({ kind: 'video' });
    try {
      track.contentHint = options.contentHint;
      stream = new MediaStream([track]);
      writer = track.writable.getWriter();
    } catch {
      track.stop();
      return null;
    }
  } catch {
    return null;
  }

  const diagnostics: NativeScreenCaptureDiagnostics = {
    backend: 'native-gpu', framesReceived: 0, refreshFrames: 0, framesWritten: 0,
    framesDroppedWhileBusy: 0, totalWriteMs: 0, maxWriteMs: 0,
  };
  captureDiagnostics.set(track, diagnostics);
  const requestId = `native_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
  let session: Extract<NativeScreenStartResult, { ok: true }> | undefined;
  let stopped = false;
  let committed = false;
  let ready = false;
  let writing = false;
  let startIssued = false;
  let lastSerial = 0;
  let lastTimestamp = -1;
  let unsubscribeFrame = () => {};
  let unsubscribeEnded = () => {};
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let settingsPoll: ReturnType<typeof setTimeout> | undefined;
  let resolveCandidate!: (candidate: NativeCaptureCandidate | null) => void;
  const outcome = new Promise<NativeCaptureCandidate | null>((resolve) => { resolveCandidate = resolve; });
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => { resolveCancelled = resolve; });
  const originalStop = track.stop.bind(track);

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
      return !options.signal.aborted && options.isCurrent() && stockTrack.readyState === 'live';
    } catch {
      return false;
    }
  }

  function stop(unexpected = false) {
    if (stopped) return;
    stopped = true;
    if (deadline !== undefined) clearTimeout(deadline);
    if (settingsPoll !== undefined) clearTimeout(settingsPoll);
    settingsPoll = undefined;
    options.signal.removeEventListener('abort', onCancelled);
    stockTrack.removeEventListener('ended', onCancelled);
    track.removeEventListener('ended', onTrackEnded);
    try { unsubscribeFrame(); } catch { /* Continue releasing the other resources. */ }
    try { unsubscribeEnded(); } catch { /* Continue releasing the other resources. */ }
    resolveCancelled();
    try { originalStop(); } catch { /* Still release the helper if a track is already invalid. */ }
    // Do not block stock fallback on an IPC or WritableStream promise.
    try {
      void writer.abort().catch(() => {}).finally(() => {
        try { writer.releaseLock(); } catch { /* A browser may already have released it. */ }
      });
    } catch {
      try { writer.releaseLock(); } catch { /* No owned writer remains usable. */ }
    }
    if (startIssued) stopBridge(unexpected);
    resolveCandidate(null);
    // stop() itself does not fire ended. Existing sharing teardown handles this fault.
    if (unexpected && committed) track.dispatchEvent(new Event('ended'));
  }

  function onCancelled() { stop(); }
  function onTrackEnded() { stop(true); }

  function checkFirstFrameSettings() {
    if (stopped || ready || !session) return;
    if (!current()) { stop(); return; }
    if (track.readyState !== 'live') { stop(true); return; }
    try {
      const settings = track.getSettings();
      if (settings.width === session.width && settings.height === session.height) {
        ready = true;
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
      stop(true);
    }
  }

  const candidate: NativeCaptureCandidate = {
    stream,
    commit() {
      if (stopped || !ready || track.readyState !== 'live') return;
      if (!current()) { stop(); return; }
      committed = true;
      options.signal.removeEventListener('abort', onCancelled);
      stockTrack.removeEventListener('ended', onCancelled);
    },
    stop() { stop(); },
  };
  async function onFrame(frame: VideoFrame, metadata: NativeScreenFrame): Promise<void> {
    let ownsWrite = false;
    try {
      if (stopped) return;
      if (!current()) { stop(); return; }
      // The start response establishes the only accepted session; never buffer early frames.
      if (!session || metadata.requestId !== requestId || metadata.sessionId !== session.sessionId) return;
      if (!Number.isInteger(metadata.slot) || metadata.slot < 0 || metadata.slot >= POOL_SIZE ||
          !Number.isSafeInteger(metadata.serial) || metadata.serial <= lastSerial ||
          !Number.isSafeInteger(metadata.timestamp) || metadata.timestamp < 0 || metadata.timestamp < lastTimestamp ||
          typeof metadata.refresh !== 'boolean') return;
      if (metadata.width !== session.width || metadata.height !== session.height ||
          frame.displayWidth !== session.width || frame.displayHeight !== session.height ||
          frame.timestamp !== metadata.timestamp) {
        console.warn('[native-screen] frame_metadata_error', {
          width: frame.displayWidth, height: frame.displayHeight, timestampMatches: frame.timestamp === metadata.timestamp,
          expectedWidth: session.width, expectedHeight: session.height,
        });
        stop(true); return;
      }
      lastSerial = metadata.serial;
      lastTimestamp = metadata.timestamp;
      diagnostics.framesReceived++;
      if (metadata.refresh) diagnostics.refreshFrames++;
      // There is at most one retained callback/write, regardless of the producer cadence.
      if (writing) { diagnostics.framesDroppedWhileBusy++; return; }
      writing = true;
      ownsWrite = true;
      const writeStartedAt = performance.now();
      const write = writer.write(frame);
      void write.then(() => {
        const writeMs = performance.now() - writeStartedAt;
        diagnostics.framesWritten++;
        diagnostics.totalWriteMs += writeMs;
        diagnostics.maxWriteMs = Math.max(diagnostics.maxWriteMs, writeMs);
      }, () => {});
      await Promise.race([write, cancelled]);
      if (stopped) return;
      if (!current()) { stop(); return; }
      if (track.readyState !== 'live') { stop(true); return; }
      // Metadata and actual frame geometry stay checked above on every frame.
      // Settings may lag; they are only a prerequisite for initial readiness.
      if (!ready) checkFirstFrameSettings();
    } catch (error) {
      console.warn('[native-screen] frame_write_error', error instanceof Error ? error.name : 'unknown');
      stop(true);
    } finally {
      if (ownsWrite) writing = false;
      try { frame.close(); } catch { /* Always settle the preload's frame-release barrier. */ }
    }
  }

  try {
    // Existing publisher stop paths must also release the helper and writer.
    track.stop = () => stop();
    deadline = setTimeout(() => stop(), START_TIMEOUT_MS);
    options.signal.addEventListener('abort', onCancelled, { once: true });
    stockTrack.addEventListener('ended', onCancelled, { once: true });
    track.addEventListener('ended', onTrackEnded, { once: true });
    unsubscribeFrame = bridge.onFrame(requestId, onFrame);
    if (stopped) unsubscribeFrame();
    unsubscribeEnded = bridge.onEnded(requestId, () => stop(true));
    if (stopped) unsubscribeEnded();
    if (stopped || !current()) { stop(); return outcome; }
    startIssued = true;
    void bridge.start(requestId, { maxWidth: options.maxWidth, maxHeight: options.maxHeight, fps: options.fps }).then((result) => {
      // A helper may finish starting after the cancellation IPC. Retire that late session too.
      if (stopped) { if (result.ok) stopBridge(); return; }
      if (!current()) { stop(); return; }
      if (!result.ok || typeof result.sessionId !== 'string' || !result.sessionId ||
          !validDimensions(result.width, result.height, options)) { stop(); return; }
      session = result;
    }).catch(() => stop());
  } catch {
    stop();
  }
  return outcome;
}
