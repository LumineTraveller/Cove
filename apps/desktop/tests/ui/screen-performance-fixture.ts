// Test-only source and safe counters for the real two-peer/SFU media fixture.
// Generated-source throughput does not measure Windows desktop capture.
import * as nativeScreenCaptureDiagnostics from '../../src/features/media/screen/nativeScreenCapture';
type VideoGenerator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type GeneratorConstructor = new (options: { kind: 'video' }) => VideoGenerator;
type SafeStat = Record<string, number | string | boolean | null>;
type PatternRect = { x: number; y: number; width: number; height: number };
type OwnedPatternRead = { markersMatched: boolean[]; capturedSequence: number | null;
  observerDrawCalls: number; observerDrawMs: number; observerReadMs: number;
  observerReadbackPixels: number; frameSnapshotCreated: boolean; frameSnapshotClosed: boolean;
  frameSnapshotMs: number; observerCopyMs: number; observerCopiedBytes: number;
  snapshotAt?: number | null;
  observerCopyCalls: number; observerCopyMaxMs: number;
  observerMethod: string; contentRect?: PatternRect;
  frameFormat: string | null; copyFormat: 'RGBA';
  frameColorSpace: { primaries: string | null; transfer: string | null; matrix: string | null; fullRange: boolean | null } | null;
  markerRgbAbsoluteErrorMaxima: { byMarker: Array<{ r: number; g: number; b: number; max: number }>;
    byChannel: { r: number; g: number; b: number }; max: number } | null;
  error?: string };

const VIDEO_FIELDS = [
  'timestamp', 'frames', 'framesPerSecond', 'width', 'height', 'frameWidth', 'frameHeight',
  'framesCaptured', 'framesEncoded', 'framesSent', 'framesReceived', 'framesDecoded',
  'framesDropped', 'keyFramesEncoded', 'keyFramesDecoded', 'bytesSent', 'bytesReceived',
  'packetsSent', 'packetsReceived', 'packetsLost', 'retransmittedBytesSent',
  'retransmittedPacketsSent', 'nackCount', 'pliCount', 'firCount', 'qpSum',
  'targetBitrate', 'totalEncodeTime', 'totalDecodeTime', 'totalPacketSendDelay',
  'jitter', 'jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay',
  'jitterBufferEmittedCount', 'totalProcessingDelay', 'totalInterFrameDelay',
  'freezeCount', 'totalFreezesDuration', 'qualityLimitationReason',
  'qualityLimitationResolutionChanges', 'encoderImplementation', 'decoderImplementation',
  'powerEfficientEncoder', 'powerEfficientDecoder', 'hugeFramesSent',
  'contentType', 'scalabilityMode',
] as const;

function positiveParameter(params: URLSearchParams, name: string, fallback: number, maximum: number) {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 && value <= maximum ? value : fallback;
}

function desiredNumber(value: ConstrainDouble | undefined, fallback: number) {
  if (typeof value === 'number') return Math.min(fallback, value);
  if (!value) return fallback;
  const preferred = typeof value.exact === 'number' ? value.exact : value.ideal;
  const result = typeof preferred === 'number' ? Math.min(fallback, preferred) : fallback;
  return typeof value.max === 'number' ? Math.min(result, value.max) : result;
}

function safeSettings(track: MediaStreamTrack) {
  const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
  return Object.fromEntries(['width', 'height', 'frameRate', 'aspectRatio', 'displaySurface']
    .map(key => [key, (settings as unknown as Record<string, unknown>)[key]])
    .filter(([, value]) => typeof value === 'number' || typeof value === 'string'));
}

