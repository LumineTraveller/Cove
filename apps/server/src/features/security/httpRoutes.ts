import express from 'express';
import {clientUpgradePolicy, requestClientIdentity} from './clientVersion';

import {
  isSecureHttpRequest,
  readBearerToken,
  requestAttemptKey,
  securityErrorResponse,
  ServerSecurityError,
} from './serverSecurity';

export interface RegisterSecurityRoutesDependencies {
  readonly app: import('express-serve-static-core').Express;
  readonly serverSecurityEnabled: boolean;
  readonly securityDenied: (res: express.Response, error: ServerSecurityError) => void;
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
  readonly requireServerSecurityEnabled: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => void;
  readonly requireSecureTransport: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => void;
  readonly requireServerAccess: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
    allowQueryToken?: boolean,
  ) => void;
}

export function registerSecurityRoutes(deps: RegisterSecurityRoutesDependencies) {
  deps.app.get('/api/security/status', (req, res) => {
    const bearer = readBearerToken(req.get('authorization'));
    // A public status probe is safe over plaintext, but never accept a bearer
    // token there: the token would otherwise be exposed while merely checking
    // whether it is still valid.
    if (deps.serverSecurityEnabled && bearer && !isSecureHttpRequest(req)) {
      deps.securityDenied(
        res,
        new ServerSecurityError(
          426,
          'INSECURE_TRANSPORT',
          '公网连接必须使用 HTTPS，请改用安全的服务器地址',
        ),
      );
      return;
    }
    const current = deps.serverSecurity.status();
    const identity = requestClientIdentity(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      enabled: deps.serverSecurityEnabled,
      ...current,
      authorized: deps.serverSecurityEnabled && !!deps.serverSecurity.accessForToken(bearer),
      secureTransportRequired: deps.serverSecurityEnabled && !isSecureHttpRequest(req),
      ...clientUpgradePolicy(identity.version, identity.platform, identity.protocol),
    });
  });

  deps.app.post(
    '/api/security/bootstrap',
    deps.requireServerSecurityEnabled,
    deps.requireSecureTransport,
    async (req, res) => {
      const body = req.body as { bootstrapToken?: unknown; password?: unknown } | undefined;
      if (typeof body?.bootstrapToken !== 'string' || typeof body.password !== 'string') {
        res
          .status(400)
          .json({ error: '请填写一次性初始化凭据和服务器访问密码', code: 'INVALID_REQUEST' });
        return;
      }
      try {
        const result = await deps.serverSecurity.bootstrap(
          body.bootstrapToken,
          body.password,
          requestAttemptKey(req, 'bootstrap'),
        );
        res.status(201).json(result);
      } catch (error) {
        securityErrorResponse(error, res);
      }
    },
  );

  deps.app.post(
    '/api/security/access',
    deps.requireServerSecurityEnabled,
    deps.requireSecureTransport,
    async (req, res) => {
      const password = req.body?.password;
      if (typeof password !== 'string') {
        res.status(400).json({ error: '请填写服务器访问密码', code: 'INVALID_REQUEST' });
        return;
      }
      try {
        const result = await deps.serverSecurity.unlock(password, requestAttemptKey(req, 'access'));
        res.json(result);
      } catch (error) {
        securityErrorResponse(error, res);
      }
    },
  );

  deps.app.post(
    '/api/security/rotate',
    deps.requireServerSecurityEnabled,
    deps.requireSecureTransport,
    (req, res, next) => {
      deps.requireServerAccess(req, res, next);
    },
    async (req, res) => {
      const body = req.body as { currentPassword?: unknown; newPassword?: unknown } | undefined;
      if (typeof body?.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
        res
          .status(400)
          .json({ error: '请填写当前密码和新的服务器访问密码', code: 'INVALID_REQUEST' });
        return;
      }
      try {
        const result = await deps.serverSecurity.rotate(
          body.currentPassword,
          body.newPassword,
          requestAttemptKey(req, 'rotate'),
        );
        res.json(result);
      } catch (error) {
        securityErrorResponse(error, res);
      }
    },
  );
  return {};
}
