/** Experimental opaque view of an already validated, full-desktop GPU frame.
 * This owns only the new wrapper. The existing source/import owners are unchanged.
 */
export interface NativeOpaqueFrameMetrics {
  requested: number;
  attempted: number;
  constructed: number;
  admitted: number;
  fallback: number;
  written: number;
  closed: number;
  closeFailures: number;
  active: number;
  maxActive: number;
  inputFormat: string | null;
  outputFormat: string | null;
}

export function createNativeOpaqueFrameMetrics(): NativeOpaqueFrameMetrics {
  return { requested: 0, attempted: 0, constructed: 0, admitted: 0, fallback: 0,
    written: 0, closed: 0, closeFailures: 0, active: 0, maxActive: 0,
    inputFormat: null, outputFormat: null };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown) => finite(value) && value > 0;
const dimension = (value: number) => Number.isSafeInteger(value) && value > 0;
const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
const createOpaque = (frame: VideoFrame) => new VideoFrame(frame, { alpha: 'discard', timestamp: frame.timestamp });

function matches(input: VideoFrame, candidate: VideoFrame): boolean {
  const duration = input.duration;
  const sameDuration = duration === null ? candidate.duration === null :
    finite(duration) && duration >= 0 && candidate.duration === duration;
  if (candidate === input || candidate.format !== 'BGRX' || !finite(input.timestamp) ||
      candidate.timestamp !== input.timestamp || !sameDuration ||
      !dimension(input.codedWidth) || candidate.codedWidth !== input.codedWidth ||
      !dimension(input.codedHeight) || candidate.codedHeight !== input.codedHeight ||
      !dimension(input.displayWidth) || candidate.displayWidth !== input.displayWidth ||
      !dimension(input.displayHeight) || candidate.displayHeight !== input.displayHeight) return false;
  const a = input.visibleRect, b = candidate.visibleRect;
  if (!a || !b || !finite(a.x) || a.x < 0 || !finite(a.y) || a.y < 0 ||
      !positive(a.width) || !positive(a.height) || a.x + a.width > input.codedWidth ||
      a.y + a.height > input.codedHeight || a.x !== b.x || a.y !== b.y ||
      a.width !== b.width || a.height !== b.height) return false;
  const x = input.colorSpace, y = candidate.colorSpace;
  return Boolean(x && y && typeof x.primaries === 'string' && x.primaries.length > 0 &&
    typeof x.transfer === 'string' && x.transfer.length > 0 &&
    typeof x.matrix === 'string' && x.matrix.length > 0 &&
    typeof x.fullRange === 'boolean' && x.primaries === y.primaries &&
    x.transfer === y.transfer && x.matrix === y.matrix && x.fullRange === y.fullRange);
}

function closeOwned(frame: VideoFrame | undefined, metrics: NativeOpaqueFrameMetrics) {
  if (!frame) return;
  try {
    frame.close();
    metrics.closed = increment(metrics.closed);
    metrics.active--;
  } catch {
    metrics.closeFailures = increment(metrics.closeFailures);
    // An unsuccessful close is not evidence of released resources.
  }
}

/** Call only at actual queue dispatch and pass the captured writer's real promise.
 * Construction/validation may fall back. A write attempt is never retried.
 */
export async function writeOpaqueDesktopFrame(
  input: VideoFrame,
  write: (frame: VideoFrame) => PromiseLike<void>,
  metrics: NativeOpaqueFrameMetrics,
  create: (frame: VideoFrame) => VideoFrame = createOpaque,
): Promise<void> {
  metrics.requested = increment(metrics.requested);
  let owned: VideoFrame | undefined, usable = false;
  try {
    const format = input.format;
    if (metrics.inputFormat === null && (format === 'BGRA' || format === 'BGRX' ||
        format === 'RGBA' || format === 'RGBX' || format === 'NV12' || format === 'I420')) metrics.inputFormat = format;
    if (format === 'BGRA' && finite(input.timestamp)) {
      metrics.attempted = increment(metrics.attempted);
      const candidate = create(input);
      if (candidate !== input) {
        owned = candidate;
        metrics.constructed = increment(metrics.constructed);
        metrics.active = increment(metrics.active);
        metrics.maxActive = Math.max(metrics.maxActive, metrics.active);
        const output = candidate.format;
        if (metrics.outputFormat === null && (output === 'BGRA' || output === 'BGRX' ||
            output === 'RGBA' || output === 'RGBX' || output === 'NV12' || output === 'I420')) metrics.outputFormat = output;
        usable = matches(input, candidate);
      }
    }
  } catch { /* Unknown construction/metadata retains the existing input route. */ }
  if (!usable) {
    closeOwned(owned, metrics);
    metrics.fallback = increment(metrics.fallback);
    await write(input);
    return;
  }
  metrics.admitted = increment(metrics.admitted);
  try {
    await write(owned!);
    metrics.written = increment(metrics.written);
  } finally {
    // queue.stop may have settled submit early. Only the actual write owns this close.
    closeOwned(owned, metrics);
  }
}
