export function normalizeHttpsOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the certificate exception scoped to one HTTPS origin.  The renderer
 * must configure this policy before opening its Socket.IO connection.
 */
export class ServerCertificatePolicy {
  private allowedOrigin: string | null = null;

  configure(serverUrl: unknown, enabled: unknown): string | null {
    this.allowedOrigin = enabled === true ? normalizeHttpsOrigin(serverUrl) : null;
    return this.allowedOrigin;
  }

  allows(requestUrl: unknown): boolean {
    return this.allowedOrigin !== null && normalizeHttpsOrigin(requestUrl) === this.allowedOrigin;
  }
}
