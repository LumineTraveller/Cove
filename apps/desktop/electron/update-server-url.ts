/** HTTP is deliberately unavailable to the renderer; loopback is fixture-only. */
export function normalizeUpdateServerUrl(value: unknown, allowLoopbackHttp = false): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const input = value.trim();
  if (!input) return '';
  try {
    const url = new URL(input);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(allowLoopbackHttp && loopback && url.protocol === 'http:')) ||
        url.username || url.password || input.includes('?') || input.includes('#') ||
        /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(input) || /[\\\u0000-\u0020\u007f]/.test(input)) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
}
