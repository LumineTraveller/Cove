/** A bounded public diagnostic, safe for updater logs and renderer error details. */
export function safeDownloadDiagnostic(value: unknown): string {
  return String(value).split(/\r?\n/, 1)[0]
    .replace(/https?:\/\/[^\s"<>]+/g, value => {
      try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return '[download URL]'; }
    })
    .replace(/\b[A-Za-z]:[\\/][^'"\r\n]*/g, '[local file]')
    .replace(/\/(?:Users|home)\/[^'"\s]+/g, '[local file]')
    .replace(/\b(?:bearer\s+\S+|(?:token|authorization|signature|credential)\s*[=:]\s*[^\s,;]+)/gi, '[redacted]')
    .slice(0, 512);
}

export function safeUpdateError(error: Error): { message: string; code?: string } {
  const code = (error as NodeJS.ErrnoException).code;
  return { message: safeDownloadDiagnostic(error.message), code: typeof code === 'string' ? code : undefined };
}
