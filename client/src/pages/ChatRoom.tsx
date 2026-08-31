import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Activity, AppWindow, ArrowLeft, AudioLines, Crown, Ellipsis, Eye, EyeOff, Gamepad2, Hash, Headphones, ImagePlus, LoaderCircle, Maximize2, Menu, MessageCircle, MousePointer2,
  Mic, MicOff, Minimize2, Monitor, MonitorPlay, MonitorUp, PanelRightClose, PanelRightOpen, PhoneOff,
  RefreshCw, Send, Settings2, Smartphone, Trash2, UserMinus, UserRound, Volume2, VolumeX, X,
} from 'lucide-react';
import { socket } from '../socket';
import { useWebRTC, SCREEN_PRESETS, ScreenPreset, Fps } from '../hooks/useWebRTC';
import { useScreenFullscreen } from '../hooks/useScreenFullscreen';
import { Avatar } from '../components/Avatar';
import { CollapsibleMediaBanner, WatchingScreenBanner } from '../components/CollapsibleMediaBanner';
import { ScreenFullscreenControl } from '../components/ScreenFullscreenControl';
import { ScreenVolumeControl } from '../components/ScreenVolumeControl';
import { WatchingScreenControls } from '../components/WatchingScreenControls';
import { MemberContextMenu } from '../components/MemberContextMenu';
import { ProfileModal } from '../components/ProfileModal';
import { UserProfileModal } from '../components/UserProfileModal';
import { SoundPackPanel } from '../components/SoundPackPanel';
import { loadProfileRemarks, saveProfileRemark } from '../profileRemarks';
import { Room, Message, RoomMember, RoomState, UserProfile } from '../types';
import { AudioDeviceOption, DEFAULT_AUDIO_DEVICE_ID } from '../audioDevices';
import { normalizedVideoPoint, remoteMouseButton, type RemoteControlInput } from '../remoteControl';
import {
  CHAT_IMAGE_MAX_BATCH,
  chatImageMimeType,
  collectChatImageFiles,
  validateChatImageFile,
} from '../chatImages';
import { parseChatText } from '../chatLinks';
import { isScreenEncodingWithinPlan } from '../screenCapture';
import { sortRoomMembers } from '../memberOrdering';
import type { ApplicationAudioSource } from '../applicationAudio';
import { updateRoomPayload } from '../roomSettings';

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

function RemoteScreenVideo({ stream, controlling, onInput }: {
  stream: MediaStream;
  controlling: boolean;
  onInput: (input: RemoteControlInput) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const lastMoveAt = useRef(0);
  const pressedKeys = useRef(new Set<string>());
  const pressedButtons = useRef(new Set<'left' | 'right' | 'middle'>());
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    video.play().catch(() => {});
  }, [stream]);
  const point = (clientX: number, clientY: number) => {
    const video = ref.current;
    if (!video) return null;
    return normalizedVideoPoint(clientX, clientY, video.getBoundingClientRect(), video.videoWidth, video.videoHeight);
  };
  const releasePressed = useCallback(() => {
    pressedKeys.current.forEach(code => onInput({ type: 'key', code, down: false }));
    pressedButtons.current.forEach(button => onInput({ type: 'button', button, down: false, x: 0.5, y: 0.5 }));
    pressedKeys.current.clear();
    pressedButtons.current.clear();
  }, [onInput]);
  useEffect(() => {
    if (!controlling) releasePressed();
    return releasePressed;
  }, [controlling, releasePressed]);
  return (
    <div
      ref={surfaceRef}
      className={`relative h-full w-full outline-none ${controlling ? 'cursor-crosshair focus:ring-2 focus:ring-inset focus:ring-cyan-300/70' : ''}`}
      tabIndex={controlling ? 0 : -1}
      onPointerMove={event => {
        if (!controlling || event.timeStamp - lastMoveAt.current < 16) return;
        const mapped = point(event.clientX, event.clientY);
        if (!mapped) return;
        lastMoveAt.current = event.timeStamp;
        onInput({ type: 'pointer', ...mapped });
      }}
      onPointerDown={event => {
        if (!controlling) return;
        const button = remoteMouseButton(event.button);
        const mapped = point(event.clientX, event.clientY);
        if (!button || !mapped) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        pressedButtons.current.add(button);
        onInput({ type: 'button', button, down: true, ...mapped });
      }}
      onPointerUp={event => {
        if (!controlling) return;
        const button = remoteMouseButton(event.button);
        const mapped = point(event.clientX, event.clientY);
        if (!button || !mapped) return;
        event.preventDefault();
        pressedButtons.current.delete(button);
        onInput({ type: 'button', button, down: false, ...mapped });
      }}
      onPointerCancel={releasePressed}
      onLostPointerCapture={releasePressed}
      onWheel={event => {
        if (!controlling) return;
        const mapped = point(event.clientX, event.clientY);
        if (!mapped) return;
        event.preventDefault();
        onInput({
          type: 'wheel',
          deltaX: Math.max(-1200, Math.min(1200, event.deltaX)),
          deltaY: Math.max(-1200, Math.min(1200, event.deltaY)),
          ...mapped,
        });
      }}
      onKeyDown={event => {
        if (!controlling || event.repeat) return;
        event.preventDefault();
        event.stopPropagation();
        pressedKeys.current.add(event.code);
        onInput({ type: 'key', code: event.code, down: true });
      }}
      onKeyUp={event => {
        if (!controlling) return;
        event.preventDefault();
        event.stopPropagation();
        pressedKeys.current.delete(event.code);
        onInput({ type: 'key', code: event.code, down: false });
      }}
      onBlur={releasePressed}
      onContextMenu={event => { if (controlling) event.preventDefault(); }}
    >
      <video ref={ref} autoPlay muted playsInline className="pointer-events-none h-full w-full object-contain" />
      {controlling && <div className="pointer-events-none absolute inset-0 border border-cyan-300/45" />}
    </div>
  );
}

interface IncomingRemoteControlRequest {
  requestId: string;
  roomId: string;
  controllerSocketId: string;
  controllerName: string;
  expiresAt: number;
}

interface ActiveRemoteControlSession {
  sessionId: string;
  roomId: string;
  role: 'controller' | 'sharer';
  controllerSocketId?: string;
  controllerName?: string;
  sharerSocketId?: string;
  sharerName?: string;
}

interface ScreenModalProps {
  preset: ScreenPreset; fps: Fps; audio: boolean; gameMode: boolean;
  nativeResolution: boolean;
  onNativeResolution: (enabled: boolean) => void;
  onPreset: (p: ScreenPreset) => void; onFps: (f: Fps) => void;
  onAudio: () => void; onGameMode: () => void;
  onConfirm: () => void; onCancel: () => void;
}
export function ScreenSettingsModal({ preset, fps, audio, gameMode, nativeResolution, onNativeResolution, onPreset, onFps, onAudio, onGameMode, onConfirm, onCancel }: ScreenModalProps) {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-50" onClick={onCancel}>
      <div className="max-h-[90vh] w-96 overflow-y-auto rounded-3xl border border-white/15 bg-white/[0.08] p-7 shadow-2xl backdrop-blur-2xl flex flex-col gap-5" onClick={e => e.stopPropagation()}>
        <h2 className="text-white font-bold text-xl">屏幕共享设置</h2>
        <p className={`rounded-2xl border px-4 py-3 text-xs leading-relaxed ${gameMode ? 'border-amber-300/20 bg-amber-300/[0.07] text-amber-100/75' : 'border-cyan-300/10 bg-cyan-300/[0.05] text-cyan-100/65'}`}>
          {gameMode
            ? `游戏模式不会分析画面变化，按${nativeResolution ? '原生分辨率' : '所选清晰度'}以 60 FPS 为目标。不设码率上限，实际速率由网络与设备能力决定。`
            : `${nativeResolution ? '直接以采集源的原生分辨率传输，不按清晰度档位缩放' : 'Cove 会保留原始采集画面用于高质量缩放，传输尺寸保持在所选档位内'}，并根据画面变化调整帧率。不设码率上限，实际速率由网络与设备能力决定。`}
        </p>
        <div>
          <p className="text-white/40 text-sm font-medium mb-2.5">传输模式</p>
          <button onClick={onGameMode} aria-pressed={gameMode}
            className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${gameMode ? 'border-amber-300/35 bg-amber-300/15 text-amber-100' : 'border-white/10 bg-white/[0.06] text-white/60 hover:bg-white/10'}`}>
            <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${gameMode ? 'bg-amber-200 text-zinc-900' : 'bg-white/10 text-white/45'}`}><Gamepad2 size={19} /></span>
            <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">游戏模式</span><span className="mt-0.5 block text-xs opacity-60">目标 60 FPS，不检测画面动态；所有模式均不限码率</span></span>
            <span className={`rounded-full px-2 py-1 text-xs font-semibold ${gameMode ? 'bg-amber-100/20' : 'bg-white/10'}`}>{gameMode ? '已开启' : '已关闭'}</span>
          </button>
        </div>
        <div>
          <p className="text-white/40 text-sm font-medium mb-2.5">传输清晰度</p>
          <label className="mb-3 flex cursor-pointer gap-3 rounded-xl border border-amber-300/15 bg-amber-300/[0.06] px-3.5 py-3 transition hover:bg-amber-300/[0.09]">
            <input type="checkbox" checked={nativeResolution} onChange={event => onNativeResolution(event.target.checked)}
              className="mt-0.5 h-4 w-4 flex-shrink-0 accent-amber-300" />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-medium text-white/70"><Monitor size={15} className="text-amber-200/70" />以原生分辨率共享</span>
              <span className="mt-1 block text-xs leading-relaxed text-white/35">使用采集源的原始尺寸，忽略下方档位；优先保留分辨率，可能增加带宽与编码负担。</span>
            </span>
          </label>
          <fieldset disabled={nativeResolution} aria-label="传输分辨率档位" className={`grid grid-cols-2 gap-2 transition-opacity ${nativeResolution ? 'opacity-40' : ''}`}>
            {(Object.keys(SCREEN_PRESETS) as ScreenPreset[]).map(p => (
              <button key={p} onClick={() => onPreset(p)}
                disabled={nativeResolution}
                className={`py-2.5 rounded-xl text-sm font-semibold transition-colors disabled:cursor-not-allowed ${nativeResolution ? 'bg-white/10 text-white/40' : preset === p ? 'bg-white text-zinc-900' : 'bg-white/10 hover:bg-white/15 text-white/60'}`}>
                {SCREEN_PRESETS[p].label}
              </button>
            ))}
          </fieldset>
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

