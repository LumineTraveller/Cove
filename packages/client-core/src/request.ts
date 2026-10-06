/** A small transport port; no Socket.IO, React, DOM or native imports. */
export interface AcknowledgedTransport {
  readonly connected: boolean;
  emit(event: string, ...args: any[]): unknown;
}
export interface RequestOptions {
  timeoutMs?: number;
  timeoutMessage?: (event: string) => string;
  disconnectedMessage?: string;
}
export function request<T = void>(
  transport: AcknowledgedTransport,
  event: string,
  payload?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  if (!transport.connected)
    return Promise.reject(new Error(options.disconnectedMessage ?? '服务器连接已断开，正在重连'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(options.timeoutMessage?.(event) ?? `${event} 请求超时`));
    }, options.timeoutMs ?? 15_000);
    try {
      transport.emit(event, payload, (response: T | { error: unknown }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (response && typeof response === 'object' && 'error' in response) {
          reject(new Error(String(response.error)));
        } else resolve(response as T);
      });
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}
