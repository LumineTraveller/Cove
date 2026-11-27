export type RtcStat = Record<string, unknown>;

/** Track/device identifiers and RTCP CNAME/SDP extensions are not diagnostics. */
export function diagnosticTrackSettings(value: MediaTrackSettings | null | undefined): MediaTrackSettings | null {
  if (!value) return null;
  const result: Record<string, unknown> = {};
  for (const key of ['width', 'height', 'frameRate', 'aspectRatio', 'sampleRate', 'sampleSize', 'channelCount', 'latency']) {
    const item = (value as Record<string, unknown>)[key];
    if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
  }
  for (const key of ['autoGainControl', 'echoCancellation', 'noiseSuppression']) {
    const item = (value as Record<string, unknown>)[key];
    if (typeof item === 'boolean') result[key] = item;
  }
  if (typeof value.displaySurface === 'string' && ['browser', 'window', 'monitor'].includes(value.displaySurface))
    result.displaySurface = value.displaySurface;
  return result;
}

export function diagnosticSenderParameters(value: RTCRtpSendParameters | null | undefined) {
  if (!value) return null;
  return {
    encodings: (value.encodings ?? []).slice(0, 8).map(encoding => {
      const result: Record<string, number | boolean> = {};
      for (const key of ['maxBitrate', 'maxFramerate', 'scaleResolutionDownBy']) {
        const item = (encoding as unknown as Record<string, unknown>)[key];
        if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
      }
      if (typeof encoding.active === 'boolean') result.active = encoding.active;
      return result;
    }),
    codecs: (value.codecs ?? []).slice(0, 16).map(codec => ({
      ...(typeof codec.mimeType === 'string' && /^(?:audio|video)\/[a-z\d.+-]{1,40}$/i.test(codec.mimeType) ? { mimeType: codec.mimeType } : {}),
      ...(Number.isFinite(codec.clockRate) ? { clockRate: codec.clockRate } : {}),
      ...(Number.isFinite(codec.channels) ? { channels: codec.channels } : {}),
    })),
  };
}

/** Sender feedback is remoteLoss; loss describes a received stream only. */
export function diagnosticPacketLoss(stats: {
  role: 'sender' | 'receiver' | 'idle';
  loss: number | null;
  remoteLoss: number | null;
}): number | null {
  return stats.role === 'sender' ? stats.remoteLoss : stats.role === 'receiver' ? stats.loss : null;
}

export interface RtcVideoCounterSample {
  id: string;
  timestamp: number | null;
  bytes: number;
  packets: number;
  framesCaptured: number | null;
  framesEncoded: number | null;
  framesSent: number | null;
  framesReceived: number | null;
  framesDecoded: number | null;
  framesDropped: number | null;
  retransmittedBytes: number;
  nackCount: number;
  pliCount: number;
  firCount: number;
  totalEncodeTime: number;
  totalDecodeTime: number;
  qpSum: number;
}

export interface RtcVideoRates {
  bitrateKbps: number | null;
  packetRate: number | null;
  captureFps: number | null;
  encodeFps: number | null;
  sendFps: number | null;
  receiveFps: number | null;
  decodeFps: number | null;
  droppedFps: number | null;
  retransmitKbps: number | null;
  nackPerSecond: number | null;
  pliPerSecond: number | null;
  firPerSecond: number | null;
  encodeTimeMs: number | null;
  decodeTimeMs: number | null;
  averageQp: number | null;
}

export interface FrameRateGap {
  stage: 'capture' | 'delivery' | 'encoder-input' | 'encode' | 'send' | 'decode';
  referenceFps: number;
  observedFps: number;
}

export type FrameRateDiagnosis =
  | { status: 'pending' | 'steady' | 'paused' | 'awaiting-complete-frame' }
  | { status: 'limited'; gaps: FrameRateGap[] };

type FrameRateCounters = Pick<RtcVideoRates, 'captureFps' | 'encodeFps' | 'sendFps' | 'receiveFps' | 'decodeFps'> &
  Partial<Pick<RtcVideoRates, 'bitrateKbps'>>;

export interface NativeFrameCounterSample {
  timestamp: number;
  framesReceived: number;
  framesWritten: number;
}

interface NativeFrameRates {
  receivedFps: number | null;
  writtenFps: number | null;
}

export function nativeFrameCounterRates(
  current: NativeFrameCounterSample,
  previous: NativeFrameCounterSample | null,
): NativeFrameRates {
  if (!previous) return { receivedFps: null, writtenFps: null };
  const elapsedMs = current.timestamp - previous.timestamp;
  if (current.framesReceived < previous.framesReceived || current.framesWritten < previous.framesWritten)
    return { receivedFps: null, writtenFps: null };
  return {
    receivedFps: rounded(rate(current.framesReceived, previous.framesReceived, elapsedMs)),
    writtenFps: rounded(rate(current.framesWritten, previous.framesWritten, elapsedMs)),
  };
}

