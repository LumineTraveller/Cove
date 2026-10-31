import type { HttpExecutor } from 'builder-util-runtime';
import type { RequestOptions } from 'node:http';

const guarded = new WeakSet<object>();
const redirectDepth = Symbol('coveUpdateRedirectDepth');

export function isSafeUpdateAssetUrl(url: URL, allowLoopbackHttp = false): boolean {
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  return !url.username && !url.password && !url.hash &&
    (url.protocol === 'https:' || (allowLoopbackHttp && loopback && url.protocol === 'http:'));
}

/** Guard the existing executor's request hooks, retaining its Range and digest implementation. */
export function guardUpdateDownloadTransport(executor: HttpExecutor<any>, allowLoopbackHttp = false): void {
  if (guarded.has(executor)) return;
  guarded.add(executor);
  const runtime = executor as any;
  const createRequest = runtime.createRequest;
  const addRedirectHandlers = runtime.addRedirectHandlers;
  runtime.addRedirectHandlers = function(request: any, options: any, reject: any, count: number, handler: any) {
    return addRedirectHandlers.call(this, request, options, reject, count, (next: any) => {
      next[redirectDepth] = (options[redirectDepth] ?? 0) + 1;
      handler(next);
    });
  };
  runtime.createRequest = function(options: RequestOptions & { [redirectDepth]?: number }, callback: any) {
    const protocol = options.protocol ?? 'https:';
    const hostname = options.hostname ?? options.host ?? '';
    const initial = new URL(`${protocol}//${hostname}${options.port ? `:${options.port}` : ''}/`);
    if (options.auth || !isSafeUpdateAssetUrl(initial, allowLoopbackHttp) || (options[redirectDepth] ?? 0) > 5) {
      throw new Error('Unsafe or excessive update download redirects');
    }
    const request = createRequest.call(this, options, callback);
    const on = request.on;
    let redirects = options[redirectDepth] ?? 0;
    // DifferentialDownloader follows redirects on the SAME request, bypassing
    // addRedirectHandlers. Guard both paths before their original listener runs.
    request.on = function(event: string, listener: (...args: any[]) => void) {
      if (event !== 'redirect') return on.call(this, event, listener);
      return on.call(this, event, (...args: any[]) => {
        let safe = false;
        try { safe = ++redirects <= 5 && isSafeUpdateAssetUrl(new URL(args[2]), allowLoopbackHttp); } catch { /* reject */ }
        if (!safe) {
          request.abort();
          request.emit('error', new Error('Unsafe or excessive update download redirects'));
          return;
        }
        listener(...args);
      });
    };
    return request;
  };
}
