import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, CheckCircle2, Download, ExternalLink, FileText, LoaderCircle, RefreshCw, RotateCcw, X } from 'lucide-react';
import packageInfo from '../../package.json';
import {
  UPDATE_CENTER_OPEN_EVENT, UPDATE_STEPS, formatTransferPercent,
  isUpdateBusy, updateStepIndex, updateWaitWarning, type UpdateState,
} from '../update';

const initialState: UpdateState = { status: 'idle' };

function statusTitle(state: UpdateState): string {
  switch (state.status) {
    case 'checking': return '正在检查更新';
    case 'available': return '正在准备下载';
    case 'downloading': return '正在传输安装包';
    case 'finalizing': return '传输完成，正在校验与准备';
    case 'downloaded': return '更新已就绪，可以安装';
    case 'installing': return '正在启动安装程序';
    case 'not-available': return 'Cove 已是最新版本';
    case 'error': return '更新未完成';
    case 'disabled': return '暂时无法检查更新';
    default: return 'Cove 更新';
  }
}

function bytes(value?: number): string {
  if (value == null || !Number.isFinite(value)) return '未知';
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(0, value / 1024).toFixed(1)} KB`;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function UpdateCenter() {
  const [state, setState] = useState<UpdateState>(initialState);
  const [open, setOpen] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const [actionError, setActionError] = useState('');
  const manualCheckRef = useRef(false);
  const dismissedRef = useRef(false);
  const previousStatusRef = useRef(state.status);

  const checkNow = useCallback(async () => {
    manualCheckRef.current = true;
    dismissedRef.current = false;
    setActionError('');
    setOpen(true);
    const updater = window.coveUpdater;
    if (!updater) {
      setState({ status: 'disabled', message: '当前环境没有提供应用内更新服务。' });
      return;
    }
    // Keep an active transfer or ready installer visible while reopening the panel.
    try {
      setState(await updater.checkNow());
    } catch (cause) {
      setState({ status: 'error', failedStage: 'checking', message: cause instanceof Error ? cause.message : '检查更新失败，请稍后重试。' });
    }
  }, []);

  useEffect(() => {
    const updater = window.coveUpdater;
    if (updater) void updater.getState().then(setState).catch(() => undefined);
    const unsubscribe = updater?.onState(next => {
      setState(next);
      const important = next.status !== previousStatusRef.current &&
        (next.status === 'downloaded' || next.status === 'error');
      previousStatusRef.current = next.status;
      if (important || (!dismissedRef.current &&
          (next.status === 'available' || next.status === 'downloading' || next.status === 'finalizing')) ||
          (manualCheckRef.current && ['not-available', 'error', 'disabled'].includes(next.status))) {
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

  useEffect(() => {
    if (!open || !isUpdateBusy(state.status)) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, state.status]);

  const installNow = async () => {
    setActionError('');
    try {
      const updater = window.coveUpdater;
      if (!updater) throw new Error('当前环境没有安装服务。');
      const accepted = await updater.installNow();
      setState(await updater.getState());
      if (!accepted) setActionError('安装请求未成功，请检查当前阶段和错误详情。');
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '无法启动安装，请查看更新日志。');
    }
  };

  const openLog = async () => {
    setActionError('');
    try {
      if (!await window.coveUpdater?.openLog?.()) setActionError('暂时无法打开更新日志，或日志文件尚未创建。');
    } catch {
      setActionError('打开更新日志失败。日志通常位于 %APPDATA%/cove-client/updater.log。');
    }
  };

  const openRelease = async (source: 'github' | 'gitee') => {
    setActionError('');
    const base = `https://${source}.com/LumineTraveller/Cove/releases`;
    const url = state.version && /^\d+\.\d+\.\d+$/.test(state.version)
      ? `${base}/${source === 'github' ? 'tag/' : ''}v${state.version}` : base;
    try {
      if (window.coveShell) {
        if (!await window.coveShell.openExternal(url)) throw new Error();
      } else window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      setActionError('无法打开发布页，请稍后再试。');
    }
  };

  if (!open) return null;
  const busy = isUpdateBusy(state.status);
  const stepIndex = updateStepIndex(state);
  const warning = updateWaitWarning(state, clock);
  const stageMs = clock - (state.stageStartedAt ?? clock);
  const sinceActivity = clock - (state.lastActivityAt ?? clock);
  const recentSpeed = sinceActivity < 5000 ? state.bytesPerSecond : undefined;
  const eta = state.status === 'downloading' && recentSpeed && recentSpeed > 0 &&
    state.total != null && state.transferred != null
    ? Math.ceil(Math.max(0, state.total - state.transferred) / recentSpeed) * 1000 : null;
  const transferring = state.status === 'downloading';
  const showTransfer = state.percent != null && stepIndex >= 2;
  const indeterminate = state.status === 'checking' || state.status === 'available' ||
    state.status === 'finalizing' || state.status === 'installing';
  const stepLabel = stepIndex >= 0 ? UPDATE_STEPS[stepIndex].label : '检查更新';

  return (
    <aside className="fixed bottom-5 right-5 z-[170] max-h-[calc(100vh-2.5rem)] w-[26rem] max-w-[calc(100vw-2.5rem)] overflow-y-auto rounded-2xl border border-white/15 bg-zinc-900/95 shadow-2xl backdrop-blur-2xl" aria-label="Cove 更新">
      <div className="flex items-start gap-3 p-4">
        <div className={`mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${state.status === 'error' ? 'bg-red-500/15 text-red-300' : state.status === 'downloaded' || state.status === 'not-available' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-cyan-300/10 text-cyan-200'}`}>
          {state.status === 'error' || state.status === 'disabled' ? <AlertCircle size={20} />
            : state.status === 'downloaded' || state.status === 'not-available' ? <CheckCircle2 size={20} />
            : transferring ? <Download size={20} /> : <LoaderCircle size={20} className={busy ? 'animate-spin' : ''} />}
        </div>
        <div className="min-w-0 flex-1" aria-live="polite">
          <p className="font-semibold text-white">{statusTitle(state)}</p>
          <p className="mt-1 text-xs text-white/45">Cove v{packageInfo.version}{state.version ? ` → v${state.version}` : ''}{state.sourceLabel ? ` · ${state.sourceLabel}` : ''}</p>
          <p className="mt-2 text-sm leading-relaxed text-white/60">{state.message ?? '检查是否有可用的新版本。'}</p>
        </div>
        <button onClick={() => { dismissedRef.current = true; manualCheckRef.current = false; setOpen(false); }} className="rounded-lg p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white" aria-label="收起更新提示"><X size={17} /></button>
      </div>

      {stepIndex >= 0 && (
        <div className="px-4 pb-4">
          <ol className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-xl bg-black/20 p-3 text-xs" aria-label="更新阶段">
            {UPDATE_STEPS.map((step, index) => {
              const current = index === stepIndex;
              const failed = current && state.status === 'error';
              const complete = index < stepIndex || (current && state.status === 'downloaded');
              return (
                <li key={step.status} aria-current={current ? 'step' : undefined} className={`flex items-center gap-2 ${failed ? 'text-red-300' : complete ? 'text-emerald-300' : current ? 'text-cyan-200' : 'text-white/35'}`}>
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {failed ? <AlertCircle size={14} /> : complete ? <Check size={14} /> : current && busy ? <LoaderCircle size={14} className="animate-spin" /> : index + 1}
                  </span>
                  {step.label}
                </li>
              );
            })}
          </ol>

          {(showTransfer || indeterminate) && (
            <div className="mt-3">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label={transferring ? '安装包传输进度' : stepLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : state.percent}>
                <div className={`h-full rounded-full bg-cyan-300 ${indeterminate ? 'w-full animate-pulse opacity-50' : 'transition-[width] duration-300'}`} style={indeterminate ? undefined : { width: `${state.percent ?? 0}%` }} />
              </div>
              {showTransfer && <div className="mt-2 flex justify-between gap-2 text-xs tabular-nums text-white/65">
                <span>已传输 {bytes(state.transferred)} / {bytes(state.total)}</span>
                <span>{formatTransferPercent(state.percent)}（传输）</span>
              </div>}
              {transferring && <div className="mt-1.5 flex justify-between text-xs tabular-nums text-white/45">
                <span>{recentSpeed != null ? `${bytes(recentSpeed)}/s` : '速度：等待新数据'}</span>
                <span>{eta != null ? `预计剩余 ${duration(eta)}` : '预计剩余：计算中'}</span>
              </div>}
            </div>
          )}

          {busy && <p className="mt-2 text-xs tabular-nums text-white/45">当前阶段已用时 {duration(stageMs)}</p>}
          {warning && <p className="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/5 p-2.5 text-xs leading-relaxed text-amber-100/85" role="status">{warning}</p>}
          {state.status === 'error' && <p className="mt-3 text-xs text-red-300">失败阶段：{stepLabel}</p>}
          {state.errorDetail && <details className="mt-2 text-xs text-white/60">
            <summary className="cursor-pointer hover:text-white">错误详情{state.errorCode ? ` · ${state.errorCode}` : ''}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-black/25 p-2">{state.errorDetail}</pre>
          </details>}
          <p className="mt-3 text-xs leading-relaxed text-white/35">
            {state.status === 'installing' ? '安装过程由系统安装程序接管。'
              : '收起不会取消更新。仅在开始安装时退出 Cove；传输 100% 不代表安装包已就绪。'}
          </p>
        </div>
      )}

      <div className="space-y-2 border-t border-white/10 p-3">
        {state.status === 'downloaded' && <button onClick={() => { void installNow(); }} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white py-2.5 text-sm font-semibold text-zinc-900 transition hover:bg-cyan-100"><RotateCcw size={16} />立即重启并安装</button>}
        {state.status === 'installing' && <button disabled className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 py-2.5 text-sm text-white/60"><LoaderCircle size={16} className="animate-spin" />正在启动安装…</button>}
        {['error', 'not-available', 'idle'].includes(state.status) && <button onClick={() => { void checkNow(); }} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 py-2.5 text-sm font-medium text-white/75 transition hover:bg-white/15 hover:text-white"><RefreshCw size={16} />重试检查与下载</button>}
        <details className="rounded-lg bg-black/15 px-2.5 py-2 text-xs text-white/55">
          <summary className="cursor-pointer hover:text-white">排查与手动下载</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => { void openLog(); }} className="inline-flex items-center gap-1 rounded px-2 py-1.5 hover:bg-white/10 hover:text-white"><FileText size={13} />打开更新日志</button>
            <button onClick={() => { void openRelease('github'); }} className="inline-flex items-center gap-1 rounded px-2 py-1.5 hover:bg-white/10 hover:text-white"><ExternalLink size={13} />GitHub 发布页</button>
            <button onClick={() => { void openRelease('gitee'); }} className="inline-flex items-center gap-1 rounded px-2 py-1.5 hover:bg-white/10 hover:text-white"><ExternalLink size={13} />Gitee 发布页</button>
          </div>
          <p className="mt-2 leading-relaxed">分享错误详情或 updater.log 可帮助定位停在何处。手动下载请选择 Windows 客户端 .exe 安装包；这不会取消当前后台更新。</p>
        </details>
        {actionError && <p className="px-1 text-xs text-red-300" role="alert">{actionError}</p>}
      </div>
    </aside>
  );
}
