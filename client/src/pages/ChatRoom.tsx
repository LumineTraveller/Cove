import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { socket } from '../socket';
import { useWebRTC, SCREEN_PRESETS, ScreenPreset, Fps, ScreenContentMode } from '../hooks/useWebRTC';
import { SoundPackPanel } from '../components/SoundPackPanel';
import { Room, Message, RoomMember, RoomState } from '../types';

interface Props { username: string; serverURL: string }

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
            {audio ? '🔊 包含系统音频' : '🔇 不包含音频'}
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

export default function ChatRoom({ username, serverURL }: Props) {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();

  const [room, setRoom]               = useState<Room | null>(null);
  const [messages, setMessages]       = useState<Message[]>([]);
  const [input, setInput]             = useState('');
  const [roomMembers, setRoomMembers] = useState<RoomMember[]>([]);
  const [isOwner, setIsOwner]         = useState(false);
  const [moderatingId, setModeratingId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
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
    if (!roomId) return;
    const joinRoom = () => socket.emit('room:join', roomId);
    const onNew = (msg: Message) => setMessages(prev => [...prev, msg]);
    const onState = (state: RoomState) => {
      if (state.roomId !== roomId) return;
      setRoomMembers(state.members);
      setIsOwner(state.isOwner);
      setRoom(current => current ? { ...current, ownerName: state.ownerName } : current);
    };
    const onDeleted = ({ roomId: deletedRoomId }: { roomId: string }) => {
      if (deletedRoomId !== roomId) return;
      rtc.leaveVoice();
      navigate('/', { replace: true });
    };
    socket.on('connect', joinRoom);
    socket.on('message:new', onNew);
    socket.on('room:state', onState);
    socket.on('room:deleted', onDeleted);
    joinRoom();
    return () => {
      socket.emit('room:leave', roomId);
      socket.off('connect', joinRoom);
      socket.off('message:new', onNew);
      socket.off('room:state', onState);
      socket.off('room:deleted', onDeleted);
      rtc.leaveVoice();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

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
    if (!window.confirm(`确定删除房间 #${room.name} 吗？\n聊天记录和禁言设置也会被永久删除。`)) return;
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
  const avatarLetter = (n: string) => n[0]?.toUpperCase() ?? '?';

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
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="text-white/30 text-lg">#</span>
            <span className="font-semibold text-white text-base truncate flex-1">{room.name}</span>
            {isOwner && (
              <button
                onClick={deleteRoom}
                className="text-red-400/60 hover:text-red-300 hover:bg-red-500/10 px-2 py-1.5 rounded-lg text-sm font-medium transition-colors"
                title="删除房间"
              >删除</button>
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
                      <div className={`w-8 h-8 rounded-full border flex items-center justify-center text-sm font-bold text-white flex-shrink-0 transition-all ${
                        speaking ? 'bg-green-500/30 border-green-400/60 ring-2 ring-green-400/40' : 'bg-white/10 border-white/15'
                      }`}>
                        {avatarLetter(m.username)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-base text-white/70 truncate font-medium block leading-tight">
                          {m.username}
                          {(m.isMuted || (isSelf && rtc.isMuted)) && <span className="text-white/30 ml-1 text-sm">🔇</span>}
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
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 border ${
                    isSelf
                      ? 'bg-white/20 text-white border-white/30'
                      : 'bg-white/[0.06] text-white/60 border-white/10'
                  }`}>
                    {avatarLetter(member.username)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-base truncate font-medium ${isSelf ? 'text-white' : 'text-white/55'}`}>
                        {isSelf ? `${member.username}（你）` : member.username}
                      </span>
                      {member.isOwner && <span className="text-amber-300 text-sm flex-shrink-0" title="房主">♛</span>}
                      {member.isMuted && <span className="text-red-300/70 text-xs flex-shrink-0" title="已被房主禁言">🔇</span>}
                    </div>
                    {member.isOwner && <p className="text-amber-300/50 text-xs mt-0.5">房主</p>}
                  </div>
                  {isOwner && !member.isOwner && !isSelf && (
                    <button
                      onClick={() => setMemberMuted(member)}
                      disabled={moderatingId === member.socketId}
                      className={`flex-shrink-0 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 ${
                        member.isMuted
                          ? 'bg-green-500/10 text-green-300 hover:bg-green-500/20'
                          : 'bg-red-500/10 text-red-300 hover:bg-red-500/20'
                      }`}
                    >{member.isMuted ? '解除' : '禁言'}</button>
                  )}
                </div>
              )})}
            </div>
          </div>

          {/* ── Sound Pack Panel ── */}
          <SoundPackPanel socket={socket} roomId={roomId!} serverURL={serverURL} />

          {/* ── Bottom voice bar ── */}
          <div className="flex-shrink-0 border-t border-white/[0.08] p-3">
            {!rtc.inVoice ? (
              <button
                onClick={rtc.joinVoice}
                className="w-full bg-white/10 hover:bg-white/15 text-white text-base font-semibold py-3 rounded-xl transition-colors border border-white/10"
              >
                {rtc.isForceMuted ? '🔇 加入语音（房主已禁言）' : '🎤 加入语音'}
              </button>
            ) : (
              <div className="flex flex-col gap-2">
              {/* 调试信息开关 */}
              <button
                onClick={rtc.toggleStats}
                className={`w-full flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-medium transition-colors ${
                  rtc.statsEnabled
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/25'
                    : 'bg-white/[0.06] text-white/50 hover:bg-white/10 border border-white/10'
                }`}
              >
                <span>📊</span>
                <span>{rtc.statsEnabled ? '调试信息：开' : '调试信息：关'}</span>
                {rtc.statsEnabled && (
                  <span className="font-mono text-xs text-white/40">
                    {rtc.stats.fps ?? '—'}fps · {rtc.stats.rtt ?? '—'}ms · {rtc.stats.loss ?? '—'}% · {rtc.stats.protocol ?? '—'}
                  </span>
                )}
              </button>
              <div className="flex gap-2">
                {/* Mic */}
                <button
                  onClick={rtc.toggleMute}
                  disabled={rtc.isForceMuted}
                  title={rtc.isForceMuted ? '你已被房主禁言' : (rtc.isMuted ? '取消静音' : '静音')}
                  className={`flex-1 flex flex-col items-center justify-center gap-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                    rtc.isForceMuted
                      ? 'bg-red-500/15 text-red-300/70 border border-red-500/20 cursor-not-allowed'
                      : rtc.isMuted
                      ? 'bg-red-500/20 text-red-400 border border-red-500/20'
                      : 'bg-white/10 text-white/70 hover:bg-white/15 border border-white/10'
                  }`}
                >
                  <span className="text-lg">{rtc.isMuted ? '🔇' : '🎤'}</span>
                  <span>{rtc.isForceMuted ? '房主禁言' : (rtc.isMuted ? '已静音' : '麦克风')}</span>
                </button>
                {/* Screen share */}
                <button
                  onClick={!rtc.isSharing ? () => setShowScreenModal(true) : rtc.stopScreenShare}
                  title={rtc.isSharing ? '停止共享' : '共享屏幕'}
                  className={`flex-1 flex flex-col items-center justify-center gap-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                    rtc.isSharing
                      ? 'bg-amber-500/20 text-amber-400 border border-amber-500/20'
                      : 'bg-white/10 text-white/70 hover:bg-white/15 border border-white/10'
                  }`}
                >
                  <span className="text-lg">📺</span>
                  <span>{rtc.isSharing ? '停止共享' : '共享屏幕'}</span>
                </button>
                {/* Leave */}
                <button
                  onClick={rtc.leaveVoice}
                  title="离开语音"
                  className="flex-1 flex flex-col items-center justify-center gap-1 py-2.5 rounded-xl text-sm font-medium bg-white/10 text-white/50 hover:bg-red-500/20 hover:text-red-400 border border-white/10 hover:border-red-500/20 transition-colors"
                >
                  <span className="text-lg">📵</span>
                  <span>离开</span>
                </button>
              </div>
              </div>
            )}
          </div>

        </div>
      </aside>

      {/* ── Main area ── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Header */}
        <header className="h-16 flex-shrink-0 flex items-center gap-3 px-5 bg-white/[0.04] backdrop-blur-xl border-b border-white/[0.08]">
          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="text-white/30 hover:text-white/80 transition-colors p-2 rounded-xl hover:bg-white/10 flex-shrink-0"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="text-white/30 text-xl">#</span>
          <span className="font-semibold text-white text-lg">{room.name}</span>
          {!sidebarOpen && (
            <button
              onClick={() => navigate('/')}
              className="ml-auto text-white/30 hover:text-white/70 text-base transition-colors flex items-center gap-1.5 font-medium"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              返回
            </button>
          )}
        </header>

        {/* Screen share */}
        {hasScreen && (
          <div
            className={screenMaximized
              ? 'fixed inset-0 z-[100] bg-black'
              : 'flex-shrink-0 bg-black border-b border-white/[0.08]'}
            style={screenMaximized ? undefined : { height: '45vh' }}
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
                className="absolute top-3 right-3 bg-black/50 hover:bg-black/70 backdrop-blur-md text-white text-sm px-3 py-1.5 rounded-xl transition-colors font-medium border border-white/10 z-10"
              >{screenMaximized ? '⛗ 退出全屏' : '⛶ 全屏'}</button>
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-5 space-y-0.5">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <span className="text-5xl">👋</span>
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
                  <div className={`w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center text-sm font-bold mb-0.5 border ${
                    isMe
                      ? 'bg-white/20 text-white border-white/25'
                      : 'bg-white/[0.07] text-white/70 border-white/10'
                  }`}>
                    {avatarLetter(msg.author)}
                  </div>
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
        <div className="flex-shrink-0 px-5 py-4 border-t border-white/[0.08]">
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
            >
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
              </svg>
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
