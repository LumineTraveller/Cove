export const SCREEN_PRESETS = {
  '540p':  { label: '540p 流畅',  width: 960,  height: 540 },
  '720p':  { label: '720p 均衡',  width: 1280, height: 720 },
  '1080p': { label: '1080p 清晰', width: 1920, height: 1080 },
  '1440p': { label: '1440p 2K',   width: 2560, height: 1440 },
} as const;

export type ScreenPreset = keyof typeof SCREEN_PRESETS;
export type ScreenFps = 30 | 60;
export type ScreenActivity = 'static' | 'active' | 'motion';

export interface ScreenCaptureConstraintOptions {
  fps: number;
  strictFrameRate: boolean;
}

export interface AppliedScreenCaptureConstraints {
  mode: 'strict' | 'preferred';
  constraints: MediaTrackConstraints;
  strictError?: unknown;
}

export interface ScreenEncodingPlan {
  preset: ScreenPreset;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  scaleResolutionDownBy: number;
  fps: number;
  contentHint: 'detail' | 'motion';
  degradationPreference: RTCDegradationPreference;
}

export interface ScreenRtpEncodingParameters {
  maxFramerate: number;
  scaleResolutionDownBy: number;
}

export function screenEncodingProfile(
  maxFps: ScreenFps,
  activity: ScreenActivity,
) {
  if (activity === 'static') return { fps: 15 };
  if (activity === 'motion' && maxFps === 60)
    return { fps: 60 };
  return { fps: 30 };
}

function positiveDimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
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
}: {
  preset: ScreenPreset;
  maxFps: ScreenFps;
  activity: ScreenActivity;
  sourceWidth?: number;
  sourceHeight?: number;
}): ScreenEncodingPlan {
  const definition = SCREEN_PRESETS[preset];
  const width = positiveDimension(sourceWidth, definition.width);
  const height = positiveDimension(sourceHeight, definition.height);
  const scaleResolutionDownBy = Math.max(1, width / definition.width, height / definition.height);
  const profile = screenEncodingProfile(maxFps, activity);

  return {
    preset,
    sourceWidth: width,
    sourceHeight: height,
    outputWidth: evenFloor(width / scaleResolutionDownBy),
    outputHeight: evenFloor(height / scaleResolutionDownBy),
    scaleResolutionDownBy,
    fps: profile.fps,
    contentHint: activity === 'motion' ? 'motion' : 'detail',
    degradationPreference: activity === 'motion' ? 'maintain-framerate' : 'maintain-resolution',
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
  return actualWidth <= plan.outputWidth + tolerance
    && actualHeight <= plan.outputHeight + tolerance;
}

/** 只约束帧率和尺寸，不设置应用层码率上限；实际速率由编码器和拥塞控制决定。 */
export function toScreenRtpEncoding(
  plan: ScreenEncodingPlan,
): ScreenRtpEncodingParameters {
  return {
    maxFramerate: plan.fps,
    scaleResolutionDownBy: plan.scaleResolutionDownBy,
  };
}

/** 调档时清除旧会话残留的码率上限，并保留 transactionId、RID 等发送参数。 */
export function withScreenEncodingPlan(
  parameters: RTCRtpSendParameters,
  plan: ScreenEncodingPlan,
): RTCRtpSendParameters {
  return {
    ...parameters,
    encodings: parameters.encodings.map(encoding => {
      const next = { ...encoding, ...toScreenRtpEncoding(plan) };
      delete next.maxBitrate;
      return next;
    }),
    degradationPreference: plan.degradationPreference,
  };
}

export function buildScreenCaptureConstraints(
  options: ScreenCaptureConstraintOptions,
  strict = options.strictFrameRate,
): MediaTrackConstraints {
  return {
    frameRate: strict
      ? { min: Math.max(1, options.fps - 5), ideal: options.fps, max: options.fps }
      : { ideal: options.fps, max: options.fps },
  };
}

/**
 * getDisplayMedia() 不能在选择屏幕前使用 min/exact，但选择完成后的轨道可以
 * 尝试严格帧率约束。分辨率不在这里处理：Chromium 的桌面轨道经常保持原生
 * 尺寸，实际传输尺寸由 RTCRtpSender.scaleResolutionDownBy 统一控制。
 */
export async function applyScreenCaptureConstraints(
  track: MediaStreamTrack,
  options: ScreenCaptureConstraintOptions,
): Promise<AppliedScreenCaptureConstraints> {
  const preferred = buildScreenCaptureConstraints(options, false);
  if (!options.strictFrameRate) {
    await track.applyConstraints(preferred);
    return { mode: 'preferred', constraints: preferred };
  }

  const strict = buildScreenCaptureConstraints(options, true);
  try {
    await track.applyConstraints(strict);
    return { mode: 'strict', constraints: strict };
  } catch (strictError) {
    await track.applyConstraints(preferred);
    return { mode: 'preferred', constraints: preferred, strictError };
  }
}
