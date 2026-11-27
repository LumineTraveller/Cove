import { useCallback, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import { Device } from 'mediasoup-client';
import type { NativeScreenColorSpace } from '../../../../electron/native-screen-capture-protocol';

import { type RtcVideoCounterSample } from '../diagnostics/mediaDiagnostics';
import {
  createScreenEncodingPlan,
  screenCaptureVideoConstraints,
  SCREEN_MAX_BITRATE_BPS,
  SCREEN_START_BITRATE_BPS,
  toScreenRtpEncoding,
  type ScreenActivity,
  type ScreenEncodingPlan,
  type ScreenPreset,
} from './screenCapture';
import { ApplicationAudioPipeline } from '../application-audio/applicationAudio';
import { Av1ScreenInitializationError, createAv1ScreenSender } from './createAv1ScreenSender';
import { screenPublicationCodecCandidates } from './screenCodecPolicy';
import { getNativeScreenCaptureDiagnostics, type NativeCaptureCandidate } from './nativeScreenCapture';
import { nativeScreenColorSpaceForCodecs } from './nativeScreenColorPolicy';
import { prepareNativeScreen, selectNativeScreenDisplay,
  type NativeScreenDisplayLease, type NativeScreenSettings } from './nativeScreenRecovery';
import {
  Transport,
  Producer,
  Fps,
  MediaStats,
  EMPTY_STATS,
  waitForMediaTrackWarmup,
  produceWithSsrcRetry,
  emitAsync,
} from '../desktopMediaSupport';

export interface useScreenPublishingDependencies {
  readonly inVoice: boolean;
  readonly mediaGeneration: import('react').MutableRefObject<number>;
  readonly isSharing: boolean;
  readonly screenPreset: '540p' | '720p' | '1080p' | '1440p';
  readonly screenGameMode: boolean;
  readonly screenNativeResolution: boolean;
  readonly screenCompatibilityMode: boolean;
  readonly setScreenCompatibilityMode: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  readonly screenGpuEncoding: boolean;
  readonly setScreenGpuEncoding: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  readonly screenSmoothPlayback: boolean;
  readonly setScreenSmoothPlayback: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  readonly fps: Fps;
  readonly shareAudio: boolean;
  readonly setScreenPreset: import('react').Dispatch<
    import('react').SetStateAction<'540p' | '720p' | '1080p' | '1440p'>
  >;
  readonly setFps: import('react').Dispatch<import('react').SetStateAction<Fps>>;
  readonly setShareAudio: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  readonly setScreenGameMode: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  readonly setScreenNativeResolution: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly localScreenRef: import('react').MutableRefObject<MediaStream | null>;
  readonly setLocalScreen: import('react').Dispatch<
    import('react').SetStateAction<MediaStream | null>
  >;
  readonly videoCounterPrev: import('react').MutableRefObject<RtcVideoCounterSample | null>;
  readonly remoteLossPrev: import('react').MutableRefObject<{
    lost: number;
    packets: number;
  } | null>;
  readonly deviceRef: import('react').MutableRefObject<Device | null>;
  readonly sendTransport: import('react').MutableRefObject<Transport | null>;
  readonly socket: Socket<
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap,
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap
  >;
  readonly screenProducer: import('react').MutableRefObject<Producer | null>;
  readonly screenDemandActiveRef: import('react').MutableRefObject<boolean>;
  readonly armScreenRampGuard: (
    preset: ScreenPreset,
    maxFps: Fps,
    nativeResolution: boolean,
  ) => void;
  readonly applyScreenActivity: (
    preset: ScreenPreset,
    maxFps: Fps,
    activity: ScreenActivity,
    nativeResolution?: boolean,
  ) => void;
  readonly stopScreenAnalysis: () => void;
  readonly startScreenAnalysis: (
    stream: MediaStream,
    preset: ScreenPreset,
    maxFps: Fps,
    nativeResolution: boolean,
  ) => void;
  readonly startScreenAudio: (isCurrent?: () => boolean) => Promise<void>;
  readonly setIsSharing: import('react').Dispatch<import('react').SetStateAction<boolean>>;
  readonly clearScreenRampGuard: () => void;
  readonly screenAudioProducer: import('react').MutableRefObject<Producer | null>;
  readonly screenAudioUnsubscribe: import('react').MutableRefObject<(() => void) | null>;
  readonly screenAudioPipeline: import('react').MutableRefObject<ApplicationAudioPipeline | null>;
  readonly setScreenEncodingPlan: import('react').Dispatch<
    import('react').SetStateAction<ScreenEncodingPlan | null>
  >;
  readonly roomId: string;
  readonly closeScreenAudio: () => void;
  readonly setScreenViewerCount: import('react').Dispatch<import('react').SetStateAction<number>>;
  readonly setScreenActivity: import('react').Dispatch<
    import('react').SetStateAction<ScreenActivity>
  >;
  readonly screenActivityRef: import('react').MutableRefObject<ScreenActivity>;
  readonly watchingScreenPeerRef: import('react').MutableRefObject<string | null>;
  readonly setStats: import('react').Dispatch<import('react').SetStateAction<MediaStats>>;
  readonly clearAvailableScreens: () => void;
  readonly clearRemoteApplicationAudios: () => void;
}

class CancelledScreenPublication extends Error {}

interface ScreenUpdateQueue {
  readonly isCurrent: () => boolean;
  readonly candidates: Set<MediaStream>;
  readonly controller: AbortController;
  readonly release: () => void;
  tail: Promise<void>;
}

interface NativeScreenPublication {
  producer: Producer;
  lease: NativeScreenDisplayLease;
  settings: NativeScreenSettings;
  colorSpace?: NativeScreenColorSpace;
  recovering: MediaStream | null;
}

function releaseScreenCaptureCandidate(stream: MediaStream) {
  stream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
}

export function useScreenPublishing(deps: useScreenPublishingDependencies) {
  const publicationGeneration = useRef(0);
  const pendingStart = useRef<{ operation: number; isCurrent: () => boolean; cancel: () => void } | null>(null);
  const [isStartingScreenShare, setIsStartingScreenShare] = useState(false);
  const rendererActivity = useRef<{ operation: number; release(): void } | null>(null);
  const updateQueue = useRef<ScreenUpdateQueue | null>(null);
  const nativePublication = useRef<NativeScreenPublication | null>(null);

  const ensureUpdateQueue = (producer: Producer, isCurrent: () => boolean): ScreenUpdateQueue => {
    const existing = updateQueue.current;
    if (existing?.isCurrent()) return existing;
    existing?.release();
    const candidates = new Set<MediaStream>();
    const controller = new AbortController();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      producer.observer?.off('close', release);
      controller.abort();
      if (nativePublication.current?.producer === producer) {
        nativePublication.current.lease.release();
        nativePublication.current = null;
      }
      candidates.forEach(releaseScreenCaptureCandidate);
      candidates.clear();
    };
    const queue: ScreenUpdateQueue = {
      isCurrent: () => !released && isCurrent(), candidates, controller, release, tail: Promise.resolve(),
    };
    updateQueue.current = queue;
    producer.observer?.once('close', release);
    return queue;
  };

  const watchPublishedTrack = (stream: MediaStream, producer: Producer, queue: ScreenUpdateQueue) => {
    const track = stream.getVideoTracks()[0];
    const ownsTrack = () => queue.isCurrent() && deps.localScreenRef.current === stream;
    track.onended = () => {
      if (!ownsTrack()) return;
      const native = nativePublication.current;
      if (native?.producer !== producer) { stopScreenShare(); return; }
      if (native.recovering === stream) return;
      native.recovering = stream;
      const recover = async () => {
        const { settings, lease, colorSpace } = native;
        for (let attempt = 0; attempt < 3 && ownsTrack(); ++attempt) {
          const prepared = await prepareNativeScreen(lease, settings, colorSpace, queue.controller.signal, ownsTrack, true);
          if (!prepared || !ownsTrack()) { prepared?.capture.stop(); return; }
          const replacement = prepared.capture.stream;
          queue.candidates.add(replacement);
          try {
            const nextTrack = replacement.getVideoTracks()[0];
            await producer.replaceTrack({ track: nextTrack });
            if (!ownsTrack()) return;
            prepared.capture.commit();
            if (nextTrack.readyState !== 'live') throw new Error('恢复后的原生采集轨道中断。');
            queue.candidates.delete(replacement);
            deps.localScreenRef.current = replacement;
            watchPublishedTrack(replacement, producer, queue);
            releaseScreenCaptureCandidate(stream);
            deps.setLocalScreen(replacement);
            deps.videoCounterPrev.current = null;
            deps.remoteLossPrev.current = null;
            const { outputWidth, outputHeight } = prepared.plan;
            Object.assign(producer.appData, { outputWidth, outputHeight });
            deps.applyScreenActivity(settings.preset, settings.fps, deps.screenActivityRef.current, settings.nativeResolution);
            if (!settings.gameMode) deps.startScreenAnalysis(replacement, settings.preset, settings.fps, settings.nativeResolution);
            return;
          } catch (error) {
            if (attempt === 2) throw error;
          } finally {
            if (queue.candidates.delete(replacement)) prepared.capture.stop();
          }
        }
      };
      queue.tail = queue.tail.then(recover).catch(error => {
        if (!ownsTrack()) return;
        console.error('[native-screen] recovery exhausted', error);
        stopScreenShare();
        window.alert(error instanceof Error ? error.message : '原生屏幕采集未能恢复，请重新开始共享。');
      }).finally(() => { if (native.recovering === stream) native.recovering = null; });
    };
  };
  const startScreenShare = useCallback(
    async (
      initPreset?: ScreenPreset,
      initFps?: Fps,
      initAudio?: boolean,
      initGameMode?: boolean,
      initNativeResolution?: boolean,
      initCompatibilityMode?: boolean,
      initGpuEncoding?: boolean,
      initSmoothPlayback?: boolean,
    ) => {
      if (deps.isSharing) return true;
      if (pendingStart.current?.isCurrent()) return false;
      if (!deps.inVoice) {
        window.alert('请先加入语音，再开始屏幕共享。');
        return false;
      }
      const transport = deps.sendTransport.current;
      const signalConnected = () => deps.socket.connected !== false;
      if (!transport || transport.closed || !deps.socket.id || !signalConnected()) {
        window.alert('共享连接正在恢复，请稍后重试。');
        return false;
      }
      const preset = initPreset ?? deps.screenPreset;
      const gameMode = initGameMode ?? deps.screenGameMode;
      const nativeResolution = initNativeResolution ?? deps.screenNativeResolution;
      const currentFps = initFps ?? deps.fps;
      const audio = initAudio ?? deps.shareAudio;
      const compatibilityMode = initCompatibilityMode ?? deps.screenCompatibilityMode ?? false;
      const bridge = window.coveNativeScreen;
      const hardwareAv1Available = bridge?.hardwareAv1Encoding === true;
      const gpuEncoding = initGpuEncoding ?? deps.screenGpuEncoding;
      const smoothPlayback = initSmoothPlayback ?? (deps.screenSmoothPlayback === true);
      if (gpuEncoding && (!hardwareAv1Available || compatibilityMode)) {
        window.alert('GPU 编码需要支持 AV1 的桌面客户端。请关闭兼容观看后重试，或使用 CPU 编码。');
        return false;
      }
      if (initPreset !== undefined) deps.setScreenPreset(initPreset);
      if (initFps !== undefined) deps.setFps(currentFps);
      if (initAudio !== undefined) deps.setShareAudio(initAudio);
      if (initGameMode !== undefined) deps.setScreenGameMode(initGameMode);
      if (initNativeResolution !== undefined) deps.setScreenNativeResolution(initNativeResolution);
      if (initCompatibilityMode !== undefined) deps.setScreenCompatibilityMode(initCompatibilityMode);
      if (initGpuEncoding !== undefined && hardwareAv1Available && !compatibilityMode)
        deps.setScreenGpuEncoding(initGpuEncoding);
      if (initSmoothPlayback !== undefined) deps.setScreenSmoothPlayback(initSmoothPlayback);

      // System-audio sharing must use the native process-exclusion bridge so
      // Cove's own voice and sound-pack playback can never enter the stream.
      // There is intentionally no full-system/browser fallback.
      if (audio && !window.coveScreenAudio) {
        window.alert('排除 Cove 自身音频的系统音频共享仅可在 Windows 桌面版中使用。');
        return false;
      }

      const initialActivity: ScreenActivity = gameMode ? 'motion' : 'active';
      const settings: NativeScreenSettings = { preset, fps: currentFps, gameMode, nativeResolution, gpuEncoding };
      const operation = ++publicationGeneration.current;
      const generation = deps.mediaGeneration.current;
      const socketId = deps.socket.id;
      const controller = new AbortController();
      pendingStart.current?.cancel();
      let acquiredStream: MediaStream | null = null;
      let nativeLease: NativeScreenDisplayLease | null = null;
      let initialNative: NativeCaptureCandidate | null = null;
      let acquiredProducer: Producer | null = null;
      let videoCommitted = false;
      let activityRelease: (() => void) | undefined;
      const releaseActivity = () => {
        const release = activityRelease;
        activityRelease = undefined;
        if (rendererActivity.current?.operation === operation) rendererActivity.current = null;
        try { release?.(); } catch { /* Scheduling policy cannot prevent media cleanup. */ }
      };
      controller.signal.addEventListener('abort', () => {
        releaseActivity();
        if (!videoCommitted) {
          nativeLease?.release();
          if (acquiredStream && deps.localScreenRef.current !== acquiredStream) releaseScreenCaptureCandidate(acquiredStream);
        }
      }, { once: true });
      const isCurrent = () => !controller.signal.aborted && operation === publicationGeneration.current &&
        generation === deps.mediaGeneration.current && transport === deps.sendTransport.current &&
        (videoCommitted
          ? acquiredProducer !== null && deps.screenProducer.current === acquiredProducer && !acquiredProducer.closed
          : socketId === deps.socket.id || (deps.socket.id === undefined && deps.socket.connected === false));
      const ensureCurrent = () => { if (!isCurrent()) throw new CancelledScreenPublication(); };
      const waitForSignal = () => {
        ensureCurrent();
        if (deps.socket.connected !== false && deps.socket.id === socketId) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            deps.socket.off('connect', connected);
            controller.signal.removeEventListener('abort', cancelled);
            if (error) reject(error); else resolve();
          };
          const connected = () => finish(isCurrent() && deps.socket.id === socketId ? undefined : new CancelledScreenPublication());
          const cancelled = () => finish(new CancelledScreenPublication());
          const timer = setTimeout(() => finish(new Error('服务器连接恢复超时，请重试屏幕共享')), 5_000);
          deps.socket.on('connect', connected);
          controller.signal.addEventListener('abort', cancelled, { once: true });
          if (controller.signal.aborted) cancelled();
          else if (deps.socket.connected && deps.socket.id) connected();
        });
      };
      pendingStart.current = { operation, isCurrent, cancel: () => controller.abort() };
      setIsStartingScreenShare(true);
      let startupStage = '申请屏幕采集';
      try {
        // rtpCapabilities is the receive-capabilities alias in mediasoup-client.
        // Explicit publication codecs must come from the sending intersection.
        const device = deps.deviceRef.current;
        const negotiatedCodecs = device?.sendRtpCapabilities?.codecs ?? device?.rtpCapabilities.codecs ?? [];
        const preferredCodecs = screenPublicationCodecCandidates(negotiatedCodecs, compatibilityMode);
        const av1 = preferredCodecs.find(codec => codec?.mimeType.toLowerCase() === 'video/av1');
        if (gpuEncoding && !av1) throw new Error('当前服务器未协商到 AV1。请选择 CPU 编码。');
        const codecCandidates = gpuEncoding ? [av1]
          : hardwareAv1Available && av1 ? preferredCodecs.filter(codec => codec !== undefined) : preferredCodecs;
        const enableRendererActivity = () => {
          try { activityRelease = window.coveScreenShareActivity?.acquire(); }
          catch { console.warn('[screen share] renderer activity unavailable'); }
          rendererActivity.current = { operation, release: releaseActivity };
        };
        let initialPlan: ScreenEncodingPlan;
        let inputColor = nativeScreenColorSpaceForCodecs(codecCandidates[0] ? [codecCandidates[0]] : undefined);
        const openNative = async (lease: NativeScreenDisplayLease, colorSpace: NativeScreenColorSpace | undefined) => {
          const prepared = await prepareNativeScreen(lease, settings, colorSpace, controller.signal, isCurrent);
          if (!prepared) throw new CancelledScreenPublication();
          return prepared;
        };
        if (bridge?.supported) {
          startupStage = '启动 Windows 原生屏幕采集';
          nativeLease = await selectNativeScreenDisplay(bridge);
          ensureCurrent();
          enableRendererActivity();
          const prepared = await openNative(nativeLease, inputColor);
          initialNative = prepared.capture;
          acquiredStream = initialNative.stream;
          initialPlan = prepared.plan;
          ensureCurrent();
        } else {
          acquiredStream = await navigator.mediaDevices.getDisplayMedia({
            video: screenCaptureVideoConstraints(currentFps, preset, nativeResolution),
            audio: false,
          });
          ensureCurrent();
          const track = acquiredStream.getVideoTracks()[0];
          if (!track) throw new Error('没有取得屏幕视频轨道');
          enableRendererActivity();
          startupStage = '等待屏幕采集轨道就绪';
          await waitForMediaTrackWarmup(track);
          ensureCurrent();
          track.contentHint = gameMode ? 'motion' : 'detail';
          const { width, height } = track.getSettings();
          initialPlan = createScreenEncodingPlan({
            preset, maxFps: currentFps, activity: initialActivity,
            sourceWidth: width, sourceHeight: height, nativeResolution,
          });
        }
        let stream = acquiredStream!;
        let videoTrack = stream.getVideoTracks()[0];
        console.info('[media-diag] 屏幕采集已开始', {
          requested: {
            preset,
            outputLimit: `${initialPlan.outputWidth}x${initialPlan.outputHeight}`,
            fps: currentFps,
            gameMode,
          },
          constraintMode: nativeLease ? 'native' : 'getDisplayMedia',
          settings: videoTrack.getSettings(),
        });
        // 发布实际选中的采集轨道，使采集设置和 Producer 使用同一轨道。
        startupStage = '初始化屏幕视频发送';
        let producer: Producer | null = null;
        let lastProduceError: unknown = null;
        for (const codec of codecCandidates) {
          const color = nativeScreenColorSpaceForCodecs(codec ? [codec] : undefined);
          if (nativeLease && (videoTrack.readyState !== 'live' ||
              (color !== inputColor && getNativeScreenCaptureDiagnostics(videoTrack)?.frameStorage === 'cpu'))) {
            initialNative?.stop();
            const prepared = await openNative(nativeLease, color);
            initialNative = prepared.capture;
            acquiredStream = initialNative.stream;
            initialPlan = prepared.plan;
            ensureCurrent();
            inputColor = color;
            stream = acquiredStream!;
            videoTrack = stream.getVideoTracks()[0];
          }
          try {
            const av1Selected = codec?.mimeType.toLowerCase() === 'video/av1';
            // On the pinned Chromium AV1 hardware only supports L1T1.
            // L1T2 keeps both temporal layers at the selected total frame rate
            // while directing the software choice to libaom.
            const av1Mode = av1Selected && hardwareAv1Available ? (gpuEncoding ? 'L1T1' : 'L1T2') : undefined;
            const publishVideo = () => produceWithSsrcRetry(async () => {
              await waitForSignal();
              ensureCurrent();
              const av1Sender = gpuEncoding ? createAv1ScreenSender(controller.signal, error => {
                if (!videoCommitted || !isCurrent()) return;
                console.error('[screen share] AV1 sender failed', error);
                stopScreenShare();
                window.alert(error.message);
              }) : null;
              try {
                await av1Sender?.ready;
                ensureCurrent();
              } catch (error) {
                av1Sender?.dispose();
                throw error;
              }
              const appData = {
                type: 'screen',
                adaptation: gameMode ? 'game' : 'content',
                preset,
                nativeResolution,
                gpuEncoding,
                smoothPlayback,
                maxFps: currentFps,
                outputWidth: initialPlan.outputWidth,
                outputHeight: initialPlan.outputHeight,
                preferredCodec: codec?.mimeType ?? 'auto',
                compatibilityMode,
              };
              const candidate = await transport.produce({
                track: videoTrack,
                streamId: `screen-${socketId}`,
                appData,
                encodings: [{ ...toScreenRtpEncoding(initialPlan), ...(av1Mode ? { scalabilityMode: av1Mode } : {}) }],
                // 初始带宽估计（kbps），不是上限；与 SFU 启动估计一致，之后由拥塞控制调整。
                codecOptions: {
                  videoGoogleStartBitrate: SCREEN_START_BITRATE_BPS / 1_000,
                  videoGoogleMaxBitrate: SCREEN_MAX_BITRATE_BPS / 1_000,
                },
                ...(codec ? { codec } : {}),
                ...(av1Sender ? {
                  onRtpSender(sender: RTCRtpSender) {
                    // The transform must see the encoder's first sequence header.
                    av1Sender.bind(sender, appData);
                  },
                } : {}),
                stopTracks: false,
                disableTrackOnPause: false,
                zeroRtpOnPause: true,
              }).catch(error => {
                av1Sender?.dispose();
                throw error;
              });
              if (av1Sender) {
                if (candidate.closed) {
                  av1Sender.dispose();
                  throw new CancelledScreenPublication();
                }
                acquiredProducer = candidate;
                candidate.observer.once('close', av1Sender.dispose);
                av1Sender.assertHealthy();
              }
              return candidate;
            });
            try {
              producer = await publishVideo();
            } catch (error) {
              if (!gpuEncoding || !(error instanceof Av1ScreenInitializationError)) throw error;
              ensureCurrent();
              console.warn('[screen share] AV1 startup keyframe missing, restarting hardware encoder');
              // The failed local negotiation is being closed by mediasoup-client.
              await new Promise(resolve => setTimeout(resolve, 120));
              producer = await publishVideo();
            }
            acquiredProducer = producer;
            ensureCurrent();
            console.info(`[screen share] 编码器：${codec?.mimeType ?? '浏览器自动选择'}`);
            break;
          } catch (error) {
            ensureCurrent();
            if (gpuEncoding) throw error;
            lastProduceError = error;
            console.warn('[screen share] codec publication failed', { codec: codec?.mimeType ?? 'auto', compatibilityMode }, error);
          }
        }
        if (!producer) throw lastProduceError ?? new Error('没有可用的屏幕共享视频编码器');
        initialNative?.commit();
        deps.screenProducer.current = producer;
        producer.observer?.once('close', releaseActivity);
        const publishedProducer = producer;
        const queue = ensureUpdateQueue(publishedProducer, () => isCurrent() &&
          deps.screenProducer.current === publishedProducer && !publishedProducer.closed);
        if (nativeLease) {
          const colorSpace = nativeScreenColorSpaceForCodecs(producer.rtpParameters?.codecs) ?? inputColor;
          nativePublication.current = { producer, lease: nativeLease, settings, colorSpace, recovering: null };
        }
        deps.localScreenRef.current = stream;
        watchPublishedTrack(stream, producer, queue);
        if (!nativeLease && videoTrack.readyState === 'ended') {
          throw new Error('屏幕采集在启动时结束，请重新开始共享');
        }
        deps.setLocalScreen(stream);
        deps.videoCounterPrev.current = null;
        deps.remoteLossPrev.current = null;
        if (!deps.screenDemandActiveRef.current) producer.pause();
        deps.armScreenRampGuard(preset, currentFps, nativeResolution);
        deps.applyScreenActivity(preset, currentFps, initialActivity, nativeResolution);
        if (gameMode) deps.stopScreenAnalysis();
        else deps.startScreenAnalysis(stream, preset, currentFps, nativeResolution);

        // The SFU video and local preview are already published. From here the
        // voice recovery coordinator owns session validity; a transient signal
        // disconnect must not undo healthy video while optional audio starts.
        videoCommitted = true;
        if (videoTrack.readyState === 'ended') videoTrack.dispatchEvent(new Event('ended'));

        // Electron's global `loopback` source captures Cove's own voice and
        // sound-pack playback as well as other desktop audio. The Windows client
        // therefore uses only the native process-loopback capture in exclude
        // mode (Cove's process tree is removed at the WASAPI level).
        if (audio) {
          startupStage = '启动共享系统音频';
          let audioSignalChanged = false;
          const audioPublicationCurrent = () => {
            if (socketId !== deps.socket.id) audioSignalChanged = true;
            return isCurrent();
          };
          try {
            await deps.startScreenAudio(audioPublicationCurrent);
            ensureCurrent();
          } catch (e) {
            ensureCurrent();
            if (audioSignalChanged || socketId !== deps.socket.id) {
              console.info('[screen share] signal interrupted audio startup; published video retained');
            } else {
              console.warn('[screen share] 排除 Cove 后的系统音频发布失败:', e);
              window.alert('屏幕画面已开始共享，但系统音频发布失败。请停止共享后重试。');
            }
          }
        }

        deps.setIsSharing(true);
        return true;

      } catch (e) {
        releaseActivity();
        nativeLease?.release();
        const current = isCurrent();
        if (acquiredProducer) {
          if (deps.screenProducer.current === acquiredProducer) deps.screenProducer.current = null;
          if (!acquiredProducer.closed) {
            if (deps.socket.id === socketId && deps.socket.connected !== false)
              deps.socket.emit('ms:close-producer', { producerId: acquiredProducer.id });
            acquiredProducer.close();
          }
        }
        acquiredStream?.getTracks().forEach((track) => {
          track.onended = null;
          if (track.readyState !== 'ended') track.stop();
        });
        const cancelled = !current || e instanceof CancelledScreenPublication;
        if (cancelled) {
          console.info('[screen share] startup cancelled', JSON.stringify({
            stage: startupStage,
            publicationChanged: operation !== publicationGeneration.current,
            mediaChanged: generation !== deps.mediaGeneration.current,
            transportChanged: transport !== deps.sendTransport.current,
            signalChanged: socketId !== deps.socket.id,
          }));
          // The media session can expire after this attempt adopted a preview.
          // Release that preview too, but never clear a successor's capture
          // or producer during late cancellation cleanup.
          if (!acquiredStream || deps.localScreenRef.current !== acquiredStream ||
              deps.screenProducer.current) return false;
        } else {
          console.error(`[screen share] ${startupStage}失败`, e);
        }
        deps.stopScreenAnalysis();
        deps.clearScreenRampGuard();
        deps.closeScreenAudio();
        if (deps.localScreenRef.current === acquiredStream) deps.localScreenRef.current = null;
        deps.setLocalScreen(null);
        deps.setIsSharing(false);
        deps.setScreenEncodingPlan(null);
        if (!cancelled)
          window.alert(`无法开始屏幕共享：${e instanceof Error ? e.message : String(e)}`);
        return false;
      } finally {
        if (pendingStart.current?.operation === operation) {
          pendingStart.current = null;
          setIsStartingScreenShare(false);
        }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [
      deps.socket,
      deps.roomId,
      deps.inVoice,
      deps.isSharing,
      deps.screenPreset,
      deps.fps,
      deps.shareAudio,
      deps.screenGameMode,
      deps.screenNativeResolution,
      deps.screenCompatibilityMode,
      deps.screenGpuEncoding,
      deps.screenSmoothPlayback,
      deps.armScreenRampGuard,
      deps.applyScreenActivity,
      deps.startScreenAnalysis,
      deps.startScreenAudio,
      deps.stopScreenAnalysis,
      deps.clearScreenRampGuard,
    ],
  );

  /**
   * 修改共享参数时复用现有的视频 Producer，只替换采集轨道和编码参数。
   * 这样 SFU 侧的 Producer ID 不变，观看方不会被断开，也不需要重新点击观看。
   */
  const updateScreenShare = useCallback(
    async (
      initPreset?: ScreenPreset,
      initFps?: Fps,
      initAudio?: boolean,
      initGameMode?: boolean,
      initNativeResolution?: boolean,
      initCompatibilityMode?: boolean,
      initGpuEncoding?: boolean,
      initSmoothPlayback?: boolean,
    ) => {
      if (!deps.inVoice || !deps.isSharing) return;
      const producer = deps.screenProducer.current;
      if (!producer) return;
      const gpuEncoding = producer.appData?.gpuEncoding === true;
      if (initGpuEncoding !== undefined && initGpuEncoding !== gpuEncoding) {
        window.alert('请停止当前共享后更改 GPU 编码选项。');
        return;
      }
      if (initCompatibilityMode !== undefined && initCompatibilityMode !== (deps.screenCompatibilityMode ?? false)) {
        window.alert('编码兼容模式需要停止当前共享后重新开始，当前共享未更改。');
        return;
      }
      const transport = deps.sendTransport.current;
      if (!transport) return;
      const operation = publicationGeneration.current;
      const generation = deps.mediaGeneration.current;
      const socketId = deps.socket.id;
      const isSessionCurrent = () => operation === publicationGeneration.current &&
        generation === deps.mediaGeneration.current && transport === deps.sendTransport.current &&
        socketId === deps.socket.id && deps.screenProducer.current === producer && !producer.closed;
      const isCurrent = isSessionCurrent;
      const ensureCurrent = () => { if (!isCurrent()) throw new CancelledScreenPublication(); };

      const preset = initPreset ?? deps.screenPreset;
      const gameMode = initGameMode ?? deps.screenGameMode;
      const nativeResolution = initNativeResolution ?? deps.screenNativeResolution;
      const currentFps = initFps ?? deps.fps;
      const audio = initAudio ?? deps.shareAudio;
      if (audio && !window.coveScreenAudio) {
        window.alert('排除 Cove 自身音频的系统音频共享仅可在 Windows 桌面版中使用。');
        return;
      }

      const currentQueue = ensureUpdateQueue(producer, isSessionCurrent);
      const native = nativePublication.current?.producer === producer ? nativePublication.current : null;
      if (!native && producer.track && getNativeScreenCaptureDiagnostics(producer.track)) return;
      const settings: NativeScreenSettings = { preset, fps: currentFps, gameMode, nativeResolution, gpuEncoding };
      const onlyPlaybackChanged = initSmoothPlayback !== undefined &&
        initSmoothPlayback !== (producer.appData?.smoothPlayback === true) &&
        preset === deps.screenPreset && currentFps === deps.fps &&
        gameMode === deps.screenGameMode && nativeResolution === deps.screenNativeResolution &&
        audio === Boolean(deps.screenAudioProducer.current);
      const updatePlayback = async () => {
        if (initSmoothPlayback === undefined || initSmoothPlayback === (producer.appData?.smoothPlayback === true)) return;
        await emitAsync(deps.socket, 'screen:set-smooth-playback', {
          producerId: producer.id,
          enabled: initSmoothPlayback,
        });
        ensureCurrent();
        producer.appData.smoothPlayback = initSmoothPlayback;
        deps.setScreenSmoothPlayback(initSmoothPlayback);
      };
      // Invoke capture in the click's turn to retain transient activation.
      // Consume rejection immediately, including while an earlier update waits.
      const capture = native || onlyPlaybackChanged ? null : (async (): Promise<{ stream: MediaStream | null; error?: unknown }> => {
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: screenCaptureVideoConstraints(currentFps, preset, nativeResolution),
            audio: false,
          });
          if (!isCurrent()) {
            releaseScreenCaptureCandidate(stream);
            return { stream: null, error: new CancelledScreenPublication() };
          }
          currentQueue.candidates.add(stream);
          return { stream };
        } catch (error) {
          return { stream: null, error };
        }
      })();

      const commitUpdate = async () => {
        let acquiredStream: MediaStream | null = null;
        try {
          const captured = capture ? await capture : null;
          acquiredStream = captured?.stream ?? null;
          ensureCurrent();
          if (onlyPlaybackChanged) {
            await updatePlayback();
            return;
          }
          // Read ownership at commit time, after the preceding update completed.
          const previousStream = deps.localScreenRef.current;
          let prepared: NativeCaptureCandidate | undefined;
          if (native && (native.settings.preset !== preset || native.settings.fps !== currentFps ||
              native.settings.gameMode !== gameMode || native.settings.nativeResolution !== nativeResolution)) {
            const result = await prepareNativeScreen(native.lease, settings, native.colorSpace, currentQueue.controller.signal, isCurrent);
            if (!result) throw new CancelledScreenPublication();
            prepared = result.capture;
            acquiredStream = prepared.stream;
            currentQueue.candidates.add(acquiredStream);
          }
          const stream = acquiredStream ?? (native ? previousStream : null);
          const videoTrack = stream?.getVideoTracks()[0];
          if (!stream || !videoTrack) throw captured?.error ?? new Error('没有取得屏幕视频轨道');
          const { width, height } = videoTrack.getSettings();
          const plan = createScreenEncodingPlan({
            preset, maxFps: currentFps, activity: gameMode ? 'motion' : 'active',
            sourceWidth: width, sourceHeight: height, nativeResolution, gpuEncoding,
          });
          if (stream !== previousStream) {
            ensureCurrent();
            if (!native) videoTrack.contentHint = plan.contentHint;
            await producer.replaceTrack({ track: videoTrack });
            ensureCurrent();
            prepared?.commit();
            if (native && videoTrack.readyState === 'ended') {
              const previousTrack = previousStream?.getVideoTracks()[0];
              if (previousTrack?.readyState === 'live') {
                try { await producer.replaceTrack({ track: previousTrack }); }
                catch (error) { if (isCurrent()) stopScreenShare(); throw error; }
              }
              throw new Error('新的原生采集轨道已中断。');
            }
            deps.localScreenRef.current = stream;
            currentQueue.candidates.delete(stream);
            acquiredStream = null;
            watchPublishedTrack(stream, producer, currentQueue);
            if (previousStream) releaseScreenCaptureCandidate(previousStream);
            if (videoTrack.readyState === 'ended') { stopScreenShare(); return; }
            deps.setLocalScreen(stream);
          }
          if (native) native.settings = settings;
          if (producer.appData && typeof producer.appData === 'object')
            Object.assign(producer.appData, {
              adaptation: gameMode ? 'game' : 'content',
              preset,
              nativeResolution,
              maxFps: currentFps,
              outputWidth: plan.outputWidth,
              outputHeight: plan.outputHeight,
            });
          deps.videoCounterPrev.current = null;
          deps.remoteLossPrev.current = null;
          deps.setScreenPreset(preset);
          deps.setFps(currentFps);
          deps.setScreenGameMode(gameMode);
          deps.setScreenNativeResolution(nativeResolution);
          // Replace the previous guard timer too, so its callback cannot restore
          // the old FPS/preset after a quick change during the startup grace period.
          deps.armScreenRampGuard(preset, currentFps, nativeResolution);
          deps.applyScreenActivity(
            preset,
            currentFps,
            gameMode ? 'motion' : 'active',
            nativeResolution,
          );
          if (gameMode) deps.stopScreenAnalysis();
          else deps.startScreenAnalysis(stream, preset, currentFps, nativeResolution);

          let hasScreenAudio = Boolean(deps.screenAudioProducer.current);
          if (audio && !hasScreenAudio) {
            try {
              await deps.startScreenAudio(isCurrent);
              ensureCurrent();
              hasScreenAudio = Boolean(deps.screenAudioProducer.current);
            } catch (error) {
              ensureCurrent();
              hasScreenAudio = false;
              console.warn('[screen share] 更新共享音频失败:', error);
              window.alert('屏幕画面已更新，但共享电脑音频启动失败。请稍后重试。');
            }
          } else if (!audio && hasScreenAudio) {
            deps.closeScreenAudio();
            hasScreenAudio = false;
          }
          deps.setShareAudio(audio && hasScreenAudio);
          await updatePlayback();
          console.info('[screen share] 共享参数已更新', {
            preset,
            fps: currentFps,
            gameMode,
            nativeResolution,
            audio: audio && hasScreenAudio,
          });
        } catch (error) {
          if (acquiredStream && currentQueue.candidates.delete(acquiredStream))
            releaseScreenCaptureCandidate(acquiredStream);
          if (!isCurrent() || error instanceof CancelledScreenPublication) return;
          if (!(error instanceof DOMException && error.name === 'NotAllowedError'))
            window.alert(
              `无法更新屏幕共享：${error instanceof Error ? error.message : String(error)}`,
            );
        }
      };
      // Only commits are serialized. Every explicit settings request completes
      // in call order, and a failed/canceled request does not poison the queue.
      const update = currentQueue.tail.then(commitUpdate);
      currentQueue.tail = update.catch(() => {});
      await update;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [
      deps.applyScreenActivity,
      deps.armScreenRampGuard,
      deps.closeScreenAudio,
      deps.fps,
      deps.inVoice,
      deps.isSharing,
      deps.screenGameMode,
      deps.screenNativeResolution,
      deps.screenCompatibilityMode,
      deps.screenPreset,
      deps.shareAudio,
      deps.startScreenAnalysis,
      deps.startScreenAudio,
      deps.stopScreenAnalysis,
    ],
  );

  const stopScreenShare = useCallback(() => {
    publicationGeneration.current += 1;
    pendingStart.current?.cancel();
    pendingStart.current = null;
    rendererActivity.current?.release();
    rendererActivity.current = null;
    setIsStartingScreenShare(false);
    updateQueue.current?.release();
    updateQueue.current = null;
    deps.stopScreenAnalysis();
    deps.clearScreenRampGuard();
    if (deps.screenProducer.current) {
      deps.socket.emit('ms:close-producer', {
        producerId: deps.screenProducer.current.id,
      });
      deps.screenProducer.current.close();
      deps.screenProducer.current = null;
    }
    deps.closeScreenAudio();
    deps.localScreenRef.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    deps.localScreenRef.current = null;
    deps.setLocalScreen(null);
    deps.setIsSharing(false);
    deps.screenDemandActiveRef.current = false;
    deps.setScreenViewerCount(0);
    deps.setScreenActivity('active');
    deps.screenActivityRef.current = 'active';
    deps.setScreenEncodingPlan(null);
    deps.videoCounterPrev.current = null;
    deps.remoteLossPrev.current = null;
    if (!deps.watchingScreenPeerRef.current) deps.setStats(EMPTY_STATS);
  }, [
    deps.clearAvailableScreens,
    deps.clearRemoteApplicationAudios,
    deps.socket,
    deps.stopScreenAnalysis,
    deps.clearScreenRampGuard,
  ]);
  return { startScreenShare, updateScreenShare, stopScreenShare, isStartingScreenShare };
}
