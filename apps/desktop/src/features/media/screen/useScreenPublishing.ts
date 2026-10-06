import { useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { Device } from 'mediasoup-client';

import { type RtcVideoCounterSample } from '../diagnostics/mediaDiagnostics';
import {
  createScreenEncodingPlan,
  SCREEN_MAX_BITRATE_BPS,
  toScreenRtpEncoding,
  type ScreenActivity,
  type ScreenEncodingPlan,
  type ScreenPreset,
} from './screenCapture';
import { ApplicationAudioPipeline } from '../application-audio/applicationAudio';
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
  readonly isSharing: boolean;
  readonly screenPreset: '540p' | '720p' | '1080p' | '1440p';
  readonly screenGameMode: boolean;
  readonly screenNativeResolution: boolean;
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
  readonly startScreenAudio: () => Promise<void>;
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

export function useScreenPublishing(deps: useScreenPublishingDependencies) {
  const startScreenShare = useCallback(
    async (
      initPreset?: ScreenPreset,
      initFps?: Fps,
      initAudio?: boolean,
      initGameMode?: boolean,
      initNativeResolution?: boolean,
    ) => {
      if (!deps.inVoice || deps.isSharing) return;
      const preset = initPreset ?? deps.screenPreset;
      const gameMode = initGameMode ?? deps.screenGameMode;
      const nativeResolution = initNativeResolution ?? deps.screenNativeResolution;
      const currentFps: Fps = gameMode ? 60 : initFps ?? deps.fps;
      const audio = initAudio ?? deps.shareAudio;
      if (initPreset !== undefined) deps.setScreenPreset(initPreset);
      if (initFps !== undefined || gameMode) deps.setFps(currentFps);
      if (initAudio !== undefined) deps.setShareAudio(initAudio);
      if (initGameMode !== undefined) deps.setScreenGameMode(initGameMode);
      if (initNativeResolution !== undefined) deps.setScreenNativeResolution(initNativeResolution);

      // System-audio sharing must use the native process-exclusion bridge so
      // Cove's own voice and sound-pack playback can never enter the stream.
      // There is intentionally no full-system/browser fallback.
      if (audio && !window.coveScreenAudio) {
        window.alert('排除 Cove 自身音频的系统音频共享仅可在 Windows 桌面版中使用。');
        return;
      }

      const initialActivity: ScreenActivity = gameMode ? 'motion' : 'active';
      let acquiredStream: MediaStream | null = null;
      let startupStage = '申请屏幕采集';
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          // 桌面源保持原始尺寸，720p/1080p 由 RTP 编码缩放统一控制。
          video: { frameRate: { ideal: currentFps, max: currentFps } },
          // The native Windows bridge supplies the filtered system audio as a
          // separate track. Chromium's global loopback track is never requested,
          // because it would include Cove's own playback.
          audio: false,
        });
        acquiredStream = stream;
        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) throw new Error('没有取得屏幕视频轨道');
        startupStage = '等待屏幕采集轨道就绪';
        await waitForMediaTrackWarmup(videoTrack);
        videoTrack.contentHint = gameMode ? 'motion' : 'detail';
        // getDisplayMedia already requested this frame rate. Reapplying even
        // the same constraints here can restart Windows' capture source; on
        // some WGC/DXGI paths Chromium then rejects with "Could not start video
        // source" or leaves a live-but-black track. Keep the acquired source
        // intact and only change capture constraints for later user changes.
        const trackSettings = videoTrack.getSettings();
        const initialPlan = createScreenEncodingPlan({
          preset,
          maxFps: currentFps,
          activity: initialActivity,
          sourceWidth: trackSettings.width,
          sourceHeight: trackSettings.height,
          nativeResolution,
        });
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
        deps.localScreenRef.current = stream;
        deps.setLocalScreen(stream);
        deps.videoCounterPrev.current = null;
        deps.remoteLossPrev.current = null;

        const negotiatedCodecs = deps.deviceRef.current?.rtpCapabilities.codecs ?? [];
        const codecCandidates = ['video/av1', 'video/vp9']
          .map((mimeType) =>
            negotiatedCodecs.find((codec) => codec.mimeType.toLowerCase() === mimeType),
          )
          .filter((codec): codec is NonNullable<typeof codec> => Boolean(codec));

        // 直接发送 getDisplayMedia 返回的原始轨道；旧实现 clone() 后继续约束原轨道，
        // 会让 Producer 的轨道停留在 Chromium 自行选择的采集帧率。
        startupStage = '初始化屏幕视频发送';
        let producer: Producer | null = null;
        let lastProduceError: unknown = null;
        for (const codec of [...codecCandidates, undefined]) {
          try {
            producer = await produceWithSsrcRetry(() =>
              deps.sendTransport.current!.produce({
                track: videoTrack,
                streamId: `screen-${deps.socket.id}`,
                appData: {
                  type: 'screen',
                  adaptation: gameMode ? 'game' : 'content',
                  preset,
                  nativeResolution,
                  maxFps: currentFps,
                  outputWidth: initialPlan.outputWidth,
                  outputHeight: initialPlan.outputHeight,
                  preferredCodec: codec?.mimeType ?? 'auto',
                },
                encodings: [toScreenRtpEncoding(initialPlan)],
                // 初始带宽估计（kbps），不是上限；与 SFU 启动估计一致，之后由拥塞控制调整。
                codecOptions: {
                  videoGoogleStartBitrate: 10_000,
                  videoGoogleMaxBitrate: SCREEN_MAX_BITRATE_BPS / 1_000,
                },
                ...(codec ? { codec } : {}),
                stopTracks: false,
                disableTrackOnPause: false,
                zeroRtpOnPause: true,
              }),
            );
            console.info(`[screen share] 编码器：${codec?.mimeType ?? '浏览器自动选择'}`);
            break;
          } catch (error) {
            lastProduceError = error;
            console.warn(
              `[screen share] ${codec?.mimeType ?? '自动 codec'} 编码失败，尝试回退`,
              error,
            );
          }
        }
        if (!producer) throw lastProduceError ?? new Error('没有可用的屏幕共享视频编码器');
        deps.screenProducer.current = producer;
        if (!deps.screenDemandActiveRef.current) producer.pause();
        deps.armScreenRampGuard(preset, currentFps, nativeResolution);
        deps.applyScreenActivity(preset, currentFps, initialActivity, nativeResolution);
        if (gameMode) deps.stopScreenAnalysis();
        else deps.startScreenAnalysis(stream, preset, currentFps, nativeResolution);

        // Electron's global `loopback` source captures Cove's own voice and
        // sound-pack playback as well as other desktop audio. The Windows client
        // therefore uses only the native process-loopback capture in exclude
        // mode (Cove's process tree is removed at the WASAPI level).
        if (audio) {
          startupStage = '启动共享系统音频';
          try {
            await deps.startScreenAudio();
          } catch (e) {
            console.warn('[screen share] 排除 Cove 后的系统音频发布失败:', e);
            window.alert('屏幕画面已开始共享，但系统音频发布失败。请停止共享后重试。');
          }
        }

        deps.setIsSharing(true);

        // 用户在浏览器 UI 点"停止共享"
        stream.getVideoTracks()[0].onended = () => stopScreenShare();
      } catch (e) {
        console.error(`[screen share] ${startupStage}失败`, e);
        deps.stopScreenAnalysis();
        deps.clearScreenRampGuard();
        if (deps.screenProducer.current) {
          deps.socket.emit('ms:close-producer', {
            producerId: deps.screenProducer.current.id,
          });
          deps.screenProducer.current.close();
          deps.screenProducer.current = null;
        }
        if (deps.screenAudioProducer.current) {
          deps.socket.emit('ms:close-producer', {
            producerId: deps.screenAudioProducer.current.id,
          });
          deps.screenAudioProducer.current.close();
          deps.screenAudioProducer.current = null;
        }
        deps.screenAudioUnsubscribe.current?.();
        deps.screenAudioUnsubscribe.current = null;
        deps.screenAudioPipeline.current?.close();
        deps.screenAudioPipeline.current = null;
        await window.coveScreenAudio?.stop();
        acquiredStream?.getTracks().forEach((track) => track.stop());
        if (deps.localScreenRef.current === acquiredStream) deps.localScreenRef.current = null;
        deps.setLocalScreen(null);
        deps.setIsSharing(false);
        deps.setScreenEncodingPlan(null);
        if (!(e instanceof DOMException && e.name === 'NotAllowedError'))
          window.alert(`无法开始屏幕共享：${e instanceof Error ? e.message : String(e)}`);
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
    ) => {
      if (!deps.inVoice || !deps.isSharing) return;
      const producer = deps.screenProducer.current;
      if (!producer) return;

      const preset = initPreset ?? deps.screenPreset;
      const gameMode = initGameMode ?? deps.screenGameMode;
      const nativeResolution = initNativeResolution ?? deps.screenNativeResolution;
      const currentFps: Fps = gameMode ? 60 : initFps ?? deps.fps;
      const audio = initAudio ?? deps.shareAudio;
      if (audio && !window.coveScreenAudio) {
        window.alert('排除 Cove 自身音频的系统音频共享仅可在 Windows 桌面版中使用。');
        return;
      }

      const previousStream = deps.localScreenRef.current;
      let acquiredStream: MediaStream | null = null;
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: currentFps, max: currentFps } },
          audio: false,
        });
        acquiredStream = stream;
        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) throw new Error('没有取得屏幕视频轨道');
        videoTrack.contentHint = gameMode ? 'motion' : 'detail';
        // The new getDisplayMedia request above already carries the preferred
        // frame rate. Avoid restarting its Windows capture source before the
        // existing producer can switch to it.
        const settings = videoTrack.getSettings();
        const plan = createScreenEncodingPlan({
          preset,
          maxFps: currentFps,
          activity: gameMode ? 'motion' : 'active',
          sourceWidth: settings.width,
          sourceHeight: settings.height,
          nativeResolution,
        });

        if (deps.screenProducer.current !== producer || producer.closed) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        await producer.replaceTrack({ track: videoTrack });
        if (producer.appData && typeof producer.appData === 'object')
          Object.assign(producer.appData, {
            adaptation: gameMode ? 'game' : 'content',
            preset,
            nativeResolution,
            maxFps: currentFps,
            outputWidth: plan.outputWidth,
            outputHeight: plan.outputHeight,
          });

        if (previousStream && previousStream !== stream) {
          previousStream.getVideoTracks().forEach((track) => {
            track.onended = null;
            track.stop();
          });
          previousStream.getAudioTracks().forEach((track) => track.stop());
        }
        deps.localScreenRef.current = stream;
        deps.setLocalScreen(stream);
        deps.videoCounterPrev.current = null;
        deps.remoteLossPrev.current = null;
        deps.setScreenPreset(preset);
        deps.setFps(currentFps);
        deps.setScreenGameMode(gameMode);
        deps.setScreenNativeResolution(nativeResolution);
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
            await deps.startScreenAudio();
            hasScreenAudio = Boolean(deps.screenAudioProducer.current);
          } catch (error) {
            hasScreenAudio = false;
            console.warn('[screen share] 更新共享音频失败:', error);
            window.alert('屏幕画面已更新，但共享电脑音频启动失败。请稍后重试。');
          }
        } else if (!audio && hasScreenAudio) {
          deps.closeScreenAudio();
          hasScreenAudio = false;
        }
        deps.setShareAudio(audio && hasScreenAudio);
        videoTrack.onended = () => stopScreenShare();
        console.info('[screen share] 共享参数已更新', {
          preset,
          fps: currentFps,
          gameMode,
          nativeResolution,
          audio: audio && hasScreenAudio,
        });
      } catch (error) {
        acquiredStream?.getTracks().forEach((track) => track.stop());
        if (!(error instanceof DOMException && error.name === 'NotAllowedError'))
          window.alert(
            `无法更新屏幕共享：${error instanceof Error ? error.message : String(error)}`,
          );
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [
      deps.applyScreenActivity,
      deps.closeScreenAudio,
      deps.fps,
      deps.inVoice,
      deps.isSharing,
      deps.screenGameMode,
      deps.screenNativeResolution,
      deps.screenPreset,
      deps.shareAudio,
      deps.startScreenAnalysis,
      deps.startScreenAudio,
      deps.stopScreenAnalysis,
    ],
  );

  const stopScreenShare = useCallback(() => {
    deps.stopScreenAnalysis();
    deps.clearScreenRampGuard();
    if (deps.screenProducer.current) {
      deps.socket.emit('ms:close-producer', {
        producerId: deps.screenProducer.current.id,
      });
      deps.screenProducer.current.close();
      deps.screenProducer.current = null;
    }
    if (deps.screenAudioProducer.current) {
      deps.socket.emit('ms:close-producer', {
        producerId: deps.screenAudioProducer.current.id,
      });
      deps.screenAudioProducer.current.close();
      deps.screenAudioProducer.current = null;
    }
    deps.screenAudioUnsubscribe.current?.();
    deps.screenAudioUnsubscribe.current = null;
    deps.screenAudioPipeline.current?.close();
    deps.screenAudioPipeline.current = null;
    void window.coveScreenAudio?.stop();
    deps.localScreenRef.current?.getTracks().forEach((t) => t.stop());
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
  return { startScreenShare, updateScreenShare, stopScreenShare };
}
