import type { ScreenEncodingDiagnostics } from '../screen/screenSharing';
import { MEDIA_TIMING_DEFINITIONS, diagnosticRoundTripTimeMs, normalizeRecoveryDiagnostics, type RecoveryDiagnosticReport } from '@cove/client-core';

export interface MobileDiagnosticsInput {
  stage: { inVoice: boolean; watching: boolean; sharing: boolean };
  stats: { send: unknown; receive: unknown; screenSend: unknown };
  server: unknown;
  screenEncoder?: unknown;
  recovery?: unknown;
}
export interface DiagnosticSample {
  transport: 'send' | 'receive' | 'screenSend';
  type: string;
  kind?: 'audio' | 'video';
  codec?: string;
  encoderImplementation?: string;
  powerEfficientEncoder?: boolean;
  selected?: boolean;
  qualityLimitationReason?: 'none' | 'cpu' | 'bandwidth' | 'other';
  values: Record<string, number>;
}
export interface MobileDiagnosticReport {
  schemaVersion: 1;
  platform: 'android';
  sampledAt: number;
  stage: MobileDiagnosticsInput['stage'];
  samples: DiagnosticSample[];
  server: unknown;
  screenEncoder?: ScreenEncodingDiagnostics;
  metricDefinitions?: typeof MEDIA_TIMING_DEFINITIONS;
  recovery?: RecoveryDiagnosticReport;
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
// Only implementation names with known encoder families are exported; arbitrary text is excluded.
function encoderImplementation(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= 128 &&
    /^(?:OMX\.[a-z\d._-]+|c2\.[a-z\d._-]+|(?:MediaCodec|HardwareVideoEncoder|SoftwareVideoEncoder|OpenH264|libvpx|libaom|LibaomAv1Encoder|SimulcastEncoderAdapter|VideoEncoderSoftwareFallbackWrapper)[ a-z\d._()+:/-]*)$/i.test(
      value,
    )
    ? value
    : undefined;
}
const encoderExceptionClasses = new Set([
  'IllegalStateException',
  'IllegalArgumentException',
  'RuntimeException',
  'CodecException',
  'SecurityException',
  'NullPointerException',
  'UnsupportedOperationException',
]);
function safeScreenEncoder(
  value: unknown,
): ScreenEncodingDiagnostics | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const reasons = [
    'hardware-h264',
    'hardware-unavailable',
    'hardware-profile-incompatible',
    'capability-unavailable',
    'fallback',
  ];
  if (
    typeof input.sequence !== 'number' ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0 ||
    typeof input.selectionReason !== 'string' ||
    !reasons.includes(input.selectionReason)
  )
    return undefined;
  const codecName = (item: unknown) =>
    typeof item === 'string' && /^(?:H264|VP8|VP9|AV1)$/.test(item)
      ? item
      : undefined;
  const result: ScreenEncodingDiagnostics = {
    sequence: input.sequence,
    selectionReason:
      input.selectionReason as ScreenEncodingDiagnostics['selectionReason'],
    hardwareProbe:
      typeof input.hardwareProbe === 'boolean' ? input.hardwareProbe : null,
    attempts: [],
  };
  const selected = codecName(input.selectedCodec);
  if (selected) result.selectedCodec = selected;
  if (Array.isArray(input.attempts))
    for (const item of input.attempts.slice(0, 4)) {
      if (!item || typeof item !== 'object') continue;
      const codec = codecName(item.codec);
      if (!codec || !['selected', 'failed'].includes(item.outcome)) continue;
      const attempt: ScreenEncodingDiagnostics['attempts'][number] = {
        codec,
        outcome: item.outcome,
      };
      if (
        [
          'negotiation',
          'native-create',
          'native-init',
          'native-encode',
        ].includes(item.reason)
      )
        attempt.reason = item.reason;
      if (
        typeof item.code === 'string' &&
        (/^[A-Z][A-Z\d_]{0,63}$/.test(item.code) ||
          encoderExceptionClasses.has(item.code))
      )
        attempt.code = item.code;
      result.attempts.push(attempt);
    }
  if (input.ready && typeof input.ready === 'object') {
    const ready = input.ready as Record<string, unknown>;
    const implementation = encoderImplementation(ready.implementation),
      codec = codecName(ready.codec);
    if (
      implementation &&
      codec &&
      typeof ready.hardwareAccelerated === 'boolean' &&
      [ready.width, ready.height, ready.targetFps].every(
        item => typeof item === 'number' && Number.isFinite(item) && item > 0,
      )
    )
      result.ready = {
        codec,
        implementation,
        hardwareAccelerated: ready.hardwareAccelerated,
        width: ready.width as number,
        height: ready.height as number,
        targetFps: ready.targetFps as number,
      };
    if (
      result.ready &&
      typeof ready.encoderMaxFramerate === 'number' &&
      Number.isFinite(ready.encoderMaxFramerate) &&
      ready.encoderMaxFramerate > 0
    )
      result.ready.encoderMaxFramerate = ready.encoderMaxFramerate;
  }
  return result;
}
/** Export only allowlisted media metrics and encoder metadata, never ICE, identity or credentials. */
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
        ...(report.type === 'candidate-pair' &&
          (typeof report.selected === 'boolean' || typeof report.nominated === 'boolean' ||
            (typeof report.state === 'string' && report.state !== 'succeeded'))
          ? { selected: (!report.state || report.state === 'succeeded') && (report.selected === true || report.nominated === true) } : {}),
        ...(encoderImplementation(report.encoderImplementation)
          ? {
              encoderImplementation: encoderImplementation(
                report.encoderImplementation,
              ),
            }
          : {}),
        ...(typeof report.powerEfficientEncoder === 'boolean'
          ? { powerEfficientEncoder: report.powerEfficientEncoder }
          : {}),
        ...(['none', 'cpu', 'bandwidth', 'other'].includes(
          String(report.qualityLimitationReason),
        )
          ? {
              qualityLimitationReason:
                report.qualityLimitationReason as DiagnosticSample['qualityLimitationReason'],
            }
          : {}),
        values: numericValues(report) as Record<string, number>,
      });
    }
  }
  return {
    schemaVersion: 1,
    platform: 'android',
    sampledAt,
    metricDefinitions: MEDIA_TIMING_DEFINITIONS,
    stage: {
      inVoice: input.stage?.inVoice === true,
      watching: input.stage?.watching === true,
      sharing: input.stage?.sharing === true,
    },
    samples,
    server: safeServer(input.server),
    ...(input.recovery ? { recovery: normalizeRecoveryDiagnostics(input.recovery) } : {}),
    ...(safeScreenEncoder(input.screenEncoder)
      ? { screenEncoder: safeScreenEncoder(input.screenEncoder) }
      : {}),
  };
}
export function videoDiagnosticSample(report: MobileDiagnosticReport) {
  if (report.stage.sharing)
    return report.samples.find(
      sample =>
        sample.transport === 'screenSend' &&
        sample.type === 'outbound-rtp' &&
        sample.kind === 'video',
    );
  return (
    report.samples.find(
      sample =>
        sample.transport === 'receive' &&
        sample.type === 'inbound-rtp' &&
        sample.kind === 'video',
    ) ??
    report.samples.find(
      sample =>
        sample.transport === 'screenSend' &&
        sample.type === 'outbound-rtp' &&
        sample.kind === 'video',
    )
  );
}
/** Avoid choosing an arbitrary ICE pair when a platform omits selection flags. */
export function mobileRoundTripTimeMs(report: MobileDiagnosticReport): number | null {
  const transport = report.stage.sharing ? 'screenSend' : report.stage.watching ? 'receive' : 'send';
  return diagnosticRoundTripTimeMs(report.samples, transport);
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
    oldSample.type !== nextSample.type ||
    oldSample.codec !== nextSample.codec ||
    (nextSample.transport === 'screenSend' &&
      previous.screenEncoder?.sequence !== current.screenEncoder?.sequence)
  )
    return null;
  const key = nextSample.type === 'inbound-rtp' ? 'bytesReceived' : 'bytesSent';
  const oldBytes = oldSample.values[key],
    nextBytes = nextSample.values[key];
  const elapsed = sampleElapsed(previous, current, oldSample, nextSample);
  if (
    !Number.isFinite(oldBytes) ||
    !Number.isFinite(nextBytes) ||
    nextBytes < oldBytes ||
    elapsed < 0.25
  )
    return null;
  return ((nextBytes - oldBytes) * 8) / elapsed;
}

