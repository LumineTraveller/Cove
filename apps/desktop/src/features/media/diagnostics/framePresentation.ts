import { createFrameIntervalWindow, type FrameStabilitySnapshot } from './frameIntervals';

type PresentationReader = (nowMs: number) => FrameStabilitySnapshot | null;
const presentations = new WeakMap<MediaStreamTrack, Set<PresentationReader>>();

/** Reads only an unambiguous observation of this exact track's existing video. */
export function readFramePresentation(
  track: MediaStreamTrack,
  nowMs = performance.now(),
): FrameStabilitySnapshot | null {
  const readers = presentations.get(track);
  if (!readers || readers.size !== 1) return null;
  const snapshot = readers.values().next().value?.(nowMs) ?? null;
  // Reading reconciles source changes; never return the replacement track's data.
  return presentations.get(track) === readers && readers.size === 1 ? snapshot : null;
}

/** Optional compositor observation. Never owns playback, tracks, or video frames. */
export function bindFramePresentation(video: HTMLVideoElement, stream: MediaStream): () => void {
  if (typeof video.requestVideoFrameCallback !== 'function' ||
      typeof video.cancelVideoFrameCallback !== 'function') return () => {};
  const ownerDocument = video.ownerDocument;
  if (!ownerDocument) return () => {};
  const intervals = createFrameIntervalWindow();
  let disposed = false;
  let selectedTrack: MediaStreamTrack | null = null;
  let callbackId: number | undefined;
  let generation = 0;
  let observing = false;
  let previousFrames: number | null = null;
  let previousPresentation: number | null = null;

  const firstTrack = () => stream.getVideoTracks()[0] ?? null;
  const eligible = () => !disposed && selectedTrack?.readyState === 'live' &&
    video.srcObject === stream && !video.paused && !video.ended &&
    (!ownerDocument.hidden || ownerDocument.pictureInPictureElement === video);

  function reset() {
    intervals.reset();
    previousFrames = null;
    previousPresentation = null;
  }
  function cancel() {
    generation++;
    const pending = callbackId;
    callbackId = undefined;
    if (pending !== undefined) {
      try { video.cancelVideoFrameCallback(pending); } catch { /* Late callbacks remain inert. */ }
    }
  }
  function removeTrack() {
    if (!selectedTrack) return;
    selectedTrack.removeEventListener('ended', reconcile);
    const readers = presentations.get(selectedTrack);
    readers?.delete(read);
    if (readers?.size === 0) presentations.delete(selectedTrack);
    selectedTrack = null;
  }
  function read(nowMs: number) {
    reconcile();
    return eligible() ? intervals.snapshot(nowMs) : null;
  }
  function schedule() {
    if (callbackId !== undefined || !eligible()) return;
    const ownedGeneration = generation;
    try {
      callbackId = video.requestVideoFrameCallback((_now, metadata) => {
        if (disposed || ownedGeneration !== generation) return;
        callbackId = undefined;
        if (!eligible() || firstTrack() !== selectedTrack) { reconcile(); return; }
        const timestamp = metadata.presentationTime;
        const frames = metadata.presentedFrames;
        if (!Number.isFinite(timestamp) || timestamp < 0 || !Number.isSafeInteger(frames) || frames < 0) {
          reset();
        } else {
          if ((previousFrames !== null && frames <= previousFrames) ||
              (previousPresentation !== null && timestamp <= previousPresentation)) reset();
          const missed = previousFrames === null ? 0 : Math.max(0, frames - previousFrames - 1);
          intervals.observe(timestamp, performance.now(), missed);
          previousFrames = frames;
          previousPresentation = timestamp;
        }
        schedule();
      });
    } catch {
      // Diagnostic support failures must not alter the existing playback path.
      dispose();
    }
  }
  function reconcile() {
    if (disposed) return;
    const next = firstTrack();
    const liveTrack = next?.readyState === 'live' ? next : null;
    if (liveTrack !== selectedTrack) {
      cancel(); reset(); observing = false; removeTrack();
      selectedTrack = liveTrack;
      if (selectedTrack) {
        const readers = presentations.get(selectedTrack) ?? new Set<PresentationReader>();
        readers.add(read);
        presentations.set(selectedTrack, readers);
        selectedTrack.addEventListener('ended', reconcile);
      }
    }
    if (!eligible()) {
      if (observing || callbackId !== undefined) { cancel(); reset(); }
      observing = false;
      return;
    }
    if (!observing) { reset(); observing = true; }
    schedule();
  }
  const videoEvents = ['playing', 'pause', 'ended', 'emptied', 'loadedmetadata',
    'enterpictureinpicture', 'leavepictureinpicture'] as const;
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancel(); reset(); removeTrack();
    ownerDocument.removeEventListener('visibilitychange', reconcile);
    for (const event of videoEvents) video.removeEventListener(event, reconcile);
    stream.removeEventListener('addtrack', reconcile);
    stream.removeEventListener('removetrack', reconcile);
  }
  ownerDocument.addEventListener('visibilitychange', reconcile);
  for (const event of videoEvents) video.addEventListener(event, reconcile);
  stream.addEventListener('addtrack', reconcile);
  stream.addEventListener('removetrack', reconcile);
  reconcile();
  return dispose;
}