function ApplicationAudioModal({
  sources, loading, onRefresh, onSelect, onClose,
}: {
  sources: ApplicationAudioSource[];
  loading: boolean;
  onRefresh: () => void;
  onSelect: (source: ApplicationAudioSource) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md" onMouseDown={onClose}>
      <section className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-white/15 bg-zinc-900/95 shadow-2xl" onMouseDown={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="application-audio-title">
        <header className="flex items-start gap-4 border-b border-white/10 px-6 py-5">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl bg-violet-300/15 text-violet-100"><AudioLines size={22} /></div>
          <div className="min-w-0 flex-1">
            <h2 id="application-audio-title" className="text-xl font-bold text-white">共享应用音频</h2>
            <p className="mt-1 text-sm leading-relaxed text-white/45">仅发送所选应用及其子进程的声音，不包含 Cove 通话或其他系统声音。</p>
          </div>
          <button onClick={onClose} className="rounded-xl p-2 text-white/35 transition hover:bg-white/10 hover:text-white" aria-label="关闭应用音频选择"><X size={18} /></button>
        </header>
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.08] bg-black/10 px-6 py-3">
          <span className="text-xs text-white/35">Windows 11 · 仅音频 · 共享后可调节发送音量</span>
          <button onClick={onRefresh} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-cyan-100 transition hover:bg-white/10 disabled:opacity-40"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />刷新</button>
        </div>
        <div className="min-h-36 overflow-y-auto p-4">
          {loading ? (
            <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-white/40"><LoaderCircle size={17} className="animate-spin" />正在读取可共享的应用…</div>
          ) : sources.length ? (
            <div className="space-y-2">
              {sources.map(source => (
                <button key={`${source.processId}-${source.id}`} onClick={() => onSelect(source)} className="flex w-full items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.045] px-4 py-3 text-left transition hover:border-violet-300/30 hover:bg-violet-300/[0.08]">
                  <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-white/10 text-white/55"><AppWindow size={18} /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-white/85">{source.name}</span><span className="mt-0.5 block truncate text-xs text-white/35">{source.processName} · PID {source.processId}</span></span>
                  <span className="text-xs font-semibold text-violet-200/80">共享音频</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-center text-sm text-white/40"><AudioLines size={25} className="text-white/25" /><span>没有可捕获的应用窗口。</span><span className="text-xs text-white/25">请先打开要播放声音的应用，再点击刷新。</span></div>
          )}
        </div>
      </section>
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
  const [kickConfirmMember, setKickConfirmMember] = useState<RoomMember | null>(null);
  const [memberMenu, setMemberMenu] = useState<{ socketId: string; roomId: string; x: number; y: number } | null>(null);
  const memberMenuAnchor = useRef<HTMLButtonElement | null>(null);
  const closeMemberMenu = useCallback((restoreFocus = false) => {
    setMemberMenu(null);
    if (restoreFocus && memberMenuAnchor.current?.isConnected) memberMenuAnchor.current.focus({ preventScroll: true });
  }, []);
  const [kickNotice, setKickNotice] = useState<{ title: string; message: string; returnToList: boolean } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [draggingVolumeMember, setDraggingVolumeMember] = useState<string | null>(null);

  useEffect(() => {
    if (draggingVolumeMember === null) return;
    const finishDrag = () => setDraggingVolumeMember(null);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    window.addEventListener('blur', finishDrag);
    return () => {
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
      window.removeEventListener('blur', finishDrag);
    };
  }, [draggingVolumeMember]);
  // 共享画面时聊天栏默认收起；只有用户主动点击右上角按钮才展开。
  // 这样消息到达时不会把隐藏的抽屉重新带入共享画面布局。
  const [chatDrawerOpen, setChatDrawerOpen] = useState(false);
  const [showRoomMenu, setShowRoomMenu] = useState(false);
  const [showRoomSettings, setShowRoomSettings] = useState(false);
  const [settingsMaxMembers, setSettingsMaxMembers] = useState('');
  const [settingsPassword, setSettingsPassword] = useState('');
  const [passwordAction, setPasswordAction] = useState<'keep' | 'set' | 'clear'>('keep');
  const [updatingRoomSettings, setUpdatingRoomSettings] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [viewingProfile, setViewingProfile] = useState<{ userId: string; socketId: string; username: string; avatarUrl?: string | null } | null>(null);
  const [profileRemarks, setProfileRemarks] = useState(loadProfileRemarks);
  const [roomSynced, setRoomSynced] = useState(false);
  const [joinError, setJoinError] = useState<{ message: string; code?: string } | null>(null);
  const [joinPassword, setJoinPassword] = useState('');
  const [joiningRoom, setJoiningRoom] = useState(false);
  const roomPasswordRef = useRef<string | undefined>(undefined);
  const roomSyncedRef = useRef(false);
  const joinGenerationRef = useRef(0);
  const joinBlockedRef = useRef(false);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  const [imageDragActive, setImageDragActive] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const messagesEndRef                = useRef<HTMLDivElement>(null);
  const imageInputRef                 = useRef<HTMLInputElement>(null);
  const messageInputRef               = useRef<HTMLTextAreaElement>(null);
  const imageUploadingRef             = useRef(false);
  const imageDragDepthRef             = useRef(0);
  const initiallyScrolledRoomRef      = useRef<string | null>(null);

  const [showScreenModal, setShowScreenModal] = useState(false);
  const [showApplicationAudioModal, setShowApplicationAudioModal] = useState(false);
  const [applicationAudioSources, setApplicationAudioSources] = useState<ApplicationAudioSource[]>([]);
  const [applicationAudioLoading, setApplicationAudioLoading] = useState(false);
  const [pendingPreset, setPendingPreset]     = useState<ScreenPreset>('720p');
  const [pendingFps, setPendingFps]           = useState<Fps>(30);
  const [pendingAudio, setPendingAudio]       = useState(false);
  const [pendingGameMode, setPendingGameMode] = useState(false);
  const [pendingNativeResolution, setPendingNativeResolution] = useState(false);
  const [showAudioDevices, setShowAudioDevices] = useState(false);
  const [diagnosticsCompact, setDiagnosticsCompact] = useState(false);
  const [incomingRemoteControl, setIncomingRemoteControl] = useState<IncomingRemoteControlRequest | null>(null);
  const [pendingRemoteControl, setPendingRemoteControl] = useState<{ requestId: string; expiresAt: number } | null>(null);
  const [remoteControlSession, setRemoteControlSession] = useState<ActiveRemoteControlSession | null>(null);
  const [remoteControlNotice, setRemoteControlNotice] = useState('');
  const remoteControlSessionRef = useRef<ActiveRemoteControlSession | null>(null);

  const rtc = useWebRTC(socket, roomId!);
  const hasScreen = Boolean(rtc.localScreen || rtc.remoteScreen);
  const { screenContainerRef, screenMaximized, nativeFullscreen, toggleFullscreen, toggleNativeFullscreen }
    = useScreenFullscreen(Boolean(rtc.localScreen || rtc.remoteScreen));

  useEffect(() => { remoteControlSessionRef.current = remoteControlSession; }, [remoteControlSession]);

  useEffect(() => {
    const bridge = window.coveRemoteControl;
    const onRequested = (request: IncomingRemoteControlRequest) => {
      if (request.roomId !== roomId) return;
      setIncomingRemoteControl(request);
      setRemoteControlNotice('');
    };
    const onRequestCancelled = ({ requestId, reason }: { requestId: string; reason?: string }) => {
      setIncomingRemoteControl(current => current?.requestId === requestId ? null : current);
      if (reason) setRemoteControlNotice(reason);
    };
    const onRequestResult = ({ requestId, accepted, error }: { requestId: string; accepted: boolean; error?: string }) => {
      setPendingRemoteControl(current => current?.requestId === requestId ? null : current);
      if (!accepted) setRemoteControlNotice(error ?? '远程控制请求未获批准');
    };
    const onStarted = async (session: ActiveRemoteControlSession) => {
      if (session.roomId !== roomId) return;
      setIncomingRemoteControl(null);
      setPendingRemoteControl(null);
      setRemoteControlNotice('');
      if (session.role === 'sharer') {
        const enabled = await bridge?.setActive(session.sessionId) ?? false;
        if (!enabled) {
          socket.emit('remote-control:stop', { sessionId: session.sessionId });
          setRemoteControlNotice('Windows 远程输入组件不可用，控制会话已终止');
          return;
        }
      }
      setRemoteControlSession(session);
    };
    const onRemoteInput = ({ sessionId, input }: { sessionId: string; input: RemoteControlInput }) => {
      const current = remoteControlSessionRef.current;
      if (!current || current.role !== 'sharer' || current.sessionId !== sessionId) return;
      void bridge?.sendInput(sessionId, input);
    };
    const onStopped = ({ sessionId, reason }: { sessionId: string; reason?: string }) => {
      const current = remoteControlSessionRef.current;
      if (!current || current.sessionId !== sessionId) return;
      if (current.role === 'sharer') void bridge?.setActive(null);
      setRemoteControlSession(null);
      setRemoteControlNotice(reason ?? '远程控制已结束');
    };
    const removeEmergencyListener = bridge?.onEmergencyStop(() => {
      const current = remoteControlSessionRef.current;
      if (!current || current.role !== 'sharer') return;
      socket.emit('remote-control:stop', { sessionId: current.sessionId });
      void bridge.setActive(null);
      setRemoteControlNotice('已通过紧急快捷键终止远程控制');
    });
    socket.on('remote-control:requested', onRequested);
    socket.on('remote-control:request-cancelled', onRequestCancelled);
    socket.on('remote-control:request-result', onRequestResult);
    socket.on('remote-control:started', onStarted);
    socket.on('remote-control:input', onRemoteInput);
    socket.on('remote-control:stopped', onStopped);
    return () => {
      socket.off('remote-control:requested', onRequested);
      socket.off('remote-control:request-cancelled', onRequestCancelled);
      socket.off('remote-control:request-result', onRequestResult);
      socket.off('remote-control:started', onStarted);
      socket.off('remote-control:input', onRemoteInput);
      socket.off('remote-control:stopped', onStopped);
      removeEmergencyListener?.();
      void bridge?.setActive(null);
    };
  }, [roomId]);

  const requestRemoteControl = useCallback(() => {
    if (!roomId || !rtc.remoteScreen || pendingRemoteControl || remoteControlSession) return;
    setRemoteControlNotice('');
    socket.timeout(5_000).emit('remote-control:request', {
      roomId,
      sharerSocketId: rtc.remoteScreen.socketId,
    }, (error: Error | null, response?: { ok: boolean; requestId?: string; expiresAt?: number; error?: string }) => {
      if (error || !response?.ok || !response.requestId || !response.expiresAt) {
        setRemoteControlNotice(response?.error ?? '远程控制请求发送失败'); return;
      }
      setPendingRemoteControl({ requestId: response.requestId, expiresAt: response.expiresAt });
    });
  }, [pendingRemoteControl, remoteControlSession, roomId, rtc.remoteScreen]);

  const respondRemoteControl = useCallback((accepted: boolean) => {
    const request = incomingRemoteControl;
    if (!request) return;
    setIncomingRemoteControl(null);
    socket.timeout(5_000).emit('remote-control:respond', {
      requestId: request.requestId,
      accepted,
    }, (error: Error | null, response?: { ok: boolean; error?: string }) => {
      if (error || !response?.ok) setRemoteControlNotice(response?.error ?? '远程控制确认失败');
    });
  }, [incomingRemoteControl]);

  const stopRemoteControl = useCallback(() => {
    const current = remoteControlSessionRef.current;
    if (!current) return;
    socket.emit('remote-control:stop', { sessionId: current.sessionId });
    if (current.role === 'sharer') void window.coveRemoteControl?.setActive(null);
  }, []);

  const sendRemoteControlInput = useCallback((input: RemoteControlInput) => {
    const current = remoteControlSessionRef.current;
    if (!current || current.role !== 'controller') return;
    socket.emit('remote-control:input', { sessionId: current.sessionId, input });
  }, []);

  useEffect(() => {
    const current = remoteControlSession;
    if (!current || current.role !== 'controller') return;
    if (rtc.remoteScreen?.socketId === current.sharerSocketId) return;
    socket.emit('remote-control:stop', { sessionId: current.sessionId });
  }, [remoteControlSession, rtc.remoteScreen]);

  useLayoutEffect(() => {
    // 每次开始观看/共享都从收起状态开始；之后的消息刷新只更新内容，
    // 不改变用户主动选择的展开状态。
    if (hasScreen) setChatDrawerOpen(false);
  }, [hasScreen]);

  const refreshApplicationAudioSources = useCallback(async () => {
    if (!window.coveApplicationAudio) {
      window.alert('应用音频共享仅可在 Windows 桌面版中使用。');
      return;
    }
    setApplicationAudioLoading(true);
    try {
      setApplicationAudioSources(await window.coveApplicationAudio.listSources());
    } catch (error) {
      console.error('[application-audio] 读取应用列表失败', error);
      window.alert(`无法读取应用列表：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setApplicationAudioLoading(false);
    }
  }, []);

  const openApplicationAudioModal = useCallback(() => {
    if (!window.coveApplicationAudio) {
      window.alert('应用音频共享仅可在 Windows 桌面版中使用。');
      return;
    }
    setShowApplicationAudioModal(true);
    void refreshApplicationAudioSources();
  }, [refreshApplicationAudioSources]);

  useEffect(() => {
    if (!roomId) return;
    let active = true;
    setRoom(null);
    setMessages([]);
    setMessagesLoaded(false);
    roomPasswordRef.current = undefined;
    joinGenerationRef.current += 1;
    joinBlockedRef.current = false;
    setJoinPassword('');
    fetch(`${serverURL}/api/rooms/${roomId}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Room>;
      })
      .then(nextRoom => { if (active) setRoom(nextRoom); })
      .catch(() => { if (active) navigate('/'); });
    return () => { active = false; };
  }, [roomId, navigate, serverURL]);

  useEffect(() => {
    roomSyncedRef.current = roomSynced;
  }, [roomSynced]);

  useEffect(() => {
    if (!roomId || !roomSynced) return;
    let active = true;
    socket.timeout(6_000).emit('room:history', { roomId }, (timeoutError: Error | null, result?: { ok: boolean; messages?: Message[] }) => {
      const history = result?.messages ?? [];
      if (timeoutError || !result?.ok) { if (active) setMessagesLoaded(true); return; }
        if (!active) return;
        setMessages(current => {
          const persistentHistory = history.filter(message => message.type !== 'system' && message.type !== 'soundpack');
          const merged = new Map(persistentHistory.map(message => [message.id, message]));
          current.forEach(message => merged.set(message.id, message));
          return [...merged.values()].sort((left, right) => left.timestamp - right.timestamp);
        });
        setMessagesLoaded(true);
      });
    return () => { active = false; };
  }, [roomId, roomSynced, serverURL]);

  useEffect(() => {
    if (!roomId || !sessionReady || joinBlockedRef.current) { setRoomSynced(false); setJoiningRoom(false); return; }
    setRoomSynced(false);
    setJoinError(null);
    const generation = ++joinGenerationRef.current;
    setJoiningRoom(true);
    const payload = { roomId, ...(roomPasswordRef.current ? { password: roomPasswordRef.current } : {}) };
    socket.timeout(5_000).emit('room:join', payload, (error: Error | null, response: { ok: boolean; error?: string; code?: string }) => {
      if (generation !== joinGenerationRef.current || joinBlockedRef.current) return;
      setJoiningRoom(false);
      if (error) { setJoinError({ message: error.message }); return; }
      if (!response?.ok) { setJoinError({ message: response?.error ?? '无法加入房间', code: response?.code }); return; }
      setJoinError(null);
      setRoomSynced(true);
    });
    return () => { if (generation === joinGenerationRef.current) setJoiningRoom(false); joinGenerationRef.current += 1; };
  }, [roomId, sessionReady, socket]);

  useEffect(() => {
    if (!roomId) return;
    const onNew = (msg: Message) => { if (!roomSyncedRef.current || msg.roomId !== roomId) return; setMessages(prev => prev.some(current => current.id === msg.id) ? prev : [...prev, msg]); };
    const onState = (state: RoomState) => {
      if (state.roomId !== roomId) return;
      setRoomMembers(state.members);
      setIsOwner(state.isOwner);
      if (joinBlockedRef.current) return;
      setRoomSynced(true);
      setRoom(current => current ? { ...current, ownerName: state.ownerName, maxMembers: state.maxMembers, hasPassword: state.hasPassword } : current);
    };
    const onDeleted = ({ roomId: deletedRoomId }: { roomId: string }) => {
      if (deletedRoomId !== roomId) return;
      joinBlockedRef.current = true;
      joinGenerationRef.current += 1;
      setJoiningRoom(false);
      rtc.leaveVoice();
      navigate('/', { replace: true });
    };
    const onKicked = ({ roomId: kickedRoomId, by }: { roomId: string; by?: string }) => {
      if (kickedRoomId !== roomId) return;
      joinBlockedRef.current = true;
      joinGenerationRef.current += 1;
      setJoiningRoom(false);
      rtc.leaveVoice();
      setKickNotice({
        title: '你已被移出房间',
        message: `房主${by ? `（${by}）` : ''}已将你移出当前房间。`,
        returnToList: true,
      });
    };
    socket.on('message:new', onNew);
    socket.on('room:state', onState);
    socket.on('room:deleted', onDeleted);
    socket.on('room:kicked', onKicked);
    return () => {
      if (socket.connected) socket.emit('room:leave', roomId);
      else socket.once('connect', () => {
        if (socket.recovered) socket.emit('room:leave', roomId);
      });
      socket.off('message:new', onNew);
      socket.off('room:state', onState);
      socket.off('room:deleted', onDeleted);
      socket.off('room:kicked', onKicked);
      rtc.leaveVoice();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  const chatHistoryReady = messagesLoaded && room?.id === roomId;
  useLayoutEffect(() => {
    // 隐藏的绝对定位抽屉仍在 DOM 中。对它调用 scrollIntoView 会让浏览器
    // 尝试把屏幕外的目标滚回视口，表现为聊天区露出一条空框并把主画面向左顶。
    // 抽屉收起时跳过滚动，用户展开时再由依赖变化把内容定位到底部。
    if (!chatHistoryReady || !roomId || !messagesEndRef.current || (hasScreen && !chatDrawerOpen)) return;
    const isInitialScroll = initiallyScrolledRoomRef.current !== roomId;
    const scrollContainer = messagesEndRef.current.parentElement;
    if (scrollContainer) {
      // 只滚动聊天列表本身，避免 scrollIntoView 把绝对定位的聊天抽屉
      // 当作视口目标，连带改变共享画面的水平滚动位置。
      scrollContainer.scrollTo({
        top: scrollContainer.scrollHeight,
        behavior: isInitialScroll ? 'auto' : 'smooth',
      });
    }
    initiallyScrolledRoomRef.current = roomId;
  }, [chatHistoryReady, messages, roomId, hasScreen, chatDrawerOpen]);

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
      setKickNotice({
        title: '移除失败',
        message: error instanceof Error ? error.message : String(error),
        returnToList: false,
      });
    } finally {
      setKickingId(null);
    }
  }, [isOwner, roomId]);

  const requestKickMember = useCallback((member: RoomMember) => {
    if (!roomId || !isOwner || member.isOwner || member.socketId === socket.id) return;
    setKickConfirmMember(member);
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

  const updateRoomSettings = useCallback(() => {
    if (!roomId || !isOwner || updatingRoomSettings) return;
    let payload: ReturnType<typeof updateRoomPayload>;
    try { payload = updateRoomPayload(roomId, settingsMaxMembers, passwordAction, settingsPassword); }
    catch (error) { alert(error instanceof Error ? error.message : String(error)); return; }
    setUpdatingRoomSettings(true);
    socket.timeout(5_000).emit('room:update-settings', payload, (error: Error | null, response: { ok: boolean; room?: Room; error?: string }) => {
      if (error || !response?.ok) { alert(response?.error ?? error?.message ?? '设置保存失败'); setUpdatingRoomSettings(false); return; }
      if (response.room) setRoom(response.room);
      setShowRoomSettings(false);
      setSettingsPassword('');
      setPasswordAction('keep');
      setUpdatingRoomSettings(false);
    });
  }, [isOwner, roomId, settingsMaxMembers, passwordAction, settingsPassword, updatingRoomSettings]);

  const menuMember = memberMenu && memberMenu.roomId === roomId && isOwner && sessionReady && roomSynced && sidebarOpen
    ? roomMembers.find(member => member.socketId === memberMenu.socketId && !member.isOwner && member.socketId !== socket.id)
    : undefined;
  useEffect(() => {
    if (memberMenu && !menuMember) closeMemberMenu();
  }, [memberMenu, menuMember, closeMemberMenu]);

  if (!room || !roomSynced) return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-zinc-950 via-black to-zinc-900 p-4">
      <section className="w-full max-w-sm rounded-3xl border border-white/15 bg-zinc-900/95 p-7 shadow-2xl" role="dialog" aria-modal="true">
        {!room ? <p className="text-center text-white/40">加载中…</p> : <>
          {kickNotice && <div className="mb-4 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">{kickNotice.message}</div>}
          <h2 className="text-xl font-bold text-white">加入「{room.name}」</h2>
          {(() => { const needPassword = room.hasPassword || joinError?.code === 'PASSWORD_REQUIRED' || joinError?.code === 'INVALID_PASSWORD'; return <><p className="mt-2 text-sm text-white/45">{joinError?.message ?? (needPassword ? '请输入房间密码' : '正在验证加入权限…')}</p>{needPassword && <input autoFocus type="password" maxLength={128} value={joinPassword} onChange={event => setJoinPassword(event.target.value)} className="mt-5 w-full rounded-xl border border-white/10 bg-white/[0.07] px-3 py-3 text-white outline-none" placeholder="房间密码" />}<div className="mt-5 flex gap-2.5"><button onClick={() => navigate('/')} className="flex-1 rounded-xl bg-white/10 py-3 font-medium text-white/70">返回</button><button disabled={joiningRoom} onClick={() => { roomPasswordRef.current = needPassword ? joinPassword : undefined; setJoinError(null); const generation = ++joinGenerationRef.current; setJoiningRoom(true); socket.timeout(5_000).emit('room:join', { roomId, ...(roomPasswordRef.current ? { password: roomPasswordRef.current } : {}) }, (error: Error | null, response: { ok: boolean; error?: string; code?: string }) => { if (generation !== joinGenerationRef.current || joinBlockedRef.current) return; setJoiningRoom(false); if (error || !response?.ok) setJoinError({ message: response?.error ?? error?.message ?? '无法加入房间', code: response?.code }); else setRoomSynced(true); }); }} className="flex-1 rounded-xl bg-white py-3 font-semibold text-zinc-900 disabled:opacity-30">{joiningRoom ? '加入中…' : '重试'}</button></div></>; })()}
        </>}
      </section>
    </div>
  );

  // 自己始终置顶，其余成员按“语音中 > 仅在房间”排序；组内保持服务端顺序稳定。
  const voiceMemberSocketIds = new Set(rtc.voiceMembers.map(member => member.socketId));
  const sortedRoomMembers = sortRoomMembers(roomMembers, voiceMemberSocketIds, rtc.localSocketId ?? socket.id);
  const remoteScreenMember = rtc.remoteScreen
    ? roomMembers.find(member => member.socketId === rtc.remoteScreen!.socketId)
    : undefined;
  const controllingRemoteScreen = remoteControlSession?.role === 'controller'
    && remoteControlSession.sharerSocketId === rtc.remoteScreen?.socketId;
  const sharingUnderRemoteControl = remoteControlSession?.role === 'sharer' && !!rtc.localScreen;

  // 观看期间仅在视频内部显示当前共享提示，不改动其他共享的订阅或播放状态。
  const hasScreenBanner = rtc.inVoice && rtc.availableScreens.length > 0 && !rtc.localScreen && !rtc.remoteScreen;
  const hasApplicationAudioBanner = rtc.inVoice && !rtc.remoteScreen && (rtc.isApplicationAudioSharing || rtc.remoteApplicationAudios.length > 0);
  const compactDiagnosticsFps = rtc.localScreen ? rtc.stats.sendFps : rtc.stats.receiveFps;
  const compactDiagnosticsResolution = rtc.stats.width && rtc.stats.height
    ? `${rtc.stats.width}×${rtc.stats.height}`
    : '—';
  const compactDiagnosticsBitrate = rtc.stats.bitrate != null
    ? `${rtc.stats.bitrate} kbps`
    : '等待第二个样本';
  return (
    <div className="h-full flex bg-gradient-to-br from-zinc-950 via-black to-zinc-900 overflow-hidden">

      {incomingRemoteControl && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md">
          <section className="w-full max-w-sm rounded-3xl border border-cyan-300/20 bg-zinc-900 p-7 text-white shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="remote-control-request-title">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-300/15 text-cyan-200"><MousePointer2 size={24} /></div>
            <h2 id="remote-control-request-title" className="mt-4 text-center text-lg font-semibold">远程控制请求</h2>
            <p className="mt-2 text-center text-sm leading-relaxed text-white/55">
              <span className="font-semibold text-white">{incomingRemoteControl.controllerName}</span> 请求控制你正在共享的屏幕。
            </p>
            <p className="mt-3 rounded-xl border border-amber-300/15 bg-amber-300/[0.07] px-3 py-2 text-xs leading-relaxed text-amber-100/70">
              同意后，对方可以发送鼠标和键盘输入。你可以随时点击停止，或按 Ctrl+Alt+Shift+X 紧急终止；UAC 与安全桌面不会被控制。
            </p>
            <div className="mt-5 flex gap-2.5">
              <button onClick={() => respondRemoteControl(false)} className="flex-1 rounded-xl bg-white/10 py-3 font-semibold text-white/70 transition hover:bg-white/15">拒绝</button>
              <button onClick={() => respondRemoteControl(true)} className="flex-1 rounded-xl bg-cyan-100 py-3 font-semibold text-zinc-900 transition hover:bg-white">允许本次控制</button>
            </div>
          </section>
        </div>
      )}

      {showScreenModal && (
        <ScreenSettingsModal
          preset={pendingPreset} fps={pendingFps} audio={pendingAudio} gameMode={pendingGameMode}
          nativeResolution={pendingNativeResolution} onNativeResolution={setPendingNativeResolution}
          onPreset={setPendingPreset} onFps={setPendingFps}
          onAudio={() => setPendingAudio(a => !a)}
          onGameMode={() => setPendingGameMode(enabled => {
            const next = !enabled;
            if (next) setPendingFps(60);
            return next;
          })}
          onCancel={() => setShowScreenModal(false)}
          onConfirm={() => { setShowScreenModal(false); rtc.startScreenShare(pendingPreset, pendingFps, pendingAudio, pendingGameMode, pendingNativeResolution); }}
        />
      )}

      {showApplicationAudioModal && (
        <ApplicationAudioModal
          sources={applicationAudioSources}
          loading={applicationAudioLoading}
          onRefresh={() => { void refreshApplicationAudioSources(); }}
          onSelect={source => {
            setShowApplicationAudioModal(false);
            void rtc.startApplicationAudioShare(source);
          }}
          onClose={() => setShowApplicationAudioModal(false)}
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

      {kickConfirmMember && (
        <div className="fixed inset-0 z-[125] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md" onMouseDown={() => setKickConfirmMember(null)}>
          <section className="w-full max-w-sm rounded-3xl border border-red-400/20 bg-zinc-900/95 p-7 shadow-2xl" onMouseDown={event => event.stopPropagation()} role="alertdialog" aria-modal="true" aria-labelledby="kick-member-title">
            <div className="flex items-start justify-between">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-red-500/15 text-red-300"><UserMinus size={21} /></div>
              <button onClick={() => setKickConfirmMember(null)} className="rounded-xl p-2 text-white/35 transition hover:bg-white/10 hover:text-white" aria-label="关闭移除确认"><X size={18} /></button>
            </div>
            <h2 id="kick-member-title" className="mt-5 text-xl font-bold text-white">移除成员？</h2>
            <p className="mt-2 text-sm leading-relaxed text-white/45">确定要将 <span className="font-semibold text-white/80">{kickConfirmMember.username}</span> 移出当前房间吗？对方将立即离开房间，但之后仍可重新加入。</p>
            <div className="mt-6 flex gap-2.5">
              <button onClick={() => setKickConfirmMember(null)} className="flex-1 rounded-xl bg-white/10 py-3 font-medium text-white/70 transition hover:bg-white/15">取消</button>
              <button onClick={() => { const member = kickConfirmMember; setKickConfirmMember(null); void kickMember(member); }} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-red-500 py-3 font-semibold text-white transition hover:bg-red-400"><UserMinus size={17} />确认移除</button>
            </div>
          </section>
        </div>
      )}

      {kickNotice && (
        <div className="fixed inset-0 z-[135] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md" onMouseDown={() => { if (kickNotice.returnToList) navigate('/', { replace: true }); setKickNotice(null); }}>
          <section className="w-full max-w-sm rounded-3xl border border-amber-300/20 bg-zinc-900/95 p-7 shadow-2xl" onMouseDown={event => event.stopPropagation()} role="alertdialog" aria-modal="true" aria-labelledby="kick-notice-title">
            <div className="flex items-start justify-between">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-300/15 text-amber-200"><UserMinus size={21} /></div>
              <button onClick={() => { if (kickNotice.returnToList) navigate('/', { replace: true }); setKickNotice(null); }} className="rounded-xl p-2 text-white/35 transition hover:bg-white/10 hover:text-white" aria-label="关闭提示"><X size={18} /></button>
            </div>
            <h2 id="kick-notice-title" className="mt-5 text-xl font-bold text-white">{kickNotice.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-white/55">{kickNotice.message}</p>
            <button onClick={() => { if (kickNotice.returnToList) navigate('/', { replace: true }); setKickNotice(null); }} className="mt-6 w-full rounded-xl bg-white py-3 font-semibold text-zinc-900 transition hover:bg-cyan-100">{kickNotice.returnToList ? '返回频道列表' : '知道了'}</button>
          </section>
        </div>
      )}

      {memberMenu && menuMember && (
        <MemberContextMenu key={menuMember.socketId} username={menuMember.username} muted={menuMember.isMuted}
          x={memberMenu.x} y={memberMenu.y} disabled={moderatingId === menuMember.socketId || kickingId === menuMember.socketId}
          onClose={closeMemberMenu} onToggleMute={() => { void setMemberMuted(menuMember); }}
          onRemove={() => requestKickMember(menuMember)} />
      )}

      {showRoomSettings && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-md" onMouseDown={() => setShowRoomSettings(false)}>
          <section className="w-full max-w-sm rounded-3xl border border-white/15 bg-zinc-900/95 p-7 shadow-2xl" onMouseDown={event => event.stopPropagation()} role="dialog" aria-modal="true">
            <h2 className="text-xl font-bold text-white">房间设置</h2>
            <label className="mt-5 block text-sm font-medium text-white/55">人数上限<select value={settingsMaxMembers} onChange={event => setSettingsMaxMembers(event.target.value)} className="ml-3 rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-white"><option value="">不限</option><option value="2">2</option><option value="5">5</option><option value="10">10</option><option value="20">20</option></select></label>
            <label className="mt-4 block text-sm font-medium text-white/55">密码操作<select value={passwordAction} onChange={event => setPasswordAction(event.target.value as typeof passwordAction)} className="ml-3 rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-white"><option value="keep">保持不变</option><option value="set">设置新密码</option><option value="clear">取消密码</option></select></label>
            {passwordAction === 'set' && <input autoFocus type="password" maxLength={128} value={settingsPassword} onChange={event => setSettingsPassword(event.target.value)} className="mt-3 w-full rounded-xl border border-white/10 bg-white/[0.07] px-3 py-3 text-white outline-none" placeholder="新密码" />}
            <div className="mt-6 flex gap-2.5"><button disabled={updatingRoomSettings} onClick={() => setShowRoomSettings(false)} className="flex-1 rounded-xl bg-white/10 py-3 text-white/70">取消</button><button onClick={updateRoomSettings} disabled={updatingRoomSettings || (passwordAction === 'set' && !settingsPassword)} className="flex-1 rounded-xl bg-white py-3 font-semibold text-zinc-900 disabled:opacity-30">{updatingRoomSettings ? '保存中…' : '保存'}</button></div>
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
                {showRoomMenu && <div className="absolute right-0 top-10 z-20 w-44 rounded-xl border border-white/10 bg-zinc-900 p-1.5 shadow-xl"><button onClick={() => { setShowRoomMenu(false); setSettingsMaxMembers(room.maxMembers ? String(room.maxMembers) : ''); setShowRoomSettings(true); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/70 transition hover:bg-white/10"><Settings2 size={16} /> 房间设置</button><button onClick={() => { setShowRoomMenu(false); setConfirmDelete(true); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-300 transition hover:bg-red-500/10"><Trash2 size={16} /> 删除房间</button></div>}
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
                const canModerate = isOwner && !member.isOwner && !isSelf && sessionReady && roomSynced;
                const voiceMember = rtc.voiceMembers.find(voice => voice.socketId === member.socketId);
                const inVoice = !!voiceMember;
                const showVoiceState = rtc.inVoice && inVoice;
                const voiceMuted = !!voiceMember?.isMuted;
                const level = showVoiceState
                  ? rtc.speakingLevels[member.socketId] ?? (isSelf ? rtc.speakingLevels[rtc.localSocketId ?? ''] ?? 0 : 0)
                  : 0;
                const speaking = showVoiceState && level > 0.08 && !voiceMuted && !(isSelf && rtc.isMuted);
                const sharingScreen = !!member.isSharingScreen || (isSelf && !!rtc.localScreen)
                  || rtc.availableScreens.some(screen => screen.socketId === member.socketId);
                const sharingApplicationAudio = !!member.isSharingApplicationAudio || (isSelf && rtc.isApplicationAudioSharing)
                  || rtc.remoteApplicationAudios.some(audio => audio.socketId === member.socketId);
                return (
                  <div key={member.socketId} className="group rounded-xl px-2 py-2 transition-colors hover:bg-white/[0.06]"
                    onContextMenu={event => {
                      if (!canModerate || !roomId) return;
                      event.preventDefault(); event.stopPropagation();
                      memberMenuAnchor.current = event.currentTarget.querySelector<HTMLButtonElement>('[data-member-profile]');
                      setMemberMenu({ socketId: member.socketId, roomId, x: event.clientX, y: event.clientY });
                    }}
                    onKeyDown={event => {
                      if (!canModerate || !roomId || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
                      event.preventDefault(); event.stopPropagation();
                      const anchor = event.currentTarget.querySelector<HTMLButtonElement>('[data-member-profile]');
                      memberMenuAnchor.current = anchor;
                      const rect = (anchor ?? event.currentTarget).getBoundingClientRect();
                      setMemberMenu({ socketId: member.socketId, roomId, x: rect.left, y: rect.bottom });
                    }}>
                    {/* 管理操作仅由右键菜单唤出，不再挤占成员信息行。 */}
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <button
                          data-member-profile
                          onClick={() => isSelf ? setShowProfile(true) : setViewingProfile(member)}
                          className="flex w-full min-w-0 items-center gap-3 rounded-xl text-left focus:outline-none focus:ring-2 focus:ring-cyan-300/35"
                          title={isSelf ? '打开个人名片' : `查看 ${member.username} 的主页${canModerate ? '（右键管理成员）' : ''}`}
                          aria-haspopup={canModerate ? 'menu' : undefined}
                          aria-expanded={canModerate ? menuMember?.socketId === member.socketId : undefined}
                          aria-controls={menuMember?.socketId === member.socketId ? 'member-moderation-menu' : undefined}
                        >
                          <Avatar username={member.username} avatarUrl={member.avatarUrl} size="sm" className={speaking ? 'border-green-400/60 ring-2 ring-green-400/40' : isSelf ? 'border-white/30' : 'transition group-hover:border-cyan-200/30'} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className={`min-w-0 flex-1 truncate text-base font-medium ${isSelf ? 'text-white' : 'text-white/55'}`}>
                                {isSelf ? `${member.username}（你）` : (profileRemarks[member.userId] || member.username)}
                              </span>
                              {member.platform === 'mobile'
                                ? <Smartphone size={13} className="flex-shrink-0 text-cyan-100/40" aria-label="手机端" />
                                : member.platform === 'desktop'
                                  ? <Monitor size={13} className="flex-shrink-0 text-cyan-100/40" aria-label="电脑端" />
                                  : null}
                              {member.isOwner && <Crown size={14} className="flex-shrink-0 text-amber-300" aria-label="房主" />}
                              {(member.isMuted || (showVoiceState && voiceMuted)) && <MicOff size={13} className="flex-shrink-0 text-red-300/70" aria-label={member.isMuted ? '已被房主禁言' : '麦克风已关闭'} />}
                            </div>
                            {profileRemarks[member.userId] && !isSelf && <p className="mt-0.5 truncate text-xs text-white/30">用户名：{member.username}</p>}
                            {member.isOwner && <p className="mt-0.5 text-xs text-amber-300/50">房主</p>}
                          </div>
                        </button>
                      </div>
                    </div>

                    {showVoiceState && (
                      <div className="relative ml-11 mt-2 flex min-w-0 items-center gap-2">
                        {/* 图标留在头像正下方，只下移到电平条中线，不挤占原有音量控件。 */}
                        <span className="absolute -left-11 top-1/2 flex h-5 w-8 -translate-y-1/2 items-center justify-center gap-1" aria-label={sharingScreen || sharingApplicationAudio ? `${member.username} 正在共享媒体` : undefined}>
                          {sharingScreen && <span className="flex h-4 w-4 items-center justify-center rounded-md bg-amber-300/15 text-amber-300" title="正在共享屏幕"><MonitorUp size={11} /></span>}
                          {sharingApplicationAudio && <span className="flex h-4 w-4 items-center justify-center rounded-md bg-violet-300/15 text-violet-300" title="正在共享应用音频"><AudioLines size={11} /></span>}
                        </span>
                        {!isSelf && rtc.inVoice && voiceMember ? (
                          <div className="flex min-w-0 flex-1 items-center gap-x-2">
                            <button
                              type="button"
                              onClick={() => rtc.toggleMemberMute(member.socketId, voiceMember.userId)}
                              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md p-0.5 text-white/35 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-300/35"
                              title={(rtc.memberVolumes[member.socketId] ?? 1) === 0 ? `恢复 ${member.username} 的声音` : `静音 ${member.username}`}
                              aria-label={(rtc.memberVolumes[member.socketId] ?? 1) === 0 ? `恢复 ${member.username} 的声音` : `静音 ${member.username}`}
                            >
                              {(rtc.memberVolumes[member.socketId] ?? 1) === 0
                                ? <VolumeX size={13} />
                                : <Volume2 size={13} />}
                            </button>
                            <div
                              className="group/volume relative h-5 min-w-0 w-0 flex-1"
                              data-testid="voice-volume-meter"
                              onWheel={event => {
                                if (event.deltaY === 0) return;
                                event.preventDefault();
                                event.stopPropagation();
                                const current = Math.round((rtc.memberVolumes[member.socketId] ?? 1) * 100);
                                const next = Math.max(0, Math.min(200, current + (event.deltaY < 0 ? 1 : -1)));
                                if (next !== current)
                                  rtc.setMemberVolume(member.socketId, voiceMember.userId, next / 100);
                              }}
                            >
                              {/* 所有成员共用整行的固定右边界；绿色强度轨和青色音量轨叠在同一中心线上。 */}
                              <div
                                className="pointer-events-none absolute left-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-gradient-to-r from-green-500/75 to-emerald-300 transition-[width] duration-75"
                              style={{ width: `${Math.round((voiceMuted ? 0 : Math.min(1, level * (rtc.memberVolumes[member.socketId] ?? 1))) * 100)}%` }}
                                role="progressbar"
                                aria-label={`${member.username} 调整后的实时声音强度`}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.round((voiceMuted ? 0 : Math.min(1, level * (rtc.memberVolumes[member.socketId] ?? 1))) * 100)}
                              />
                              <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/15" />
                              <div
                                className="pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-cyan-300/75"
                                style={{ width: `${Math.round((rtc.memberVolumes[member.socketId] ?? 1) / 2 * 100)}%` }}
                              />
                              <div
                                className="pointer-events-none absolute top-1/2 h-3 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-50/80 bg-cyan-100 shadow-[0_0_6px_rgba(165,243,252,0.75)]"
                                style={{ left: `${Math.round((rtc.memberVolumes[member.socketId] ?? 1) / 2 * 100)}%` }}
                                aria-hidden="true"
                              />
                              <input
                                type="range"
                                min="0"
                                max="200"
                                step="1"
                                value={Math.round((rtc.memberVolumes[member.socketId] ?? 1) * 100)}
                                onChange={event => rtc.setMemberVolume(member.socketId, voiceMember.userId, Number(event.target.value) / 100)}
                                onPointerDown={event => {
                                  if (event.button !== 0) return;
                                  setDraggingVolumeMember(member.socketId);
                                  event.currentTarget.setPointerCapture(event.pointerId);
                                }}
                                onLostPointerCapture={() => setDraggingVolumeMember(null)}
                                className="absolute inset-x-0 top-1/2 h-5 w-full -translate-y-1/2 cursor-pointer opacity-0"
                                aria-label={`${member.username} 的接收音量（0-200%，100%为原始音量）`}
                                aria-valuetext={`${Math.round((rtc.memberVolumes[member.socketId] ?? 1) * 100)}%`}
                              />
                              <span
                                aria-hidden="true"
                                className={`pointer-events-none absolute bottom-full z-40 mb-2 -translate-x-1/2 rounded-lg border border-white/10 bg-zinc-800 px-2.5 py-1 text-sm tabular-nums text-white shadow-lg transition-opacity duration-100 ${draggingVolumeMember === member.socketId ? 'opacity-100' : 'opacity-0 group-hover/volume:opacity-100 group-focus-within/volume:opacity-100'}`}
                                style={{ left: `${Math.round((rtc.memberVolumes[member.socketId] ?? 1) / 2 * 100)}%` }}
                              >
                                {Math.round((rtc.memberVolumes[member.socketId] ?? 1) * 100)}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <>
                            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-white/35" title={rtc.isMuted ? '麦克风已关闭' : '麦克风声音强度'}>
                              {rtc.isMuted ? <MicOff size={13} /> : <Mic size={13} />}
                            </span>
                            <div className="h-1 min-w-0 w-0 flex-1 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label={`${member.username} 的实时声音强度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((voiceMuted || (isSelf && rtc.isMuted) ? 0 : level) * 100)}>
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-green-400 to-emerald-300 transition-[width] duration-75"
                                style={{ width: `${Math.round((voiceMuted || (isSelf && rtc.isMuted) ? 0 : level) * 100)}%` }}
                              />
                            </div>
                          </>
                        )}
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
                <button onClick={rtc.toggleMute} disabled={rtc.isForceMuted || !sessionReady} className={`rounded-xl p-2 transition disabled:cursor-not-allowed ${rtc.isForceMuted || rtc.isMuted ? 'bg-red-500/20 text-red-300' : 'text-emerald-300 hover:bg-white/10 hover:text-emerald-200'}`} aria-label={rtc.isForceMuted ? '已被房主语音禁言' : rtc.isMuted ? '取消静音' : '静音'} title={rtc.isForceMuted ? '已被房主语音禁言' : rtc.isMuted ? '取消静音' : '静音'}>{rtc.isMuted || rtc.isForceMuted ? <MicOff size={18} /> : <Mic size={18} />}</button>
                <button onClick={!rtc.isSharing ? () => setShowScreenModal(true) : rtc.stopScreenShare} disabled={!sessionReady} className={`rounded-xl p-2 transition ${rtc.isSharing ? 'bg-amber-500/20 text-amber-300' : 'text-white/60 hover:bg-white/10 hover:text-white'}`} aria-label={rtc.isSharing ? '停止屏幕共享' : '开始屏幕共享'} title={rtc.isSharing ? '停止屏幕共享' : '开始屏幕共享'}><MonitorUp size={18} /></button>
                <button onClick={rtc.isApplicationAudioSharing ? rtc.stopApplicationAudioShare : openApplicationAudioModal} disabled={!sessionReady} className={`rounded-xl p-2 transition ${rtc.isApplicationAudioSharing ? 'bg-violet-400/20 text-violet-200' : 'text-white/60 hover:bg-white/10 hover:text-white'}`} aria-label={rtc.isApplicationAudioSharing ? '停止应用音频共享' : '共享应用音频'} title={rtc.isApplicationAudioSharing ? `停止共享 ${rtc.applicationAudioLabel ?? '应用'} 的音频` : '共享应用音频（仅音频）'}><AudioLines size={18} /></button>
                <button onClick={rtc.leaveVoice} className="rounded-xl p-2 text-red-400 transition hover:bg-red-500/20 hover:text-red-200" aria-label="离开语音" title="离开语音"><PhoneOff size={18} /></button>
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

        {!rtc.inVoice && rtc.audioDeviceError && (
          <div role="status" className="border-b border-amber-300/10 bg-amber-300/5 px-5 py-2 text-sm text-amber-100/80">
            {rtc.audioDeviceError}
          </div>
        )}

        {hasScreenBanner && (
          <CollapsibleMediaBanner kind="screen">
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
          </CollapsibleMediaBanner>
        )}

        {hasApplicationAudioBanner && (
          <>
            {rtc.isApplicationAudioSharing && (
              <CollapsibleMediaBanner kind="audio">
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-violet-200 text-zinc-900"><AudioLines size={18} /></span>
                <div className="min-w-0 flex-1"><p className="truncate font-semibold">正在共享 {rtc.applicationAudioLabel ?? '应用'} 的音频</p><p className="mt-0.5 text-xs text-violet-100/45">仅共享该应用及其子进程的声音</p></div>
                <label className="flex items-center gap-2 text-xs text-violet-100/70" title="调节对方听到的应用音频音量"><Volume2 size={15} /><input type="range" min="0" max="100" step="1" value={Math.round(rtc.applicationAudioShareVolume * 100)} onChange={event => rtc.setApplicationAudioShareVolume(Number(event.target.value) / 100)} className="h-1 w-24 cursor-pointer accent-violet-200" aria-label="应用音频发送音量" /><span className="w-8 text-right tabular-nums">{Math.round(rtc.applicationAudioShareVolume * 100)}%</span></label>
                <button onClick={rtc.stopApplicationAudioShare} className="rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold text-white/75 transition hover:bg-red-500/20 hover:text-red-200">停止</button>
              </CollapsibleMediaBanner>
            )}
            {rtc.remoteApplicationAudios.map(audio => {
              const sharer = rtc.voiceMembers.find(member => member.socketId === audio.socketId)?.username ?? '成员';
              const receiveVolume = rtc.applicationAudioReceiveVolumes[audio.socketId] ?? 1;
              return (
                <CollapsibleMediaBanner key={audio.producerId} kind="audio">
                  <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-violet-200 text-zinc-900"><AudioLines size={18} /></span>
                  <div className="min-w-0 flex-1"><p className="truncate font-semibold">正在接收 {sharer} 共享的 {audio.label} 音频</p><p className="mt-0.5 truncate text-xs text-violet-100/45">来自 {sharer} · 仅共享该应用及其子进程的声音</p></div>
                  <label className="flex items-center gap-2 text-xs text-violet-100/70" title={`调节 ${sharer} 的应用音频音量`}><Volume2 size={15} /><input type="range" min="0" max="100" step="1" value={Math.round(receiveVolume * 100)} onChange={event => rtc.setApplicationAudioReceiveVolume(audio.socketId, Number(event.target.value) / 100)} className="h-1 w-24 cursor-pointer accent-violet-200" aria-label={`${sharer} 应用音频音量`} /><span className="w-8 text-right tabular-nums">{Math.round(receiveVolume * 100)}%</span></label>
                </CollapsibleMediaBanner>
              );
            })}
          </>
        )}

        {/* Screen share */}
        {hasScreen && (
          <div
            className={screenMaximized
              ? 'fixed inset-0 z-[100] bg-black'
              : 'min-h-0 flex-1 bg-black'}
          >
            <div ref={screenContainerRef} className="cove-screen-container relative h-full bg-black">
              {rtc.remoteScreen ? (
                <>
                  <RemoteScreenVideo stream={rtc.remoteScreen.stream} controlling={controllingRemoteScreen} onInput={sendRemoteControlInput} />
                  <WatchingScreenBanner
                    key={rtc.remoteScreen.stream.id}
                    sharer={rtc.voiceMembers.find(member => member.socketId === rtc.remoteScreen!.socketId)?.username ?? '成员'}
                    onStopWatching={() => { if (controllingRemoteScreen) stopRemoteControl(); rtc.stopWatchingScreen(); }}
                  >
                    <WatchingScreenControls volume={rtc.screenReceiveVolume} onVolumeChange={rtc.setScreenReceiveVolume}
                      remoteState={controllingRemoteScreen ? 'active' : pendingRemoteControl ? 'pending' : remoteScreenMember?.canReceiveRemoteControl && window.coveRemoteControl?.supported ? 'available' : 'unsupported'}
                      notice={remoteControlNotice} onRequestControl={requestRemoteControl} onStopControl={stopRemoteControl} />
                  </WatchingScreenBanner>
                  <div className="absolute bottom-3 left-3 bg-black/60 backdrop-blur-md text-white text-sm px-3 py-1.5 rounded-xl font-medium border border-white/10">
                    {rtc.voiceMembers.find(m => m.socketId === rtc.remoteScreen!.socketId)?.username ?? rtc.remoteScreen.socketId} 正在共享
                  </div>
                </>
              ) : rtc.localScreen ? (
                <>
                  <LocalScreenVideo stream={rtc.localScreen} />
                  <div className="absolute bottom-3 left-3 bg-white/10 backdrop-blur-md text-white text-sm px-3 py-1.5 rounded-xl font-medium border border-white/15">
                    你正在共享 · {rtc.screenViewerCount} 人观看 · {rtc.screenNativeResolution ? '原生 ' : ''}{rtc.screenEncodingPlan ? `${rtc.screenEncodingPlan.outputWidth}×${rtc.screenEncodingPlan.outputHeight}` : SCREEN_PRESETS[rtc.screenPreset].label} · {rtc.screenGameMode ? '游戏模式' : `自动${rtc.screenActivity === 'static' ? '静止' : rtc.screenActivity === 'motion' ? '动态' : '操作'}`}
                  </div>
                </>
              ) : null}

              {sharingUnderRemoteControl && (
                <div className="absolute right-3 top-16 z-20 max-w-sm rounded-xl border border-amber-300/25 bg-black/60 p-3 text-xs text-white shadow-xl backdrop-blur-md">
                  <p className="font-semibold text-amber-100"><MousePointer2 size={14} className="mr-1.5 inline" />{remoteControlSession.controllerName ?? '成员'} 正在控制你的屏幕</p>
                  <p className="mt-1 text-white/45">按 Ctrl+Alt+Shift+X 或点击下方按钮立即终止。</p>
                  <button onClick={stopRemoteControl} className="mt-2 rounded-lg bg-red-500/20 px-3 py-1.5 font-semibold text-red-100 transition hover:bg-red-500/30">停止控制</button>
                </div>
              )}

              {!rtc.remoteScreen && rtc.localScreen && rtc.shareAudio ? (
                <ScreenVolumeControl
                  volume={rtc.screenShareVolume}
                  onChange={rtc.setScreenShareVolume}
                  ariaLabel="共享发送音量"
                />
              ) : null}

              {/* 实时统计悬浮显示（开关在语音栏） */}
              {rtc.statsEnabled && (
                <div className={`absolute top-3 left-3 z-30 bg-black/80 backdrop-blur-md text-white text-xs px-3 py-2 rounded-xl border border-white/10 font-mono space-y-0.5 ${diagnosticsCompact ? 'min-w-[240px]' : 'min-w-[360px]'}`}>
                  <div className="mb-1 flex items-center justify-between gap-3 border-b border-white/10 pb-1">
                    <span className="font-sans font-semibold text-white/90">媒体诊断 · {rtc.localScreen ? '共享方' : '观看方'}</span>
                    <div className="flex gap-1 font-sans">
                      <button onClick={() => setDiagnosticsCompact(value => !value)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-white/60 hover:bg-white/10 hover:text-white" title={diagnosticsCompact ? '切换到详细模式' : '切换到精简模式'} aria-pressed={diagnosticsCompact}>
                        {diagnosticsCompact ? <Maximize2 size={12} /> : <Minimize2 size={12} />}{diagnosticsCompact ? '详细' : '精简'}
                      </button>
                    </div>
                  </div>
                  {diagnosticsCompact ? (
                    <div className="space-y-0.5" data-testid="compact-media-diagnostics">
                      <div>帧率：<span className="text-green-400">{compactDiagnosticsFps ?? '—'} fps</span></div>
                      <div>分辨率：<span className="text-cyan-300">{compactDiagnosticsResolution}</span></div>
                      <div>码率：<span className="text-cyan-300">{compactDiagnosticsBitrate}</span></div>
                    </div>
                  ) : (
                    <>
                      {rtc.localScreen ? (
                        <div>帧率 轨道/采集/编码/发送：<span className="text-green-400">{rtc.stats.trackFps ?? '—'} / {rtc.stats.captureFps ?? '—'} / {rtc.stats.encodeFps ?? '—'} / {rtc.stats.sendFps ?? '—'} fps</span></div>
                      ) : (
                        <div>帧率 接收/解码：<span className="text-green-400">{rtc.stats.receiveFps ?? '—'} / {rtc.stats.decodeFps ?? rtc.stats.fps ?? '—'} fps</span></div>
                      )}
                  <div>原始采集/实际编码/档位上限：<span className={isScreenEncodingWithinPlan(rtc.stats.width, rtc.stats.height, rtc.localScreen ? rtc.screenEncodingPlan : null) === false ? 'text-red-300' : 'text-cyan-300'}>{rtc.stats.trackWidth && rtc.stats.trackHeight ? `${rtc.stats.trackWidth}×${rtc.stats.trackHeight}` : '—'} / {rtc.stats.width && rtc.stats.height ? `${rtc.stats.width}×${rtc.stats.height}` : '—'} / {rtc.localScreen && rtc.screenEncodingPlan ? `${rtc.screenEncodingPlan.outputWidth}×${rtc.screenEncodingPlan.outputHeight}` : '—'}</span></div>
                  {rtc.localScreen && rtc.screenEncodingPlan && <div>编码缩放：<span className="text-cyan-300">{rtc.screenEncodingPlan.scaleResolutionDownBy.toFixed(3)}×</span></div>}
                  {isScreenEncodingWithinPlan(rtc.stats.width, rtc.stats.height, rtc.localScreen ? rtc.screenEncodingPlan : null) === false && <div className="rounded bg-red-500/15 px-1.5 py-1 text-red-200">编码输出超过所选档位，RTP 缩放没有生效</div>}
                  <div>编码：<span className="text-cyan-300">{rtc.stats.codec ?? '—'}{rtc.stats.encoderImplementation ? ` · ${rtc.stats.encoderImplementation}` : rtc.stats.decoderImplementation ? ` · ${rtc.stats.decoderImplementation}` : ''}</span></div>
                  {rtc.localScreen && <div>节能编码器：<span className="text-white/70">{rtc.stats.powerEfficientEncoder == null ? '未知' : rtc.stats.powerEfficientEncoder ? '是' : '否'}</span></div>}
                  <div>RTP 媒体码率：<span className="text-cyan-300">{rtc.stats.bitrate != null ? `${rtc.stats.bitrate} kbps` : '等待第二个样本'}</span></div>
                  {rtc.localScreen && <div>编码器目标 / Cove 码率上限：<span className="text-cyan-300">{rtc.stats.targetBitrate != null ? `${rtc.stats.targetBitrate} kbps` : '浏览器未提供'} / 不设上限</span></div>}
                  {rtc.localScreen && <div>画面模式：<span className="text-cyan-300">{rtc.screenGameMode ? '游戏模式' : rtc.screenActivity === 'static' ? '自动 · 静止' : rtc.screenActivity === 'motion' ? '自动 · 动态' : '自动 · 普通操作'}</span></div>}
                  {rtc.localScreen && <div>发送可用带宽：<span className="text-cyan-300">{rtc.stats.availableBitrate != null ? `${rtc.stats.availableBitrate} kbps` : '浏览器未提供'}</span></div>}
                  <div>服务器入口/出口：<span className="text-cyan-300">{rtc.stats.serverIngressBitrate != null ? `${rtc.stats.serverIngressBitrate} kbps` : '—'} / {rtc.stats.serverEgressBitrate != null ? `${rtc.stats.serverEgressBitrate} kbps` : '—'}</span>　Score：<span className="text-cyan-300">{rtc.stats.serverScore ?? '—'}</span></div>
                  {rtc.localScreen && <div>编码耗时/平均 QP：<span className="text-amber-300">{rtc.stats.encodeTimeMs != null ? `${rtc.stats.encodeTimeMs} ms/帧` : '—'} / {rtc.stats.averageQp ?? '—'}</span></div>}
                  {!rtc.localScreen && <div>解码耗时：<span className="text-amber-300">{rtc.stats.decodeTimeMs != null ? `${rtc.stats.decodeTimeMs} ms/帧` : '—'}</span></div>}
                  <div>延迟/抖动：<span className="text-amber-400">{rtc.stats.rtt != null ? `${rtc.stats.rtt} ms` : '—'} / {rtc.stats.jitter != null ? `${rtc.stats.jitter} ms` : '—'}</span></div>
                  <div>{rtc.localScreen ? '上传反馈丢包' : '接收丢包'}：<span className="text-red-400">{(rtc.localScreen ? rtc.stats.remoteLoss : rtc.stats.loss) != null ? `${rtc.localScreen ? rtc.stats.remoteLoss : rtc.stats.loss}%` : '等待反馈'}</span>　重传：<span className="text-red-300">{rtc.stats.retransmitBitrate != null ? `${rtc.stats.retransmitBitrate} kbps` : '—'}</span></div>
                  <div>NACK / PLI / FIR：<span className="text-red-300">{rtc.stats.nackPerSecond ?? '—'} / {rtc.stats.pliPerSecond ?? '—'} / {rtc.stats.firPerSecond ?? '—'} 次/秒</span></div>
                  <div>掉帧：<span className="text-red-400">{rtc.stats.droppedFrames != null ? `${rtc.stats.droppedFrames}/秒` : '—'}</span></div>
                  <div>受限原因：<span className="text-white/70">{rtc.stats.qualityLimitation ?? '—'}</span>{rtc.localScreen && <span className="text-white/40">　CPU {rtc.stats.qualityLimitationCpuSeconds ?? '—'}s / 带宽 {rtc.stats.qualityLimitationBandwidthSeconds ?? '—'}s</span>}</div>
                  <div>协议/来源：<span className="text-white/70">{rtc.stats.protocol ?? '—'} / {rtc.stats.displaySurface ?? '—'}</span></div>
                    </>
                  )}
                </div>
              )}

              <ScreenFullscreenControl
                maximized={screenMaximized}
                nativeFullscreen={nativeFullscreen}
                allowNativeFullscreen={!rtc.localScreen}
                onToggleWindow={toggleFullscreen}
                onToggleNative={() => { void toggleNativeFullscreen(); }}
              />
            </div>
          </div>
        )}

        {/* Messages */}
        <div className={hasScreen
          ? `absolute bottom-20 right-0 top-16 z-10 w-96 overflow-y-auto border-l border-white/10 bg-zinc-950/90 px-5 py-4 shadow-2xl backdrop-blur-xl transform transition-[transform,opacity] duration-300 ease-in-out will-change-transform motion-reduce:transition-none ${chatDrawerOpen ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0 pointer-events-none'}`
          : 'flex-1 overflow-y-auto min-h-0 px-6 py-5'}>
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
        <div className={hasScreen
          ? `absolute bottom-0 right-0 z-10 w-96 border-l border-t border-white/10 bg-zinc-950/95 px-4 py-3 backdrop-blur-xl transform transition-[transform,opacity] duration-300 ease-in-out will-change-transform motion-reduce:transition-none ${chatDrawerOpen ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0 pointer-events-none'}`
          : 'flex-shrink-0 px-5 py-4 border-t border-white/[0.08]'}>
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
