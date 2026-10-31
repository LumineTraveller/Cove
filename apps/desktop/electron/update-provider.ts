import type { OutgoingHttpHeaders } from 'node:http';
import type { URL } from 'node:url';
import { CancellationError, type CancellationToken, type CustomPublishOptions, type UpdateInfo, type WindowsUpdateInfo } from 'builder-util-runtime';
import type { AppUpdater } from 'electron-updater/out/AppUpdater';
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import { isSafeUpdateAssetUrl } from './update-download-transport';

interface UpdateProviderOptions extends CustomPublishOptions {
  url: string;
  expectedVersion?: string;
  getCheckSignal: () => AbortSignal | null;
  /** Only explicitly constructed local fixtures may opt into loopback HTTP. */
  allowLoopbackHttpForTests?: boolean;
  fetchImpl?: typeof fetch;
}

/** Metadata is bounded; native blockmaps, Range reconstruction and digests remain intact. */
export class BoundedUpdateProvider extends GenericProvider {
  private readonly options: UpdateProviderOptions;
  constructor(configuration: CustomPublishOptions, updater: AppUpdater, runtime: ProviderRuntimeOptions) {
    const options = configuration as UpdateProviderOptions;
    super({ provider: 'generic', url: options.url, useMultipleRangeRequest: false }, updater,
      { ...runtime, isUseMultipleRangeRequest: false });
    this.options = options;
  }

  private safeUrl(url: URL): boolean {
    return isSafeUpdateAssetUrl(url, this.options.allowLoopbackHttpForTests === true);
  }

  protected override async httpRequest(url: URL, headers?: OutgoingHttpHeaders | null,
    parent?: CancellationToken): Promise<string | null> {
    const signal = this.options.getCheckSignal();
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    parent?.on('cancel', cancel);
    if (signal?.aborted || parent?.cancelled) cancel();
    const timeout = setTimeout(cancel, 10_000);
    timeout.unref?.();
    try {
      const requestHeaders = new Headers({ 'User-Agent': 'Cove-Updater', 'Cache-Control': 'no-cache' });
      for (const [name, value] of Object.entries(this.createRequestOptions(url, headers).headers ?? {})) {
        if (value !== undefined) requestHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
      }
      const fetchImpl = this.options.fetchImpl ?? fetch;
      let current = url;
      let response: Response;
      for (let redirects = 0; ; redirects++) {
        abort.signal.throwIfAborted();
        if (!this.safeUrl(current)) throw new Error('Update metadata requires HTTPS without credentials');
        response = await fetchImpl(current.href, { headers: requestHeaders, signal: abort.signal, redirect: 'manual' });
        if (response.status < 300 || response.status >= 400) break;
        void response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location || redirects >= 5) throw new Error('Invalid or excessive update metadata redirects');
        const redirected = new globalThis.URL(location, current);
        if (!this.safeUrl(redirected)) throw new Error('Unsafe update metadata redirect');
        if (redirected.origin !== current.origin) {
          requestHeaders.delete('authorization');
          requestHeaders.delete('cookie');
          requestHeaders.delete('x-user-staging-id');
        }
        current = redirected;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error(`Update manifest returned HTTP ${response.status}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty update manifest');
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > 128 * 1024) throw new Error('Update manifest is too large');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      abort.signal.throwIfAborted();
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      parent?.off('cancel', cancel);
    }
  }

  override async getLatestVersion(): Promise<UpdateInfo> {
    const info = await super.getLatestVersion();
    this.rejectWebInstaller(info);
    if (this.options.getCheckSignal()?.aborted) throw new CancellationError();
    if (this.options.expectedVersion && info.version !== this.options.expectedVersion) {
      throw new Error('Release index and installer manifest identify different versions');
    }
    return info;
  }

  private rejectWebInstaller(info: UpdateInfo): void {
    if ((info as WindowsUpdateInfo).packages != null) throw new Error('Cove requires the complete NSIS installer; web installer packages are unsupported');
  }

  override resolveFiles(info: UpdateInfo) {
    this.rejectWebInstaller(info);
    const files = super.resolveFiles(info);
    if (files.some(file => !this.safeUrl(file.url))) throw new Error('Installer URLs require HTTPS without credentials');
    return files;
  }
}
