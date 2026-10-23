import path from 'path';
import { URL } from 'url';
import { CancellationError, CancellationToken, type HttpExecutor } from 'builder-util-runtime';
import { NsisUpdater, type Logger, type ResolvedUpdateFileInfo, type UpdateDownloadedEvent } from 'electron-updater';
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater';
import type { InstallOptions } from 'electron-updater/out/BaseUpdater';
import { findFile, parseUpdateInfo, resolveFiles, type Provider } from 'electron-updater/out/providers/Provider';
import { prepareDifferentialBaseline, stageNextBaseline, type BaselineIdentity } from './differential-baseline';
import fs from 'fs';
import { acquireUpdateCacheLock, cacheError, hashStableFile, regularCacheFile, sameFile } from './update-cache-safety';
import type { UpdateDownloadMode } from './update-state';
import { safeDownloadDiagnostic } from './update-diagnostics';
export { safeDownloadDiagnostic } from './update-diagnostics';

const NATIVE_FALLBACK = 'Cannot download differentially, fallback to full download:';

function nativeFallbackCode(detail = ''): string {
  return /sha512|checksum|digest/i.test(detail) ? 'COVE_DIFFERENTIAL_CHECKSUM'
    : /range|content.length|content-range|\b416\b/i.test(detail) ? 'COVE_DIFFERENTIAL_RANGE'
    : /TLS|socket|ECONN|ETIMEDOUT|aborted|connection/i.test(detail) ? 'COVE_DIFFERENTIAL_NETWORK'
    : 'COVE_DIFFERENTIAL_FAILED';
}

// These two runtime fields are used by the protected hooks in 6.8.9 but omitted
// from its published declarations. Keep this narrow adapter covered by the real
// library tests when upgrading electron-updater; never replace its executor.
interface NativeUpdaterRuntime {
  httpExecutor: HttpExecutor<any>;
  configOnDisk: { value: Promise<{ updaterCacheDirName?: string }> };
}

/** Small adaptations around the protected electron-updater 6.8.9 NSIS hooks. */
export class StableNsisUpdater extends NsisUpdater {
  private modeListener: ((mode: UpdateDownloadMode) => void) | null = null;
  private nativeFailure: string | undefined;
  private preparingDownload = false;
  private pendingReady: UpdateDownloadedEvent | null = null;
  private attemptedDifferential = false;
  private readyInstaller: { file: string; stat: fs.Stats } | null = null;

  private get nativeRuntime(): NativeUpdaterRuntime {
    const runtime = this as unknown as NativeUpdaterRuntime;
    if (!runtime.httpExecutor || !runtime.configOnDisk) throw new Error('Unsupported electron-updater runtime hooks');
    return runtime;
  }

  setDownloadModeListener(listener: ((mode: UpdateDownloadMode) => void) | null): void {
    this.modeListener = listener;
  }

  override get logger(): Logger | null { return super.logger; }
  override set logger(logger: Logger | null) {
    super.logger = logger && {
      info: message => logger.info(typeof message === 'string' ? safeDownloadDiagnostic(message) : message),
      warn: message => logger.warn(typeof message === 'string' ? safeDownloadDiagnostic(message) : message),
      error: (message, ...args) => {
        if (typeof message === 'string' && message.startsWith(NATIVE_FALLBACK)) {
          this.nativeFailure = message.slice(NATIVE_FALLBACK.length).trim();
        }
        logger.error(safeDownloadDiagnostic(message));
      },
      debug: logger.debug ? message => logger.debug!(safeDownloadDiagnostic(message)) : undefined,
    };
  }

  private report(mode: UpdateDownloadMode, detail?: string): void {
    // UI receives a stable code and fixed translated reason, never raw stacks,
    // signed redirect URLs, user paths, headers or tokens.
    this._logger.info(`[updater] download mode ${JSON.stringify({ ...mode,
      ...(detail ? { diagnostic: safeDownloadDiagnostic(detail) } : {}) })}`);
    this.modeListener?.(mode);
  }

  private async boundedBuffer(url: URL, options: DownloadUpdateOptions): Promise<Buffer> {
    const cancellationToken = new CancellationToken(options.cancellationToken);
    const timer = setTimeout(() => cancellationToken.cancel(), 10_000);
    timer.unref?.();
    try {
      return await this.nativeRuntime.httpExecutor.downloadToBuffer(url, { headers: options.requestHeaders, cancellationToken });
    } finally { clearTimeout(timer); cancellationToken.dispose(); }
  }

