export const SCREEN_PRESETS = {
  '540p': { label: '540p 流畅', width: 960, height: 540 },
  '720p': { label: '720p 均衡', width: 1280, height: 720 },
  '1080p': { label: '1080p 清晰', width: 1920, height: 1080 },
  '1440p': { label: '1440p 2K', width: 2560, height: 1440 },
} as const;

export type ScreenPreset = keyof typeof SCREEN_PRESETS;
export type ScreenFps = 30 | 60;
export type ScreenActivity = 'static' | 'active' | 'motion';

/**
 * 拥塞控制从起播的低码率爬到可用码率需要数秒。此期间若允许
 * maintain-framerate，编码器会降分辨率换帧率，观看端看到的是开头几秒画面
 * 发糊、随后才变清晰。宽限期内一律保分辨率，宁可掉帧率。
 */
export const SCREEN_RAMP_GRACE_MS = 5_000;

// Override WebRTC's implicit single-stream 2.5 Mbps default; this is a ceiling,
// not a target or minimum. Congestion control still chooses the actual rate.
export const SCREEN_MAX_BITRATE_BPS = 200_000_000;

export interface ScreenEncodingPlan {
  preset: ScreenPreset;
  nativeResolution: boolean;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  scaleResolutionDownBy: number;
  fps: number;
  contentHint: 'detail' | 'motion';
  degradationPreference: RTCDegradationPreference;
}

/**
 * A pixel/cadence seed can use headroom already observed on the send transport.
 * Without that evidence, retain the existing 10 Mbps bootstrap: blindly raising
 * the initial probes delays cold startup on a constrained link. The 0.12
 * bits/pixel/frame heuristic and bootstrap are neither steady-state targets nor
 * minima. GCC still controls the actual rate; no runtime rate forcing is used.
 */
export function screenCodecOptions(plan: ScreenEncodingPlan, availableOutgoingBitrate?: number) {
  const pixelBudgetBps = plan.outputWidth * plan.outputHeight * plan.fps * 0.12;
  const observedBudgetBps =
    typeof availableOutgoingBitrate === 'number' && Number.isFinite(availableOutgoingBitrate)
      ? Math.max(0, availableOutgoingBitrate) * 0.85
      : 0;
  const initialBitrateBps = Math.min(pixelBudgetBps, Math.max(10_000_000, observedBudgetBps));
  return {
    videoGoogleStartBitrate: Math.max(
      1,
      Math.round(Math.min(SCREEN_MAX_BITRATE_BPS, initialBitrateBps) / 1_000),
    ),
    videoGoogleMaxBitrate: SCREEN_MAX_BITRATE_BPS / 1_000,
  };
}

export interface ScreenRtpEncodingParameters {
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
}

export function screenEncodingProfile(maxFps: ScreenFps, activity: ScreenActivity) {
  if (activity === 'static') return { fps: 15 };
  // Any changing content may use the user's selected cadence. Small windows
  // should not require >12% of the screen to change to unlock 60 FPS.
  return { fps: maxFps };
}

function positiveDimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function evenFloor(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * 桌面捕获轨道可以保留显示器原生分辨率；画质档位约束的是编码输出。
 * 使用一个统一缩放因子把画面完整装入档位边界，不裁剪、不拉伸，也不放大
 * 低于档位分辨率的窗口。
 */
export function createScreenEncodingPlan({
  preset,
  maxFps,
  activity,
  sourceWidth,
  sourceHeight,
  nativeResolution = false,
  rampGuard = false,
}: {
  preset: ScreenPreset;
  maxFps: ScreenFps;
  activity: ScreenActivity;
  sourceWidth?: number;
  sourceHeight?: number;
  nativeResolution?: boolean;
  rampGuard?: boolean;
}): ScreenEncodingPlan {
  const definition = SCREEN_PRESETS[preset];
  const width = positiveDimension(sourceWidth, definition.width);
  const height = positiveDimension(sourceHeight, definition.height);
  const scaleResolutionDownBy = nativeResolution
    ? 1
    : Math.max(1, width / definition.width, height / definition.height);
  const profile = screenEncodingProfile(maxFps, activity);

  return {
    preset,
    nativeResolution,
    sourceWidth: width,
    sourceHeight: height,
    outputWidth: nativeResolution ? Math.round(width) : evenFloor(width / scaleResolutionDownBy),
    outputHeight: nativeResolution ? Math.round(height) : evenFloor(height / scaleResolutionDownBy),
    scaleResolutionDownBy,
    fps: profile.fps,
    contentHint: activity === 'motion' ? 'motion' : 'detail',
    degradationPreference:
      !nativeResolution && activity === 'motion' && !rampGuard
        ? 'maintain-framerate'
        : 'maintain-resolution',
  };
}

/**
 * RTC stats 中的实际编码尺寸允许有极小的偶数对齐误差，但不能越过档位计划。
 * 缺少统计样本时返回 null，避免把“尚未采样”误报成缩放失败。
 */
export function isScreenEncodingWithinPlan(
  actualWidth: number | null | undefined,
  actualHeight: number | null | undefined,
  plan: ScreenEncodingPlan | null | undefined,
  tolerance = 4,
): boolean | null {
  if (!plan || !actualWidth || !actualHeight) return null;
  return (
    actualWidth <= plan.outputWidth + tolerance && actualHeight <= plan.outputHeight + tolerance
  );
}

export function screenEncodingPlanLabel(withinPlan: boolean | null): string {
  return withinPlan == null ? '未知' : withinPlan ? '正常' : '超过档位';
}

/** 显式设置 200 Mbps 上限，实际速率仍由编码器和拥塞控制决定。 */
export function toScreenRtpEncoding(plan: ScreenEncodingPlan): ScreenRtpEncodingParameters {
  return {
    maxBitrate: SCREEN_MAX_BITRATE_BPS,
    maxFramerate: plan.fps,
    scaleResolutionDownBy: plan.scaleResolutionDownBy,
  };
}

/** 调档时覆盖旧上限，保留 transactionId、RID 与 active 等发送参数。 */
export function withScreenEncodingPlan(
  parameters: RTCRtpSendParameters,
  plan: ScreenEncodingPlan,
): RTCRtpSendParameters {
  return {
    ...parameters,
    encodings: parameters.encodings.map((encoding) => {
      return { ...encoding, ...toScreenRtpEncoding(plan) };
    }),
    degradationPreference: plan.degradationPreference,
  };
}
