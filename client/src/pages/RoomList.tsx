import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Crown, Hash, Headphones, LoaderCircle, MessageCircle, Monitor, Plus, Server, Settings, Smartphone, Users, X } from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { ProfileModal } from '../components/ProfileModal';
import { ServerCertificateToggle } from '../components/ServerCertificateToggle';
import { socket, normalizeURL } from '../socket';
import { hasServerCertificateException, saveServerCertificateException } from '../serverCertificate';
import type { OnlineUser, Room, UserProfile } from '../types';
import { createRoomPayload } from '../roomSettings';
import coveIcon from '../../build/icon.ico';

interface Props {
  profile: UserProfile;
  onProfileChange: (profile: UserProfile) => void;
  onReset: () => void;
  onSwitchServer?: () => void;
  sessionReady: boolean;
  serverURL: string;
}

interface LobbyPresenceSnapshot {
  ok: true;
  onlineUsers: OnlineUser[];
  roomMembers: Record<string, string[]>;
  voiceCounts: Record<string, number>;
}

export default function RoomList({ profile, onProfileChange, onReset, onSwitchServer, sessionReady, serverURL }: Props) {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMaxMembers, setNewMaxMembers] = useState('');
  const [customMaxMembers, setCustomMaxMembers] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [draftUrl, setDraftUrl] = useState(localStorage.getItem('cove_server_url') ?? serverURL);
  const [allowUntrustedCertificate, setAllowUntrustedCertificate] = useState(() => hasServerCertificateException(serverURL));
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [roomMembersMap, setRoomMembersMap] = useState<Record<string, string[]>>({});
  const [voiceCounts, setVoiceCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    const onRooms = (updated: Room[]) => setRooms(updated);
    const onUsers = (users: OnlineUser[]) => setOnlineUsers(users);
    const onMembers = ({ roomId, members }: { roomId: string; members: string[] }) => setRoomMembersMap(previous => ({ ...previous, [roomId]: members }));
    const onVoiceCounts = (counts: Record<string, number>) => setVoiceCounts(counts);
    socket.on('rooms:updated', onRooms);
    socket.on('users:online', onUsers);
    socket.on('room:members:global', onMembers);
    socket.on('voice:counts', onVoiceCounts);
    return () => {
      socket.off('rooms:updated', onRooms);
      socket.off('users:online', onUsers);
      socket.off('room:members:global', onMembers);
      socket.off('voice:counts', onVoiceCounts);
    };
  }, []);

  useEffect(() => {
    if (!sessionReady) return;
    let active = true;
    socket.timeout(5_000).emit('presence:get', (
      error: Error | null,
      snapshot?: LobbyPresenceSnapshot,
    ) => {
      if (!active || error || !snapshot?.ok) return;
      setOnlineUsers(snapshot.onlineUsers);
      setRoomMembersMap(snapshot.roomMembers);
      setVoiceCounts(snapshot.voiceCounts);
    });
    return () => { active = false; };
  }, [sessionReady]);

  useEffect(() => {
    if (!sessionReady) return;
    setLoading(true);
    fetch(`${serverURL}/api/rooms`)
      .then(response => response.json())
      .then((data: Room[]) => setRooms(data))
      .finally(() => setLoading(false));
  }, [serverURL, sessionReady]);

  const createRoom = async () => {
    if (!newName.trim() || !sessionReady || creatingRoom) return;
    setCreatingRoom(true);
    try {
      const result = await new Promise<{ room?: Room; error?: string }>((resolve, reject) => {
        socket.timeout(5_000).emit('room:create', createRoomPayload(newName, newMaxMembers === 'custom' ? customMaxMembers : newMaxMembers, newPassword), (error: Error | null, response: { room?: Room; error?: string }) => error ? reject(error) : resolve(response));
      });
      if (!result.room) throw new Error(result.error ?? '创建失败');
      setNewName('');
      setNewMaxMembers('');
      setCustomMaxMembers('');
      setNewPassword('');
      setCreating(false);
      navigate(`/room/${result.room.id}`);
    } catch (error) {
      alert(`创建失败：${error instanceof Error ? error.message : String(error)}\n${serverURL}`);
    } finally { setCreatingRoom(false); }
  };

  const saveSettings = () => {
    if (!draftUrl.trim()) return;
    const nextServerUrl = normalizeURL(draftUrl);
    localStorage.setItem('cove_server_url', nextServerUrl);
    saveServerCertificateException(nextServerUrl, allowUntrustedCertificate);
    window.location.reload();
  };

  return (
    <div className="flex h-full overflow-hidden bg-gradient-to-br from-zinc-950 via-black to-zinc-900">
      <aside className="flex w-72 flex-shrink-0 flex-col border-r border-white/[0.08] bg-white/[0.055] backdrop-blur-2xl">
        <div className="flex h-16 flex-shrink-0 items-center border-b border-white/[0.08] px-5">
          <img src={coveIcon} alt="Cove" className="h-9 w-9 rounded-xl shadow-lg shadow-black/30" />
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
                  <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-cyan-300/10 px-2 py-0.5 text-xs text-cyan-100/65" title="语音人数"><Headphones size={11} />{voiceCounts[room.id] ?? 0}</span>
                  {(roomMembersMap[room.id]?.length ?? 0) > 0 && <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/45" title="频道人数"><Users size={11} />{roomMembersMap[room.id].length}</span>}
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
                <span className={`min-w-0 flex-1 truncate text-sm ${isSelf ? 'font-medium text-white' : 'text-white/60'}`}>{isSelf ? `${user.username}（你）` : user.username}</span>
                {user.platform === 'mobile'
                  ? <Smartphone size={13} className="flex-shrink-0 text-cyan-100/45" aria-label="手机端" />
                  : user.platform === 'desktop'
                    ? <Monitor size={13} className="flex-shrink-0 text-cyan-100/45" aria-label="电脑端" />
                    : null}
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
          <button className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-base text-white/40 transition hover:bg-white/10 hover:text-white disabled:opacity-20" onClick={() => setCreating(true)} disabled={!sessionReady}><Plus size={17} /> 创建一个频道</button>
        </div>
      </main>

      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-md" onMouseDown={() => setCreating(false)}>
          <section className="flex w-full max-w-sm flex-col gap-5 rounded-3xl border border-white/15 bg-zinc-900/95 p-7 shadow-2xl" onMouseDown={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="create-title">
            <div className="flex items-start justify-between"><div><h2 id="create-title" className="text-xl font-bold text-white">创建频道</h2><p className="mt-1 text-sm text-white/40">创建者会成为房主</p></div><button onClick={() => setCreating(false)} className="rounded-lg p-2 text-white/35 hover:bg-white/10 hover:text-white" aria-label="关闭"><X size={18} /></button></div>
             <div><label className="mb-2 block text-sm font-medium text-white/55" htmlFor="room-name">频道名称</label><div className="flex items-center rounded-xl border border-white/10 bg-white/[0.07] px-3 focus-within:border-cyan-300/45"><Hash size={18} className="mr-2 text-white/30" /><input id="room-name" className="flex-1 bg-transparent py-3 text-base text-white outline-none placeholder:text-white/20" placeholder="general" value={newName} onChange={event => setNewName(event.target.value)} onKeyDown={event => event.key === 'Enter' && createRoom()} autoFocus /></div></div>
             <label className="block text-sm font-medium text-white/55" htmlFor="room-limit">人数上限 <select id="room-limit" value={newMaxMembers} onChange={event => setNewMaxMembers(event.target.value)} className="ml-2 rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-white"><option value="">不限</option><option value="2">2</option><option value="5">5</option><option value="10">10</option><option value="20">20</option><option value="custom">自定义</option></select>{newMaxMembers === 'custom' && <input type="number" min="1" max="1000" value={customMaxMembers} className="ml-2 w-24 rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-white" onChange={event => setCustomMaxMembers(event.target.value)} />}</label>
             <label className="block text-sm font-medium text-white/55" htmlFor="room-password">密码（可选）<input id="room-password" type="password" maxLength={128} value={newPassword} onChange={event => setNewPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-white/[0.07] px-3 py-3 text-white outline-none" /></label>
             <div className="flex gap-2.5"><button disabled={creatingRoom} className="flex-1 rounded-xl bg-white/10 py-3 font-medium text-white/70 transition hover:bg-white/15" onClick={() => { setCreating(false); setNewName(''); setNewMaxMembers(''); setCustomMaxMembers(''); setNewPassword(''); }}>取消</button><button className="flex-1 rounded-xl bg-white py-3 font-semibold text-zinc-900 transition hover:bg-cyan-100 disabled:opacity-25" disabled={!newName.trim() || !sessionReady || creatingRoom} onClick={createRoom}>{creatingRoom ? '创建中…' : '创建'}</button></div>
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
            <ServerCertificateToggle serverUrl={draftUrl} checked={allowUntrustedCertificate} onChange={setAllowUntrustedCertificate} />
            <button className="mt-5 w-full rounded-xl bg-white py-3 font-semibold text-zinc-900 transition hover:bg-cyan-100 disabled:opacity-25" disabled={!draftUrl.trim()} onClick={saveSettings}>保存并重连</button>
          </section>
        </div>
      )}

      {showProfile && <ProfileModal profile={profile} serverURL={serverURL} onSave={onProfileChange} onClose={() => setShowProfile(false)} onOpenServerSettings={() => { setShowProfile(false); setShowSettings(true); }} onReset={onReset} onSwitchServer={onSwitchServer} />}
    </div>
  );
}
