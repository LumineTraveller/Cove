import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, LoaderCircle, RefreshCw, RotateCcw, X } from 'lucide-react';
import packageInfo from '../../package.json';
import { UPDATE_CENTER_OPEN_EVENT, type UpdateState } from '../update';

const initialState: UpdateState = { status: 'idle' };

function statusTitle(state: UpdateState): string {
  switch (state.status) {
    case 'checking': return '正在检查更新';
    case 'available': return `发现 Cove ${state.version ?? '新版本'}`;
    case 'downloading': return `正在下载 Cove ${state.version ?? '更新'}`;
    case 'downloaded': return `Cove ${state.version ?? '更新'} 已准备好`;
    case 'not-available': return 'Cove 已是最新版本';
    case 'error': return '检查更新失败';
    case 'disabled': return '暂时无法检查更新';
    default: return 'Cove 更新';
  }
}

export function UpdateCenter() {
  const [state, setState] = useState<UpdateState>(initialState);
  const [open, setOpen] = useState(false);
  const manualCheckRef = useRef(false);

  const checkNow = useCallback(async () => {
    manualCheckRef.current = true;
    setOpen(true);
    const updater = window.coveUpdater;
    if (!updater) {
      setState({ status: 'disabled', message: '当前环境没有提供应用内更新服务。' });
      return;
    }
    setState({ status: 'checking', message: '正在连接更新服务器…' });
    try {
      setState(await updater.checkNow());
    } catch (cause) {
      setState({ status: 'error', message: cause instanceof Error ? cause.message : '检查更新失败，请稍后重试。' });
    }
  }, []);

  useEffect(() => {
    const updater = window.coveUpdater;
    if (updater) void updater.getState().then(setState).catch(() => undefined);
    const unsubscribe = updater?.onState(next => {
      setState(next);
      if (next.status === 'available' || next.status === 'downloading' || next.status === 'downloaded') {
        setOpen(true);
      } else if (manualCheckRef.current && (next.status === 'not-available' || next.status === 'error' || next.status === 'disabled')) {
        setOpen(true);
      }
    });
    const handleOpen = () => { void checkNow(); };
    window.addEventListener(UPDATE_CENTER_OPEN_EVENT, handleOpen);
    return () => {
      unsubscribe?.();
      window.removeEventListener(UPDATE_CENTER_OPEN_EVENT, handleOpen);
    };
  }, [checkNow]);

  const installNow = async () => {
    try {
      await window.coveUpdater?.installNow();
    } catch (cause) {
      setState({ status: 'error', message: cause instanceof Error ? cause.message : '无法启动安装，请重新打开 Cove 后重试。' });
    }
  };

  if (!open) return null;
  const percent = Math.round(state.percent ?? 0);
  const busy = state.status === 'checking' || state.status === 'available' || state.status === 'downloading';

  return (
    <aside className="fixed bottom-5 right-5 z-[170] w-[22rem] overflow-hidden rounded-2xl border border-white/15 bg-zinc-900/95 shadow-2xl backdrop-blur-2xl" aria-live="polite" aria-label="Cove 更新">
      <div className="flex items-start gap-3 p-4">
        <div className={`mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${state.status === 'error' ? 'bg-red-500/15 text-red-300' : state.status === 'downloaded' || state.status === 'not-available' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-cyan-300/10 text-cyan-200'}`}>
          {state.status === 'error' || state.status === 'disabled'
            ? <AlertCircle size={20} />
            : state.status === 'downloaded' || state.status === 'not-available'
              ? <CheckCircle2 size={20} />
              : state.status === 'downloading' || state.status === 'available'
                ? <Download size={20} />
                : <LoaderCircle size={20} className={busy ? 'animate-spin' : ''} />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-white">{statusTitle(state)}</p>
          <p className="mt-1 text-sm leading-relaxed text-white/45">{state.message ?? `当前版本 Cove v${packageInfo.version}`}</p>
          {state.sourceLabel && <p className="mt-1 text-xs text-cyan-100/40">更新源：{state.sourceLabel}</p>}
        </div>
        <button onClick={() => { manualCheckRef.current = false; setOpen(false); }} className="rounded-lg p-1.5 text-white/30 transition hover:bg-white/10 hover:text-white" aria-label="关闭更新提示"><X size={17} /></button>
      </div>

      {(state.status === 'available' || state.status === 'downloading') && (
        <div className="px-4 pb-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className={`h-full rounded-full bg-cyan-300 transition-[width] duration-300 ${state.status === 'available' ? 'animate-pulse' : ''}`} style={{ width: `${Math.max(3, percent)}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-xs text-white/30"><span>后台下载，不会中断当前通话</span><span>{percent}%</span></div>
        </div>
      )}

      {state.status === 'downloaded' && (
        <div className="border-t border-white/10 p-3">
          <button onClick={installNow} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white py-2.5 text-sm font-semibold text-zinc-900 transition hover:bg-cyan-100"><RotateCcw size={16} />立即重启并安装</button>
        </div>
      )}

      {(state.status === 'error' || state.status === 'not-available' || state.status === 'idle') && (
        <div className="border-t border-white/10 p-3">
          <button onClick={() => { void checkNow(); }} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 py-2.5 text-sm font-medium text-white/75 transition hover:bg-white/15 hover:text-white"><RefreshCw size={16} />重新检查</button>
        </div>
      )}
    </aside>
  );
}