  private async recoverIdentity(oldMapUrl: URL, options: DownloadUpdateOptions): Promise<BaselineIdentity> {
    const manifestUrl = new URL('latest.yml', oldMapUrl);
    const version = this.app.version;
    // Recovery is deliberately narrower than normal mirror downloads. A custom
    // server can use an existing locally verified identity, but cannot bootstrap it.
    const official = manifestUrl.protocol === 'https:' && !manifestUrl.username && !manifestUrl.password &&
      ((manifestUrl.origin === 'https://github.com' && manifestUrl.pathname === `/LumineTraveller/Cove/releases/download/v${version}/latest.yml`) ||
       (manifestUrl.origin === 'https://cove.luxe' && manifestUrl.pathname === `/releases/v${version}/latest.yml`));
    if (!official) throw cacheError('COVE_BASELINE_UNVERIFIED', 'No verified local identity or official versioned recovery source');
    try {
      const data = await this.boundedBuffer(manifestUrl, options);
      if (data.length > 128 * 1024) throw new Error('Installed-release metadata is too large');
      const info = parseUpdateInfo(data.toString('utf8'), 'latest.yml', manifestUrl);
      const expectedInstallerUrl = new URL(oldMapUrl);
      expectedInstallerUrl.pathname = expectedInstallerUrl.pathname.replace(/\.blockmap$/, '');
      expectedInstallerUrl.search = '';
      expectedInstallerUrl.hash = '';
      const file = resolveFiles(info, new URL('.', manifestUrl)).find(item => item.url.href === expectedInstallerUrl.href);
      if (info.version !== version || !file || !Number.isSafeInteger(file.info.size) || file.info.size! <= 0) {
        throw new Error('Installed-release metadata does not identify this installer/version');
      }
      return { schema: 1, version, sha512: file.info.sha512, size: file.info.size! };
    } catch (error) {
      if (options.cancellationToken.cancelled) throw new CancellationError();
      throw cacheError('COVE_BASELINE_UNVERIFIED', `Unable to recover installed-release baseline identity: ${String(error)}`);
    }
  }

  protected override async differentialDownloadInstaller(
    fileInfo: ResolvedUpdateFileInfo, options: DownloadUpdateOptions, installerPath: string,
    provider: Provider<any>, oldInstallerFileName: string,
  ): Promise<boolean> {
    this.attemptedDifferential = true;
    this.nativeFailure = undefined;
    this.report({ downloadMode: 'differential', differentialOutcome: 'in-progress' });
    try {
      const helper = this.downloadedUpdateHelper;
      if (!helper) throw cacheError('COVE_BASELINE_UNVERIFIED', 'Updater cache has not been initialized');
      const [oldMapUrl] = await provider.getBlockMapFiles(fileInfo.url, this.app.version,
        options.updateInfoAndProvider.info.version, this.previousBlockmapBaseUrlOverride);
      const preflightToken = new CancellationToken(options.cancellationToken);
      const timeout = setTimeout(() => preflightToken.cancel(), 20_000);
      timeout.unref?.();
      const preflightOptions = { ...options, cancellationToken: preflightToken };
      try { await prepareDifferentialBaseline({
        cacheDir: helper.cacheDir, installedVersion: this.app.version, installerFileName: oldInstallerFileName,
        recoverIdentity: () => this.recoverIdentity(oldMapUrl, preflightOptions),
        downloadOldBlockmap: () => this.boundedBuffer(oldMapUrl, preflightOptions),
        checkCancelled: () => { if (preflightToken.cancelled) throw new CancellationError(); },
      }); } finally { clearTimeout(timeout); preflightToken.dispose(); }
      // The native planner, Range requests, target SHA512 and full fallback are
      // unchanged. It now receives a verified installed-version cache pair.
      const fallback = await super.differentialDownloadInstaller(fileInfo, options, installerPath, provider, oldInstallerFileName);
      if (options.cancellationToken.cancelled) throw new CancellationError();
      if (fallback) this.report({ downloadMode: 'full', differentialOutcome: 'fallback',
        fallbackCode: nativeFallbackCode(this.nativeFailure) }, this.nativeFailure ?? 'Native differential download requested full transfer');
      else this.report({ downloadMode: 'differential', differentialOutcome: 'completed' });
      return fallback;
    } catch (error) {
      if (options.cancellationToken.cancelled) throw new CancellationError();
      const cause = error as Error & { code?: string };
      this.report({ downloadMode: 'full', differentialOutcome: 'fallback',
        fallbackCode: cause.code ?? 'COVE_BASELINE_UNVERIFIED' }, cause.message ?? String(error));
      return true;
    }
  }

