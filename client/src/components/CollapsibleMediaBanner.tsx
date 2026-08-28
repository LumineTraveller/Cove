import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AudioLines, ChevronLeft, EyeOff, MonitorPlay } from 'lucide-react';

export function CollapsibleMediaBanner({ kind, children, overlay = false, defaultCollapsed = false }: {
  kind: 'screen' | 'audio';
  children: ReactNode;
  overlay?: boolean;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const tabRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const focusTabRef = useRef(false);
  const isAudio = kind === 'audio';
  const label = isAudio ? '共享音频提示' : '屏幕共享提示';

  useLayoutEffect(() => {
    panelRef.current?.toggleAttribute('inert', collapsed);
    // 自动收起时不抢走视频或全屏控件的焦点，仅响应用户主动收回。
    if (collapsed && focusTabRef.current) tabRef.current?.focus();
    focusTabRef.current = false;
  }, [collapsed]);

  return (
    // 观看时绝对定位在视频内，展开/收回都不占布局高度；其余横幅保留原行高度。
    <div className={`cove-media-banner ${overlay ? 'pointer-events-none absolute inset-x-0 top-14 z-20' : 'relative mt-4 flex-shrink-0'} ${collapsed ? 'is-collapsed' : ''}`} data-kind={kind} data-overlay={overlay}>
      <div
        id={panelId}
        ref={panelRef}
        aria-hidden={collapsed}
        className={`cove-media-banner-panel mx-5 flex min-w-0 items-center gap-3 rounded-2xl border px-4 py-3 text-sm ${overlay ? 'pointer-events-auto bg-zinc-950/90 shadow-xl backdrop-blur-xl' : ''} ${isAudio
          ? 'border-violet-300/20 bg-violet-300/[0.07] text-violet-50/85'
          : 'border-cyan-300/25 bg-gradient-to-r from-cyan-300/15 via-sky-400/10 to-transparent text-cyan-50/85'}`}
      >
        {children}
        <button
          ref={collapseRef}
          onClick={() => { focusTabRef.current = true; setCollapsed(true); }}
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
        aria-expanded={!collapsed}
        aria-controls={panelId}
        aria-hidden={!collapsed}
        aria-label={`展开${label}`}
        title={`展开${label}`}
      >{isAudio ? <AudioLines size={17} /> : <MonitorPlay size={17} />}</button>
    </div>
  );
}

/** 只描述当前观看的共享，随观看会话挂载，默认收回到视频左侧。 */
export function WatchingScreenBanner({ sharer, onStopWatching }: {
  sharer: string;
  onStopWatching: () => void;
}) {
  return (
    <CollapsibleMediaBanner kind="screen" overlay defaultCollapsed>
      <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-cyan-200 text-zinc-900"><MonitorPlay size={20} /></span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-white" title={sharer}>正在观看 {sharer} 的屏幕共享</p>
        <p className="mt-0.5 text-xs text-cyan-50/50">停止观看后可选择其他共享</p>
      </div>
      <button onClick={onStopWatching} className="inline-flex flex-shrink-0 items-center gap-2 rounded-xl bg-red-500/15 px-3 py-2 text-xs font-semibold text-red-100 transition hover:bg-red-500/25">
        <EyeOff size={16} />停止观看
      </button>
    </CollapsibleMediaBanner>
  );
}
