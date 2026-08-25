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
  source?: 'github' | 'gitee';
  sourceLabel?: 'GitHub' | 'Gitee';
}

export interface UpdateSourceCandidate {
  id: 'github' | 'gitee';
  label: 'GitHub' | 'Gitee';
  version: string;
  feedUrl: string;
  latencyMs: number;
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
  setFeedURL?(options: any): void;
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
  resolveSources?: () => Promise<UpdateSourceCandidate[]>;
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
    resolveSources = async () => [],
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
  let probingSources = false;
  let retryingDownload = false;
  let sources: UpdateSourceCandidate[] = [];
  let sourceIndex = -1;
  let activeSource: UpdateSourceCandidate | undefined;

  const stateForSource = (next: UpdateState): UpdateState => activeSource
    ? { ...next, source: activeSource.id, sourceLabel: activeSource.label }
    : next;

  const selectSource = (index: number) => {
    const source = sources[index];
    if (!source) return false;
    sourceIndex = index;
    activeSource = source;
    updater.setFeedURL?.({ provider: 'generic', url: source.feedUrl, useMultipleRangeRequest: false });
    logger.info(`[updater] 使用 ${source.label} 更新源 ${source.feedUrl}`);
    return true;
  };

  const onChecking = () => {
    logger.info('[updater] 正在检查更新');
    setState(stateForSource({ status: 'checking', message: `正在连接${activeSource ? ` ${activeSource.label}` : ''}更新服务器…` }));
  };
  const onAvailable = (info: UpdateInfoLike) => {
    checking = false;
    logger.info(`[updater] 发现新版本 ${info.version}，开始后台下载`);
    setState(stateForSource({ status: 'available', version: info.version, percent: 0, message: '发现新版本，准备下载。' }));
  };
  const onNotAvailable = (info: UpdateInfoLike) => {
    checking = false;
    logger.info(`[updater] 当前已是最新版本 ${info.version}`);
    setWindowProgress(getWindow, -1);
    setState(stateForSource({ status: 'not-available', version: info.version, message: '当前已经是最新版本。' }));
  };
  const onProgress = (progress: DownloadProgressLike) => {
    const percent = Math.max(0, Math.min(100, Number.isFinite(progress.percent) ? progress.percent : 0));
    setWindowProgress(getWindow, percent / 100);
    setState(stateForSource({ status: 'downloading', version: state.version, percent, message: '正在后台下载更新…' }));
  };
  const onDownloaded = (info: UpdateInfoLike) => {
    checking = false;
    setWindowProgress(getWindow, -1);
    logger.info(`[updater] 版本 ${info.version} 下载完成`);
    setState(stateForSource({ status: 'downloaded', version: info.version, percent: 100, message: '更新已下载，重启 Cove 即可安装。' }));
  };
  const onCancelled = () => {
    checking = false;
    logger.warn('[updater] 更新下载已取消');
    setWindowProgress(getWindow, -1);
    setState(stateForSource({ status: 'error', version: state.version, message: '更新下载已取消，请重新检查。' }));
  };
  const publishFinalError = (error: Error) => {
    checking = false;
    logger.error('[updater] 自动更新失败', error);
    setWindowProgress(getWindow, -1);
    setState(stateForSource({ status: 'error', version: state.version, message: error.message || '检查更新失败，请稍后重试。' }));
  };
  const retryDownloadFromFallback = async (initialError: Error) => {
    retryingDownload = true;
    let lastError = initialError;
    while (selectSource(sourceIndex + 1)) {
      checking = true;
      setState(stateForSource({ status: 'checking', version: state.version, message: `下载失败，正在自动切换到 ${activeSource!.label}…` }));
      try {
        await updater.checkForUpdates();
        retryingDownload = false;
        return;
      } catch (cause) {
        lastError = cause instanceof Error ? cause : new Error(String(cause));
        logger.warn(`[updater] ${activeSource!.label} 回退源失败`, lastError);
      }
    }
    retryingDownload = false;
    publishFinalError(lastError);
  };
  const onError = (error: Error) => {
    if (probingSources || retryingDownload) {
      logger.warn('[updater] 当前更新源失败，准备尝试备用源', error);
      return;
    }
    if ((state.status === 'available' || state.status === 'downloading') && sourceIndex + 1 < sources.length) {
      void retryDownloadFromFallback(error);
      return;
    }
    publishFinalError(error);
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
      sources = await resolveSources();
      if (!sources.length) throw new Error('GitHub 与 Gitee 更新源均无法访问，请检查网络后重试。');
      probingSources = true;
      let lastError: Error | null = null;
      for (let index = 0; index < sources.length; index += 1) {
        selectSource(index);
        setState(stateForSource({ status: 'checking', message: `正在通过 ${activeSource!.label} 检查更新…` }));
        try {
          await updater.checkForUpdates();
          lastError = null;
          break;
        } catch (cause) {
          lastError = cause instanceof Error ? cause : new Error(String(cause));
          logger.warn(`[updater] ${activeSource!.label} 检查失败`, lastError);
        }
      }
      if (lastError) throw lastError;
    } catch (error) {
      publishFinalError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      probingSources = false;
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
