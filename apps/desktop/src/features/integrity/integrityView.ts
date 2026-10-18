import type {
  InstallationIntegrityIssue,
  InstallationIntegrityState,
  InstallationIntegrityStatus,
} from '../../../electron/integrity-state';

export const INTEGRITY_DETAIL_LIMIT = 20;

export const INTEGRITY_ISSUE_LABELS: Record<InstallationIntegrityIssue['kind'], string> = {
  missing: '缺失',
  modified: '内容不一致',
  unreadable: '无法读取',
  unsafe: '路径异常',
};

export function integrityBusy(status: InstallationIntegrityStatus): boolean {
  return ['checking', 'downloading', 'confirming', 'launching'].includes(status);
}

export function integrityTitle(status: InstallationIntegrityStatus): string {
  switch (status) {
    case 'checking': return '正在检查安装文件';
    case 'healthy': return '安装文件与官方清单一致';
    case 'damaged': return '发现安装文件异常';
    case 'unavailable': return '未能验证安装文件';
    case 'downloading': return '正在下载同版本修复安装包';
    case 'downloaded': return '修复安装包已就绪';
    case 'confirming': return '等待确认退出并修复';
    case 'launching': return '正在启动修复安装程序';
    case 'error': return '操作未完成';
    case 'disabled': return '当前环境不支持检查';
    default: return '检查当前安装文件';
  }
}

export function integrityDescription(state: InstallationIntegrityState): string {
  switch (state.status) {
    case 'checking': return '正在与当前版本的官方文件清单逐项比对，可以取消。';
    case 'healthy': return '本次检查的安装文件未发现缺失或内容差异。';
    case 'damaged': return '可下载官方同版本安装包，退出 Cove 后覆盖安装以修复文件。';
    case 'unavailable': return '未获得可用的官方完整性清单，暂时无法判断安装文件是否完整。旧版本可能尚未提供清单。';
    case 'downloading': return '下载并校验官方同版本 Windows 安装包（NSIS），完成后由你决定何时修复。';
    case 'downloaded': return '安装包已下载并校验。点击“退出并修复”后，还需要在系统对话框中确认。';
    case 'confirming': return '请在确认对话框中选择。取消后会保留已下载的安装包。';
    case 'launching': return 'Cove 将退出，由安装程序修复安装文件。请留意 Windows 安全提示。';
    case 'error': return '请检查网络连接和文件访问权限，然后重试；也可打开官方版本页手动下载。';
    case 'disabled': return '仅 Windows 正式安装版支持应用内检查和修复，开发环境不执行检查。';
    default: return '按需检查当前版本的安装文件，并在需要时下载同版本修复安装包。';
  }
}

/** Display relative installation paths only, even if a malformed bridge state reaches the view. */
export function integrityRelativePath(value: string): string {
  if (!value || value !== value.trim() || value.length > 512 || /[:\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) return '（路径不可显示）';
  const path = value.replace(/\\/g, '/');
  if (/^(?:\/|[a-zA-Z]:|[a-zA-Z][a-zA-Z\d+.-]*:)/.test(path)) return '（路径不可显示）';
  if (path.split('/').some((part) => !part || part === '.' || part === '..')) return '（路径不可显示）';
  return path;
}

export function integrityIssues(state: InstallationIntegrityState): InstallationIntegrityIssue[] {
  return (state.issues ?? []).slice(0, INTEGRITY_DETAIL_LIMIT);
}

export function integrityIssueCount(state: InstallationIntegrityState): number {
  const count = state.issueCount;
  return Math.max(state.issues?.length ?? 0, count != null && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0);
}

export function integrityFileCount(value?: number): string {
  return value != null && Number.isFinite(value) ? Math.max(0, Math.floor(value)).toLocaleString('zh-CN') : '—';
}

export function integrityCheckedTime(value?: number): string {
  if (value == null || !Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) return '尚未检查';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function integrityPercent(state: InstallationIntegrityState): number | undefined {
  const value = state.status === 'checking' && state.totalFiles && state.checkedFiles != null
    ? state.checkedFiles / state.totalFiles * 100
    : state.status === 'downloading' ? state.progress?.percent : undefined;
  return value != null && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined;
}

export function integrityBytes(value?: number): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '未知大小';
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
