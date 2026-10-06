import { useCallback } from 'react';

import {
  createScreenEncodingPlan,
  SCREEN_MAX_BITRATE_BPS,
  SCREEN_RAMP_GRACE_MS,
  withScreenEncodingPlan,
  type ScreenActivity,
  type ScreenEncodingPlan,
  type ScreenPreset,
} from './screenCapture';

import { Producer, Fps } from '../desktopMediaSupport';

export interface useScreenAnalysisDependencies {
  readonly screenAnalysisTimer: import('react').MutableRefObject<number | null>;
  readonly screenAnalysisVideo: import('react').MutableRefObject<HTMLVideoElement | null>;
  readonly screenAnalysisCanvas: import('react').MutableRefObject<HTMLCanvasElement | null>;
  readonly previousScreenSample: import('react').MutableRefObject<Uint8ClampedArray<ArrayBufferLike> | null>;
  readonly activityCandidate: import('react').MutableRefObject<{
    value: ScreenActivity;
    count: number;
  }>;
  readonly screenProducer: import('react').MutableRefObject<Producer | null>;
  readonly localScreenRef: import('react').MutableRefObject<MediaStream | null>;
  readonly screenRampGuardUntil: import('react').MutableRefObject<number>;
  readonly screenActivityRef: import('react').MutableRefObject<ScreenActivity>;
  readonly setScreenActivity: import('react').Dispatch<
    import('react').SetStateAction<ScreenActivity>
  >;
  readonly setScreenEncodingPlan: import('react').Dispatch<
    import('react').SetStateAction<ScreenEncodingPlan | null>
  >;
  readonly screenRampTimer: import('react').MutableRefObject<number | null>;
}

