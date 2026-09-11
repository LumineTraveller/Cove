import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react';
import packageInfo from '../../package.json';
import {
  UPDATE_CENTER_OPEN_EVENT,
  UPDATE_STEPS,
  formatTransferPercent,
  isUpdateBusy,
  openUpdateDetails,
  updateHasDetails,
  updateStepIndex,
  updateWaitWarning,
  type UpdateState,
} from '../update';
import '../ui-v2.css';

const initialState: UpdateState = { status: 'idle' };

function statusTitle(state: UpdateState): string {
  switch (state.status) {
    case 'checking': return '正在检查更新';
    case 'available': return '正在准备下载';
    case 'downloading': return '正在传输安装包';
    case 'finalizing': return '传输完成，正在校验';
    case 'downloaded': return '更新已就绪';
    case 'installing': return '正在启动安装程序';
    case 'not-available': return 'Cove 已是最新版本';
    case 'error': return '更新未完成';
    case 'disabled': return '暂时无法检查更新';
    default: return 'Cove 更新';
  }
}

function compactStatusMessage(state: UpdateState): string {
  switch (state.status) {
    case 'checking': return '正在检查可用的新版本。';
    case 'available': return state.version ? `发现 v${state.version}，准备下载。` : '发现新版本，准备下载。';
    case 'downloading': return state.percent == null ? '正在下载更新包。' : `正在下载更新包 · ${formatTransferPercent(state.percent)}`;
    case 'finalizing': return '下载完成，正在校验并准备安装。';
    case 'downloaded': return '更新包已经准备好，可以重启更新。';
    case 'installing': return '安装程序启动后，Cove 将退出并完成更新。';
    case 'not-available': return '当前已经是最新版本。';
    case 'disabled': return state.message ?? '当前环境没有提供应用内更新服务。';
    case 'error': return state.message ?? '更新失败，可以重试或查看详细信息。';
    default: return '检查是否有可用的新版本。';
  }
}

