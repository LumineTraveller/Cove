import type * as BetterSqlite3 from 'better-sqlite3';

import { Server, type Socket } from 'socket.io';

import path from 'path';

import fs from 'fs';
import { randomBytes } from 'crypto';

import { createAccountStore } from '../accounts/accountAuth';

import { createServerSecurityStore } from './serverSecurity';

export interface CreateSecurityServicesDependencies {
  readonly dataDir: string;
  readonly db: BetterSqlite3.Database;
  readonly serverSecurityEnabled: boolean;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly disconnectForInvalidServerAccess: (targetSocket: Socket) => void;
}

export function createSecurityServices(deps: CreateSecurityServicesDependencies) {
  const bootstrapTokenFile =
    process.env.COVE_BOOTSTRAP_TOKEN_FILE?.trim() || path.join(deps.dataDir, 'bootstrap-token.txt');

  const securityWasConfigured = (() => {
    try {
      const row = deps.db.prepare('SELECT passwordHash FROM server_security WHERE id = 1').get() as
        | { passwordHash?: string | null }
        | undefined;
      return !!row?.passwordHash;
    } catch {
      return false;
    }
  })();

  const loadBootstrapToken = (): string | undefined => {
    const configured = process.env.COVE_BOOTSTRAP_TOKEN?.trim();
    if (configured) return configured;
    try {
      const fromFile = fs.readFileSync(bootstrapTokenFile, 'utf8').trim();
      if (fromFile) return fromFile;
    } catch {
      /* A new local server may need a generated credential. */
    }
    if (securityWasConfigured || process.env.COVE_BOOTSTRAP_TOKEN_FILE?.trim()) return undefined;
    const generated = randomBytes(32).toString('base64url');
    try {
      fs.writeFileSync(bootstrapTokenFile, `${generated}\n`, { flag: 'wx', mode: 0o600 });
      return generated;
    } catch {
      try {
        const existing = fs.readFileSync(bootstrapTokenFile, 'utf8').trim();
        return existing || undefined;
      } catch {
        return undefined;
      }
    }
  };

  const bootstrapToken = deps.serverSecurityEnabled ? loadBootstrapToken() : undefined;

  const serverSecurity = createServerSecurityStore(deps.db, {
    bootstrapToken,
    onBootstrapConsumed: () => {
      if (process.env.COVE_BOOTSTRAP_TOKEN?.trim()) return;
      try {
        fs.rmSync(bootstrapTokenFile, { force: true });
      } catch {
        /* best effort */
      }
    },
    onAccessTokensRevoked: () => {
      // Password rotation must stop already-connected clients from continuing
      // to receive room traffic with a token that is no longer valid.
      if (deps.serverSecurityEnabled)
        for (const targetSocket of deps.io.sockets.sockets.values())
          deps.disconnectForInvalidServerAccess(targetSocket);
    },
  });

  const accounts = createAccountStore(deps.db);
  return {
    bootstrapTokenFile,
    securityWasConfigured,
    loadBootstrapToken,
    bootstrapToken,
    serverSecurity,
    accounts,
  };
}
