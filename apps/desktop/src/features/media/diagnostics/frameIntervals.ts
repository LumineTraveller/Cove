export interface FrameStabilitySnapshot {
  lowFps: number | null;
  sampleCount: number;
  slowFrameCount: number;
  windowMs: number;
  /** Sum of retained actual frame intervals; a recovered long stall is not capped. */
  observedMs: number;
  lastFrameAgeMs: number | null;
  missedFrames: number;
  status: 'sampling' | 'ready' | 'stalled' | 'incomplete';
  capacityLimited: boolean;
}

export interface FrameIntervalWindowOptions {
  windowMs?: number;
  capacity?: number;
  minSamples?: number;
  staleAfterMs?: number;
}

export interface FrameIntervalWindow {
  observe(timestampMs: number, observedAtMs: number, missedFrames?: number): void;
  snapshot(nowMs: number): FrameStabilitySnapshot;
  reset(): void;
}

const MAX_CAPACITY = 65_536;
const MAX_MISSED_FRAMES = 0xffff_ffff;

/**
 * Per-frame numeric observations only. The frame clock may have a different
 * origin from observedAtMs/nowMs, which must share one monotonic local clock.
 * The 1% low is 1000 / mean(slowest ceil(N / 100) actual frame intervals).
 * It is not a percentile of once-per-second FPS or an average of FPS values.
 */
export function createFrameIntervalWindow(
  options: FrameIntervalWindowOptions = {},
): FrameIntervalWindow {
  const windowMs = options.windowMs ?? 30_000;
  const capacity = options.capacity ?? 8_192;
  const minSamples = options.minSamples ?? 100;
  const staleAfterMs = options.staleAfterMs ?? 1_000;
  if (!Number.isFinite(windowMs) || windowMs <= 0 ||
      !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY ||
      !Number.isInteger(minSamples) || minSamples < 1 || minSamples > capacity ||
      !Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new RangeError('Invalid frame interval window options');
  }

  const durations = new Float64Array(capacity);
  const observedEnds = new Float64Array(capacity);
  const missed = new Float64Array(capacity);
  let head = 0;
  let count = 0;
  let previousTimestamp: number | null = null;
  let previousObservedAt: number | null = null;
  let lastDiscardedEnd = Number.NEGATIVE_INFINITY;

  function reset() {
    head = 0;
    count = 0;
    previousTimestamp = null;
    previousObservedAt = null;
    lastDiscardedEnd = Number.NEGATIVE_INFINITY;
  }

  const validTime = (value: number) => Number.isFinite(value) &&
    value >= 0 && value <= Number.MAX_SAFE_INTEGER;

  function observe(timestampMs: number, observedAtMs: number, missedFrames = 0) {
    if (!validTime(timestampMs) || !validTime(observedAtMs)) {
      reset();
      return;
    }
    if (!Number.isInteger(missedFrames) || missedFrames < 0 || missedFrames > MAX_MISSED_FRAMES ||
        (previousTimestamp !== null && timestampMs <= previousTimestamp) ||
        (previousObservedAt !== null && observedAtMs < previousObservedAt)) {
      // A reset clock/duplicate frame cannot create a zero interval or FPS spike.
      reset();
    }
    if (previousTimestamp !== null) {
      if (count === capacity) {
        // A read may be less frequent than frames. Keep observation O(1), and
        // disclose overwritten coverage until that missing interval expires.
        if (observedEnds[head] > observedAtMs - windowMs)
          lastDiscardedEnd = Math.max(lastDiscardedEnd, observedEnds[head]);
        head = (head + 1) % capacity;
        count--;
      }
      const index = (head + count) % capacity;
      durations[index] = timestampMs - previousTimestamp;
      observedEnds[index] = observedAtMs;
      missed[index] = missedFrames;
      count++;
    }
    previousTimestamp = timestampMs;
    previousObservedAt = observedAtMs;
  }

  function snapshot(nowMs: number): FrameStabilitySnapshot {
    if (!validTime(nowMs) || (previousObservedAt !== null && nowMs < previousObservedAt))
      reset();
    const cutoff = nowMs - windowMs;
    // Expiration and sorting are confined to the low-frequency reader.
    while (count > 0 && observedEnds[head] <= cutoff) {
      head = (head + 1) % capacity;
      count--;
    }
    const capacityLimited = lastDiscardedEnd > cutoff;
    let observedMs = 0;
    let missedFrames = 0;
    for (let offset = 0; offset < count; offset++) {
      const index = (head + offset) % capacity;
      observedMs += durations[index];
      missedFrames += missed[index];
    }
    const lastFrameAgeMs = previousObservedAt === null ? null : nowMs - previousObservedAt;
    const status: FrameStabilitySnapshot['status'] =
      lastFrameAgeMs !== null && lastFrameAgeMs >= staleAfterMs ? 'stalled' :
      capacityLimited || missedFrames > 0 ? 'incomplete' :
      count < minSamples ? 'sampling' : 'ready';
    const slowFrameCount = Math.ceil(count / 100);
    let lowFps: number | null = null;
    if (status === 'ready') {
      const sorted = new Float64Array(count);
      for (let offset = 0; offset < count; offset++)
        sorted[offset] = durations[(head + offset) % capacity];
      sorted.sort();
      let slowTotalMs = 0;
      for (let offset = 0; offset < slowFrameCount; offset++)
        slowTotalMs += sorted[count - 1 - offset];
      lowFps = 1_000 / (slowTotalMs / slowFrameCount);
    }
    return {
      lowFps, sampleCount: count, slowFrameCount, windowMs, observedMs,
      lastFrameAgeMs, missedFrames, status, capacityLimited,
    };
  }

  return { observe, snapshot, reset };
}
