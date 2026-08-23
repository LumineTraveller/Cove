import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { socket, normalizeURL } from '../socket';
import { Room } from '../types';

interface Props { username: string; onReset: () => void; connected: boolean | null; serverURL: string }

export default function RoomList({ username, onReset, connected, serverURL }: Props) {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [draftUrl, setDraftUrl] = useState(localStorage.getItem('cove_server_url') ?? serverURL);
  const [onlineUsers, setOnlineUsers] = useState<string[]>([]);
  const [roomMembersMap, setRoomMembersMap] = useState<Record<string, string[]>>({});

  useEffect(() => {
    fetch(`${serverURL}/api/rooms`)
      .then(r => r.json())
      .then((data: Room[]) => { setRooms(data); setLoading(false); })
      .catch(() => setLoading(false));

    socket.on('rooms:updated',       (updated: Room[]) => setRooms(updated));
    socket.on('users:online',        (users: string[]) => setOnlineUsers(users));
    socket.on('room:members:global', ({ roomId, members }: { roomId: string; members: string[] }) =>
      setRoomMembersMap(prev => ({ ...prev, [roomId]: members }))
    );
    return () => {
      socket.off('rooms:updated');
      socket.off('users:online');
      socket.off('room:members:global');
    };
  }, []);

  const createRoom = async () => {
    if (!newName.trim()) return;
    try {
      const result = await new Promise<{ room?: Room; error?: string }>((resolve, reject) => {
        socket.timeout(5_000).emit('room:create', { name: newName.trim() }, (error: Error | null, response: { room?: Room; error?: string }) => {
          if (error) reject(error);
          else resolve(response);
        });
      });
      if (!result.room) throw new Error(result.error ?? '创建失败');
      setNewName('');
      setCreating(false);
      navigate(`/room/${result.room.id}`);
    } catch (error) {
      alert(`创建失败：${error instanceof Error ? error.message : String(error)}\n${serverURL}`);
    }
  };

  const saveSettings = () => {
    localStorage.setItem('cove_server_url', normalizeURL(draftUrl));
    window.location.reload();
  };

  const avatarLetter = username[0]?.toUpperCase() ?? '?';

  return (
    <div className="h-full flex bg-gradient-to-br from-zinc-950 via-black to-zinc-900 overflow-hidden">

      {/* ── Sidebar ── */}
      <aside className="w-72 flex-shrink-0 flex flex-col bg-white/[0.06] backdrop-blur-2xl border-r border-white/[0.08]">

        {/* Header */}
        <div className="h-16 px-5 flex items-center justify-between border-b border-white/[0.08] flex-shrink-0">
          <span className="font-bold text-xl text-white tracking-tight">Cove</span>
          <span className={`w-3 h-3 rounded-full flex-shrink-0 ${
            connected === true  ? 'bg-green-400' :
            connected === false ? 'bg-red-400' :
            'bg-white/20 animate-pulse'
          }`} />
        </div>

        {/* Channel list */}
        <div className="flex-1 overflow-y-auto py-4 px-3">
          <div className="flex items-center justify-between px-2 mb-2">
            <span className="text-white/30 text-sm font-semibold uppercase tracking-wider">频道</span>
            <button
              className="text-white/30 hover:text-white/80 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/10 transition-colors text-xl leading-none disabled:opacity-20"
              onClick={() => setCreating(true)}
              disabled={connected === false}
              title="新建频道"
            >+</button>
          </div>

          {loading ? (
            <p className="px-2 py-2 text-white/30 text-base">加载中…</p>
          ) : rooms.length === 0 ? (
            <p className="px-2 py-2 text-white/30 text-base">还没有频道</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {rooms.map(room => (
                <button
                  key={room.id}
                  className="w-full text-left flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-white/50 hover:text-white hover:bg-white/10 active:bg-white/15 transition-colors group"
                  onClick={() => navigate(`/room/${room.id}`)}
                >
                  <span className="text-white/25 group-hover:text-white/50 transition-colors font-medium text-lg">#</span>
                  <span className="flex-1 text-base truncate font-medium">{room.name}</span>
                  {room.ownerName && (
                    <span className="text-amber-300/70 text-sm flex-shrink-0" title={`房主：${room.ownerName}`}>♛</span>
                  )}
                  {(roomMembersMap[room.id]?.length ?? 0) > 0 && (
                    <span className="text-sm text-white/40 bg-white/10 px-2 py-0.5 rounded-full flex-shrink-0">
                      {roomMembersMap[room.id].length}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Online users */}
        <div className="border-t border-white/[0.08] py-4 px-3 flex-shrink-0 max-h-52 overflow-y-auto">
          <p className="px-2 mb-2.5 text-white/30 text-sm font-semibold uppercase tracking-wider">
            在线 — {onlineUsers.length}
          </p>
          {onlineUsers.map((name, i) => (
            <div key={`${name}-${i}`} className="flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-white/[0.06] transition-colors">
              <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${name === username ? 'bg-white/60' : 'bg-green-400'}`} />
              <span className={`text-base truncate ${name === username ? 'text-white font-medium' : 'text-white/55'}`}>
                {name === username ? `${name}（你）` : name}
              </span>
            </div>
          ))}
        </div>

        {/* User footer */}
        <div className="flex-shrink-0 border-t border-white/[0.08] p-3.5 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-white/15 backdrop-blur-sm flex items-center justify-center text-base font-bold text-white flex-shrink-0 border border-white/20">
            {avatarLetter}
          </div>
          <span className="flex-1 text-base text-white truncate font-medium">{username}</span>
          <button
            className="text-white/30 hover:text-white/80 transition-colors p-2 rounded-xl hover:bg-white/10"
            onClick={() => setShowSettings(true)}
            title="设置"
          >
            <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="flex-1 flex flex-col items-center justify-center select-none">
        <div className="text-center space-y-4">
          <div className="w-20 h-20 rounded-3xl bg-white/[0.06] backdrop-blur-xl border border-white/10 flex items-center justify-center mx-auto">
            <span className="text-4xl">💬</span>
          </div>
          <div>
            <p className="text-white text-xl font-semibold">选择一个频道</p>
            <p className="text-white/40 text-base mt-1.5">从左侧选择频道开始聊天</p>
          </div>
          <button
            className="text-white/30 hover:text-white/70 text-base transition-colors disabled:opacity-20"
            onClick={() => setCreating(true)}
            disabled={connected === false}
          >+ 创建第一个频道</button>
        </div>
      </main>

      {/* ── New room modal ── */}
      {creating && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-50" onClick={() => setCreating(false)}>
          <div className="bg-white/[0.08] backdrop-blur-2xl border border-white/15 rounded-3xl p-7 w-80 flex flex-col gap-5 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div>
              <h2 className="text-white font-bold text-xl">创建频道</h2>
              <p className="text-white/40 text-sm mt-1">频道创建后所有人都能看到</p>
            </div>
            <div>
              <label className="text-white/50 text-sm mb-2 block font-medium">频道名称</label>
              <div className="flex items-center bg-white/[0.07] border border-white/10 rounded-xl px-3 focus-within:border-white/25 focus-within:bg-white/10 transition-all">
                <span className="text-white/25 text-lg mr-1">#</span>
                <input
                  className="flex-1 bg-transparent py-3 text-white text-base placeholder-white/20 outline-none"
                  placeholder="general"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && createRoom()}
                  autoFocus
                />
              </div>
            </div>
            <div className="flex gap-2.5">
              <button
                className="flex-1 bg-white/10 hover:bg-white/15 text-white/70 text-base rounded-xl py-3 transition-colors font-medium"
                onClick={() => { setCreating(false); setNewName(''); }}
              >取消</button>
              <button
                className="flex-1 bg-white hover:bg-zinc-100 text-zinc-900 text-base font-semibold rounded-xl py-3 transition-colors disabled:opacity-20"
                disabled={!newName.trim()}
                onClick={createRoom}
              >创建</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Settings modal ── */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-50" onClick={() => setShowSettings(false)}>
          <div className="bg-white/[0.08] backdrop-blur-2xl border border-white/15 rounded-3xl p-7 w-80 flex flex-col gap-5 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-white font-bold text-xl">设置</h2>
            <div>
              <label className="text-white/50 text-sm mb-2 block font-medium">服务器地址</label>
              <input
                className="w-full bg-white/[0.07] border border-white/10 rounded-xl px-4 py-3 text-white text-base placeholder-white/20 outline-none focus:border-white/25 focus:bg-white/10 transition-all font-mono"
                value={draftUrl}
                onChange={e => setDraftUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveSettings()}
                autoFocus
              />
              <p className="text-white/25 text-sm mt-1.5">当前连接：{serverURL}</p>
            </div>
            <button
              className="w-full bg-white hover:bg-zinc-100 text-zinc-900 text-base font-semibold py-3 rounded-xl transition-colors"
              onClick={saveSettings}
            >保存并重连</button>
            <div className="border-t border-white/[0.08] pt-4">
              <button
                className="w-full text-red-400 hover:text-red-300 hover:bg-red-500/10 text-base py-2.5 rounded-xl transition-colors font-medium"
                onClick={onReset}
              >退出登录</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
