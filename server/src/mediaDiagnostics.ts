type UnknownStat = Record<string, unknown>;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export interface TransportDiagnostic {
  transportId: string | null;
  timestamp: number | null;
  protocol: string | null;
  recvBitrateKbps: number | null;
  sendBitrateKbps: number | null;
  rtpRecvBitrateKbps: number | null;
  rtpSendBitrateKbps: number | null;
  rtxRecvBitrateKbps: number | null;
  rtxSendBitrateKbps: number | null;
  availableIncomingKbps: number | null;
  availableOutgoingKbps: number | null;
  packetLossReceived: number | null;
  packetLossSent: number | null;
  iceState: string | null;
  dtlsState: string | null;
}

export interface RtpStreamDiagnostic {
  timestamp: number | null;
  kind: string | null;
  mimeType: string | null;
  bitrateKbps: number | null;
  packetsLost: number | null;
  fractionLost: number | null;
  jitter: number | null;
  packetsDiscarded: number | null;
  packetsRetransmitted: number | null;
  packetsRepaired: number | null;
  nackCount: number | null;
  pliCount: number | null;
  firCount: number | null;
  roundTripTimeMs: number | null;
  score: number | null;
}

function kbps(value: unknown): number | null {
  const number = finiteNumber(value);
  return number == null ? null : Math.round(number / 100) / 10;
}

export function summarizeTransportStat(stat: UnknownStat | undefined): TransportDiagnostic | null {
  if (!stat) return null;
  const tuple = stat.iceSelectedTuple as UnknownStat | undefined;
  return {
    transportId: text(stat.transportId),
    timestamp: finiteNumber(stat.timestamp),
    protocol: text(tuple?.protocol)?.toUpperCase() ?? null,
    recvBitrateKbps: kbps(stat.recvBitrate),
    sendBitrateKbps: kbps(stat.sendBitrate),
    rtpRecvBitrateKbps: kbps(stat.rtpRecvBitrate),
    rtpSendBitrateKbps: kbps(stat.rtpSendBitrate),
    rtxRecvBitrateKbps: kbps(stat.rtxRecvBitrate),
    rtxSendBitrateKbps: kbps(stat.rtxSendBitrate),
    availableIncomingKbps: kbps(stat.availableIncomingBitrate),
    availableOutgoingKbps: kbps(stat.availableOutgoingBitrate),
    packetLossReceived: finiteNumber(stat.rtpPacketLossReceived),
    packetLossSent: finiteNumber(stat.rtpPacketLossSent),
    iceState: text(stat.iceState),
    dtlsState: text(stat.dtlsState),
  };
}

export function summarizeRtpStat(stat: UnknownStat): RtpStreamDiagnostic {
  const rtt = finiteNumber(stat.roundTripTime);
  return {
    timestamp: finiteNumber(stat.timestamp),
    kind: text(stat.kind),
    mimeType: text(stat.mimeType),
    bitrateKbps: kbps(stat.bitrate),
    packetsLost: finiteNumber(stat.packetsLost),
    fractionLost: finiteNumber(stat.fractionLost),
    jitter: finiteNumber(stat.jitter),
    packetsDiscarded: finiteNumber(stat.packetsDiscarded),
    packetsRetransmitted: finiteNumber(stat.packetsRetransmitted),
    packetsRepaired: finiteNumber(stat.packetsRepaired),
    nackCount: finiteNumber(stat.nackCount),
    pliCount: finiteNumber(stat.pliCount),
    firCount: finiteNumber(stat.firCount),
    roundTripTimeMs: rtt == null ? null : Math.round(rtt * 1_000),
    score: finiteNumber(stat.score),
  };
}
