import type { FrameStabilitySnapshot } from './frameIntervals';

export const FRAME_STABILITY_DEFINITION = Object.freeze({
  windowMs: 30_000,
  minimumIntervals: 100,
  formula: '1000 / mean(slowest ceil(intervalCount * 0.01) frame intervals in ms)',
  nativeDelivery: 'Validated native helper output timestamps; not raw DXGI acquisition or encode/send timing.',
  presentation: 'Existing video compositor submission timestamps; not physical display scan-out. Missing callbacks are not reconstructed.',
  availability: 'Statistics must be enabled. Hidden/non-PiP or paused video resets presentation sampling. Stalls keep the real recovery gap. Missed callbacks produce an observed-interval estimate; stale or capacity-limited samples have no value.',
});

export function frameStabilityLabel(sample: FrameStabilitySnapshot | null | undefined): string {
  if (!sample) return '—';
  if (sample.status === 'stalled') return '暂无新帧';
  if (sample.capacityLimited) return '采样容量已满';
  if (sample.lowFps == null || !Number.isFinite(sample.lowFps))
    return `采样中 ${sample.sampleCount}/100`;
  return `${sample.status === 'incomplete' ? '≈' : ''}${sample.lowFps.toFixed(1)} fps`;
}

export function frameStabilityDetail(sample: FrameStabilitySnapshot | null | undefined): string {
  const definition = '最近30秒，至少100个帧间隔；取最慢1%间隔的平均耗时，再换算为fps。';
  if (!sample) return `${definition}当前轨道没有可用的逐帧观测。`;
  return `${definition}已记录${sample.sampleCount}个间隔，漏采${sample.missedFrames}帧。${
    sample.capacityLimited ? '采样容量已满。' : sample.missedFrames > 0 ? '≈表示按已观测间隔计算的估计值。' : ''
  }`;
}
