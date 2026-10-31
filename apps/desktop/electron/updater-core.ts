import { isUpdateBusy, transferPercent, type UpdateDownloadMode, type UpdateState } from './update-state';
import { UPDATE_DOWNLOAD_BASE_URL } from './update-config';
import { normalizeUpdateServerUrl, settingsForServerUrl, type UpdateSettings, type UpdateSettingsResult } from './update-settings';
import { safeDownloadDiagnostic, safeUpdateError } from './update-diagnostics';
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
  id: 'github' | 'cloud';
  label: 'GitHub' | 'Cove 服务器' | '当前服务器' | '更新服务器';
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
  setCheckSignal?(signal: AbortSignal | null): void;
  setDownloadModeListener?(listener: ((mode: UpdateDownloadMode) => void) | null): void;
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
  resolveSources?: (serverUrl: string, signal?: AbortSignal) => Promise<UpdateSourceCandidate[]>;
  saveServerUrl?: (serverUrl: string) => void;
  downloadBaseUrl?: string;
  now?: () => number;
  /** Installation verification/repair owns the maintenance lock while active. */
  isMaintenanceBusy?: () => boolean;
}

export interface AutoUpdaterController {
  enabled: boolean;
  checkNow: () => Promise<UpdateState>;
  checkGithub: () => Promise<UpdateState>;
  checkAutomatically: () => Promise<UpdateState>;
  getSettings: () => UpdateSettings;
  saveSettings: (serverUrl: unknown) => UpdateSettingsResult;
  getState: () => UpdateState;
  installNow: () => boolean;
  /** Suspend before handing another verified installer to the OS; restore on failure. */
  suppressInstallOnQuit: () => () => void;
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
    downloadBaseUrl = UPDATE_DOWNLOAD_BASE_URL,
    saveServerUrl = () => undefined,
    now = Date.now,
    isMaintenanceBusy = () => false,
  } = options;

  let state: UpdateState = isPackaged
    ? { status: 'idle' }
    : { status: 'disabled', message: '开发模式不连接更新服务，请在正式安装版中检查更新。' };
  let disposed = false;
  let configuredServerUrl = normalizeUpdateServerUrl(downloadBaseUrl) ?? '';
  let checkAbort: AbortController | null = null;
  let checkTask: Promise<UpdateState> | null = null;
  const getSettings = () => settingsForServerUrl(configuredServerUrl);
  const saveSettings = (value: unknown): UpdateSettingsResult => {
    const serverUrl = normalizeUpdateServerUrl(value);
    const fail = (error: string) => ({ ok: false, settings: getSettings(), error });
    if (serverUrl === null) return fail('请输入不含凭据、查询参数或片段的 HTTPS 更新服务器地址。');
    if (disposed) return fail('更新服务已关闭。');
    if (serverUrl === configuredServerUrl) return { ok: true, settings: getSettings() };
    if (['available', 'downloading', 'finalizing', 'downloaded', 'installing'].includes(state.status) || retryingDownload || downloadPending) {
      return fail('更新包正在下载、校验或已准备安装，请完成当前更新后再修改服务器。');
    }
    // The Windows adapter can cancel its metadata request. Other platform
    // adapters finish their check first rather than racing an unabortable feed.
    if (checkTask && activeSource && !updater.setCheckSignal) return fail('正在检查更新，请检查结束后再修改服务器。');
    try { saveServerUrl(serverUrl); } catch { return fail('更新服务器地址保存失败，请重试。'); }
    configuredServerUrl = serverUrl;
    checkAbort?.abort();
    sourceGeneration += 1;
    activeSource = undefined;
    setState({ status: isPackaged ? 'idle' : 'disabled', message: serverUrl ? '更新服务器已保存。' : '自动更新已关闭，仍可手动检查 GitHub 更新。' });
    return { ok: true, settings: getSettings() };
  };
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

  let retryingDownload = false;
  let downloadPending = false;
  let activeSource: UpdateSourceCandidate | undefined;
  let sourceGeneration = 0;

  if (!isPackaged) {
    return {
      enabled: false,
      checkNow: async () => state,
      checkGithub: async () => state,
      checkAutomatically: async () => state,
      getSettings,
      saveSettings,
      getState: () => state,
      installNow: () => false,
      suppressInstallOnQuit: () => () => undefined,
      dispose: () => undefined,
    };
  }

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.logger = logger;

  let checking = false;
  let probingSources = false;
  let sources: UpdateSourceCandidate[] = [];
  let sourceIndex = -1;
  let deferredDownloadError: Error | null = null;
  let handledError: Error | null = null;
  let activeDownloadPromise: Promise<unknown> | null = null;

  const obsoleteCheck = () => disposed || checkAbort?.signal.aborted === true;
  const isDownloading = () => ['available', 'downloading', 'finalizing'].includes(state.status);

  // checkForUpdates resolves before its automatic download. Observe the second
  // promise too, including errors that arrive while source discovery is active.
  const observeDownload = (result: UpdateCheckResultLike | null | void, generation: number) => {
    const observed = result?.downloadPromise ?? null;
    activeDownloadPromise = observed;
    downloadPending = observed !== null;
    void observed?.then(() => {
      if (activeDownloadPromise === observed) downloadPending = false;
    }, cause => {
      if (activeDownloadPromise === observed) downloadPending = false;
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
    updater.disableDifferentialDownload = false;
    updater.setFeedURL?.({ provider: 'generic', url: source.feedUrl, useMultipleRangeRequest: false, expectedVersion: source.version });
    logger.info(`[updater] 使用 ${source.label} 更新源 ${source.feedUrl}`);
    logger.info('[updater] 下载方式：优先差分，失败时全量下载');
    return true;
  };

  const onChecking = () => {
    if (obsoleteCheck()) return;
    logger.info('[updater] 正在检查更新');
    setState(stateForSource({ status: 'checking', message: `正在连接${activeSource ? ` ${activeSource.label}` : ''}更新服务器…` }));
  };
  const onAvailable = (info: UpdateInfoLike) => {
    if (obsoleteCheck()) return;
    checking = false;
    logger.info(`[updater] 发现新版本 ${info.version}，开始后台下载`);
    setState(stateForSource({ status: 'available', version: info.version, percent: 0,
      message: activeSource?.id === 'cloud' ? '发现新版本，准备从更新服务器下载。' : '发现新版本，准备下载。',
    }));
  };
  const onNotAvailable = (info: UpdateInfoLike) => {
    if (obsoleteCheck()) return;
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
      downloadMode: state.downloadMode, differentialOutcome: state.differentialOutcome,
      fallbackCode: state.fallbackCode,
      status, version: state.version, percent, transferred, total,
      bytesPerSecond: status === 'downloading' ? finite(progress.bytesPerSecond) : undefined,
      lastActivityAt: changed || status !== state.status ? now() : state.lastActivityAt,
      message: status === 'finalizing'
        ? '当前传输已完成，正在等待更新器完成校验与文件准备；尚不可安装。'
        : '正在传输更新文件，不会中断当前通话。',
    }));
  };
  const onDownloaded = (info: UpdateInfoLike) => {
    if (obsoleteCheck()) return;
    checking = false;
    setWindowProgress(getWindow, -1);
    logger.info(`[updater] 版本 ${info.version} 下载完成`);
    if (disposed) return;
    setState(stateForSource({ status: 'downloaded', version: info.version, percent: 100,
      downloadMode: state.downloadMode, differentialOutcome: state.differentialOutcome,
      fallbackCode: state.fallbackCode,
      transferred: state.transferred, total: state.total,
      message: '更新器已确认安装包就绪。可以立即重启安装，或退出 Cove 时安装。',
    }));
  };
  const onCancelled = () => {
    if (obsoleteCheck()) return;
    checking = false;
    logger.warn('[updater] 更新下载已取消');
    setWindowProgress(getWindow, -1);
    setState(stateForSource({ ...state, status: 'error', failedStage: state.status, message: '更新下载已取消，请重新检查。' }));
  };
  const publishFinalError = (error: Error) => {
    checking = false;
    logger.error('[updater] 自动更新失败', safeUpdateError(error));
    setWindowProgress(getWindow, -1);
    const code = (error as Error & { code?: string }).code;
    setState(stateForSource({ ...state, status: 'error', failedStage: state.status,
      message: state.status === 'finalizing' ? '传输结束，但校验或安装文件准备失败；请重试或手动下载。'
        : state.status === 'installing' ? '无法启动安装，请查看错误详情或手动下载安装。'
        : isDownloading() ? '更新下载失败，请重试或从发布页手动下载。' : '检查更新失败，请检查网络后重试。',
      errorDetail: safeDownloadDiagnostic(error.message || String(error)), errorCode: typeof code === 'string' ? code : undefined,
    }));
  };
  const appendGithubFallback = async () => {
    if (activeSource?.id !== 'cloud' || sources.some(source => source.id === 'github') || obsoleteCheck()) return;
    const fallback = await resolveSources('', checkAbort?.signal);
    if (!obsoleteCheck()) sources.push(...fallback.filter(source => source.id === 'github'));
  };
  const retryDownloadFromFallback = async (initialError: Error) => {
    retryingDownload = true;
    let lastError = initialError;
    try { await appendGithubFallback(); } catch (cause) { logger.warn('[updater] GitHub fallback discovery failed', safeUpdateError(cause instanceof Error ? cause : new Error(String(cause)))); }
    if (obsoleteCheck()) { retryingDownload = false; return; }
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
        logger.warn(`[updater] ${activeSource!.label} 回退源失败`, safeUpdateError(lastError));
      }
    }
    retryingDownload = false;
    deferredDownloadError = null;
    publishFinalError(lastError);
  };
  const onError = (error: Error) => {
    if (obsoleteCheck() || handledError === error) return;
    if (probingSources || retryingDownload) {
      if (isDownloading()) deferredDownloadError = error;
      logger.warn('[updater] 当前更新源失败，准备尝试备用源', safeUpdateError(error));
      return;
    }
    handledError = error;
    if (isDownloading() && (sourceIndex + 1 < sources.length || activeSource?.id === 'cloud')) {
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

  updater.setDownloadModeListener?.(mode => {
    if (disposed || !isDownloading()) return;
    const reset = mode.downloadMode === 'full' && mode.differentialOutcome === 'fallback';
    if (reset) setWindowProgress(getWindow, 2);
    setState(stateForSource({ ...state, ...mode, lastActivityAt: now(),
      ...(reset ? { status: 'available', percent: 0, transferred: undefined, total: undefined, bytesPerSecond: undefined } : {}),
    }));
  });

  updater.on('checking-for-update', onChecking);
  updater.on('update-available', onAvailable);
  updater.on('update-not-available', onNotAvailable);
  updater.on('download-progress', onProgress);
  updater.on('update-downloaded', onDownloaded);
  updater.on('update-cancelled', onCancelled);
  updater.on('error', onError);

  const runCheck = async (githubOnly: boolean): Promise<UpdateState> => {
    if (disposed || checking || retryingDownload || downloadPending || isMaintenanceBusy() || isUpdateBusy(state.status) || state.status === 'downloaded') return state;
    checking = true;
    const attempt = new AbortController();
    checkAbort = attempt;
    updater.setCheckSignal?.(attempt.signal);
    activeSource = undefined;
    handledError = null;
    deferredDownloadError = null;
    setState({ status: 'checking', message: '正在连接更新服务器。' });
    try {
      sources = (await resolveSources(githubOnly ? '' : configuredServerUrl, attempt.signal))
        .filter(source => source.id === 'github' || source.id === 'cloud');
      if (obsoleteCheck()) return state;
      if (!sources.length) throw new Error('更新服务器和 GitHub 均无法访问，请检查网络后重试。');
      probingSources = true;
      let lastError: Error | null = null;
      for (let index = 0; index < sources.length; index += 1) {
        if (obsoleteCheck()) return state;
        selectSource(index);
        setState(stateForSource({ status: 'checking', message: `正在通过 ${activeSource!.label} 检查更新。` }));
        try {
          const generation = sourceGeneration;
          const result = await updater.checkForUpdates();
          if (obsoleteCheck()) return state;
          observeDownload(result, generation);
          lastError = null;
          // A stale server manifest must not conceal a newer GitHub release.
          if (sources[index]?.id === 'cloud' && state.status === 'not-available') {
            await appendGithubFallback();
            if (index + 1 < sources.length) continue;
          }
          break;
        } catch (cause) {
          if (obsoleteCheck()) return state;
          lastError = cause instanceof Error ? cause : new Error(String(cause));
          logger.warn(`[updater] ${activeSource!.label} 检查失败`, safeUpdateError(lastError));
          await appendGithubFallback();
        }
      }
      if (lastError) throw lastError;
    } catch (error) {
      if (!obsoleteCheck()) publishFinalError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      probingSources = false;
      checking = false;
      if (!obsoleteCheck()) flushDeferredError();
    }
    return state;
  };
  const check = async (githubOnly: boolean): Promise<UpdateState> => {
    // A settings change aborts discovery/metadata. Wait for that aborted request
    // to unwind before letting electron-updater reuse its internal check slot.
    if (checkTask) {
      if (!checkAbort?.signal.aborted) return state;
      await checkTask;
      return check(githubOnly);
    }
    const task = runCheck(githubOnly);
    checkTask = task;
    try { return await task; }
    finally { if (checkTask === task) checkTask = null; }
  };
  const checkNow = () => check(false);
  const checkGithub = () => check(true);
  const checkAutomatically = () => {
    if (configuredServerUrl) return checkNow();
    return Promise.resolve(state);
  };

  const startupTimer = scheduleOnce(() => checkAutomatically(), startupDelayMs);
  const intervalTimer = scheduleRepeating(() => checkAutomatically(), checkIntervalMs);
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
    checkGithub,
    checkAutomatically,
    getSettings,
    saveSettings,
    getState: () => state,
    suppressInstallOnQuit: () => {
      const previous = updater.autoInstallOnAppQuit;
      updater.autoInstallOnAppQuit = false;
      let restored = false;
      return () => {
        if (restored) return;
        restored = true;
        updater.autoInstallOnAppQuit = previous;
      };
    },
    installNow: () => {
      if (disposed || isMaintenanceBusy() || state.status !== 'downloaded') return false;
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
      checkAbort?.abort();
      updater.setCheckSignal?.(null);
      updater.setDownloadModeListener?.(null);
      clearScheduled(startupTimer);
      clearScheduled(intervalTimer);
      if (updater.off) {
        for (const [event, listener] of listeners) updater.off(event, listener);
      }
      setWindowProgress(getWindow, -1);
    },
  };
}
