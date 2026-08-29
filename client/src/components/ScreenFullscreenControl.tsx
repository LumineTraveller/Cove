import { useEffect, useId, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';

export function ScreenFullscreenControl({ maximized, nativeFullscreen, onToggleWindow, onToggleNative, allowNativeFullscreen = true }: {
  maximized: boolean;
  nativeFullscreen: boolean;
  onToggleWindow: () => void;
  onToggleNative: () => void;
  allowNativeFullscreen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const trigger = useRef<HTMLButtonElement>(null);
  const nativeButton = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const cancelClose = () => { clearTimeout(timer.current); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    clearTimeout(timer.current);
    setOpen(false);
  }, [nativeFullscreen]);

  // 系统全屏中只有退出操作，不再渲染菜单，也不能再切换底下的 CSS 窗口全屏。
  if (nativeFullscreen) {
    return (
      <div className="absolute right-3 top-3 z-10">
        <button
          ref={trigger}
          onClick={onToggleNative}
          className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-1.5 text-sm font-medium text-white backdrop-blur-md transition-colors hover:bg-black/50"
          aria-label="退出全屏"
          title="退出全屏"
        ><Minimize2 size={16} />退出全屏</button>
      </div>
    );
  }

  return (
    <div
      className="absolute right-3 top-3 z-10"
      onMouseEnter={() => { cancelClose(); if (allowNativeFullscreen) setOpen(true); }}
      onMouseLeave={() => { cancelClose(); timer.current = setTimeout(() => setOpen(false), 160); }}
      onFocusCapture={() => { cancelClose(); if (allowNativeFullscreen) setOpen(true); }}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { cancelClose(); setOpen(false); }
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          trigger.current?.focus();
          cancelClose();
          setOpen(false);
        }
        if (event.key === 'ArrowDown' && allowNativeFullscreen) {
          event.preventDefault();
          setOpen(true);
          requestAnimationFrame(() => nativeButton.current?.focus());
        }
      }}
    >
      <button
        ref={trigger}
        onClick={onToggleWindow}
        className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-1.5 text-sm font-medium text-white backdrop-blur-md transition-colors hover:bg-black/50"
        aria-label={maximized ? '退出窗口全屏' : '窗口全屏'}
        aria-expanded={allowNativeFullscreen ? open : undefined}
        aria-controls={allowNativeFullscreen ? menuId : undefined}
      >{maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}{maximized ? '退出全屏' : '全屏'}</button>
      {allowNativeFullscreen && (
        <>
          {/* 间距由可悬停的 padding 提供；margin 会留下触发 mouseleave 的空洞。 */}
          <div id={menuId} className={`absolute right-0 top-full w-44 pt-1.5 ${open ? '' : 'hidden'}`}>
            <div className="rounded-xl border border-white/15 bg-zinc-900/80 p-1.5 shadow-2xl backdrop-blur-xl">
              <button
                ref={nativeButton}
                onClick={() => { cancelClose(); setOpen(false); onToggleNative(); }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-white/80 transition hover:bg-white/10 hover:text-white"
                aria-pressed={false}
              ><Maximize2 size={15} />完全全屏</button>
              <p className="px-3 pb-1 pt-1 text-[11px] leading-relaxed text-white/35">覆盖整个显示器，按 Esc 退出</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
