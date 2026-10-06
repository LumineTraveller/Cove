import { useCallback } from 'react';
import { Socket } from 'socket.io-client';

import {
  intervalLossPercent,
  mediaDiagnosticSessionKey,
  shouldAcceptMediaDiagnosticSample,
  statNumber,
  type RtcStat,
  type RtcVideoCounterSample,
  videoCounterRates,
  videoCounterSample,
} from './mediaDiagnostics';
import { SCREEN_MAX_BITRATE_BPS, type ScreenEncodingPlan } from '../screen/screenCapture';

import {
  Transport,
  Producer,
  Consumer,
  Fps,
  MediaStats,
  EMPTY_STATS,
  ServerMediaDiagnostics,
} from '../desktopMediaSupport';

export interface useMediaDiagnosticsDependencies {
  readonly statsCollecting: import('react').MutableRefObject<boolean>;
  readonly screenProducer: import('react').MutableRefObject<Producer | null>;
  readonly watchingScreenPeerRef: import('react').MutableRefObject<string | null>;
  readonly statsEnabledRef: import('react').MutableRefObject<boolean>;
  readonly videoCounterPrev: import('react').MutableRefObject<RtcVideoCounterSample | null>;
  readonly receiveLossPrev: import('react').MutableRefObject<{
    lost: number;
    packets: number;
  } | null>;
  readonly remoteLossPrev: import('react').MutableRefObject<{
    lost: number;
    packets: number;
  } | null>;
  readonly setStats: import('react').Dispatch<import('react').SetStateAction<MediaStats>>;
  readonly sendTransport: import('react').MutableRefObject<Transport | null>;
  readonly recvTransport: import('react').MutableRefObject<Transport | null>;
  readonly consumers: import('react').MutableRefObject<
    Map<
      string,
      {
        consumer: Consumer;
        socketId: string;
        kind: string;
        producerId: string;
        sourceType?: string;
      }
    >
  >;
  readonly socket: Socket<
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap,
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap
  >;
  readonly diagnosticHistory: import('react').MutableRefObject<
    { timestamp: string; stats: MediaStats; trackSettings: MediaTrackSettings | null }[]
  >;
  readonly setStatsEnabled: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  readonly statsTimer: import('react').MutableRefObject<number | null>;
  readonly roomId: string;
  readonly screenPreset: '540p' | '720p' | '1080p' | '1440p';
  readonly screenGameMode: boolean;
  readonly fps: Fps;
  readonly screenNativeResolution: boolean;
  readonly screenEncodingPlan: ScreenEncodingPlan | null;
}

