import { observeScreenVideoFrame } from './screenVideoReadiness';

export type ScreenVideoStatus = 'loading' | 'ready' | 'error';
export type ScreenVideoSizeListener = (stream: MediaStream, width: number, height: number) => void;

/** Own only the video element, not the shared capture/consumer tracks. */
export function bindScreenVideo(
  video: HTMLVideoElement,
  stream: MediaStream,
  remote: boolean,
  onStatus: (status: ScreenVideoStatus) => void,
  onSize?: ScreenVideoSizeListener,
) {
  let disposed = false;
  let retryPending = false;
  let hasPresentedFrame = false;
  const isCurrent = () => !disposed && video.srcObject === stream;
  let lastWidth = 0;
  let lastHeight = 0;
  const reportSize = () => {
    const { videoWidth: width, videoHeight: height } = video;
    if (!isCurrent() || width <= 0 || height <= 0 || (width === lastWidth && height === lastHeight)) return;
    lastWidth = width;
    lastHeight = height;
    onSize?.(stream, width, height);
  };
  onStatus('loading');
  if (onSize) {
    video.addEventListener('loadedmetadata', reportSize);
    video.addEventListener('resize', reportSize);
  }
  if (video.srcObject !== stream) video.srcObject = stream;
  const stopObserving = observeScreenVideoFrame(video, () => {
    if (!isCurrent()) return;
    hasPresentedFrame = true;
    if (onSize) reportSize();
    onStatus('ready');
  });
  const retry = () => {
    document.removeEventListener('click', retry);
    retryPending = false;
    if (!isCurrent()) return;
    // A retry on the same source may have a usable static frame already.
    // Do not await a second frame that a paused/static source need not produce.
    onStatus(hasPresentedFrame ? 'ready' : 'loading');
    play();
  };
  const play = () => {
    void video.play().catch((error: unknown) => {
      if (!isCurrent()) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.warn(`[screen-preview] ${remote ? '远程' : '本地'}共享预览播放失败`, error);
      onStatus('error');
      if (remote && !retryPending) {
        retryPending = true;
        document.addEventListener('click', retry, { once: true });
      }
    });
  };
  play();
  return {
    retry,
    dispose: () => {
      disposed = true;
      stopObserving();
      if (onSize) {
        video.removeEventListener('loadedmetadata', reportSize);
        video.removeEventListener('resize', reportSize);
      }
      document.removeEventListener('click', retry);
      if (video.srcObject === stream) {
        video.pause();
        video.srcObject = null;
      }
    },
  };
}
