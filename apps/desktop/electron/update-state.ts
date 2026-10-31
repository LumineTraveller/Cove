// Shared by Electron and the renderer; no platform APIs here.
export type UpdateStatus =
  | 'disabled' | 'idle' | 'checking' | 'available' | 'downloading'
  | 'finalizing' | 'downloaded' | 'installing' | 'not-available' | 'error';

export interface UpdateDownloadMode {
  downloadMode: 'differential' | 'full' | 'cached';
  differentialOutcome?: 'in-progress' | 'completed' | 'fallback';
  fallbackCode?: string;
}

export interface UpdateState extends Partial<UpdateDownloadMode> {
  status: UpdateStatus;
  version?: string;
  /** Transfer progress only, never overall installation progress. */
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  stageStartedAt?: number;
  lastActivityAt?: number;
  message?: string;
  source?: 'github' | 'cloud';
  sourceLabel?: 'GitHub' | 'Cove 服务器' | '当前服务器' | '更新服务器';
  failedStage?: UpdateStatus;
  errorDetail?: string;
  errorCode?: string;
}

export function updateDownloadNotice(state: UpdateState): string | null {
  if (state.downloadMode === 'cached') return '使用已校验的完整安装包缓存。';
  if (state.downloadMode === 'differential') return state.differentialOutcome === 'completed'
    ? '差分重建及安装包完整性校验已完成。' : '正在校验旧版基线并尝试差分下载。';
  if (state.downloadMode !== 'full') return null;
  if (state.differentialOutcome !== 'fallback') return '正在下载完整安装包，完成后仍会校验完整性。';
  const reason = state.fallbackCode === 'ENOENT' ? '旧版安装包基线缺失'
    : state.fallbackCode === 'COVE_BASELINE_MISMATCH' ? '旧版安装包基线与已安装版本不符'
    : state.fallbackCode === 'COVE_BASELINE_CHANGED' ? '旧版安装包基线在校验期间发生变化'
    : state.fallbackCode === 'COVE_CACHE_UNSAFE' ? '更新缓存路径无法安全使用'
    : state.fallbackCode?.startsWith('COVE_BASELINE') ? '无法确认旧版安装包的身份或完整性'
    : state.fallbackCode?.startsWith('COVE_BLOCKMAP') ? '旧版分块信息无法验证'
    : state.fallbackCode === 'COVE_DIFFERENTIAL_CHECKSUM' ? '差分重建的完整性校验未通过'
    : state.fallbackCode === 'COVE_DIFFERENTIAL_RANGE' ? '下载源的分段响应不符合预期'
    : state.fallbackCode === 'COVE_DIFFERENTIAL_NETWORK' ? '差分传输的网络连接中断'
    : '差分下载未完成';
  return `${reason}，已转为完整安装包下载；完整性校验仍会执行。`;
}

export const UPDATE_STEPS = [
  { status: 'checking', label: '检查版本' },
  { status: 'available', label: '准备下载' },
  { status: 'downloading', label: '传输安装包' },
  { status: 'finalizing', label: '校验与安装准备' },
  { status: 'downloaded', label: '可以安装' },
  { status: 'installing', label: '启动安装' },
] as const;

export function isUpdateBusy(status: UpdateStatus): boolean {
  return ['checking', 'available', 'downloading', 'finalizing', 'installing'].includes(status);
}

export function updateStepIndex(state: UpdateState): number {
  const status = state.status === 'error' ? state.failedStage : state.status;
  const index = UPDATE_STEPS.findIndex(step => step.status === status);
  return index < 0 && state.status === 'error' ? 0 : index;
}

export function transferPercent(progress: { percent: number; total?: number; transferred?: number }): number {
  if (Number.isFinite(progress.total) && progress.total! > 0 &&
      Number.isFinite(progress.transferred) && progress.transferred! >= 0) {
    return Math.min(100, progress.transferred! / progress.total! * 100);
  }
  return Math.max(0, Math.min(100, Number.isFinite(progress.percent) ? progress.percent : 0));
}

export function formatTransferPercent(percent = 0): string {
  // 99.99% must not display as 100% while the transfer is incomplete.
  return `${Math.floor(Math.max(0, Math.min(100, percent)) * 10) / 10}%`;
}

export function updateWaitWarning(state: UpdateState, now: number): string | null {
  const elapsed = Math.max(0, now - (state.lastActivityAt ?? state.stageStartedAt ?? now));
  const seconds = Math.floor(elapsed / 1000);
  if (state.status === 'finalizing' && elapsed >= 30_000) {
    return `传输已达到 100%，但 ${seconds} 秒内尚未收到安装就绪确认。可能仍在校验或保存文件；不能据此认定校验通过。可查看更新日志，或从发布页手动下载安装包。`;
  }
  if (state.status === 'downloading' && elapsed >= 30_000) {
    return `已 ${seconds} 秒没有新增下载数据。正在等待更新源响应；可继续等待，或从发布页手动下载。`;
  }
  if ((state.status === 'available' || state.status === 'checking') && elapsed >= 30_000) {
    return `此阶段已等待 ${seconds} 秒，尚未收到后续进展。可能在读取更新信息、检查缓存或等待网络；可查看更新日志。`;
  }
  if (state.status === 'installing' && elapsed >= 15_000) {
    return `已等待 ${seconds} 秒，Cove 尚未退出。请检查 Windows 是否有安装或权限确认窗口；当前无法确认安装成功，可查看更新日志。`;
  }
  return null;
}

/**
 * 更新详情卡片是否应渲染。空闲、已是最新、更新服务不可用等状态下没有可展示的
 * 内容，必须整块隐藏，避免留下一个空白框。
 */
export function updateHasDetails(state: UpdateState, now: number): boolean {
  return updateStepIndex(state) >= 0 || isUpdateBusy(state.status) ||
    Boolean(updateWaitWarning(state, now)) || state.status === 'error' ||
    Boolean(state.errorDetail);
}
