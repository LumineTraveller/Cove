import { useCallback, useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { LoaderCircle, LogIn, Server, UserRound, WifiOff } from 'lucide-react';
import RoomList from './pages/RoomList';
import ChatRoom from './pages/ChatRoom';
import { createConnectionDeadline } from './connectionDeadline';
import { clearProfile, persistProfile, readProfile } from './profile';
import { socket, getClientId, getServerURL, normalizeURL } from './socket';
import type { UserProfile } from './types';

const DEFAULT_SERVER = 'http://localhost:3001';
type ConnectionProblem = 'timeout' | 'registration' | null;

export default function App() {
  const [profile, setProfile] = useState<UserProfile>(() => readProfile());
  const serverUrl = localStorage.getItem('cove_server_url') ?? '';
  const [connected, setConnected] = useState<boolean | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftUrl, setDraftUrl] = useState(() => localStorage.getItem('cove_server_url') ?? DEFAULT_SERVER);
  const [editingServer, setEditingServer] = useState(false);
  const [initialConnectionPending, setInitialConnectionPending] = useState(false);
  const [connectionProblem, setConnectionProblem] = useState<ConnectionProblem>(null);
  const needLogin = !profile.username || !serverUrl;
  const serverURL = getServerURL();

  useEffect(() => {
    if (needLogin || editingServer) return;
    let active = true;
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

    const register = () => {
      const currentProfile = readProfile();
      setConnected(null);
      socket.timeout(8_000).emit('user:register', {
        username: currentProfile.username,
        avatarUrl: currentProfile.avatarUrl,
        clientId: getClientId(),
      }, (error: Error | null, response?: { ok?: boolean }) => {
        if (!active) return;
        const registered = !error && response?.ok !== false;
        setConnected(registered);
        if (registered) {
          deadline.complete();
          setInitialConnectionPending(false);
          setConnectionProblem(null);
        } else {
          socket.disconnect();
          setInitialConnectionPending(false);
          setConnectionProblem('registration');
          setEditingServer(true);
        }
      });
    };
    const disconnect = () => active && setConnected(false);
    const connectError = () => active && setConnected(false);
    socket.on('connect', register);
    socket.on('disconnect', disconnect);
    socket.on('connect_error', connectError);
    socket.connect();
    if (socket.connected) register();
    return () => {
      active = false;
      deadline.cancel();
      socket.off('connect', register);
      socket.off('disconnect', disconnect);
      socket.off('connect_error', connectError);
      socket.disconnect();
    };
  }, [editingServer, needLogin]);

  const handleLogin = () => {
    const username = draftName.trim();
    if (!username || !draftUrl.trim()) return;
    persistProfile({ username, avatarUrl: null });
    localStorage.setItem('cove_server_url', normalizeURL(draftUrl || DEFAULT_SERVER));
    window.location.reload();
  };

  const handleReset = () => {
    clearProfile();
    localStorage.removeItem('cove_server_url');
    window.location.reload();
  };

  const editServer = () => {
    socket.disconnect();
    setDraftUrl(serverURL);
    setInitialConnectionPending(false);
    setConnectionProblem(null);
    setEditingServer(true);
  };

  const saveServerAndReconnect = () => {
    if (!draftUrl.trim()) return;
    localStorage.setItem('cove_server_url', normalizeURL(draftUrl));
    window.location.reload();
  };

  const handleProfileChange = useCallback((next: UserProfile) => {
    persistProfile(next);
    setProfile(next);
    if (socket.connected) socket.emit('user:update-profile', next);
  }, []);

  if (needLogin) {
    return (
      <div className="flex h-full items-center justify-center bg-gradient-to-br from-zinc-950 via-black to-zinc-900">
        <div className="w-full max-w-sm px-6">
          <div className="mb-8 text-center">
            <div className="mb-5 inline-flex h-16 w-16 items-center justify-center rounded-3xl border border-white/15 bg-white/10 shadow-2xl backdrop-blur-xl"><span className="text-3xl font-bold text-white">C</span></div>
            <h1 className="text-3xl font-bold tracking-tight text-white">Cove</h1>
            <p className="mt-1 text-base text-white/45">连接朋友的语音与屏幕</p>
          </div>
          <div className="flex flex-col gap-5 rounded-3xl border border-white/10 bg-white/[0.07] p-7 shadow-2xl backdrop-blur-2xl">
            <div>
              <label className="mb-2 block text-sm font-medium text-white/55" htmlFor="login-name">用户名</label>
              <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.07] px-4 transition focus-within:border-cyan-300/45 focus-within:ring-2 focus-within:ring-cyan-300/10">
                <UserRound size={18} className="text-white/30" />
                <input id="login-name" className="min-w-0 flex-1 bg-transparent py-3 text-base text-white outline-none placeholder:text-white/20" placeholder="你的名字" value={draftName} onChange={event => setDraftName(event.target.value)} autoFocus />
              </div>
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-white/55" htmlFor="login-server">服务器地址</label>
              <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.07] px-4 transition focus-within:border-cyan-300/45 focus-within:ring-2 focus-within:ring-cyan-300/10">
                <Server size={18} className="text-white/30" />
                <input id="login-server" className="min-w-0 flex-1 bg-transparent py-3 font-mono text-sm text-white outline-none placeholder:text-white/20" placeholder="https://example.com:3001" value={draftUrl} onChange={event => setDraftUrl(event.target.value)} onKeyDown={event => event.key === 'Enter' && handleLogin()} />
              </div>
              <p className="mt-2 text-xs leading-relaxed text-white/30">这是连接 Cove 的必填地址，可填写你的 HTTPS 或本地服务器地址。</p>
              <p className="mt-1.5 text-xs leading-relaxed text-amber-200/45">localhost 只适用于服务器就在这台电脑上；其他用户需要填写房主提供的地址。</p>
            </div>
            <button className="mt-1 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white py-3 text-base font-semibold text-zinc-900 transition hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-25" disabled={!draftName.trim() || !draftUrl.trim()} onClick={handleLogin}><LogIn size={18} /> 进入 Cove</button>
          </div>
        </div>
      </div>
    );
  }

  const sessionReady = connected === true;
  return (
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<RoomList profile={profile} onProfileChange={handleProfileChange} onReset={handleReset} connected={connected} sessionReady={sessionReady} serverURL={serverURL} />} />
        <Route path="/room/:roomId" element={<ChatRoom profile={profile} onProfileChange={handleProfileChange} sessionReady={sessionReady} serverURL={serverURL} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {connected !== true && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="connection-title">
          <div className="w-full max-w-sm rounded-3xl border border-white/15 bg-zinc-900/95 p-7 shadow-2xl">
            {editingServer ? (
              <>
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/15 text-red-300"><WifiOff size={24} /></div>
                <h2 id="connection-title" className="mt-4 text-center text-lg font-semibold text-white">{connectionProblem === 'timeout' ? '连接超时' : connectionProblem === 'registration' ? '服务器拒绝了登录' : '修改服务器地址'}</h2>
                <p className="mt-2 text-center text-sm leading-relaxed text-white/45">{connectionProblem === 'timeout' ? '30 秒内未能连接，Cove 已停止重试。请检查或修改地址。' : connectionProblem === 'registration' ? '身份验证没有成功，请检查服务器是否正常或更换地址。' : '当前连接已取消，保存新地址后会立即重新连接。'}</p>
                <label className="mb-2 mt-5 block text-sm font-medium text-white/55" htmlFor="reconnect-server">服务器地址</label>
                <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.07] px-4 transition focus-within:border-cyan-300/45 focus-within:ring-2 focus-within:ring-cyan-300/10">
                  <Server size={18} className="text-white/30" />
                  <input id="reconnect-server" className="min-w-0 flex-1 bg-transparent py-3 font-mono text-sm text-white outline-none" value={draftUrl} onChange={event => setDraftUrl(event.target.value)} onKeyDown={event => event.key === 'Enter' && saveServerAndReconnect()} autoFocus />
                </div>
                <p className="mt-2 text-xs leading-relaxed text-amber-200/45">localhost 只适用于服务器所在电脑；朋友的电脑应填写房主提供的公网或局域网地址。</p>
                <button className="mt-5 w-full rounded-xl bg-white py-3 font-semibold text-zinc-900 transition hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-25" disabled={!draftUrl.trim()} onClick={saveServerAndReconnect}>保存并重新连接</button>
              </>
            ) : (
              <div className="text-center" aria-live="polite">
                <div className={`mx-auto flex h-12 w-12 items-center justify-center rounded-2xl ${connected === false ? 'bg-red-500/15 text-red-300' : 'bg-cyan-400/10 text-cyan-200'}`}>{connected === false ? <WifiOff size={24} /> : <LoaderCircle size={24} className="animate-spin" />}</div>
                <h2 id="connection-title" className="mt-4 text-lg font-semibold text-white">{connected === false ? '暂时无法连接' : '正在连接服务器'}</h2>
                <p className="mt-2 text-sm leading-relaxed text-white/45">{initialConnectionPending ? 'Cove 最多尝试 30 秒；你也可以立即取消并修改服务器地址。' : 'Cove 会自动重连并恢复你所在的房间。'}</p>
                <p className="mt-4 truncate rounded-xl bg-black/25 px-3 py-2 font-mono text-xs text-white/35" title={serverURL}>{serverURL}</p>
                <button className="mt-4 w-full rounded-xl bg-white/10 py-3 font-medium text-white/75 transition hover:bg-white/15 hover:text-white" onClick={editServer}>取消连接并修改地址</button>
              </div>
            )}
          </div>
        </div>
      )}
    </HashRouter>
  );
}
