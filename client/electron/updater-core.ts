export interface UpdateInfoLike {
  version: string;
}

export interface DownloadProgressLike {
  percent: number;
}

export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  percent?: number;
  message?: string;
}

export interface LoggerLike {
  info(message?: unknown, ...args: unknown[]): void;
  warn(message?: unknown, ...args: unknown[]): void;
  error(message?: unknown, ...args: unknown[]): void;
}

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  logger: LoggerLike | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface WindowLike {
  isDestroyed(): boolean;
  setProgressBar(progress: number): void;
}

interface TimerLike {
  unref?(): void;
}

export interface AutoUpdaterOptions {
  updater: UpdaterLike;
  isPackaged: boolean;
  getWindow: () => WindowLike | null;
  publishState: (state: UpdateState) => void;
  logger: LoggerLike;
  scheduleOnce?: (callback: () => void, delayMs: number) => TimerLike;
  scheduleRepeating?: (callback: () => void, delayMs: number) => TimerLike;
  clearScheduled?: (timer: TimerLike) => void;
  startupDelayMs?: number;
  checkIntervalMs?: number;
}

export interface AutoUpdaterController {
  enabled: boolean;
  checkNow: () => Promise<UpdateState>;
  getState: () => UpdateState;
  installNow: () => boolean;
  dispose: () => void;
}

const DEFAULT_STARTUP_DELAY_MS = 10_000;
const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;

function setWindowProgress(getWindow: () => WindowLike | null, progress: number): void {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  win.setProgressBar(progress);
}

export function configureAutoUpdater(options: AutoUpdaterOptions): AutoUpdaterController {
  const {
    updater,
    isPackaged,
    getWindow,
    publishState,
    logger,
    scheduleOnce = (callback, delayMs) => setTimeout(callback, delayMs),
    scheduleRepeating = (callback, delayMs) => setInterval(callback, delayMs),
    clearScheduled = timer => clearTimeout(timer as NodeJS.Timeout),
    startupDelayMs = DEFAULT_STARTUP_DELAY_MS,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  } = options;

  let state: UpdateState = isPackaged
    ? { status: 'idle' }
    : { status: 'disabled', message: '开发模式不连接更新服务，请在正式安装版中检查更新。' };
  const setState = (next: UpdateState) => {
    state = next;
    publishState(next);
  };

  if (!isPackaged) {
    return {
      enabled: false,
      checkNow: async () => state,
      getState: () => state,
      installNow: () => false,
      dispose: () => undefined,
    };
  }

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.logger = logger;

  let checking = false;

  const onChecking = () => {
    logger.info('[updater] 正在检查更新');
    setState({ status: 'checking', message: '正在连接更新服务器…' });
  };
  const onAvailable = (info: UpdateInfoLike) => {
    checking = false;
    logger.info(`[updater] 发现新版本 ${info.version}，开始后台下载`);
    setState({ status: 'available', version: info.version, percent: 0, message: '发现新版本，准备下载。' });
  };
  const onNotAvailable = (info: UpdateInfoLike) => {
    checking = false;
    logger.info(`[updater] 当前已是最新版本 ${info.version}`);
    setWindowProgress(getWindow, -1);
    setState({ status: 'not-available', version: info.version, message: '当前已经是最新版本。' });
  };
  const onProgress = (progress: DownloadProgressLike) => {
    const percent = Math.max(0, Math.min(100, Number.isFinite(progress.percent) ? progress.percent : 0));
    setWindowProgress(getWindow, percent / 100);
    setState({ status: 'downloading', version: state.version, percent, message: '正在后台下载更新…' });
  };
  const onDownloaded = (info: UpdateInfoLike) => {
    checking = false;
    setWindowProgress(getWindow, -1);
    logger.info(`[updater] 版本 ${info.version} 下载完成`);
    setState({ status: 'downloaded', version: info.version, percent: 100, message: '更新已下载，重启 Cove 即可安装。' });
  };
  const onCancelled = () => {
    checking = false;
    logger.warn('[updater] 更新下载已取消');
    setWindowProgress(getWindow, -1);
    setState({ status: 'error', version: state.version, message: '更新下载已取消，请重新检查。' });
  };
  const onError = (error: Error) => {
    checking = false;
    logger.error('[updater] 自动更新失败', error);
    setWindowProgress(getWindow, -1);
    setState({ status: 'error', version: state.version, message: error.message || '检查更新失败，请稍后重试。' });
  };

  updater.on('checking-for-update', onChecking);
  updater.on('update-available', onAvailable);
  updater.on('update-not-available', onNotAvailable);
  updater.on('download-progress', onProgress);
  updater.on('update-downloaded', onDownloaded);
  updater.on('update-cancelled', onCancelled);
  updater.on('error', onError);

  const checkNow = async (): Promise<UpdateState> => {
    if (checking || state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded') return state;
    checking = true;
    setState({ status: 'checking', message: '正在连接更新服务器…' });
    try {
      await updater.checkForUpdates();
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      checking = false;
    }
    return state;
  };

  const startupTimer = scheduleOnce(() => void checkNow(), startupDelayMs);
  const intervalTimer = scheduleRepeating(() => void checkNow(), checkIntervalMs);
  startupTimer.unref?.();
  intervalTimer.unref?.();

  const listeners: Array<[string, (...args: any[]) => void]> = [
    ['checking-for-update', onChecking],
    ['update-available', onAvailable],
    ['update-not-available', onNotAvailable],
    ['download-progress', onProgress],
    ['update-downloaded', onDownloaded],
    ['update-cancelled', onCancelled],
    ['error', onError],
  ];

  return {
    enabled: true,
    checkNow,
    getState: () => state,
    installNow: () => {
      if (state.status !== 'downloaded') return false;
      updater.quitAndInstall(true, true);
      return true;
    },
    dispose: () => {
      clearScheduled(startupTimer);
      clearScheduled(intervalTimer);
      if (updater.off) {
        for (const [event, listener] of listeners) updater.off(event, listener);
      }
      setWindowProgress(getWindow, -1);
    },
  };
}
