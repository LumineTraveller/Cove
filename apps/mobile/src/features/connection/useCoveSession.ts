import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { createSessionRegistration } from '@cove/client-core';

import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Socket } from 'socket.io-client';

import { createCoveSocket } from './socket';
import {
  clearServerConfig,
  forgetRememberedServer,
  readRememberedServers,
  readLastServerAddress,
  readSessionConfig,
  saveLastServerAddress,
  saveSessionConfig,
  invalidateSessionConfigSaves,
  type RememberedServer,
} from '../settings/storage';

import type { Room, SessionConfig } from '../../types';
import { configureServerCertificate } from './serverCertificate';

import {
  authenticateAccount,
  type AccountAuthRequest,
} from '../accounts/accountAuth';
import {
  captureAccountPasswordSaveIntent,
  invalidateAccountPasswordSaves,
  listAccountPasswords,
  removeAccountPassword,
  saveAuthenticatedAccountPassword,
  PASSWORD_MEMORY_FAILED,
  PASSWORD_MEMORY_UNAVAILABLE,
} from '../accounts/accountPasswordMemory';
import {
  clearServerAccessToken,
  ensureServerAccess,
  normalizeServerSecurityURL,
  readServerSecurityStatus,
  requiresServerAccessRecovery,
  serverFetch,
  ServerSecurityClientError,
  type ServerSecurityStatus,
} from './serverSecurity';
import {
  captureServerAccessIntent,
  forgetServerAccess,
  invalidateServerAccessOperations,
  isServerAccessIntentCurrent,
  rememberServerAccess,
  restoreServerAccess,
  serverAccessGeneration,
} from './serverAccessMemory';
import { resolveServerIdentity } from './serverIdentity';
import { MOBILE_RELEASE_VERSION } from './clientVersion';
import {
  readUpgradePolicy,
  requireClientUpgrade,
} from '../updates/versionPolicy';