  protected override dispatchUpdateDownloaded(event: UpdateDownloadedEvent): void {
    const helper = this.downloadedUpdateHelper;
    if (!helper?.downloadedFileInfo) throw cacheError('COVE_BASELINE_INVALID', 'Verified installer metadata is missing');
    const staged = stageNextBaseline(helper.cacheDir, { schema: 1, version: event.version,
      sha512: helper.downloadedFileInfo.sha512, size: regularCacheFile(event.downloadedFile).size });
    if (staged.ignoredInvalidMap) this._logger.warn('[updater] COVE_BLOCKMAP_INVALID: optional next blockmap ignored after full installer verification');
    this.pendingReady = event;
  }

  protected override async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    const cacheName = (await this.nativeRuntime.configOnDisk.value).updaterCacheDirName;
    const cacheDir = path.join(this.app.baseCachePath, cacheName || this.app.name);
    const lockAbort = new AbortController();
    const cancelLock = () => lockAbort.abort();
    options.cancellationToken.on('cancel', cancelLock);
    if (options.cancellationToken.cancelled) lockAbort.abort();
    let release: () => Promise<void>;
    try { release = await acquireUpdateCacheLock(cacheDir, lockAbort.signal); }
    catch (error) {
      if (options.cancellationToken.cancelled) throw new CancellationError();
      throw error;
    } finally { options.cancellationToken.off('cancel', cancelLock); }
    this.preparingDownload = true;
    this.readyInstaller = null;
    this.pendingReady = null;
    this.attemptedDifferential = false;
    let completed = false;
    try {
      const files = await super.doDownloadUpdate(options);
      // The native call invokes our virtual dispatch hook; TS cannot observe
      // that mutation across the awaited superclass implementation.
      const event = this.pendingReady as UpdateDownloadedEvent | null;
      if (event) {
        // The native same-instance cache fast path checks only existence. Rehash
        // before readiness so changed cached installers can never bypass SHA512.
        const verified = await hashStableFile(event.downloadedFile, () => {
          if (options.cancellationToken.cancelled) throw new CancellationError();
        });
        const expected = findFile(options.updateInfoAndProvider.provider.resolveFiles(options.updateInfoAndProvider.info), 'exe')?.info;
        if (!expected || verified.sha512 !== expected.sha512) {
          // Invalidate only this corrupt regular pending EXE, so the native fast
          // path cannot repeatedly reuse it. Preserve the installed baseline.
          if (sameFile(verified.stat, regularCacheFile(event.downloadedFile))) fs.unlinkSync(event.downloadedFile);
          throw cacheError('ERR_CHECKSUM_MISMATCH', 'Cached installer SHA512 checksum mismatch before readiness');
        }
        if (expected.size != null && verified.stat.size !== expected.size) {
          throw cacheError('COVE_INSTALLER_SIZE_MISMATCH', 'Installer size does not match the release metadata');
        }
        this.readyInstaller = { file: event.downloadedFile, stat: verified.stat };
      }
      this.preparingDownload = false;
      if (event) {
        if (!this.attemptedDifferential) this.report({ downloadMode: options.disableDifferentialDownload ? 'full' : 'cached' });
        super.dispatchUpdateDownloaded(event);
      }
      completed = true;
      return files;
    } finally {
      if (!completed) this.readyInstaller = null;
      this.preparingDownload = false;
      this.pendingReady = null;
      await release();
    }
  }

  protected override doInstall(options: InstallOptions): boolean {
    if (this.preparingDownload || !this.readyInstaller) {
      this._logger.warn('[updater] Installer handoff blocked while the verified cache is being finalized');
      return false;
    }
    try {
      if (this.installerPath !== this.readyInstaller.file ||
          !sameFile(this.readyInstaller.stat, regularCacheFile(this.readyInstaller.file))) {
        throw cacheError('COVE_INSTALLER_CHANGED', 'Verified installer changed before installation');
      }
    } catch {
      this.readyInstaller = null;
      this.dispatchError(cacheError('COVE_INSTALLER_CHANGED', 'Verified installer changed before installation; download it again'));
      return false;
    }
    return super.doInstall(options);
  }
}