function sampleElapsed(
  previous: MobileDiagnosticReport,
  current: MobileDiagnosticReport,
  before: DiagnosticSample,
  after: DiagnosticSample,
) {
  const first = before.values.timestamp,
    second = after.values.timestamp;
  return Number.isFinite(first) && Number.isFinite(second)
    ? (second - first) / 1000
    : (current.sampledAt - previous.sampledAt) / 1000;
}

/** Counter deltas describe the sampling window, rather than a lifetime average. */
export function videoEncodingPerformance(
  previous: MobileDiagnosticReport | null,
  current: MobileDiagnosticReport,
) {
  const empty = {
    framesPerSecond: null as number | null,
    encodeMsPerFrame: null as number | null,
  };
  if (!previous || current.sampledAt <= previous.sampledAt) return empty;
  const before = videoDiagnosticSample(previous),
    after = videoDiagnosticSample(current);
  if (
    !before ||
    !after ||
    before.transport !== 'screenSend' ||
    after.transport !== 'screenSend' ||
    before.type !== 'outbound-rtp' ||
    after.type !== 'outbound-rtp' ||
    before.codec !== after.codec ||
    previous.screenEncoder?.sequence !== current.screenEncoder?.sequence
  )
    return empty;
  const elapsed = sampleElapsed(previous, current, before, after);
  const frames = after.values.framesEncoded - before.values.framesEncoded;
  const encodeTime =
    after.values.totalEncodeTime - before.values.totalEncodeTime;
  if (elapsed < 0.25 || !Number.isFinite(frames) || frames < 0) return empty;
  return {
    framesPerSecond: frames / elapsed,
    encodeMsPerFrame:
      frames > 0 && Number.isFinite(encodeTime) && encodeTime >= 0
        ? (encodeTime * 1000) / frames
        : null,
  };
}
