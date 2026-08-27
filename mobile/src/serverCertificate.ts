import { NativeModules, Platform } from 'react-native';

export function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

export async function configureServerCertificate(serverURL: string, enabled: boolean): Promise<void> {
  const origin = enabled ? httpsOrigin(serverURL) : null;
  const configure = NativeModules.CoveNative?.configureServerCertificate;
  if (!configure) {
    if (origin) throw new Error('当前安装包不支持 HTTPS 证书例外，请更新 Android 客户端');
    return;
  }
  if (origin && Platform.OS !== 'android') throw new Error('证书例外目前仅支持 Android');
  await configure(origin ?? '', !!origin);
}
