// Test-only source and safe counters for the real two-peer/SFU media fixture.
// Generated-source throughput does not measure Windows desktop capture.
import { getNativeScreenCaptureDiagnostics } from '../../src/features/media/screen/nativeScreenCapture';
type VideoGenerator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type GeneratorConstructor = new (options: { kind: 'video' }) => VideoGenerator;
type SafeStat = Record<string, number | string | boolean | null>;
type OwnedPatternRead = { markersMatched: boolean[]; capturedSequence: number | null;
  observerDrawCalls: number; observerDrawMs: number; observerReadMs: number;
  observerReadbackPixels: number; frameSnapshotCreated: boolean; frameSnapshotClosed: boolean;
  frameSnapshotMs: number; observerCopyMs: number; observerCopiedBytes: number;
  observerMethod: string; error?: string };

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

export function installScreenPerformanceFixture(
  params: URLSearchParams,
  peerConnections: Set<RTCPeerConnection>,
) {
  if (params.get('performance') !== '1') return;
  const sourceMode = params.get('source') === 'native' ? 'native' : 'generated';
  const configuration = {
    source: sourceMode,
    width: Math.round(positiveParameter(params, 'width', 1920, 8192)),
    height: Math.round(positiveParameter(params, 'height', 1080, 8192)),
    fps: positiveParameter(params, 'fps', 120, 240),
    captureWidth: Math.round(positiveParameter(params, 'captureWidth', 0, 8192)),
    captureHeight: Math.round(positiveParameter(params, 'captureHeight', 0, 8192)),
    nativeGpuCapture: params.get('nativeGpu') === '1',
  };
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
  }> = [];
  const presentations = new Map<HTMLVideoElement, {
    callbackId: number | null; callbacks: number; firstPresentedFrames: number | null;
    latestPresentedFrames: number | null; firstAt: number | null; lastAt: number | null;
    mediaTime: number | null; processingDuration: number | null;
  }>();
  let disposed = false;
  const inspectOwnedPattern = params.get('ownedPattern') === '1';
  // One immutable decoded frame, one explicit RGBA copy, twenty point reads.
  // Avoid scaling and repeated canvas YUV conversion/synchronization. Pixels
  // remain local to this call and are zeroed after classification.
  const originalAlert = window.alert;
  const unexpectedAlerts: string[] = [];
  const testAlert: typeof window.alert = message => {
    const text = String(message).slice(0, 300); unexpectedAlerts.push(text);
    throw new Error('Unexpected screen-performance renderer alert: ' + text);
  };
  window.alert = testAlert;
  const patternSnapshotResources = { created: 0, closed: 0, active: 0, errors: 0 };
  async function readOwnedPatternSnapshot(source: HTMLVideoElement | HTMLCanvasElement): Promise<OwnedPatternRead> {
    const measured: OwnedPatternRead = { markersMatched: [], capturedSequence: null,
      observerDrawCalls: 0, observerDrawMs: 0, observerReadMs: 0, observerReadbackPixels: 0,
      frameSnapshotCreated: false, frameSnapshotClosed: false, frameSnapshotMs: 0,
      observerCopyMs: 0, observerCopiedBytes: 0, observerMethod: 'VideoFrame.copyTo(RGBA)' };
    let frame: VideoFrame | null = null;
    let pixels: Uint8Array | null = null;
    try {
      const snapshotStarted = performance.now();
      frame = new VideoFrame(source, { timestamp: Math.round(snapshotStarted * 1000) });
      measured.frameSnapshotMs = performance.now() - snapshotStarted;
      measured.frameSnapshotCreated = true; patternSnapshotResources.created++; patternSnapshotResources.active++;
      const points = [[.05, .05], [.95, .05], [.05, .95], [.95, .95],
        ...Array.from({ length: 16 }, (_, bit) => [.2 + (bit + .5) * .0375, .45])];
      const options = { format: 'RGBA' as const };
      pixels = new Uint8Array(frame.allocationSize(options));
      const copyStarted = performance.now(), layouts = await frame.copyTo(pixels, options);
      measured.observerCopyMs = performance.now() - copyStarted; measured.observerCopiedBytes = pixels.byteLength;
      if (layouts.length !== 1) throw new Error('RGBA copy did not produce one packed plane');
      const width = frame.visibleRect?.width ?? frame.codedWidth, height = frame.visibleRect?.height ?? frame.codedHeight;
      measured.observerReadbackPixels = width * height;
      const offsets = points.map(([x, y]) => layouts[0].offset + Math.floor(height * y) * layouts[0].stride + Math.floor(width * x) * 4);
      const copiedPixels = pixels, readStarted = performance.now();
      const expected = [[232, 74, 95], [65, 179, 163], [232, 208, 169], [75, 46, 131]];
      measured.markersMatched = expected.map((color, index) => color.every((value, channel) =>
        Math.abs(copiedPixels[offsets[index] + channel] - value) <= 32));
      if (measured.markersMatched.every(Boolean)) {
        let sequence = 0;
        for (let bit = 0; bit < 16; bit++) {
          const offset = offsets[bit + 4];
          if (copiedPixels[offset] + copiedPixels[offset + 1] + copiedPixels[offset + 2] > 380) sequence |= 1 << bit;
        }
        measured.capturedSequence = sequence;
      }
      measured.observerReadMs = performance.now() - readStarted;
    } catch (error) { measured.error = String(error); patternSnapshotResources.errors++; }
    finally {
      pixels?.fill(0);
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
    for (const sequence of [3112, 3355, 4094, 65535, 0, 74]) {
      context.fillStyle = '#17324d'; context.fillRect(0, 0, canvas.width, canvas.height);
      for (const [color, x, y] of [['#e84a5f', 0, 0], ['#41b3a3', .9, 0],
        ['#e8d0a9', 0, .9], ['#4b2e83', .9, .9]] as const) {
        context.fillStyle = color; context.fillRect(x * canvas.width, y * canvas.height, .1 * canvas.width, .1 * canvas.height);
      }
      for (let bit = 0; bit < 16; bit++) {
        context.fillStyle = sequence & (1 << bit) ? '#fff' : '#000';
        context.fillRect((.2 + bit * .0375) * canvas.width, .4 * canvas.height, .0375 * canvas.width, .1 * canvas.height);
      }
      const actual = await readOwnedPatternSnapshot(canvas);
      cases.push({ expectedSequence: sequence, actualSequence: actual.capturedSequence,
        markersMatched: actual.markersMatched, frameClosed: actual.frameSnapshotClosed,
        copyMs: actual.observerCopyMs, copiedBytes: actual.observerCopiedBytes, error: actual.error ?? null,
        passed: actual.markersMatched.every(Boolean) && actual.capturedSequence === sequence && actual.frameSnapshotClosed && !actual.error });
    }
    return { required: true, passed: cases.every(result => result.passed), width: canvas.width,
      height: canvas.height, cases, snapshotResources: { ...patternSnapshotResources },
      meaning: 'Deterministic in-browser VideoFrame.copyTo(RGBA) decoder check before live capture; live native qualification also requires nonfuture source-counter lag.' };
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
      }
      return stream;
    }

    const width = Math.max(2, Math.floor(desiredNumber(video.width, configuration.width)));
    const height = Math.max(2, Math.floor(desiredNumber(video.height, configuration.height)));
    const fps = Math.max(1, desiredNumber(video.frameRate, configuration.fps));
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
        try { degradationPreference = sender.getParameters().degradationPreference ?? null; } catch { /* Closed sender. */ }
        return { trackToken: videoTrackTokens.get(track)!, trackState: track.readyState,
          isLiveCaptureSource: track === liveSource?.track, contentHint: track.contentHint,
          degradationPreference };
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
    const ownedPattern = inspectOwnedPattern && video && video.readyState >= 2 && video.videoWidth && video.videoHeight
      ? await readOwnedPatternSnapshot(video) : null;
    return {
      timestamp: performance.now(), configuration, supportsGenerator,
      nativeCaptureCounters: liveSource ? getNativeScreenCaptureDiagnostics(liveSource.track) : null,
      unexpectedAlerts: [...unexpectedAlerts],
      activityAnalysis: { ...analysisTiming },
      product: (() => {
        const rtc = (window as unknown as { coveMediaQA?: { rtc?: {
          screenActivity?: string; screenEncodingPlan?: { fps: number; contentHint: string; degradationPreference: string };
        } } }).coveMediaQA?.rtc;
        return { activity: rtc?.screenActivity ?? null,
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
    await Promise.all(closingAudio);
    const resources = { disposed, liveSourceTracks: sources.filter(source => source.track.readyState === 'live').length,
      liveSyntheticAudioTracks: testAudio.filter(audio => audio.track.readyState === 'live').length,
      openSyntheticAudioContexts: testAudio.filter(audio => audio.context.state !== 'closed').length,
      pendingPresentationCallbacks: [...presentations.values()].filter(state => state.callbackId !== null).length,
      patternSnapshotResources: { ...patternSnapshotResources },
      canvasProfilerRestored: HTMLCanvasElement.prototype.getContext === originalGetContext,
      displayCaptureRestored: navigator.mediaDevices.getDisplayMedia === originalCapture,
      userMediaRestored: navigator.mediaDevices.getUserMedia === originalUserMedia,
      enumerationRestored: navigator.mediaDevices.enumerateDevices === originalEnumeration,
      alertRestored: window.alert === originalAlert };
    return { ...resources, passed: resources.liveSourceTracks === 0 && resources.liveSyntheticAudioTracks === 0 &&
      resources.openSyntheticAudioContexts === 0 && resources.pendingPresentationCallbacks === 0 &&
      resources.patternSnapshotResources.active === 0 && resources.patternSnapshotResources.created === resources.patternSnapshotResources.closed &&
      resources.canvasProfilerRestored && resources.displayCaptureRestored && resources.userMediaRestored && resources.enumerationRestored && resources.alertRestored };
  }
  (window as unknown as { coveScreenPerformance: { sample: typeof sample; cleanup: typeof cleanup; verifyPatternReader: typeof verifyPatternReader } })
    .coveScreenPerformance = { sample, cleanup, verifyPatternReader };
  return { sample, cleanup, verifyPatternReader };
}
