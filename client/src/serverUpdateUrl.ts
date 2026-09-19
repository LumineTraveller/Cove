/**
 * 是否在界面上暴露由服务器地址派生的下载入口（更新中心「当前服务器下载」、
 * 关于页「下载站」）。
 *
 * 目前服务端还没有托管 `/downloads/Cove-Setup.exe` 与 `/releases/*`，
 * 打开这些入口只会得到 404。等服务器端适配完成后把这里改成 `true` 即可，
 * 无需改动任何调用点。
 */
export const SERVER_DOWNLOAD_LINKS_ENABLED = false;

/**
 * Build the stable manual-download URL from the server selected by the user.
 * Unlike the updater's source resolver, this helper allows HTTP so local
 * development servers can still expose a useful link; automatic updates only
 * accept HTTPS in the Electron process.
 */
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
