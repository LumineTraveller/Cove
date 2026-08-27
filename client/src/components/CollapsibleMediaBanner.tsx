import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AudioLines, ChevronLeft, MonitorPlay } from 'lucide-react';

export function CollapsibleMediaBanner({ kind, children }: {
  kind: 'screen' | 'audio';
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const tabRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const isAudio = kind === 'audio';
  const label = isAudio ? '共享音频提示' : '屏幕共享提示';

  useLayoutEffect(() => {
    panelRef.current?.toggleAttribute('inert', collapsed);
    if (collapsed) tabRef.current?.focus();
  }, [collapsed]);

  return (
    // 保留原行高度，半圆始终与自己的横幅中心对齐，其它横幅不会上下跳动。
    <div className={`cove-media-banner relative mt-4 flex-shrink-0 ${collapsed ? 'is-collapsed' : ''}`} data-kind={kind}>
      <div
        ref={panelRef}
        aria-hidden={collapsed}
        className={`cove-media-banner-panel mx-5 flex min-w-0 items-center gap-3 rounded-2xl border px-4 py-3 text-sm ${isAudio
          ? 'border-violet-300/20 bg-violet-300/[0.07] text-violet-50/85'
          : 'border-cyan-300/25 bg-gradient-to-r from-cyan-300/15 via-sky-400/10 to-transparent text-cyan-50/85'}`}
      >
        {children}
        <button
          ref={collapseRef}
          onClick={() => { collapseRef.current?.blur(); setCollapsed(true); }}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-xl bg-black/20 px-3 py-2 text-xs font-semibold transition hover:bg-black/35 hover:text-white"
          title={`收回${label}`}
          aria-label={`收回${label}`}
        ><ChevronLeft size={15} />收回</button>
      </div>
      <button
        ref={tabRef}
        onClick={() => {
          setCollapsed(false);
          // 恢复焦点需等 inert 被移除。
          requestAnimationFrame(() => collapseRef.current?.focus());
        }}
        className={`cove-media-banner-tab absolute left-0 top-1/2 z-10 flex h-14 w-8 items-center justify-center rounded-r-full border border-l-0 shadow-lg backdrop-blur-md hover:w-10 ${isAudio
          ? 'border-violet-300/30 bg-violet-300/25 text-violet-100 hover:bg-violet-300/35'
          : 'border-cyan-300/30 bg-cyan-300/25 text-cyan-100 hover:bg-cyan-300/35'}`}
        tabIndex={collapsed ? 0 : -1}
        aria-hidden={!collapsed}
        aria-label={`展开${label}`}
        title={`展开${label}`}
      >{isAudio ? <AudioLines size={17} /> : <MonitorPlay size={17} />}</button>
    </div>
  );
}
