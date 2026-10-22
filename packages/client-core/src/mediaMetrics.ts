/** WebRTC RTT covers a client/SFU round trip, not capture-to-display latency. */
export const MEDIA_TIMING_DEFINITIONS = {
  rtt: { label: 'RTT', unit: 'ms', scope: 'client-sfu-round-trip' },
  jitter: { label: 'RTP jitter', unit: 'ms', scope: 'packet-arrival-variation' },
  endToEndLatency: { measured: false, unit: 'ms', scope: 'capture-to-display' },
} as const;

export function rtcSecondsToMilliseconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value * 10000) && value >= 0
    ? Math.round(value * 1000 * 10) / 10 : null;
}

export function diagnosticRoundTripTimeMs(samples: readonly {
  transport: string; type: string; kind?: string; selected?: boolean; values: Record<string, number>;
}[], transport: string): number | null {
  const current = samples.filter(sample => sample.transport === transport);
  const pairs = current.filter(sample => sample.type === 'candidate-pair');
  const selected = pairs.find(sample => sample.selected === true) ??
    (pairs.length === 1 && pairs[0].selected !== false ? pairs[0] : undefined);
  const candidateRtt = rtcSecondsToMilliseconds(selected?.values.currentRoundTripTime);
  if (candidateRtt !== null) return candidateRtt;
  return rtcSecondsToMilliseconds(current.find(sample => sample.type === 'remote-inbound-rtp' && sample.kind === 'video')?.values.roundTripTime);
}