export function useScreenAnalysis(deps: useScreenAnalysisDependencies) {
  // ── 屏幕共享 ───────────────────────────────────────────────────────────────

  const stopScreenAnalysis = useCallback(() => {
    if (deps.screenAnalysisTimer.current) clearInterval(deps.screenAnalysisTimer.current);
    deps.screenAnalysisTimer.current = null;
    if (deps.screenAnalysisVideo.current) {
      deps.screenAnalysisVideo.current.pause();
      deps.screenAnalysisVideo.current.srcObject = null;
    }
    deps.screenAnalysisVideo.current = null;
    deps.screenAnalysisCanvas.current = null;
    deps.previousScreenSample.current = null;
    deps.activityCandidate.current = { value: 'active', count: 0 };
  }, []);

  const applyScreenActivity = useCallback(
    (preset: ScreenPreset, maxFps: Fps, activity: ScreenActivity, nativeResolution = false) => {
      const producer = deps.screenProducer.current;
      const track = producer?.track ?? deps.localScreenRef.current?.getVideoTracks()[0];
      const settings = track?.getSettings();
      const plan = createScreenEncodingPlan({
        preset,
        maxFps,
        activity,
        sourceWidth: settings?.width,
        sourceHeight: settings?.height,
        nativeResolution,
        rampGuard: Date.now() < deps.screenRampGuardUntil.current,
      });
      deps.screenActivityRef.current = activity;
      deps.setScreenActivity(activity);
      deps.setScreenEncodingPlan(plan);
      if (track) track.contentHint = plan.contentHint;
      // getDisplayMedia requests the selected maximum FPS up front. Activity
      // changes only need to alter sender encoding; applying constraints to a
      // live Windows desktop track can restart WGC/DXGI and leave black frames.
      if (!producer) return;
      if (producer.track) producer.track.contentHint = plan.contentHint;
      try {
        const currentParameters = producer.rtpSender?.getParameters();
        if (!currentParameters) return;
        const params = withScreenEncodingPlan(currentParameters, plan);
        producer.rtpSender
          ?.setParameters(params)
          .then(() => {
            console.info('[media-diag] 已应用屏幕编码参数', {
              activity,
              source: `${plan.sourceWidth}x${plan.sourceHeight}`,
              outputLimit: `${plan.outputWidth}x${plan.outputHeight}`,
              scaleResolutionDownBy: plan.scaleResolutionDownBy,
              requestedFps: plan.fps,
              configuredMaxBitrate: SCREEN_MAX_BITRATE_BPS,
              parameters: producer.rtpSender?.getParameters(),
            });
          })
          .catch((error) => {
            console.warn('[media-diag] 应用屏幕编码参数失败', error);
          });
      } catch (error) {
        console.warn('[media-diag] 读取屏幕编码参数失败', error);
      }
    },
    [],
  );

  /**
   * 起播宽限期：这段时间内即使画面被判为 motion 也保持 maintain-resolution，
   * 避免码率还在爬升时编码器降分辨率换帧率。到期后按当前活跃度重新下发一次，
   * motion 才恢复 maintain-framerate。
   */
  const armScreenRampGuard = useCallback(
    (preset: ScreenPreset, maxFps: Fps, nativeResolution: boolean) => {
      if (deps.screenRampTimer.current) clearTimeout(deps.screenRampTimer.current);
      deps.screenRampGuardUntil.current = Date.now() + SCREEN_RAMP_GRACE_MS;
      deps.screenRampTimer.current = setTimeout(() => {
        deps.screenRampTimer.current = null;
        deps.screenRampGuardUntil.current = 0;
        applyScreenActivity(preset, maxFps, deps.screenActivityRef.current, nativeResolution);
      }, SCREEN_RAMP_GRACE_MS);
    },
    [applyScreenActivity],
  );

  const clearScreenRampGuard = useCallback(() => {
    if (deps.screenRampTimer.current) clearTimeout(deps.screenRampTimer.current);
    deps.screenRampTimer.current = null;
    deps.screenRampGuardUntil.current = 0;
  }, []);

  /**
   * mediasoup 不读取视频像素，因此在发送端把画面缩到 160×90，每秒比较一次
   * 亮度变化。连续静止后降到 15fps；滚动/普通操作用 30fps；大面积变化时才
   * 使用用户选择的最高 60fps。采样只有约 1.4 万像素，开销远低于视频编码。
   */
  const startScreenAnalysis = useCallback(
    (stream: MediaStream, preset: ScreenPreset, maxFps: Fps, nativeResolution: boolean) => {
      stopScreenAnalysis();
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream(stream.getVideoTracks());
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 90;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;

      deps.screenAnalysisVideo.current = video;
      deps.screenAnalysisCanvas.current = canvas;
      video.play().catch(() => {});
      // 调用方在启动分析前已经按 initialActivity 下发过编码参数，这里不再重复
      // 下发一次：多一次 setParameters 就是多一次编码器重配置，正好落在起播
      // 码率爬坡的窗口里。

      deps.screenAnalysisTimer.current = setInterval(() => {
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        try {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const current = context.getImageData(0, 0, canvas.width, canvas.height).data;
          const previous = deps.previousScreenSample.current;
          deps.previousScreenSample.current = current;
          if (!previous || previous.length !== current.length) return;

          let changed = 0;
          let sampled = 0;
          // 每隔一个像素采样；通过 RGB 的近似亮度差过滤编码噪点和光标闪烁。
          for (let index = 0; index < current.length; index += 8) {
            const nowLuma = current[index] * 3 + current[index + 1] * 6 + current[index + 2];
            const oldLuma = previous[index] * 3 + previous[index + 1] * 6 + previous[index + 2];
            if (Math.abs(nowLuma - oldLuma) > 160) changed += 1;
            sampled += 1;
          }
          const changedRatio = sampled ? changed / sampled : 0;
          const next: ScreenActivity =
            changedRatio < 0.004 ? 'static' : changedRatio > 0.12 ? 'motion' : 'active';

          if (deps.activityCandidate.current.value === next)
            deps.activityCandidate.current.count += 1;
          else deps.activityCandidate.current = { value: next, count: 1 };

          // 动态画面立即升档；普通操作需连续2次；静止需连续4秒，防止频繁抖动。
          const required = next === 'motion' ? 1 : next === 'active' ? 2 : 4;
          if (
            deps.activityCandidate.current.count >= required &&
            deps.screenActivityRef.current !== next
          )
            applyScreenActivity(preset, maxFps, next, nativeResolution);
        } catch {
          /* 采样失败不影响共享本身 */
        }
      }, 1_000);
    },
    [applyScreenActivity, stopScreenAnalysis],
  );
  return {
    stopScreenAnalysis,
    applyScreenActivity,
    armScreenRampGuard,
    clearScreenRampGuard,
    startScreenAnalysis,
  };
}
