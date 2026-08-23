import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Activity, ArrowLeft, Crown, Ellipsis, Hash, Maximize2, Menu, MessageCircle,
  Mic, MicOff, Minimize2, MonitorUp, PanelRightClose, PanelRightOpen, PhoneOff,
  Send, Trash2, Volume2, VolumeX, X,
} from 'lucide-react';
import { socket } from '../socket';
import { useWebRTC, SCREEN_PRESETS, ScreenPreset, Fps, ScreenContentMode } from '../hooks/useWebRTC';
import { Avatar } from '../components/Avatar';
import { ProfileModal } from '../components/ProfileModal';
import { SoundPackPanel } from '../components/SoundPackPanel';
import { Room, Message, RoomMember, RoomState, UserProfile } from '../types';

interface Props {
  profile: UserProfile;
  onProfileChange: (profile: UserProfile) => void;
  serverURL: string;
  sessionReady: boolean;
}

function LocalScreenVideo({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  return <video ref={ref} autoPlay muted playsInline className="w-full h-full object-contain" />;
}

function RemoteScreenVideo({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    video.play().catch(() => {});
  }, [stream]);
  return <video ref={ref} autoPlay muted playsInline className="w-full h-full object-contain" />;
}

interface ScreenModalProps {
  preset: ScreenPreset; fps: Fps; mode: ScreenContentMode; audio: boolean;
  onPreset: (p: ScreenPreset) => void; onFps: (f: Fps) => void;
  onMode: (m: ScreenContentMode) => void; onAudio: () => void;
  onConfirm: () => void; onCancel: () => void;
}
function ScreenSettingsModal({ preset, fps, mode, audio, onPreset, onFps, onMode, onAudio, onConfirm, onCancel }: ScreenModalProps) {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-white/[0.08] backdrop-blur-2xl border border-white/15 rounded-3xl p-7 w-96 flex flex-col gap-5 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h2 className="text-white font-bold text-xl">屏幕共享设置</h2>
        <div>
          <p className="text-white/40 text-sm font-medium mb-2.5">内容类型</p>
          <div className="flex gap-2">
            {([
              ['detail', '文档 / 代码'],
              ['motion', '视频 / 动态'],
            ] as [ScreenContentMode, string][]).map(([value, label]) => (
              <button key={value} onClick={() => onMode(value)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors ${mode === value ? 'bg-white text-zinc-900' : 'bg-white/10 hover:bg-white/15 text-white/60'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-white/40 text-sm font-medium mb-2.5">画质</p>
          <div className="flex gap-2">
            {(Object.keys(SCREEN_PRESETS) as ScreenPreset[]).map(p => (
              <button key={p} onClick={() => onPreset(p)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors ${preset === p ? 'bg-white text-zinc-900' : 'bg-white/10 hover:bg-white/15 text-white/60'}`}>
                {SCREEN_PRESETS[p].label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-white/40 text-sm font-medium mb-2.5">帧率</p>
          <div className="flex gap-2">
            {([30, 60] as Fps[]).map(f => (
              <button key={f} onClick={() => onFps(f)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors ${fps === f ? 'bg-white text-zinc-900' : 'bg-white/10 hover:bg-white/15 text-white/60'}`}>
                {f} fps
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-white/40 text-sm font-medium mb-2.5">系统音频</p>
          <button onClick={onAudio}
            className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-colors ${audio ? 'bg-white text-zinc-900' : 'bg-white/10 hover:bg-white/15 text-white/60'}`}>
            <span className="inline-flex items-center justify-center gap-2">{audio ? <Volume2 size={17} /> : <VolumeX size={17} />}{audio ? '包含系统音频' : '不包含音频'}</span>
          </button>
        </div>
        <div className="flex gap-2.5">
          <button onClick={onCancel} className="flex-1 py-3 rounded-xl text-base bg-white/10 hover:bg-white/15 text-white/70 font-medium transition-colors">取消</button>
          <button onClick={onConfirm} className="flex-1 py-3 rounded-xl text-base bg-white hover:bg-zinc-100 text-zinc-900 font-semibold transition-colors">开始共享</button>
        </div>
      </div>
    </div>
  );
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export default function ChatRoom({ profile, onProfileChange, serverURL, sessionReady }: Props) {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const username = profile.username;

  const [room, setRoom]               = useState<Room | null>(null);
  const [messages, setMessages]       = useState<Message[]>([]);
  const [input, setInput]             = useState('');
  const [roomMembers, setRoomMembers] = useState<RoomMember[]>([]);
  const [isOwner, setIsOwner]         = useState(false);
  const [moderatingId, setModeratingId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [chatDrawerOpen, setChatDrawerOpen] = useState(true);
  const [showRoomMenu, setShowRoomMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [roomSynced, setRoomSynced] = useState(false);
  const messagesEndRef                = useRef<HTMLDivElement>(null);
  const screenContainerRef            = useRef<HTMLDivElement>(null);

  const [showScreenModal, setShowScreenModal] = useState(false);
  const [pendingPreset, setPendingPreset]     = useState<ScreenPreset>('720p');
  const [pendingFps, setPendingFps]           = useState<Fps>(30);
  const [pendingMode, setPendingMode]         = useState<ScreenContentMode>('detail');
  const [pendingAudio, setPendingAudio]       = useState(false);
  const [screenMaximized, setScreenMaximized] = useState(false);

  const rtc = useWebRTC(socket, roomId!);

  useEffect(() => {
    if (!roomId) return;
    fetch(`${serverURL}/api/rooms/${roomId}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Room>;
      }).then(setRoom).catch(() => navigate('/'));
    fetch(`${serverURL}/api/rooms/${roomId}/messages`)
      .then(r => r.json()).then(setMessages);
  }, [roomId, navigate, serverURL]);

  useEffect(() => {
    if (!roomId || !sessionReady) { setRoomSynced(false); return; }
    const joinRoom = () => socket.emit('room:join', roomId);
    const onNew = (msg: Message) => setMessages(prev => [...prev, msg]);
    const onState = (state: RoomState) => {
      if (state.roomId !== roomId) return;
      setRoomMembers(state.members);
      setIsOwner(state.isOwner);
      setRoomSynced(true);
      setRoom(current => current ? { ...current, ownerName: state.ownerName } : current);
    };
    const onDeleted = ({ roomId: deletedRoomId }: { roomId: string }) => {
      if (deletedRoomId !== roomId) return;
      rtc.leaveVoice();
      navigate('/', { replace: true });
    };
    socket.on('message:new', onNew);
    socket.on('room:state', onState);
    socket.on('room:deleted', onDeleted);
    joinRoom();
    return () => {
      socket.emit('room:leave', roomId);
      socket.off('message:new', onNew);
      socket.off('room:state', onState);
      socket.off('room:deleted', onDeleted);
      rtc.leaveVoice();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, sessionReady]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(() => {
    if (!input.trim() || !roomId) return;
    socket.emit('message:send', { roomId, content: input.trim() });
    setInput('');
  }, [input, roomId]);

  const setMemberMuted = useCallback(async (member: RoomMember) => {
    if (!roomId || !isOwner || member.isOwner) return;
    setModeratingId(member.socketId);
    try {
      const result = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        socket.timeout(5_000).emit('room:set-muted', {
          roomId,
          targetSocketId: member.socketId,
          muted: !member.isMuted,
        }, (error: Error | null, response: { ok: boolean; error?: string }) => {
          if (error) reject(error);
          else resolve(response);
        });
      });
      if (!result.ok) throw new Error(result.error ?? '操作失败');
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      setModeratingId(null);
    }
  }, [isOwner, roomId]);

  const deleteRoom = useCallback(async () => {
    if (!roomId || !isOwner || !room) return;
    try {
      const result = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        socket.timeout(5_000).emit('room:delete', { roomId }, (error: Error | null, response: { ok: boolean; error?: string }) => {
          if (error) reject(error);
          else resolve(response);
        });
      });
      if (!result.ok) throw new Error(result.error ?? '删除失败');
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    }
  }, [isOwner, room, roomId]);

  // 全屏：纯 CSS 最大化（fixed 铺满窗口）。
  // 不用原生 Fullscreen API——它在 Electron 里行为不稳定（可能 resolve 但无视觉变化）。
  // CSS fixed inset-0 是 100% 可控、必定生效的方案。
  const toggleFullscreen = useCallback(() => {
    setScreenMaximized(m => !m);
  }, []);

  // 全屏时按 Esc 退出
  useEffect(() => {
    if (!screenMaximized) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setScreenMaximized(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [screenMaximized]);

  if (!room) return (
    <div className="h-full flex items-center justify-center bg-gradient-to-br from-zinc-950 via-black to-zinc-900 text-white/40">加载中…</div>
  );

  const hasScreen    = !!rtc.localScreen || !!rtc.remoteScreen;
  return (
    <div className="h-full flex bg-gradient-to-br from-zinc-950 via-black to-zinc-900 overflow-hidden">

      {showScreenModal && (
        <ScreenSettingsModal
          preset={pendingPreset} fps={pendingFps} mode={pendingMode} audio={pendingAudio}
          onPreset={setPendingPreset} onFps={setPendingFps}
          onMode={setPendingMode}
          onAudio={() => setPendingAudio(a => !a)}
          onCancel={() => setShowScreenModal(false)}
          onConfirm={() => { setShowScreenModal(false); rtc.startScreenShare(pendingPreset, pendingFps, pendingAudio, pendingMode); }}
        />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md" onMouseDown={() => setConfirmDelete(false)}>
          <section className="w-full max-w-sm rounded-3xl border border-red-400/20 bg-zinc-900/95 p-7 shadow-2xl" onMouseDown={event => event.stopPropagation()} role="alertdialog" aria-modal="true" aria-labelledby="delete-room-title">
            <div className="flex items-start justify-between"><div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-red-500/15 text-red-300"><Trash2 size={21} /></div><button onClick={() => setConfirmDelete(false)} className="rounded-xl p-2 text-white/35 hover:bg-white/10 hover:text-white" aria-label="关闭"><X size={18} /></button></div>
            <h2 id="delete-room-title" className="mt-5 text-xl font-bold text-white">删除 #{room.name}？</h2>
            <p className="mt-2 text-sm leading-relaxed text-white/45">聊天记录、房间成员状态和语音禁言设置都会永久删除。此操作无法撤销。</p>
            <div className="mt-6 flex gap-2.5"><button onClick={() => setConfirmDelete(false)} className="flex-1 rounded-xl bg-white/10 py-3 font-medium text-white/70 transition hover:bg-white/15">取消</button><button onClick={() => { setConfirmDelete(false); deleteRoom(); }} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-red-500 py-3 font-semibold text-white transition hover:bg-red-400"><Trash2 size={17} />确认删除</button></div>
          </section>
        </div>
      )}

      {showProfile && <ProfileModal profile={profile} serverURL={serverURL} onSave={onProfileChange} onClose={() => setShowProfile(false)} />}

      {/* ── Collapsible Sidebar ── */}
      <aside
        className="flex-shrink-0 flex flex-col bg-white/[0.06] backdrop-blur-2xl border-r border-white/[0.08] overflow-hidden transition-[width] duration-200"
        style={{ width: sidebarOpen ? '18rem' : '0' }}
      >
        <div className="w-72 h-full flex flex-col">

          {/* Room header */}
          <div className="h-16 px-4 flex items-center gap-2.5 border-b border-white/[0.08] flex-shrink-0">
            <button
              onClick={() => navigate('/')}
              className="text-white/30 hover:text-white/80 transition-colors p-2 rounded-xl hover:bg-white/10"
              aria-label="返回频道列表"
            >
              <ArrowLeft size={20} />
            </button>
            <Hash size={18} className="text-white/30" />
            <span className="font-semibold text-white text-base truncate flex-1">{room.name}</span>
            {isOwner && (
              <div className="relative">
                <button onClick={() => setShowRoomMenu(open => !open)} className="rounded-lg p-2 text-white/35 transition hover:bg-white/10 hover:text-white" aria-label="房间操作" title="房间操作"><Ellipsis size={18} /></button>
                {showRoomMenu && <div className="absolute right-0 top-10 z-20 w-40 rounded-xl border border-white/10 bg-zinc-900 p-1.5 shadow-xl"><button onClick={() => { setShowRoomMenu(false); setConfirmDelete(true); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-300 transition hover:bg-red-500/10"><Trash2 size={16} /> 删除房间</button></div>}
              </div>
            )}
          </div>

          {/* Voice members (when in voice) */}
          {rtc.inVoice && rtc.voiceMembers.length > 0 && (
            <div className="px-4 pt-4 pb-2 border-b border-white/[0.08] flex-shrink-0">
              <p className="text-white/30 text-sm font-semibold uppercase tracking-wider mb-3">语音中</p>
              <div className="space-y-2">
                {rtc.voiceMembers.map(m => {
                  // 自己的音量用 localSocketId 对应的 key
                  const isSelf = m.socketId === rtc.localSocketId || m.username === username;
                  const level = rtc.speakingLevels[m.socketId] ?? (isSelf ? rtc.speakingLevels[rtc.localSocketId ?? ''] ?? 0 : 0);
                  const speaking = level > 0.08 && !m.isMuted && !(isSelf && rtc.isMuted);
                  return (
                    <div key={m.socketId} className="flex items-center gap-2.5 px-1">
                      <Avatar username={m.username} avatarUrl={m.avatarUrl} size="sm" className={speaking ? 'border-green-400/60 ring-2 ring-green-400/40' : ''} />
                      <div className="flex-1 min-w-0">
                        <span className="text-base text-white/70 truncate font-medium block leading-tight">
                          {m.username}
                          {(m.isMuted || (isSelf && rtc.isMuted)) && <MicOff size={13} className="ml-1 inline text-white/35" aria-label="已静音" />}
                        </span>
                        {/* 实时音量条 */}
                        <div className="h-1 mt-1 rounded-full bg-white/10 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-green-400 to-emerald-300 transition-[width] duration-75"
                            style={{ width: `${Math.round((m.isMuted || (isSelf && rtc.isMuted) ? 0 : level) * 100)}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Room members */}
          <div className="flex-1 overflow-y-auto p-4">
            <p className="text-white/30 text-sm font-semibold uppercase tracking-wider mb-3">
              成员 — {roomMembers.length}
            </p>
            <div className="space-y-1">
              {roomMembers.map(member => {
                const isSelf = member.socketId === socket.id;
                return (
                <div key={member.socketId} className="group flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-white/[0.06] transition-colors">
                  <Avatar username={member.username} avatarUrl={member.avatarUrl} size="sm" className={isSelf ? 'border-white/30' : ''} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-base truncate font-medium ${isSelf ? 'text-white' : 'text-white/55'}`}>
                        {isSelf ? `${member.username}（你）` : member.username}
                      </span>
                      {member.isOwner && <Crown size={14} className="flex-shrink-0 text-amber-300" aria-label="房主" />}
                      {member.isMuted && <MicOff size={13} className="flex-shrink-0 text-red-300/70" aria-label="已被房主语音禁言" />}
                    </div>
                    {member.isOwner && <p className="text-amber-300/50 text-xs mt-0.5">房主</p>}
                  </div>
                  {isOwner && !member.isOwner && !isSelf && (
                    <button
                      onClick={() => setMemberMuted(member)}
                      disabled={moderatingId === member.socketId || !sessionReady || !roomSynced}
                      className={`flex-shrink-0 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 ${
                        member.isMuted
                          ? 'bg-green-500/10 text-green-300 hover:bg-green-500/20'
                          : 'bg-red-500/10 text-red-300 hover:bg-red-500/20'
                      }`}
                    >{member.isMuted ? '解除语音禁言' : '语音禁言'}</button>
                  )}
                </div>
              )})}
            </div>
          </div>

          {/* ── Sound Pack Panel ── */}
          <SoundPackPanel socket={socket} roomId={roomId!} serverURL={serverURL} disabled={!sessionReady || !roomSynced} />

        </div>
      </aside>

      {/* ── Main area ── */}
      <div className="relative flex min-w-0 flex-1 flex-col">

        {/* Header */}
        <header className="h-16 flex-shrink-0 flex items-center gap-3 px-5 bg-white/[0.04] backdrop-blur-xl border-b border-white/[0.08]">
          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="text-white/30 hover:text-white/80 transition-colors p-2 rounded-xl hover:bg-white/10 flex-shrink-0"
            aria-label={sidebarOpen ? '收起成员栏' : '展开成员栏'}
          >
            <Menu size={20} />
          </button>
          <Hash size={19} className="text-white/30" />
          <span className="font-semibold text-white text-lg">{room.name}</span>
          <div className="ml-auto flex items-center gap-2">
            {!rtc.inVoice ? (
              <button onClick={rtc.joinVoice} disabled={!sessionReady || !roomSynced} className="inline-flex items-center gap-2 rounded-xl bg-white px-3.5 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-30">{rtc.isForceMuted ? <MicOff size={17} /> : <Mic size={17} />}{rtc.isForceMuted ? '加入语音（已被禁言）' : '加入语音'}</button>
            ) : (
              <div className="flex items-center gap-1.5 rounded-2xl border border-white/10 bg-black/20 p-1.5">
                <button onClick={rtc.toggleStats} className={`rounded-xl p-2 transition ${rtc.statsEnabled ? 'bg-sky-500/20 text-sky-300' : 'text-white/45 hover:bg-white/10 hover:text-white'}`} aria-label={rtc.statsEnabled ? '关闭媒体统计' : '打开媒体统计'} title="媒体统计"><Activity size={18} /></button>
                <button onClick={rtc.toggleMute} disabled={rtc.isForceMuted || !sessionReady} className={`rounded-xl p-2 transition disabled:cursor-not-allowed ${rtc.isForceMuted || rtc.isMuted ? 'bg-red-500/20 text-red-300' : 'text-white/60 hover:bg-white/10 hover:text-white'}`} aria-label={rtc.isForceMuted ? '已被房主语音禁言' : rtc.isMuted ? '取消静音' : '静音'} title={rtc.isForceMuted ? '已被房主语音禁言' : rtc.isMuted ? '取消静音' : '静音'}>{rtc.isMuted || rtc.isForceMuted ? <MicOff size={18} /> : <Mic size={18} />}</button>
                <button onClick={!rtc.isSharing ? () => setShowScreenModal(true) : rtc.stopScreenShare} disabled={!sessionReady} className={`rounded-xl p-2 transition ${rtc.isSharing ? 'bg-amber-500/20 text-amber-300' : 'text-white/60 hover:bg-white/10 hover:text-white'}`} aria-label={rtc.isSharing ? '停止屏幕共享' : '开始屏幕共享'} title={rtc.isSharing ? '停止屏幕共享' : '开始屏幕共享'}><MonitorUp size={18} /></button>
                <button onClick={rtc.leaveVoice} className="rounded-xl p-2 text-white/45 transition hover:bg-red-500/20 hover:text-red-300" aria-label="离开语音" title="离开语音"><PhoneOff size={18} /></button>
              </div>
            )}
            {hasScreen && <button onClick={() => setChatDrawerOpen(open => !open)} className="rounded-xl p-2 text-white/45 transition hover:bg-white/10 hover:text-white" aria-label={chatDrawerOpen ? '收起聊天栏' : '展开聊天栏'} title={chatDrawerOpen ? '收起聊天栏' : '展开聊天栏'}>{chatDrawerOpen ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}</button>}
            <button onClick={() => setShowProfile(true)} className="rounded-full focus:outline-none focus:ring-2 focus:ring-cyan-300/50" aria-label="打开个人名片" title="个人名片"><Avatar username={profile.username} avatarUrl={profile.avatarUrl} size="sm" /></button>
            {!sidebarOpen && <button onClick={() => navigate('/')} className="rounded-xl p-2 text-white/40 transition hover:bg-white/10 hover:text-white" aria-label="返回频道列表" title="返回频道列表"><ArrowLeft size={19} /></button>}
          </div>
        </header>

        {/* Screen share */}
        {hasScreen && (
          <div
            className={screenMaximized
              ? 'fixed inset-0 z-[100] bg-black'
              : 'min-h-0 flex-1 bg-black'}
          >
            <div ref={screenContainerRef} className="h-full relative">
              {rtc.remoteScreen ? (
                <>
                  <RemoteScreenVideo stream={rtc.remoteScreen.stream} />
                  <div className="absolute bottom-3 left-3 bg-black/60 backdrop-blur-md text-white text-sm px-3 py-1.5 rounded-xl font-medium border border-white/10">
                    {rtc.voiceMembers.find(m => m.socketId === rtc.remoteScreen!.socketId)?.username ?? rtc.remoteScreen.socketId} 正在共享
                  </div>
                </>
              ) : rtc.localScreen ? (
                <>
                  <LocalScreenVideo stream={rtc.localScreen} />
                  <div className="absolute bottom-3 left-3 bg-white/10 backdrop-blur-md text-white text-sm px-3 py-1.5 rounded-xl font-medium border border-white/15">
                    你正在共享
                  </div>
                </>
              ) : null}

              {/* 实时统计悬浮显示（开关在语音栏） */}
              {rtc.statsEnabled && (
                <div className="absolute top-3 left-3 bg-black/70 backdrop-blur-md text-white text-xs px-3 py-2 rounded-xl border border-white/10 font-mono space-y-0.5 pointer-events-none">
                  <div>帧率 FPS：<span className="text-green-400">{rtc.stats.fps ?? '—'}</span></div>
                  <div>画面：<span className="text-cyan-300">{rtc.stats.width && rtc.stats.height ? `${rtc.stats.width}×${rtc.stats.height}` : '—'}</span></div>
                  <div>码率：<span className="text-cyan-300">{rtc.stats.bitrate != null ? `${rtc.stats.bitrate} kbps` : '—'}</span></div>
                  <div>可用带宽：<span className="text-cyan-300">{rtc.stats.availableBitrate != null ? `${rtc.stats.availableBitrate} kbps` : '—'}</span></div>
                  <div>延迟 RTT：<span className="text-amber-400">{rtc.stats.rtt != null ? `${rtc.stats.rtt} ms` : '—'}</span></div>
                  <div>抖动 Jitter：<span className="text-amber-400">{rtc.stats.jitter != null ? `${rtc.stats.jitter} ms` : '—'}</span></div>
                  <div>丢包 Loss：<span className="text-red-400">{rtc.stats.loss != null ? `${rtc.stats.loss}%` : '—'}</span></div>
                  <div>丢帧：<span className="text-red-400">{rtc.stats.droppedFrames ?? '—'}</span></div>
                  <div>受限原因：<span className="text-white/70">{rtc.stats.qualityLimitation ?? '—'}</span></div>
                  <div>协议：<span className="text-white/70">{rtc.stats.protocol ?? '—'}</span></div>
                </div>
              )}

              <button
                onClick={toggleFullscreen}
                className="absolute top-3 right-3 inline-flex items-center gap-2 bg-black/50 hover:bg-black/70 backdrop-blur-md text-white text-sm px-3 py-1.5 rounded-xl transition-colors font-medium border border-white/10 z-10"
              >{screenMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}{screenMaximized ? '退出全屏' : '全屏'}</button>
            </div>
          </div>
        )}

        {/* Messages */}
        <div className={hasScreen ? (chatDrawerOpen ? 'absolute bottom-20 right-0 top-16 z-10 w-96 overflow-y-auto border-l border-white/10 bg-zinc-950/90 px-5 py-4 shadow-2xl backdrop-blur-xl space-y-0.5' : 'hidden') : 'flex-1 overflow-y-auto min-h-0 px-6 py-5 space-y-0.5'}>
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <MessageCircle size={42} className="text-white/20" />
              <p className="text-white/40 text-lg">这是 <span className="text-white/70 font-semibold">#{room.name}</span> 的起始位置</p>
            </div>
          )}
          {messages.map((msg, idx) => {
            const isMe    = msg.author === username;
            const prevMsg = messages[idx - 1];
            const grouped = prevMsg && prevMsg.author === msg.author &&
              msg.timestamp - prevMsg.timestamp < 5 * 60 * 1000;

            return (
              <div key={msg.id} className={`flex items-end gap-3 ${isMe ? 'flex-row-reverse' : ''} ${grouped ? 'mt-1' : 'mt-5'}`}>
                {!grouped ? (
                  isMe ? <Avatar username={profile.username} avatarUrl={profile.avatarUrl} size="sm" className="mb-0.5" /> : <Avatar username={msg.author} size="sm" className="mb-0.5" />
                ) : (
                  <div className="w-9 flex-shrink-0" />
                )}

                <div className={`flex flex-col gap-1 max-w-sm lg:max-w-lg ${isMe ? 'items-end' : 'items-start'}`}>
                  {!grouped && (
                    <div className={`flex items-baseline gap-2 px-1 ${isMe ? 'flex-row-reverse' : ''}`}>
                      <span className="text-sm font-semibold text-white/60">{isMe ? '你' : msg.author}</span>
                      <span className="text-sm text-white/25">{formatTime(msg.timestamp)}</span>
                    </div>
                  )}
                  <div className={`px-4 py-2.5 rounded-2xl text-base leading-relaxed ${
                    isMe
                      ? 'bg-white text-zinc-900 rounded-br-sm'
                      : 'bg-white/10 backdrop-blur-sm text-white rounded-bl-sm border border-white/[0.08]'
                  }`}>
                    {msg.content}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className={hasScreen ? (chatDrawerOpen ? 'absolute bottom-0 right-0 z-10 w-96 border-l border-t border-white/10 bg-zinc-950/95 px-4 py-3 backdrop-blur-xl' : 'hidden') : 'flex-shrink-0 px-5 py-4 border-t border-white/[0.08]'}>
          <div className="flex items-center gap-3 bg-white/[0.07] backdrop-blur-xl border border-white/10 rounded-2xl px-5 py-3.5 focus-within:border-white/20 focus-within:bg-white/10 transition-all">
            <input
              className="flex-1 bg-transparent text-white text-base placeholder-white/25 outline-none"
              placeholder={`在 #${room.name} 发消息…`}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
            />
            <button
              className="text-white/25 hover:text-white/70 transition-colors disabled:opacity-20 flex-shrink-0"
              disabled={!input.trim()}
              onClick={sendMessage}
              aria-label="发送消息"
            >
              <Send size={19} />
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
