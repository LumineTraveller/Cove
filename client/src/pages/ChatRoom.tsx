import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Activity, ArrowLeft, Crown, Ellipsis, Eye, EyeOff, Gamepad2, Hash, Headphones, ImagePlus, LoaderCircle, Maximize2, Menu, MessageCircle,
  Mic, MicOff, Minimize2, MonitorPlay, MonitorUp, PanelRightClose, PanelRightOpen, PhoneOff,
  RefreshCw, Send, Settings2, Trash2, UserMinus, UserRound, Volume2, VolumeX, X,
} from 'lucide-react';
import { socket } from '../socket';
import { useWebRTC, SCREEN_PRESETS, ScreenPreset, Fps } from '../hooks/useWebRTC';
import { Avatar } from '../components/Avatar';
import { ProfileModal } from '../components/ProfileModal';
import { UserProfileModal } from '../components/UserProfileModal';
import { SoundPackPanel } from '../components/SoundPackPanel';
import { loadProfileRemarks, saveProfileRemark } from '../profileRemarks';
import { Room, Message, RoomMember, RoomState, UserProfile } from '../types';
import { AudioDeviceOption, DEFAULT_AUDIO_DEVICE_ID } from '../audioDevices';
import {
  CHAT_IMAGE_MAX_BATCH,
  chatImageMimeType,
  collectChatImageFiles,
  validateChatImageFile,
} from '../chatImages';
import { parseChatText } from '../chatLinks';

