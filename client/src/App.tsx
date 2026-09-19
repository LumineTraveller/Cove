import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ArrowRight, Clock3, Copy, Headphones, LoaderCircle, LockKeyhole, LogIn, Mail, MessageCircle, Minus, MonitorPlay, Server, Sparkles, Square, UserRound, WifiOff, X } from 'lucide-react';
import RoomList from './pages/RoomList';
import ChatRoomV2 from './pages/ChatRoomV2';
import { UpdateCenter } from './components/UpdateCenter';
import { createConnectionDeadline } from './connectionDeadline';
import { createSessionRegistration } from './sessionRegistration';
import { clearProfile, MAX_PERSISTED_AVATAR_DATA_URL_LENGTH, persistProfile, readProfile } from './profile';
import { applyServerAccessToSocket, socket, getClientId, getServerURL } from './socket';
import type { UserProfile } from './types';
import { ServerCertificateToggle } from './components/ServerCertificateToggle';
import { hasServerCertificateException, saveServerCertificateException } from './serverCertificate';
import { clearAccountSession, enrichRememberedLoginIdentities, forgetRememberedLogin, loginAccount, normalizeLoginServer, readAccountSession, readRememberedLogins, registerAccount, rememberAccountSession, rememberAccountSessionResolved, validAccountEmail, type RememberedLogin } from './accountAuth';
import { clearServerAccessToken, ensureServerAccess, normalizeServerSecurityURL, readServerSecurityStatus, requiresServerAccessRecovery, serverFetch, type ServerSecurityStatus } from './serverSecurity';
import { applyTheme, readTheme, type AppTheme, THEME_STORAGE_KEY } from './theme';

const DEFAULT_SERVER = 'http://localhost:3001';
type ConnectionProblem = 'timeout' | 'registration' | null;
type ServerSecurityProbe =
  | { phase: 'idle' | 'checking' | 'invalid' | 'unavailable'; status?: undefined }
  | { phase: 'ready'; status: ServerSecurityStatus };

function WindowTitleBar({ showBrand = true }: { showBrand?: boolean }) {
  const [maximized, setMaximized] = useState(false);
  const windowApi = window.coveWindow;

  useEffect(() => {
    if (!windowApi) return;
    void windowApi.isMaximized().then(setMaximized);
    return windowApi.onState(setMaximized);
  }, [windowApi]);

  const toggleMaximize = () => {
    if (!windowApi) return;
    void windowApi.toggleMaximize().then(setMaximized);
  };

  return (
    <div className={`cove-window-titlebar ${maximized ? "is-maximized" : ""}`} onDoubleClick={toggleMaximize}>
      {showBrand && (
        <span className="cove-window-brand">
          <img src="./assets/cove-icon.png" alt="" aria-hidden="true" />
          <span className="cove-window-title">Cove</span>
        </span>
      )}
      <div className="cove-window-controls">
        <button type="button" onClick={() => void windowApi?.minimize()} aria-label="最小化" title="最小化"><Minus size={15} /></button>
        <button type="button" onClick={toggleMaximize} aria-label={maximized ? '还原窗口' : '最大化'} title={maximized ? '还原窗口' : '最大化'}>{maximized ? <Copy size={13} /> : <Square size={13} />}</button>
        <button type="button" className="close" onClick={() => void windowApi?.close()} aria-label="关闭窗口" title="关闭窗口"><X size={16} /></button>
      </div>
    </div>
  );
}

