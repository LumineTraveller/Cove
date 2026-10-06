import type express from 'express';
import {CLIENT_PROTOCOL_VERSION, CLIENT_RELEASE_VERSIONS, COVE_RELEASE_VERSION, MINIMUM_CLIENT_VERSION, isSupportedClientVersion, minimumClientVersionForPlatform} from '@cove/contracts';

export function isClientIdentitySupported(version: unknown, platform: unknown, protocol: unknown): boolean {
  const minimum = minimumClientVersionForPlatform(platform);
  return minimum !== null && isSupportedClientVersion(version, minimum)
    && (protocol === CLIENT_PROTOCOL_VERSION || protocol === String(CLIENT_PROTOCOL_VERSION));
}

export function clientUpgradePolicy(version: unknown, platform: unknown, protocol?: unknown) {
  const clientPlatform = platform === 'desktop' || platform === 'mobile' ? platform : null;
  const releaseVersion = clientPlatform ? CLIENT_RELEASE_VERSIONS[clientPlatform] : CLIENT_RELEASE_VERSIONS.desktop;
  const tag = clientPlatform === 'mobile' ? `mobile-v${releaseVersion}` : `v${releaseVersion}`;
  const downloadUrl = `https://github.com/LumineTraveller/Cove/releases/tag/${tag}`;
  return {
    serverVersion: COVE_RELEASE_VERSION,
    clientPlatform,
    releaseVersion,
    minimumClientVersion: minimumClientVersionForPlatform(platform) ?? MINIMUM_CLIENT_VERSION,
    requiredClientProtocol: CLIENT_PROTOCOL_VERSION,
    upgradeRequired: !isClientIdentitySupported(version, platform, protocol),
    downloadUrl,
  };
}

export function requestClientIdentity(req: express.Request, allowQuery = false) {
  return {
    version: req.get('x-cove-client-version') ?? (allowQuery ? req.query.client_version : undefined),
    platform: req.get('x-cove-client-platform') ?? (allowQuery ? req.query.client_platform : undefined),
    protocol: req.get('x-cove-client-protocol') ?? (allowQuery ? req.query.client_protocol : undefined),
  };
}

export function clientUpgradeError(version: unknown, platform: unknown, protocol?: unknown) {
  const policy = clientUpgradePolicy(version, platform, protocol);
  return {
    code: 'CLIENT_VERSION_TOO_OLD',
    error: `客户端需要升级到 ${policy.minimumClientVersion} 或更新的正式版本才能连接。请先检查并下载更新：${policy.downloadUrl}。手机旧版需要点击下载并确认安装。`,
    ...policy,
  };
}

export function requireClientVersion(req: express.Request, res: express.Response, next: express.NextFunction) {
  const {version, platform, protocol} = requestClientIdentity(req);
  if (isClientIdentitySupported(version, platform, protocol)) { next(); return; }
  res.setHeader('Cache-Control','no-store');
  res.status(426).json(clientUpgradeError(version, platform, protocol));
}
