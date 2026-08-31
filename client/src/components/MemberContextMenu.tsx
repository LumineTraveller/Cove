import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mic, MicOff, UserMinus } from 'lucide-react';

export function MemberContextMenu({ username, muted, x, y, disabled, onToggleMute, onRemove, onClose }: {
  username: string;
  muted: boolean;
  x: number;
  y: number;
  disabled: boolean;
  onToggleMute: () => void;
  onRemove: () => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
    (element.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? element).focus({ preventScroll: true });
  }, [x, y]);

  useEffect(() => {
    const outside = (event: Event) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) onClose();
    };
    const close = () => onClose();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('contextmenu', outside, true);
    document.addEventListener('scroll', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('contextmenu', outside, true);
      document.removeEventListener('scroll', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);

  return createPortal(
    <div ref={menu} id="member-moderation-menu" role="menu" aria-label={`${username} 的成员操作`} tabIndex={-1}
      className="fixed z-[150] w-52 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-white/15 bg-zinc-900/95 p-1.5 text-sm shadow-2xl backdrop-blur-xl focus:outline-none"
      style={{ ...position, maxHeight: 'calc(100vh - 1rem)' }}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key === 'Tab') { onClose(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        if (!buttons.length) return;
        const index = buttons.findIndex(button => button === document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus({ preventScroll: true });
      }}
    >
      <p className="truncate border-b border-white/10 px-3 py-2 text-xs text-white/45" title={username}>{username}</p>
      <button role="menuitem" disabled={disabled} onClick={() => { onClose(true); onToggleMute(); }}
        className={`mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none ${muted ? 'text-emerald-300 hover:bg-emerald-500/10 focus:bg-emerald-500/10' : 'text-white/80 hover:bg-white/10 focus:bg-white/10'}`}>
        {muted ? <Mic size={16} /> : <MicOff size={16} />}{muted ? '解除禁言' : '禁言'}
      </button>
      <button role="menuitem" disabled={disabled} onClick={() => { onClose(true); onRemove(); }}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-red-300 transition hover:bg-red-500/10 focus:bg-red-500/10 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40">
        <UserMinus size={16} />移出房间
      </button>
    </div>,
    document.body,
  );
}
