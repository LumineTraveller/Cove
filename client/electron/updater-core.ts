import { isUpdateBusy, transferPercent, type UpdateState } from './update-state';
export type { UpdateState, UpdateStatus } from './update-state';

export interface UpdateInfoLike {
  version: string;
  downloadedFile?: string;
}

export interface DownloadProgressLike {
  percent: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

export interface UpdateCheckResultLike {
  downloadPromise?: Promise<unknown> | null;
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
  disableDifferentialDownload: boolean;
  logger: LoggerLike | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  setFeedURL?(options: any): void;
  checkForUpdates(): Promise<UpdateCheckResultLike | null | void>;
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
  onInstallerReady?: (info: UpdateInfoLike, source?: UpdateSourceCandidate['id']) => void;
  now?: () => number;
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
    onInstallerReady,
    now = Date.now,
  } = options;

  let state: UpdateState = isPackaged
    ? { status: 'idle' }
    : { status: 'disabled', message: '开发模式不连接更新服务，请在正式安装版中检查更新。' };
  let disposed = false;
  const setState = (next: UpdateState) => {
    if (disposed) return;
    const changed = next.status !== state.status || next.source !== state.source;
    const stageStartedAt = changed ? now() : state.stageStartedAt ?? now();
    if (changed) logger.info(`[updater] 阶段 ${state.status} → ${next.status}`, {
      source: next.source, version: next.version, previousStageMs: state.stageStartedAt == null ? 0 : now() - state.stageStartedAt,
    });
    state = { ...next, stageStartedAt, lastActivityAt: changed ? stageStartedAt : next.lastActivityAt ?? stageStartedAt };
    publishState(state);
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
  let sourceGeneration = 0;
  let deferredDownloadError: Error | null = null;
  let handledError: Error | null = null;
  let activeDownloadPromise: Promise<unknown> | null = null;

  const isDownloading = () => ['available', 'downloading', 'finalizing'].includes(state.status);

  // checkForUpdates resolves before its automatic download. Observe the second
  // promise too, including errors that arrive while source discovery is active.
  const observeDownload = (result: UpdateCheckResultLike | null | void, generation: number) => {
    activeDownloadPromise = result?.downloadPromise ?? null;
    void activeDownloadPromise?.catch(cause => {
      if (disposed || generation !== sourceGeneration || !isDownloading()) return;
      onError(cause instanceof Error ? cause : new Error(String(cause)));
    });
  };

  const stateForSource = (next: UpdateState): UpdateState => activeSource
    ? { ...next, source: activeSource.id, sourceLabel: activeSource.label }
    : next;

  const selectSource = (index: number) => {
    const source = sources[index];
    if (!source) return false;
    sourceIndex = index;
    sourceGeneration += 1;
    deferredDownloadError = null;
    activeDownloadPromise = null;
    activeSource = source;
    // Gitee's attachment redirect can ignore Range and return the entire EXE.
    // Disabling multi-range requests alone still leaves single-range diffs on.
    updater.disableDifferentialDownload = source.id === 'gitee';
    updater.setFeedURL?.({ provider: 'generic', url: source.feedUrl, useMultipleRangeRequest: false });
    logger.info(`[updater] 使用 ${source.label} 更新源 ${source.feedUrl}`);
    logger.info(`[updater] 下载方式：${updater.disableDifferentialDownload ? '全量安装包（禁用差分）' : '优先差分，失败时全量下载'}`);
    return true;
  };

  const onChecking = () => {
    logger.info('[updater] 正在检查更新');
    setState(stateForSource({ status: 'checking', message: `正在连接${activeSource ? ` ${activeSource.label}` : ''}更新服务器…` }));
  };
  const onAvailable = (info: UpdateInfoLike) => {
    checking = false;
    logger.info(`[updater] 发现新版本 ${info.version}，开始后台下载`);
    setState(stateForSource({ status: 'available', version: info.version, percent: 0,
      message: activeSource?.id === 'gitee' ? '发现新版本，准备从 Gitee 下载完整安装包。' : '发现新版本，准备下载。',
    }));
  };
  const onNotAvailable = (info: UpdateInfoLike) => {
    checking = false;
    logger.info(`[updater] 当前已是最新版本 ${info.version}`);
    setWindowProgress(getWindow, -1);
    setState(stateForSource({ status: 'not-available', version: info.version, message: '当前已经是最新版本。' }));
  };
  const onProgress = (progress: DownloadProgressLike) => {
    if (disposed || !isDownloading()) return;
    const percent = transferPercent(progress);
    const finite = (value: number | undefined) => value != null && Number.isFinite(value) && value >= 0 ? value : undefined;
    const transferred = finite(progress.transferred);
    const total = finite(progress.total);
    const changed = transferred != null && state.transferred != null
      ? transferred !== state.transferred || total !== state.total
      : percent !== state.percent;
    const status = percent >= 100 ? 'finalizing' : 'downloading';
    setWindowProgress(getWindow, status === 'finalizing' ? 2 : percent / 100);
    setState(stateForSource({
      status, version: state.version, percent, transferred, total,
      bytesPerSecond: status === 'downloading' ? finite(progress.bytesPerSecond) : undefined,
      lastActivityAt: changed || status !== state.status ? now() : state.lastActivityAt,
      message: status === 'finalizing'
        ? '当前传输已完成，正在等待更新器完成校验与文件准备；尚不可安装。'
        : '正在传输更新文件，不会中断当前通话。',
    }));
  };
  const onDownloaded = (info: UpdateInfoLike) => {
    checking = false;
    setWindowProgress(getWindow, -1);
    logger.info(`[updater] 版本 ${info.version} 下载完成`);
    if (disposed) return;
    // Persist cleanup eligibility only after electron-updater has validated the
    // package, and before the renderer can request installation.
    try { onInstallerReady?.(info, activeSource?.id); }
    catch (error) { logger.warn('[updater] 无法记录安装后清理任务，保留安装包', error); }
    setState(stateForSource({ status: 'downloaded', version: info.version, percent: 100,
      transferred: state.transferred, total: state.total,
      message: '更新器已确认安装包就绪。可以立即重启安装，或退出 Cove 时安装。' +
        (activeSource?.id === 'gitee' ? '新版本启动成功后自动清理本次安装包缓存。' : ''),
    }));
  };
  const onCancelled = () => {
    checking = false;
    logger.warn('[updater] 更新下载已取消');
    setWindowProgress(getWindow, -1);
    setState(stateForSource({ ...state, status: 'error', failedStage: state.status, message: '更新下载已取消，请重新检查。' }));
  };
  const publishFinalError = (error: Error) => {
    checking = false;
    logger.error('[updater] 自动更新失败', error);
    setWindowProgress(getWindow, -1);
    const code = (error as Error & { code?: string }).code;
    setState(stateForSource({ ...state, status: 'error', failedStage: state.status,
      message: state.status === 'finalizing' ? '传输结束，但校验或安装文件准备失败；请重试或手动下载。'
        : state.status === 'installing' ? '无法启动安装，请查看错误详情或手动下载安装。'
        : isDownloading() ? '更新下载失败，请重试或从发布页手动下载。' : '检查更新失败，请检查网络后重试。',
      errorDetail: error.message || String(error), errorCode: typeof code === 'string' ? code : undefined,
    }));
  };
  const retryDownloadFromFallback = async (initialError: Error) => {
    retryingDownload = true;
    let lastError = initialError;
    while (selectSource(sourceIndex + 1)) {
      checking = true;
      setState(stateForSource({ status: 'checking', version: state.version, message: `下载失败，正在自动切换到 ${activeSource!.label}…` }));
      try {
        observeDownload(await updater.checkForUpdates(), sourceGeneration);
        retryingDownload = false;
        flushDeferredError();
        return;
      } catch (cause) {
        lastError = cause instanceof Error ? cause : new Error(String(cause));
        logger.warn(`[updater] ${activeSource!.label} 回退源失败`, lastError);
      }
    }
    retryingDownload = false;
    deferredDownloadError = null;
    publishFinalError(lastError);
  };
  const onError = (error: Error) => {
    if (disposed || handledError === error) return;
    if (probingSources || retryingDownload) {
      if (isDownloading()) deferredDownloadError = error;
      logger.warn('[updater] 当前更新源失败，准备尝试备用源', error);
      return;
    }
    handledError = error;
    if (isDownloading() && sourceIndex + 1 < sources.length) {
      // Let electron-updater finish clearing its rejected download promise before
      // starting another source, or it may return the previous failed download.
      retryingDownload = true;
      void (activeDownloadPromise?.catch(() => undefined) ?? Promise.resolve()).then(() => {
        retryingDownload = false;
        deferredDownloadError = null;
        if (!disposed) return retryDownloadFromFallback(error);
      }).catch(publishFinalError);
      return;
    }
    publishFinalError(error);
  };
  const flushDeferredError = () => {
    const error = deferredDownloadError;
    deferredDownloadError = null;
    if (error) onError(error);
  };

  updater.on('checking-for-update', onChecking);
  updater.on('update-available', onAvailable);
  updater.on('update-not-available', onNotAvailable);
  updater.on('download-progress', onProgress);
  updater.on('update-downloaded', onDownloaded);
  updater.on('update-cancelled', onCancelled);
  updater.on('error', onError);

  const checkNow = async (): Promise<UpdateState> => {
    if (disposed || checking || isUpdateBusy(state.status) || state.status === 'downloaded') return state;
    checking = true;
    activeSource = undefined;
    handledError = null;
    deferredDownloadError = null;
    setState({ status: 'checking', message: '正在连接更新服务器…' });
    try {
      sources = await resolveSources();
      if (disposed) return state;
      if (!sources.length) throw new Error('GitHub 与 Gitee 更新源均无法访问，请检查网络后重试。');
      probingSources = true;
      let lastError: Error | null = null;
      for (let index = 0; index < sources.length; index += 1) {
        selectSource(index);
        setState(stateForSource({ status: 'checking', message: `正在通过 ${activeSource!.label} 检查更新…` }));
        try {
          observeDownload(await updater.checkForUpdates(), sourceGeneration);
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
      flushDeferredError();
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
      if (disposed || state.status !== 'downloaded') return false;
      setState(stateForSource({ ...state, status: 'installing', message: '正在请求启动安装并退出 Cove。安装将中断通话；此处不代表已经安装成功。' }));
      try {
        updater.quitAndInstall(true, true);
        return (state as UpdateState).status === 'installing';
      } catch (cause) {
        onError(cause instanceof Error ? cause : new Error(String(cause)));
        return false;
      }
    },
    dispose: () => {
      disposed = true;
      clearScheduled(startupTimer);
      clearScheduled(intervalTimer);
      if (updater.off) {
        for (const [event, listener] of listeners) updater.off(event, listener);
      }
      setWindowProgress(getWindow, -1);
    },
  };
}
