export const SERVER_CERTIFICATE_EXCEPTION_KEY = 'cove_server_certificate_exception_origin';

export function normalizeHttpsOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function hasServerCertificateException(serverUrl: string, storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  const origin = normalizeHttpsOrigin(serverUrl);
  return origin !== null && storage.getItem(SERVER_CERTIFICATE_EXCEPTION_KEY) === origin;
}

export function saveServerCertificateException(
  serverUrl: string,
  enabled: boolean,
  storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage,
): void {
  const origin = enabled ? normalizeHttpsOrigin(serverUrl) : null;
  if (origin) storage.setItem(SERVER_CERTIFICATE_EXCEPTION_KEY, origin);
  else storage.removeItem(SERVER_CERTIFICATE_EXCEPTION_KEY);
}
