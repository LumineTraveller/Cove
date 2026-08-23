import { useState, useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import RoomList from './pages/RoomList';
import ChatRoom from './pages/ChatRoom';
import { socket, getClientId, getServerURL, normalizeURL } from './socket';

const DEFAULT_SERVER = 'http://localhost:3001';

export default function App() {
  const username  = localStorage.getItem('cove_username')  ?? '';
  const serverUrl = localStorage.getItem('cove_server_url') ?? '';

  const [connected, setConnected] = useState<boolean | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftUrl,  setDraftUrl]  = useState(
    () => localStorage.getItem('cove_server_url') ?? DEFAULT_SERVER
  );

  const needLogin = !username || !serverUrl;

  useEffect(() => {
    if (needLogin) return;
    const register = () => {
      setConnected(true);
      socket.emit('user:register', { username, clientId: getClientId() });
    };
    socket.on('connect', register);
    socket.on('disconnect', () => setConnected(false));
    socket.connect();
    return () => {
      socket.off('connect', register);
      socket.off('disconnect');
      socket.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = () => {
    const name = draftName.trim();
    const url  = normalizeURL(draftUrl || DEFAULT_SERVER);
    if (!name) return;
    localStorage.setItem('cove_username', name);
    localStorage.setItem('cove_server_url', url);
    window.location.reload();
  };

  const handleReset = () => {
    localStorage.removeItem('cove_username');
    localStorage.removeItem('cove_server_url');
    window.location.reload();
  };

  if (needLogin) {
    return (
      <div className="h-full flex items-center justify-center bg-gradient-to-br from-zinc-950 via-black to-zinc-900">
        <div className="w-full max-w-sm px-6">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-3xl bg-white/10 backdrop-blur-xl border border-white/15 shadow-2xl mb-5">
              <span className="text-3xl font-bold text-white">C</span>
            </div>
            <h1 className="text-3xl font-bold text-white tracking-tight">Cove</h1>
            <p className="text-white/40 text-base mt-1">填写信息后进入</p>
          </div>
          <div className="bg-white/[0.07] backdrop-blur-2xl border border-white/10 rounded-3xl p-7 flex flex-col gap-5 shadow-2xl">
            <div>
              <label className="text-white/50 text-sm mb-2 block font-medium">用户名</label>
              <input
                className="w-full bg-white/[0.07] border border-white/10 rounded-xl px-4 py-3 text-white text-base placeholder-white/20 outline-none focus:border-white/30 focus:bg-white/10 transition-all"
                placeholder="你的名字"
                value={draftName}
                onChange={e => setDraftName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                autoFocus
              />
            </div>
            <div>
              <label className="text-white/50 text-sm mb-2 block font-medium">服务器地址</label>
              <input
                className="w-full bg-white/[0.07] border border-white/10 rounded-xl px-4 py-3 text-white text-base placeholder-white/20 outline-none focus:border-white/30 focus:bg-white/10 transition-all font-mono"
                placeholder="http://example.com:3001"
                value={draftUrl}
                onChange={e => setDraftUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
              />
            </div>
            <button
              className="w-full bg-white hover:bg-zinc-100 active:bg-zinc-200 text-zinc-900 font-semibold rounded-xl py-3 text-base transition-colors disabled:opacity-20 disabled:cursor-not-allowed mt-1"
              disabled={!draftName.trim() || !draftUrl.trim()}
              onClick={handleLogin}
            >
              进入 Cove
            </button>
          </div>
        </div>
      </div>
    );
  }

  const serverURL = getServerURL();

  return (
    <HashRouter>
      {connected === false && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-red-500/80 backdrop-blur-sm text-white text-sm text-center py-2 font-medium">
          ⚠ 无法连接到 {serverURL}
        </div>
      )}
      <Routes>
        <Route path="/" element={<RoomList username={username} onReset={handleReset} connected={connected} serverURL={serverURL} />} />
        <Route path="/room/:roomId" element={<ChatRoom username={username} serverURL={serverURL} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
