import { useLayoutEffect, useState, type RefObject } from 'react';
import { sharedChatNeedsDrawer } from './sharedChatLayout';

export function useSharedChatLayout(shellRef: RefObject<HTMLDivElement>, active: boolean, sidebarOpen: boolean, mounted: boolean) {
  const [drawer, setDrawer] = useState(false);
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!active || !shell) { setDrawer(false); return; }
    const measure = () => {
      const style = getComputedStyle(shell);
      // Target CSS widths, not animated rectangles: switching presentation must
      // not change its own inputs or flip back halfway through a rail animation.
      const rail = Number.parseFloat(style.getPropertyValue('--rail-width'));
      const chat = Number.parseFloat(style.getPropertyValue('--chat-panel-width'));
      if (Number.isFinite(rail) && Number.isFinite(chat))
        setDrawer(sharedChatNeedsDrawer(shell.clientWidth, rail, chat));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    // The observer already covers viewport changes, after browser layout.
    // A second window.resize listener forced the same style/layout read early
    // in every resize frame, then repeated it in the observer callback.
    return () => observer.disconnect();
  }, [shellRef, active, sidebarOpen, mounted]);
  return active && drawer;
}
