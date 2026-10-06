/** Watch the first decoded/presented frame, never a timer or metadata alone. */
export function observeScreenVideoFrame(video: HTMLVideoElement, onReady: () => void) {
  let disposed = false;
  let ready = false;
  let frameId: number | null = null;
  const hasFrameCallback = typeof video.requestVideoFrameCallback === 'function';
  const finish = () => {
    if (disposed || ready) return;
    ready = true;
    onReady();
  };
  const checkDecodedFrame = () => {
    // Older engines have no presentation callback. HAVE_CURRENT_DATA and real
    // dimensions are the minimum proof that a frame can be painted.
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) finish();
  };
  if (hasFrameCallback) {
    frameId = video.requestVideoFrameCallback(() => {
      frameId = null;
      finish();
    });
  } else {
    video.addEventListener('loadeddata', checkDecodedFrame);
    video.addEventListener('playing', checkDecodedFrame);
    checkDecodedFrame();
  }
  return () => {
    disposed = true;
    if (frameId !== null) video.cancelVideoFrameCallback(frameId);
    video.removeEventListener('loadeddata', checkDecodedFrame);
    video.removeEventListener('playing', checkDecodedFrame);
  };
}
