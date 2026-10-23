// Test-only source and safe counters for the real two-peer/SFU media fixture.
// Generated-source throughput does not measure Windows desktop capture.
type VideoGenerator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type GeneratorConstructor = new (options: { kind: 'video' }) => VideoGenerator;
type SafeStat = Record<string, number | string | boolean | null>;

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
  };
  const Generator = (window as unknown as { MediaStreamTrackGenerator?: GeneratorConstructor })
    .MediaStreamTrackGenerator;
  const supportsGenerator = Boolean(Generator && typeof VideoFrame === 'function');
  const originalCapture = navigator.mediaDevices.getDisplayMedia;
  const nativeCapture = originalCapture.bind(navigator.mediaDevices);
  const sources: Array<{
    kind: string; track: MediaStreamTrack; width: number | null; height: number | null;
    requestedFps: number | null; uniqueFramesDrawn: number; uniqueFramesWritten: number;
    skippedDeadlines: number; totalWriteMs: number; maxWriteMs: number;
    startedAt: number; lastFrameAt: number | null; error: string | null; stop: () => void;
  }> = [];
  const presentations = new Map<HTMLVideoElement, {
    callbackId: number | null; callbacks: number; firstPresentedFrames: number | null;
    latestPresentedFrames: number | null; firstAt: number | null; lastAt: number | null;
    mediaTime: number | null; processingDuration: number | null;
  }>();
  let disposed = false;
  const videoTrackTokens = new WeakMap<MediaStreamTrack, number>();
  let nextVideoTrackToken = 0;
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
    const connections = await Promise.all([...peerConnections].map(async (connection, index) => {
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
        if (typeof stat.mediaSourceId === 'string') result.mediaSourceId = stat.mediaSourceId;
        stats.push(result);
      }
      return { index, connectionState: connection.connectionState, stats };
    }));
    // Bind recovery checks to the receiver currently feeding the video element.
    // Full-PC stats can retain closed consumers' cumulative inbound counters.
    const video = document.querySelector('video');
    const stream = video?.srcObject instanceof MediaStream ? video.srcObject : null;
    const displayedTrack = stream?.getVideoTracks()[0];
    let currentVideo: { trackToken: number; trackState: string; reportId: string;
      timestamp: number; framesDecoded: number; framesReceived: number } | null = null;
    if (displayedTrack) {
      if (!videoTrackTokens.has(displayedTrack)) videoTrackTokens.set(displayedTrack, ++nextVideoTrackToken);
      for (const connection of peerConnections) {
        const receiver = connection.getReceivers().find(item => item.track === displayedTrack);
        if (!receiver) continue;
        const report = await receiver.getStats();
        const inbound = [...report.values()].filter(stat => stat.type === 'inbound-rtp' &&
          (stat.kind ?? stat.mediaType) === 'video' && typeof stat.framesDecoded === 'number')
          .sort((a, b) => b.framesDecoded - a.framesDecoded)[0];
        if (inbound) currentVideo = { trackToken: videoTrackTokens.get(displayedTrack)!,
          trackState: displayedTrack.readyState, reportId: inbound.id, timestamp: inbound.timestamp,
          framesDecoded: inbound.framesDecoded, framesReceived: inbound.framesReceived ?? 0 };
        break;
      }
    }
    return {
      timestamp: performance.now(), configuration, supportsGenerator,
      sourceMeaning: sourceMode === 'native'
        ? 'Native getDisplayMedia: source production count is unavailable; use media-source counters.'
        : supportsGenerator
          ? 'Every successful generator write has distinct pixels and timestamp; independent of display vsync. This excludes native screen capture.'
          : 'Canvas fallback: drawn images are unique, but canvas capture may coalesce them. Draw count is not captured or encoded FPS.',
      sources: sources.map(({ track, stop: _stop, ...state }) => ({ ...state,
        trackState: track.readyState, settings: safeSettings(track) })),
      connections,
      currentVideo,
      reports: connections.flatMap(connection => connection.stats.map(stat => ({
        ...stat, connectionIndex: connection.index,
      }))),
      presentation: [...presentations].map(([video, state], index) => {
        const quality = video.getVideoPlaybackQuality?.();
        return { index, connected: video.isConnected, paused: video.paused,
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

  function cleanup() {
    if (disposed) return;
    disposed = true;
    mutationObserver.disconnect();
    for (const source of sources) source.stop();
    for (const { context, oscillator, track } of testAudio) { oscillator.stop(); track.stop(); void context.close().catch(() => {}); }
    if (navigator.mediaDevices.getUserMedia === syntheticUserMedia) navigator.mediaDevices.getUserMedia = originalUserMedia;
    navigator.mediaDevices.enumerateDevices = originalEnumeration;
    for (const [video, state] of presentations) if (state.callbackId !== null) video.cancelVideoFrameCallback?.(state.callbackId);
    if (navigator.mediaDevices.getDisplayMedia === capture) navigator.mediaDevices.getDisplayMedia = originalCapture;
  }
  (window as unknown as { coveScreenPerformance: { sample: typeof sample; cleanup: typeof cleanup } })
    .coveScreenPerformance = { sample, cleanup };
  return { sample, cleanup };
}
