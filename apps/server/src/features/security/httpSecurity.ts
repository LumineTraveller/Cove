import express from 'express';

import {
  isClientProtocolSupported,
  isSecureHttpRequest,
  readBearerToken,
  ServerSecurityError,
} from './serverSecurity';

export interface CreateHttpSecurityDependencies {
  readonly serverSecurityEnabled: boolean;
  readonly serverSecurity: {
    status: () => import('./serverSecurity').ServerSecurityStatus;
    bootstrap(
      bootstrapCredential: unknown,
      password: unknown,
      attemptKey?: string,
    ): Promise<{ accessToken: string; expiresAt: number }>;
    unlock(
      password: unknown,
      attemptKey?: string,
    ): Promise<{ accessToken: string; expiresAt: number }>;
    rotate(
      currentPassword: unknown,
      nextPassword: unknown,
      attemptKey?: string,
    ): Promise<{ accessToken: string; expiresAt: number }>;
    accessForToken(token: unknown): import('./serverSecurity').ServerAccessPrincipal | null;
    revokeAll(): void;
  };
}

export function createHttpSecurity(deps: CreateHttpSecurityDependencies) {
  const securityDenied = (res: express.Response, error: ServerSecurityError) => {
    res.status(error.status).json({ error: error.message, code: error.code });
  };

  const outdatedClient = () =>
    new ServerSecurityError(
      426,
      'CLIENT_VERSION_TOO_OLD',
      '客户端版本过旧，无法登录，请升级到最新版本',
    );

  const requireSecureTransport = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!isSecureHttpRequest(req)) {
      securityDenied(
        res,
        new ServerSecurityError(
          426,
          'INSECURE_TRANSPORT',
          '公网连接必须使用 HTTPS，请改用安全的服务器地址',
        ),
      );
      return;
    }
    next();
  };

  const requireServerSecurityEnabled = (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (deps.serverSecurityEnabled) {
      next();
      return;
    }
    securityDenied(
      res,
      new ServerSecurityError(404, 'SERVER_SECURITY_DISABLED', '服务器访问密码功能尚未启用'),
    );
  };

  const requestServerAccessToken = (req: express.Request, allowQueryToken = false) => {
    const headerToken = readBearerToken(req.get('authorization'));
    if (headerToken) return headerToken;
    if (!allowQueryToken) return null;
    const queryToken = req.query.access_token;
    return typeof queryToken === 'string' ? queryToken : null;
  };

  const requireServerAccess = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
    allowQueryToken = false,
  ) => {
    if (!deps.serverSecurityEnabled) {
      next();
      return;
    }
    if (
      !isClientProtocolSupported(
        req.get('x-cove-client-protocol') ??
          (allowQueryToken ? req.query.client_protocol : undefined),
      )
    ) {
      securityDenied(res, outdatedClient());
      return;
    }
    if (!isSecureHttpRequest(req)) {
      securityDenied(
        res,
        new ServerSecurityError(
          426,
          'INSECURE_TRANSPORT',
          '公网连接必须使用 HTTPS，请改用安全的服务器地址',
        ),
      );
      return;
    }
    const token = requestServerAccessToken(req, allowQueryToken);
    if (!deps.serverSecurity.status().configured) {
      securityDenied(
        res,
        new ServerSecurityError(
          503,
          'SERVER_NOT_INITIALIZED',
          '服务器尚未初始化，请先设置服务器访问密码',
        ),
      );
      return;
    }
    if (!deps.serverSecurity.accessForToken(token)) {
      securityDenied(
        res,
        new ServerSecurityError(
          401,
          'SERVER_ACCESS_REQUIRED',
          '需要先验证服务器访问密码，请升级客户端或先完成服务器初始化',
        ),
      );
      return;
    }
    next();
  };
  return {
    securityDenied,
    outdatedClient,
    requireSecureTransport,
    requireServerSecurityEnabled,
    requestServerAccessToken,
    requireServerAccess,
  };
}
