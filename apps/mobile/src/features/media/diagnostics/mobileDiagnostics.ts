export interface MobileDiagnosticsInput {
  stage: { inVoice: boolean; watching: boolean; sharing: boolean };
  stats: { send: unknown; receive: unknown; screenSend: unknown };
  server: unknown;
}
export interface DiagnosticSample {
  transport: 'send' | 'receive' | 'screenSend';
  type: string;
  kind?: 'audio' | 'video';
  codec?: string;
  values: Record<string, number>;
}
export interface MobileDiagnosticReport {
  schemaVersion: 1;
  platform: 'android';
  sampledAt: number;
  stage: MobileDiagnosticsInput['stage'];
  samples: DiagnosticSample[];
  server: unknown;
}
const numericKeys = new Set([
  'timestamp',
  'bytesReceived',
  'bytesSent',
  'packetsReceived',
  'packetsSent',
  'packetsLost',
  'framesReceived',
  'framesDecoded',
  'framesEncoded',
  'framesSent',
  'framesDropped',
  'framesPerSecond',
  'frameWidth',
  'frameHeight',
  'jitter',
  'roundTripTime',
  'currentRoundTripTime',
  'totalRoundTripTime',
  'totalDecodeTime',
  'totalEncodeTime',
  'keyFramesDecoded',
  'keyFramesEncoded',
  'nackCount',
  'pliCount',
  'firCount',
  'retransmittedBytesSent',
  'retransmittedPacketsSent',
  'availableOutgoingBitrate',
  'availableIncomingBitrate',
  'targetBitrate',
  'totalSamplesReceived',
  'concealedSamples',
  'audioLevel',
  'score',
  'bitrate',
  'packetsDiscarded',
  'packetCount',
  'byteCount',
  'fractionLost',
  'rtt',
]);
const reportTypes = new Set([
  'inbound-rtp',
  'outbound-rtp',
  'remote-inbound-rtp',
  'remote-outbound-rtp',
  'candidate-pair',
  'track',
  'media-source',
  'transport',
]);
const serverContainers = new Set([
  'transports',
  'send',
  'receive',
  'producers',
  'consumers',
  'stats',
  'score',
]);
function numericValues(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]) =>
        numericKeys.has(key) &&
        typeof item === 'number' &&
        Number.isFinite(item),
    ),
  );
}
function entries(report: unknown): Record<string, unknown>[] {
  if (!report || typeof report !== 'object') return [];
  try {
    const list =
      report instanceof Map
        ? [...report.values()]
        : Array.isArray(report)
        ? report
        : typeof (report as { forEach?: unknown }).forEach === 'function'
        ? (() => {
            const items: unknown[] = [];
            (
              report as { forEach: (callback: (item: unknown) => void) => void }
            ).forEach(item => items.push(item));
            return items;
          })()
        : Object.values(report);
    return list
      .filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && !Array.isArray(item),
      )
      .slice(0, 500);
  } catch {
    return [];
  }
}
function safeServer(value: unknown, depth = 0): unknown {
  if (depth > 5 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value))
    return value.slice(0, 50).map(item => safeServer(item, depth + 1));
  const result: Record<string, unknown> = numericValues(
    value as Record<string, unknown>,
  );
  for (const [key, item] of Object.entries(value)) {
    if (serverContainers.has(key) && item && typeof item === 'object') {
      result[key] = safeServer(item, depth + 1);
    }
  }
  return result;
}
/** Only numeric metrics and codec names leave the device; ICE addresses, tokens and labels are excluded. */
export function normalizeMobileDiagnostics(
  input: MobileDiagnosticsInput,
  sampledAt = Date.now(),
): MobileDiagnosticReport {
  const samples: DiagnosticSample[] = [];
  for (const transport of ['send', 'receive', 'screenSend'] as const) {
    const reports = entries(input.stats?.[transport]);
    const codecs = new Map(
      reports.flatMap(report =>
        typeof report.id === 'string' &&
        typeof report.mimeType === 'string' &&
        /^(?:audio|video)\/[a-z\d.+-]+$/i.test(report.mimeType)
          ? [[report.id, report.mimeType] as const]
          : [],
      ),
    );
    for (const report of reports) {
      if (typeof report.type !== 'string' || !reportTypes.has(report.type))
        continue;
      const kind = report.kind ?? report.mediaType;
      const codec =
        typeof report.codecId === 'string'
          ? codecs.get(report.codecId)
          : undefined;
      samples.push({
        transport,
        type: report.type,
        ...(kind === 'audio' || kind === 'video' ? { kind } : {}),
        ...(codec ? { codec } : {}),
        values: numericValues(report) as Record<string, number>,
      });
    }
  }
  return {
    schemaVersion: 1,
    platform: 'android',
    sampledAt,
    stage: {
      inVoice: input.stage?.inVoice === true,
      watching: input.stage?.watching === true,
      sharing: input.stage?.sharing === true,
    },
    samples,
    server: safeServer(input.server),
  };
}
export function videoDiagnosticSample(report: MobileDiagnosticReport) {
  return (
    report.samples.find(
      sample =>
        sample.transport === 'receive' &&
        sample.type === 'inbound-rtp' &&
        sample.kind === 'video',
    ) ??
    report.samples.find(
      sample => sample.type === 'outbound-rtp' && sample.kind === 'video',
    )
  );
}
export function videoBitrate(
  previous: MobileDiagnosticReport | null,
  current: MobileDiagnosticReport,
): number | null {
  if (!previous || current.sampledAt <= previous.sampledAt) return null;
  const oldSample = videoDiagnosticSample(previous),
    nextSample = videoDiagnosticSample(current);
  if (
    !oldSample ||
    !nextSample ||
    oldSample.transport !== nextSample.transport ||
    oldSample.type !== nextSample.type
  )
    return null;
  const key = nextSample.type === 'inbound-rtp' ? 'bytesReceived' : 'bytesSent';
  const oldBytes = oldSample.values[key],
    nextBytes = nextSample.values[key];
  const elapsed = (current.sampledAt - previous.sampledAt) / 1000;
  if (
    !Number.isFinite(oldBytes) ||
    !Number.isFinite(nextBytes) ||
    nextBytes < oldBytes ||
    elapsed < 0.25
  )
    return null;
  return ((nextBytes - oldBytes) * 8) / elapsed;
}
