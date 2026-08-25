export interface UpdateInfoLike {
  version: string;
}

export interface DownloadProgressLike {
  percent: number;
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
  notify: (title: string, body: string) => void;
  promptInstall: (version: string) => Promise<boolean>;
  logger: LoggerLike;
  scheduleOnce?: (callback: () => void, delayMs: number) => TimerLike;
  scheduleRepeating?: (callback: () => void, delayMs: number) => TimerLike;
  clearScheduled?: (timer: TimerLike) => void;
  startupDelayMs?: number;
  checkIntervalMs?: number;
}

export interface AutoUpdaterController {
  enabled: boolean;
  checkNow: () => Promise<void>;
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
    notify,
    promptInstall,
    logger,
    scheduleOnce = (callback, delayMs) => setTimeout(callback, delayMs),
    scheduleRepeating = (callback, delayMs) => setInterval(callback, delayMs),
    clearScheduled = timer => clearTimeout(timer as NodeJS.Timeout),
    startupDelayMs = DEFAULT_STARTUP_DELAY_MS,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  } = options;

  if (!isPackaged) {
    return {
      enabled: false,
      checkNow: async () => undefined,
      dispose: () => undefined,
    };
  }

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.logger = logger;

  let checking = false;
  let installPromptOpen = false;

  const onChecking = () => logger.info('[updater] 正在检查更新');
  const onAvailable = (info: UpdateInfoLike) => {
    logger.info(`[updater] 发现新版本 ${info.version}，开始后台下载`);
    notify(`Cove ${info.version} 可用`, '正在后台下载更新，不会中断当前语音或共享。');
  };
  const onNotAvailable = (info: UpdateInfoLike) => {
    logger.info(`[updater] 当前已是最新版本 ${info.version}`);
    setWindowProgress(getWindow, -1);
  };
  const onProgress = (progress: DownloadProgressLike) => {
    const percent = Number.isFinite(progress.percent) ? progress.percent : 0;
    setWindowProgress(getWindow, Math.max(0, Math.min(1, percent / 100)));
  };
  const onDownloaded = async (info: UpdateInfoLike) => {
    setWindowProgress(getWindow, -1);
    if (installPromptOpen) return;
    installPromptOpen = true;
    try {
      logger.info(`[updater] 版本 ${info.version} 下载完成`);
      const restartNow = await promptInstall(info.version);
      if (restartNow) updater.quitAndInstall(true, true);
    } catch (error) {
      logger.error('[updater] 显示安装提示失败', error);
    } finally {
      installPromptOpen = false;
    }
  };
  const onCancelled = () => {
    logger.warn('[updater] 更新下载已取消');
    setWindowProgress(getWindow, -1);
  };
  const onError = (error: Error) => {
    logger.error('[updater] 自动更新失败', error);
    setWindowProgress(getWindow, -1);
  };

  updater.on('checking-for-update', onChecking);
  updater.on('update-available', onAvailable);
  updater.on('update-not-available', onNotAvailable);
  updater.on('download-progress', onProgress);
  updater.on('update-downloaded', onDownloaded);
  updater.on('update-cancelled', onCancelled);
  updater.on('error', onError);

  const checkNow = async () => {
    if (checking) return;
    checking = true;
    try {
      await updater.checkForUpdates();
    } catch (error) {
      logger.error('[updater] 检查更新请求失败', error);
    } finally {
      checking = false;
    }
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
