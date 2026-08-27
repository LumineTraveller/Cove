export type RtcStat = Record<string, unknown>;

export interface RtcVideoCounterSample {
  id: string;
  timestamp: number;
  bytes: number;
  packets: number;
  framesCaptured: number;
  framesEncoded: number;
  framesSent: number;
  framesReceived: number;
  framesDecoded: number;
  framesDropped: number;
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
  return statsEnabled
    && capturedSessionKey != null
    && capturedSessionKey === currentSessionKey;
}

export function statNumber(stat: RtcStat | undefined, key: string, fallback = 0): number {
  const value = stat?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function videoCounterSample(stat: RtcStat): RtcVideoCounterSample {
  return {
    id: String(stat.id ?? ''),
    timestamp: statNumber(stat, 'timestamp'),
    bytes: statNumber(stat, 'bytesSent', statNumber(stat, 'bytesReceived')),
    packets: statNumber(stat, 'packetsSent', statNumber(stat, 'packetsReceived')),
    framesCaptured: statNumber(stat, 'framesCaptured'),
    framesEncoded: statNumber(stat, 'framesEncoded'),
    framesSent: statNumber(stat, 'framesSent'),
    framesReceived: statNumber(stat, 'framesReceived'),
    framesDecoded: statNumber(stat, 'framesDecoded'),
    framesDropped: statNumber(stat, 'framesDropped'),
    retransmittedBytes: statNumber(stat, 'retransmittedBytesSent', statNumber(stat, 'retransmittedBytesReceived')),
    nackCount: statNumber(stat, 'nackCount'),
    pliCount: statNumber(stat, 'pliCount'),
    firCount: statNumber(stat, 'firCount'),
    totalEncodeTime: statNumber(stat, 'totalEncodeTime'),
    totalDecodeTime: statNumber(stat, 'totalDecodeTime'),
    qpSum: statNumber(stat, 'qpSum'),
  };
}

function rate(current: number, previous: number, elapsedMs: number): number | null {
  if (elapsedMs <= 0 || current < previous) return null;
  return (current - previous) * 1_000 / elapsedMs;
}

function rounded(value: number | null, digits = 1): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function scaledRate(current: number, previous: number, elapsedMs: number, scale: number): number | null {
  const value = rate(current, previous, elapsedMs);
  return value == null ? null : value * scale;
}

export function videoCounterRates(
  current: RtcVideoCounterSample,
  previous: RtcVideoCounterSample | null,
): RtcVideoRates {
  const empty: RtcVideoRates = {
    bitrateKbps: null, packetRate: null,
    captureFps: null, encodeFps: null, sendFps: null,
    receiveFps: null, decodeFps: null, droppedFps: null,
    retransmitKbps: null, nackPerSecond: null, pliPerSecond: null, firPerSecond: null,
    encodeTimeMs: null, decodeTimeMs: null, averageQp: null,
  };
  if (!previous || current.id !== previous.id) return empty;
  const elapsedMs = current.timestamp - previous.timestamp;
  if (elapsedMs <= 0) return empty;

  const encodedFrames = current.framesEncoded - previous.framesEncoded;
  const decodedFrames = current.framesDecoded - previous.framesDecoded;
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
    retransmitKbps: rounded(scaledRate(current.retransmittedBytes, previous.retransmittedBytes, elapsedMs, 8 / 1_000)),
    nackPerSecond: rounded(rate(current.nackCount, previous.nackCount, elapsedMs)),
    pliPerSecond: rounded(rate(current.pliCount, previous.pliCount, elapsedMs)),
    firPerSecond: rounded(rate(current.firCount, previous.firCount, elapsedMs)),
    encodeTimeMs: encodedFrames > 0 && encodeSeconds >= 0 ? rounded(encodeSeconds * 1_000 / encodedFrames, 2) : null,
    decodeTimeMs: decodedFrames > 0 && decodeSeconds >= 0 ? rounded(decodeSeconds * 1_000 / decodedFrames, 2) : null,
    averageQp: encodedFrames > 0 && qp >= 0 ? rounded(qp / encodedFrames, 1) : null,
  };
}

export function intervalLossPercent(
  currentLost: number,
  currentReceivedOrSent: number,
  previous: { lost: number; packets: number } | null,
  packetsIncludeLost = false,
): number | null {
  if (!previous || currentLost < previous.lost || currentReceivedOrSent < previous.packets) return null;
  const lost = currentLost - previous.lost;
  const packets = currentReceivedOrSent - previous.packets;
  const total = packetsIncludeLost ? packets : lost + packets;
  if (total <= 0) return 0;
  return Math.round((lost / total) * 1_000) / 10;
}
