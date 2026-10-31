import type { Producer } from '../desktopMediaSupport';
import type { NativeCaptureCandidate, NativeScreenCaptureOptions } from './nativeScreenCapture';
import { SCREEN_PRESETS, type ScreenEncodingPlan, type ScreenFps } from './screenCapture';
import { nativeScreenColorSpaceForCodecs } from './nativeScreenColorPolicy';

export interface NativeScreenUpgradeQueue {
  readonly candidates: Set<MediaStream>;
  tail: Promise<void>;
}

/** A source swap must never change an encoder's existing resize contract. */
export function canUpgradeScreenCapture(
  producer: Pick<Producer, 'rtpSender'>,
  plan: ScreenEncodingPlan,
): boolean {
  const preset = SCREEN_PRESETS[plan.preset];
  if (plan.nativeResolution || plan.scaleResolutionDownBy !== 1 ||
      !Number.isFinite(plan.sourceWidth) || !Number.isFinite(plan.sourceHeight) ||
      plan.sourceWidth < 2 || plan.sourceHeight < 2 ||
      plan.sourceWidth > preset.width || plan.sourceHeight > preset.height) return false;
  try {
    const encodings = producer.rtpSender?.getParameters().encodings;
    return Boolean(encodings?.length && encodings.every(encoding => {
      const scale = encoding.scaleResolutionDownBy ?? 1;
      return Number.isFinite(scale) && scale > 0 && scale <= 1;
    }));
  } catch {
    return false;
  }
}

interface NativeScreenUpgradeOptions {
  readonly stockStream: MediaStream;
  readonly stockPlan: ScreenEncodingPlan;
  readonly maxFps: ScreenFps;
  readonly producer: Pick<Producer, 'replaceTrack' | 'rtpSender' | 'rtpParameters'>;
  readonly queue: NativeScreenUpgradeQueue;
  readonly signal: AbortSignal;
  readonly isIntentCurrent: () => boolean;
  readonly isPublicationCurrent: () => boolean;
  readonly currentStream: () => MediaStream | null;
  readonly acquire: (stock: MediaStream, options: NativeScreenCaptureOptions) => Promise<NativeCaptureCandidate | null>;
  readonly onCommit: (stream: MediaStream, track: MediaStreamTrack, width: number, height: number) => void;
  readonly stopPublication: () => void;
}

function isLive(track: MediaStreamTrack | undefined): track is MediaStreamTrack {
  return Boolean(track && track.readyState === 'live');
}

function dimensionsWithinPreset(track: MediaStreamTrack, plan: ScreenEncodingPlan) {
  const { width, height } = track.getSettings();
  const preset = SCREEN_PRESETS[plan.preset];
  if (typeof width !== 'number' || typeof height !== 'number' ||
      !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 2 || height < 2 || width > preset.width || height > preset.height) return null;
  return { width, height };
}

function candidateDimensions(track: MediaStreamTrack, stockTrack: MediaStreamTrack, plan: ScreenEncodingPlan) {
  // A display source can report provisional constraint dimensions before its
  // published sink settles. The live stock geometry is the resize contract.
  const stock = dimensionsWithinPreset(stockTrack, plan);
  const native = dimensionsWithinPreset(track, plan);
  if (!stock || !native || native.width > stock.width + 2 || native.height > stock.height + 2) return null;
  // Both paths may round an aspect-preserving resize down to even pixels.
  if (Math.abs(native.width * stock.height - native.height * stock.width) >
      2 * Math.max(stock.width, stock.height)) return null;
  return native;
}

