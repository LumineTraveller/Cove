import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, ExternalLink, FileCheck2, LoaderCircle, RotateCcw, X } from 'lucide-react';
import type { InstallationIntegrityApi, InstallationIntegrityState } from '../../../../electron/integrity-state';
import packageInfo from '../../../../package.json';
import {
  INTEGRITY_ISSUE_LABELS,
  integrityBusy,
  integrityBytes,
  integrityCheckedTime,
  integrityDescription,
  integrityFileCount,
  integrityIssueCount,
  integrityIssues,
  integrityPercent,
  integrityRelativePath,
  integrityTitle,
} from '../integrityView';
import '../installation-integrity.css';

type IntegrityAction = 'check' | 'download' | 'launch' | 'release';

const initialState: InstallationIntegrityState = {
  status: 'idle', version: packageInfo.version, platform: '', arch: '',
};

export function InstallationIntegrityPanel({ api }: { api?: InstallationIntegrityApi } = {}) {
  const service = api ?? (typeof window === 'undefined' ? undefined : window.coveIntegrity);
  const [state, setState] = useState<InstallationIntegrityState>(initialState);
  const [ready, setReady] = useState(false);
  const [pendingAction, setPendingAction] = useState<IntegrityAction | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [actionError, setActionError] = useState('');
  const revision = useRef(0);
  const mounted = useRef(false);
  const actionLock = useRef(false);
  const cancelLock = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    setReady(false);
    if (!service) {
      setState({ ...initialState, status: 'disabled' });
      setReady(true);
      return () => { mounted.current = false; };
    }
    // Subscribe before requesting the initial snapshot. A newer event always wins.
    const unsubscribe = service.onState((next) => {
      if (!active) return;
      revision.current++;
      setState(next);
      setReady(true);
    });
    const requestedAt = revision.current;
    service.getState().then((next) => {
      if (active && revision.current === requestedAt) setState(next);
    }).catch(() => {
      if (active && revision.current === requestedAt) {
        setState({ ...initialState, status: 'error' });
        setActionError('无法读取安装完整性状态，请重试。');
      }
    }).finally(() => { if (active) setReady(true); });
    return () => {
      active = false;
      mounted.current = false;
      unsubscribe();
    };
  }, [service]);

  const runAction = async (action: IntegrityAction) => {
    if (!service || !ready || actionLock.current || cancelLock.current || integrityBusy(state.status) || state.status === 'disabled') return;
    if (action === 'download' && !state.repairAvailable) return;
    if (action === 'launch' && state.status !== 'downloaded') return;
    actionLock.current = true;
    setPendingAction(action);
    setActionError('');
    const requestedAt = revision.current;
    try {
      let next: InstallationIntegrityState | undefined;
      if (action === 'check') next = await service.checkNow();
      if (action === 'download') next = await service.downloadRepair();
      if (action === 'launch') {
        // A false result includes the user cancelling the native confirmation.
        await service.launchRepair();
        next = await service.getState();
      }
      if (action === 'release' && !(await service.openRelease())) {
        throw new Error('无法打开官方版本页，请稍后重试。');
      }
      if (mounted.current && next && revision.current === requestedAt) setState(next);
    } catch {
      if (mounted.current) setActionError(action === 'release'
        ? '无法打开官方版本页，请稍后重试。'
        : '操作未完成，请检查网络连接和文件访问权限后重试。');
    } finally {
      actionLock.current = false;
      if (mounted.current) setPendingAction(null);
    }
  };

  const cancel = async () => {
    if (!service || cancelLock.current || !['checking', 'downloading'].includes(state.status)) return;
    cancelLock.current = true;
    setCancelPending(true);
    setActionError('');
    const requestedAt = revision.current;
    try {
      const next = await service.cancel();
      if (mounted.current && revision.current === requestedAt) setState(next);
    } catch {
      if (mounted.current) setActionError('取消未完成，请稍后重试。');
    } finally {
      cancelLock.current = false;
      if (mounted.current) setCancelPending(false);
    }
  };

  const busy = integrityBusy(state.status) || pendingAction != null || cancelPending;
  const disabled = !service || !ready || busy || state.status === 'disabled';
  const issues = integrityIssues(state);
  const issueCount = integrityIssueCount(state);
  const percent = integrityPercent(state);
  const progressVisible = state.status === 'checking' || state.status === 'downloading';
  const repairReady = ['downloaded', 'confirming', 'launching'].includes(state.status);
  const showDownload = state.repairAvailable && !repairReady;
  const tone = state.status === 'healthy' || state.status === 'downloaded' ? 'success'
    : state.status === 'damaged' || state.status === 'error' ? 'warning'
    : integrityBusy(state.status) ? 'progress' : 'neutral';
  const StatusIcon = tone === 'success' ? CheckCircle2
    : tone === 'warning' ? AlertCircle : integrityBusy(state.status) ? LoaderCircle : FileCheck2;

  return (
    <section className="installation-integrity" aria-label="安装完整性">
      <div className="integrity-heading">
        <span className={`integrity-icon tone-${tone}`} aria-hidden="true">
          <StatusIcon size={19} className={integrityBusy(state.status) ? 'integrity-spin' : undefined} />
        </span>
        <div className="integrity-heading-copy">
          <h3>安装完整性</h3>
          <p className="integrity-version">当前版本 v{state.version || packageInfo.version}</p>
        </div>
        <button type="button" className="integrity-button integrity-check" disabled={disabled}
          onClick={() => void runAction('check')}>
          {state.status === 'checking' || pendingAction === 'check'
            ? <LoaderCircle size={15} className="integrity-spin" aria-hidden="true" />
            : <FileCheck2 size={15} aria-hidden="true" />}
          {state.status === 'checking' || pendingAction === 'check' ? '检查中…' : '检查安装文件'}
        </button>
      </div>

      <div className="integrity-status" aria-live="polite" aria-atomic="true">
        <strong>{ready ? integrityTitle(state.status) : '正在读取检查状态…'}</strong>
        <p>{integrityDescription(state)}</p>
        {state.message && <p className="integrity-service-message">{state.message}</p>}
      </div>

      {progressVisible && (
        <div className="integrity-progress">
          <div className="integrity-progress-track" role="progressbar"
            aria-label={state.status === 'checking' ? '安装文件检查进度' : '修复安装包下载进度'}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <span className={percent == null ? 'indeterminate' : undefined}
              style={percent == null ? undefined : { width: `${percent}%` }} />
          </div>
          <div className="integrity-progress-caption">
            <span>{state.status === 'checking'
              ? `已检查 ${integrityFileCount(state.checkedFiles)} / ${integrityFileCount(state.totalFiles)} 个文件`
              : `${integrityBytes(state.progress?.transferred)} / ${integrityBytes(state.progress?.total)}`}</span>
            <span>{percent == null ? '准备中…' : `${percent.toFixed(0)}%`}</span>
          </div>
        </div>
      )}

      {(state.checkedAt != null || state.checkedFiles != null) && (
        <p className="integrity-last-check">上次检查：{integrityCheckedTime(state.checkedAt)}
          {state.checkedFiles != null && ` · 已检查 ${integrityFileCount(state.checkedFiles)} 个文件`}</p>
      )}

      {issueCount > 0 && (
        <details className="integrity-issues" open={state.status === 'damaged'}>
          <summary>安装文件异常：{integrityFileCount(issueCount)} 项</summary>
          {issues.length > 0 && (
            <ul>{issues.map((issue, index) => (
              <li key={`${issue.kind}-${index}`}>
                <span>{INTEGRITY_ISSUE_LABELS[issue.kind]}</span>
                <code>{integrityRelativePath(issue.path)}</code>
              </li>
            ))}</ul>
          )}
          {issueCount > issues.length && <p>仅显示前 {issues.length} 项；异常总数为 {integrityFileCount(issueCount)} 项。</p>}
        </details>
      )}

      <p className="integrity-scope">仅检查安装文件，不检查账户、设置、聊天记录或语音包。检查结果不代表所有功能的运行状态。</p>

      {repairReady && (
        <p className="integrity-repair-notice">请先保存工作。退出会中断通话和屏幕共享；Cove 退出后再由安装程序修复，不会在运行中覆写文件。请保留并核对 Windows 安全提示。</p>
      )}

      <div className="integrity-actions">
        {showDownload && (
          <button type="button" className="integrity-button integrity-primary" disabled={disabled}
            onClick={() => void runAction('download')}>
            <Download size={15} aria-hidden="true" />
            {state.status === 'downloading' || pendingAction === 'download' ? '正在下载…' : '下载同版本修复安装包'}
          </button>
        )}
        {repairReady && (
          <button type="button" className="integrity-button integrity-primary"
            disabled={disabled || state.status !== 'downloaded'} onClick={() => void runAction('launch')}>
            <RotateCcw size={15} aria-hidden="true" />
            {state.status === 'launching' ? '正在启动修复…' : state.status === 'confirming' || pendingAction === 'launch' ? '等待确认…' : '退出并修复'}
          </button>
        )}
        {progressVisible && (
          <button type="button" className="integrity-button" disabled={cancelPending}
            onClick={() => void cancel()}><X size={15} aria-hidden="true" />{cancelPending ? '正在取消…' : '取消'}</button>
        )}
        <button type="button" className="integrity-button integrity-release" disabled={disabled}
          onClick={() => void runAction('release')}>
          <ExternalLink size={14} aria-hidden="true" />打开官方版本页
        </button>
      </div>
      {actionError && <p className="integrity-action-error" role="alert">{actionError}</p>}

      <details className="integrity-manual-help">
        <summary>Cove 无法启动时如何修复</summary>
        <p>应用内入口需要 Cove 能正常启动。若主程序无法打开，请在浏览器访问官方对应版本发布页，下载同版本 Windows 安装包，在退出 Cove 后覆盖安装。使用原安装位置并保留用户数据目录，即可保留账户、设置和聊天记录。</p>
      </details>
    </section>
  );
}
