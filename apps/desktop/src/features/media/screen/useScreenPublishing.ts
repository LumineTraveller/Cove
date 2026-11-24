import { useCallback, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import { Device } from 'mediasoup-client';
import { NATIVE_SCREEN_MAX_WIDTH, NATIVE_SCREEN_MAX_HEIGHT } from '../../../../electron/native-screen-capture-protocol';

import { type RtcVideoCounterSample } from '../diagnostics/mediaDiagnostics';
import {
  createScreenEncodingPlan,
  screenCaptureVideoConstraints,
  SCREEN_MAX_BITRATE_BPS,
  SCREEN_PRESETS,
  SCREEN_START_BITRATE_BPS,
  toScreenRtpEncoding,
  type ScreenActivity,
  type ScreenEncodingPlan,
  type ScreenPreset,
} from './screenCapture';
import { ApplicationAudioPipeline } from '../application-audio/applicationAudio';
import { screenPublicationCodecCandidates } from './screenCodecPolicy';
import { getLastNativeScreenCaptureAttempt, nativeScreenContentHint, tryNativeScreenCapture,
  type NativeCaptureCandidate, type NativeScreenBridge } from './nativeScreenCapture';
import { canUpgradeScreenCapture, upgradePublishedScreenCapture } from './nativeScreenUpgrade';
import {
  Transport,
  Producer,
  Fps,
  MediaStats,
  EMPTY_STATS,
  waitForMediaTrackWarmup,
  produceWithSsrcRetry,
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
  readonly release: () => void;
  tail: Promise<void>;
}

function releaseScreenCaptureCandidate(stream: MediaStream) {
  stream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
}

async function prepareHardwareScreenCapture(
  stockStream: MediaStream,
  plan: ScreenEncodingPlan,
  fps: Fps,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<{ capture: NativeCaptureCandidate; plan: ScreenEncodingPlan }> {
  // Chromium may not report stock track dimensions before its first frame.
  // The native capture fits the physical display into the requested bounds.
  const bounds = plan.nativeResolution
    ? { width: NATIVE_SCREEN_MAX_WIDTH, height: NATIVE_SCREEN_MAX_HEIGHT }
    : SCREEN_PRESETS[plan.preset];
  const prepared = await tryNativeScreenCapture(stockStream, {
    maxWidth: bounds.width, maxHeight: bounds.height, fps,
    colorSpace: 'bt709-limited', cpuNv12: true, nativeResolution: plan.nativeResolution,
    contentHint: stockStream.getVideoTracks()[0]?.contentHint,
    isCurrent, signal,
  });
  try {
    if (!isCurrent() || signal.aborted) throw new CancelledScreenPublication();
    const track = prepared?.stream.getVideoTracks()[0];
    const { width, height } = track?.getSettings() ?? {};
    if (!prepared || track?.readyState !== 'live' || !width || !height) {
      const attempt = getLastNativeScreenCaptureAttempt();
      if (attempt?.startFailureReason === 'native_resolution_unavailable' ||
          attempt?.backendEndReason === 'native_resolution_unavailable')
        throw new Error('GPU 采集无法保留原生分辨率。请关闭 GPU 编码或选择分辨率档位。');
      if (attempt?.startFailureReason === 'desktop_unavailable' || attempt?.backendEndReason === 'desktop_unavailable')
        throw new Error('Windows 桌面暂不可用。关闭系统提示后请重新共享。');
      throw new Error('GPU 屏幕采集启动失败。请重试或关闭 GPU 编码。');
    }
    const capability = await navigator.mediaCapabilities?.encodingInfo({
      type: 'webrtc',
      video: { contentType: 'video/AV1', width, height, framerate: fps,
        bitrate: SCREEN_START_BITRATE_BPS, scalabilityMode: 'L1T1' },
    }).catch(() => null);
    if (!isCurrent() || signal.aborted) throw new CancelledScreenPublication();
    if (!capability?.supported || !capability.powerEfficient)
      throw new Error('显卡无法按当前分辨率和帧率编码 AV1。请关闭 GPU 编码或调整共享设置。');
    if (track.readyState !== 'live') throw new Error('GPU 屏幕采集已停止。请重试。');

    track.contentHint = nativeScreenContentHint(track, plan.contentHint);
    return {
      capture: prepared,
      plan: { ...plan, sourceWidth: width, sourceHeight: height,
        outputWidth: width, outputHeight: height, scaleResolutionDownBy: 1 },
    };
  } catch (error) {
    prepared?.stop();
    throw error;
  }
}

export function useScreenPublishing(deps: useScreenPublishingDependencies) {
  const publicationGeneration = useRef(0);
  const pendingStart = useRef<{ operation: number; isCurrent: () => boolean; cancel: () => void } | null>(null);
  const [isStartingScreenShare, setIsStartingScreenShare] = useState(false);
  const rendererActivity = useRef<{ operation: number; release(): void } | null>(null);
  const updateQueue = useRef<ScreenUpdateQueue | null>(null);
  const nativeUpgradeIntent = useRef(0);
  const nativeUpgradeAbort = useRef<{ controller: AbortController; queue: ScreenUpdateQueue } | null>(null);

  const cancelNativeUpgrade = () => {
    nativeUpgradeIntent.current += 1;
    nativeUpgradeAbort.current?.controller.abort();
    nativeUpgradeAbort.current = null;
    return nativeUpgradeIntent.current;
  };

  const ensureUpdateQueue = (producer: Producer, isCurrent: () => boolean): ScreenUpdateQueue => {
    const existing = updateQueue.current;
    if (existing?.isCurrent()) return existing;
    existing?.release();
    const candidates = new Set<MediaStream>();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      producer.observer?.off('close', release);
      // An old producer closing cannot cancel a newer publication's preparation.
      if (nativeUpgradeAbort.current?.queue === queue) {
        nativeUpgradeAbort.current.controller.abort();
        nativeUpgradeAbort.current = null;
      }
      candidates.forEach(releaseScreenCaptureCandidate);
      candidates.clear();
    };
    const queue: ScreenUpdateQueue = {
      isCurrent: () => !released && isCurrent(), candidates, release, tail: Promise.resolve(),
    };
    updateQueue.current = queue;
    producer.observer?.once('close', release);
    return queue;
  };

  const beginNativeUpgrade = (
    stream: MediaStream, producer: Producer, queue: ScreenUpdateQueue,
    intent: number, plan: ScreenEncodingPlan, maxFps: Fps, gameMode: boolean,
  ) => {
    if (maxFps === 30) return;
    // Most builds have no native bridge. Keep their original synchronous path.
    const bridge = (window as Window & { coveNativeScreen?: NativeScreenBridge }).coveNativeScreen;
    if (!bridge?.supported || nativeUpgradeIntent.current !== intent || !queue.isCurrent() ||
        deps.localScreenRef.current !== stream || !canUpgradeScreenCapture(producer, plan)) return;
    const controller = new AbortController();
    nativeUpgradeAbort.current = { controller, queue };
    void upgradePublishedScreenCapture({
      stockStream: stream, stockPlan: plan, maxFps, producer, queue, signal: controller.signal,
      isIntentCurrent: () => nativeUpgradeIntent.current === intent,
      isPublicationCurrent: queue.isCurrent,
      currentStream: () => deps.localScreenRef.current,
      acquire: tryNativeScreenCapture,
      onCommit: (nativeStream, track, width, height) => {
        deps.localScreenRef.current = nativeStream;
        deps.setLocalScreen(nativeStream);
        if (producer.appData && typeof producer.appData === 'object')
          Object.assign(producer.appData, { sourceWidth: width, sourceHeight: height, outputWidth: width, outputHeight: height });
        // Preserve the current activity's FPS and degradation settings. In
        // particular, applyScreenActivity is an asynchronous sender mutation.
        deps.setScreenEncodingPlan(current => ({
          ...(current ?? plan), sourceWidth: width, sourceHeight: height,
          outputWidth: width, outputHeight: height, scaleResolutionDownBy: 1,
          contentHint: track.contentHint === 'motion' ? 'motion' : 'detail',
        }));
        deps.videoCounterPrev.current = null;
        deps.remoteLossPrev.current = null;
        if (gameMode) deps.stopScreenAnalysis();
        else deps.startScreenAnalysis(nativeStream, plan.preset, maxFps, false);
      },
      stopPublication: () => stopScreenShare(),
    }).catch(error => {
      console.warn('[screen share] native upgrade kept stock capture', error);
    }).then(() => {
      if (nativeUpgradeAbort.current?.controller === controller) nativeUpgradeAbort.current = null;
    });
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
      const bridge = (window as Window & { coveNativeScreen?: NativeScreenBridge }).coveNativeScreen;
      const hardwareAv1Available = bridge?.hardwareAv1Encoding === true;
      const gpuEncoding = initGpuEncoding ?? (hardwareAv1Available && !compatibilityMode && deps.screenGpuEncoding);
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

      // System-audio sharing must use the native process-exclusion bridge so
      // Cove's own voice and sound-pack playback can never enter the stream.
      // There is intentionally no full-system/browser fallback.
      if (audio && !window.coveScreenAudio) {
        window.alert('排除 Cove 自身音频的系统音频共享仅可在 Windows 桌面版中使用。');
        return false;
      }

      const nativeIntent = cancelNativeUpgrade();
      const initialActivity: ScreenActivity = gameMode ? 'motion' : 'active';
      const operation = ++publicationGeneration.current;
      const generation = deps.mediaGeneration.current;
      const socketId = deps.socket.id;
      const controller = new AbortController();
      pendingStart.current?.cancel();
      let acquiredStream: MediaStream | null = null;
      let stockStream: MediaStream | null = null;
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
      const releaseStock = () => {
        if (stockStream && stockStream !== acquiredStream) releaseScreenCaptureCandidate(stockStream);
        stockStream = null;
      };
      controller.signal.addEventListener('abort', () => {
        releaseActivity();
        if (!videoCommitted) {
          releaseStock();
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
        const selected = await navigator.mediaDevices.getDisplayMedia({
          // Bound capture before the RTP stage to avoid a second large-frame
          // resize. Native mode retains the original FPS-only request.
          video: screenCaptureVideoConstraints(currentFps, preset, nativeResolution),
          // The native Windows bridge supplies the filtered system audio as a
          // separate track. Chromium's global loopback track is never requested,
          // because it would include Cove's own playback.
          audio: false,
        });
        stockStream = selected;
        let stream = selected;
        acquiredStream = stream;
        ensureCurrent();
        const selectedTrack = stream.getVideoTracks()[0];
        if (!selectedTrack) throw new Error('没有取得屏幕视频轨道');
        let videoTrack = selectedTrack;
        try { activityRelease = window.coveScreenShareActivity?.acquire(); }
        catch { console.warn('[screen share] renderer activity unavailable'); }
        rendererActivity.current = { operation, release: releaseActivity };
        startupStage = '等待屏幕采集轨道就绪';
        await waitForMediaTrackWarmup(videoTrack);
        ensureCurrent();
        videoTrack.contentHint = gameMode ? 'motion' : 'detail';
        // getDisplayMedia already requested this frame rate. Reapplying even
        // the same constraints here can restart Windows' capture source; on
        // some WGC/DXGI paths Chromium then rejects with "Could not start video
        // source" or leaves a live-but-black track. Keep the acquired source
        // intact and only change capture constraints for later user changes.
        const trackSettings = videoTrack.getSettings();
        let initialPlan = createScreenEncodingPlan({
          preset,
          maxFps: currentFps,
          activity: initialActivity,
          sourceWidth: trackSettings.width,
          sourceHeight: trackSettings.height,
          nativeResolution,
        });
        const startAv1WithNative = bridge?.supported && bridge.startAv1WithNative === true &&
          codecCandidates[0]?.mimeType.toLowerCase() === 'video/av1';
        if (gpuEncoding) {
          startupStage = '准备 GPU 编码画面';
          ({ capture: initialNative, plan: initialPlan } = await prepareHardwareScreenCapture(
            selected, initialPlan, currentFps, controller.signal, isCurrent,
          ));
          stream = initialNative.stream;
          videoTrack = stream.getVideoTracks()[0];
          acquiredStream = stream;
          ensureCurrent();
        } else if (startAv1WithNative && !nativeResolution && currentFps > 30 && initialPlan.scaleResolutionDownBy === 1 &&
            trackSettings.width && trackSettings.height) {
          startupStage = '准备原生屏幕视频轨道';
          const prepared = await tryNativeScreenCapture(selected, {
            maxWidth: trackSettings.width, maxHeight: trackSettings.height, fps: currentFps,
            colorSpace: 'bt709-limited', nativeResolution: false, contentHint: selectedTrack.contentHint,
            opaqueDesktopView: bridge.opaqueAv1Input === true,
            isCurrent, signal: controller.signal,
          });
          const preparedTrack = prepared?.stream.getVideoTracks()[0];
          const preparedSize = preparedTrack?.getSettings();
          if (prepared && isCurrent() && preparedTrack?.readyState === 'live' &&
              preparedSize?.width === trackSettings.width && preparedSize.height === trackSettings.height) {
            preparedTrack.contentHint = nativeScreenContentHint(preparedTrack, selectedTrack.contentHint);
            initialNative = prepared;
            stream = prepared.stream;
            videoTrack = preparedTrack;
            acquiredStream = stream;
          } else prepared?.stop();
          ensureCurrent();
        }
        console.info('[media-diag] 屏幕采集已开始', {
          requested: {
            preset,
            outputLimit: `${initialPlan.outputWidth}x${initialPlan.outputHeight}`,
            fps: currentFps,
            gameMode,
          },
          constraintMode: 'getDisplayMedia',
          settings: trackSettings,
          constraints: videoTrack.getConstraints(),
          capabilities: videoTrack.getCapabilities(),
        });
        // 发布实际选中的采集轨道，使采集设置和 Producer 使用同一轨道。
        startupStage = '初始化屏幕视频发送';
        let producer: Producer | null = null;
        let lastProduceError: unknown = null;
        let retainFirstTrack = gpuEncoding;
        // A failed initial native attempt retries the same negotiated codec
        // with the still-live picker track before falling back to other codecs.
        for (const codec of initialNative && !gpuEncoding ? [codecCandidates[0], ...codecCandidates] : codecCandidates) {
          try {
            const av1Selected = codec?.mimeType.toLowerCase() === 'video/av1';
            // On the pinned Chromium AV1 hardware only supports L1T1.
            // L1T2 keeps both temporal layers at the selected total frame rate
            // while directing the software choice to libaom.
            const av1Mode = av1Selected && hardwareAv1Available ? (gpuEncoding ? 'L1T1' : 'L1T2') : undefined;
            producer = await produceWithSsrcRetry(async () => {
              await waitForSignal();
              ensureCurrent();
              return transport.produce({
                track: videoTrack,
                streamId: `screen-${socketId}`,
                appData: {
                  type: 'screen',
                  adaptation: gameMode ? 'game' : 'content',
                  preset,
                  nativeResolution,
                  gpuEncoding,
                  maxFps: currentFps,
                  outputWidth: initialPlan.outputWidth,
                  outputHeight: initialPlan.outputHeight,
                  preferredCodec: codec?.mimeType ?? 'auto',
                  compatibilityMode,
                },
                encodings: [{ ...toScreenRtpEncoding(initialPlan), ...(av1Mode ? { scalabilityMode: av1Mode } : {}) }],
                // 初始带宽估计（kbps），不是上限；与 SFU 启动估计一致，之后由拥塞控制调整。
                codecOptions: {
                  videoGoogleStartBitrate: SCREEN_START_BITRATE_BPS / 1_000,
                  videoGoogleMaxBitrate: SCREEN_MAX_BITRATE_BPS / 1_000,
                },
                ...(codec ? { codec } : {}),
                stopTracks: false,
                disableTrackOnPause: false,
                zeroRtpOnPause: true,
              });
            });
            acquiredProducer = producer;
            ensureCurrent();
            retainFirstTrack = gpuEncoding || Boolean(startAv1WithNative && av1Selected);
            console.info(`[screen share] 编码器：${codec?.mimeType ?? '浏览器自动选择'}`);
            break;
          } catch (error) {
            ensureCurrent();
            if (gpuEncoding) throw error;
            if (initialNative) {
              initialNative.stop();
              initialNative = null;
              stream = selected;
              videoTrack = selectedTrack;
              acquiredStream = selected;
            }
            lastProduceError = error;
            console.warn('[screen share] codec publication failed', { codec: codec?.mimeType ?? 'auto', compatibilityMode }, error);
          }
        }
        if (!producer) throw lastProduceError ?? new Error('没有可用的屏幕共享视频编码器');
        initialNative?.commit();
        releaseStock();
        deps.screenProducer.current = producer;
        producer.observer?.once('close', releaseActivity);
        const publishedProducer = producer;
        const queue = ensureUpdateQueue(publishedProducer, () => isCurrent() &&
          deps.screenProducer.current === publishedProducer && !publishedProducer.closed);
        deps.localScreenRef.current = stream;
        // 用户在浏览器 UI 点"停止共享"
        videoTrack.onended = () => {
          if (isCurrent() && deps.localScreenRef.current === stream && deps.screenProducer.current === producer)
            stopScreenShare();
        };
        if (videoTrack.readyState === 'ended') {
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
        if (!retainFirstTrack) beginNativeUpgrade(stream, producer, queue, nativeIntent, initialPlan, currentFps, gameMode);
        return true;

      } catch (e) {
        releaseActivity();
        releaseStock();
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

      // A new user intent cancels native preparation immediately, while stock
      // updates retain their existing ordered commit semantics.
      const nativeIntent = cancelNativeUpgrade();
      const currentQueue = ensureUpdateQueue(producer, isSessionCurrent);
      // Invoke capture in the click's turn to retain transient activation.
      // Consume rejection immediately, including while an earlier update waits.
      const capture = (async (): Promise<{ stream: MediaStream | null; error?: unknown }> => {
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
        let stockToRelease: MediaStream | null = null;
        try {
          const captured = await capture;
          acquiredStream = captured.stream;
          ensureCurrent();
          if (!acquiredStream) throw captured.error;
          let stream = acquiredStream;
          // Read ownership at commit time, after the preceding update completed.
          const previousStream = deps.localScreenRef.current;
          let videoTrack = stream.getVideoTracks()[0];
          if (!videoTrack) throw new Error('没有取得屏幕视频轨道');
          if (gpuEncoding) await waitForMediaTrackWarmup(videoTrack);
          ensureCurrent();
          videoTrack.contentHint = gameMode ? 'motion' : 'detail';
          // The new getDisplayMedia request above already carries the preferred
          // frame rate. Avoid restarting its Windows capture source before the
          // existing producer can switch to it.
          const settings = videoTrack.getSettings();
          let plan = createScreenEncodingPlan({
            preset,
            maxFps: currentFps,
            activity: gameMode ? 'motion' : 'active',
            sourceWidth: settings.width,
            sourceHeight: settings.height,
            nativeResolution,
          });
          let prepared: NativeCaptureCandidate | undefined;
          if (gpuEncoding) {
            const preparation = { controller: new AbortController(), queue: currentQueue };
            nativeUpgradeAbort.current = preparation;
            try {
              ({ capture: prepared, plan } = await prepareHardwareScreenCapture(
                stream, plan, currentFps, preparation.controller.signal, isCurrent,
              ));
            } finally {
              if (nativeUpgradeAbort.current === preparation) nativeUpgradeAbort.current = null;
            }
            stockToRelease = stream;
            stream = prepared.stream;
            currentQueue.candidates.add(stream);
            acquiredStream = stream;
            videoTrack = stream.getVideoTracks()[0];
          }

          ensureCurrent();
          await producer.replaceTrack({ track: videoTrack });
          ensureCurrent();
          prepared?.commit();

          if (previousStream && previousStream !== stream) {
            previousStream.getVideoTracks().forEach((track) => {
              track.onended = null;
              track.stop();
            });
            previousStream.getAudioTracks().forEach((track) => track.stop());
          }
          deps.localScreenRef.current = stream;
          // The live publication now owns the attached track. Later failures or
          // queue cleanup must never release it as an uncommitted candidate.
          currentQueue.candidates.delete(stream);
          acquiredStream = null;
          videoTrack.onended = () => {
            if (isSessionCurrent() && deps.localScreenRef.current === stream) stopScreenShare();
          };
          if (videoTrack.readyState === 'ended') {
            stopScreenShare();
            return;
          }
          deps.setLocalScreen(stream);
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
          if (!gpuEncoding) beginNativeUpgrade(stream, producer, currentQueue, nativeIntent, plan, currentFps, gameMode);
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
        } finally {
          if (stockToRelease && currentQueue.candidates.delete(stockToRelease))
            releaseScreenCaptureCandidate(stockToRelease);
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
    cancelNativeUpgrade();
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