export function diagnoseFrameRate(
  rates: FrameRateCounters,
  sending: boolean,
  targetFps: number | null,
  nativeFrames: NativeFrameRates | null = null,
): FrameRateDiagnosis {
  const { captureFps, encodeFps, sendFps, receiveFps, decodeFps } = rates;
  if (!sending && receiveFps === 0 && decodeFps === 0)
    return { status: (rates.bitrateKbps ?? 0) > 0 ? 'awaiting-complete-frame' : 'pending' };
  const capped = (fps: number | null) =>
    fps != null && targetFps != null ? Math.min(fps, targetFps) : null;
  type StageSample = [FrameRateGap['stage'], number | null, number | null];
  const sourceStages: StageSample[] = nativeFrames ? [
    ['capture', targetFps, nativeFrames.receivedFps],
    ['delivery', capped(nativeFrames.receivedFps), nativeFrames.writtenFps],
    ['encoder-input', capped(nativeFrames.writtenFps), captureFps],
  ] : [['encoder-input', targetFps, captureFps]];
  const stages: StageSample[] = sending
    ? [
        ...sourceStages,
        ['encode', capped(captureFps), encodeFps],
        ['send', encodeFps, sendFps],
      ]
    : [['decode', receiveFps, decodeFps]];
  let complete = true;
  const gaps: FrameRateGap[] = [];
  for (const [stage, referenceFps, observedFps] of stages) {
    if (referenceFps == null || observedFps == null) {
      complete = false;
      continue;
    }
    // Adjacent pipeline stages can count a frame on opposite sides of the sample boundary.
    if (referenceFps - observedFps > Math.max(2, referenceFps * 0.05))
      gaps.push({ stage, referenceFps, observedFps });
  }
  return gaps.length ? { status: 'limited', gaps } : { status: complete ? 'steady' : 'pending' };
}

export function mediaDiagnosticSessionKey(
  screenProducerId: string | null | undefined,
  watchedPeerId: string | null | undefined,
): string | null {
  if (screenProducerId) return `sender:${screenProducerId}`;
  if (watchedPeerId) return `receiver:${watchedPeerId}`;
  return null;
}

export function shouldAcceptMediaDiagnosticSample(
  statsEnabled: boolean,
  capturedSessionKey: string | null,
  currentSessionKey: string | null,
): boolean {
  return statsEnabled && capturedSessionKey != null && capturedSessionKey === currentSessionKey;
}

