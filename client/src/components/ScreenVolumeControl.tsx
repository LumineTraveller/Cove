import { useEffect, useId, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';

export function ScreenVolumeControl({ volume, onChange }: {
  volume: number;
  onChange: (volume: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const hovering = useRef(false);
  const dragging = useRef(false);
  const cancelClose = () => clearTimeout(timer.current);
  const scheduleClose = () => {
    cancelClose();
    timer.current = setTimeout(() => {
      if (!hovering.current && !dragging.current) setOpen(false);
    }, 180);
  };

  useEffect(() => {
    const finishDrag = () => {
      if (!dragging.current) return;
      dragging.current = false;
      if (!hovering.current) scheduleClose();
    };
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    return () => {
      clearTimeout(timer.current);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
    };
  }, []);

  const percent = Math.round(volume * 100);
  return (
    <div
      className="absolute bottom-3 right-3 z-10"
      onMouseEnter={() => { hovering.current = true; cancelClose(); setOpen(true); }}
      onMouseLeave={() => { hovering.current = false; scheduleClose(); }}
      onFocusCapture={() => { cancelClose(); setOpen(true); }}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !hovering.current) scheduleClose();
      }}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          trigger.current?.focus();
          cancelClose();
          setOpen(false);
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        onClick={() => { cancelClose(); setOpen(true); }}
        onKeyDown={event => {
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => slider.current?.focus());
          }
        }}
        className="flex h-10 w-10 flex-col items-center justify-center rounded-xl border border-white/10 bg-black/35 text-white/65 backdrop-blur-md transition hover:bg-black/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/50"
        aria-label="共享音量"
        aria-expanded={open}
        aria-controls={panelId}
      >
        {percent === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
      </button>
      {/* padding 连接按钮与上拉栏，鼠标向上移动时没有悬停断层。 */}
      <div id={panelId} className={`absolute bottom-full -right-2 w-14 pb-2 ${open ? '' : 'hidden'}`}>
        <div className="flex flex-col items-center rounded-xl border border-white/15 bg-zinc-950/85 py-3 text-xs text-white/75 shadow-xl backdrop-blur-xl">
          <span className="mb-2 tabular-nums text-cyan-100">{percent}%</span>
          {/* 旋转原生滑条兼容 Electron 29：底端 0%，顶端 100%。 */}
          <div className="relative h-32 w-8">
          <input
            ref={slider}
            type="range" min="0" max="100" step="1"
            value={percent}
            onChange={event => onChange(Number(event.target.value) / 100)}
            onPointerDown={() => { dragging.current = true; cancelClose(); }}
            onKeyDown={event => {
              if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault();
                event.stopPropagation();
                onChange(Math.max(0, Math.min(100, percent + (event.key === 'ArrowUp' ? 1 : -1))) / 100);
              }
            }}
            className="absolute left-1/2 top-1/2 m-0 h-5 w-32 -translate-x-1/2 -translate-y-1/2 -rotate-90 cursor-pointer accent-cyan-300"
            aria-label="共享接收音量"
            aria-orientation="vertical"
            aria-valuetext={`${percent}%`}
          />
          </div>
        </div>
      </div>
    </div>
  );
}