function ChatMessageText({ content, isMe }: { content: string; isMe: boolean }) {
  const openExternal = (event: React.MouseEvent<HTMLAnchorElement>, url: string) => {
    event.preventDefault();
    if (window.coveShell) {
      void window.coveShell.openExternal(url);
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <>
      {parseChatText(content).map((segment, index) => segment.kind === 'link' && segment.href ? (
        <a
          key={`${index}-${segment.href}`}
          href={segment.href}
          onClick={event => openExternal(event, segment.href!)}
          className={`break-all font-medium underline decoration-1 underline-offset-2 transition-colors ${isMe ? 'text-blue-600 decoration-blue-600/65 hover:text-blue-800' : 'text-blue-400 decoration-blue-400/70 hover:text-blue-300'}`}
          title="在默认浏览器中打开"
          rel="noreferrer noopener"
        >
          {segment.text}
        </a>
      ) : <span key={index}>{segment.text}</span>)}
    </>
  );
}

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
  preset: ScreenPreset; fps: Fps; audio: boolean; gameMode: boolean;
  onPreset: (p: ScreenPreset) => void; onFps: (f: Fps) => void;
  onAudio: () => void; onGameMode: () => void;
  onConfirm: () => void; onCancel: () => void;
}
function ScreenSettingsModal({ preset, fps, audio, gameMode, onPreset, onFps, onAudio, onGameMode, onConfirm, onCancel }: ScreenModalProps) {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-50" onClick={onCancel}>
      <div className="max-h-[90vh] w-96 overflow-y-auto rounded-3xl border border-white/15 bg-white/[0.08] p-7 shadow-2xl backdrop-blur-2xl flex flex-col gap-5" onClick={e => e.stopPropagation()}>
        <h2 className="text-white font-bold text-xl">屏幕共享设置</h2>
        <p className={`rounded-2xl border px-4 py-3 text-xs leading-relaxed ${gameMode ? 'border-amber-300/20 bg-amber-300/[0.07] text-amber-100/75' : 'border-cyan-300/10 bg-cyan-300/[0.05] text-cyan-100/65'}`}>
          {gameMode
            ? '游戏模式不会分析画面变化，会持续使用所选画质的 60 FPS 与最高码率。网络占用会明显增加。'
            : 'Cove 会自动识别静止画面、普通操作和动态内容，并实时调整帧率与码率。下方帧率仅表示允许使用的最高值。'}
        </p>
        <div>
          <p className="text-white/40 text-sm font-medium mb-2.5">传输模式</p>
          <button onClick={onGameMode} aria-pressed={gameMode}
            className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${gameMode ? 'border-amber-300/35 bg-amber-300/15 text-amber-100' : 'border-white/10 bg-white/[0.06] text-white/60 hover:bg-white/10'}`}>
            <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${gameMode ? 'bg-amber-200 text-zinc-900' : 'bg-white/10 text-white/45'}`}><Gamepad2 size={19} /></span>
            <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">游戏模式</span><span className="mt-0.5 block text-xs opacity-60">固定最高帧率和码率，不检测画面动态</span></span>
            <span className={`rounded-full px-2 py-1 text-xs font-semibold ${gameMode ? 'bg-amber-100/20' : 'bg-white/10'}`}>{gameMode ? '已开启' : '已关闭'}</span>
          </button>
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
              <button key={f} onClick={() => onFps(f)} disabled={gameMode}
                className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors disabled:cursor-not-allowed ${fps === f ? 'bg-white text-zinc-900' : 'bg-white/10 hover:bg-white/15 text-white/60'} ${gameMode && f === 30 ? 'opacity-30' : ''}`}>
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
          {audio && (
            <p className="mt-2 text-xs leading-relaxed text-amber-200/70">
              Windows 会采集这台电脑正在播放的全部声音，包括 Cove 通话。若对方听到自己的回声，请关闭系统音频。
            </p>
          )}
        </div>
        <div className="flex gap-2.5">
          <button onClick={onCancel} className="flex-1 py-3 rounded-xl text-base bg-white/10 hover:bg-white/15 text-white/70 font-medium transition-colors">取消</button>
          <button onClick={onConfirm} className="flex-1 py-3 rounded-xl text-base bg-white hover:bg-zinc-100 text-zinc-900 font-semibold transition-colors">开始共享</button>
        </div>
      </div>
    </div>
  );
}

interface AudioDeviceModalProps {
  inputDevices: AudioDeviceOption[];
  outputDevices: AudioDeviceOption[];
  selectedInputId: string;
  selectedOutputId: string;
  refreshing: boolean;
  switchingInput: boolean;
  error: string | null;
  onInput: (deviceId: string) => Promise<void>;
  onOutput: (deviceId: string) => Promise<void>;
  onRefresh: (requestPermission?: boolean) => Promise<void>;
  onClose: () => void;
}

function AudioDeviceModal({
  inputDevices, outputDevices, selectedInputId, selectedOutputId,
  refreshing, switchingInput, error, onInput, onOutput, onRefresh, onClose,
}: AudioDeviceModalProps) {
  const inputUnavailable = selectedInputId !== DEFAULT_AUDIO_DEVICE_ID
    && !inputDevices.some(device => device.deviceId === selectedInputId);
  const outputUnavailable = selectedOutputId !== DEFAULT_AUDIO_DEVICE_ID
    && !outputDevices.some(device => device.deviceId === selectedOutputId);
  const labelsHidden = [...inputDevices, ...outputDevices].some(device => /^(麦克风|扬声器) \d+$/.test(device.label));

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md" onMouseDown={onClose}>
      <section className="w-full max-w-md rounded-3xl border border-white/15 bg-zinc-900/95 p-6 shadow-2xl" onMouseDown={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="audio-device-title">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="audio-device-title" className="text-xl font-bold text-white">音频设备</h2>
            <p className="mt-1 text-sm text-white/40">切换后自动记忆，下次启动继续使用。</p>
          </div>
          <button onClick={onClose} className="rounded-xl p-2 text-white/35 transition hover:bg-white/10 hover:text-white" aria-label="关闭音频设备设置"><X size={18} /></button>
        </div>

        <div className="mt-6 space-y-5">
          <label className="block">
            <span className="mb-2 flex items-center gap-2 text-sm font-semibold text-white/65"><Mic size={16} />收音设备</span>
            <select
              value={selectedInputId}
              disabled={switchingInput || refreshing}
              onChange={event => { void onInput(event.target.value); }}
              className="w-full rounded-xl border border-white/10 bg-black/35 px-3 py-3 text-sm text-white outline-none transition focus:border-cyan-300/45 disabled:cursor-wait disabled:opacity-50"
            >
              <option value={DEFAULT_AUDIO_DEVICE_ID}>系统默认麦克风</option>
              {inputUnavailable && <option value={selectedInputId}>此前选择的麦克风（当前不可用）</option>}
              {inputDevices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
            </select>
            {switchingInput && <span className="mt-2 inline-flex items-center gap-2 text-xs text-cyan-200/70"><LoaderCircle size={13} className="animate-spin" />正在切换麦克风，不会退出语音</span>}
          </label>

          <label className="block">
            <span className="mb-2 flex items-center gap-2 text-sm font-semibold text-white/65"><Volume2 size={16} />扬声器</span>
            <select
              value={selectedOutputId}
              disabled={refreshing}
              onChange={event => { void onOutput(event.target.value); }}
              className="w-full rounded-xl border border-white/10 bg-black/35 px-3 py-3 text-sm text-white outline-none transition focus:border-cyan-300/45 disabled:cursor-wait disabled:opacity-50"
            >
              <option value={DEFAULT_AUDIO_DEVICE_ID}>系统默认扬声器</option>
              {outputUnavailable && <option value={selectedOutputId}>此前选择的扬声器（当前不可用）</option>}
              {outputDevices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
            </select>
            <p className="mt-2 text-xs leading-relaxed text-white/30">影响语音、共享音频、语音包和加入/退出提示音。</p>
          </label>
        </div>

        {labelsHidden && <p className="mt-5 rounded-xl border border-amber-300/15 bg-amber-300/[0.06] px-3 py-2 text-xs leading-relaxed text-amber-100/65">Windows 尚未提供设备名称。点击“授权并刷新”后即可显示完整名称。</p>}
        {error && <p className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200">{error}</p>}

        <div className="mt-6 flex gap-2.5">
          <button onClick={() => { void onRefresh(true); }} disabled={refreshing || switchingInput} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-white/10 py-3 text-sm font-semibold text-white/70 transition hover:bg-white/15 disabled:cursor-wait disabled:opacity-45">
            {refreshing ? <LoaderCircle size={16} className="animate-spin" /> : <RefreshCw size={16} />}{refreshing ? '正在读取' : '授权并刷新'}
          </button>
          <button onClick={onClose} className="flex-1 rounded-xl bg-white py-3 text-sm font-semibold text-zinc-900 transition hover:bg-cyan-100">完成</button>
        </div>
      </section>
    </div>
  );
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片读取失败'));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
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
  const [kickingId, setKickingId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [chatDrawerOpen, setChatDrawerOpen] = useState(true);
  const [showRoomMenu, setShowRoomMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [viewingProfile, setViewingProfile] = useState<{ userId: string; socketId: string; username: string; avatarUrl?: string | null } | null>(null);
  const [profileRemarks, setProfileRemarks] = useState(loadProfileRemarks);
  const [roomSynced, setRoomSynced] = useState(false);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  const [imageDragActive, setImageDragActive] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const messagesEndRef                = useRef<HTMLDivElement>(null);
  const screenContainerRef            = useRef<HTMLDivElement>(null);
  const imageInputRef                 = useRef<HTMLInputElement>(null);
  const messageInputRef               = useRef<HTMLTextAreaElement>(null);
  const imageUploadingRef             = useRef(false);
  const imageDragDepthRef             = useRef(0);
  const initiallyScrolledRoomRef      = useRef<string | null>(null);

  const [showScreenModal, setShowScreenModal] = useState(false);
  const [pendingPreset, setPendingPreset]     = useState<ScreenPreset>('720p');
  const [pendingFps, setPendingFps]           = useState<Fps>(30);
  const [pendingAudio, setPendingAudio]       = useState(false);
  const [pendingGameMode, setPendingGameMode] = useState(false);
  const [screenMaximized, setScreenMaximized] = useState(false);
  const [showAudioDevices, setShowAudioDevices] = useState(false);

  const rtc = useWebRTC(socket, roomId!);

  useEffect(() => {
    if (!roomId) return;
    let active = true;
    setRoom(null);
    setMessages([]);
    setMessagesLoaded(false);
    fetch(`${serverURL}/api/rooms/${roomId}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Room>;
      })
      .then(nextRoom => { if (active) setRoom(nextRoom); })
      .catch(() => { if (active) navigate('/'); });
    fetch(`${serverURL}/api/rooms/${roomId}/messages`)
      .then(r => r.json())
      .then((history: Message[]) => {
        if (!active) return;
        setMessages(current => {
          const merged = new Map(history.map(message => [message.id, message]));
          current.forEach(message => merged.set(message.id, message));
          return [...merged.values()].sort((left, right) => left.timestamp - right.timestamp);
        });
        setMessagesLoaded(true);
      })
      .catch(() => { if (active) setMessagesLoaded(true); });
    return () => { active = false; };
  }, [roomId, navigate, serverURL]);

  useEffect(() => {
    if (!roomId || !sessionReady) { setRoomSynced(false); return; }
    const joinRoom = () => socket.emit('room:join', roomId);
    const onNew = (msg: Message) => setMessages(prev => prev.some(current => current.id === msg.id) ? prev : [...prev, msg]);
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
    const onKicked = ({ roomId: kickedRoomId, by }: { roomId: string; by?: string }) => {
      if (kickedRoomId !== roomId) return;
      rtc.leaveVoice();
      window.alert(`你已被${by ? ` ${by} ` : '房主'}移出房间。`);
      navigate('/', { replace: true });
    };
    const onRoomPresence = ({ roomId: presenceRoomId, action }: { roomId: string; action: 'join' | 'leave' }) => {
      if (presenceRoomId === roomId) rtc.playPresenceTone(action);
    };
    socket.on('message:new', onNew);
    socket.on('room:state', onState);
    socket.on('room:deleted', onDeleted);
    socket.on('room:kicked', onKicked);
    socket.on('room:presence', onRoomPresence);
    joinRoom();
    return () => {
      socket.emit('room:leave', roomId);
      socket.off('message:new', onNew);
      socket.off('room:state', onState);
      socket.off('room:deleted', onDeleted);
      socket.off('room:kicked', onKicked);
      socket.off('room:presence', onRoomPresence);
      rtc.leaveVoice();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, sessionReady]);

  const chatHistoryReady = messagesLoaded && room?.id === roomId;
  useLayoutEffect(() => {
    if (!chatHistoryReady || !roomId || !messagesEndRef.current) return;
    const isInitialScroll = initiallyScrolledRoomRef.current !== roomId;
    messagesEndRef.current.scrollIntoView({
      behavior: isInitialScroll ? 'auto' : 'smooth',
      block: 'end',
    });
    initiallyScrolledRoomRef.current = roomId;
  }, [chatHistoryReady, messages, roomId]);

  useLayoutEffect(() => {
    const element = messageInputRef.current;
    if (!element) return;
    element.style.height = '0px';
    const height = Math.min(Math.max(element.scrollHeight, 24), 128);
    element.style.height = `${height}px`;
    element.style.overflowY = element.scrollHeight > 128 ? 'auto' : 'hidden';
  }, [input]);

  const sendMessage = useCallback(() => {
    if (!input.trim() || !roomId) return;
    socket.emit('message:send', { roomId, content: input.trim() });
    setInput('');
  }, [input, roomId]);

  const resolveImageUrl = useCallback((value: string) => {
    if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value;
    return `${serverURL.replace(/\/$/, '')}${value.startsWith('/') ? value : `/${value}`}`;
  }, [serverURL]);

  const sendImages = useCallback(async (files: File[]) => {
    if (!files.length || !roomId || !socket.id || !sessionReady || !roomSynced || imageUploadingRef.current) return;
    if (files.length > CHAT_IMAGE_MAX_BATCH) {
      window.alert(`一次最多发送 ${CHAT_IMAGE_MAX_BATCH} 张图片。`);
      return;
    }
    for (const file of files) {
      const validationError = validateChatImageFile(file);
      if (validationError) { window.alert(validationError); return; }
    }

    imageUploadingRef.current = true;
    setImageUploading(true);
    try {
      for (const file of files) {
        const dataUrl = await readFileAsDataUrl(file);
        const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
        const response = await fetch(`${serverURL.replace(/\/$/, '')}/api/rooms/${roomId}/images`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data, mimeType: chatImageMimeType(file), socketId: socket.id }),
        });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      }
    } catch (cause) {
      window.alert(`图片发送失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      imageUploadingRef.current = false;
      setImageUploading(false);
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  }, [roomId, roomSynced, serverURL, sessionReady]);

  const hasFileItems = useCallback((items: DataTransferItemList) =>
    Array.from(items).some(item => item.kind === 'file'), []);

  const handleImageDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileItems(event.dataTransfer.items)) return;
    event.preventDefault();
    imageDragDepthRef.current += 1;
    setImageDragActive(true);
  }, [hasFileItems]);

  const handleImageDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileItems(event.dataTransfer.items)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, [hasFileItems]);

  const handleImageDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!imageDragActive) return;
    event.preventDefault();
    imageDragDepthRef.current = Math.max(0, imageDragDepthRef.current - 1);
    if (imageDragDepthRef.current === 0) setImageDragActive(false);
  }, [imageDragActive]);

  const handleImageDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileItems(event.dataTransfer.items) && event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    imageDragDepthRef.current = 0;
    setImageDragActive(false);
    const images = collectChatImageFiles(event.dataTransfer.files);
    if (!images.length) return;
    void sendImages(images);
  }, [hasFileItems, sendImages]);

  const handleImagePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardFiles = event.clipboardData.files.length
      ? event.clipboardData.files
      : Array.from(event.clipboardData.items)
          .flatMap(item => item.kind === 'file' ? [item.getAsFile()] : [])
          .filter((file): file is File => file !== null);
    const images = collectChatImageFiles(clipboardFiles);
    if (!images.length) return;
    event.preventDefault();
    void sendImages(images);
  }, [sendImages]);

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

  const kickMember = useCallback(async (member: RoomMember) => {
    if (!roomId || !isOwner || member.isOwner || member.socketId === socket.id) return;
    if (!window.confirm(`将 ${member.username} 移出房间？`)) return;
    setKickingId(member.socketId);
    try {
      const result = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        socket.timeout(5_000).emit('room:kick', {
          roomId,
          targetSocketId: member.socketId,
        }, (error: Error | null, response: { ok: boolean; error?: string }) => {
          if (error) reject(error);
          else resolve(response);
        });
      });
      if (!result.ok) throw new Error(result.error ?? '移除失败');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setKickingId(null);
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

  useEffect(() => {
    if (!rtc.localScreen && !rtc.remoteScreen) setScreenMaximized(false);
  }, [rtc.localScreen, rtc.remoteScreen]);

  if (!room) return (
    <div className="h-full flex items-center justify-center bg-gradient-to-br from-zinc-950 via-black to-zinc-900 text-white/40">加载中…</div>
  );

  // 语音中的成员始终排在仅进入房间的成员之前；同一组内保持服务端顺序稳定。
  const voiceMemberSocketIds = new Set(rtc.voiceMembers.map(member => member.socketId));
  const sortedRoomMembers = roomMembers
    .map((member, index) => ({ member, index }))
    .sort((left, right) =>
      Number(voiceMemberSocketIds.has(right.member.socketId))
      - Number(voiceMemberSocketIds.has(left.member.socketId))
      || left.index - right.index)
    .map(({ member }) => member);

  const hasScreen    = !!rtc.localScreen || !!rtc.remoteScreen;
  return (
    <div className="h-full flex bg-gradient-to-br from-zinc-950 via-black to-zinc-900 overflow-hidden">

      {showScreenModal && (
        <ScreenSettingsModal
          preset={pendingPreset} fps={pendingFps} audio={pendingAudio} gameMode={pendingGameMode}
          onPreset={setPendingPreset} onFps={setPendingFps}
          onAudio={() => setPendingAudio(a => !a)}
          onGameMode={() => setPendingGameMode(enabled => {
            const next = !enabled;
            if (next) setPendingFps(60);
            return next;
          })}
          onCancel={() => setShowScreenModal(false)}
          onConfirm={() => { setShowScreenModal(false); rtc.startScreenShare(pendingPreset, pendingFps, pendingAudio, pendingGameMode); }}
        />
      )}

      {showAudioDevices && (
        <AudioDeviceModal
          inputDevices={rtc.audioInputDevices}
          outputDevices={rtc.audioOutputDevices}
          selectedInputId={rtc.selectedAudioInputId}
          selectedOutputId={rtc.selectedAudioOutputId}
          refreshing={rtc.audioDevicesRefreshing}
          switchingInput={rtc.audioInputSwitching}
          error={rtc.audioDeviceError}
          onInput={rtc.selectAudioInput}
          onOutput={rtc.selectAudioOutput}
          onRefresh={rtc.refreshAudioDevices}
          onClose={() => setShowAudioDevices(false)}
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
      {viewingProfile && (
        <UserProfileModal
          userId={viewingProfile.userId}
          username={viewingProfile.username}
          avatarUrl={viewingProfile.avatarUrl}
          remark={profileRemarks[viewingProfile.userId]}
          onSaveRemark={remark => setProfileRemarks(current => saveProfileRemark(current, viewingProfile.userId, remark))}
          onClose={() => setViewingProfile(null)}
        />
      )}
      {previewImage && (
        <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/90 p-8 backdrop-blur-md" onMouseDown={() => setPreviewImage(null)} role="dialog" aria-modal="true" aria-label="图片预览">
          <img src={previewImage} alt="聊天图片预览" className="max-h-full max-w-full rounded-2xl object-contain shadow-2xl" onMouseDown={event => event.stopPropagation()} />
          <button onClick={() => setPreviewImage(null)} className="absolute right-6 top-6 rounded-xl bg-white/10 p-3 text-white/70 transition hover:bg-white/20 hover:text-white" aria-label="关闭图片预览"><X size={21} /></button>
        </div>
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

          {/* 房间成员与语音状态合并：只有正在语音中的成员显示音量条。 */}
          <div className="flex-1 overflow-y-auto p-4">
            <p className="text-white/30 text-sm font-semibold uppercase tracking-wider mb-3">
              成员 — {roomMembers.length}
            </p>
            <div className="space-y-1">
              {sortedRoomMembers.map(member => {
                const isSelf = member.socketId === socket.id;
                const voiceMember = rtc.voiceMembers.find(voice => voice.socketId === member.socketId);
                const inVoice = !!voiceMember;
                const showVoiceState = rtc.inVoice && inVoice;
                const voiceMuted = !!voiceMember?.isMuted;
                const level = showVoiceState
                  ? rtc.speakingLevels[member.socketId] ?? (isSelf ? rtc.speakingLevels[rtc.localSocketId ?? ''] ?? 0 : 0)
                  : 0;
                const speaking = showVoiceState && level > 0.08 && !voiceMuted && !(isSelf && rtc.isMuted);
                return (
                  <div key={member.socketId} className="group flex items-start gap-2 rounded-xl px-2 py-2 transition-colors hover:bg-white/[0.06]">
                    <div className="min-w-0 flex-1">
                      <button
                        onClick={() => isSelf ? setShowProfile(true) : setViewingProfile(member)}
                        className="flex w-full min-w-0 items-center gap-3 rounded-xl text-left focus:outline-none focus:ring-2 focus:ring-cyan-300/35"
                        title={isSelf ? '打开个人名片' : `查看 ${member.username} 的主页`}
                      >
                        <Avatar username={member.username} avatarUrl={member.avatarUrl} size="sm" className={speaking ? 'border-green-400/60 ring-2 ring-green-400/40' : isSelf ? 'border-white/30' : 'transition group-hover:border-cyan-200/30'} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className={`min-w-0 flex-1 truncate text-base font-medium ${isSelf ? 'text-white' : 'text-white/55'}`}>
                              {isSelf ? `${member.username}（你）` : (profileRemarks[member.userId] || member.username)}
                            </span>
                            {member.isOwner && <Crown size={14} className="flex-shrink-0 text-amber-300" aria-label="房主" />}
                            {showVoiceState && voiceMuted && <MicOff size={13} className="flex-shrink-0 text-red-300/70" aria-label="麦克风已关闭" />}
                            {showVoiceState && !isSelf && <span className="text-xs tabular-nums text-white/30">{Math.round((rtc.memberVolumes[member.socketId] ?? 1) * 100)}%</span>}
                          </div>
                          {profileRemarks[member.userId] && !isSelf && <p className="mt-0.5 truncate text-xs text-white/30">用户名：{member.username}</p>}
                          {member.isOwner && <p className="mt-0.5 text-xs text-amber-300/50">房主</p>}
                        </div>
                      </button>

                      {showVoiceState && (
                        <div className="ml-11 mt-2">
                          {!isSelf && rtc.inVoice && voiceMember ? (
                            <label className="grid grid-cols-[13px_minmax(0,1fr)] items-center gap-x-2" title={`调整你听到的 ${member.username} 音量`}>
                              {(rtc.memberVolumes[member.socketId] ?? 1) === 0
                                ? <VolumeX size={13} className="flex-shrink-0 text-white/35" />
                                : <Volume2 size={13} className="flex-shrink-0 text-white/35" />}
                              <div className="relative h-5 min-w-0" data-testid="voice-volume-meter">
                                {/* 同一条中心线上：较宽的绿色实时电平位于底层，较细的青色音量轨位于上层。 */}
                                <div
                                  className="pointer-events-none absolute left-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-gradient-to-r from-green-500/75 to-emerald-300 transition-[width] duration-75"
                                  style={{ width: `${Math.round((voiceMuted ? 0 : Math.min(rtc.memberVolumes[member.socketId] ?? 1, level * (rtc.memberVolumes[member.socketId] ?? 1))) * 100)}%` }}
                                  role="progressbar"
                                  aria-label={`${member.username} 调整后的实时声音强度`}
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                  aria-valuenow={Math.round((voiceMuted ? 0 : Math.min(rtc.memberVolumes[member.socketId] ?? 1, level * (rtc.memberVolumes[member.socketId] ?? 1))) * 100)}
                                />
                                <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/15" />
                                <div
                                  className="pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-cyan-300/75"
                                  style={{ width: `${Math.round((rtc.memberVolumes[member.socketId] ?? 1) * 100)}%` }}
                                />
                                <div
                                  className="pointer-events-none absolute top-1/2 h-3 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-50/80 bg-cyan-100 shadow-[0_0_6px_rgba(165,243,252,0.75)]"
                                  style={{ left: `${Math.round((rtc.memberVolumes[member.socketId] ?? 1) * 100)}%` }}
                                  aria-hidden="true"
                                />
                                <input
                                  type="range"
                                  min="0"
                                  max="100"
                                  step="1"
                                  value={Math.round((rtc.memberVolumes[member.socketId] ?? 1) * 100)}
                                  onChange={event => rtc.setMemberVolume(member.socketId, voiceMember.userId, Number(event.target.value) / 100)}
                                  className="absolute inset-x-0 top-1/2 h-5 w-full -translate-y-1/2 cursor-pointer opacity-0"
                                  aria-label={`${member.username} 的接收音量`}
                                />
                              </div>
                            </label>
                          ) : (
                            <div className="h-1 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label={`${member.username} 的实时声音强度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((voiceMuted || (isSelf && rtc.isMuted) ? 0 : level) * 100)}>
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-green-400 to-emerald-300 transition-[width] duration-75"
                                style={{ width: `${Math.round((voiceMuted || (isSelf && rtc.isMuted) ? 0 : level) * 100)}%` }}
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {isOwner && !member.isOwner && !isSelf && (
                      <div className="mt-0.5 flex flex-shrink-0 items-center gap-1">
                        <button
                          onClick={() => setMemberMuted(member)}
                          disabled={moderatingId === member.socketId || kickingId === member.socketId || !sessionReady || !roomSynced}
                          className={`rounded-lg px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${
                            member.isMuted
                              ? 'bg-green-500/10 text-green-300 hover:bg-green-500/20'
                              : 'bg-red-500/10 text-red-300 hover:bg-red-500/20'
                          }`}
                        >{member.isMuted ? '解禁' : '禁言'}</button>
                        <button
                          onClick={() => { void kickMember(member); }}
                          disabled={kickingId === member.socketId || moderatingId === member.socketId || !sessionReady || !roomSynced}
                          className="rounded-lg bg-red-500/10 p-1.5 text-red-300 transition hover:bg-red-500/20 disabled:opacity-40"
                          title={`将 ${member.username} 移出房间`}
                          aria-label={`将 ${member.username} 移出房间`}
                        ><UserMinus size={14} /></button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Sound Pack Panel ── */}
          <SoundPackPanel socket={socket} roomId={roomId!} serverURL={serverURL} outputDeviceId={rtc.selectedAudioOutputId} inVoice={rtc.inVoice} disabled={!sessionReady || !roomSynced} />

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
          <div className="inline-flex items-center gap-1.5 rounded-full border border-cyan-300/15 bg-cyan-300/[0.07] px-2.5 py-1 text-xs font-semibold text-cyan-100/75" title="当前语音人数">
            <Headphones size={14} /> {rtc.voiceMembers.length}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => { setShowAudioDevices(true); void rtc.refreshAudioDevices(false); }}
              className={`rounded-xl p-2 transition ${showAudioDevices ? 'bg-cyan-300/15 text-cyan-200' : 'text-white/45 hover:bg-white/10 hover:text-white'}`}
              aria-label="选择麦克风和扬声器"
              title="音频设备"
            ><Settings2 size={18} /></button>
            {!rtc.inVoice ? (
              <button onClick={rtc.joinVoice} disabled={!sessionReady || !roomSynced || rtc.isJoining} className="inline-flex items-center gap-2 rounded-xl bg-white px-3.5 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-50">{rtc.isJoining ? <LoaderCircle size={17} className="animate-spin" /> : rtc.isForceMuted ? <MicOff size={17} /> : <Mic size={17} />}{rtc.isJoining ? '正在加入' : rtc.isForceMuted ? '加入语音（已被禁言）' : '加入语音'}</button>
            ) : (
              <div className="flex items-center gap-1.5 rounded-2xl border border-white/10 bg-black/20 p-1.5">
                <button onClick={rtc.toggleStats} className={`rounded-xl p-2 transition ${rtc.statsEnabled ? 'bg-sky-500/20 text-sky-300' : 'text-white/45 hover:bg-white/10 hover:text-white'}`} aria-label={rtc.statsEnabled ? '关闭媒体统计' : '打开媒体统计'} title="媒体统计"><Activity size={18} /></button>
                <button onClick={rtc.toggleMute} disabled={rtc.isForceMuted || !sessionReady} className={`rounded-xl p-2 transition disabled:cursor-not-allowed ${rtc.isForceMuted || rtc.isMuted ? 'bg-red-500/20 text-red-300' : 'text-white/60 hover:bg-white/10 hover:text-white'}`} aria-label={rtc.isForceMuted ? '已被房主语音禁言' : rtc.isMuted ? '取消静音' : '静音'} title={rtc.isForceMuted ? '已被房主语音禁言' : rtc.isMuted ? '取消静音' : '静音'}>{rtc.isMuted || rtc.isForceMuted ? <MicOff size={18} /> : <Mic size={18} />}</button>
                <button onClick={!rtc.isSharing ? () => setShowScreenModal(true) : rtc.stopScreenShare} disabled={!sessionReady} className={`rounded-xl p-2 transition ${rtc.isSharing ? 'bg-amber-500/20 text-amber-300' : 'text-white/60 hover:bg-white/10 hover:text-white'}`} aria-label={rtc.isSharing ? '停止屏幕共享' : '开始屏幕共享'} title={rtc.isSharing ? '停止屏幕共享' : '开始屏幕共享'}><MonitorUp size={18} /></button>
                <button onClick={rtc.leaveVoice} className="rounded-xl p-2 text-white/45 transition hover:bg-red-500/20 hover:text-red-300" aria-label="离开语音" title="离开语音"><PhoneOff size={18} /></button>
              </div>
            )}
            {rtc.inVoice && rtc.availableScreens.length > 0 && !rtc.localScreen && (
              <div className="inline-flex items-center gap-2 rounded-xl border border-cyan-300/15 bg-cyan-300/[0.07] px-3 py-2 text-sm font-semibold text-cyan-100/75" title="当前可观看的屏幕共享数量">
                <MonitorPlay size={17} />{rtc.availableScreens.length} 个共享
              </div>
            )}
            {hasScreen && <button onClick={() => setChatDrawerOpen(open => !open)} className="rounded-xl p-2 text-white/45 transition hover:bg-white/10 hover:text-white" aria-label={chatDrawerOpen ? '收起聊天栏' : '展开聊天栏'} title={chatDrawerOpen ? '收起聊天栏' : '展开聊天栏'}>{chatDrawerOpen ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}</button>}
            <button onClick={() => setShowProfile(true)} className="rounded-full focus:outline-none focus:ring-2 focus:ring-cyan-300/50" aria-label="打开个人名片" title="个人名片"><Avatar username={profile.username} avatarUrl={profile.avatarUrl} size="sm" /></button>
            {!sidebarOpen && <button onClick={() => navigate('/')} className="rounded-xl p-2 text-white/40 transition hover:bg-white/10 hover:text-white" aria-label="返回频道列表" title="返回频道列表"><ArrowLeft size={19} /></button>}
          </div>
        </header>

        {rtc.inVoice && rtc.availableScreens.length > 0 && !rtc.localScreen && (
          <div className="mx-5 mt-4 flex flex-shrink-0 items-center gap-4 rounded-2xl border border-cyan-300/25 bg-gradient-to-r from-cyan-300/15 via-sky-400/10 to-transparent px-4 py-3 shadow-[0_0_28px_rgba(34,211,238,0.08)]">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-200 text-zinc-900"><MonitorPlay size={22} /></div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white">
                {rtc.availableScreens.length === 1 ? '1 位成员正在共享屏幕' : `${rtc.availableScreens.length} 位成员正在共享屏幕`}
              </p>
              <p className="mt-0.5 text-xs text-cyan-50/50">选择要观看的成员；未选择的共享不会消耗本机视频流量</p>
            </div>
            <div className="flex max-w-[55%] flex-wrap justify-end gap-2">
              {rtc.availableScreens.map(screen => {
                const selected = rtc.watchingScreenPeerId === screen.socketId;
                const sharer = rtc.voiceMembers.find(member => member.socketId === screen.socketId)?.username ?? '成员';
                return (
                  <button
                    key={screen.videoProducerId}
                    onClick={() => selected ? rtc.stopWatchingScreen() : rtc.watchScreen(screen.socketId)}
                    className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold transition ${selected ? 'bg-red-500/15 text-red-100 hover:bg-red-500/25' : 'bg-cyan-100 text-zinc-900 hover:bg-white'}`}
                    title={selected ? `停止观看 ${sharer} 的共享` : `观看 ${sharer} 的共享`}
                  >
                    {selected ? <EyeOff size={16} /> : <Eye size={16} />}{sharer}
                  </button>
                );
              })}
            </div>
          </div>
        )}

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
                    你正在共享 · {rtc.screenViewerCount} 人观看 · {rtc.screenGameMode ? '游戏模式' : `自动${rtc.screenActivity === 'static' ? '静止' : rtc.screenActivity === 'motion' ? '动态' : '操作'}`}
                  </div>
                </>
              ) : null}

              {(rtc.remoteScreen || (rtc.localScreen && rtc.shareAudio)) && (
                <label className="absolute bottom-3 right-3 flex items-center gap-2 rounded-xl border border-white/10 bg-black/65 px-3 py-2 text-xs text-white/70 backdrop-blur-md" title={rtc.remoteScreen ? '调节你听到的共享音量' : '调节对方听到的共享音量'}>
                  {(rtc.remoteScreen ? rtc.screenReceiveVolume : rtc.screenShareVolume) === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
                  <span>{rtc.remoteScreen ? '共享音量' : '发送音量'}</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round((rtc.remoteScreen ? rtc.screenReceiveVolume : rtc.screenShareVolume) * 100)}
                    onChange={event => (rtc.remoteScreen ? rtc.setScreenReceiveVolume : rtc.setScreenShareVolume)(Number(event.target.value) / 100)}
                    className="h-1 w-24 cursor-pointer accent-cyan-300"
                    aria-label={rtc.remoteScreen ? '共享接收音量' : '共享发送音量'}
                  />
                  <span className="w-8 text-right tabular-nums">{Math.round((rtc.remoteScreen ? rtc.screenReceiveVolume : rtc.screenShareVolume) * 100)}%</span>
                </label>
              )}

              {/* 实时统计悬浮显示（开关在语音栏） */}
              {rtc.statsEnabled && (
                <div className="absolute top-3 left-3 bg-black/70 backdrop-blur-md text-white text-xs px-3 py-2 rounded-xl border border-white/10 font-mono space-y-0.5 pointer-events-none">
                  <div>帧率 FPS：<span className="text-green-400">{rtc.stats.fps ?? '—'}</span></div>
                  <div>画面：<span className="text-cyan-300">{rtc.stats.width && rtc.stats.height ? `${rtc.stats.width}×${rtc.stats.height}` : '—'}</span></div>
                  <div>编码：<span className="text-cyan-300">{rtc.stats.codec ?? '—'}</span></div>
                  <div>码率：<span className="text-cyan-300">{rtc.stats.bitrate != null ? `${rtc.stats.bitrate} kbps` : '—'}</span></div>
                  {rtc.localScreen && <div>{rtc.screenGameMode ? '固定上限' : '自动上限'}：<span className="text-cyan-300">{rtc.screenTargetBitrate ? `${Math.round(rtc.screenTargetBitrate / 1000)} kbps` : '—'}</span></div>}
                  {rtc.localScreen && <div>画面模式：<span className="text-cyan-300">{rtc.screenGameMode ? '游戏模式' : rtc.screenActivity === 'static' ? '自动 · 静止' : rtc.screenActivity === 'motion' ? '自动 · 动态' : '自动 · 普通操作'}</span></div>}
                  <div>{rtc.localScreen ? '发送可用带宽' : '接收可用带宽'}：<span className="text-cyan-300">{rtc.localScreen && rtc.stats.availableBitrate != null ? `${rtc.stats.availableBitrate} kbps` : '浏览器不提供'}</span></div>
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
        <div className={hasScreen ? (chatDrawerOpen ? 'absolute bottom-20 right-0 top-16 z-10 w-96 overflow-y-auto border-l border-white/10 bg-zinc-950/90 px-5 py-4 shadow-2xl backdrop-blur-xl' : 'hidden') : 'flex-1 overflow-y-auto min-h-0 px-6 py-5'}>
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <MessageCircle size={42} className="text-white/20" />
              <p className="text-white/40 text-lg">这是 <span className="text-white/70 font-semibold">#{room.name}</span> 的起始位置</p>
            </div>
          )}
          {messages.map((msg, idx) => {
            if (msg.type === 'system') {
              return (
                <div key={msg.id} className="my-5 flex items-center justify-center gap-2 py-1 text-sm text-white/35">
                  <UserRound size={14} className="text-emerald-200/55" />
                  <span>{msg.content}</span>
                  <span className="text-xs text-white/20">{formatTime(msg.timestamp)}</span>
                </div>
              );
            }
            if (msg.type === 'soundpack') {
              return (
                <div key={msg.id} className="my-5 flex items-center justify-center gap-2 py-1 text-sm text-white/35">
                  <Volume2 size={14} className="text-cyan-200/55" />
                  <span>{msg.content}</span>
                  <span className="text-xs text-white/20">{formatTime(msg.timestamp)}</span>
                </div>
              );
            }
            const isMe    = msg.author === username;
            const prevMsg = messages[idx - 1];
            const grouped = prevMsg && prevMsg.type !== 'soundpack' && prevMsg.type !== 'system' && prevMsg.author === msg.author &&
              msg.timestamp - prevMsg.timestamp < 5 * 60 * 1000;

            return (
              <div key={msg.id} className={`flex items-start gap-3 ${isMe ? 'flex-row-reverse' : ''} ${grouped ? 'mt-1' : 'mt-5'}`}>
                {!grouped ? (
                  isMe ? <Avatar username={profile.username} avatarUrl={profile.avatarUrl} size="sm" className="mt-0.5" /> : <Avatar username={msg.author} size="sm" className="mt-0.5" />
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
                  <div className={`rounded-2xl text-base leading-relaxed ${msg.type === 'image' ? 'overflow-hidden border border-white/10 bg-black/30 p-1' : 'whitespace-pre-wrap break-words px-4 py-2.5'} ${
                    isMe
                      ? msg.type === 'image' ? 'rounded-br-sm' : 'bg-white text-zinc-900 rounded-br-sm'
                      : msg.type === 'image' ? 'rounded-bl-sm' : 'bg-white/10 backdrop-blur-sm text-white rounded-bl-sm border border-white/[0.08]'
                  }`}>
                    {msg.type === 'image' ? (
                      <button onClick={() => setPreviewImage(resolveImageUrl(msg.content))} className="block max-w-full cursor-zoom-in" title="点击查看原图">
                        <img src={resolveImageUrl(msg.content)} alt={`${msg.author} 发送的图片`} loading="lazy" className="max-h-80 max-w-full rounded-xl object-contain" />
                      </button>
                    ) : <ChatMessageText content={msg.content} isMe={isMe} />}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className={hasScreen ? (chatDrawerOpen ? 'absolute bottom-0 right-0 z-10 w-96 border-l border-t border-white/10 bg-zinc-950/95 px-4 py-3 backdrop-blur-xl' : 'hidden') : 'flex-shrink-0 px-5 py-4 border-t border-white/[0.08]'}>
          <div
            onDragEnter={handleImageDragEnter}
            onDragOver={handleImageDragOver}
            onDragLeave={handleImageDragLeave}
            onDrop={handleImageDrop}
            className={`relative flex items-end gap-3 overflow-hidden rounded-2xl border px-5 py-3.5 backdrop-blur-xl transition-all focus-within:bg-white/10 ${imageDragActive ? 'border-cyan-300/70 bg-cyan-300/10 ring-2 ring-cyan-300/20' : 'border-white/10 bg-white/[0.07] focus-within:border-white/20'}`}
          >
            {imageDragActive && (
              <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-2 bg-cyan-950/90 text-sm font-semibold text-cyan-100 backdrop-blur-sm">
                <ImagePlus size={19} />松开发送图片
              </div>
            )}
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              className="hidden"
              onChange={event => { void sendImages(collectChatImageFiles(event.target.files ?? [])); }}
            />
            <button
              className="flex-shrink-0 text-white/30 transition-colors hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-30"
              disabled={imageUploading || !sessionReady || !roomSynced}
              onClick={() => imageInputRef.current?.click()}
              aria-label="发送图片"
              title="发送图片（最大 5MB）"
            >
              {imageUploading ? <LoaderCircle size={19} className="animate-spin" /> : <ImagePlus size={19} />}
            </button>
            <textarea
              ref={messageInputRef}
              rows={1}
              className="min-h-6 max-h-32 flex-1 resize-none bg-transparent text-base leading-6 text-white outline-none placeholder-white/25"
              placeholder={`在 #${room.name} 发消息…`}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                sendMessage();
              }}
              onPaste={handleImagePaste}
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