function bytes(value?: number): string {
  if (value == null || !Number.isFinite(value)) return '未知';
  return value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(0, value / 1024).toFixed(1)} KB`;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function statusTone(state: UpdateState): 'error' | 'success' | 'progress' | 'neutral' {
  if (state.status === 'error' || state.status === 'disabled') return 'error';
  if (state.status === 'downloaded' || state.status === 'not-available') return 'success';
  if (isUpdateBusy(state.status)) return 'progress';
  return 'neutral';
}

function StatusIcon({ state }: { state: UpdateState }) {
  const tone = statusTone(state);
  return (
    <span className={`update-status-icon tone-${tone}`} aria-hidden="true">
      {state.status === 'error' || state.status === 'disabled' ? <AlertCircle size={19} />
        : state.status === 'downloaded' || state.status === 'not-available' ? <CheckCircle2 size={19} />
        : state.status === 'downloading' ? <Download size={19} />
        : isUpdateBusy(state.status) ? <LoaderCircle size={19} className="update-status-spin" />
        : <RefreshCw size={19} />}
    </span>
  );
}

function UpdateProgress({
  state,
  clock,
  compact = false,
}: {
  state: UpdateState;
  clock: number;
  compact?: boolean;
}) {
  const stepIndex = updateStepIndex(state);
  const warning = updateWaitWarning(state, clock);
  const stageMs = clock - (state.stageStartedAt ?? clock);
  const sinceActivity = clock - (state.lastActivityAt ?? clock);
  const recentSpeed = sinceActivity < 5000 ? state.bytesPerSecond : undefined;
  const eta = state.status === 'downloading' && recentSpeed && recentSpeed > 0 &&
    state.total != null && state.transferred != null
    ? Math.ceil(Math.max(0, state.total - state.transferred) / recentSpeed) * 1000
    : null;
  const transferring = state.status === 'downloading';
  const showTransfer = state.percent != null && stepIndex >= 2;
  const indeterminate = state.status === 'checking' || state.status === 'available' ||
    state.status === 'finalizing' || state.status === 'installing';
  const stepLabel = stepIndex >= 0 ? UPDATE_STEPS[stepIndex].label : '检查更新';

  if (compact) {
    if (!showTransfer && !indeterminate) return null;
    return (
      <div className="update-status-progress">
        <div
          className="update-progress-track"
          role="progressbar"
          aria-label={transferring ? '安装包传输进度' : stepLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate ? undefined : state.percent}
        >
          <span
            className={indeterminate ? 'indeterminate' : ''}
            style={indeterminate ? undefined : { width: `${state.percent ?? 0}%` }}
          />
        </div>
        {showTransfer && (
          <div className="update-progress-caption">
            <span>{formatTransferPercent(state.percent)} · {bytes(state.transferred)} / {bytes(state.total)}</span>
            {transferring && <span>{eta != null ? `剩余约 ${duration(eta)}` : '计算剩余时间…'}</span>}
          </div>
        )}
      </div>
    );
  }

  // 详情卡片只在确有进度、阶段或错误可展示时出现；空闲、最新版本或更新服务
  // 不可用等状态下不应留下一个空白框。
  if (!updateHasDetails(state, clock)) return null;

  return (
    <div className="update-details-progress">
      {stepIndex >= 0 && (
        <ol className="update-step-list" aria-label="更新阶段">
          {UPDATE_STEPS.map((step, index) => {
            const current = index === stepIndex;
            const failed = current && state.status === 'error';
            const complete = index < stepIndex || (current && state.status === 'downloaded');
            return (
              <li
                key={step.status}
                aria-current={current ? 'step' : undefined}
                className={failed ? 'failed' : complete ? 'complete' : current ? 'current' : ''}
              >
                <span>
                  {failed ? <AlertCircle size={14} />
                    : complete ? <Check size={14} />
                    : current && isUpdateBusy(state.status) ? <LoaderCircle size={14} className="update-status-spin" />
                    : index + 1}
                </span>
                {step.label}
              </li>
            );
          })}
        </ol>
      )}

      {(showTransfer || indeterminate) && (
        <div className="update-detail-transfer">
          <div
            className="update-progress-track"
            role="progressbar"
            aria-label={transferring ? '安装包传输进度' : stepLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={indeterminate ? undefined : state.percent}
          >
            <span
              className={indeterminate ? 'indeterminate' : ''}
              style={indeterminate ? undefined : { width: `${state.percent ?? 0}%` }}
            />
          </div>
          {showTransfer && (
            <div className="update-progress-caption">
              <span>已传输 {bytes(state.transferred)} / {bytes(state.total)}</span>
              <span>{formatTransferPercent(state.percent)}（传输）</span>
            </div>
          )}
          {transferring && (
            <div className="update-progress-caption muted">
              <span>{recentSpeed != null ? `${bytes(recentSpeed)}/s` : '速度：等待新数据'}</span>
              <span>{eta != null ? `预计剩余 ${duration(eta)}` : '预计剩余：计算中'}</span>
            </div>
          )}
        </div>
      )}

      {isUpdateBusy(state.status) && (
        <p className="update-stage-time">当前阶段已用时 {duration(stageMs)}</p>
      )}
      {warning && <p className="update-warning" role="status">{warning}</p>}
      {state.status === 'error' && <p className="update-error-stage">失败阶段：{stepLabel}</p>}
      {state.errorDetail && (
        <details className="update-error-detail">
          <summary>错误详情{state.errorCode ? ` · ${state.errorCode}` : ''}</summary>
          <pre>{state.errorDetail}</pre>
        </details>
      )}
      {stepIndex >= 0 && (
        <p className="update-details-note">
          {state.status === 'installing'
            ? '安装过程由系统安装程序接管。'
            : '关闭或切换页面不会取消更新；仅在开始安装时退出 Cove。传输 100% 不代表安装包已经就绪。'}
        </p>
      )}
    </div>
  );
}

export function UpdateCenter({ embedded = false }: { embedded?: boolean }) {
  const [state, setState] = useState<UpdateState>(initialState);
  const [open, setOpen] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const [actionError, setActionError] = useState('');
  const manualCheckRef = useRef(false);
  const dismissedRef = useRef(false);
  const popoverRef = useRef<HTMLElement | null>(null);
  const previousStatusRef = useRef(state.status);

  const checkNow = useCallback(async () => {
    manualCheckRef.current = true;
    dismissedRef.current = false;
    setActionError('');
    if (!embedded) setOpen(true);
    const updater = window.coveUpdater;
    if (!updater) {
      setState({ status: 'disabled', message: '当前环境没有提供应用内更新服务。' });
      return;
    }
    try {
      setState(await updater.checkNow());
    } catch (cause) {
      setState({
        status: 'error',
        failedStage: 'checking',
        message: cause instanceof Error ? cause.message : '检查更新失败，请稍后重试。',
      });
    }
  }, [embedded]);

  useEffect(() => {
    const updater = window.coveUpdater;
    let active = true;
    if (updater) {
      void updater.getState().then((next) => {
        if (!active) return;
        setState(next);
        if (!embedded && ['available', 'downloading', 'finalizing', 'downloaded', 'installing', 'error'].includes(next.status)) setOpen(true);
      }).catch(() => undefined);
    }
    const unsubscribe = updater?.onState((next) => {
      setState(next);
      const important = next.status !== previousStatusRef.current &&
        (next.status === 'downloaded' || next.status === 'error');
      previousStatusRef.current = next.status;
      if (!embedded && (important || (!dismissedRef.current &&
          ['available', 'downloading', 'finalizing', 'installing'].includes(next.status)) ||
          (manualCheckRef.current && ['not-available', 'error', 'disabled'].includes(next.status)))) {
        setOpen(true);
      }
    });
    const handleOpen = () => { void checkNow(); };
    window.addEventListener(UPDATE_CENTER_OPEN_EVENT, handleOpen);
    return () => {
      active = false;
      unsubscribe?.();
      window.removeEventListener(UPDATE_CENTER_OPEN_EVENT, handleOpen);
    };
  }, [checkNow, embedded]);

  useEffect(() => {
    if ((!embedded && !open) || !isUpdateBusy(state.status)) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [embedded, open, state.status]);

  // 点击更新浮窗以外的任何位置即关闭，和其余弹窗保持一致。
  useEffect(() => {
    if (embedded || !open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && popoverRef.current?.contains(target)) return;
      dismissedRef.current = true;
      manualCheckRef.current = false;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [embedded, open]);

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
      ? `${base}/${source === 'github' ? 'tag/' : ''}v${state.version}`
      : base;
    try {
      if (window.coveShell) {
        if (!await window.coveShell.openExternal(url)) throw new Error();
      } else window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      setActionError('无法打开发布页，请稍后再试。');
    }
  };

  const closeStatus = () => {
    dismissedRef.current = true;
    manualCheckRef.current = false;
    setOpen(false);
  };
  const showDetails = () => {
    closeStatus();
    openUpdateDetails();
  };
  const retryLabel = state.status === 'not-available' ? '重新检查' : '检查更新';
  const currentVersion = `Cove v${packageInfo.version}`;
  const targetVersion = state.version ? ` → v${state.version}` : '';
  const busy = isUpdateBusy(state.status);

  if (!embedded && !open) return null;

  if (embedded) {
    return (
      <section className="update-center-details" aria-label="Cove 更新详情">
        <div className="update-details-summary">
          <StatusIcon state={state} />
          <div className="update-details-summary-copy" aria-live="polite">
            <strong>{statusTitle(state)}</strong>
            <small>{currentVersion}{targetVersion}{state.sourceLabel ? ` · ${state.sourceLabel}` : ''}</small>
            <p>{state.message ?? compactStatusMessage(state)}</p>
          </div>
          <button
            type="button"
            className="update-check-button"
            onClick={() => { void checkNow(); }}
            disabled={busy}
          >
            {busy ? <LoaderCircle size={16} className="update-status-spin" /> : <RefreshCw size={16} />}
            {busy ? '检查中…' : '检查更新'}
          </button>
        </div>

        <UpdateProgress state={state} clock={clock} />

        {(state.status === 'downloaded' || state.status === 'installing') && (
          <div className="update-details-actions">
            {state.status === 'downloaded' && (
              <button type="button" className="update-primary-action" onClick={() => { void installNow(); }}>
                <RotateCcw size={16} />重启并更新
              </button>
            )}
            {state.status === 'installing' && (
              <button type="button" className="update-primary-action" disabled>
                <LoaderCircle size={16} className="update-status-spin" />正在启动安装…
              </button>
            )}
          </div>
        )}
        {actionError && <p className="update-action-error" role="alert">{actionError}</p>}

        <details className="update-manual-tools">
          <summary>排查与手动下载</summary>
          <div>
            <button type="button" onClick={() => { void openLog(); }}><FileText size={14} />打开更新日志</button>
            <button type="button" onClick={() => { void openRelease('github'); }}><ExternalLink size={14} />GitHub 发布页</button>
            <button type="button" onClick={() => { void openRelease('gitee'); }}><ExternalLink size={14} />Gitee 发布页</button>
          </div>
          <p>分享错误详情或 updater.log 可帮助定位停在何处。手动下载请选择 Windows 客户端 .exe 安装包；这不会取消当前后台更新。</p>
        </details>
      </section>
    );
  }

  return (
    <aside className="update-status-popover" aria-label="Cove 更新状态" ref={popoverRef}>
      <div className="update-status-heading">
        <StatusIcon state={state} />
        <div className="update-status-heading-copy" aria-live="polite">
          <strong>{statusTitle(state)}</strong>
          <small>{currentVersion}{targetVersion}{state.sourceLabel ? ` · ${state.sourceLabel}` : ''}</small>
        </div>
        <button type="button" className="update-status-close" onClick={closeStatus} aria-label="关闭更新提示">
          <X size={16} />
        </button>
      </div>
      <p className="update-status-message">{compactStatusMessage(state)}</p>
      <UpdateProgress state={state} clock={clock} compact />
      {actionError && <p className="update-action-error" role="alert">{actionError}</p>}
      <div className="update-status-actions">
        {state.status === 'downloaded' && (
          <button type="button" className="update-primary-action" onClick={() => { void installNow(); }}>
            <RotateCcw size={15} />重启并更新
          </button>
        )}
        {state.status === 'installing' && (
          <button type="button" className="update-primary-action" disabled>
            <LoaderCircle size={15} className="update-status-spin" />正在安装…
          </button>
        )}
        {['error', 'not-available', 'idle', 'disabled'].includes(state.status) && (
          <button type="button" className="update-secondary-action" onClick={() => { void checkNow(); }}>
            <RefreshCw size={15} />{retryLabel}
          </button>
        )}
        <button type="button" className="update-details-action" onClick={showDetails}>
          <FileText size={15} />详细信息
        </button>
      </div>
    </aside>
  );
}
