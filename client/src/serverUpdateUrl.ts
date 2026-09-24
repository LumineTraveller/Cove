/** 手动下载跟随当前输入的服务器；允许本地开发用的 HTTP 地址。 */
export const SERVER_DOWNLOAD_LINKS_ENABLED = true;

export function getServerDownloadUrl(serverUrl: string, fileName = 'Cove-Setup.exe'): string | null {
  try {
    const url = new URL(serverUrl.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    return `${base}/downloads/${encodeURIComponent(fileName)}`;
  } catch {
    return null;
  }
}