export function statNumber(stat: RtcStat | undefined, key: string, fallback = 0): number {
  const value = stat?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function frameCounter(stat: RtcStat | undefined, key: string): number | null {
  const value = statNumber(stat, key, -1);
  return value >= 0 ? value : null;
}

export function videoCounterSample(stat: RtcStat, mediaSource?: RtcStat): RtcVideoCounterSample {
  const sourceFrames = frameCounter(mediaSource, 'frames');
  return {
    id: `${String(stat.id ?? '')}:${sourceFrames == null ? 'rtp' : `source:${String(mediaSource?.id ?? '')}`}`,
    timestamp: frameCounter(stat, 'timestamp'),
    bytes: statNumber(stat, 'bytesSent', statNumber(stat, 'bytesReceived')),
    packets: statNumber(stat, 'packetsSent', statNumber(stat, 'packetsReceived')),
    framesCaptured: sourceFrames ?? frameCounter(stat, 'framesCaptured'),
    framesEncoded: frameCounter(stat, 'framesEncoded'),
    framesSent: frameCounter(stat, 'framesSent'),
    framesReceived: frameCounter(stat, 'framesReceived'),
    framesDecoded: frameCounter(stat, 'framesDecoded'),
    framesDropped: frameCounter(stat, 'framesDropped'),
    retransmittedBytes: statNumber(
      stat,
      'retransmittedBytesSent',
      statNumber(stat, 'retransmittedBytesReceived'),
    ),
    nackCount: statNumber(stat, 'nackCount'),
    pliCount: statNumber(stat, 'pliCount'),
    firCount: statNumber(stat, 'firCount'),
    totalEncodeTime: statNumber(stat, 'totalEncodeTime'),
    totalDecodeTime: statNumber(stat, 'totalDecodeTime'),
    qpSum: statNumber(stat, 'qpSum'),
  };
}

function counterDelta(current: number | null, previous: number | null): number | null {
  return current == null || previous == null || current < previous ? null : current - previous;
}

function rate(current: number | null, previous: number | null, elapsedMs: number): number | null {
  const delta = counterDelta(current, previous);
  return delta == null || elapsedMs <= 0 ? null : (delta * 1_000) / elapsedMs;
}

function rounded(value: number | null, digits = 1): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function scaledRate(
  current: number,
  previous: number,
  elapsedMs: number,
  scale: number,
): number | null {
  const value = rate(current, previous, elapsedMs);
  return value == null ? null : value * scale;
}

export function videoCounterRates(
  current: RtcVideoCounterSample,
  previous: RtcVideoCounterSample | null,
): RtcVideoRates {
  const empty: RtcVideoRates = {
    bitrateKbps: null,
    packetRate: null,
    captureFps: null,
    encodeFps: null,
    sendFps: null,
    receiveFps: null,
    decodeFps: null,
    droppedFps: null,
    retransmitKbps: null,
    nackPerSecond: null,
    pliPerSecond: null,
    firPerSecond: null,
    encodeTimeMs: null,
    decodeTimeMs: null,
    averageQp: null,
  };
  if (!previous || current.id !== previous.id || current.timestamp == null || previous.timestamp == null)
    return empty;
  const elapsedMs = current.timestamp - previous.timestamp;
  if (elapsedMs <= 0) return empty;

  const encodedFrames = counterDelta(current.framesEncoded, previous.framesEncoded);
  const decodedFrames = counterDelta(current.framesDecoded, previous.framesDecoded);
  const encodeSeconds = current.totalEncodeTime - previous.totalEncodeTime;
  const decodeSeconds = current.totalDecodeTime - previous.totalDecodeTime;
  const qp = current.qpSum - previous.qpSum;

  return {
    bitrateKbps: rounded(scaledRate(current.bytes, previous.bytes, elapsedMs, 8 / 1_000)),
    packetRate: rounded(rate(current.packets, previous.packets, elapsedMs)),
    captureFps: rounded(rate(current.framesCaptured, previous.framesCaptured, elapsedMs)),
    encodeFps: rounded(rate(current.framesEncoded, previous.framesEncoded, elapsedMs)),
    sendFps: rounded(rate(current.framesSent, previous.framesSent, elapsedMs)),
    receiveFps: rounded(rate(current.framesReceived, previous.framesReceived, elapsedMs)),
    decodeFps: rounded(rate(current.framesDecoded, previous.framesDecoded, elapsedMs)),
    droppedFps: rounded(rate(current.framesDropped, previous.framesDropped, elapsedMs)),
    retransmitKbps: rounded(
      scaledRate(current.retransmittedBytes, previous.retransmittedBytes, elapsedMs, 8 / 1_000),
    ),
    nackPerSecond: rounded(rate(current.nackCount, previous.nackCount, elapsedMs)),
    pliPerSecond: rounded(rate(current.pliCount, previous.pliCount, elapsedMs)),
    firPerSecond: rounded(rate(current.firCount, previous.firCount, elapsedMs)),
    encodeTimeMs:
      encodedFrames != null && encodedFrames > 0 && encodeSeconds >= 0
        ? rounded((encodeSeconds * 1_000) / encodedFrames, 2)
        : null,
    decodeTimeMs:
      decodedFrames != null && decodedFrames > 0 && decodeSeconds >= 0
        ? rounded((decodeSeconds * 1_000) / decodedFrames, 2)
        : null,
    averageQp: encodedFrames != null && encodedFrames > 0 && qp >= 0 ? rounded(qp / encodedFrames, 1) : null,
  };
}

export function intervalLossPercent(
  currentLost: number,
  currentReceivedOrSent: number,
  previous: { lost: number; packets: number } | null,
  packetsIncludeLost = false,
): number | null {
  if (!previous || currentLost < previous.lost || currentReceivedOrSent < previous.packets)
    return null;
  const lost = currentLost - previous.lost;
  const packets = currentReceivedOrSent - previous.packets;
  const total = packetsIncludeLost ? packets : lost + packets;
  if (total <= 0) return 0;
  return Math.round((lost / total) * 1_000) / 10;
}

/** Numeric allowlist: preserve raw windows/queue counters without exporting
 * candidate addresses, identifiers, credentials, or absent values as zero.
 */
export function diagnosticVideoCounters(rtp?: RtcStat, source?: RtcStat) {
  const pick = (stat: RtcStat | undefined, keys: readonly string[]) =>
    Object.fromEntries(keys.map((key) => {
      const value = stat?.[key];
      return [key, typeof value === 'number' && Number.isFinite(value) ? value : null];
    }));
  return {
    rtp: pick(rtp, [
      'timestamp', 'framesCaptured', 'framesEncoded', 'keyFramesEncoded', 'framesSent', 'framesReceived',
      'framesDecoded', 'keyFramesDecoded', 'framesDropped', 'packetsSent', 'packetsReceived',
      'packetsLost', 'bytesSent', 'bytesReceived', 'retransmittedBytesSent',
      'retransmittedPacketsSent', 'nackCount', 'pliCount', 'firCount', 'qpSum',
      'targetBitrate', 'totalEncodeTime', 'totalDecodeTime', 'totalPacketSendDelay',
      'jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay',
      'jitterBufferEmittedCount', 'totalProcessingDelay', 'totalInterFrameDelay',
      'freezeCount', 'totalFreezesDuration',
    ]),
    mediaSource: pick(source, ['timestamp', 'frames', 'framesPerSecond', 'width', 'height']),
  };
}
