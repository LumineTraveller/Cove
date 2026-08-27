import { useCallback, useEffect, useRef, useState } from 'react';

/** Window maximization and Fullscreen API share a single exit back to the room layout. */
export function useScreenFullscreen(active: boolean) {
  const screenContainerRef = useRef<HTMLDivElement>(null);
  const nativeElementRef = useRef<Element | null>(null);
  const [screenMaximized, setScreenMaximized] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);

  const exitFullscreen = useCallback(async () => {
    setScreenMaximized(false);
    const element = document.fullscreenElement;
    if (element && (element === screenContainerRef.current || element === nativeElementRef.current)) {
      await document.exitFullscreen();
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (nativeElementRef.current) {
      void exitFullscreen().catch(error => console.warn('[screen] 退出全屏失败', error));
    } else {
      setScreenMaximized(value => !value);
    }
  }, [exitFullscreen]);

  const toggleNativeFullscreen = useCallback(async () => {
    const element = screenContainerRef.current;
    if (!element) return;
    try {
      if (document.fullscreenElement === element) {
        await exitFullscreen();
        return;
      }
      if (document.fullscreenElement) await document.exitFullscreen();
      if (!element.requestFullscreen) {
        window.alert('当前环境不支持完全全屏，请使用窗口全屏。');
        return;
      }
      await element.requestFullscreen();
    } catch (error) {
      console.warn('[screen] 无法切换完全全屏', error);
      window.alert('无法切换完全全屏，请检查窗口权限或使用窗口全屏。');
    }
  }, [exitFullscreen]);

  useEffect(() => {
    const onChange = () => {
      const element = document.fullscreenElement;
      const ownFullscreen = element !== null && element === screenContainerRef.current;
      // Esc、按钮退出、共享结束都清除底层 CSS 全屏，避免退出后仍然铺满窗口。
      if (nativeElementRef.current && !ownFullscreen) setScreenMaximized(false);
      nativeElementRef.current = ownFullscreen ? element : null;
      setNativeFullscreen(ownFullscreen);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.fullscreenElement) setScreenMaximized(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      window.removeEventListener('keydown', onKey);
      if (nativeElementRef.current && document.fullscreenElement === nativeElementRef.current) {
        void document.exitFullscreen().catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    if (!active) void exitFullscreen().catch(error => console.warn('[screen] 共享结束时退出全屏失败', error));
  }, [active, exitFullscreen]);

  return { screenContainerRef, screenMaximized, nativeFullscreen, toggleFullscreen, toggleNativeFullscreen };
}