/** Acquire outside the stock commit queue; serialize only replace and rollback. */
export async function upgradePublishedScreenCapture(options: NativeScreenUpgradeOptions): Promise<void> {
  if (options.maxFps === 30) return;
  const { stockStream, stockPlan, producer, queue, signal } = options;
  const stockTrack = stockStream.getVideoTracks()[0];
  const ownsStock = () => options.isPublicationCurrent() && options.currentStream() === stockStream;
  const current = () => !signal.aborted && options.isIntentCurrent() && ownsStock() && isLive(stockTrack);
  if (!current() || !canUpgradeScreenCapture(producer, stockPlan)) return;
  const colorSpace = nativeScreenColorSpaceForCodecs(producer.rtpParameters?.codecs);
  const colorCurrent = () => nativeScreenColorSpaceForCodecs(producer.rtpParameters?.codecs) === colorSpace;

  let candidate: NativeCaptureCandidate | null = null;
  let removeAbort = () => {};
  try {
    candidate = await options.acquire(stockStream, {
      maxWidth: stockPlan.sourceWidth,
      maxHeight: stockPlan.sourceHeight,
      fps: options.maxFps,
      ...(colorSpace ? { colorSpace } : {}),
      nativeResolution: stockPlan.nativeResolution,
      contentHint: stockTrack.contentHint === 'motion' ? 'motion' : 'detail',
      isCurrent: current,
      signal,
    });
    if (!candidate) return;
    if (!current()) { candidate.stop(); return; }
    const ready = candidate;
    queue.candidates.add(ready.stream);
    const release = () => {
      if (queue.candidates.delete(ready.stream)) ready.stop();
    };
    signal.addEventListener('abort', release, { once: true });
    removeAbort = () => signal.removeEventListener('abort', release);

    const commit = async () => {
      const nativeTrack = ready.stream.getVideoTracks()[0];
      const dimensions = nativeTrack && candidateDimensions(nativeTrack, stockTrack, stockPlan);
      if (!current() || !colorCurrent() || !isLive(nativeTrack) || !dimensions ||
          !canUpgradeScreenCapture(producer, stockPlan)) { release(); return; }
      let attached = false;
      const retireStock = () => {
        stockStream.getTracks().forEach(track => { track.onended = null; track.stop(); });
      };
      const restoreStock = async () => {
        if (!attached || !ownsStock() || !isLive(stockTrack)) return;
        try {
          await producer.replaceTrack({ track: stockTrack });
        } catch (error) {
          // An old replacement must never tear down a newer publication.
          if (ownsStock()) options.stopPublication();
          console.warn('[screen share] native upgrade rollback failed', error);
        }
      };
      try {
        nativeTrack.contentHint = stockTrack.contentHint;
        await producer.replaceTrack({ track: nativeTrack });
        attached = true;
        const committedDimensions = candidateDimensions(nativeTrack, stockTrack, stockPlan);
        if (!current() || !colorCurrent() || !isLive(nativeTrack) || !committedDimensions) { await restoreStock(); release(); return; }
        nativeTrack.onended = () => {
          if (options.isPublicationCurrent() && options.currentStream() === ready.stream)
            options.stopPublication();
        };
        if (!isLive(nativeTrack)) { await restoreStock(); release(); return; }
        ready.commit();
        if (!isLive(nativeTrack)) { await restoreStock(); release(); return; }
        // Ownership is transferred synchronously before stock is retired.
        options.onCommit(ready.stream, nativeTrack, committedDimensions.width, committedDimensions.height);
        queue.candidates.delete(ready.stream);
        removeAbort();
        retireStock();
      } catch (error) {
        // A synchronous ownership callback can fail after adopting native.
        // Do not leave an ended attached source advertised as a live share.
        if (options.isPublicationCurrent() && options.currentStream() === ready.stream) {
          // The local ref no longer owns stock, and stopTracks:false means the
          // producer cannot release it on our behalf during normal teardown.
          retireStock();
          options.stopPublication();
        } else await restoreStock();
        release();
        console.warn('[screen share] native upgrade kept stock capture', error);
      }
    };
    const update = queue.tail.then(commit);
    queue.tail = update.catch(() => {});
    await update;
  } catch (error) {
    // Native is optional; the already-published stock source remains usable.
    if (candidate && queue.candidates.delete(candidate.stream)) candidate.stop();
    console.warn('[screen share] native acquisition kept stock capture', error);
  } finally {
    removeAbort();
  }
}
