import { LoaderCircle, MousePointer2, Volume2, VolumeX } from 'lucide-react';

export function WatchingScreenControls({ volume, onVolumeChange, remoteState, notice, onRequestControl, onStopControl }: {
  volume: number;
  onVolumeChange: (volume: number) => void;
  remoteState: 'available' | 'unsupported' | 'pending' | 'active';
  notice?: string;
  onRequestControl: () => void;
  onStopControl: () => void;
}) {
  const percent = Math.round(volume * 100);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3" data-watching-screen-controls>
      <label className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-cyan-50/75">
        {percent === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
        <span className="sr-only">共享接收音量</span>
        <input type="range" min="0" max="100" step="1" value={percent}
          onChange={event => onVolumeChange(Number(event.target.value) / 100)}
          className="h-5 w-24 cursor-pointer accent-cyan-300" aria-label="共享接收音量" aria-valuetext={`${percent}%`} />
        <span className="w-9 text-right tabular-nums">{percent}%</span>
      </label>
      <div className="min-w-0 text-xs">
        {remoteState === 'active' ? (
          <button onClick={onStopControl} className="inline-flex items-center gap-2 rounded-xl bg-red-500/20 px-3 py-2 font-semibold text-red-100 transition hover:bg-red-500/30">
            <MousePointer2 size={15} />停止远程控制
          </button>
        ) : remoteState === 'pending' ? (
          <span role="status" className="inline-flex items-center gap-2 px-2 py-1.5 text-cyan-100/75"><LoaderCircle size={14} className="animate-spin" />等待共享者确认</span>
        ) : remoteState === 'available' ? (
          <button onClick={onRequestControl} className="inline-flex items-center gap-2 rounded-xl bg-cyan-200 px-3 py-2 font-semibold text-zinc-900 transition hover:bg-white">
            <MousePointer2 size={15} />申请远程控制
          </button>
        ) : (
          <span className="block max-w-48 px-2 py-1.5 text-white/40">共享者当前客户端不支持远程控制</span>
        )}
        {!!notice && <p role="status" className="mt-1 max-w-56 px-2 text-[11px] leading-relaxed text-amber-100/70">{notice}</p>}
      </div>
    </div>
  );
}
