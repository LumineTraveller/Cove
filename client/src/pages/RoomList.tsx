import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Crown, Hash, LoaderCircle, MessageCircle, Plus, Server, Settings, Users, Wifi, WifiOff, X } from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { ProfileModal } from '../components/ProfileModal';
import { socket, normalizeURL } from '../socket';
import type { OnlineUser, Room, UserProfile } from '../types';

interface Props {
  profile: UserProfile;
  onProfileChange: (profile: UserProfile) => void;
  onReset: () => void;
  connected: boolean | null;
  sessionReady: boolean;
  serverURL: string;
}

export default function RoomList({ profile, onProfileChange, onReset, connected, sessionReady, serverURL }: Props) {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [draftUrl, setDraftUrl] = useState(localStorage.getItem('cove_server_url') ?? serverURL);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [roomMembersMap, setRoomMembersMap] = useState<Record<string, string[]>>({});

  useEffect(() => {
    const onRooms = (updated: Room[]) => setRooms(updated);
    const onUsers = (users: OnlineUser[]) => setOnlineUsers(users);
    const onMembers = ({ roomId, members }: { roomId: string; members: string[] }) => setRoomMembersMap(previous => ({ ...previous, [roomId]: members }));
    socket.on('rooms:updated', onRooms);
    socket.on('users:online', onUsers);
    socket.on('room:members:global', onMembers);
    return () => {
      socket.off('rooms:updated', onRooms);
      socket.off('users:online', onUsers);
      socket.off('room:members:global', onMembers);
    };
  }, []);

  useEffect(() => {
    if (!sessionReady) return;
    setLoading(true);
    fetch(`${serverURL}/api/rooms`)
      .then(response => response.json())
      .then((data: Room[]) => setRooms(data))
      .finally(() => setLoading(false));
  }, [serverURL, sessionReady]);

  const createRoom = async () => {
    if (!newName.trim() || !sessionReady) return;
    try {
      const result = await new Promise<{ room?: Room; error?: string }>((resolve, reject) => {
        socket.timeout(5_000).emit('room:create', { name: newName.trim() }, (error: Error | null, response: { room?: Room; error?: string }) => error ? reject(error) : resolve(response));
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
    if (!draftUrl.trim()) return;
    localStorage.setItem('cove_server_url', normalizeURL(draftUrl));
    window.location.reload();
  };

  return (
    <div className="flex h-full overflow-hidden bg-gradient-to-br from-zinc-950 via-black to-zinc-900">
      <aside className="flex w-72 flex-shrink-0 flex-col border-r border-white/[0.08] bg-white/[0.055] backdrop-blur-2xl">
        <div className="flex h-16 flex-shrink-0 items-center justify-between border-b border-white/[0.08] px-5">
          <span className="text-xl font-bold tracking-tight text-white">Cove</span>
          <div className="flex items-center gap-1.5">
            <span className={`rounded-lg p-1.5 ${connected === true ? 'text-emerald-300' : connected === false ? 'text-red-300' : 'text-white/30'}`} title={connected === true ? '服务器已连接' : connected === false ? '服务器连接中断' : '正在连接服务器'}>{connected === false ? <WifiOff size={16} /> : connected === true ? <Wifi size={16} /> : <LoaderCircle size={16} className="animate-spin" />}</span>
            <button onClick={() => setShowSettings(true)} className="rounded-xl p-2 text-white/35 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-300/50" aria-label="服务器设置" title="服务器设置"><Settings size={19} /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4">
          <div className="mb-2 flex items-center justify-between px-2">
            <span className="text-sm font-semibold uppercase tracking-wider text-white/40">频道</span>
            <button className="flex h-8 w-8 items-center justify-center rounded-lg text-white/40 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-300/50 disabled:opacity-20" onClick={() => setCreating(true)} disabled={!sessionReady} aria-label="新建频道" title="新建频道"><Plus size={18} /></button>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-white/35"><LoaderCircle size={16} className="animate-spin" /> 加载频道</div>
          ) : rooms.length === 0 ? (
            <p className="px-2 py-3 text-sm text-white/35">还没有频道</p>
          ) : (
            <div className="flex flex-col gap-1">
              {rooms.map(room => (
                <button key={room.id} className="group flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-white/55 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-300/40" onClick={() => navigate(`/room/${room.id}`)}>
                  <Hash size={17} className="flex-shrink-0 text-white/25 transition group-hover:text-white/55" />
                  <span className="flex-1 truncate text-base font-medium">{room.name}</span>
                  {room.ownerName && <Crown size={15} className="flex-shrink-0 text-amber-300/70" aria-label={`房主：${room.ownerName}`} />}
                  {(roomMembersMap[room.id]?.length ?? 0) > 0 && <span className="flex-shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/45">{roomMembersMap[room.id].length}</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="max-h-56 flex-shrink-0 overflow-y-auto border-t border-white/[0.08] px-3 py-4">
          <p className="mb-2.5 flex items-center gap-2 px-2 text-sm font-semibold uppercase tracking-wider text-white/40"><Users size={15} /> 在线 · {onlineUsers.length}</p>
          {onlineUsers.map(user => {
            const isSelf = user.socketId === socket.id;
            return (
              <div key={user.socketId} className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-white/[0.06]">
                <div className="relative"><Avatar username={user.username} avatarUrl={user.avatarUrl} size="sm" /><span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-zinc-900 bg-emerald-400" /></div>
                <span className={`truncate text-sm ${isSelf ? 'font-medium text-white' : 'text-white/60'}`}>{isSelf ? `${user.username}（你）` : user.username}</span>
              </div>
            );
          })}
        </div>

        <button className="flex flex-shrink-0 items-center gap-3 border-t border-white/[0.08] p-3.5 text-left transition hover:bg-white/[0.06] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-300/40" onClick={() => setShowProfile(true)} aria-label="打开个人名片">
          <Avatar username={profile.username} avatarUrl={profile.avatarUrl} size="md" />
          <span className="min-w-0 flex-1"><span className="block truncate text-base font-medium text-white">{profile.username}</span><span className="block text-xs text-white/35">查看和编辑个人名片</span></span>
          <Settings size={18} className="text-white/35" />
        </button>
      </aside>

      <main className="flex flex-1 select-none flex-col items-center justify-center">
        <div className="space-y-4 text-center">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl border border-white/10 bg-white/[0.06] text-cyan-100/70 backdrop-blur-xl"><MessageCircle size={36} /></div>
          <div><p className="text-xl font-semibold text-white">选择一个频道</p><p className="mt-1.5 text-base text-white/40">从左侧选择频道开始聊天或共享屏幕</p></div>
          <button className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-base text-white/40 transition hover:bg-white/10 hover:text-white disabled:opacity-20" onClick={() => setCreating(true)} disabled={!sessionReady}><Plus size={17} /> 创建第一个频道</button>
        </div>
      </main>

      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-md" onMouseDown={() => setCreating(false)}>
          <section className="flex w-full max-w-sm flex-col gap-5 rounded-3xl border border-white/15 bg-zinc-900/95 p-7 shadow-2xl" onMouseDown={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="create-title">
            <div className="flex items-start justify-between"><div><h2 id="create-title" className="text-xl font-bold text-white">创建频道</h2><p className="mt-1 text-sm text-white/40">创建者会成为房主</p></div><button onClick={() => setCreating(false)} className="rounded-lg p-2 text-white/35 hover:bg-white/10 hover:text-white" aria-label="关闭"><X size={18} /></button></div>
            <div><label className="mb-2 block text-sm font-medium text-white/55" htmlFor="room-name">频道名称</label><div className="flex items-center rounded-xl border border-white/10 bg-white/[0.07] px-3 focus-within:border-cyan-300/45"><Hash size={18} className="mr-2 text-white/30" /><input id="room-name" className="flex-1 bg-transparent py-3 text-base text-white outline-none placeholder:text-white/20" placeholder="general" value={newName} onChange={event => setNewName(event.target.value)} onKeyDown={event => event.key === 'Enter' && createRoom()} autoFocus /></div></div>
            <div className="flex gap-2.5"><button className="flex-1 rounded-xl bg-white/10 py-3 font-medium text-white/70 transition hover:bg-white/15" onClick={() => { setCreating(false); setNewName(''); }}>取消</button><button className="flex-1 rounded-xl bg-white py-3 font-semibold text-zinc-900 transition hover:bg-cyan-100 disabled:opacity-25" disabled={!newName.trim() || !sessionReady} onClick={createRoom}>创建</button></div>
          </section>
        </div>
      )}

      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-md" onMouseDown={() => setShowSettings(false)}>
          <section className="w-full max-w-md rounded-3xl border border-white/15 bg-zinc-900/95 p-7 shadow-2xl" onMouseDown={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="flex items-center justify-between"><h2 id="settings-title" className="text-xl font-bold text-white">服务器设置</h2><button onClick={() => setShowSettings(false)} className="rounded-lg p-2 text-white/35 hover:bg-white/10 hover:text-white" aria-label="关闭"><X size={18} /></button></div>
            <label className="mb-2 mt-5 block text-sm font-medium text-white/55" htmlFor="settings-server">服务器地址</label>
            <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.07] px-4 focus-within:border-cyan-300/45"><Server size={18} className="text-white/30" /><input id="settings-server" className="min-w-0 flex-1 bg-transparent py-3 font-mono text-sm text-white outline-none" value={draftUrl} onChange={event => setDraftUrl(event.target.value)} onKeyDown={event => event.key === 'Enter' && saveSettings()} autoFocus /></div>
            <p className="mt-2 text-xs text-white/35">保存后客户端会重启连接。服务器地址不会被隐藏。</p>
            <button className="mt-5 w-full rounded-xl bg-white py-3 font-semibold text-zinc-900 transition hover:bg-cyan-100 disabled:opacity-25" disabled={!draftUrl.trim()} onClick={saveSettings}>保存并重连</button>
          </section>
        </div>
      )}

      {showProfile && <ProfileModal profile={profile} serverURL={serverURL} onSave={onProfileChange} onClose={() => setShowProfile(false)} onOpenServerSettings={() => { setShowProfile(false); setShowSettings(true); }} onReset={onReset} />}
    </div>
  );
}
