import type { FrameStabilitySnapshot } from './frameIntervals';

export const FRAME_STABILITY_DEFINITION = Object.freeze({
  windowMs: 30_000,
  minimumIntervals: 100,
  formula: '1000 / mean(slowest ceil(intervalCount * 0.01) frame intervals in ms)',
  nativeDelivery: 'Validated native helper output timestamps; not raw DXGI acquisition or encode/send timing.',
  presentation: 'Existing video compositor submission timestamps; not physical display scan-out. Missing callbacks are not reconstructed.',
  availability: 'Statistics must be enabled. Hidden/non-PiP or paused video resets presentation sampling. Stalls keep the real recovery gap. Incomplete or stale samples have no low FPS value.',
});

export function frameStabilityLabel(sample: FrameStabilitySnapshot | null | undefined): string {
  if (!sample) return '—';
  if (sample.status === 'stalled') return '暂无新帧';
  if (sample.status === 'incomplete') return '采样不完整';
  if (sample.status !== 'ready' || sample.lowFps == null || !Number.isFinite(sample.lowFps))
    return '采样中';
  return `${sample.lowFps.toFixed(1)} fps`;
}

export function frameStabilityDetail(sample: FrameStabilitySnapshot | null | undefined): string {
  const definition = '最近30秒，至少100个帧间隔；取最慢1%间隔的平均耗时，再换算为fps。';
  if (!sample) return `${definition}当前轨道没有可用的逐帧观测。`;
  return `${definition}已记录${sample.sampleCount}个间隔，漏采${sample.missedFrames}帧。${
    sample.capacityLimited ? '采样容量已满，本窗口不报告估算值。' : ''
  }`;
}