export function useMediaDiagnostics(deps: useMediaDiagnosticsDependencies) {
  // 分阶段媒体统计：采集 → 编码 → RTP 发送 → SFU → RTP 接收 → 解码。
  // 每个速率都由同一个 RTP 对象的累计计数器求差，避免切换共享或统计对象时出现假低值/假峰值。
  const collectStats = useCallback(async () => {
    if (deps.statsCollecting.current) return;
    deps.statsCollecting.current = true;
    const next: MediaStats = { ...EMPTY_STATS };
    const sendingProducerId = deps.screenProducer.current?.id ?? null;
    const sendingScreen = Boolean(sendingProducerId);
    const watchedPeerId = deps.watchingScreenPeerRef.current;
    const capturedSessionKey = mediaDiagnosticSessionKey(sendingProducerId, watchedPeerId);
    if (!deps.statsEnabledRef.current || !capturedSessionKey) {
      deps.videoCounterPrev.current = null;
      deps.receiveLossPrev.current = null;
      deps.remoteLossPrev.current = null;
      deps.setStats(EMPTY_STATS);
      deps.statsCollecting.current = false;
      return;
    }
    next.role = sendingScreen ? 'sender' : watchedPeerId ? 'receiver' : 'idle';

    try {
      const selectedTransport = sendingScreen
        ? deps.sendTransport.current
        : watchedPeerId
        ? deps.recvTransport.current
        : null;
      if (selectedTransport) {
        const report = await selectedTransport.getStats();
        const pairs: RtcStat[] = [];
        report.forEach((stat) => {
          const value = stat as unknown as RtcStat;
          if (value.type === 'candidate-pair' && (!value.state || value.state === 'succeeded'))
            pairs.push(value);
        });
        const pair =
          pairs.find((value) => value.nominated === true || value.selected === true) ?? pairs[0];
        if (pair) {
          if (typeof pair.currentRoundTripTime === 'number')
            next.rtt = Math.round(pair.currentRoundTripTime * 1_000);
          if (sendingScreen && typeof pair.availableOutgoingBitrate === 'number')
            next.availableBitrate = Math.round(pair.availableOutgoingBitrate / 1_000);
          const candidate = report.get(String(pair.localCandidateId ?? '')) as unknown as
            | RtcStat
            | undefined;
          if (candidate?.protocol) next.protocol = String(candidate.protocol).toUpperCase();
        }
      }

      let videoReport: RTCStatsReport | null = null;
      let videoTrack: MediaStreamTrack | null = null;
      if (deps.screenProducer.current) {
        videoReport = await deps.screenProducer.current.getStats();
        videoTrack = deps.screenProducer.current.track ?? null;
      } else {
        for (const { consumer, kind, socketId } of deps.consumers.current.values()) {
          if (kind !== 'video' || (watchedPeerId && socketId !== watchedPeerId)) continue;
          videoReport = await consumer.getStats();
          videoTrack = consumer.track ?? null;
          break;
        }
      }

      if (videoTrack) {
        const settings = videoTrack.getSettings();
        next.trackFps =
          typeof settings.frameRate === 'number' ? Math.round(settings.frameRate * 10) / 10 : null;
        next.trackWidth = settings.width ?? null;
        next.trackHeight = settings.height ?? null;
        next.displaySurface = settings.displaySurface ?? null;
      }

      let rtpStat: RtcStat | undefined;
      let remoteInbound: RtcStat | undefined;
      let mediaSource: RtcStat | undefined;
      videoReport?.forEach((stat) => {
        const value = stat as unknown as RtcStat;
        const isVideo = !value.kind || value.kind === 'video' || value.mediaType === 'video';
        if (sendingScreen && value.type === 'outbound-rtp' && value.isRemote !== true && isVideo)
          rtpStat = value;
        if (!sendingScreen && value.type === 'inbound-rtp' && value.isRemote !== true && isVideo)
          rtpStat = value;
        if (value.type === 'remote-inbound-rtp' && isVideo) remoteInbound = value;
        if (value.type === 'media-source' && isVideo) mediaSource = value;
      });

      if (rtpStat && videoReport) {
        if (rtpStat.mediaSourceId) {
          const linkedSource = videoReport.get(String(rtpStat.mediaSourceId)) as unknown as
            | RtcStat
            | undefined;
          if (linkedSource) mediaSource = linkedSource;
        }
        const counterStat: RtcStat = {
          ...rtpStat,
          id: `${String(rtpStat.id ?? '')}:${String(mediaSource?.id ?? '')}`,
          framesCaptured: statNumber(mediaSource, 'frames', statNumber(rtpStat, 'framesCaptured')),
        };
        const sample = videoCounterSample(counterStat);
        const rates = videoCounterRates(sample, deps.videoCounterPrev.current);
        deps.videoCounterPrev.current = sample;

        const sourceReportedFps =
          typeof mediaSource?.framesPerSecond === 'number'
            ? Math.round(mediaSource.framesPerSecond * 10) / 10
            : null;
        const rtpReportedFps =
          typeof rtpStat.framesPerSecond === 'number'
            ? Math.round(rtpStat.framesPerSecond * 10) / 10
            : null;
        const hasCaptureCounter =
          typeof mediaSource?.frames === 'number' || typeof rtpStat.framesCaptured === 'number';
        next.captureFps = hasCaptureCounter
          ? rates.captureFps ?? sourceReportedFps
          : sourceReportedFps;
        next.encodeFps = typeof rtpStat.framesEncoded === 'number' ? rates.encodeFps : null;
        next.sendFps = typeof rtpStat.framesSent === 'number' ? rates.sendFps : null;
        next.receiveFps = typeof rtpStat.framesReceived === 'number' ? rates.receiveFps : null;
        next.decodeFps =
          typeof rtpStat.framesDecoded === 'number'
            ? rates.decodeFps ?? (!sendingScreen ? rtpReportedFps : null)
            : !sendingScreen
            ? rtpReportedFps
            : null;
        next.fps = sendingScreen
          ? next.sendFps ?? next.encodeFps ?? rtpReportedFps
          : next.decodeFps ?? next.receiveFps ?? rtpReportedFps;
        next.bitrate = rates.bitrateKbps;
        next.retransmitBitrate = rates.retransmitKbps;
        next.encodeTimeMs = rates.encodeTimeMs;
        next.decodeTimeMs = rates.decodeTimeMs;
        next.averageQp = rates.averageQp;
        next.nackPerSecond = rates.nackPerSecond;
        next.pliPerSecond = rates.pliPerSecond;
        next.firPerSecond = rates.firPerSecond;
        next.droppedFrames = typeof rtpStat.framesDropped === 'number' ? rates.droppedFps : null;
        next.width = typeof rtpStat.frameWidth === 'number' ? rtpStat.frameWidth : null;
        next.height = typeof rtpStat.frameHeight === 'number' ? rtpStat.frameHeight : null;
        next.targetBitrate =
          typeof rtpStat.targetBitrate === 'number'
            ? Math.round(rtpStat.targetBitrate / 1_000)
            : null;
        next.qualityLimitation =
          typeof rtpStat.qualityLimitationReason === 'string'
            ? rtpStat.qualityLimitationReason
            : null;
        const durations = rtpStat.qualityLimitationDurations as RtcStat | undefined;
        next.qualityLimitationCpuSeconds =
          typeof durations?.cpu === 'number' ? Math.round(durations.cpu * 10) / 10 : null;
        next.qualityLimitationBandwidthSeconds =
          typeof durations?.bandwidth === 'number'
            ? Math.round(durations.bandwidth * 10) / 10
            : null;
        next.encoderImplementation =
          typeof rtpStat.encoderImplementation === 'string' ? rtpStat.encoderImplementation : null;
        next.decoderImplementation =
          typeof rtpStat.decoderImplementation === 'string' ? rtpStat.decoderImplementation : null;
        next.powerEfficientEncoder =
          typeof rtpStat.powerEfficientEncoder === 'boolean' ? rtpStat.powerEfficientEncoder : null;
        next.powerEfficientDecoder =
          typeof rtpStat.powerEfficientDecoder === 'boolean' ? rtpStat.powerEfficientDecoder : null;
        if (rtpStat.codecId) {
          const codec = videoReport.get(String(rtpStat.codecId)) as unknown as RtcStat | undefined;
          if (codec?.mimeType)
            next.codec = String(codec.mimeType)
              .replace(/^video\//i, '')
              .toUpperCase();
        }

        if (sendingScreen && remoteInbound) {
          const lost = statNumber(remoteInbound, 'packetsLost');
          next.remoteLoss = intervalLossPercent(
            lost,
            sample.packets,
            deps.remoteLossPrev.current,
            true,
          );
          deps.remoteLossPrev.current = { lost, packets: sample.packets };
          if (typeof remoteInbound.roundTripTime === 'number')
            next.rtt = Math.round(remoteInbound.roundTripTime * 1_000);
          if (typeof remoteInbound.jitter === 'number')
            next.jitter = Math.round(remoteInbound.jitter * 1_000);
        } else if (!sendingScreen) {
          const lost = statNumber(rtpStat, 'packetsLost');
          const received = statNumber(rtpStat, 'packetsReceived');
          next.loss = intervalLossPercent(lost, received, deps.receiveLossPrev.current);
          deps.receiveLossPrev.current = { lost, packets: received };
          if (typeof rtpStat.jitter === 'number') next.jitter = Math.round(rtpStat.jitter * 1_000);
        }
      }

      const serverSnapshot = await new Promise<ServerMediaDiagnostics | null>((resolve) => {
        deps.socket
          .timeout(1_500)
          .emit('ms:media-diagnostics', {}, (error: Error | null, value: ServerMediaDiagnostics) =>
            resolve(error ? null : value),
          );
      });
      if (serverSnapshot?.role === 'sender') {
        const producer = serverSnapshot.producers[0];
        next.serverIngressBitrate =
          producer?.stats[0]?.bitrateKbps ??
          serverSnapshot.transports.send?.rtpRecvBitrateKbps ??
          null;
        next.serverScore = producer?.stats[0]?.score ?? producer?.score?.[0]?.score ?? null;
      } else if (serverSnapshot?.role === 'receiver') {
        const consumer = serverSnapshot.consumers[0];
        next.serverEgressBitrate =
          consumer?.stats[0]?.bitrateKbps ??
          serverSnapshot.transports.receive?.rtpSendBitrateKbps ??
          null;
        next.serverScore = consumer?.stats[0]?.score ?? consumer?.score?.score ?? null;
      }

      const currentSessionKey = mediaDiagnosticSessionKey(
        deps.screenProducer.current?.id ?? null,
        deps.watchingScreenPeerRef.current,
      );
      if (
        !shouldAcceptMediaDiagnosticSample(
          deps.statsEnabledRef.current,
          capturedSessionKey,
          currentSessionKey,
        )
      ) {
        deps.setStats(EMPTY_STATS);
        return;
      }

      const trackSettings = videoTrack?.getSettings() ?? null;
      const diagnosticEntry = {
        timestamp: new Date().toISOString(),
        stats: next,
        trackSettings,
      };
      // 仅在内存中保留最近 600 个样本，只有手动点击导出才保存文件。
      deps.diagnosticHistory.current.push(diagnosticEntry);
      if (deps.diagnosticHistory.current.length > 600) deps.diagnosticHistory.current.shift();
      deps.setStats(next);
    } catch (error) {
      console.warn('[media-diag] 采集客户端媒体统计失败', error);
    } finally {
      deps.statsCollecting.current = false;
    }
  }, [deps.socket]);

  // stats 开关：打开时每秒采集一次
  const toggleStats = useCallback(() => {
    deps.setStatsEnabled((prev) => {
      const next = !prev;
      deps.statsEnabledRef.current = next;
      if (next) {
        if (!deps.statsTimer.current)
          deps.statsTimer.current = setInterval(() => {
            collectStats();
          }, 1000);
      } else {
        if (deps.statsTimer.current) {
          clearInterval(deps.statsTimer.current);
          deps.statsTimer.current = null;
        }
        deps.receiveLossPrev.current = null;
        deps.remoteLossPrev.current = null;
        deps.videoCounterPrev.current = null;
        deps.setStats(EMPTY_STATS);
      }
      return next;
    });
  }, [collectStats]);

  const exportMediaDiagnostics = useCallback(() => {
    const producer = deps.screenProducer.current;
    const payload = {
      exportedAt: new Date().toISOString(),
      roomId: deps.roomId,
      socketId: deps.socket.id ?? null,
      userAgent: navigator.userAgent,
      screen: {
        preset: deps.screenPreset,
        requestedFps: deps.screenGameMode ? 60 : deps.fps,
        gameMode: deps.screenGameMode,
        nativeResolution: deps.screenNativeResolution,
        configuredMaxBitrate: SCREEN_MAX_BITRATE_BPS,
        encodingPlan: deps.screenEncodingPlan,
        trackSettings: producer?.track?.getSettings() ?? null,
        senderParameters: producer?.rtpSender?.getParameters() ?? null,
      },
      samples: deps.diagnosticHistory.current,
    };
    const text = JSON.stringify(
      payload,
      (_key, value) => (typeof value === 'bigint' ? Number(value) : value),
      2,
    );
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `cove-media-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }, [
    deps.fps,
    deps.roomId,
    deps.screenEncodingPlan,
    deps.screenGameMode,
    deps.screenNativeResolution,
    deps.screenPreset,
    deps.socket.id,
  ]);
  return { collectStats, toggleStats, exportMediaDiagnostics };
}