export function useCoveSession() {
  const insets = useSafeAreaInsets();
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [config, setConfig] = useState<SessionConfig | null>(null);
  const [rememberedServers, setRememberedServers] = useState<
    RememberedServer[]
  >([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [registrationRetryAvailable, setRegistrationRetryAvailable] = useState(false);
  const retryRegistrationRef = useRef<(() => void) | null>(null);
  const retryRegistration = useCallback(() => retryRegistrationRef.current?.(), []);
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [lastServerURL, setLastServerURL] = useState<string | undefined>();
  const [resumeError, setResumeError] = useState<string | null>(null);
  const startupCandidate = useRef<SessionConfig | null>(null);
  const addressEdited = useRef(false);
  const mounted = useRef(true);
  const loginRevision = useRef(0);
  const securityProbeRevision = useRef(0);
  const busy = useRef(false);
  const cancelPendingLogin = useCallback(() => {
    loginRevision.current += 1;
    busy.current = false;
    invalidateAccountPasswordSaves();
    invalidateSessionConfigSaves();
    invalidateServerAccessOperations();
  }, []);
  const resumeSavedSession = useCallback(async (saved: SessionConfig) => {
    if (!saved.accountToken) {
      setAuthError('请重新登录账号。');
      return;
    }
    if (busy.current) return;
    busy.current = true;
    invalidateServerAccessOperations();
    const revision = ++loginRevision.current;
    const accessIntent = captureServerAccessIntent(
      saved.serverURL,
      saved.email,
    );
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () =>
      !timedOut &&
      mounted.current &&
      revision === loginRevision.current &&
      isServerAccessIntentCurrent(accessIntent);
    startupCandidate.current = saved;
    setLoadingConfig(true);
    setResumeError(null);
    try {
      const attempt = async () => {
        await configureServerCertificate(
          saved.serverURL,
          saved.allowInvalidServerCertificate === true,
        );
        if (!current()) return;
        const grant = await restoreServerAccess(saved.serverURL, saved.email);
        if (!current()) return;
        const status = await readServerSecurityStatus(saved.serverURL);
        if (!current()) return;
        if (status.upgradeRequired) return;
        if (status.enabled && (!grant || !status.authorized)) {
          await forgetServerAccess(saved.serverURL, saved.email);
          if (
            timedOut ||
            !mounted.current ||
            revision !== loginRevision.current
          )
            return;
          await clearServerConfig({ forgetSession: false });
          if (
            timedOut ||
            !mounted.current ||
            revision !== loginRevision.current
          )
            return;
          startupCandidate.current = null;
          setAuthError('服务器认证已到期或失效，请重新验证服务器密码。');
          return;
        }
        startupCandidate.current = null;
        setConfig(saved);
      };
      await Promise.race([
        attempt(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('连接超时'));
          }, 12_000);
        }),
      ]);
    } catch (cause) {
      if (!mounted.current || revision !== loginRevision.current) return;
      if (timedOut) {
        invalidateServerAccessOperations();
        setResumeError('连接服务器超时，登录信息已保留。');
        return;
      }
      if (!current()) return;
      if (cause instanceof ServerSecurityClientError) {
        if (requiresServerAccessRecovery(cause.code)) {
          await forgetServerAccess(saved.serverURL, saved.email);
          if (
            timedOut ||
            !mounted.current ||
            revision !== loginRevision.current
          )
            return;
          await clearServerConfig({ forgetSession: false });
          if (
            timedOut ||
            !mounted.current ||
            revision !== loginRevision.current
          )
            return;
        }
        startupCandidate.current = null;
        setAuthError(cause.message);
      } else {
        // Offline is not revocation. Wait for an explicit retry, keeping secrets.
        setResumeError('暂时无法连接服务器，登录信息已保留。');
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (mounted.current && revision === loginRevision.current) {
        if (timedOut) setResumeError('连接服务器超时，登录信息已保留。');
        busy.current = false;
        setLoadingConfig(false);
      }
    }
  }, []);
  const retryAutoLogin = useCallback(() => {
    if (startupCandidate.current)
      resumeSavedSession(startupCandidate.current).catch(() => undefined);
  }, [resumeSavedSession]);
  const cancelAutoLogin = useCallback(async () => {
    cancelPendingLogin();
    startupCandidate.current = null;
    setResumeError(null);
    setLoadingConfig(false);
    try {
      await clearServerConfig({ forgetSession: false });
    } catch {
      if (mounted.current) setAuthError('无法取消本机自动登录，请重试。');
    }
  }, [cancelPendingLogin]);
  const handleServerURLChange = useCallback((value: string) => {
    addressEdited.current = true;
    setLastServerURL(value);
    saveLastServerAddress(value).catch(() => {
      if (mounted.current) setAuthError('无法保存上次填写的服务器地址。');
    });
  }, []);
  useEffect(() => {
    mounted.current = true;
    const revision = loginRevision.current;
    const accessGeneration = serverAccessGeneration();
    Promise.all([readSessionConfig(), readLastServerAddress()])
      .then(async ([saved, lastAddress]) => {
        const servers = await readRememberedServers();
        if (
          !mounted.current ||
          revision !== loginRevision.current ||
          accessGeneration !== serverAccessGeneration()
        )
          return;
        setRememberedServers(servers);
        if (!addressEdited.current && lastAddress !== null)
          setLastServerURL(lastAddress);
        if (saved) await resumeSavedSession(saved);
      })
      .catch(() => {
        if (mounted.current) setAuthError('无法读取本机登录信息，请重新登录。');
      })
      .finally(() => {
        if (mounted.current && !busy.current) setLoadingConfig(false);
      });
    return () => {
      mounted.current = false;
      cancelPendingLogin();
    };
  }, [cancelPendingLogin, resumeSavedSession]);
  useEffect(() => {
    if (!config) {
      setSocket(null);
      setSessionReady(false);
      setRegistrationRetryAvailable(false);
      return;
    }

    const nextSocket = createCoveSocket(config.serverURL);
    let active = true;
    const registration = createSessionRegistration({
      isConnected: () => active && nextSocket.connected,
      onPending: () => {
        setConnectionError(null);
        setSessionReady(false);
        setRegistrationRetryAvailable(false);
      },
      send: acknowledge => nextSocket.timeout(8_000).emit(
        'user:register',
        {
          username: config.username,
          avatarUrl: null,
          clientId: config.clientId,
          authToken: config.accountToken,
          platform: 'mobile',
          remoteControlSupported: false,
          remoteControlControllerSupported: true,
          clientVersion: MOBILE_RELEASE_VERSION,
        },
        acknowledge,
      ),
      onTransientError: () => setConnectionError('服务器登录登记确认暂未收到，正在重试'),
      onExhausted: () => {
        setSessionReady(false);
        setRegistrationRetryAvailable(true);
        setConnectionError('登录登记重试已暂停，登录记录已保留。可点击重试登记。');
      },
      onRejected: response => {
        if (response.code === 'CLIENT_VERSION_TOO_OLD') {
          requireClientUpgrade(response);
          nextSocket.disconnect();
          return;
        }
        if (
          response.error?.includes('登录已失效') ||
          [
            'ACCOUNT_SESSION_INVALID',
            'ACCOUNT_AUTH_REQUIRED',
            'ACCOUNT_SWITCH_FORBIDDEN',
            'AUTH_REQUIRED',
          ].includes(response.code ?? '')
        ) {
          cancelPendingLogin();
          setSavingConfig(true);
          setSelectedRoom(null);
          setConfig(null);
          setAuthError(response.error ?? '账号登录已失效，请重新登录。');
          clearServerConfig()
            .then(readRememberedServers)
            .then(setRememberedServers)
            .catch(() => {})
            .finally(() => setSavingConfig(false));
          return;
        }
        if (response.code === 'SESSION_IN_USE') {
          cancelPendingLogin();
          setSavingConfig(true);
          setSelectedRoom(null);
          setConfig(null);
          setAuthError(response.error ?? '账号已在其他设备使用，请重新登录。');
          nextSocket.disconnect();
          clearServerConfig()
            .then(readRememberedServers)
            .then(setRememberedServers)
            .catch(() => {})
            .finally(() => setSavingConfig(false));
          return;
        }
        setConnectionError(response.error ?? '服务器身份注册超时');
        setSessionReady(false);
      },
      onSuccess: () => {
        setConnectionError(null);
        setSessionReady(true);
        setRegistrationRetryAvailable(false);
      },
    });
    const retryCurrentRegistration = () => {
      if (!active || !nextSocket.connected) return;
      registration.cancel();
      registration.start();
    };
    retryRegistrationRef.current = retryCurrentRegistration;
    const register = () => registration.start();
    const disconnect = () => {
      if (!active) return;
      registration.cancel();
      setRegistrationRetryAvailable(false);
      setSessionReady(false);
      setConnectionError('服务器连接已中断，正在自动重试');
    };
    const requireServerUnlock = (message?: string) => {
      if (!active) return;
      registration.cancel();
      cancelPendingLogin();
      setSessionReady(false);
      clearServerAccessToken(config.serverURL);
      forgetServerAccess(config.serverURL, config.email).catch(() => undefined);
      setSelectedRoom(null);
      setConfig(null);
      setAuthError(message || '服务器访问令牌已失效，请重新验证服务器密码。');
      nextSocket.disconnect();
    };
    const connectError = (cause: Error) => {
      if (!active) return;
      registration.cancel();
      setSessionReady(false);
      const code = (cause as Error & { data?: { code?: string } }).data?.code;
      if (code === 'CLIENT_VERSION_TOO_OLD') {
        requireClientUpgrade((cause as Error & { data?: unknown }).data);
        nextSocket.disconnect();
        return;
      }
      if (requiresServerAccessRecovery(code)) {
        requireServerUnlock(cause.message);
        return;
      }
      setConnectionError(`无法连接服务器：${cause.message}`);
    };
    const serverAccessInvalid = (notice?: {
      code?: string;
      message?: string;
    }) => {
      if (requiresServerAccessRecovery(notice?.code))
        requireServerUnlock(notice?.message);
    };
    const sessionReplaced = () => {
      if (!active) return;
      registration.cancel();
      cancelPendingLogin();
      setSavingConfig(true);
      setSelectedRoom(null);
      setConfig(null);
      setAuthError('账号已在其他设备登录，本设备已退出。');
      nextSocket.disconnect();
      clearServerConfig()
        .then(readRememberedServers)
        .then(setRememberedServers)
        .catch(() => {})
        .finally(() => setSavingConfig(false));
    };

    nextSocket.on('connect', register);
    nextSocket.on('disconnect', disconnect);
    nextSocket.on('connect_error', connectError);
    nextSocket.on('server:access-invalid', serverAccessInvalid);
    nextSocket.on('account:session-replaced', sessionReplaced);
    setSocket(nextSocket);
    // Native HTTPS policy must be ready before HTTP polling or WSS starts.
    configureServerCertificate(
      config.serverURL,
      config.allowInvalidServerCertificate === true,
    )
      .then(() => {
        // An offline public-version probe must not disable Socket.IO's retry
        // loop. The handshake still enforces the server's minimum version.
        return serverFetch(config.serverURL, '/api/version').catch(() => null);
      })
      .then(async response => {
        if (!active) return;
        if (response?.ok) {
          const policy = readUpgradePolicy(await response.json());
          if (policy?.upgradeRequired) {
            requireClientUpgrade(policy);
            return;
          }
        }
        if (active) nextSocket.connect();
      })
      .catch(cause => {
        if (active)
          connectError(
            cause instanceof Error ? cause : new Error(String(cause)),
          );
      });

    return () => {
      active = false;
      registration.cancel();
      if (retryRegistrationRef.current === retryCurrentRegistration) retryRegistrationRef.current = null;
      nextSocket.off('connect', register);
      nextSocket.off('disconnect', disconnect);
      nextSocket.off('connect_error', connectError);
      nextSocket.off('server:access-invalid', serverAccessInvalid);
      nextSocket.off('account:session-replaced', sessionReplaced);
      nextSocket.disconnect();
    };
  }, [config, cancelPendingLogin]);
  const handleLogin = async (request: AccountAuthRequest) => {
    if (busy.current) return;
    busy.current = true;
    invalidateServerAccessOperations();
    const revision = ++loginRevision.current;
    const current = () =>
      mounted.current &&
      revision === loginRevision.current &&
      isServerAccessIntentCurrent(accessIntent);
    // Capture synchronously: switching scope or cancelling memory during any
    // subsequent await must revoke this login's permission to save a password.
    const passwordIntent = captureAccountPasswordSaveIntent(
      request.serverURL,
      request.email,
    );
    const accessIntent = captureServerAccessIntent(
      request.serverURL,
      request.email,
    );
    handleServerURLChange(request.serverURL);
    setSavingConfig(true);
    setAuthError(null);
    try {
      await saveLastServerAddress(request.serverURL);
      if (!current()) return;
      const serverURL = normalizeServerSecurityURL(request.serverURL);
      if (!serverURL) throw new Error('服务器地址无效');
      const normalizedRequest = { ...request, serverURL };
      // A remembered account token is already an account credential. Re-unlock
      // the server without issuing a new account token or replacing another device.
      const rememberedAccount =
        request.mode === 'login'
          ? rememberedServers.find(
              entry =>
                entry.serverURL === serverURL &&
                entry.email.toLowerCase() ===
                  request.email.trim().toLowerCase() &&
                entry.accountToken,
            )
          : undefined;
      await configureServerCertificate(
        serverURL,
        normalizedRequest.allowInvalidServerCertificate,
      );
      if (!current()) return;
      await restoreServerAccess(serverURL, normalizedRequest.email);
      if (!current()) return;
      const grant = await ensureServerAccess({
        serverURL,
        password: normalizedRequest.serverPassword ?? '',
        bootstrapToken: normalizedRequest.bootstrapToken,
      });
      if (!current()) return;
      const result = rememberedAccount?.accountToken
        ? {
            token: rememberedAccount.accountToken,
            account: {
              id: rememberedAccount.accountId,
              email: rememberedAccount.email,
              username: rememberedAccount.username,
              avatarUrl: null,
            },
          }
        : await authenticateAccount(normalizedRequest);
      if (!current()) return;
      const identity = await resolveServerIdentity(serverURL);
      if (!current()) return;
      const passwordMemory = rememberedAccount?.accountToken
        ? { available: true, ok: true }
        : await saveAuthenticatedAccountPassword(
            serverURL,
            result.account.email,
            request.password,
            request.rememberAccountPassword === true,
            passwordIntent,
          );
      if (!current()) return;
      if (request.rememberAccountPassword && !passwordMemory.ok)
        Alert.alert(
          passwordMemory.cancelled ? '密码记忆未取消' : '密码记忆未确认',
          passwordMemory.cancelled
            ? '无法确认密码记忆已取消，旧密码可能仍保存在本机，请重新清除。'
            : passwordMemory.available
            ? PASSWORD_MEMORY_FAILED
            : PASSWORD_MEMORY_UNAVAILABLE,
        );
      if (grant) {
        const remembered = await rememberServerAccess(
          serverURL,
          result.account.email,
          grant,
          accessIntent,
        );
        if (!current()) return;
        if (!remembered)
          Alert.alert(
            '服务器认证未记住',
            '无法使用系统安全存储保留服务器认证，本次登录可继续，下次需重新验证。',
          );
      }
      const saved = await saveSessionConfig({
        username: result.account.username,
        serverURL,
        accountToken: result.token,
        accountId: result.account.id,
        email: result.account.email,
        serverKey: identity.key,
        allowInvalidServerCertificate:
          normalizedRequest.allowInvalidServerCertificate,
        lastServerAddress: request.serverURL,
      });
      if (current()) setConfig(saved);
    } catch (cause) {
      if (current())
        setAuthError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (revision === loginRevision.current) busy.current = false;
      if (mounted.current && revision === loginRevision.current)
        setSavingConfig(false);
    }
  };
  const invalidateServerSecurityScope = useCallback((serverURL: string) => {
    // Saving disables scope edits; a finishing probe cannot revoke that login.
    if (busy.current) return;
    invalidateServerAccessOperations();
    clearServerAccessToken(serverURL);
  }, []);
  const probeServerSecurity = useCallback(
    async (
      serverURLValue: string,
      allowInvalidServerCertificate: boolean,
      email?: string,
      isAccountScopeCurrent: () => boolean = () => true,
    ): Promise<ServerSecurityStatus> => {
      if (busy.current) throw new Error('正在认证');
      const serverURL = normalizeServerSecurityURL(serverURLValue);
      const probeRevision = ++securityProbeRevision.current;
      const revision = loginRevision.current;
      invalidateServerAccessOperations();
      const accessIntent = captureServerAccessIntent(serverURL, email ?? '');
      const current = () =>
        mounted.current &&
        !busy.current &&
        revision === loginRevision.current &&
        probeRevision === securityProbeRevision.current;
      const mayRestore = () =>
        current() &&
        isAccountScopeCurrent() &&
        isServerAccessIntentCurrent(accessIntent);
      const requireCurrent = () => {
        if (!current())
          throw new ServerSecurityClientError(
            'Request cancelled',
            499,
            'REQUEST_CANCELLED',
          );
      };
      if (!serverURL) throw new Error('服务器地址无效');
      await configureServerCertificate(
        serverURL,
        allowInvalidServerCertificate,
      );
      if (busy.current) throw new Error('正在认证');
      requireCurrent();
      if (email && mayRestore())
        await restoreServerAccess(serverURL, email, mayRestore);
      else if (!email) clearServerAccessToken(serverURL);
      requireCurrent();
      if (busy.current) throw new Error('正在认证');
      const status = await readServerSecurityStatus(serverURL);
      requireCurrent();
      if (email && mayRestore() && status.enabled && !status.authorized)
        await forgetServerAccess(serverURL, email);
      requireCurrent();
      return isAccountScopeCurrent()
        ? status
        : { ...status, authorized: false };
    },
    [],
  );
  const handleChangeServer = async () => {
    if (busy.current || savingConfig) return;
    busy.current = true;
    cancelPendingLogin();
    setSavingConfig(true);
    try {
      // Switching servers disconnects this session, but keeps its valid login token.
      if (config && !(await forgetServerAccess(config.serverURL, config.email)))
        throw new Error('无法清除本机服务器认证，请重试。');
      await clearServerConfig({ forgetSession: false });
      setRememberedServers(await readRememberedServers());
      setSelectedRoom(null);
      setConfig(null);
      setConnectionError(null);
      await configureServerCertificate('', false);
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : '无法保存服务器登录记录',
      );
    } finally {
      busy.current = false;
      if (mounted.current) setSavingConfig(false);
    }
  };
  const handleForget = async (saved: RememberedServer) => {
    if (busy.current || savingConfig) return;
    busy.current = true;
    cancelPendingLogin();
    setSavingConfig(true);
    setAuthError(null);
    try {
      const passwords = await listAccountPasswords();
      if (passwords.available && !passwords.ok)
        throw new Error('无法安全移除账号密码记忆，请重试。');
      const serverURL = normalizeServerSecurityURL(saved.serverURL);
      const emails = new Set([
        saved.email,
        ...passwords.accounts
          .filter(account => account.serverURL === serverURL)
          .map(account => account.email),
      ]);
      for (const email of emails) {
        const removed = await removeAccountPassword(saved.serverURL, email);
        if (removed.available && !removed.ok)
          throw new Error('无法安全移除账号密码记忆，请重试。');
      }
      if (!(await forgetServerAccess(saved.serverURL, saved.email)))
        throw new Error('无法清除本机服务器认证，请重试。');
      if (saved.accountToken)
        serverFetch(saved.serverURL, '/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: saved.accountToken }),
        }).catch(() => {});
      await forgetRememberedServer(saved.serverURL);
      setRememberedServers(await readRememberedServers());
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '无法移除登录记忆');
    } finally {
      busy.current = false;
      if (mounted.current) setSavingConfig(false);
    }
  };
  const leaveRoom = useCallback(() => setSelectedRoom(null), []);
  return {
    loadingConfig,
    config,
    savingConfig,
    authError,
    handleLogin,
    rememberedServers,
    lastServerURL,
    resumeError,
    retryAutoLogin,
    cancelAutoLogin,
    handleServerURLChange,
    handleForget,
    probeServerSecurity,
    invalidateServerSecurityScope,
    socket,
    selectedRoom,
    sessionReady,
    leaveRoom,
    setSelectedRoom,
    handleChangeServer,
    connectionError,
    registrationRetryAvailable,
    retryRegistration,
    insets,
  };
}
