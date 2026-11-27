import { useCallback, useEffect, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { MEDIA_TIMING_DEFINITIONS, rtcSecondsToMilliseconds } from '@cove/client-core';

import {
  diagnoseFrameRate,
  diagnosticVideoCounters,
  diagnosticTrackSettings,
  diagnosticSenderParameters,
  intervalLossPercent,
  mediaDiagnosticSessionKey,
  nativeFrameCounterRates,
  shouldAcceptMediaDiagnosticSample,
  statNumber,
  type FrameRateDiagnosis,
  type NativeFrameCounterSample,
  type RtcStat,
  type RtcVideoCounterSample,
  videoCounterRates,
  videoCounterSample,
} from './mediaDiagnostics';
import { SCREEN_MAX_BITRATE_BPS, type ScreenEncodingPlan } from '../screen/screenCapture';
import { getAv1ScreenSenderDiagnostics } from '../screen/createAv1ScreenSender';
import { getNativeScreenCaptureDiagnostics, getLastNativeScreenCaptureAttempt, observeNativeFrameStability } from '../screen/nativeScreenCapture';
import { readFramePresentation } from './framePresentation';
import { FRAME_STABILITY_DEFINITION } from './frameStabilityView';

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
  readonly recoveryDiagnostics?: import('react').MutableRefObject<import('@cove/client-core').RecoveryDiagnostics>;
  readonly statsCollecting: import('react').MutableRefObject<boolean>;
  readonly screenProducer: import('react').MutableRefObject<Producer | null>;
  readonly watchingScreenPeerRef: import('react').MutableRefObject<string | null>;
  readonly statsEnabledRef: import('react').MutableRefObject<boolean>;
  readonly statsEnabled: boolean;
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
    { timestamp: string; stats: MediaStats; trackSettings: MediaTrackSettings | null;
      rawVideoCounters: ReturnType<typeof diagnosticVideoCounters>;
      encodingPlan: ScreenEncodingPlan | null; contentHint: string | null }[]
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
  const latestDeps = useRef(deps);
  latestDeps.current = deps;
  const previousVideoWindow = useRef<{
    track: MediaStreamTrack | null;
    targetFps: number | null;
    paused: boolean;
    native: NativeFrameCounterSample | null;
  } | null>(null);
  const nativeObservation = useRef<{
    track: MediaStreamTrack;
    observer: NonNullable<ReturnType<typeof observeNativeFrameStability>>;
  } | null>(null);
  const nativeTrack = deps.screenProducer.current?.track ?? null;
  useEffect(() => {
    if (!deps.statsEnabled || !nativeTrack) return;
    const observer = observeNativeFrameStability(nativeTrack);
    if (!observer) return;
    const owned = { track: nativeTrack, observer };
    nativeObservation.current = owned;
    return () => {
      observer.dispose();
      if (nativeObservation.current === owned) nativeObservation.current = null;
    };
  }, [deps.statsEnabled, nativeTrack]);

  // 分阶段媒体统计：采集 → 编码 → RTP 发送 → SFU → RTP 接收 → 解码。
  // 阶段帧率由同一轨道、同一统计对象的连续计数器样本求得。
  const collectStats = useCallback(async () => {
    // The timer keeps this callback; render-state getters belong to the latest render.
    const deps = latestDeps.current;
    if (deps.statsCollecting.current) return;
    deps.statsCollecting.current = true;
    const next: MediaStats = { ...EMPTY_STATS };
    const sendingProducer = deps.screenProducer.current;
    const sendingProducerId = sendingProducer?.id ?? null;
    const sendingScreen = Boolean(sendingProducerId);
    const watchedPeerId = deps.watchingScreenPeerRef.current;
    const capturedSessionKey = mediaDiagnosticSessionKey(sendingProducerId, watchedPeerId);
    if (!deps.statsEnabledRef.current || !capturedSessionKey) {
      previousVideoWindow.current = null;
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
            next.rtt = rtcSecondsToMilliseconds(pair.currentRoundTripTime);
          if (sendingScreen && typeof pair.availableOutgoingBitrate === 'number')
            next.availableBitrate = Math.round(pair.availableOutgoingBitrate / 1_000);
          const candidate = report.get(String(pair.localCandidateId ?? '')) as unknown as
            | RtcStat
            | undefined;
          if (candidate?.protocol) next.protocol = String(candidate.protocol).toUpperCase();
        }
      }

      let videoEndpoint: Producer | Consumer | null = sendingProducer;
      if (!videoEndpoint) {
        for (const { consumer, kind, socketId } of deps.consumers.current.values()) {
          if (kind !== 'video' || (watchedPeerId && socketId !== watchedPeerId)) continue;
          videoEndpoint = consumer;
          break;
        }
      }
      const videoTrack = videoEndpoint?.track ?? null;
      const sampleDeps = latestDeps.current;
      const targetFps = sendingScreen ? sampleDeps.screenEncodingPlan?.fps ?? sampleDeps.fps : null;
      const pausedBeforeSample = videoEndpoint?.paused === true;
      const videoReport = await videoEndpoint?.getStats();
      const endpointPaused = videoEndpoint?.paused === true;
      const sampledAt = new Date().toISOString();
      const captureProvider = sendingScreen && videoTrack ? getNativeScreenCaptureDiagnostics(videoTrack) : null;
      const nativeCounters = captureProvider ? {
        timestamp: performance.now(),
        framesReceived: captureProvider.framesReceived,
        framesWritten: captureProvider.framesWritten,
      } : null;

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

      let frameRateDiagnosis: FrameRateDiagnosis = { status: 'pending' };
      let nativeRates: ReturnType<typeof nativeFrameCounterRates> | null = null;
      if (rtpStat && videoReport) {
        if (rtpStat.mediaSourceId) {
          const linkedSource = videoReport.get(String(rtpStat.mediaSourceId)) as unknown as
            | RtcStat
            | undefined;
          mediaSource = linkedSource?.type === 'media-source' ? linkedSource : undefined;
        }
        const sample = videoCounterSample(rtpStat, mediaSource);
        const paused = endpointPaused || rtpStat.active === false;
        const sameTrack = videoEndpoint?.track === videoTrack;
        const lastWindow = previousVideoWindow.current;
        const previous = sameTrack && lastWindow?.track === videoTrack ? lastWindow : null;
        const rates = videoCounterRates(sample, previous ? deps.videoCounterPrev.current : null);
        deps.videoCounterPrev.current = sameTrack && pausedBeforeSample === endpointPaused ? sample : null;
        previousVideoWindow.current = sameTrack && pausedBeforeSample === endpointPaused
          ? { track: videoTrack, targetFps, paused, native: nativeCounters } : null;
        const comparable = !paused && !pausedBeforeSample && previous?.targetFps === targetFps && !previous.paused;
        if (nativeCounters)
          nativeRates = nativeFrameCounterRates(nativeCounters, comparable ? previous.native : null);
        if (paused) frameRateDiagnosis = { status: 'paused' };
        else if (comparable) frameRateDiagnosis = diagnoseFrameRate(rates, sendingScreen, targetFps, nativeRates);

        const sourceReportedFps =
          typeof mediaSource?.framesPerSecond === 'number'
            ? Math.round(mediaSource.framesPerSecond * 10) / 10
            : null;
        const rtpReportedFps =
          typeof rtpStat.framesPerSecond === 'number'
            ? Math.round(rtpStat.framesPerSecond * 10) / 10
            : null;
        next.captureFps = rates.captureFps ?? sourceReportedFps;
        next.encodeFps = rates.encodeFps;
        next.sendFps = rates.sendFps;
        next.receiveFps = rates.receiveFps;
        next.decodeFps = rates.decodeFps ?? (!sendingScreen ? rtpReportedFps : null);
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
        next.droppedFrames = rates.droppedFps;
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
            next.rtt = rtcSecondsToMilliseconds(remoteInbound.roundTripTime);
          if (typeof remoteInbound.jitter === 'number')
            next.jitter = Math.round(remoteInbound.jitter * 1_000);
        } else if (!sendingScreen) {
          const lost = statNumber(rtpStat, 'packetsLost');
          const received = statNumber(rtpStat, 'packetsReceived');
          next.loss = intervalLossPercent(lost, received, deps.receiveLossPrev.current);
          deps.receiveLossPrev.current = { lost, packets: received };
          if (typeof rtpStat.jitter === 'number') next.jitter = Math.round(rtpStat.jitter * 1_000);
        }
      } else {
        deps.videoCounterPrev.current = null;
        previousVideoWindow.current = null;
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

      const currentDeps = latestDeps.current;
      const currentSessionKey = mediaDiagnosticSessionKey(
        currentDeps.screenProducer.current?.id ?? null,
        currentDeps.watchingScreenPeerRef.current,
      );
      if (
        !shouldAcceptMediaDiagnosticSample(
          currentDeps.statsEnabledRef.current,
          capturedSessionKey,
          currentSessionKey,
        )
      ) {
        currentDeps.setStats(EMPTY_STATS);
        return;
      }

      const trackSettings = diagnosticTrackSettings(videoTrack?.getSettings());
      // Frame intervals belong to the actual selected track, not just its peer.
      // A replacement from the same peer must not inherit a predecessor's data.
      const currentTrack = sendingScreen
        ? currentDeps.screenProducer.current?.track
        : Array.from(currentDeps.consumers.current.values()).find(
            entry => entry.kind === 'video' && entry.socketId === watchedPeerId,
          )?.consumer.track;
      const activeTrack = videoTrack === currentTrack && videoTrack?.readyState === 'live' ? videoTrack : null;
      const lastNativeAttempt = sendingScreen && activeTrack ? getLastNativeScreenCaptureAttempt(activeTrack) : null;
      if (activeTrack) {
        const currentTargetFps = sendingScreen ? currentDeps.screenEncodingPlan?.fps ?? currentDeps.fps : null;
        if (videoEndpoint?.paused) next.frameRateDiagnosis = { status: 'paused' };
        else if (!endpointPaused && !pausedBeforeSample && currentTargetFps === targetFps) {
          next.frameRateDiagnosis = frameRateDiagnosis;
          next.nativeCaptureFps = nativeRates?.receivedFps ?? null;
          next.nativeDeliveryFps = nativeRates?.writtenFps ?? null;
        }
        next.captureBackend = captureProvider?.backend ?? (sendingScreen && next.displaySurface ? 'chromium' : null);
        next.nativeCaptureStartTimedOut = next.captureBackend === 'chromium' && lastNativeAttempt?.stopReason === 'deadline_timeout';
        const native = nativeObservation.current;
        next.nativeDeliveryStability = native?.track === activeTrack
          ? native.observer.snapshot()
          : null;
        next.presentationStability = readFramePresentation(activeTrack);
      }
      const diagnosticEntry = {
        timestamp: sampledAt,
        stats: next,
        trackSettings,
        captureProvider: activeTrack ? captureProvider : null,
        lastNativeAttempt,
        rawVideoCounters: diagnosticVideoCounters(rtpStat, mediaSource),
        encodingPlan: currentDeps.screenEncodingPlan,
        contentHint: videoTrack?.contentHint ?? null,
      };
      // 仅在内存中保留最近 600 个样本，只有手动点击导出才保存文件。
      currentDeps.diagnosticHistory.current.push(diagnosticEntry);
      if (currentDeps.diagnosticHistory.current.length > 600) currentDeps.diagnosticHistory.current.shift();
      currentDeps.setStats(next);
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
        previousVideoWindow.current = null;
        deps.setStats(EMPTY_STATS);
      }
      return next;
    });
  }, [collectStats]);

  const exportMediaDiagnostics = useCallback(() => {
    const producer = deps.screenProducer.current;
    const payload = {
      exportedAt: new Date().toISOString(),
      metricDefinitions: MEDIA_TIMING_DEFINITIONS,
      frameStabilityDefinition: FRAME_STABILITY_DEFINITION,
      recovery: deps.recoveryDiagnostics?.current.snapshot(),
      platform: 'desktop',
      screen: {
        preset: deps.screenPreset,
        requestedFps: deps.fps,
        gameMode: deps.screenGameMode,
        nativeResolution: deps.screenNativeResolution,
        configuredMaxBitrate: SCREEN_MAX_BITRATE_BPS,
        encodingPlan: deps.screenEncodingPlan,
        trackSettings: diagnosticTrackSettings(producer?.track?.getSettings()),
        captureProvider: producer?.track ? getNativeScreenCaptureDiagnostics(producer.track) : null,
        lastNativeAttempt: producer?.track ? getLastNativeScreenCaptureAttempt(producer.track) : null,
        senderParameters: diagnosticSenderParameters(producer?.rtpSender?.getParameters()),
        av1Sender: getAv1ScreenSenderDiagnostics(producer?.rtpSender),
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
