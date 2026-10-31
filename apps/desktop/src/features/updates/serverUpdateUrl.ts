/** Derive a manual installer link from the explicitly saved update base URL. */
export const SERVER_DOWNLOAD_LINKS_ENABLED = true;

export function getServerDownloadUrl(
  serverUrl: string,
  fileName = 'Cove-Setup.exe',
): string | null {
  try {
    const url = new URL(serverUrl.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    return `${base}/downloads/${encodeURIComponent(fileName)}`;
  } catch {
    return null;
  }
}