// Error stacks contain renderer URLs and their authentication query. Retain
// only conservative V8 function-name tokens, never locations or raw lines.
export function screenPerformanceStackFunctionNames(stack: string | undefined): string[] {
  const names: string[] = [];
  for (const line of (stack ?? '').split('\n').slice(1, 24)) {
    const match = /^\s*at (?:async )?([A-Za-z_$][A-Za-z0-9_$.]{0,95})(?: \[as [A-Za-z_$][A-Za-z0-9_$]*\])?\s+\(/.exec(line);
    const name = match?.[1];
    if (!name || !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(name) ||
        /(?:^|\.)(?:screenPerformanceStackFunctionNames|recordStockTrackEvent|journaledStockStop)$/.test(name)) continue;
    names.push(name);
    if (names.length === 6) break;
  }
  return names;
}

export function generatedNv12Geometry(width: number, height: number): PatternRect {
  if (!Number.isInteger(width) || width < 1728 || width > 1920 || width % 2 !== 0 || height !== 1080)
    throw new Error('Generated NV12 requires even width 1728..1920 and height 1080');
  return { x: 2 * Math.floor((width - 1728) / 4), y: 0, width: 1728, height: 1080 };
}

/** Test pixels only: equal sequence means byte-identical active content at both widths. */
export function createGeneratedNv12Painter(width: number, height: number) {
  const contentRect = generatedNv12Geometry(width, height), yBytes = width * height;
  const base = new Uint8Array(yBytes * 3 / 2); base.fill(16, 0, yBytes); base.fill(128, yBytes);
  const even = (value: number) => 2 * Math.floor(value / 2);
  const yuv = ([r, g, b]: readonly number[]) => [
    Math.round(16 + .182586 * r + .614231 * g + .062007 * b),
    Math.round(128 - .100644 * r - .338572 * g + .439216 * b),
    Math.round(128 + .439216 * r - .398942 * g - .040274 * b),
  ];
  function rect(bytes: Uint8Array, x: number, y: number, w: number, h: number, color: number[]) {
    x += contentRect.x;
    for (let row = y; row < y + h; row++) bytes.fill(color[0], row * width + x, row * width + x + w);
    const uv = new Uint8Array(w);
    for (let column = 0; column < w; column += 2) { uv[column] = color[1]; uv[column + 1] = color[2]; }
    for (let row = y / 2; row < (y + h) / 2; row++) bytes.set(uv, yBytes + row * width + x);
  }
  rect(base, 0, 0, 1728, 1080, yuv([23, 50, 77]));
  for (const [rgb, x, y] of [[[232, 74, 95], 0, 0], [[65, 179, 163], even(.9 * 1728), 0],
    [[232, 208, 169], 0, 972], [[75, 46, 131], even(.9 * 1728), 972]] as const) {
    const markerWidth = x === 0 ? even(.1 * 1728) : 1728 - x;
    rect(base, x, y, markerWidth, 108, yuv(rgb));
  }
  const stripeX = even(.2 * 1728), stripeRight = even(.8 * 1728), stripe = new Uint8Array(stripeRight - stripeX);
  rect(base, stripeX, 432, stripe.length, 108, [16, 128, 128]);
  let closed = false;
  return { contentRect, bytesPerFrame: base.byteLength,
    next(sequence: number): ArrayBuffer {
      if (closed || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Generated NV12 painter is unavailable');
      const bytes = new Uint8Array(base), phase = sequence % 65536;
      for (let bit = 0; bit < 16; bit++) stripe.fill(phase & (1 << bit) ? 235 : 16,
        even((.2 + bit * .0375) * 1728) - stripeX, even((.2 + (bit + 1) * .0375) * 1728) - stripeX);
      for (let row = 432; row < 540; row++) bytes.set(stripe, row * width + contentRect.x + stripeX);
      rect(bytes, (phase * 34) % 1600, 640 + (phase * 14) % 204, 128, 128,
        yuv(phase % 2 ? [252, 186, 53] : [101, 215, 242]));
      return bytes.buffer;
    },
    close() { closed = true; base.fill(0); stripe.fill(0); },
  };
}

export function installScreenPerformanceFixture(
  params: URLSearchParams,
  peerConnections: Set<RTCPeerConnection>,
) {
  if (params.get('performance') !== '1') return;
  const sourceMode = params.get('source') === 'native' ? 'native' : 'generated';
  const generatedNv12Flag = params.get('generatedNv12');
  if (generatedNv12Flag !== null && !['0', '1'].includes(generatedNv12Flag)) throw new Error('Invalid generated NV12 option');
  const configuration = {
    source: sourceMode,
    width: Math.round(positiveParameter(params, 'width', 1920, 8192)),
    height: Math.round(positiveParameter(params, 'height', 1080, 8192)),
    fps: positiveParameter(params, 'fps', 120, 240),
    captureWidth: Math.round(positiveParameter(params, 'captureWidth', 0, 8192)),
    captureHeight: Math.round(positiveParameter(params, 'captureHeight', 0, 8192)),
    nativeGpuCapture: params.get('nativeGpu') === '1',
    generatedNv12: generatedNv12Flag === '1',
  };
  if (configuration.generatedNv12 && (sourceMode !== 'generated' || configuration.nativeGpuCapture))
    throw new Error('Generated NV12 requires the generated source without native GPU capture');
  const Generator = (window as unknown as { MediaStreamTrackGenerator?: GeneratorConstructor })
    .MediaStreamTrackGenerator;
  const supportsGenerator = Boolean(Generator && typeof VideoFrame === 'function');
  const originalCapture = navigator.mediaDevices.getDisplayMedia;
  const nativeCapture = originalCapture.bind(navigator.mediaDevices);
  const sources: Array<{
    kind: string; track: MediaStreamTrack; width: number | null; height: number | null;
    requestedFps: number | null; uniqueFramesDrawn: number | null; uniqueFramesWritten: number | null;
    skippedDeadlines: number | null; totalWriteMs: number | null; maxWriteMs: number | null;
    startedAt: number; lastFrameAt: number | null; error: string | null; stop: () => void;
    sourceKind?: 'generated-cpu-nv12'; generatedNv12?: {
      contentRect: PatternRect; bytesPerFrame: number; totalInputBytes: number; framesConstructed: number; framesClosed: number;
      transferDetached: boolean | null; transferDetachedFrames: number; transferRetainedFrames: number;
      totalGenerateMs: number; maxGenerateMs: number; timerActive: boolean; writerReleased: boolean; writesPending: number;
    };
  }> = [];
  const generatedNv12Closures: Promise<void>[] = [];
  const stockTrackJournal: Array<{ at: number; sourceIndex: number; event: 'js-stop' | 'natural-ended'; functions: string[] }> = [];
  let stockTrackJournalDropped = 0;
  const stockTrackObservers: Array<{ track: MediaStreamTrack; wrappedStop: MediaStreamTrack['stop']; restore: () => void; restored: boolean }> = [];
  function observeStockTrack(track: MediaStreamTrack, sourceIndex: number) {
    const previousStop = track.stop, previousOwnStop = Object.getOwnPropertyDescriptor(track, 'stop');
    function recordStockTrackEvent(event: 'js-stop' | 'natural-ended') {
      if (stockTrackJournal.length >= 128) { stockTrackJournalDropped++; return; }
      stockTrackJournal.push({ at: performance.now(), sourceIndex, event,
        functions: screenPerformanceStackFunctionNames(new Error().stack) });
    }
    const journaledStockStop: MediaStreamTrack['stop'] = function(this: MediaStreamTrack) {
      recordStockTrackEvent('js-stop');
      return Reflect.apply(previousStop, this, []);
    };
    const ended = () => recordStockTrackEvent('natural-ended');
    track.stop = journaledStockStop;
    track.addEventListener('ended', ended);
    const observer = { track, wrappedStop: journaledStockStop, restored: false, restore() {
      track.removeEventListener('ended', ended);
      if (track.stop === journaledStockStop) {
        if (previousOwnStop) Object.defineProperty(track, 'stop', previousOwnStop);
        else delete (track as unknown as { stop?: MediaStreamTrack['stop'] }).stop;
      }
      observer.restored = track.stop !== journaledStockStop;
    } };
    stockTrackObservers.push(observer);
  }
  const stockTrackJournalSnapshot = () => ({ maximumEvents: 128, droppedEvents: stockTrackJournalDropped,
    events: stockTrackJournal.map(event => ({ ...event, functions: [...event.functions] })) });
  const presentations = new Map<HTMLVideoElement, {
    callbackId: number | null; callbacks: number; firstPresentedFrames: number | null;
    latestPresentedFrames: number | null; firstAt: number | null; lastAt: number | null;
    mediaTime: number | null; processingDuration: number | null;
  }>();
  let disposed = false;
  const inspectOwnedPattern = params.get('ownedPattern') === '1';
  const sourceAgeFlag = params.get('sourceAge');
  if (sourceAgeFlag !== null && !['0', '1'].includes(sourceAgeFlag)) throw new Error('Invalid source age option');
  const sourceAgeEnabled = sourceAgeFlag === '1';
  const patternReadbackMode = params.get('ownedPatternReadback') ?? 'full';
  if (!['full', 'roi'].includes(patternReadbackMode)) throw new Error('Invalid owned-pattern readback mode');
  // Both controlled observer variants inspect the same twenty points from one
  // immutable decoded frame. Full remains the comparison default; ROI measures
  // observer overhead and must not be reported as a product improvement.
  const originalAlert = window.alert;
  const unexpectedAlerts: string[] = [];
  const testAlert: typeof window.alert = message => {
    const text = String(message).slice(0, 300); unexpectedAlerts.push(text);
    throw new Error('Unexpected screen-performance renderer alert: ' + text);
  };
  window.alert = testAlert;
  const patternSnapshotResources = { created: 0, closed: 0, active: 0, errors: 0 };
  async function readOwnedPatternSnapshot(source: HTMLVideoElement | HTMLCanvasElement,
    mode = patternReadbackMode, contentRect?: PatternRect): Promise<OwnedPatternRead> {
    const measured: OwnedPatternRead = { markersMatched: [], capturedSequence: null,
      observerDrawCalls: 0, observerDrawMs: 0, observerReadMs: 0, observerReadbackPixels: 0,
      frameSnapshotCreated: false, frameSnapshotClosed: false, frameSnapshotMs: 0,
      observerCopyMs: 0, observerCopiedBytes: 0, observerCopyCalls: 0, observerCopyMaxMs: 0,
      observerMethod: `VideoFrame.copyTo(RGBA:${mode})`, frameFormat: null, copyFormat: 'RGBA',
      frameColorSpace: null, markerRgbAbsoluteErrorMaxima: null };
    let frame: VideoFrame | null = null;
    const buffers: Uint8Array[] = [];
    try {
      const snapshotStarted = performance.now();
      if (sourceAgeEnabled) {
        const origin = performance.timeOrigin, snapshotAt = origin + snapshotStarted;
        measured.snapshotAt = Number.isFinite(origin) && origin > 0 && Number.isFinite(snapshotStarted) && snapshotStarted >= 0 &&
          Number.isFinite(snapshotAt) && snapshotAt > 0 && snapshotAt <= Number.MAX_SAFE_INTEGER ? snapshotAt : null;
      }
      frame = new VideoFrame(source, { timestamp: Math.round(snapshotStarted * 1000) });
      measured.frameFormat = frame.format ?? null;
      measured.frameColorSpace = { primaries: frame.colorSpace.primaries ?? null, transfer: frame.colorSpace.transfer ?? null,
        matrix: frame.colorSpace.matrix ?? null, fullRange: typeof frame.colorSpace.fullRange === 'boolean' ? frame.colorSpace.fullRange : null };
      measured.frameSnapshotMs = performance.now() - snapshotStarted;
      measured.frameSnapshotCreated = true; patternSnapshotResources.created++; patternSnapshotResources.active++;
      const points = [[.05, .05], [.95, .05], [.05, .95], [.95, .95],
        ...Array.from({ length: 16 }, (_, bit) => [.2 + (bit + .5) * .0375, .45])];
      const width = frame.visibleRect?.width ?? frame.codedWidth, height = frame.visibleRect?.height ?? frame.codedHeight;
      const originX = frame.visibleRect?.x ?? 0, originY = frame.visibleRect?.y ?? 0;
      const patternRect = contentRect ?? { x: 0, y: 0, width, height };
      if (patternRect.x < 0 || patternRect.y < 0 || patternRect.width <= 0 || patternRect.height <= 0 ||
          patternRect.x + patternRect.width > width || patternRect.y + patternRect.height > height)
        throw new Error('Owned pattern content rectangle is outside the decoded frame');
      measured.contentRect = { ...patternRect };
      const positions = points.map(([x, y]) => ({ x: originX + Math.floor(patternRect.x + patternRect.width * x),
        y: originY + Math.floor(patternRect.y + patternRect.height * y) }));
      const colors: number[][] = Array.from({ length: points.length }, () => []);
      const copyRegion = async (indexes: number[], rect?: DOMRectInit) => {
        const options = { format: 'RGBA' as const, ...(rect ? { rect } : {}) };
        const pixels = new Uint8Array(frame!.allocationSize(options)); buffers.push(pixels);
        const copyStarted = performance.now();
        let layouts: PlaneLayout[];
        try { layouts = await frame!.copyTo(pixels, options); }
        finally {
          const duration = performance.now() - copyStarted;
          measured.observerCopyMs += duration; measured.observerCopyCalls++;
          measured.observerCopyMaxMs = Math.max(measured.observerCopyMaxMs, duration);
          measured.observerCopiedBytes += pixels.byteLength;
        }
        if (layouts.length !== 1) throw new Error('RGBA copy did not produce one packed plane');
        measured.observerReadbackPixels += (rect?.width ?? width) * (rect?.height ?? height);
        const readStarted = performance.now();
        for (const index of indexes) {
          const point = positions[index];
          const offset = layouts[0].offset + (point.y - (rect?.y ?? originY)) * layouts[0].stride + (point.x - (rect?.x ?? originX)) * 4;
          colors[index] = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
        }
        measured.observerReadMs += performance.now() - readStarted;
      };
      if (mode === 'roi') {
        if (frame.codedWidth < 2 || frame.codedHeight < 2) throw new Error('Owned-pattern ROI requires at least two coded pixels per dimension');
        // Even coordinates and extents also work with subsampled input. Five
        // copies trade reduced transfer bytes for additional synchronization;
        // the saved per-call costs decide whether that trade helps this device.
        const roi = (indexes: number[]): DOMRectInit => {
          const minX = Math.min(...indexes.map(index => positions[index].x));
          const maxX = Math.max(...indexes.map(index => positions[index].x));
          const minY = Math.min(...indexes.map(index => positions[index].y));
          const maxY = Math.max(...indexes.map(index => positions[index].y));
          const x = Math.floor(minX / 2) * 2, y = Math.floor(minY / 2) * 2;
          const right = Math.min(frame!.codedWidth, Math.ceil((maxX + 1) / 2) * 2);
          const bottom = Math.min(frame!.codedHeight, Math.ceil((maxY + 1) / 2) * 2);
          return { x, y, width: right - x, height: bottom - y };
        };
        for (let index = 0; index < 4; index++) await copyRegion([index], roi([index]));
        const stripe = Array.from({ length: 16 }, (_, bit) => bit + 4);
        await copyRegion(stripe, roi(stripe));
      } else await copyRegion(points.map((_, index) => index));
      const readStarted = performance.now();
      const expected = [[232, 74, 95], [65, 179, 163], [232, 208, 169], [75, 46, 131]];
      const markerErrors = expected.map((color, index) => color.map((value, channel) => Math.abs(colors[index][channel] - value)));
      const channelErrors = [0, 1, 2].map(channel => Math.max(...markerErrors.map(error => error[channel])));
      measured.markerRgbAbsoluteErrorMaxima = { byMarker: markerErrors.map(error => ({ r: error[0], g: error[1], b: error[2], max: Math.max(...error) })),
        byChannel: { r: channelErrors[0], g: channelErrors[1], b: channelErrors[2] }, max: Math.max(...channelErrors) };
      measured.markersMatched = expected.map((color, index) => color.every((value, channel) =>
        Math.abs(colors[index][channel] - value) <= 32));
      if (measured.markersMatched.every(Boolean)) {
        let sequence = 0;
        for (let bit = 0; bit < 16; bit++) {
          if (colors[bit + 4].reduce((sum, value) => sum + value, 0) > 380) sequence |= 1 << bit;
        }
        measured.capturedSequence = sequence;
      }
      measured.observerReadMs += performance.now() - readStarted;
    } catch (error) { measured.error = String(error); patternSnapshotResources.errors++; }
    finally {
      for (const pixels of buffers) pixels.fill(0);
      if (frame) { frame.close(); measured.frameSnapshotClosed = true;
        patternSnapshotResources.closed++; patternSnapshotResources.active--; }
    }
    return measured;
  }
  async function verifyPatternReader() {
    if (!inspectOwnedPattern) return { required: false, passed: true };
    const canvas = document.createElement('canvas'); canvas.width = 865; canvas.height = 540;
    const context = canvas.getContext('2d', { alpha: false })!;
    const cases = [];
    const modes = patternReadbackMode === 'roi' ? ['full', 'roi'] : ['full'];
    for (const mode of modes) for (const sequence of [3112, 3355, 4094, 65535, 0, 74]) {
      context.fillStyle = '#17324d'; context.fillRect(0, 0, canvas.width, canvas.height);
      for (const [color, x, y] of [['#e84a5f', 0, 0], ['#41b3a3', .9, 0],
        ['#e8d0a9', 0, .9], ['#4b2e83', .9, .9]] as const) {
        context.fillStyle = color; context.fillRect(x * canvas.width, y * canvas.height, .1 * canvas.width, .1 * canvas.height);
      }
      for (let bit = 0; bit < 16; bit++) {
        context.fillStyle = sequence & (1 << bit) ? '#fff' : '#000';
        context.fillRect((.2 + bit * .0375) * canvas.width, .4 * canvas.height, .0375 * canvas.width, .1 * canvas.height);
      }
      const actual = await readOwnedPatternSnapshot(canvas, mode);
      cases.push({ mode, expectedSequence: sequence, actualSequence: actual.capturedSequence,
        markersMatched: actual.markersMatched, frameClosed: actual.frameSnapshotClosed,
        copyMs: actual.observerCopyMs, copyCalls: actual.observerCopyCalls, copiedBytes: actual.observerCopiedBytes, error: actual.error ?? null,
        passed: actual.markersMatched.every(Boolean) && actual.capturedSequence === sequence && actual.frameSnapshotClosed && !actual.error });
    }
    return { required: true, passed: cases.every(result => result.passed), width: canvas.width,
      height: canvas.height, cases, snapshotResources: { ...patternSnapshotResources },
      selectedMode: patternReadbackMode,
      meaning: 'The selected mode decodes deterministic patterns before live capture; ROI also cross-checks full mode. Live native qualification requires nonfuture source-counter lag.' };
  }
  const analysisTiming = { drawCalls: 0, readCalls: 0, drawMs: 0, readMs: 0,
    maxDrawMs: 0, maxReadMs: 0, errors: 0 };
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const profiledContexts = new WeakSet<CanvasRenderingContext2D>();
  const restoreAnalysisContexts: Array<() => void> = [];
  // Observe only the product activity sampler's 160x90 canvas. This wrapper
  // adds no pixels, extra readbacks, timers, or producer-side work to game mode.
  const profiledGetContext = function(this: HTMLCanvasElement, ...args: unknown[]) {
    const context = Reflect.apply(originalGetContext, this, args) as RenderingContext | null;
    if (args[0] === '2d' && this.width === 160 && this.height === 90 && context &&
        !profiledContexts.has(context as CanvasRenderingContext2D)) {
      const measured = context as CanvasRenderingContext2D;
      profiledContexts.add(measured);
      const draw = measured.drawImage, read = measured.getImageData;
      measured.drawImage = function(this: CanvasRenderingContext2D, ...values: unknown[]) {
        const started = performance.now();
        try { return Reflect.apply(draw, this, values); }
        catch (error) { analysisTiming.errors++; throw error; }
        finally { const duration = performance.now() - started;
          analysisTiming.drawCalls++; analysisTiming.drawMs += duration;
          analysisTiming.maxDrawMs = Math.max(analysisTiming.maxDrawMs, duration); }
      } as CanvasRenderingContext2D['drawImage'];
      measured.getImageData = function(this: CanvasRenderingContext2D, ...values: unknown[]) {
        const started = performance.now();
        try { return Reflect.apply(read, this, values) as ImageData; }
        catch (error) { analysisTiming.errors++; throw error; }
        finally { const duration = performance.now() - started;
          analysisTiming.readCalls++; analysisTiming.readMs += duration;
          analysisTiming.maxReadMs = Math.max(analysisTiming.maxReadMs, duration); }
      } as CanvasRenderingContext2D['getImageData'];
      restoreAnalysisContexts.push(() => { measured.drawImage = draw; measured.getImageData = read; });
    }
    return context;
  } as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = profiledGetContext;
  const videoTrackTokens = new WeakMap<MediaStreamTrack, number>();
  let nextVideoTrackToken = 0;
  const connectionTokens = new WeakMap<RTCPeerConnection, number>();
  let nextConnectionToken = 0;
  const connectionToken = (connection: RTCPeerConnection) => {
    if (!connectionTokens.has(connection)) connectionTokens.set(connection, ++nextConnectionToken);
    return connectionTokens.get(connection)!;
  };
  const originalUserMedia = navigator.mediaDevices.getUserMedia;
  const originalEnumeration = navigator.mediaDevices.enumerateDevices;
  const testAudio: Array<{ context: AudioContext; oscillator: OscillatorNode; track: MediaStreamTrack }> = [];
  // A global Chromium fake-device flag would also fake display capture. Keep
  // native screen capture real while never opening the physical microphone.
  const syntheticUserMedia: typeof navigator.mediaDevices.getUserMedia = async () => {
    const context = new AudioContext({ sinkId: { type: 'none' } } as AudioContextOptions);
    const oscillator = context.createOscillator();
    const gain = context.createGain(); gain.gain.value = 0.03;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination); oscillator.start();
    await context.resume();
    const track = destination.stream.getAudioTracks()[0];
    testAudio.push({ context, oscillator, track });
    return destination.stream;
  };
  navigator.mediaDevices.getUserMedia = syntheticUserMedia;
  navigator.mediaDevices.enumerateDevices = async () => [];

  function observeVideos() {
    for (const video of document.querySelectorAll('video')) {
      if (presentations.has(video)) continue;
      const state = {
        callbackId: null as number | null, callbacks: 0,
        firstPresentedFrames: null as number | null, latestPresentedFrames: null as number | null,
        firstAt: null as number | null, lastAt: null as number | null,
        mediaTime: null as number | null, processingDuration: null as number | null,
      };
      presentations.set(video, state);
      if (typeof video.requestVideoFrameCallback !== 'function') continue;
      const onFrame: VideoFrameRequestCallback = (now, metadata) => {
        if (disposed) return;
        state.callbacks++;
        state.firstAt ??= now;
        state.firstPresentedFrames ??= metadata.presentedFrames;
        state.lastAt = now;
        state.latestPresentedFrames = metadata.presentedFrames;
        state.mediaTime = metadata.mediaTime;
        state.processingDuration = metadata.processingDuration ?? null;
        state.callbackId = video.requestVideoFrameCallback(onFrame);
      };
      state.callbackId = video.requestVideoFrameCallback(onFrame);
    }
  }
  const mutationObserver = new MutationObserver(observeVideos);
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  observeVideos();

  const capture: typeof navigator.mediaDevices.getDisplayMedia = async constraints => {
    if (disposed) throw new Error('Screen performance fixture was disposed');
    const video = typeof constraints?.video === 'object' ? { ...constraints.video } : {};
    if (configuration.captureWidth) video.width = { ideal: configuration.captureWidth, max: configuration.captureWidth };
    if (configuration.captureHeight) video.height = { ideal: configuration.captureHeight, max: configuration.captureHeight };
    const requested = { ...constraints, video, audio: false };
    if (sourceMode === 'native') {
      const stream = await nativeCapture(requested);
      for (const track of stream.getVideoTracks()) {
        const settings = track.getSettings();
        sources.push({ kind: 'native-display-capture', track,
          width: settings.width ?? null, height: settings.height ?? null,
          requestedFps: desiredNumber(video.frameRate, configuration.fps),
          uniqueFramesDrawn: 0, uniqueFramesWritten: 0, skippedDeadlines: 0,
          totalWriteMs: 0, maxWriteMs: 0, startedAt: performance.now(),
          lastFrameAt: null, error: null, stop: () => track.stop() });
        observeStockTrack(track, sources.length - 1);
      }
      return stream;
    }

    const width = Math.max(2, Math.floor(desiredNumber(video.width, configuration.width)));
    const height = Math.max(2, Math.floor(desiredNumber(video.height, configuration.height)));
    const fps = Math.max(1, desiredNumber(video.frameRate, configuration.fps));
    if (configuration.generatedNv12) {
      if (!supportsGenerator || fps !== 120) throw new Error('Generated NV12 requires a VideoFrame generator at 120 FPS');
      const frameWidth = Math.min(width, 1920), frameHeight = Math.min(height, 1080);
      const painter = createGeneratedNv12Painter(frameWidth, frameHeight), generator = new Generator!({ kind: 'video' });
      const writer = generator.writable.getWriter(), originalStop = generator.stop.bind(generator);
      const stream = new MediaStream([generator]), period = 1000 / fps;
      const state = { kind: 'generated-cpu-nv12', sourceKind: 'generated-cpu-nv12' as const, track: generator,
        width: frameWidth, height: frameHeight, requestedFps: fps, uniqueFramesDrawn: 0, uniqueFramesWritten: 0,
        skippedDeadlines: 0, totalWriteMs: 0, maxWriteMs: 0, startedAt: performance.now(),
        lastFrameAt: null as number | null, error: null as string | null, stop: () => {},
        generatedNv12: { contentRect: { ...painter.contentRect }, bytesPerFrame: painter.bytesPerFrame,
          totalInputBytes: 0, framesConstructed: 0, framesClosed: 0, transferDetached: null as boolean | null,
          transferDetachedFrames: 0, transferRetainedFrames: 0, totalGenerateMs: 0, maxGenerateMs: 0,
          timerActive: false, writerReleased: false, writesPending: 0 },
      };
      sources.push(state);
      let timer: number | null = null, stopped = false, deadline = performance.now();
      state.stop = () => {
        if (stopped) return; stopped = true;
        if (timer !== null) { window.clearTimeout(timer); timer = null; }
        state.generatedNv12.timerActive = false;
        generator.removeEventListener('ended', state.stop); originalStop(); painter.close();
        generatedNv12Closures.push(writer.abort().catch(() => {}).finally(() => {
          try { writer.releaseLock(); state.generatedNv12.writerReleased = true; } catch { /* Cleanup reports a remaining writer. */ }
        }));
      };
      generator.stop = state.stop;
      generator.addEventListener('ended', state.stop, { once: true });
      const emit = async () => {
        timer = null; state.generatedNv12.timerActive = false;
        if (stopped || disposed || generator.readyState === 'ended') return;
        if (deadline - performance.now() > .2) { schedule(); return; }
        let frame: VideoFrame | null = null, data: ArrayBuffer | null = null;
        try {
          const started = performance.now(), sequence = ++state.uniqueFramesDrawn;
          data = painter.next(sequence); state.generatedNv12.totalInputBytes += data.byteLength;
          const init: VideoFrameBufferInit & { transfer: ArrayBuffer[] } = { format: 'NV12',
            codedWidth: frameWidth, codedHeight: frameHeight, displayWidth: frameWidth, displayHeight: frameHeight,
            timestamp: Math.round(deadline * 1000), layout: [{ offset: 0, stride: frameWidth },
              { offset: frameWidth * frameHeight, stride: frameWidth }],
            colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }, transfer: [data] };
          frame = new VideoFrame(data, init); state.generatedNv12.framesConstructed++;
          if (frame.format !== 'NV12' || frame.colorSpace.matrix !== 'bt709' || frame.colorSpace.fullRange !== false)
            throw new Error('Generated CPU NV12 format or color space was not preserved');
          const detached = data.byteLength === 0; state.generatedNv12.transferDetached = detached;
          if (detached) state.generatedNv12.transferDetachedFrames++; else state.generatedNv12.transferRetainedFrames++;
          const generateMs = performance.now() - started;
          state.generatedNv12.totalGenerateMs += generateMs;
          state.generatedNv12.maxGenerateMs = Math.max(state.generatedNv12.maxGenerateMs, generateMs);
          state.generatedNv12.writesPending++;
          const writeStarted = performance.now();
          try { await writer.write(frame); }
          finally { state.generatedNv12.writesPending--; }
          const writeMs = performance.now() - writeStarted;
          state.totalWriteMs += writeMs; state.maxWriteMs = Math.max(state.maxWriteMs, writeMs);
          state.uniqueFramesWritten++; state.lastFrameAt = performance.now();
        } catch (error) {
          if (!stopped && !disposed) state.error = 'generated_nv12_frame_error:' + (error instanceof Error ? error.name : 'unknown');
          state.stop();
        } finally {
          if (frame) { frame.close(); state.generatedNv12.framesClosed++; }
          if (data?.byteLength) new Uint8Array(data).fill(0);
        }
        if (stopped || disposed) return;
        deadline += period;
        const after = performance.now();
        if (after > deadline) { const missed = Math.floor((after - deadline) / period) + 1;
          state.skippedDeadlines += missed; deadline += missed * period; }
        schedule();
      };
      function schedule() {
        if (stopped || disposed) return;
        state.generatedNv12.timerActive = true;
        timer = window.setTimeout(() => { void emit(); }, Math.max(0, deadline - performance.now()));
      }
      void emit();
      return stream;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false })!;
    context.fillStyle = '#182d4d';
    context.fillRect(0, 0, width, height);
    const generator = supportsGenerator ? new Generator!({ kind: 'video' }) : null;
    const fallback = generator ? null : canvas.captureStream(fps);
    const track = generator ?? fallback!.getVideoTracks()[0];
    const writer = generator?.writable.getWriter();
    const stream = new MediaStream([track]);
    const period = 1_000 / fps;
    const state = {
      kind: generator ? 'generator-unique-frames' : 'canvas-capture-fallback', track,
      width, height, requestedFps: fps, uniqueFramesDrawn: 0, uniqueFramesWritten: 0,
      skippedDeadlines: 0, totalWriteMs: 0, maxWriteMs: 0,
      startedAt: performance.now(), lastFrameAt: null as number | null,
      error: null as string | null, stop: () => {},
    };
    sources.push(state);
    let timer: number | null = null;
    let stopped = false;
    let deadline = performance.now();
    let previousX = 0;
    let previousY = 0;
    const boxWidth = Math.max(2, Math.min(192, Math.floor(width / 5)));
    const boxHeight = Math.max(2, Math.min(128, Math.floor(height / 5)));
    const draw = () => {
      const sequence = ++state.uniqueFramesDrawn;
      context.fillStyle = '#182d4d';
      context.fillRect(previousX, previousY, boxWidth, boxHeight);
      context.fillRect(0, 0, Math.min(width, 720), Math.min(height, 80));
      const x = (sequence * 17) % Math.max(1, width - boxWidth);
      const y = 90 + (sequence * 7) % Math.max(1, height - boxHeight - 90);
      context.fillStyle = sequence % 2 ? '#f7bd45' : '#65d7f2';
      context.fillRect(x, Math.min(y, height - boxHeight), boxWidth, boxHeight);
      context.fillStyle = '#ffffff';
      context.font = '32px monospace';
      context.fillText(`unique frame ${sequence}`, 12, Math.min(48, height - 1));
      // The frame number makes every generated image distinct even on tiny sizes.
      // This narrow binary stripe remains unambiguous when text is clipped.
      for (let bit = 0; bit < Math.min(32, width); bit++) {
        context.fillStyle = sequence & (1 << bit) ? '#ffffff' : '#000000';
        context.fillRect(bit, height - 1, 1, 1);
      }
      previousX = x;
      previousY = Math.min(y, height - boxHeight);
    };
    const emit = async () => {
      if (stopped || disposed || track.readyState === 'ended') return;
      draw();
      const now = performance.now();
      if (writer) {
        const frame = new VideoFrame(canvas, { timestamp: Math.round(now * 1_000) });
        try {
          // One pending write only: a slow downstream never grows a frame queue.
          const started = performance.now();
          await writer.write(frame);
          const writeMs = performance.now() - started;
          state.totalWriteMs += writeMs;
          state.maxWriteMs = Math.max(state.maxWriteMs, writeMs);
          state.uniqueFramesWritten++;
          state.lastFrameAt = performance.now();
        } catch (error) {
          if (!stopped && !disposed) state.error = String(error);
          state.stop();
          return;
        } finally { frame.close(); }
      } else {
        // Draw count is not a captured-frame count in this fallback.
        state.lastFrameAt = now;
      }
      if (stopped || disposed) return;
      deadline += period;
      const after = performance.now();
      if (after > deadline) {
        const missed = Math.floor((after - deadline) / period) + 1;
        state.skippedDeadlines += missed;
        deadline += missed * period;
      }
      timer = window.setTimeout(() => { void emit(); }, Math.max(0, deadline - performance.now()));
    };
    state.stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      track.stop();
      if (writer) void writer.abort().catch(() => {});
    };
    track.addEventListener('ended', state.stop, { once: true });
    void emit();
    return stream;
  };
  navigator.mediaDevices.getDisplayMedia = capture;

  async function sample() {
    observeVideos();
    const fixtureWindow = window as unknown as { coveNativeScreen?: { supported?: boolean };
      coveMediaQA?: { rtc?: { localScreen?: MediaStream } } };
    const localScreenTrack = fixtureWindow.coveMediaQA?.rtc?.localScreen?.getVideoTracks()[0];
    const videoSenders = [...peerConnections].flatMap(connection => connection.getSenders())
      .filter(sender => sender.track?.kind === 'video' && sender.track.readyState === 'live');
    // getDisplayMedia cannot observe the generator created by the product's
    // background upgrade. Register only the actual replacement shared by the
    // live sender and localScreen, after the owned stock capture ended.
    if (configuration.nativeGpuCapture && sourceMode === 'native' && fixtureWindow.coveNativeScreen?.supported &&
      localScreenTrack && videoSenders.length === 1 && videoSenders[0].track === localScreenTrack &&
      !sources.some(source => source.track === localScreenTrack) &&
      sources.some(source => source.kind === 'native-display-capture' && source.track.readyState === 'ended')) {
      const track = localScreenTrack, settings = track.getSettings();
      sources.push({ kind: 'native-gpu-adapter', track, width: settings.width ?? null, height: settings.height ?? null,
        requestedFps: null, uniqueFramesDrawn: null, uniqueFramesWritten: null, skippedDeadlines: null,
        totalWriteMs: null, maxWriteMs: null, startedAt: performance.now(), lastFrameAt: null,
        error: null, stop: () => track.stop() });
    }
    const liveSources = sources.filter(source => source.track.readyState === 'live' &&
      [...peerConnections].some(connection => connection.getSenders().some(sender => sender.track === source.track)));
    const liveSource = liveSources.length === 1 ? liveSources[0] : null;
    if (liveSource && !videoTrackTokens.has(liveSource.track)) videoTrackTokens.set(liveSource.track, ++nextVideoTrackToken);
    const connections = await Promise.all([...peerConnections].map(async connection => {
      const index = connectionToken(connection);
      const report = await connection.getStats();
      const stats: SafeStat[] = [];
      for (const stat of report.values()) {
        if (!['media-source', 'outbound-rtp', 'inbound-rtp'].includes(stat.type)) continue;
        if ((stat.kind ?? stat.mediaType) !== 'video') continue;
        const result: SafeStat = { type: stat.type, id: stat.id };
        for (const field of VIDEO_FIELDS) {
          const value = stat[field];
          if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string' || typeof value === 'boolean') result[field] = value;
        }
        const durations = stat.qualityLimitationDurations;
        if (durations) for (const reason of ['none', 'cpu', 'bandwidth', 'other']) {
          const value = durations[reason];
          if (typeof value === 'number' && Number.isFinite(value)) result[`qualityLimitationSeconds_${reason}`] = value;
        }
        const codec = report.get(stat.codecId);
        if (typeof codec?.mimeType === 'string') result.codec = codec.mimeType;
        if (typeof codec?.sdpFmtpLine === 'string') result.codecFmtp = codec.sdpFmtpLine;
        if (typeof stat.mediaSourceId === 'string') result.mediaSourceId = stat.mediaSourceId;
        if (stat.type === 'media-source' && liveSource && stat.trackIdentifier === liveSource.track.id)
          result.isLiveCaptureSource = true;
        stats.push(result);
      }
      const senders = connection.getSenders().filter(sender => sender.track?.kind === 'video').map(sender => {
        const track = sender.track!;
        if (!videoTrackTokens.has(track)) videoTrackTokens.set(track, ++nextVideoTrackToken);
        let degradationPreference: string | null = null;
        let encodings: Array<{ maxFramerate: number | null; maxBitrate: number | null; scaleResolutionDownBy: number | null }> | null = null;
        try {
          const parameters = sender.getParameters(); degradationPreference = parameters.degradationPreference ?? null;
          const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
          encodings = (parameters.encodings ?? []).slice(0, 8).map(encoding => ({
            maxFramerate: numeric(encoding.maxFramerate), maxBitrate: numeric(encoding.maxBitrate),
            scaleResolutionDownBy: numeric(encoding.scaleResolutionDownBy) }));
        } catch { /* Closed sender. */ }
        return { trackToken: videoTrackTokens.get(track)!, trackState: track.readyState,
          isLiveCaptureSource: track === liveSource?.track, contentHint: track.contentHint,
          degradationPreference, encodings };
      });
      return { index, connectionState: connection.connectionState, stats, senders };
    }));
    // Bind recovery checks to the receiver currently feeding the video element.
    // Full-PC stats can retain closed consumers' cumulative inbound counters.
    const video = document.querySelector('video');
    const stream = video?.srcObject instanceof MediaStream ? video.srcObject : null;
    const displayedTrack = stream?.getVideoTracks()[0];
    let currentVideo: { trackToken: number; trackState: string; reportId: string;
      timestamp: number; framesDecoded: number; framesReceived: number; connectionIndex: number } | null = null;
    if (displayedTrack) {
      if (!videoTrackTokens.has(displayedTrack)) videoTrackTokens.set(displayedTrack, ++nextVideoTrackToken);
      for (const connection of peerConnections) {
        const connectionIndex = connectionToken(connection);
        const receiver = connection.getReceivers().find(item => item.track === displayedTrack);
        if (!receiver) continue;
        const report = await receiver.getStats();
        const inboundReports = [...report.values()].filter(stat => stat.type === 'inbound-rtp' &&
          (stat.kind ?? stat.mediaType) === 'video' && typeof stat.framesDecoded === 'number' && stat.framesDecoded > 0 &&
          stat.ssrc !== 1234 && report.get(stat.codecId)?.mimeType !== 'video/rtx');
        const inbound = inboundReports.length === 1 ? inboundReports[0] : null;
        if (inbound) currentVideo = { trackToken: videoTrackTokens.get(displayedTrack)!,
          trackState: displayedTrack.readyState, reportId: inbound.id, timestamp: inbound.timestamp,
          framesDecoded: inbound.framesDecoded, framesReceived: inbound.framesReceived ?? 0, connectionIndex };
        break;
      }
    }
    const reports: Array<SafeStat & { connectionIndex: number }> = connections.flatMap(connection => connection.stats.map(stat => ({
      ...stat, connectionIndex: connection.index,
    })));
    const liveReports = reports.filter(report => report.isLiveCaptureSource === true);
    const sourceReport = liveReports.length === 1 ? liveReports[0] : null;
    const outgoingReports = sourceReport ? reports.filter(report => report.type === 'outbound-rtp' &&
      report.mediaSourceId === sourceReport.id && report.connectionIndex === sourceReport.connectionIndex &&
      report.codec !== 'video/rtx') : [];
    const outboundReport = outgoingReports.length === 1 ? outgoingReports[0] : null;
    const link = (report: typeof sourceReport) => report
      ? { reportId: report.id, connectionIndex: report.connectionIndex,
        trackToken: liveSource ? videoTrackTokens.get(liveSource.track)! : null } : null;
    let patternRect: PatternRect | undefined;
    if (configuration.generatedNv12 && video?.videoWidth && video.videoHeight) {
      const sourceWidth = Math.min(configuration.captureWidth || configuration.width, 1920);
      const sourceHeight = Math.min(configuration.captureHeight || configuration.height, 1080);
      const content = generatedNv12Geometry(sourceWidth, sourceHeight);
      patternRect = { x: content.x * video.videoWidth / sourceWidth, y: 0,
        width: content.width * video.videoWidth / sourceWidth, height: content.height * video.videoHeight / sourceHeight };
    }
    const ownedPattern = inspectOwnedPattern && video && video.readyState >= 2 && video.videoWidth && video.videoHeight
      ? await readOwnedPatternSnapshot(video, patternReadbackMode, patternRect) : null;
    return {
      timestamp: performance.now(), configuration, supportsGenerator,
      sourceKind: liveSource?.kind ?? null,
      nativeCaptureCounters: liveSource ? nativeScreenCaptureDiagnostics.getNativeScreenCaptureDiagnostics(liveSource.track) : null,
      nativeCaptureStartupAttempt: (() => {
        // Older explicitly selected writer snapshots have no startup getter.
        const getter = (nativeScreenCaptureDiagnostics as unknown as { getLastNativeScreenCaptureAttempt?: () => unknown })
          .getLastNativeScreenCaptureAttempt;
        return typeof getter === 'function' ? getter() : null;
      })(),
      unexpectedAlerts: [...unexpectedAlerts],
      stockTrackJournal: stockTrackJournalSnapshot(),
      activityAnalysis: { ...analysisTiming },
      product: (() => {
        const rtc = (window as unknown as { coveMediaQA?: { rtc?: {
          screenActivity?: string; screenEncodingPlan?: { fps: number; contentHint: string; degradationPreference: string };
          inVoice?: boolean; isSharing?: boolean; localScreen?: MediaStream;
        } } }).coveMediaQA?.rtc;
        return { inVoice: rtc?.inVoice === true, isSharing: rtc?.isSharing === true, localScreen: Boolean(rtc?.localScreen),
          activity: rtc?.screenActivity ?? null,
          requestedSenderFps: rtc?.screenEncodingPlan?.fps ?? null,
          plannedContentHint: rtc?.screenEncodingPlan?.contentHint ?? null,
          degradationPreference: rtc?.screenEncodingPlan?.degradationPreference ?? null,
          trackContentHint: liveSource?.track.contentHint ?? null,
          senderDegradationPreference: connections.flatMap(connection => connection.senders)
            .find(sender => sender.isLiveCaptureSource)?.degradationPreference ?? null };
      })(),
      nativeGpu: { enabled: configuration.nativeGpuCapture, bridgeSupported: fixtureWindow.coveNativeScreen?.supported === true,
        localScreenTrackMatchesSender: Boolean(liveSource && localScreenTrack === liveSource.track),
        upgraded: liveSource?.kind === 'native-gpu-adapter' },
      sourceMeaning: sourceMode === 'native'
        ? liveSource?.kind === 'native-gpu-adapter'
          ? 'Product native GPU adapter: fixture write/draw counts are unavailable; use the actual sender track and linked media-source counters.'
          : 'Native getDisplayMedia: source production count is unavailable; use media-source counters.'
        : configuration.generatedNv12
          ? 'Test-only CPU NV12 generator with fixed 1728x1080 content and even black padding; every written frame is unique. This measures generated encode/decode throughput, not desktop capture.'
        : supportsGenerator
          ? 'Every successful generator write has distinct pixels and timestamp; independent of display vsync. This excludes native screen capture.'
          : 'Canvas fallback: drawn images are unique, but canvas capture may coalesce them. Draw count is not captured or encoded FPS.',
      sources: sources.map(({ track, stop: _stop, ...state }) => ({ ...state,
        trackState: track.readyState, trackToken: videoTrackTokens.get(track) ?? null,
        isLiveSenderSource: track === liveSource?.track, settings: safeSettings(track) })),
      connections,
      currentVideo,
      reports,
      pipeline: { source: link(sourceReport), outbound: link(outboundReport),
        inbound: currentVideo ? { reportId: currentVideo.reportId, connectionIndex: currentVideo.connectionIndex, trackToken: currentVideo.trackToken } : null },
      ownedPattern,
      patternSnapshotResources: { ...patternSnapshotResources },
      presentation: [...presentations].map(([video, state], index) => {
        const quality = video.getVideoPlaybackQuality?.();
        return { index, connected: video.isConnected, paused: video.paused,
          isCurrentVideo: video === document.querySelector('video') && video.isConnected,
          trackToken: video === document.querySelector('video') ? currentVideo?.trackToken ?? null : null,
          width: video.videoWidth, height: video.videoHeight,
          callbacks: state.callbacks, firstPresentedFrames: state.firstPresentedFrames,
          latestPresentedFrames: state.latestPresentedFrames, firstAt: state.firstAt,
          lastAt: state.lastAt, mediaTime: state.mediaTime,
          processingDurationSeconds: state.processingDuration,
          totalVideoFrames: quality?.totalVideoFrames ?? null,
          droppedVideoFrames: quality?.droppedVideoFrames ?? null,
          note: 'Compositor/video-element counters, not proof of physical display scan-out.' };
      }),
    };
  }

  let cleanupPromise: Promise<Record<string, unknown>> | null = null;
  function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = finishCleanup();
    return cleanupPromise;
  }
  async function finishCleanup() {
    disposed = true;
    mutationObserver.disconnect();
    if (HTMLCanvasElement.prototype.getContext === profiledGetContext) HTMLCanvasElement.prototype.getContext = originalGetContext;
    for (const restore of restoreAnalysisContexts) restore();
    for (const observer of stockTrackObservers) observer.restore();
    for (const source of sources) source.stop();
    const closingAudio = testAudio.map(async ({ context, oscillator, track }) => {
      oscillator.stop(); track.stop(); await context.close().catch(() => {});
    });
    if (navigator.mediaDevices.getUserMedia === syntheticUserMedia) navigator.mediaDevices.getUserMedia = originalUserMedia;
    navigator.mediaDevices.enumerateDevices = originalEnumeration;
    if (window.alert === testAlert) window.alert = originalAlert;
    for (const [video, state] of presentations) if (state.callbackId !== null) {
      video.cancelVideoFrameCallback?.(state.callbackId); state.callbackId = null;
    }
    if (navigator.mediaDevices.getDisplayMedia === capture) navigator.mediaDevices.getDisplayMedia = originalCapture;
    await Promise.all([...closingAudio, ...generatedNv12Closures]);
    const resources = { disposed, liveSourceTracks: sources.filter(source => source.track.readyState === 'live').length,
      liveSyntheticAudioTracks: testAudio.filter(audio => audio.track.readyState === 'live').length,
      openSyntheticAudioContexts: testAudio.filter(audio => audio.context.state !== 'closed').length,
      pendingPresentationCallbacks: [...presentations.values()].filter(state => state.callbackId !== null).length,
      patternSnapshotResources: { ...patternSnapshotResources },
      stockTrackJournal: stockTrackJournalSnapshot(),
      stockTrackObserversRestored: stockTrackObservers.every(observer => observer.restored && observer.track.stop !== observer.wrappedStop),
      generatedNv12OpenWriters: sources.filter(source => source.generatedNv12 && !source.generatedNv12.writerReleased).length,
      generatedNv12ActiveTimers: sources.filter(source => source.generatedNv12?.timerActive).length,
      generatedNv12PendingWrites: sources.reduce((sum, source) => sum + (source.generatedNv12?.writesPending ?? 0), 0),
      generatedNv12FramesUnclosed: sources.reduce((sum, source) => sum + (source.generatedNv12
        ? source.generatedNv12.framesConstructed - source.generatedNv12.framesClosed : 0), 0),
      canvasProfilerRestored: HTMLCanvasElement.prototype.getContext === originalGetContext,
      displayCaptureRestored: navigator.mediaDevices.getDisplayMedia === originalCapture,
      userMediaRestored: navigator.mediaDevices.getUserMedia === originalUserMedia,
      enumerationRestored: navigator.mediaDevices.enumerateDevices === originalEnumeration,
      alertRestored: window.alert === originalAlert };
    return { ...resources, passed: resources.liveSourceTracks === 0 && resources.liveSyntheticAudioTracks === 0 &&
      resources.openSyntheticAudioContexts === 0 && resources.pendingPresentationCallbacks === 0 &&
      resources.patternSnapshotResources.active === 0 && resources.patternSnapshotResources.created === resources.patternSnapshotResources.closed &&
      resources.stockTrackObserversRestored && resources.generatedNv12OpenWriters === 0 && resources.generatedNv12ActiveTimers === 0 &&
      resources.generatedNv12PendingWrites === 0 && resources.generatedNv12FramesUnclosed === 0 &&
      resources.canvasProfilerRestored && resources.displayCaptureRestored && resources.userMediaRestored && resources.enumerationRestored && resources.alertRestored };
  }
  (window as unknown as { coveScreenPerformance: { sample: typeof sample; cleanup: typeof cleanup; verifyPatternReader: typeof verifyPatternReader } })
    .coveScreenPerformance = { sample, cleanup, verifyPatternReader };
  return { sample, cleanup, verifyPatternReader };
}