export default function App() {
  const [rememberedLogins, setRememberedLogins] = useState(readRememberedLogins);
  const [theme, setTheme] = useState<AppTheme>(readTheme);
  const [profile, setProfile] = useState<UserProfile>(() => readAccountSession(getServerURL())?.profile ?? readProfile());
  const serverUrl = localStorage.getItem('cove_server_url') ?? '';
  const [connected, setConnected] = useState<boolean | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftEmail, setDraftEmail] = useState(() => rememberedLogins.find(entry => entry.serverUrl === normalizeLoginServer(getServerURL()))?.email ?? rememberedLogins[0]?.email ?? '');
  const [draftPassword, setDraftPassword] = useState('');
  const [draftServerPassword, setDraftServerPassword] = useState('');
  const [draftBootstrapToken, setDraftBootstrapToken] = useState('');
  const [serverSecurityProbe, setServerSecurityProbe] = useState<ServerSecurityProbe>({ phase: 'idle' });
  const [serverUnlockRequired, setServerUnlockRequired] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [showServerHistory, setShowServerHistory] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const [authError, setAuthError] = useState('');
  const [draftUrl, setDraftUrl] = useState(() => localStorage.getItem('cove_server_url') ?? rememberedLogins[0]?.serverUrl ?? DEFAULT_SERVER);
  const [allowUntrustedCertificate, setAllowUntrustedCertificate] = useState(() =>
    hasServerCertificateException(localStorage.getItem('cove_server_url') ?? DEFAULT_SERVER));
  const [editingServer, setEditingServer] = useState(false);
  const [initialConnectionPending, setInitialConnectionPending] = useState(false);
  const [connectionProblem, setConnectionProblem] = useState<ConnectionProblem>(null);
  const serverURL = getServerURL();
  const accountSession = readAccountSession(serverURL);
  const needLogin = !profile.username || !serverUrl || !accountSession || serverUnlockRequired;

  useEffect(() => {
    void window.coveUpdater?.setServerUrl(serverURL).catch(() => undefined);
  }, [serverURL]);

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // 即使本地存储不可用，本次运行仍保持主题切换。
    }
  }, [theme]);

  useEffect(() => {
    let active = true;
    void enrichRememberedLoginIdentities().then(entries => {
      if (active) setRememberedLogins(entries);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setDraftServerPassword('');
    setDraftBootstrapToken('');
    const normalizedServerUrl = normalizeServerSecurityURL(draftUrl);
    if (!draftUrl.trim()) {
      setServerSecurityProbe({ phase: 'idle' });
      return;
    }
    if (!normalizedServerUrl) {
      setServerSecurityProbe({ phase: 'invalid' });
      return;
    }

    let active = true;
    setServerSecurityProbe({ phase: 'checking' });
    const timer = window.setTimeout(() => {
      void readServerSecurityStatus(normalizedServerUrl).then(status => {
        if (!active) return;
        setServerSecurityProbe({ phase: 'ready', status });
        if (!status.enabled || status.configured) setDraftBootstrapToken('');
      }).catch(() => {
        if (active) setServerSecurityProbe({ phase: 'unavailable' });
      });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [draftUrl]);

  const handleThemeChange = useCallback((next: AppTheme) => {
    // Capture the old surface BEFORE React changes theme-dependent gradients
    // and controls. Commit both CSS tokens and React state in the snapshot update.
    applyTheme(next, () => flushSync(() => setTheme(next)));
  }, []);

  useEffect(() => {
    if (needLogin || editingServer) return;
    let active = true;
    let sessionRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let sessionRetryAttempt = 0;
    setConnected(null);
    setInitialConnectionPending(true);
    setConnectionProblem(null);

    const deadline = createConnectionDeadline(() => {
      if (!active) return;
      socket.disconnect();
      setConnected(false);
      setInitialConnectionPending(false);
      setConnectionProblem('timeout');
      setEditingServer(true);
    });

    // During a short transport outage Socket.IO can establish the replacement
    // connection before the server has processed the old socket's disconnect.
    // The server then briefly reports SESSION_IN_USE even though this is the
    // same persisted login reconnecting. Retry for the disconnect grace window
    // before treating the response as a real second-device login.
    const scheduleSessionRetry = (): boolean => {
      if (!active || sessionRetryAttempt >= 6) return false;
      // A duplicated acknowledgement from the same connection is already
      // covered by the pending retry; never fall through to logout here.
      if (sessionRetryTimer) return true;
      sessionRetryAttempt += 1;
      const delay = Math.min(2_500, 250 * 2 ** (sessionRetryAttempt - 1));
      setConnected(null);
      setInitialConnectionPending(true);
      setConnectionProblem(null);
      socket.disconnect();
      sessionRetryTimer = setTimeout(() => {
        sessionRetryTimer = null;
        if (active) socket.connect();
      }, delay);
      return true;
    };

    const registration = createSessionRegistration({
      isConnected: () => active && socket.connected,
      onPending: () => setConnected(null),
      send: acknowledge => {
        const currentProfile = readAccountSession(serverURL)?.profile ?? readProfile();
        applyServerAccessToSocket(serverURL);
        socket.timeout(8_000).emit('user:register', {
          username: currentProfile.username,
          avatarUrl: currentProfile.avatarUrl,
          clientId: getClientId(),
          authToken: readAccountSession(serverURL)?.token,
          platform: 'desktop',
          remoteControlSupported: window.coveRemoteControl?.supported === true,
        }, acknowledge);
      },
      onTransientError: error => {
        console.warn('[connection] 登录登记确认暂未收到，将自动重试:', error.message);
      },
      onSuccess: response => {
        setConnected(true);
        if (response.profile?.username) {
          const syncedProfile: UserProfile = {
            username: response.profile.username,
            avatarUrl: response.profile.avatarUrl ?? null,
          };
          setProfile(syncedProfile);
          persistProfile(syncedProfile);
          const session = readAccountSession(serverURL);
          if (session) rememberAccountSession({ ...session, profile: syncedProfile });
        }
        sessionRetryAttempt = 0;
        if (sessionRetryTimer) {
          clearTimeout(sessionRetryTimer);
          sessionRetryTimer = null;
        }
        deadline.complete();
        setInitialConnectionPending(false);
        setConnectionProblem(null);
      },
      onRejected: response => {
        setConnected(false);
        socket.disconnect();
        setInitialConnectionPending(false);
        if (response.error?.includes('登录已失效')) {
          clearAccountSession(serverURL);
          clearProfile();
          window.location.reload();
          return;
        }
        if (response.code === 'SESSION_IN_USE') {
          if (scheduleSessionRetry()) return;
          clearAccountSession(serverURL);
          clearProfile();
          setProfile({ username: '', avatarUrl: null });
          setAuthError(response.error ?? '账号已在其他设备使用，请重新登录。');
          setEditingServer(false);
          return;
        }
        setConnectionProblem('registration');
        setEditingServer(true);
      },
    });
    const register = () => registration.start();
    const disconnect = () => {
      registration.cancel();
      if (active) setConnected(false);
    };
    const requireServerUnlock = (message?: string) => {
      if (!active) return;
      clearServerAccessToken(serverURL);
      setAuthError(message || '服务器访问令牌已失效，请重新验证服务器密码。');
      setConnected(false);
      setInitialConnectionPending(false);
      setServerUnlockRequired(true);
      socket.disconnect();
    };
    const connectError = (cause: Error & { data?: { code?: string } }) => {
      if (!active) return;
      if (requiresServerAccessRecovery(cause.data?.code)) {
        requireServerUnlock(cause.message);
        return;
      }
      setConnected(false);
    };
    const serverAccessInvalid = (notice?: { code?: string; message?: string }) => {
      if (requiresServerAccessRecovery(notice?.code)) requireServerUnlock(notice?.message);
    };
    const sessionReplaced = () => {
      if (!active) return;
      if (sessionRetryTimer) {
        clearTimeout(sessionRetryTimer);
        sessionRetryTimer = null;
      }
      clearAccountSession(serverURL);
      clearProfile();
      socket.disconnect();
      setProfile({ username: '', avatarUrl: null });
      setConnected(false);
      setAuthError('账号已在其他设备登录，本设备已退出，请重新登录。');
      setEditingServer(false);
    };
    socket.on('connect', register);
    socket.on('disconnect', disconnect);
    socket.on('connect_error', connectError);
    socket.on('server:access-invalid', serverAccessInvalid);
    socket.on('account:session-replaced', sessionReplaced);
    const connectToServer = async () => {
      try {
        await window.coveSecurity?.setServerCertificateException(
          serverURL,
          hasServerCertificateException(serverURL),
        );
      } catch (error) {
        console.warn('[security] 无法配置服务器证书例外:', error);
      }
      if (!active) return;
      applyServerAccessToSocket(serverURL);
      socket.connect();
      if (socket.connected) register();
    };
    void connectToServer();
    return () => {
      active = false;
      registration.cancel();
      deadline.cancel();
      if (sessionRetryTimer) clearTimeout(sessionRetryTimer);
      socket.off('connect', register);
      socket.off('disconnect', disconnect);
      socket.off('connect_error', connectError);
      socket.off('server:access-invalid', serverAccessInvalid);
      socket.off('account:session-replaced', sessionReplaced);
      socket.disconnect();
    };
  }, [editingServer, needLogin, serverURL]);

  const handleLogin = async () => {
    const username = draftName.trim();
    const securityEnabled = serverSecurityProbe.phase === 'ready' && serverSecurityProbe.status.enabled;
    const bootstrapRequired = securityEnabled && !serverSecurityProbe.status.configured;
    if (serverSecurityProbe.phase !== 'ready' || !validAccountEmail(draftEmail) || draftPassword.length < 8
      || (securityEnabled && draftServerPassword.length < 8)
      || (bootstrapRequired && (!serverSecurityProbe.status.bootstrapAvailable || !draftBootstrapToken.trim()))
      || !draftUrl.trim()
      || (authMode === 'register' && !username)) return;
    const nextServerUrl = normalizeServerSecurityURL(draftUrl || DEFAULT_SERVER);
    if (!nextServerUrl) {
      setAuthError('服务器地址无效，请使用 http:// 或 https:// 地址，且不要包含账号、查询参数或片段');
      setAuthPending(false);
      return;
    }
    setAuthPending(true);
    setAuthError('');
    try {
      await window.coveSecurity?.setServerCertificateException(nextServerUrl, allowUntrustedCertificate);
      await ensureServerAccess({
        serverURL: nextServerUrl,
        password: draftServerPassword,
        bootstrapToken: draftBootstrapToken,
      });
      const result = authMode === 'register'
        ? await registerAccount(nextServerUrl, draftEmail, draftPassword, username)
        : await loginAccount(nextServerUrl, draftEmail, draftPassword);
      persistProfile(result.profile);
      await rememberAccountSessionResolved({ ...result.session, allowInvalidServerCertificate: allowUntrustedCertificate });
      localStorage.setItem('cove_server_url', result.session.serverUrl);
      saveServerCertificateException(nextServerUrl, allowUntrustedCertificate);
      window.location.reload();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '账号请求失败');
      setAuthPending(false);
    }
  };

  const handleLogout = () => {
    const session = readAccountSession(serverURL);
    if (session) void serverFetch(serverURL, '/api/auth/logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: session.token }), keepalive: true,
    }).catch(() => {});
    socket.disconnect();
    clearServerAccessToken(serverURL);
    clearProfile();
    clearAccountSession(serverURL);
    window.location.reload();
  };

  const editServer = () => {
    socket.disconnect();
    setDraftUrl(serverURL);
    setAllowUntrustedCertificate(hasServerCertificateException(serverURL));
    setInitialConnectionPending(false);
    setConnectionProblem(null);
    setEditingServer(true);
  };

  const saveServerAndReconnect = () => {
    if (!draftUrl.trim()) return;
    const nextServerUrl = normalizeServerSecurityURL(draftUrl);
    if (!nextServerUrl) {
      setAuthError('服务器地址无效，请使用 http:// 或 https:// 地址，且不要包含账号、查询参数或片段');
      return;
    }
    clearServerAccessToken(serverURL);
    localStorage.setItem('cove_server_url', nextServerUrl);
    saveServerCertificateException(nextServerUrl, allowUntrustedCertificate);
    window.location.reload();
  };

  const handleProfileChange = useCallback((next: UserProfile) => {
    persistProfile(next);
    const session = readAccountSession(getServerURL());
    if (session) rememberAccountSession({ ...session, profile: next });
    setProfile(next);
    const hasLargeAvatar = Boolean(next.avatarUrl && next.avatarUrl.length > MAX_PERSISTED_AVATAR_DATA_URL_LENGTH);
    if (hasLargeAvatar && session?.token) {
      // Keep multi-megabyte animated GIFs out of the real-time packet path.
      // Older Socket.IO proxies commonly close the connection when a single
      // profile packet exceeds their payload limit.
      void serverFetch(session.serverUrl, '/api/auth/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.token, username: next.username, avatarUrl: next.avatarUrl }),
      }).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      }).catch(error => {
        console.warn('[profile] 大头像同步失败', error);
      });
      return;
    }
    if (socket.connected) socket.emit('user:update-profile', next);
  }, []);

  const selectRememberedLogin = (entry: RememberedLogin) => {
    if (authPending) return;
    setAuthMode('login');
    setDraftUrl(entry.serverUrl);
    setDraftEmail(entry.email);
    setDraftPassword('');
    setDraftServerPassword('');
    setDraftBootstrapToken('');
    setAllowUntrustedCertificate(entry.allowInvalidServerCertificate === true);
    setAuthError('');
    setShowServerHistory(false);
  };

  const forgetLogin = (entry: RememberedLogin) => {
    const saved = readAccountSession(entry.serverUrl);
    if (saved) void serverFetch(saved.serverUrl, '/api/auth/logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: saved.token }), keepalive: true,
    }).catch(() => {});
    forgetRememberedLogin(entry.serverUrl);
    setRememberedLogins(readRememberedLogins());
  };

  const loginVideoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!needLogin) return;
    const video = loginVideoRef.current;
    if (!video || !video.requestVideoFrameCallback) return;
    let callbackId = 0;
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      // This decorative clip has matching endpoints. Skip its duplicate tail
      // before native looping drains and restarts the decoder.
      if (Number.isFinite(video.duration) && video.duration > 0.12 &&
          metadata.mediaTime >= video.duration - 0.06 && !video.seeking) {
        video.currentTime = 0;
      }
      callbackId = video.requestVideoFrameCallback(onFrame);
    };
    callbackId = video.requestVideoFrameCallback(onFrame);
    return () => video.cancelVideoFrameCallback(callbackId);
  }, [needLogin]);

  const serverSecurityStatus = serverSecurityProbe.phase === 'ready' ? serverSecurityProbe.status : null;
  const serverSecurityEnabled = serverSecurityStatus?.enabled === true;
  const serverSecurityConfigured = serverSecurityEnabled && serverSecurityStatus.configured;
  const serverSecurityUnconfigured = serverSecurityEnabled && !serverSecurityStatus.configured;
  const serverBootstrapAvailable = serverSecurityUnconfigured && serverSecurityStatus.bootstrapAvailable;
  const serverSecurityReady = serverSecurityProbe.phase === 'ready';
  const serverSecurityHint = serverSecurityProbe.phase === 'idle'
    ? '等待输入服务器地址'
    : serverSecurityProbe.phase === 'checking'
      ? '正在识别服务器状态…'
      : serverSecurityProbe.phase === 'invalid'
        ? '服务器地址格式无效'
        : serverSecurityProbe.phase === 'unavailable'
        ? '无法识别，请检查服务器是否启动'
          : serverSecurityConfigured
            ? '服务器已初始化，请输入已有的服务器访问密码'
            : serverBootstrapAvailable
              ? '检测到新服务器，请设置服务器访问密码'
              : '服务器尚未提供一次性初始化凭据，请联系管理员';

  if (needLogin) {
    return (
      <main className="auth-page">
        <WindowTitleBar showBrand={false} />
        <UpdateCenter allowDetails={false} serverURL={serverURL} />
        <div className="auth-shell">
          <section className="auth-showcase" aria-label="Cove 产品介绍">
            <div className="auth-brand">
              <img src="./assets/cove-icon.png" alt="Cove" />
              <span>Cove</span>
            </div>
            {/* 装饰性循环动画：静音、循环播放，且不进无障碍树。
                muted 必须保留 —— 否则 Electron 的自动播放会被拦下。 */}
            <div className="auth-showcase-media" aria-hidden="true">
              <video
                ref={loginVideoRef}
                src="./assets/cove-login-loop.mp4"
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                disablePictureInPicture
              />
            </div>
            <div className="auth-showcase-copy">
              <p className="auth-eyebrow">COVE · VOICE SPACE</p>
              <h1>把声音留在一起。</h1>
              <p>一个轻松聊天、加入语音，也能一起共享屏幕的空间。</p>
            </div>
            <div className="auth-feature-list">
              <div className="auth-feature-card">
                <span className="auth-feature-icon blue"><Headphones size={20} /></span>
                <span><strong>自然加入语音</strong><small>和朋友随时聊两句</small></span>
              </div>
              <div className="auth-feature-card">
                <span className="auth-feature-icon yellow"><MonitorPlay size={20} /></span>
                <span><strong>一起看屏幕</strong><small>分享画面，不打断交流</small></span>
              </div>
              <div className="auth-feature-card">
                <span className="auth-feature-icon purple"><MessageCircle size={20} /></span>
                <span><strong>保留每次聊天</strong><small>文字、图片都在频道里</small></span>
              </div>
            </div>
            <div className="auth-showcase-footer"><Sparkles size={16} /> 让每个频道，都有自己的声音。</div>
          </section>

          <section className="auth-panel">
            <div className="auth-panel-inner">
              <div className="auth-heading">
                <p>{authMode === 'login' ? '欢迎回来' : '从这里开始'}</p>
                <h2>{authMode === 'login' ? '登录 Cove' : '创建 Cove 账号'}</h2>
                <span>{authMode === 'login' ? '连接你的频道，继续和朋友保持联系。' : '创建账号后即可加入或创建频道。'}</span>
              </div>

              <div className="auth-mode-switcher" role="tablist" aria-label="登录或注册">
                {(['login', 'register'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={authMode === mode}
                    onClick={() => { setAuthMode(mode); setAuthError(''); setShowServerHistory(false); }}
                    className={authMode === mode ? 'active' : ''}
                  >
                    {mode === 'login' ? '登录' : '注册'}
                  </button>
                ))}
              </div>

              <form className="auth-form" onSubmit={event => { event.preventDefault(); void handleLogin(); }}>
                {authMode === 'register' && (
                  <label className="auth-field" htmlFor="login-name">
                    <span>用户名</span>
                    <div className="auth-input-wrap">
                      <UserRound size={19} />
                      <input id="login-name" autoComplete="name" placeholder="你的名字" value={draftName} onChange={event => setDraftName(event.target.value)} autoFocus />
                    </div>
                  </label>
                )}
                <div className="auth-field">
                  <label className="auth-field-label" htmlFor="login-server">服务器地址</label>
                  <div className="auth-server-picker">
                    <div className="auth-input-wrap auth-server-input-wrap">
                      <Server size={19} />
                      <input id="login-server" inputMode="url" placeholder="https://example.com:3001" value={draftUrl} onChange={event => setDraftUrl(event.target.value)} />
                      {authMode === 'login' && (
                        <button
                          type="button"
                          className="auth-history-button"
                          aria-label="打开服务器历史"
                          title={rememberedLogins.length > 0 ? '服务器历史' : '暂无服务器历史'}
                          aria-expanded={showServerHistory}
                          aria-controls="auth-server-history"
                          disabled={authPending || rememberedLogins.length === 0}
                          onClick={() => setShowServerHistory(current => !current)}
                        >
                          <Clock3 size={19} />
                        </button>
                      )}
                    </div>
                    {authMode === 'login' && showServerHistory && rememberedLogins.length > 0 && (
                      <div id="auth-server-history" className="auth-history-dropdown" role="listbox" aria-label="服务器历史">
                        <div className="auth-history-heading"><span>继续连接</span><small>已保存的账号</small></div>
                        <div className="auth-history-list">
                          {rememberedLogins.map(entry => (
                            <div key={entry.serverUrl} className="auth-history-item">
                              <button type="button" disabled={authPending} onClick={() => selectRememberedLogin(entry)} className="auth-history-main">
                                <span className="auth-history-icon"><Server size={17} /></span>
                                <span className="auth-history-copy"><strong>{entry.serverUrl}</strong><small>{entry.email} · {entry.token ? '继续连接' : '填入账号'}</small></span>
                                <ArrowRight size={17} />
                              </button>
                              <button type="button" disabled={authPending} onClick={() => forgetLogin(entry)} className="auth-forget" aria-label={`忘记 ${entry.serverUrl}`}>忘记</button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <small>连接到你所在的 Cove 空间。</small>
                  {/^http:\/\/(?!localhost(?::|\/|$)|127\.0\.0\.1(?::|\/|$))/i.test(draftUrl.trim()) && <small className="auth-warning">公网 HTTP 会明文传输登录凭据，正式使用账号前应配置 HTTPS。</small>}
                  <ServerCertificateToggle tone="light" serverUrl={draftUrl} checked={allowUntrustedCertificate} onChange={setAllowUntrustedCertificate} />
                </div>
                {serverSecurityEnabled && <section className="auth-server-security" aria-labelledby="login-server-security-title">
                  <div className="auth-server-security-heading">
                    <div>
                      <strong id="login-server-security-title">服务器安全设置</strong>
                      <small aria-live="polite">{serverSecurityHint}</small>
                    </div>
                    {serverSecurityUnconfigured && <span>首次连接</span>}
                  </div>
                  {serverSecurityReady && (
                    <div className={`auth-server-security-fields ${serverSecurityConfigured || !serverBootstrapAvailable ? 'is-single' : ''}`}>
                      <label className="auth-field" htmlFor="login-server-password">
                        <span>服务器访问密码</span>
                        <div className="auth-input-wrap">
                          <Server size={19} />
                          <input id="login-server-password" type="password" autoComplete="off" placeholder="至少 8 个字符" value={draftServerPassword} onChange={event => setDraftServerPassword(event.target.value)} />
                        </div>
                      </label>
                      {serverBootstrapAvailable && (
                        <label className="auth-field" htmlFor="login-bootstrap-token">
                          <span>一次性初始化凭据 <em>（新服务器必填）</em></span>
                          <div className="auth-input-wrap">
                            <LockKeyhole size={19} />
                            <input id="login-bootstrap-token" type="password" autoComplete="off" placeholder="一次性凭据" value={draftBootstrapToken} onChange={event => setDraftBootstrapToken(event.target.value)} />
                          </div>
                        </label>
                      )}
                    </div>
                  )}
                  {serverSecurityUnconfigured && !serverBootstrapAvailable && (
                    <p className="auth-warning" role="alert">服务器管理员尚未配置一次性初始化凭据，暂时无法完成初始化。</p>
                  )}
                </section>}
                <label className="auth-field" htmlFor="login-email">
                  <span>邮箱</span>
                  <div className="auth-input-wrap">
                    <Mail size={19} />
                    <input id="login-email" type="email" autoComplete="email" placeholder="name@example.com" value={draftEmail} onChange={event => setDraftEmail(event.target.value)} autoFocus={authMode === 'login'} />
                  </div>
                  <small>邮箱仅用于登录身份识别，不会发送验证邮件。</small>
                </label>
                <label className="auth-field" htmlFor="login-password">
                  <span>密码</span>
                  <div className="auth-input-wrap">
                    <LockKeyhole size={19} />
                    <input id="login-password" type="password" autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} placeholder="至少 8 个字符" value={draftPassword} onChange={event => setDraftPassword(event.target.value)} />
                  </div>
                </label>

                {authError && <p className="auth-error" role="alert">{authError}</p>}
                <button
                  type="submit"
                  className="auth-submit"
                  disabled={authPending || !serverSecurityReady || !validAccountEmail(draftEmail) || draftPassword.length < 8 || (serverSecurityEnabled && draftServerPassword.length < 8) || (serverSecurityUnconfigured && (!serverBootstrapAvailable || !draftBootstrapToken.trim())) || !draftUrl.trim() || (authMode === 'register' && !draftName.trim())}
                >
                  {authPending ? <LoaderCircle size={19} className="animate-spin" /> : <LogIn size={19} />}
                  {authMode === 'login' ? '登录 Cove' : '注册并进入'}
                </button>
              </form>

              <p className="auth-panel-footer">登录后会进入频道大厅，你可以从左侧选择一个频道。</p>
            </div>
          </section>
        </div>
      </main>
    );
  }

  const sessionReady = connected === true;
  return (
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <WindowTitleBar showBrand={false} />
      <Routes>
        <Route path="/" element={<RoomList profile={profile} accountId={accountSession?.accountId ?? ''} onProfileChange={handleProfileChange} onLogout={handleLogout} sessionReady={sessionReady} serverURL={serverURL} theme={theme} onThemeChange={handleThemeChange} />} />
        <Route path="/room/:roomId" element={<ChatRoomV2 profile={profile} accountId={accountSession?.accountId ?? ''} onProfileChange={handleProfileChange} onLogout={handleLogout} sessionReady={sessionReady} serverURL={serverURL} theme={theme} onThemeChange={handleThemeChange} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <UpdateCenter serverURL={serverURL} />
      {connected !== true && (
        <div className="cove-connection-scrim" role="dialog" aria-modal="true" aria-labelledby="connection-title">
          <div className="cove-connection-modal">
            {editingServer ? (
              <>
                <div className="cove-connection-icon error"><WifiOff size={24} /></div>
                <h2 id="connection-title" className="cove-connection-title">{connectionProblem === 'timeout' ? '连接超时' : connectionProblem === 'registration' ? '服务器拒绝了登录' : '修改服务器地址'}</h2>
                <p className="cove-connection-copy">{connectionProblem === 'timeout' ? '30 秒内未能连接，Cove 已停止重试。请检查或修改地址。' : connectionProblem === 'registration' ? '身份验证没有成功，请检查服务器是否正常或更换地址。' : '当前连接已取消，保存新地址后会立即重新连接。'}</p>
                <label className="cove-connection-label" htmlFor="reconnect-server">服务器地址</label>
                <div className="cove-connection-input-wrap">
                  <Server size={18} />
                  <input id="reconnect-server" value={draftUrl} onChange={event => setDraftUrl(event.target.value)} onKeyDown={event => event.key === 'Enter' && saveServerAndReconnect()} autoFocus />
                </div>
                <p className="cove-connection-hint">localhost 只适用于服务器所在电脑；朋友的电脑应填写房主提供的公网或局域网地址。</p>
                <ServerCertificateToggle tone="light" serverUrl={draftUrl} checked={allowUntrustedCertificate} onChange={setAllowUntrustedCertificate} />
                <button className="cove-connection-primary" disabled={!draftUrl.trim()} onClick={saveServerAndReconnect}>保存并重新连接</button>
              </>
            ) : (
              <div className="text-center" aria-live="polite">
                <div className={`cove-connection-icon ${connected === false ? 'error' : 'pending'}`}>{connected === false ? <WifiOff size={24} /> : <LoaderCircle size={24} className="animate-spin" />}</div>
                <h2 id="connection-title" className="cove-connection-title">{connected === false ? '暂时无法连接' : '正在连接服务器'}</h2>
                <p className="cove-connection-copy">{initialConnectionPending ? 'Cove 最多尝试 30 秒；你也可以立即取消并修改服务器地址。' : 'Cove 会自动重连并恢复你所在的房间。'}</p>
                <p className="cove-connection-server" title={serverURL}>{serverURL}</p>
                <button className="cove-connection-secondary" onClick={editServer}>取消连接并修改地址</button>
              </div>
            )}
          </div>
        </div>
      )}
    </HashRouter>
  );
}
