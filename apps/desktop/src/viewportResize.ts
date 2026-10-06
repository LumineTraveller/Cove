const VIEWPORT_RESIZE_CLASS = 'viewport-resizing';
const RESIZE_SETTLE_DELAY_MS = 120;

/**
 * Temporarily marks native viewport resizing so viewport-bound shell tracks
 * follow every resize frame instead of restarting their intentional layout
 * animations for each frame.
 */
export function installViewportResizeState(): () => void {
  let settleTimer: number | undefined;
  let nativeResizeActive = false;

  const markResizing = () => {
    const root = document.documentElement;
    if (!root.classList.contains(VIEWPORT_RESIZE_CLASS)) root.classList.add(VIEWPORT_RESIZE_CLASS);
    if (settleTimer !== undefined) window.clearTimeout(settleTimer);
    settleTimer = undefined;
  };
  const settle = () => {
    if (settleTimer !== undefined) window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      settleTimer = undefined;
      if (!nativeResizeActive) document.documentElement.classList.remove(VIEWPORT_RESIZE_CLASS);
    }, RESIZE_SETTLE_DELAY_MS);
  };

  const handleResize = () => {
    markResizing();
    if (!nativeResizeActive) settle();
  };

  // The native gesture starts before new viewport dimensions arrive. Keep
  // lightweight rendering enabled even when the user briefly pauses the drag.
  // Browser / old preload builds retain the ordinary resize-event fallback.
  const unsubscribeNative = window.coveWindow?.onResize?.(active => {
    nativeResizeActive = active;
    if (active) markResizing();
    else settle();
  });

  window.addEventListener('resize', handleResize, { passive: true });

  return () => {
    unsubscribeNative?.();
    window.removeEventListener('resize', handleResize);
    if (settleTimer !== undefined) window.clearTimeout(settleTimer);
    document.documentElement.classList.remove(VIEWPORT_RESIZE_CLASS);
  };
}
