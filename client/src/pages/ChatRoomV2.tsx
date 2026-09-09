import {
  Fragment,
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Phone } from "lucide-react";
import {
  AppWindow,
  ArrowDown,
  ArrowClockwise,
  ArrowRight,
  Waveform as AudioLines,
  CaretLeft,
  ChatCircleDots,
  Check,
  Clipboard,
  Copy,
  Desktop,
  DeviceMobile,
  DoorOpen,
  DownloadSimple,
  Eye,
  GearSix,
  Headphones,
  ImageSquare,
  Info,
  CircleNotch as LoaderCircle,
  Microphone,
  MicrophoneSlash,
  MonitorPlay,
  Cursor as MousePointer2,
  PaperPlaneTilt,
  PhoneDisconnect,
  Plus,
  Radio,
  SpeakerHigh,
  SpeakerSlash,
  SquaresFour,
  Moon,
  Sun,
  TextAa,
  Trash,
  UploadSimple,
  UserCircle,
  Waveform,
  Wrench,
  X,
} from "@phosphor-icons/react";
import { socket } from "../socket";
import {
  SCREEN_PRESETS,
  useWebRTC,
  type Fps,
  type ScreenPreset,
} from "../hooks/useWebRTC";
import { useScreenFullscreen } from "../hooks/useScreenFullscreen";
import { Avatar } from "../components/Avatar";
import { ProfileModal } from "../components/ProfileModal";
import { UserProfileModal } from "../components/UserProfileModal";
import { SoundPackPanel } from "../components/SoundPackPanel";
import { CreateRoomDialog } from "../components/CreateRoomDialog";
import { UpdateCenter } from "../components/UpdateCenter";
import packageInfo from "../../package.json";
import { UPDATE_CENTER_DETAILS_EVENT } from "../update";
import { loadProfileRemarks, saveProfileRemark } from "../profileRemarks";
import { createRoomPayload } from "../roomSettings";
import { sortRoomMembers } from "../memberOrdering";
import { prepareAvatar } from "../profile";
import { parseChatText } from "../chatLinks";
import {
  CHAT_IMAGE_MAX_BATCH,
  chatImageMimeType,
  collectChatImageFiles,
  validateChatImageFile,
} from "../chatImages";
import { isScreenEncodingWithinPlan } from "../screenCapture";
import type {
  Message,
  Room,
  RoomMember,
  RoomState,
  UserProfile,
} from "../types";
import {
  normalizedVideoPoint,
  type RemoteControlInput,
} from "../remoteControl";
import type { ApplicationAudioSource } from "../applicationAudio";
import type { AppTheme } from "../theme";
import { pickAboutQuote, type AboutQuote } from "../aboutQuotes";
import "../ui-v2.css";

export type RoomWithAppearance = Room & {
  count?: number;
  avatarUrl?: string | null;
  backgroundTop?: string | null;
  backgroundBottom?: string | null;
  backgroundTopDark?: string | null;
  backgroundBottomDark?: string | null;
};
interface Props {
  profile: UserProfile;
  accountId: string;
  onProfileChange: (profile: UserProfile) => void;
  onLogout: () => void;
  serverURL: string;
  sessionReady: boolean;
  theme: AppTheme;
  onThemeChange: (theme: AppTheme) => void;
}
interface RemoteControlRequest {
  requestId: string;
  roomId: string;
  controllerName: string;
}
interface RemoteControlSession {
  sessionId: string;
  roomId: string;
  role: "controller" | "sharer";
  sharerSocketId?: string;
  controllerName?: string;
}
interface MessageHistoryCursor {
  timestamp: number;
  id: string;
}
interface MessageHistoryResponse {
  ok?: boolean;
  messages?: Message[];
  hasMore?: boolean;
  cursor?: MessageHistoryCursor | null;
}
const clamp = (value: number) => Math.max(0, Math.min(200, Number(value)));

type ChatFontSize = "small" | "medium" | "large";
export type GlobalSettingsPage = "audio" | "account" | "update" | "about";

const CHAT_FONT_SIZE_STORAGE_KEY = "cove-chat-font-size";
const CHAT_FONT_SIZE_OPTIONS: ReadonlyArray<{
  value: ChatFontSize;
  label: string;
  pixels: number;
}> = [
  { value: "small", label: "小", pixels: 14 },
  { value: "medium", label: "标准", pixels: 16 },
  { value: "large", label: "大", pixels: 18 },
];

function readChatFontSize(): ChatFontSize {
  try {
    const value = window.localStorage.getItem(CHAT_FONT_SIZE_STORAGE_KEY);
    if (value === "small" || value === "medium" || value === "large")
      return value;
  } catch {
    // 浏览器禁用本地存储时仍使用默认字号。
  }
  return "medium";
}

function ChatFontMenu({
  fontSize,
  onFontSizeChange,
  onClose,
  className = "",
  onMouseEnter,
  onMouseLeave,
}: {
  fontSize: ChatFontSize;
  onFontSizeChange: (value: ChatFontSize) => void;
  onClose?: () => void;
  className?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  return (
    <div
      className={`chat-font-menu ${className}`.trim()}
      role="menu"
      aria-label="聊天字号"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span className="chat-font-menu-title">消息字号</span>
      {CHAT_FONT_SIZE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={fontSize === option.value}
          className={fontSize === option.value ? "active" : ""}
          onClick={() => {
            onFontSizeChange(option.value);
            onClose?.();
          }}
        >
          <span>{option.label}</span>
          <b style={{ fontSize: option.pixels }}>Aa</b>
        </button>
      ))}
    </div>
  );
}

async function copyTextToClipboard(value: string) {
  if (window.coveClipboard?.writeText) {
    try {
      if (await window.coveClipboard.writeText(value)) return;
    } catch {
      // 原生通道不可用时继续尝试渲染进程的剪贴板接口。
    }
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // 某些 Electron 页面会暴露接口，但实际写入时拒绝请求。
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  if (copied) return;
  if (window.coveClipboard?.writeText) {
    try {
      if (await window.coveClipboard.writeText(value)) return;
    } catch {
      // 统一在函数末尾报告复制失败。
    }
  }
  throw new Error("复制文本失败");
}

async function copyImageToClipboard(src: string) {
  const response = await fetch(src);
  if (!response.ok) throw new Error("读取图片失败");
  const sourceBlob = await response.blob();
  let clipboardBlob = sourceBlob;

  // Chromium 对剪贴板图片的兼容性以 PNG 最好，上传的 JPEG/WebP/GIF
  // 统一转换后再写入，确保可以直接粘贴到聊天输入框或其它应用。
  if (sourceBlob.type !== "image/png") {
    const objectUrl = URL.createObjectURL(sourceBlob);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new window.Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("解码图片失败"));
        element.src = objectUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context || !canvas.width || !canvas.height)
        throw new Error("转换图片失败");
      context.drawImage(image, 0, 0);
      clipboardBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("转换图片失败"))),
          "image/png",
        );
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
  if (window.coveClipboard?.writeImage) {
    try {
      if (
        await window.coveClipboard.writeImage(
          new Uint8Array(await clipboardBlob.arrayBuffer()),
        )
      )
        return;
    } catch {
      // 原生通道不可用时继续尝试浏览器剪贴板接口。
    }
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
    throw new Error("当前环境不支持复制图片");
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": clipboardBlob }),
  ]);
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

function openExternalLink(
  event: MouseEvent<HTMLAnchorElement>,
  url: string,
) {
  event.preventDefault();
  if (window.coveShell) {
    void window.coveShell.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function roomColor(value: string | null | undefined, fallback: string) {
  return /^#[0-9a-f]{6}$/i.test(value ?? "") ? value! : fallback;
}
const ROOM_LIGHT_TOP = "#FFFFFF";
const ROOM_LIGHT_BOTTOM = "#FFFFFF";
const ROOM_DARK_TOP = "#111827";
const ROOM_DARK_BOTTOM = "#0B1220";
function colorLuminance(value: string) {
  const hex = value.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return 1;
  const channels = [0, 2, 4]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((channel) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function DeviceBadge({ platform }: { platform?: string | null }) {
  if (platform !== "mobile" && platform !== "desktop") return null;
  return (
    <span
      className="device-badge"
      title={platform === "mobile" ? "手机端" : "电脑端"}
    >
      {platform === "mobile" ? (
        <DeviceMobile size={10} weight="fill" />
      ) : (
        <Desktop size={10} weight="fill" />
      )}
    </span>
  );
}
function MemberAvatar({
  member,
  speaking = false,
  inVoice = false,
}: {
  member: RoomMember;
  speaking?: boolean;
  inVoice?: boolean;
}) {
  return (
    <span className="member-avatar">
      <Avatar
        username={member.username}
        avatarUrl={member.avatarUrl}
        size="sm"
        className={speaking ? "avatar-core speaking" : "avatar-core"}
      />
      {inVoice && (
        <span
          className={`mic-badge ${member.isMuted ? "off" : "on"}`}
          title={member.isMuted ? "已闭麦" : "已开麦"}
        >
          {member.isMuted ? (
            <MicrophoneSlash size={10} weight="bold" />
          ) : (
            <Microphone size={10} weight="fill" />
          )}
        </span>
      )}
      <DeviceBadge platform={member.platform} />
    </span>
  );
}
function SharedBadges({
  screen,
  audio,
}: {
  screen?: boolean;
  audio?: boolean;
}) {
  if (!screen && !audio) return null;
  return (
    <span className="shared-badges" aria-label="正在共享媒体">
      {screen && (
        <MonitorPlay
          className="screen-share-badge"
          size={15}
          weight="fill"
          aria-label="正在共享屏幕"
        />
      )}
      {audio && (
        <Waveform
          className="audio-share-badge"
          size={15}
          weight="bold"
          aria-label="正在共享音频"
        />
      )}
    </span>
  );
}
function VolumeControl({
  value,
  onChange,
  label,
  icon = "speaker",
  muted = false,
  onMute,
  level = 0,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  icon?: "speaker" | "mic" | "share";
  muted?: boolean;
  onMute?: () => void;
  /** 实时音量电平（0~1），显示在可调节轨道上。 */
  level?: number;
}) {
  const shown = muted ? 0 : Math.round(clamp(value));
  const liveLevel = Math.max(0, Math.min(1, Number(level) || 0));
  const meterLevel = muted
    ? 0
    : Math.min(1, liveLevel * (shown / 100));
  const Icon =
    icon === "mic"
      ? muted
        ? MicrophoneSlash
        : Microphone
      : icon === "share"
        ? Waveform
        : muted
          ? SpeakerSlash
          : SpeakerHigh;
  return (
    <div className={`volume-control volume-${icon}`}>
      <button
        className="volume-icon"
        onClick={onMute}
        aria-label={muted ? `恢复${label}` : `静音${label}`}
        title={muted ? `恢复${label}` : `静音${label}`}
      >
        <Icon size={17} weight={muted ? "regular" : "fill"} />
      </button>
      <label
        style={
          {
            "--volume-position": `${shown / 2}%`,
            "--volume-level": `${meterLevel * 100}%`,
          } as React.CSSProperties
        }
      >
        <span className="sr-only">{label}</span>
        <span className="volume-live-level" aria-hidden="true" />
        <span className="volume-thumb" aria-hidden="true" />
        <input
          type="range"
          min="0"
          max="200"
          step="1"
          value={shown}
          onChange={(event) => onChange(Number(event.target.value))}
          onWheel={(event) => {
            event.preventDefault();
            onChange(clamp(shown + (event.deltaY < 0 ? 1 : -1)));
          }}
          aria-label={label}
        />
        <output>{shown}%</output>
      </label>
    </div>
  );
}
function VerticalVolume({
  value,
  onChange,
  label,
  colorClass = "",
  level = 0,
  muted = false,
  icon = "speaker",
  onMute,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  colorClass?: string;
  level?: number;
  muted?: boolean;
  icon?: "speaker" | "mic" | "share";
  onMute?: () => void;
}) {
  const shown = muted ? 0 : Math.round(clamp(value));
  const liveLevel = Math.max(0, Math.min(1, Number(level) || 0));
  const meterLevel = muted
    ? 0
    : Math.min(1, liveLevel * (shown / 100));
  const Icon =
    icon === "mic"
      ? muted
        ? MicrophoneSlash
        : Microphone
      : icon === "share"
        ? Waveform
        : muted
          ? SpeakerSlash
          : SpeakerHigh;
  return (
    <div
      className={`vertical-volume ${colorClass}`}
      style={
        {
          "--volume-position": `${shown / 2}%`,
          "--volume-level": `${meterLevel * 100}%`,
        } as React.CSSProperties
      }
    >
      <output>{shown}%</output>
      <span className="vertical-volume-track">
        <span className="vertical-live-level" aria-hidden="true" />
        <span className="vertical-volume-thumb" aria-hidden="true" />
        <input
          type="range"
          min="0"
          max="200"
          step="1"
          value={shown}
          onChange={(event) => onChange(Number(event.target.value))}
          onWheel={(event) => {
            event.preventDefault();
            onChange(clamp(shown + (event.deltaY < 0 ? 1 : -1)));
          }}
          aria-label={label}
        />
      </span>
      {onMute ? (
        <button
          type="button"
          className={`vertical-mute ${muted ? "muted" : ""}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onMute();
          }}
          aria-label={muted ? `恢复${label}` : `静音${label}`}
          title={muted ? `恢复${label}` : `静音${label}`}
        >
          <Icon size={14} weight={muted ? "regular" : "fill"} />
        </button>
      ) : (
        <span className="vertical-volume-label">{label}</span>
      )}
    </div>
  );
}
function MemberMenu({
  member,
  x,
  y,
  onClose,
  onProfile,
  onRemark,
  onMute,
  onRemove,
  canModerate,
}: {
  member: RoomMember;
  x: number;
  y: number;
  onClose: () => void;
  onProfile: () => void;
  onRemark: () => void;
  onMute: () => void;
  onRemove: () => void;
  canModerate: boolean;
}) {
  const left = Math.max(8, Math.min(x, window.innerWidth - 232));
  const top = Math.max(8, Math.min(y, window.innerHeight - 244));
  return (
    <div
      className="member-context popover-card"
      style={{ position: "fixed", left, top, zIndex: 950 }}
      role="menu"
    >
      <header>
        <div>
          <b>{member.username}</b>
          <small>{member.platform === "mobile" ? "手机端" : "电脑端"}</small>
        </div>
        <button
          className="icon-btn"
          onClick={onClose}
          aria-label="关闭成员菜单"
        >
          <X size={16} />
        </button>
      </header>
      <button onClick={onProfile}>
        <UserCircle size={18} />
        查看资料
      </button>
      <button onClick={onRemark}>
        <Wrench size={18} />
        添加备注
      </button>
      {canModerate && (
        <button onClick={onMute}>
          <MicrophoneSlash size={18} />
          {member.isMuted ? "解除禁言" : "禁言"}
        </button>
      )}
      {canModerate && (
        <button className="danger-row" onClick={onRemove}>
          <PhoneDisconnect size={18} />
          移出房间
        </button>
      )}
    </div>
  );
}

function LocalScreenVideo({ stream }: { stream: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.srcObject !== stream) video.srcObject = stream;
    let disposed = false;
    void video.play().catch((error: unknown) => {
      if (
        !disposed &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        console.warn("[screen-preview] 本地共享预览播放失败", error);
    });

    return () => {
      disposed = true;
      video.pause();
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [stream]);

  return <video ref={videoRef} autoPlay muted playsInline />;
}

function RemoteScreenVideo({
  stream,
  controlling,
  onInput,
}: {
  stream: MediaStream;
  controlling: boolean;
  onInput: (input: RemoteControlInput) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastMove = useRef(0);
  const pressedKeys = useRef(new Set<string>());
  const pressedButtons = useRef(
    new Map<"left" | "right" | "middle", { x: number; y: number }>(),
  );
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch((error: unknown) => {
        // Changing a remote track while Chromium is starting playback can
        // legitimately abort the previous play request.
        if (!(error instanceof DOMException && error.name === "AbortError"))
          console.warn("[screen-preview] 远程共享预览播放失败", error);
      });
    }
  }, [stream]);
  const point = (event: { clientX: number; clientY: number }) => {
    const video = videoRef.current;
    if (!video) return null;
    return normalizedVideoPoint(
      event.clientX,
      event.clientY,
      video.getBoundingClientRect(),
      video.videoWidth,
      video.videoHeight,
    );
  };
  const rememberPoint = (mapped: { x: number; y: number } | null) => {
    if (!mapped) return null;
    lastPoint.current = mapped;
    pressedButtons.current.forEach((_, button) => {
      pressedButtons.current.set(button, mapped);
    });
    return mapped;
  };
  const release = useCallback(() => {
    pressedKeys.current.forEach((code) =>
      onInput({ type: "key", code, down: false }),
    );
    pressedButtons.current.forEach((mapped, button) =>
      onInput({ type: "button", button, down: false, ...mapped }),
    );
    pressedKeys.current.clear();
    pressedButtons.current.clear();
  }, [onInput]);
  useEffect(() => {
    if (!controlling) release();
    return release;
  }, [controlling, release]);
  return (
    <div
      className={`remote-video-surface ${controlling ? "controlling" : ""}`}
      tabIndex={controlling ? 0 : -1}
      onPointerMove={(event) => {
        if (!controlling) return;
        const p = rememberPoint(point(event));
        if (event.timeStamp - lastMove.current < 16) return;
        if (p) {
          lastMove.current = event.timeStamp;
          onInput({ type: "pointer", ...p });
        }
      }}
      onPointerDown={(event) => {
        if (!controlling) return;
        const button =
          event.button === 0
            ? "left"
            : event.button === 1
              ? "middle"
              : event.button === 2
                ? "right"
                : null;
        const p = rememberPoint(point(event));
        if (!button || !p) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        pressedButtons.current.set(button, p);
        onInput({ type: "button", button, down: true, ...p });
      }}
      onPointerUp={(event) => {
        if (!controlling) return;
        const button =
          event.button === 0
            ? "left"
            : event.button === 1
              ? "middle"
            : event.button === 2
                ? "right"
                : null;
        const p = rememberPoint(point(event));
        if (!button) return;
        const releasePoint =
          p ??
          pressedButtons.current.get(button) ??
          lastPoint.current;
        if (!releasePoint) return;
        event.preventDefault();
        pressedButtons.current.delete(button);
        onInput({ type: "button", button, down: false, ...releasePoint });
      }}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onWheel={(event) => {
        if (!controlling) return;
        const p = point(event);
        if (!p) return;
        event.preventDefault();
        onInput({
          type: "wheel",
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          ...p,
        });
      }}
      onKeyDown={(event) => {
        if (!controlling || event.repeat) return;
        event.preventDefault();
        event.stopPropagation();
        pressedKeys.current.add(event.code);
        onInput({ type: "key", code: event.code, down: true });
      }}
      onKeyUp={(event) => {
        if (!controlling) return;
        event.preventDefault();
        event.stopPropagation();
        pressedKeys.current.delete(event.code);
        onInput({ type: "key", code: event.code, down: false });
      }}
      onBlur={release}
      onContextMenu={(event) => controlling && event.preventDefault()}
    >
      <video ref={videoRef} autoPlay muted playsInline />
      <span className="remote-control-frame" />
    </div>
  );
}

function sameMessageDay(firstTimestamp: number, secondTimestamp: number) {
  const first = new Date(firstTimestamp);
  const second = new Date(secondTimestamp);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

function formatMessageDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(timestamp));
}

function isMessageListNearBottom(element: HTMLElement | null) {
  if (!element) return true;
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
}

function mergeChatMessages(current: Message[], incoming: Message[]) {
  const merged = new Map(current.map((message) => [message.id, message]));
  incoming.forEach((message) => merged.set(message.id, message));
  return [...merged.values()].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
}

function ChatImagePreview({
  src,
  onOpen,
  onContextMenu,
}: {
  src: string;
  onOpen: () => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const [width, setWidth] = useState(320);
  return (
    <button
      type="button"
      className="image-preview-button"
      style={{ width }}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      aria-label="放大查看聊天图片"
    >
      <img
        src={src}
        alt="聊天图片"
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          if (naturalWidth && naturalHeight)
            setWidth(Math.min(320, naturalWidth, 280 * naturalWidth / naturalHeight));
        }}
      />
    </button>
  );
}

function ChatPanelV2({
  messages,
  profile,
  serverURL,
  input,
  setInput,
  onSend,
  onSendImages,
  compact,
  fontSize,
  onFontSizeChange,
  hasOlderMessages,
  loadingOlderMessages,
  historyLoadVersion,
  onLoadOlderMessages,
}: {
  messages: Message[];
  profile: UserProfile;
  serverURL: string;
  input: string;
  setInput: (value: string) => void;
  onSend: () => void;
  onSendImages: (files: FileList | File[] | null) => void;
  compact: boolean;
  unread: number;
  fontSize: ChatFontSize;
  onFontSizeChange: (value: ChatFontSize) => void;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  historyLoadVersion: number;
  onLoadOlderMessages: () => void;
}) {
  const imageRef = useRef<HTMLInputElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const imageMenuRef = useRef<HTMLDivElement>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const copyNoticeTimerRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const previousMessageCountRef = useRef(messages.length);
  const firstMessageRenderRef = useRef(true);
  const stickToBottomRef = useRef(true);
  const historyScrollAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const handledHistoryLoadVersionRef = useRef(historyLoadVersion);
  const olderRequestPendingRef = useRef(false);
  const [pendingImages, setPendingImages] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [fontMenuOpen, setFontMenuOpen] = useState(false);
  const fontHoverTimerRef = useRef<number | null>(null);
  const openFontMenuOnHover = () => {
    if (fontHoverTimerRef.current !== null)
      window.clearTimeout(fontHoverTimerRef.current);
    setFontMenuOpen(true);
  };
  const closeFontMenuOnHover = () => {
    if (fontHoverTimerRef.current !== null)
      window.clearTimeout(fontHoverTimerRef.current);
    fontHoverTimerRef.current = window.setTimeout(() => {
      setFontMenuOpen(false);
      fontHoverTimerRef.current = null;
    }, 260);
  };
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [imageContextMenu, setImageContextMenu] = useState<{
    src: string;
    x: number;
    y: number;
  } | null>(null);
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const list = messageListRef.current;
    if (!list) return;
    stickToBottomRef.current = true;
    if (programmaticScrollTimerRef.current !== null)
      window.clearTimeout(programmaticScrollTimerRef.current);
    programmaticScrollRef.current = behavior === "smooth";
    const initialHeight = list.scrollHeight;
    if (behavior === "smooth")
      list.scrollTo({ top: initialHeight, behavior: "smooth" });
    else list.scrollTop = initialHeight;
    requestAnimationFrame(() => {
      const current = messageListRef.current;
      if (!current) return;
      if (current.scrollHeight !== initialHeight) {
        if (behavior === "smooth")
          current.scrollTo({ top: current.scrollHeight, behavior: "smooth" });
        else current.scrollTop = current.scrollHeight;
      }
      requestAnimationFrame(() => {
        if (behavior === "auto") {
          current.scrollTop = current.scrollHeight;
          programmaticScrollRef.current = false;
        }
      });
    });
    if (behavior === "smooth") {
      programmaticScrollTimerRef.current = window.setTimeout(() => {
        programmaticScrollRef.current = false;
        programmaticScrollTimerRef.current = null;
      }, 900);
    }
  }, []);
  useLayoutEffect(() => {
    if (
      historyLoadVersion === handledHistoryLoadVersionRef.current ||
      !historyScrollAnchorRef.current
    )
      return;
    const list = messageListRef.current;
    const anchor = historyScrollAnchorRef.current;
    if (list) {
      list.scrollTop =
        anchor.scrollTop + (list.scrollHeight - anchor.scrollHeight);
    }
    historyScrollAnchorRef.current = null;
  }, [historyLoadVersion, messages.length]);
  useEffect(() => {
    const previousCount = previousMessageCountRef.current;
    const addedCount = messages.length - previousCount;
    previousMessageCountRef.current = messages.length;
    const isHistoryLoad =
      historyLoadVersion !== handledHistoryLoadVersionRef.current;
    handledHistoryLoadVersionRef.current = historyLoadVersion;
    if (isHistoryLoad) {
      setNewMessageCount(0);
      return;
    }
    if (firstMessageRenderRef.current) {
      firstMessageRenderRef.current = false;
      setNewMessageCount(0);
      scrollToBottom("auto");
      return;
    }
    if (addedCount <= 0) return;
    const list = messageListRef.current;
    if (stickToBottomRef.current || isMessageListNearBottom(list)) {
      setNewMessageCount(0);
      scrollToBottom("smooth");
    } else {
      setNewMessageCount((current) => current + addedCount);
    }
  }, [historyLoadVersion, messages.length, scrollToBottom]);
  useEffect(() => {
    if (!loadingOlderMessages) olderRequestPendingRef.current = false;
  }, [loadingOlderMessages]);
  useEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    const syncBottom = () => {
      if (stickToBottomRef.current) list.scrollTop = list.scrollHeight;
    };
    syncBottom();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncBottom);
    Array.from(list.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [messages.length]);
  useEffect(() => {
    return () => {
      if (fontHoverTimerRef.current !== null)
        window.clearTimeout(fontHoverTimerRef.current);
      if (copyResetTimerRef.current !== null)
        window.clearTimeout(copyResetTimerRef.current);
      if (copyNoticeTimerRef.current !== null)
        window.clearTimeout(copyNoticeTimerRef.current);
      if (programmaticScrollTimerRef.current !== null)
        window.clearTimeout(programmaticScrollTimerRef.current);
    };
  }, []);
  useEffect(() => {
    if (!fontMenuOpen && !imageContextMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        fontMenuOpen &&
        (!(target instanceof Element) ||
          !target.closest(".chat-font-picker"))
      ) {
        setFontMenuOpen(false);
      }
      if (
        imageContextMenu &&
        (!(target instanceof Node) || !imageMenuRef.current?.contains(target))
      ) {
        setImageContextMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setFontMenuOpen(false);
      setImageContextMenu(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [fontMenuOpen, imageContextMenu]);
  const imageUrl = (value: string) =>
    /^https?:\/\//i.test(value) || value.startsWith("data:")
      ? value
      : `${serverURL.replace(/\/$/, "")}${value.startsWith("/") ? value : `/${value}`}`;
  const showCopyNotice = (notice: string) => {
    setCopyNotice(notice);
    if (copyNoticeTimerRef.current !== null)
      window.clearTimeout(copyNoticeTimerRef.current);
    copyNoticeTimerRef.current = window.setTimeout(
      () => setCopyNotice(null),
      1600,
    );
  };
  const copyMessage = async (messageId: string, content: string) => {
    try {
      await copyTextToClipboard(content);
      setCopiedMessageId(messageId);
      showCopyNotice("已复制消息");
      if (copyResetTimerRef.current !== null)
        window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(
        () => setCopiedMessageId((current) => (current === messageId ? null : current)),
        1600,
      );
    } catch (error) {
      console.warn("[chat-copy] 文本复制失败", error);
      showCopyNotice("复制失败，请重试");
    }
  };
  const copyImage = async (src: string) => {
    try {
      await copyImageToClipboard(src);
      showCopyNotice("图片已复制");
    } catch (error) {
      console.warn("[chat-copy] 图片复制失败", error);
      showCopyNotice("复制图片失败，请重试");
    }
  };
  const openImageContextMenu = (
    event: MouseEvent<HTMLButtonElement>,
    src: string,
  ) => {
    event.preventDefault();
    const menuWidth = 148;
    const menuHeight = 48;
    setImageContextMenu({
      src,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    });
  };
  const stageImages = (files: FileList | File[]) => {
    setDragActive(false);
    const images = collectChatImageFiles(files);
    if (!images.length) return;
    if (images.length > CHAT_IMAGE_MAX_BATCH) {
      window.alert(`一次最多发送 ${CHAT_IMAGE_MAX_BATCH} 张图片。`);
      return;
    }
    setPendingImages(images);
  };
  const confirmImages = () => {
    if (!pendingImages.length) return;
    const images = pendingImages;
    setPendingImages([]);
    onSendImages(images);
  };
  return (
    <aside
      className={`chat-panel chat-font-${fontSize} ${compact ? "compact" : ""} ${dragActive ? "drag-active" : ""}`}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!nextTarget || !event.currentTarget.contains(nextTarget))
          setDragActive(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        stageImages(event.dataTransfer.files);
      }}
    >
      {!compact && (
        <header>
          <div className="chat-header-actions chat-header-actions-left">
            <div
              className="chat-font-picker"
              onMouseEnter={openFontMenuOnHover}
              onMouseLeave={closeFontMenuOnHover}
              onFocus={openFontMenuOnHover}
            >
              <button
                type="button"
                className={`icon-btn chat-font-button ${fontMenuOpen ? "active" : ""}`}
                onClick={() => setFontMenuOpen((value) => !value)}
                aria-label="调整聊天字号"
                aria-expanded={fontMenuOpen}
                title="调整聊天字号"
              >
                <TextAa size={18} />
              </button>
              {fontMenuOpen && (
                <ChatFontMenu
                  fontSize={fontSize}
                  onFontSizeChange={onFontSizeChange}
                  onClose={() => setFontMenuOpen(false)}
                  onMouseEnter={openFontMenuOnHover}
                  onMouseLeave={closeFontMenuOnHover}
                />
              )}
            </div>
          </div>
        </header>
      )}
      {copyNotice && (
        <div className="chat-copy-notice" role="status">
          {copyNotice}
        </div>
      )}
      <div
        ref={messageListRef}
        className="message-list"
        onScroll={(event) => {
          const list = event.currentTarget;
          const nearBottom = isMessageListNearBottom(list);
          if (programmaticScrollRef.current && !nearBottom) return;
          if (nearBottom) {
            stickToBottomRef.current = true;
            setNewMessageCount(0);
            return;
          }
          stickToBottomRef.current = false;
          if (
            list.scrollTop <= 36 &&
            hasOlderMessages &&
            !loadingOlderMessages &&
            !olderRequestPendingRef.current
          ) {
            olderRequestPendingRef.current = true;
            historyScrollAnchorRef.current = {
              scrollHeight: list.scrollHeight,
              scrollTop: list.scrollTop,
            };
            onLoadOlderMessages();
          }
        }}
      >
        {messages.length === 0 && (
          <div className="chat-empty">
            <span className="chat-empty-icon">
              <ChatCircleDots size={32} weight="fill" />
            </span>
            <p>这里还是空的，发条消息吧。</p>
          </div>
        )}
        {messages.map((message, index) => {
          const showDate =
            index === 0 ||
            !sameMessageDay(messages[index - 1].timestamp, message.timestamp);
          return (
            <Fragment key={message.id}>
              {showDate && (
                <div className="message-date-divider" role="separator">
                  <span>{formatMessageDate(message.timestamp)}</span>
                </div>
              )}
              {message.type === "system" || message.type === "soundpack" ? (
                <div className="message-system">
                  <Radio size={14} />
                  {message.content}
                </div>
              ) : (
                <article
                  className={`message-row ${message.author === profile.username ? "mine" : ""} ${message.type === "image" ? "image-message" : ""}`}
                >
                  <Avatar
                    username={
                      message.author === profile.username
                        ? profile.username
                        : message.author
                    }
                    avatarUrl={
                      message.author === profile.username
                        ? profile.avatarUrl
                        : undefined
                    }
                    size="sm"
                    className="message-avatar"
                  />
                  <div className="message-copy">
                    <div className="message-meta">
                      <b>
                        {message.author === profile.username
                          ? "你"
                          : message.author}
                      </b>
                      <time>
                        {new Date(message.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                    <div
                      className={`message-bubble ${message.type === "image" ? "image" : ""}`}
                    >
                      {message.type === "image" ? (
                        <ChatImagePreview
                          src={imageUrl(message.content)}
                          onOpen={() =>
                            setLightboxImage(imageUrl(message.content))
                          }
                          onContextMenu={(event) =>
                            openImageContextMenu(
                              event,
                              imageUrl(message.content),
                            )
                          }
                        />
                      ) : (
                        <>
                          <span className="message-text-content">
                            {parseChatText(message.content).map(
                              (part, partIndex) =>
                                part.kind === "link" && part.href ? (
                                  <a
                                    key={partIndex}
                                    href={part.href}
                                    onClick={(event) => {
                                      event.preventDefault();
                                      window.coveShell
                                        ? void window.coveShell.openExternal(
                                            part.href!,
                                          )
                                        : window.open(
                                            part.href,
                                            "_blank",
                                            "noopener,noreferrer",
                                          );
                                    }}
                                  >
                                    {part.text}
                                  </a>
                                ) : (
                                  <span key={partIndex}>{part.text}</span>
                                ),
                            )}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  {message.type !== "image" && (
                    <button
                      type="button"
                      className="message-copy-button"
                      onClick={() =>
                        void copyMessage(message.id, message.content)
                      }
                      aria-label={
                        copiedMessageId === message.id
                          ? "已复制消息"
                          : "复制消息"
                      }
                      title={
                        copiedMessageId === message.id
                          ? "已复制"
                          : "复制消息"
                      }
                    >
                      {copiedMessageId === message.id ? (
                        <Check size={14} weight="bold" />
                      ) : (
                        <Copy size={14} />
                      )}
                    </button>
                  )}
                </article>
              )}
            </Fragment>
          );
        })}
      </div>
      {newMessageCount > 0 && (
        <button
          type="button"
          className="chat-new-message-notice"
          onClick={() => {
            setNewMessageCount(0);
            scrollToBottom("smooth");
          }}
        >
          <ArrowDown size={14} weight="bold" />
          <span>
            {newMessageCount} 条新消息 · 回到底部
          </span>
        </button>
      )}
      <div className="chat-composer-wrap">
        {pendingImages.length > 0 && (
          <div className="image-send-confirm popover-card" role="dialog">
            <div className="image-send-confirm-copy">
              <ImageSquare size={17} />
              <span>已选择 {pendingImages.length} 张图片，确认发送？</span>
            </div>
            <div className="image-send-confirm-actions">
              <button type="button" onClick={() => setPendingImages([])}>
                取消
              </button>
              <button type="button" className="primary" onClick={confirmImages}>
                发送
              </button>
            </div>
          </div>
        )}
        <div className="chat-composer">
          <input
            ref={imageRef}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            onChange={(event) => {
              onSendImages(event.target.files);
              event.currentTarget.value = "";
            }}
          />
          <button
            className="icon-btn"
            onClick={() => imageRef.current?.click()}
            aria-label="添加图片"
          >
            <ImageSquare size={19} />
          </button>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onPaste={(event) => {
              const pastedImages = Array.from(event.clipboardData.items)
                .filter((item) => item.kind === "file")
                .map((item) => item.getAsFile())
                .filter((file): file is File => Boolean(file));
              if (!pastedImages.length) return;
              event.preventDefault();
              stageImages(pastedImages);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
            placeholder="发送消息"
            rows={1}
          />
          <button
            className="icon-btn"
            onClick={onSend}
            disabled={!input.trim()}
            aria-label="发送消息"
          >
            <PaperPlaneTilt size={20} weight="fill" />
          </button>
        </div>
      </div>
      {imageContextMenu && (
        <div
          ref={imageMenuRef}
          className="chat-image-context-menu"
          style={{ left: imageContextMenu.x, top: imageContextMenu.y }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const src = imageContextMenu.src;
              setImageContextMenu(null);
              void copyImage(src);
            }}
          >
            <Clipboard size={16} />
            <span>复制图片</span>
          </button>
        </div>
      )}
      {lightboxImage && (
        <div
          className="image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="查看聊天图片"
          onClick={() => setLightboxImage(null)}
        >
          <button
            type="button"
            className="image-lightbox-close icon-btn"
            onClick={() => setLightboxImage(null)}
            aria-label="关闭图片预览"
          >
            <X size={20} />
          </button>
          <img
            src={lightboxImage}
            alt="放大的聊天图片"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </aside>
  );
}

export function RoomAppearanceSettings({
  room,
  onSave,
  onClose,
  onDelete,
  theme = "light",
}: {
  room: RoomWithAppearance;
  onSave: (changes: Record<string, unknown>) => void;
  onClose: () => void;
  onDelete: () => void;
  theme?: AppTheme;
}) {
  const [name, setName] = useState(room.name);
  const [backgroundMode, setBackgroundMode] = useState<AppTheme>(theme);
  const [lightTop, setLightTop] = useState(
    roomColor(room.backgroundTop, ROOM_LIGHT_TOP),
  );
  const [lightBottom, setLightBottom] = useState(
    roomColor(room.backgroundBottom, ROOM_LIGHT_BOTTOM),
  );
  const [darkTop, setDarkTop] = useState(
    roomColor(room.backgroundTopDark, ROOM_DARK_TOP),
  );
  const [darkBottom, setDarkBottom] = useState(
    roomColor(room.backgroundBottomDark, ROOM_DARK_BOTTOM),
  );
  const top = backgroundMode === "dark" ? darkTop : lightTop;
  const bottom = backgroundMode === "dark" ? darkBottom : lightBottom;
  const setTop = backgroundMode === "dark" ? setDarkTop : setLightTop;
  const setBottom = backgroundMode === "dark" ? setDarkBottom : setLightBottom;
  const [avatar, setAvatar] = useState(room.avatarUrl ?? null);
  const [maxMembers, setMaxMembers] = useState(
    room.maxMembers ? String(room.maxMembers) : "unlimited",
  );
  const [passwordAction, setPasswordAction] = useState<
    "keep" | "set" | "clear"
  >("keep");
  const [password, setPassword] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="modal-scrim">
      <section className="settings-modal room-settings">
        <header>
          <div>
            <small>仅房主可调整</small>
            <h2>房间设置</h2>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label="关闭房间设置"
          >
            <X size={20} />
          </button>
        </header>
        <div className="settings-scroll">
          <section className="settings-section">
            <h3>房间资料</h3>
            <div className="room-avatar-editor">
              <span className="room-avatar large">
                {avatar ? (
                  <img src={avatar} alt="房间头像" />
                ) : (
                  <DoorOpen size={22} weight="duotone" />
                )}
                <span className="voice-count">{room.count ?? 0}</span>
              </span>
              <div>
                <b>房间头像</b>
                <p>没有设置时使用默认房间图标。</p>
                <button onClick={() => fileRef.current?.click()}>
                  <UploadSimple size={17} />
                  选择图片
                </button>
                <input
                  ref={fileRef}
                  hidden
                  type="file"
                  accept="image/*"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      try {
                        setAvatar(await prepareAvatar(file));
                      } catch {
                        window.alert("房间头像处理失败");
                      }
                    }
                  }}
                />
              </div>
            </div>
            <label className="field">
              <span>频道名称</span>
              <input
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className="two-fields">
              <label className="field">
                <span>人数上限</span>
                <select
                  value={maxMembers}
                  onChange={(event) => setMaxMembers(event.target.value)}
                >
                  <option value="unlimited">不限人数</option>
                  <option value="5">5 人</option>
                  <option value="10">10 人</option>
                  <option value="20">20 人</option>
                  <option value="50">50 人</option>
                </select>
              </label>
              <label className="field">
                <span>密码操作</span>
                <select
                  value={passwordAction}
                  onChange={(event) =>
                    setPasswordAction(
                      event.target.value as typeof passwordAction,
                    )
                  }
                >
                  <option value="keep">保持不变</option>
                  <option value="set">设置新密码</option>
                  <option value="clear">取消密码</option>
                </select>
              </label>
            </div>
            {passwordAction === "set" && (
              <label className="field">
                <span>新密码</span>
                <input
                  type="password"
                  value={password}
                  maxLength={128}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="输入新密码"
                />
              </label>
            )}
          </section>
          <section className="settings-section">
            <h3>房间背景</h3>
            <p className="section-note">
              两套主题背景分别保存，切换主题时不会覆盖另一套颜色。
            </p>
            <div className="theme-segmented-control" role="tablist" aria-label="编辑哪套主题背景">
              <button
                type="button"
                role="tab"
                aria-selected={backgroundMode === "light"}
                className={backgroundMode === "light" ? "active" : ""}
                onClick={() => setBackgroundMode("light")}
              >
                浅色模式
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={backgroundMode === "dark"}
                className={backgroundMode === "dark" ? "active" : ""}
                onClick={() => setBackgroundMode("dark")}
              >
                深色模式
              </button>
            </div>
            <div className="gradient-editor">
              <div
                className="gradient-capsule"
                style={{
                  background: `linear-gradient(90deg, ${top}, ${bottom})`,
                }}
              >
                <label className="color-stop left">
                  <input
                    type="color"
                    value={top}
                    onChange={(event) =>
                      setTop(event.target.value.toUpperCase())
                    }
                    aria-label="房间顶部颜色"
                  />
                </label>
                <label className="color-stop right">
                  <input
                    type="color"
                    value={bottom}
                    onChange={(event) =>
                      setBottom(event.target.value.toUpperCase())
                    }
                    aria-label="房间底部颜色"
                  />
                </label>
              </div>
              <div className="color-code-row">
                <label>
                  <span>顶部颜色</span>
                  <input
                    value={top}
                    onChange={(event) =>
                      setTop(event.target.value.toUpperCase())
                    }
                  />
                </label>
                <label>
                  <span>底部颜色</span>
                  <input
                    value={bottom}
                    onChange={(event) =>
                      setBottom(event.target.value.toUpperCase())
                    }
                  />
                </label>
              </div>
            </div>
          </section>
          <section className="danger-zone">
            <div>
              <b>删除频道</b>
              <p>此操作无法撤销。</p>
            </div>
            <button type="button" onClick={() => setConfirmingDelete(true)}>
              <Trash size={17} />
              删除频道
            </button>
          </section>
          {confirmingDelete && (
            <div
              className="room-delete-confirm-scrim modal-scrim"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget)
                  setConfirmingDelete(false);
              }}
            >
              <section
                className="room-delete-confirm popover-card"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="room-delete-confirm-title"
                onMouseDown={(event) => event.stopPropagation()}
              >
                <span className="room-delete-confirm-icon">
                  <Trash size={21} />
                </span>
                <h3 id="room-delete-confirm-title">删除频道</h3>
                <p>确定删除“{room.name}”吗？此操作无法撤销。</p>
                <div className="room-delete-confirm-actions">
                  <button
                    type="button"
                    className="plain-action"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="danger-confirm"
                    onClick={() => {
                      setConfirmingDelete(false);
                      onDelete();
                    }}
                  >
                    <Trash size={16} />
                    删除频道
                  </button>
                </div>
              </section>
            </div>
          )}
          <button
            className="primary-wide"
            onClick={() => {
              onSave({
                name: name.trim() || room.name,
                avatarUrl: avatar,
                backgroundTop: top,
                backgroundBottom: bottom,
                backgroundTopDark: darkTop,
                backgroundBottomDark: darkBottom,
                maxMembers:
                  maxMembers === "unlimited" ? null : Number(maxMembers),
                password:
                  passwordAction === "set"
                    ? password
                    : passwordAction === "clear"
                      ? null
                      : undefined,
              });
            }}
          >
            保存房间设置
          </button>
        </div>
      </section>
    </div>
  );
}

export function GlobalSettingsV2({
  profile,
  accountId,
  onProfileChange,
  onLogout,
  inputVolume,
  outputVolume,
  setInputVolume,
  setOutputVolume,
  rtc,
  onClose,
  initialPage = "audio",
  theme,
  onThemeChange,
}: {
  profile: UserProfile;
  accountId: string;
  onProfileChange: (profile: UserProfile) => void;
  onLogout: () => void;
  inputVolume: number;
  outputVolume: number;
  setInputVolume: (value: number) => void;
  setOutputVolume: (value: number) => void;
  rtc: ReturnType<typeof useWebRTC>;
  onClose: () => void;
  initialPage?: GlobalSettingsPage;
  theme: AppTheme;
  onThemeChange: (theme: AppTheme) => void;
}) {
  const [page, setPage] = useState<GlobalSettingsPage>(initialPage);
  const [aboutQuote, setAboutQuote] = useState<AboutQuote>(() =>
    pickAboutQuote(),
  );
  const [name, setName] = useState(profile.username);
  const [avatar, setAvatar] = useState(profile.avatarUrl);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [draftAudioInputId, setDraftAudioInputId] = useState(
    rtc.selectedAudioInputId,
  );
  const [draftAudioOutputId, setDraftAudioOutputId] = useState(
    rtc.selectedAudioOutputId,
  );
  const [audioActionBusy, setAudioActionBusy] = useState(false);
  const audioDeviceSelectionChanged =
    draftAudioInputId !== rtc.selectedAudioInputId ||
    draftAudioOutputId !== rtc.selectedAudioOutputId;

  useEffect(() => {
    setPage(initialPage);
  }, [initialPage]);

  useEffect(() => {
    if (page !== "about") return;
    setAboutQuote((previous) => pickAboutQuote(previous));
  }, [page]);

  useEffect(() => {
    setDraftAudioInputId(rtc.selectedAudioInputId);
  }, [rtc.selectedAudioInputId]);
  useEffect(() => {
    setDraftAudioOutputId(rtc.selectedAudioOutputId);
  }, [rtc.selectedAudioOutputId]);

  const handleAudioDeviceAction = async () => {
    if (
      audioActionBusy ||
      rtc.audioDevicesRefreshing ||
      rtc.audioInputSwitching
    )
      return;

    setAudioActionBusy(true);
    try {
      const inputChanged = draftAudioInputId !== rtc.selectedAudioInputId;
      const outputChanged = draftAudioOutputId !== rtc.selectedAudioOutputId;
      if (inputChanged) await rtc.selectAudioInput(draftAudioInputId);
      if (outputChanged) await rtc.selectAudioOutput(draftAudioOutputId);

      if (!inputChanged && !outputChanged) {
        if (rtc.inVoice) await rtc.refreshAudioConnection();
        else await rtc.refreshAudioDevices(false);
      }
    } finally {
      setAudioActionBusy(false);
    }
  };
  const nav: [typeof page, React.ReactNode, string][] = [
    ["audio", <Headphones size={19} />, "音频设备"],
    ["account", <UserCircle size={19} />, "账号与服务器"],
    ["update", <DownloadSimple size={19} />, "检查更新"],
    ["about", <Info size={19} />, "关于应用"],
  ];
  return (
    <div className="modal-scrim">
      <section className="settings-modal global-settings">
        <aside>
          <h2>设置</h2>
          {nav.map(([id, icon, label]) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              onClick={() => setPage(id)}
            >
              {icon}
              {label}
            </button>
          ))}
          <div className="settings-theme-control">
            <span>
              {theme === "dark" ? <Moon size={18} /> : <Sun size={18} />}
              <b>深色模式</b>
            </span>
            <button
              type="button"
              className={`theme-switch ${theme === "dark" ? "active" : ""}`}
              role="switch"
              aria-checked={theme === "dark"}
              aria-label="切换深色模式"
              onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}
            >
              <i />
            </button>
          </div>
        </aside>
        <main>
          <header>
            <div>
              <small>Cove 偏好设置</small>
              <h2>{nav.find(([id]) => id === page)?.[2]}</h2>
            </div>
            <button
              className="icon-btn"
              onClick={onClose}
              aria-label="关闭设置"
            >
              <X size={20} />
            </button>
          </header>
          {page === "audio" && (
            <div className="settings-page">
              <label className="field">
                <span>默认输入设备</span>
                <select
                  value={draftAudioInputId}
                  disabled={
                    audioActionBusy ||
                    rtc.audioDevicesRefreshing ||
                    rtc.audioInputSwitching
                  }
                  onChange={(event) => setDraftAudioInputId(event.target.value)}
                >
                  <option value="default">系统默认麦克风</option>
                  {draftAudioInputId !== "default" &&
                    !rtc.audioInputDevices.some(
                      (device) => device.deviceId === draftAudioInputId,
                    ) && (
                      <option value={draftAudioInputId}>
                        此前选择的麦克风（当前不可用）
                      </option>
                    )}
                  {rtc.audioInputDevices.map((device) => (
                    <option value={device.deviceId} key={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>
              <VolumeControl
                value={inputVolume}
                onChange={setInputVolume}
                icon="mic"
                label="默认输入音量"
              />
              <label className="field">
                <span>默认输出设备</span>
                <select
                  value={draftAudioOutputId}
                  disabled={audioActionBusy || rtc.audioDevicesRefreshing}
                  onChange={(event) =>
                    setDraftAudioOutputId(event.target.value)
                  }
                >
                  <option value="default">系统默认扬声器</option>
                  {draftAudioOutputId !== "default" &&
                    !rtc.audioOutputDevices.some(
                      (device) => device.deviceId === draftAudioOutputId,
                    ) && (
                      <option value={draftAudioOutputId}>
                        此前选择的扬声器（当前不可用）
                      </option>
                    )}
                  {rtc.audioOutputDevices.map((device) => (
                    <option value={device.deviceId} key={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>
              <VolumeControl
                value={outputVolume}
                onChange={setOutputVolume}
                label="默认输出音量"
              />
              <div className="audio-device-actions">
                <button
                  className="plain-action"
                  disabled={audioActionBusy || rtc.audioDevicesRefreshing}
                  onClick={() => void rtc.refreshAudioDevices(true)}
                >
                  {rtc.audioDevicesRefreshing ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <Radio size={17} />
                  )}
                  {rtc.audioDevicesRefreshing ? "检测中" : "检测设备"}
                </button>
                <button
                  className="plain-action"
                  disabled={
                    audioActionBusy ||
                    rtc.audioDevicesRefreshing ||
                    rtc.audioInputSwitching
                  }
                  onClick={() => void handleAudioDeviceAction()}
                >
                  {audioActionBusy || rtc.audioInputSwitching ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <ArrowClockwise size={17} />
                  )}
                  {audioActionBusy || rtc.audioInputSwitching
                    ? "处理中"
                    : audioDeviceSelectionChanged
                      ? "更改"
                      : "刷新"}
                </button>
              </div>
              <p className="audio-device-action-hint">
                {audioDeviceSelectionChanged
                  ? "设备选择已暂存，点击“更改”后应用。"
                  : rtc.inVoice
                    ? "刷新会重新建立当前音频连接，不会结束屏幕共享。"
                    : "未加入语音时，刷新会重新检测当前设备状态。"}
              </p>
              {rtc.audioDeviceError && (
                <p className="field-error">{rtc.audioDeviceError}</p>
              )}
            </div>
          )}
          {page === "account" && (
            <div className="settings-page">
              <section className="profile-editor">
                <span className="profile-avatar-preview">
                  {avatar ? (
                    <img src={avatar} alt="个人头像" />
                  ) : (
                    (name[0] ?? "你")
                  )}
                </span>
                <div>
                  <label className="profile-inline-name field">
                    <span>昵称</span>
                    <input
                      value={name}
                      maxLength={64}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <div className="profile-avatar-actions">
                    <button onClick={() => uploadRef.current?.click()}>
                      <UploadSimple size={16} />
                      选择图片
                    </button>
                    {avatar && (
                      <button
                        className="subtle-danger"
                        onClick={() => setAvatar(null)}
                      >
                        <Trash size={16} />
                        移除
                      </button>
                    )}
                  </div>
                  <input
                    ref={uploadRef}
                    hidden
                    type="file"
                    accept="image/*"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        try {
                          setAvatar(await prepareAvatar(file));
                        } catch {
                          window.alert("头像处理失败");
                        }
                      }
                    }}
                  />
                </div>
              </section>
              <button
                className="primary-wide"
                onClick={() =>
                  name.trim() &&
                  onProfileChange({
                    username: name.trim().slice(0, 64),
                    avatarUrl: avatar,
                  })
                }
              >
                <Check size={17} />
                保存个人资料
              </button>
              <label className="field">
                <span>账号</span>
                <input
                  value={accountId ? `#${accountId.replace(/^#/, "")}` : "#未知"}
                  readOnly
                />
              </label>
              <label className="field">
                <span>服务器地址</span>
                <input
                  value={window.localStorage.getItem("cove_server_url") ?? ""}
                  readOnly
                />
              </label>
              <div className="account-danger-zone">
                <button className="logout-wide" onClick={onLogout}>
                  <DoorOpen size={17} />
                  退出登录
                </button>
              </div>
            </div>
          )}
          {page === "update" && (
            <div className="settings-page update-settings-page">
              <UpdateCenter embedded />
            </div>
          )}
          {page === "about" && (
            <div className="empty-settings about-settings">
              <div className="about-settings-main">
                <img
                  className="about-app-icon"
                  src="/assets/cove-icon.png"
                  alt="Cove"
                />
                <h3>Cove</h3>
                <p>连接朋友的语音与屏幕。</p>
                <small>桌面客户端 · v{packageInfo.version}</small>
                <nav className="about-links" aria-label="Cove 页面链接">
                  <a
                    href="https://github.com/LumineTraveller/Cove"
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={(event) =>
                      openExternalLink(
                        event,
                        "https://github.com/LumineTraveller/Cove",
                      )
                    }
                  >
                    GitHub
                  </a>
                  <a
                    href="https://gitee.com/LumineTraveller/Cove"
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={(event) =>
                      openExternalLink(
                        event,
                        "https://gitee.com/LumineTraveller/Cove",
                      )
                    }
                  >
                    Gitee
                  </a>
                  <a
                    href="https://download.cove-cove.space"
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={(event) =>
                      openExternalLink(
                        event,
                        "https://download.cove-cove.space",
                      )
                    }
                  >
                    下载站
                  </a>
                </nav>
              </div>
              <small className="about-quote">
                “{aboutQuote.text}”
              </small>
            </div>
          )}
        </main>
      </section>
    </div>
  );
}

export function NavigationRailV2({
  rooms,
  activeRoom,
  profileName,
  onRoom,
  expanded,
  setExpanded,
  onSettings,
  onRoomSettings,
  onCreate,
  showCollapse = true,
  className = "",
}: {
  rooms: RoomWithAppearance[];
  activeRoom: string;
  profileName: string;
  onRoom: (id: string) => void;
  expanded: boolean;
  setExpanded: (value: boolean) => void;
  onSettings: () => void;
  onRoomSettings: (room: RoomWithAppearance) => void;
  onCreate: () => void;
  showCollapse?: boolean;
  className?: string;
}) {
  return (
    <aside className={`navigation-rail ${expanded ? "expanded" : "narrow"} ${className}`.trim()}>
      <div className="nav-brand">
        <button
          className={`logo-swap ${expanded ? "expanded" : "narrow"}`}
          onClick={() => setExpanded(true)}
          aria-label="展开频道栏"
          title="展开频道栏"
        >
          <img
            className="app-mark-image"
            src="/assets/cove-icon.png"
            alt="Cove"
          />
          {!expanded && (
            <span className="expand-mark" aria-hidden="true">
              <ArrowRight size={22} />
            </span>
          )}
        </button>
        {expanded && <span className="brand-name">Cove</span>}
        {expanded && showCollapse && (
          <button
            className="icon-btn"
            onClick={() => setExpanded(false)}
            aria-label="收回频道栏"
          >
            <CaretLeft size={20} />
          </button>
        )}
      </div>
      <div className="room-nav-list">
        {rooms.map((room) => (
          <div
            className={`room-nav-item ${room.id === activeRoom ? "active" : ""}`}
            key={room.id}
            data-room-name={room.name}
          >
            <button
              className="room-switch"
              onClick={() => onRoom(room.id)}
              onContextMenu={(event) => {
                if (!(room.isOwner ?? room.ownerName === profileName)) return;
                event.preventDefault();
                onRoomSettings(room);
              }}
              aria-label={`进入频道 ${room.name}`}
            >
              <span className="room-avatar">
                {room.avatarUrl ? (
                  <img src={room.avatarUrl} alt="" />
                ) : (
                  <DoorOpen size={20} weight="duotone" />
                )}
                <span className="voice-count">{room.count ?? 0}</span>
              </span>
              <span className="room-nav-copy">
                <b>{room.name}</b>
                <small>
                  {room.count ? `${room.count} 人语音中` : "暂无语音"}
                </small>
              </span>
            </button>
            {expanded && (room.isOwner ?? room.ownerName === profileName) && (
              <button
                className="icon-btn"
                onClick={() => onRoomSettings(room)}
                aria-label={`${room.name} 设置`}
              >
                <GearSix size={18} />
              </button>
            )}
          </div>
        ))}
        <button
          className="create-room"
          onClick={onCreate}
          aria-label="新建频道"
          title="新建频道"
        >
          <span className="nav-action-icon" aria-hidden="true">
            <Plus size={20} />
          </span>
          <span className="nav-action-label">新建频道</span>
        </button>
      </div>
      <button
        className="global-settings-button"
        onClick={onSettings}
        aria-label="设置"
        title="设置"
      >
        <span className="nav-action-icon" aria-hidden="true">
          <GearSix size={22} />
        </span>
        <span className="nav-action-label">设置</span>
      </button>
    </aside>
  );
}

function ShareStatusBarV2({
  self,
  sharer,
  volume,
  onVolume,
  muted,
  onMute,
  onRemote,
  remoteState,
  onStopRemote,
  onFull,
  onEnd,
  fullscreenMode,
  onAppFull,
  notice,
}: {
  self: boolean;
  sharer: string;
  volume: number;
  onVolume: (value: number) => void;
  muted: boolean;
  onMute: () => void;
  onRemote: () => void;
  remoteState: "available" | "pending" | "active" | "unsupported";
  onStopRemote: () => void;
  onFull: () => void;
  onEnd: () => void;
  fullscreenMode: string | null;
  onAppFull: () => void;
  notice?: string;
}) {
  const appFullscreen = fullscreenMode === "app";
  return (
    <div className="share-status-bar">
      <div className="share-status-left">
        <b>{self ? "你的共享" : `${sharer}的共享`}</b>
        <VolumeControl
          value={volume}
          onChange={onVolume}
          label={self ? "共享发送音量" : "共享观看音量"}
          muted={muted}
          onMute={onMute}
        />
      </div>
      <div className="share-status-actions">
        {!self &&
          (remoteState === "active" ? (
            <button onClick={onStopRemote}>
              <MousePointer2 size={17} />
              停止远程控制
            </button>
          ) : remoteState === "pending" ? (
            <button className="remote-pending" onClick={onStopRemote}>
              <LoaderCircle size={15} />
              取消请求
            </button>
          ) : remoteState === "available" ? (
            <button onClick={onRemote}>
              <MousePointer2 size={17} />
              远程控制
            </button>
          ) : null)}
        <div className="fullscreen-stack">
          <button onClick={appFullscreen ? onAppFull : onFull}>
            <SquaresFour size={17} />
            {appFullscreen ? "退出全屏" : "全屏"}
          </button>
          {!appFullscreen && (
            <button className="application-fullscreen" onClick={onAppFull}>
              <MonitorPlay size={17} />
              应用全屏
            </button>
          )}
        </div>
        {notice && (
          <span className="share-status-notice" role="status">
            {notice}
          </span>
        )}
        <button className="end-share" onClick={onEnd}>
          <PhoneDisconnect size={17} />
          {self ? "结束共享" : "结束观看"}
        </button>
      </div>
    </div>
  );
}

function ScreenShareSettingsV2({
  preset,
  fps,
  audio,
  gameMode,
  nativeResolution,
  onPreset,
  onFps,
  onAudio,
  onGameMode,
  onNativeResolution,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  preset: ScreenPreset;
  fps: Fps;
  audio: boolean;
  gameMode: boolean;
  nativeResolution: boolean;
  onPreset: (preset: ScreenPreset) => void;
  onFps: (fps: Fps) => void;
  onAudio: () => void;
  onGameMode: () => void;
  onNativeResolution: (enabled: boolean) => void;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="modal-scrim share-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="tool-menu screen-menu screen-settings popover-card"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <b>屏幕共享设置</b>
          <button className="icon-btn" onClick={onCancel} aria-label="关闭">
            <X size={16} />
          </button>
        </header>
        <p className="screen-settings-note">
          {gameMode
            ? "游戏模式以 60 FPS 和稳定动态画面为目标。"
            : "根据画面变化自动调整帧率。"}{" "}
          不设码率上限，实际速率由网络与设备能力决定。
        </p>
        <label className="settings-toggle-card">
          <span>
            <b>游戏模式</b>
            <small>以 60 FPS 和稳定动态画面为目标</small>
          </span>
          <input type="checkbox" checked={gameMode} onChange={onGameMode} />
        </label>
        <label className="settings-toggle-card">
          <span>
            <b>以原生分辨率共享</b>
            <small>使用采集源自身分辨率</small>
          </span>
          <input
            type="checkbox"
            checked={nativeResolution}
            onChange={(event) => onNativeResolution(event.target.checked)}
          />
        </label>
        <section
          className={`media-choice-section ${nativeResolution ? "disabled" : ""}`}
        >
          <span>分辨率</span>
          <div className="choice-grid resolution-grid">
            {(Object.keys(SCREEN_PRESETS) as ScreenPreset[]).map((value) => (
              <button
                key={value}
                disabled={nativeResolution}
                className={preset === value ? "active" : ""}
                onClick={() => onPreset(value)}
              >
                {value === "1440p" ? "1440p 2K" : SCREEN_PRESETS[value].label}
              </button>
            ))}
          </div>
        </section>
        <section className="media-choice-section">
          <span>帧率</span>
          <div className="choice-grid">
            <button
              className={fps === 30 ? "active" : ""}
              disabled={gameMode}
              onClick={() => onFps(30)}
            >
              30 fps
            </button>
            <button
              className={fps === 60 ? "active" : ""}
              onClick={() => onFps(60)}
            >
              60 fps
            </button>
          </div>
        </section>
        <label className="settings-toggle-card computer-audio-toggle">
          <span>
            <b>共享电脑音频</b>
            <small>排除 Cove 自身声音，作为屏幕共享附带音频</small>
          </span>
          <input type="checkbox" checked={audio} onChange={onAudio} />
        </label>
        <button className="primary-wide yellow" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

function AudioShareMenuV2({
  sources,
  loading,
  onClose,
  onRefresh,
  onSystemAudio,
  onApplicationAudio,
}: {
  sources: ApplicationAudioSource[];
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onSystemAudio: () => void;
  onApplicationAudio: (source: ApplicationAudioSource) => void;
}) {
  return (
    <div
      className="audio-popover-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="tool-menu audio-menu audio-share-modal popover-card"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="audio-share-title"
      >
        <header className="audio-share-header">
          <div className="audio-share-heading">
            <span className="audio-share-heading-icon">
              <AudioLines size={25} weight="bold" />
            </span>
            <div>
              <h2 id="audio-share-title">共享应用音频</h2>
              <p>
                仅发送所选应用及其子进程的声音，不包含 Cove 通话或其他系统声音。
              </p>
            </div>
          </div>
          <button
            className="icon-btn audio-share-close"
            onClick={onClose}
            aria-label="关闭应用音频选择"
          >
            <X size={18} />
          </button>
        </header>
        <div className="audio-share-meta">
          <span>Windows 11 · 仅音频 · 共享后可调节发送音量</span>
          <button
            type="button"
            className="audio-share-refresh"
            onClick={onRefresh}
            disabled={loading}
          >
            <ArrowClockwise size={17} className={loading ? "spin" : ""} />
            刷新
          </button>
        </div>
        <div className="audio-share-list">
          <button
            type="button"
            className="source-option system-audio-option"
            onClick={onSystemAudio}
          >
            <span className="source-option-icon">
              <Headphones size={20} />
            </span>
            <span className="source-option-copy">
              <b>全部系统音频</b>
              <small>排除 Cove 后共享电脑其他应用的声音</small>
            </span>
            <span className="source-option-action" aria-hidden="true">
              <AudioLines size={19} weight="bold" />
            </span>
          </button>
          {loading ? (
            <div className="audio-share-loading">
              <LoaderCircle className="spin" size={19} />
              正在读取可共享的应用…
            </div>
          ) : sources.length > 0 ? (
            sources.map((source) => (
              <button
                type="button"
                key={source.id}
                className="source-option"
                onClick={() => onApplicationAudio(source)}
              >
                <span className="source-option-icon">
                  <AppWindow size={20} />
                </span>
                <span className="source-option-copy">
                  <b>{source.name}</b>
                  <small>
                    {source.processName} · PID {source.processId}
                  </small>
                </span>
                <span className="source-option-action" aria-hidden="true">
                  <AudioLines size={19} weight="bold" />
                </span>
              </button>
            ))
          ) : (
            <div className="audio-share-empty">
              <AppWindow size={22} />
              <span>没有可捕获的应用窗口。</span>
              <small>请先打开要播放声音的应用，再点击刷新。</small>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function DiagnosticsOverlayV2({
  rtc,
  compact,
  onToggleCompact,
}: {
  rtc: ReturnType<typeof useWebRTC>;
  compact: boolean;
  onToggleCompact: () => void;
}) {
  const resolution =
    rtc.stats.width && rtc.stats.height
      ? `${rtc.stats.width}×${rtc.stats.height}`
      : "—";
  const fps = rtc.localScreen ? rtc.stats.sendFps : rtc.stats.receiveFps;
  return (
    <div className={`debug-overlay diagnostics-v2 ${compact ? "compact" : ""}`}>
      <header>
        <Radio size={17} weight="fill" />
        媒体调试<span>{rtc.localScreen ? "共享方" : "观看方"}</span>
        <button
          className="icon-btn"
          onClick={onToggleCompact}
          aria-label={compact ? "显示详细诊断" : "显示精简诊断"}
        >
          <SquaresFour size={14} />
        </button>
      </header>
      {compact ? (
        <>
          <div>
            <span>帧率</span>
            <b>{fps ?? "—"} fps</b>
          </div>
          <div>
            <span>分辨率</span>
            <b>{resolution}</b>
          </div>
          <div>
            <span>码率</span>
            <b>
              {rtc.stats.bitrate != null ? `${rtc.stats.bitrate} kbps` : "—"}
            </b>
          </div>
        </>
      ) : (
        <>
          <div>
            <span>帧率</span>
            <b>
              {rtc.localScreen
                ? `${rtc.stats.trackFps ?? "—"} / ${rtc.stats.captureFps ?? "—"} / ${rtc.stats.encodeFps ?? "—"} / ${rtc.stats.sendFps ?? "—"}`
                : `${rtc.stats.receiveFps ?? "—"} / ${rtc.stats.decodeFps ?? "—"}`}{" "}
              fps
            </b>
          </div>
          <div>
            <span>原始/编码/档位</span>
            <b>
              {rtc.stats.trackWidth && rtc.stats.trackHeight
                ? `${rtc.stats.trackWidth}×${rtc.stats.trackHeight}`
                : "—"}{" "}
              / {resolution} /{" "}
              {rtc.localScreen && rtc.screenEncodingPlan
                ? `${rtc.screenEncodingPlan.outputWidth}×${rtc.screenEncodingPlan.outputHeight}`
                : "—"}
            </b>
          </div>
          <div>
            <span>编码器</span>
            <b>{rtc.stats.codec ?? "—"}</b>
          </div>
          <div>
            <span>RTP 码率</span>
            <b>
              {rtc.stats.bitrate != null ? `${rtc.stats.bitrate} kbps` : "—"}
            </b>
          </div>
          <div>
            <span>服务器入口/出口</span>
            <b>
              {rtc.stats.serverIngressBitrate ?? "—"} /{" "}
              {rtc.stats.serverEgressBitrate ?? "—"} kbps
            </b>
          </div>
          <div>
            <span>延迟/抖动</span>
            <b>
              {rtc.stats.rtt ?? "—"} / {rtc.stats.jitter ?? "—"} ms
            </b>
          </div>
          <div>
            <span>丢包/重传</span>
            <b>
              {rtc.stats.loss ?? "—"}% / {rtc.stats.retransmitBitrate ?? "—"}{" "}
              kbps
            </b>
          </div>
          <div>
            <span>掉帧/受限原因</span>
            <b>
              {rtc.stats.droppedFrames ?? "—"} /{" "}
              {rtc.stats.qualityLimitation ?? "—"}
            </b>
          </div>
          <div>
            <span>协议/来源</span>
            <b>
              {rtc.stats.protocol ?? "—"} / {rtc.stats.displaySurface ?? "—"}
            </b>
          </div>
          {rtc.localScreen && (
            <div>
              <span>档位检查</span>
              <b>
                {isScreenEncodingWithinPlan(
                  rtc.stats.width,
                  rtc.stats.height,
                  rtc.screenEncodingPlan,
                ) === false
                  ? "超过档位"
                  : "正常"}
              </b>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ShareViewV2({
  rtc,
  debug,
  onToggleDebug,
  remoteControl,
  onInput,
  onRequestRemote,
  onStopRemote,
  onEnd,
  diagnosticsCompact,
  onToggleDiagnosticsCompact,
}: {
  rtc: ReturnType<typeof useWebRTC>;
  debug: boolean;
  onToggleDebug: () => void;
  remoteControl: {
    state: "available" | "pending" | "active" | "unsupported";
    notice: string;
    sharerActive?: boolean;
    controllerName?: string;
  };
  onInput: (input: RemoteControlInput) => void;
  onRequestRemote: () => void;
  onStopRemote: () => void;
  onEnd: () => void;
  diagnosticsCompact: boolean;
  onToggleDiagnosticsCompact: () => void;
}) {
  const local = Boolean(rtc.localScreen);
  const remote = rtc.remoteScreen;
  const [muted, setMuted] = useState(false);
  const lastVolume = useRef(100);
  const {
    screenContainerRef,
    screenMaximized,
    nativeFullscreen,
    toggleFullscreen,
    toggleNativeFullscreen,
  } = useScreenFullscreen(Boolean(rtc.localScreen || rtc.remoteScreen));
  const sharer = remote
    ? (rtc.voiceMembers.find((member) => member.socketId === remote.socketId)
        ?.username ?? "成员")
    : "你";
  const end = () => {
    if (nativeFullscreen) void toggleNativeFullscreen();
    if (screenMaximized) toggleFullscreen();
    onEnd();
  };
  const currentVolume =
    (local ? rtc.screenShareVolume : rtc.screenReceiveVolume) * 100;
  const setCurrentVolume = (value: number) => {
    if (value > 0) setMuted(false);
    if (local) rtc.setScreenShareVolume(value / 100);
    else rtc.setScreenReceiveVolume(value / 100);
  };
  const toggleVolumeMute = () => {
    if (muted || currentVolume === 0) {
      setCurrentVolume(lastVolume.current || 100);
      setMuted(false);
    } else {
      lastVolume.current = currentVolume;
      setCurrentVolume(0);
      setMuted(true);
    }
  };
  return (
    <div className={`share-view ${screenMaximized ? "screen-maximized" : ""}`}>
      <div ref={screenContainerRef} className="video-surface">
        <div className="video-content">
          {remote ? (
            <RemoteScreenVideo
              stream={remote.stream}
              controlling={remoteControl.state === "active"}
              onInput={onInput}
            />
          ) : local ? (
            <LocalScreenVideo stream={rtc.localScreen!} />
          ) : (
            <div className="video-placeholder">
              <MonitorPlay size={42} />
              <span>共享画面将在这里显示</span>
            </div>
          )}
        </div>
        {debug && (
          <DiagnosticsOverlayV2
            rtc={rtc}
            compact={diagnosticsCompact}
            onToggleCompact={onToggleDiagnosticsCompact}
          />
        )}
        {false && (
          <div className="debug-overlay">
            <header>
              <Radio size={17} weight="fill" />
              媒体调试
              <button
                className="icon-btn"
                onClick={onToggleDebug}
                aria-label="关闭调试信息"
              >
                <X size={15} />
              </button>
            </header>
            <div>
              <span>分辨率</span>
              <b>
                {rtc.stats.width && rtc.stats.height
                  ? `${rtc.stats.width} × ${rtc.stats.height}`
                  : "等待数据"}
              </b>
            </div>
            <div>
              <span>帧率</span>
              <b>
                {local
                  ? (rtc.stats.sendFps ?? "—")
                  : (rtc.stats.receiveFps ?? "—")}{" "}
                fps
              </b>
            </div>
            <div>
              <span>码率</span>
              <b>
                {rtc.stats.bitrate != null ? `${rtc.stats.bitrate} kbps` : "—"}
              </b>
            </div>
            <div>
              <span>丢包</span>
              <b>{rtc.stats.loss != null ? `${rtc.stats.loss}%` : "—"}</b>
            </div>
          </div>
        )}
        {remoteControl.sharerActive && (
          <div className="remote-control-banner">
            <b>
              <MousePointer2 size={14} />
              {remoteControl.controllerName ?? "成员"} 正在控制你的屏幕
            </b>
            <button onClick={onStopRemote}>停止控制</button>
          </div>
        )}
      </div>
      <ShareStatusBarV2
        self={local}
        sharer={sharer}
        volume={currentVolume}
        onVolume={setCurrentVolume}
        muted={muted}
        onMute={toggleVolumeMute}
        onRemote={onRequestRemote}
        remoteState={remoteControl.state}
        onStopRemote={onStopRemote}
        onFull={toggleNativeFullscreen}
        onEnd={end}
        fullscreenMode={
          nativeFullscreen ? "full" : screenMaximized ? "app" : null
        }
        onAppFull={toggleFullscreen}
        notice={remoteControl.notice}
      />
    </div>
  );
}

function ControlBallV2({
  rtc,
  mode,
  onLeave,
  onLeaveVoice,
  onStartScreen,
  onEditScreen,
  onStartAudio,
  onToggleDebug,
  debug,
  onOpenDevices,
  onOpenSoundboard,
  soundboardButtonRef,
  onSoundboardHoverStart,
  onSoundboardHoverEnd,
}: {
  rtc: ReturnType<typeof useWebRTC>;
  mode: "idle" | "available" | "watching" | "self";
  onLeave: () => void;
  onLeaveVoice: () => void;
  onStartScreen: () => void;
  onEditScreen: () => void;
  onStartAudio: () => void;
  onToggleDebug: () => void;
  debug: boolean;
  onOpenDevices: () => void;
  onOpenSoundboard: () => void;
  soundboardButtonRef: {
    current: HTMLButtonElement | null;
  };
  onSoundboardHoverStart: () => void;
  onSoundboardHoverEnd: () => void;
}) {
  const [locked, setLocked] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [closing, setClosing] = useState(false);
  const leaveTimer = useRef<number>();
  const collapseTimer = useRef<number>();
  const expanded = locked || hovered;
  const compactDock =
    rtc.inVoice && (mode === "idle" || mode === "available");
  const labelsVisible = !compactDock && (expanded || closing);
  const selfShare = mode === "self";
  const collapseDuration = 340;

  const clearCollapseTimer = () => {
    window.clearTimeout(collapseTimer.current);
    collapseTimer.current = undefined;
  };
  const beginCollapse = () => {
    clearCollapseTimer();
    setClosing(true);
    collapseTimer.current = window.setTimeout(() => {
      setClosing(false);
      collapseTimer.current = undefined;
    }, collapseDuration);
  };

  useEffect(
    () => () => {
      window.clearTimeout(leaveTimer.current);
      window.clearTimeout(collapseTimer.current);
    },
    [],
  );

  return (
    <div
      className={`control-ball-anchor ${expanded ? "expanded" : "collapsed"}`}
      onMouseEnter={() => {
        window.clearTimeout(leaveTimer.current);
        clearCollapseTimer();
        setClosing(false);
        setHovered(true);
      }}
      onMouseLeave={() => {
        window.clearTimeout(leaveTimer.current);
        leaveTimer.current = window.setTimeout(() => setHovered(false), 180);
        if (!locked) {
          window.clearTimeout(leaveTimer.current);
          leaveTimer.current = window.setTimeout(() => {
            beginCollapse();
            setHovered(false);
          }, 180);
        }
      }}
    >
      <div
        className={`control-ball ${expanded ? "expanded" : "collapsed"} ${locked ? "locked" : "unlocked"} ${labelsVisible ? "full" : "compact"} ${closing ? "closing" : ""} ${rtc.inVoice ? "voice-active" : "voice-idle"}`}
      >
        <div className="ball-side ball-left">
          <button
            className={rtc.inVoice && !rtc.isMuted ? "enabled-blue" : ""}
            onClick={rtc.inVoice ? rtc.toggleMute : rtc.joinVoice}
            onContextMenu={(event) => {
              event.preventDefault();
              onOpenDevices();
            }}
            title={rtc.inVoice ? "切换麦克风" : "加入语音"}
          >
            {!rtc.inVoice ? (
              <Phone size={21} strokeWidth={2} />
            ) : rtc.isMuted ? (
              <MicrophoneSlash size={21} />
            ) : (
              <Microphone size={21} weight="fill" />
            )}
            <span className="dock-label">
              {rtc.inVoice ? "麦克风" : "加入语音"}
            </span>
          </button>
          {rtc.inVoice && (
            <>
              <button
                className={selfShare ? "enabled-yellow" : ""}
                onClick={selfShare ? rtc.stopScreenShare : onStartScreen}
                onContextMenu={(event) => {
                  if (!selfShare) return;
                  event.preventDefault();
                  onEditScreen();
                }}
                title={
                  selfShare ? "左键结束共享，右键修改参数" : "共享屏幕"
                }
              >
                <MonitorPlay
                  size={21}
                  weight={selfShare ? "fill" : "regular"}
                />
                <span className="dock-label">
                  {selfShare ? "结束共享" : "共享屏幕"}
                </span>
              </button>
              <button
                className={
                  rtc.isApplicationAudioSharing ? "enabled-purple" : ""
                }
                onClick={
                  rtc.isApplicationAudioSharing
                    ? rtc.stopApplicationAudioShare
                    : onStartAudio
                }
                title="共享音频"
              >
                <Waveform size={21} weight="bold" />
                <span className="dock-label">共享音频</span>
              </button>
            </>
          )}
        </div>
        <button
          className="ball-quad"
          onClick={() => {
            if (locked) {
              beginCollapse();
              setLocked(false);
              setHovered(false);
            } else {
              clearCollapseTimer();
              setClosing(false);
              setLocked(true);
            }
          }}
          aria-label={locked ? "点击解锁收起" : "点击锁定展开"}
          title={locked ? "点击解锁收起" : "点击锁定展开"}
        >
          <span className={`quad-grid ${locked ? "upright" : "tilted"}`}>
            <i
              className={`quad-lamp mic ${rtc.inVoice && !rtc.isMuted ? "on" : ""}`}
            />
            <i className={`quad-lamp screen ${selfShare ? "on" : ""}`} />
            <i
              className={`quad-lamp audio ${rtc.isApplicationAudioSharing ? "on" : ""}`}
            />
            <i className="quad-lamp net good" />
          </span>
        </button>
        <div className="ball-side ball-right">
          {rtc.inVoice && (
            <>
              <button
                ref={soundboardButtonRef}
                onClick={onOpenSoundboard}
                onMouseEnter={onSoundboardHoverStart}
                onMouseLeave={onSoundboardHoverEnd}
                onFocus={onSoundboardHoverStart}
                onBlur={onSoundboardHoverEnd}
                title="语音包"
              >
                <SquaresFour size={21} />
                <span className="dock-label">语音包</span>
              </button>
              <button
                className={debug ? "debug-enabled" : ""}
                onClick={onToggleDebug}
                title="调试信息"
              >
                <Wrench size={21} />
                <span className="dock-label">调试信息</span>
              </button>
            </>
          )}
          <button
            className="ball-leave danger"
            onClick={rtc.inVoice ? onLeaveVoice : onLeave}
            title={rtc.inVoice ? "离开语音" : "离开频道"}
          >
            <PhoneDisconnect size={22} weight="fill" />
            <span className="dock-label">
              {rtc.inVoice ? "离开语音" : "离开频道"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ChatRoomV2({
  profile,
  accountId,
  onProfileChange,
  onLogout,
  serverURL,
  sessionReady,
  theme,
  onThemeChange,
}: Props) {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const rtc = useWebRTC(socket, roomId ?? "");
  const inputVolume = rtc.microphoneVolume * 100;
  const setInputVolume = (value: number) =>
    rtc.setMicrophoneVolume(value / 100);
  const sharedAudioMuteRestore = useRef<Record<string, number>>({});
  const sharedAudioKey = (member: RoomMember, isSelf: boolean) =>
    isSelf
      ? "self-application"
      : `remote:${member.socketId}`;
  const getSharedAudioVolume = (member: RoomMember, isSelf: boolean) =>
    isSelf
      ? rtc.applicationAudioShareVolume
      : (rtc.applicationAudioReceiveVolumes[member.socketId] ?? 1);
  const setSharedAudioVolume = (
    member: RoomMember,
    isSelf: boolean,
    value: number,
  ) => {
    const normalized = Math.max(0, Math.min(2, value));
    const key = sharedAudioKey(member, isSelf);
    if (normalized > 0) sharedAudioMuteRestore.current[key] = normalized;
    if (isSelf) {
      rtc.setApplicationAudioShareVolume(normalized);
    } else {
      rtc.setApplicationAudioReceiveVolume(member.socketId, normalized);
    }
  };
  const toggleSharedAudioMute = (member: RoomMember, isSelf: boolean) => {
    const key = sharedAudioKey(member, isSelf);
    const current = getSharedAudioVolume(member, isSelf);
    if (current === 0) {
      setSharedAudioVolume(
        member,
        isSelf,
        sharedAudioMuteRestore.current[key] ?? 1,
      );
      delete sharedAudioMuteRestore.current[key];
    } else {
      sharedAudioMuteRestore.current[key] = current;
      setSharedAudioVolume(member, isSelf, 0);
    }
  };
  const [room, setRoom] = useState<RoomWithAppearance | null>(null);
  const [rooms, setRooms] = useState<RoomWithAppearance[]>([]);
  const [voiceCounts, setVoiceCounts] = useState<Record<string, number>>({});
  const [roomMembers, setRoomMembers] = useState<RoomMember[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [roomSynced, setRoomSynced] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [joinRetryNonce, setJoinRetryNonce] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [historyLoadVersion, setHistoryLoadVersion] = useState(0);
  const [input, setInput] = useState("");
  const [unread, setUnread] = useState(0);
  const [chatFontSize, setChatFontSize] =
    useState<ChatFontSize>(readChatFontSize);
  const [chatOpen, setChatOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [memberMenu, setMemberMenu] = useState<{
    member: RoomMember;
    x: number;
    y: number;
  } | null>(null);
  const [roomSettings, setRoomSettings] = useState<RoomWithAppearance | null>(
    null,
  );
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomLimit, setNewRoomLimit] = useState("");
  const [newRoomPassword, setNewRoomPassword] = useState("");
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [globalSettings, setGlobalSettings] = useState(false);
  const [globalSettingsPage, setGlobalSettingsPage] =
    useState<GlobalSettingsPage>("audio");
  const [showSoundboard, setShowSoundboard] = useState(false);
  const [showSoundboardQuick, setShowSoundboardQuick] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [viewingProfile, setViewingProfile] = useState<RoomMember | null>(null);
  const [profileRemarks, setProfileRemarks] = useState(loadProfileRemarks);
  const [showScreenModal, setShowScreenModal] = useState(false);
  const [editingScreen, setEditingScreen] = useState(false);
  const [pendingPreset, setPendingPreset] = useState<
    "540p" | "720p" | "1080p" | "1440p"
  >("720p");
  const [pendingFps, setPendingFps] = useState<Fps>(30);
  const [pendingAudio, setPendingAudio] = useState(false);
  const [pendingGameMode, setPendingGameMode] = useState(false);
  const [pendingNativeResolution, setPendingNativeResolution] = useState(false);
  const [showAudioModal, setShowAudioModal] = useState(false);
  const [audioSources, setAudioSources] = useState<ApplicationAudioSource[]>(
    [],
  );
  const [audioLoading, setAudioLoading] = useState(false);
  const [pendingRemote, setPendingRemote] =
    useState<RemoteControlRequest | null>(null);
  const [pendingRemoteRequest, setPendingRemoteRequest] = useState(false);
  const [pendingRemoteRequestId, setPendingRemoteRequestId] = useState<
    string | null
  >(null);
  const [remoteSession, setRemoteSession] =
    useState<RemoteControlSession | null>(null);
  const [remoteNotice, setRemoteNotice] = useState("");
  const [debug, setDebug] = useState(false);
  const [diagnosticsCompact, setDiagnosticsCompact] = useState(false);
  const outputVolume = rtc.masterOutputVolume * 100;
  const setOutputVolume = (value: number) =>
    rtc.setMasterOutputVolume(value / 100);
  const updateChatFontSize = (value: ChatFontSize) => {
    setChatFontSize(value);
    try {
      window.localStorage.setItem(CHAT_FONT_SIZE_STORAGE_KEY, value);
    } catch {
      // 本地存储不可用时仍即时应用字号。
    }
  };
  const remoteRef = useRef<RemoteControlSession | null>(null);
  const roomSyncedRef = useRef(false);
  const joinPasswordRef = useRef("");
  const roomJoinGenerationRef = useRef(0);
  const messageHistoryCursorRef = useRef<MessageHistoryCursor | null>(null);
  const historyGenerationRef = useRef(0);
  const imageBusy = useRef(false);
  const soundboardButtonRef = useRef<HTMLButtonElement>(null);
  const soundboardHoverTimer = useRef<number | null>(null);
  joinPasswordRef.current = joinPassword;
  const shareLayout = Boolean(rtc.localScreen || rtc.remoteScreen);
  const chatVisible = !shareLayout || chatOpen;
  const chatVisibleRef = useRef(chatVisible);
  // 让消息回调同步读取最新的可见状态，避免打开聊天栏的状态切换窗口
  // 仍被旧回调误判为“聊天栏已收起”。
  chatVisibleRef.current = chatVisible;
  const clearSoundboardHoverTimer = () => {
    if (soundboardHoverTimer.current === null) return;
    window.clearTimeout(soundboardHoverTimer.current);
    soundboardHoverTimer.current = null;
  };
  const openSoundboardQuick = () => {
    clearSoundboardHoverTimer();
    if (!showSoundboard) setShowSoundboardQuick(true);
  };
  const closeSoundboardQuick = () => {
    clearSoundboardHoverTimer();
    soundboardHoverTimer.current = window.setTimeout(
      () => {
        setShowSoundboardQuick(false);
        soundboardHoverTimer.current = null;
      },
      180,
    );
  };
  const openSoundboard = () => {
    clearSoundboardHoverTimer();
    setShowSoundboardQuick(false);
    setShowSoundboard(true);
  };
  useEffect(
    () => () => {
      clearSoundboardHoverTimer();
    },
    [],
  );
  useEffect(() => {
    if (rtc.inVoice) return;
    clearSoundboardHoverTimer();
    setShowSoundboard(false);
    setShowSoundboardQuick(false);
  }, [rtc.inVoice]);
  useEffect(() => {
    remoteRef.current = remoteSession;
  }, [remoteSession]);
  useEffect(() => {
    roomSyncedRef.current = roomSynced;
  }, [roomSynced]);
  useEffect(() => {
    setChatOpen(shareLayout ? false : true);
  }, [shareLayout]);
  useEffect(() => {
    // 聊天栏重新可见时，清除之前在收起期间累积的提示。
    if (chatVisible) setUnread(0);
  }, [chatVisible]);
  useEffect(() => {
    const handleUpdateDetails = () => {
      setGlobalSettingsPage("update");
      setGlobalSettings(true);
    };
    window.addEventListener(UPDATE_CENTER_DETAILS_EVENT, handleUpdateDetails);
    return () =>
      window.removeEventListener(
        UPDATE_CENTER_DETAILS_EVENT,
        handleUpdateDetails,
      );
  }, []);
  const refreshRooms = useCallback(() => {
    fetch(`${serverURL}/api/rooms`)
      .then((response) => (response.ok ? response.json() : []))
      .then((data) =>
        setRooms((current) =>
          (data as RoomWithAppearance[]).map((room) => ({
            ...room,
            isOwner:
              room.isOwner ??
              current.find((item) => item.id === room.id)?.isOwner,
            count: voiceCounts[room.id] ?? room.count ?? 0,
          })),
        ),
      )
      .catch(() => undefined);
  }, [serverURL, voiceCounts]);
  useEffect(() => {
    refreshRooms();
    const onRooms = (next: RoomWithAppearance[]) =>
      setRooms((current) =>
        next.map((room) => ({
          ...room,
          isOwner:
            room.isOwner ??
            current.find((item) => item.id === room.id)?.isOwner,
          count: voiceCounts[room.id] ?? room.count ?? 0,
        })),
      );
    const onCounts = (next: Record<string, number>) => {
      setVoiceCounts(next);
      setRooms((current) =>
        current.map((room) => ({ ...room, count: next[room.id] ?? 0 })),
      );
    };
    socket.on("rooms:updated", onRooms);
    socket.on("voice:counts", onCounts);
    socket
      .timeout(5000)
      .emit(
        "rooms:get",
        (
          error: Error | null,
          response?: { ok?: boolean; rooms?: RoomWithAppearance[] },
        ) => {
          if (!error && response?.ok && response.rooms)
            setRooms(
              response.rooms.map((room) => ({
                ...room,
                count: voiceCounts[room.id] ?? room.count ?? 0,
              })),
            );
        },
      );
    return () => {
      socket.off("rooms:updated", onRooms);
      socket.off("voice:counts", onCounts);
    };
  }, [refreshRooms, voiceCounts]);
  useEffect(() => {
    const next = rooms.find((item) => item.id === roomId);
    if (next)
      setRoom((current) => (current ? { ...current, ...next } : current));
  }, [rooms, roomId]);
  useEffect(() => {
    if (!roomId) return;
    let active = true;
    fetch(`${serverURL}/api/rooms/${roomId}`)
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error("房间不存在")),
      )
      .then((next) => {
        if (active) setRoom(next as RoomWithAppearance);
      })
      .catch(() => {
        if (active) navigate("/");
      });
    return () => {
      active = false;
    };
  }, [roomId, serverURL, navigate]);
  useEffect(() => {
    if (!roomId || !sessionReady) {
      if (roomId) {
        setJoining(false);
        setRoomSynced(false);
      }
      return;
    }
    let active = true;
    const generation = ++roomJoinGenerationRef.current;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    let requestInFlight = false;
    let requestSerial = 0;
    let joined = false;
    let failed = false;

    const clearRetryTimer = () => {
      if (retryTimer === null) return;
      clearTimeout(retryTimer);
      retryTimer = null;
    };

    const failJoin = (message: string) => {
      if (!active || generation !== roomJoinGenerationRef.current) return;
      failed = true;
      clearRetryTimer();
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      setJoining(false);
      setRoomSynced(false);
      setJoinError(message);
    };

    const scheduleRetry = (message: string) => {
      if (!active || generation !== roomJoinGenerationRef.current) return;
      if (retryTimer !== null) return;
      if (retryCount >= 6) {
        failJoin(message);
        return;
      }
      retryCount += 1;
      setJoining(true);
      // Keep the loading state visible during transient reconnects. Showing
      // Socket.IO's raw "operation has timed out" would make a recoverable
      // transport hiccup look like a room/permission failure.
      setJoinError("");
      const delay = Math.min(2_500, 250 * 2 ** (retryCount - 1));
      retryTimer = setTimeout(() => {
        retryTimer = null;
        attemptJoin();
      }, delay);
    };

    const attemptJoin = () => {
      if (
        !active ||
        generation !== roomJoinGenerationRef.current ||
        requestInFlight ||
        retryTimer !== null ||
        joined ||
        failed
      )
        return;
      if (!socket.connected) {
        // App normally owns reconnecting, but calling connect here closes the
        // small window where a room click races the account socket recovery.
        socket.connect();
        scheduleRetry("加入频道超时，请检查服务器连接后重试");
        return;
      }

      requestInFlight = true;
      const requestId = ++requestSerial;
      const payload = {
        roomId,
        ...(joinPasswordRef.current
          ? { password: joinPasswordRef.current }
          : {}),
      };
      socket
        .timeout(5_000)
        .emit(
          "room:join",
          payload,
          (
            error: Error | null,
            response: { ok?: boolean; error?: string; code?: string },
          ) => {
            if (
              !active ||
              generation !== roomJoinGenerationRef.current ||
              requestId !== requestSerial
            )
              return;
            requestInFlight = false;
            if (error) {
              if (!socket.connected || error.message === "operation has timed out") {
                scheduleRetry("加入频道超时，请检查服务器连接后重试");
              } else {
                failJoin(error.message || "无法加入频道");
              }
              return;
            }
            if (!response?.ok) {
              // The server's joinPending guard is transient; retry it instead
              // of exposing a false room failure during a reconnect race.
              if (
                response?.code === "RATE_LIMITED" &&
                response.error === "正在加入，请稍候"
              ) {
                scheduleRetry("加入频道超时，请检查服务器连接后重试");
              } else if (response?.code === "NOT_REGISTERED") {
                scheduleRetry("登录连接正在恢复，请稍候");
              } else {
                failJoin(response?.error ?? "无法加入频道");
              }
              return;
            }
            joined = true;
            clearRetryTimer();
            retryCount = 0;
            socket.off("connect", onConnect);
            setJoining(false);
            setJoinError("");
            setRoomSynced(true);
          },
        );
    };

    const onConnect = () => {
      if (!active || joined || failed || requestInFlight) return;
      clearRetryTimer();
      attemptJoin();
    };
    const onDisconnect = () => {
      if (!active || joined || failed) return;
      requestSerial += 1;
      requestInFlight = false;
      scheduleRetry("登录连接正在恢复，请稍候");
    };

    setJoining(true);
    setRoomSynced(false);
    setJoinError("");
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    attemptJoin();
    return () => {
      active = false;
      requestSerial += 1;
      requestInFlight = false;
      clearRetryTimer();
      roomJoinGenerationRef.current += 1;
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      if (socket.connected) socket.emit("room:leave", roomId);
      rtc.leaveVoice();
    };
  }, [roomId, sessionReady, joinRetryNonce]);
  useEffect(() => {
    if (!roomId) return;
    historyGenerationRef.current += 1;
    messageHistoryCursorRef.current = null;
    setMessages([]);
    setMessagesLoaded(false);
    setHasOlderMessages(false);
    setLoadingOlderMessages(false);
    setHistoryLoadVersion(0);
    setUnread(0);
  }, [roomId]);
  useEffect(() => {
    if (!roomId || !roomSynced) return;
    let active = true;
    const generation = historyGenerationRef.current;
    socket
      .timeout(6000)
      .emit(
        "room:history",
        { roomId },
        (
          error: Error | null,
          response?: MessageHistoryResponse,
        ) => {
          if (!active || generation !== historyGenerationRef.current) return;
          if (!error && response?.ok) {
            const history = response.messages ?? [];
            setMessages((current) => mergeChatMessages(current, history));
            messageHistoryCursorRef.current = response.cursor ?? (
              history[0]
                ? { timestamp: history[0].timestamp, id: history[0].id }
                : null
            );
            setHasOlderMessages(Boolean(response.hasMore));
          }
          setMessagesLoaded(true);
        },
      );
    return () => {
      active = false;
    };
  }, [roomId, roomSynced]);
  const loadOlderMessages = useCallback(() => {
    const before = messageHistoryCursorRef.current;
    if (
      !roomId ||
      !roomSynced ||
      !hasOlderMessages ||
      loadingOlderMessages ||
      !before
    )
      return;
    const generation = historyGenerationRef.current;
    setLoadingOlderMessages(true);
    socket.timeout(6000).emit(
      "room:history",
      { roomId, before },
      (error: Error | null, response?: MessageHistoryResponse) => {
        if (generation !== historyGenerationRef.current) return;
        setLoadingOlderMessages(false);
        if (error || !response?.ok) return;
        const older = response.messages ?? [];
        if (older.length) {
          setMessages((current) => mergeChatMessages(older, current));
          setHistoryLoadVersion((current) => current + 1);
        }
        messageHistoryCursorRef.current = response.cursor ?? (
          older[0]
            ? { timestamp: older[0].timestamp, id: older[0].id }
            : null
        );
        setHasOlderMessages(Boolean(response.hasMore));
      },
    );
  }, [hasOlderMessages, loadingOlderMessages, roomId, roomSynced]);
  useEffect(() => {
    if (!roomId) return;
    const onMessage = (message: Message) => {
      if (message.roomId !== roomId || !roomSyncedRef.current) return;
      setMessages((current) =>
        current.some((item) => item.id === message.id)
          ? current
          : [...current, message],
      );
      if (!chatVisibleRef.current) setUnread((current) => current + 1);
    };
    const onState = (state: RoomState) => {
      if (state.roomId !== roomId) return;
      setRoomMembers(state.members);
      setIsOwner(state.isOwner);
      setRoom((current) =>
        current
          ? {
              ...current,
              name: state.name ?? current.name,
              ownerName: state.ownerName,
              maxMembers: state.maxMembers,
              hasPassword: state.hasPassword,
              avatarUrl: state.avatarUrl ?? current.avatarUrl,
              backgroundTop: state.backgroundTop ?? current.backgroundTop,
              backgroundBottom:
                state.backgroundBottom ?? current.backgroundBottom,
              backgroundTopDark:
                state.backgroundTopDark ?? current.backgroundTopDark,
              backgroundBottomDark:
                state.backgroundBottomDark ?? current.backgroundBottomDark,
            }
          : current,
      );
      setRoomSynced(true);
    };
    const onDeleted = ({ roomId: deleted }: { roomId: string }) => {
      if (deleted === roomId) navigate("/", { replace: true });
    };
    socket.on("message:new", onMessage);
    socket.on("room:state", onState);
    socket.on("room:deleted", onDeleted);
    return () => {
      socket.off("message:new", onMessage);
      socket.off("room:state", onState);
      socket.off("room:deleted", onDeleted);
    };
  }, [roomId, navigate]);
  useEffect(() => {
    const bridge = window.coveRemoteControl;
    const onRequested = (request: RemoteControlRequest) => {
      if (request.roomId === roomId) setPendingRemote(request);
    };
    const onResult = ({
      requestId,
      accepted,
      error,
    }: {
      requestId?: string;
      accepted: boolean;
      error?: string;
    }) => {
      setPendingRemoteRequest(false);
      setPendingRemoteRequestId((current) =>
        !requestId || current === requestId ? null : current,
      );
      if (!accepted) setRemoteNotice(error ?? "远程控制请求未获批准");
    };
    const onRequestCancelled = ({
      requestId,
      reason,
    }: {
      requestId: string;
      reason?: string;
    }) => {
      setPendingRemote((current) =>
        current?.requestId === requestId ? null : current,
      );
      setPendingRemoteRequestId((current) =>
        current === requestId ? null : current,
      );
      setRemoteNotice(reason ?? "远程控制请求已取消");
    };
    const onStarted = async (session: RemoteControlSession) => {
      if (session.roomId !== roomId) return;
      if (session.role === "sharer") {
        const enabled = await bridge?.setActive(session.sessionId);
        if (!enabled) {
          socket.emit("remote-control:stop", { sessionId: session.sessionId });
          setRemoteNotice("本机远程输入组件不可用，控制已终止");
          return;
        }
      }
      setPendingRemoteRequest(false);
      setPendingRemoteRequestId(null);
      setPendingRemote(null);
      setRemoteSession(session);
    };
    const onInput = ({
      sessionId,
      input,
    }: {
      sessionId: string;
      input: RemoteControlInput;
    }) => {
      const current = remoteRef.current;
      if (current?.role === "sharer" && current.sessionId === sessionId)
        void bridge?.sendInput(sessionId, input);
    };
    const removeEmergencyListener = bridge?.onEmergencyStop(() => {
      if (remoteRef.current?.role !== "sharer") return;
      socket.emit("remote-control:stop", {
        sessionId: remoteRef.current.sessionId,
      });
      void bridge.setActive(null);
      setRemoteSession(null);
      setRemoteNotice("已通过紧急快捷键终止远程控制");
    });
    const onStopped = ({
      sessionId,
      reason,
    }: {
      sessionId: string;
      reason?: string;
    }) => {
      if (remoteRef.current?.sessionId === sessionId) {
        setPendingRemoteRequest(false);
        setRemoteSession(null);
        if (remoteRef.current.role === "sharer") void bridge?.setActive(null);
        setRemoteNotice(reason ?? "远程控制已结束");
      }
    };
    socket.on("remote-control:requested", onRequested);
    socket.on("remote-control:request-result", onResult);
    socket.on("remote-control:request-cancelled", onRequestCancelled);
    socket.on("remote-control:started", onStarted);
    socket.on("remote-control:input", onInput);
    socket.on("remote-control:stopped", onStopped);
    return () => {
      socket.off("remote-control:requested", onRequested);
      socket.off("remote-control:request-result", onResult);
      socket.off("remote-control:request-cancelled", onRequestCancelled);
      socket.off("remote-control:started", onStarted);
      socket.off("remote-control:input", onInput);
      socket.off("remote-control:stopped", onStopped);
      void bridge?.setActive(null);
      removeEmergencyListener?.();
    };
  }, [roomId]);
  const sortedMembers = useMemo(
    () =>
      sortRoomMembers(
        roomMembers,
        new Set(rtc.voiceMembers.map((member) => member.socketId)),
        rtc.localSocketId ?? socket.id,
      ),
    [roomMembers, rtc.voiceMembers, rtc.localSocketId],
  );
  const sendMessage = () => {
    if (!input.trim() || !roomId) return;
    socket.emit("message:send", { roomId, content: input.trim() });
    setInput("");
  };
  const sendImages = async (files: FileList | File[] | null) => {
    const images = files ? collectChatImageFiles(files) : [];
    if (!images.length || !roomId || imageBusy.current) return;
    if (images.length > CHAT_IMAGE_MAX_BATCH) {
      window.alert(`一次最多发送 ${CHAT_IMAGE_MAX_BATCH} 张图片。`);
      return;
    }
    for (const file of images) {
      const validationError = validateChatImageFile(file);
      if (validationError) {
        window.alert(validationError);
        return;
      }
    }
    imageBusy.current = true;
    try {
      for (const file of images) {
        const dataUrl = await readFileAsDataUrl(file);
        const response = await fetch(
          `${serverURL}/api/rooms/${roomId}/images`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              data: dataUrl.slice(dataUrl.indexOf(",") + 1),
              mimeType: chatImageMimeType(file) ?? file.type,
              socketId: socket.id,
            }),
          },
        );
        if (!response.ok) throw new Error("图片上传失败");
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "图片发送失败");
    } finally {
      imageBusy.current = false;
    }
  };
  const closeAudioModal = () => {
    setShowAudioModal(false);
  };
  const refreshAudioSources = useCallback(async () => {
    if (!window.coveApplicationAudio) return;
    setAudioLoading(true);
    try {
      setAudioSources(await window.coveApplicationAudio.listSources());
    } finally {
      setAudioLoading(false);
    }
  }, []);
  const openAudioModal = () => {
    setShowAudioModal(true);
    void refreshAudioSources();
  };
  const openScreenModal = (editing: boolean) => {
    setEditingScreen(editing && rtc.isSharing);
    setPendingPreset(rtc.screenPreset);
    setPendingFps(rtc.fps);
    setPendingAudio(rtc.shareAudio);
    setPendingGameMode(rtc.screenGameMode);
    setPendingNativeResolution(rtc.screenNativeResolution);
    setShowScreenModal(true);
  };
  const createRoom = () => {
    if (!newRoomName.trim() || creatingRoom) return;
    let payload: ReturnType<typeof createRoomPayload>;
    try {
      payload = createRoomPayload(newRoomName, newRoomLimit, newRoomPassword);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "频道设置无效");
      return;
    }
    setCreatingRoom(true);
    socket.timeout(5000).emit(
      "room:create",
      payload,
      (
        error: Error | null,
        response?: { room?: RoomWithAppearance; error?: string },
      ) => {
        setCreatingRoom(false);
        if (error || !response?.room) {
          window.alert(response?.error ?? error?.message ?? "创建频道失败");
          return;
        }
        setShowCreateRoom(false);
        setNewRoomName("");
        setNewRoomLimit("");
        setNewRoomPassword("");
        navigate(`/room/${response.room.id}`);
      },
    );
  };
  const deleteRoomById = (targetRoomId: string) => {
    if (!targetRoomId) return;
    socket
      .timeout(5000)
      .emit(
        "room:delete",
        { roomId: targetRoomId },
        (error: Error | null, response?: { ok?: boolean; error?: string }) => {
          if (error || !response?.ok) {
            window.alert(response?.error ?? error?.message ?? "删除频道失败");
            return;
          }
          // The settings dialog can be opened for any owned room in the rail,
          // not only the room currently shown in the URL.  Close the dialog
          // and remove exactly the room confirmed by the user; the room:
          // deleted listener handles navigation when that room is current.
          setRooms((current) =>
            current.filter((item) => item.id !== targetRoomId),
          );
          setRoomSettings((current) =>
            current?.id === targetRoomId ? null : current,
          );
        },
      );
  };
  const requestRemote = () => {
    const target = rtc.remoteScreen?.socketId;
    if (!target || !roomId || pendingRemoteRequest) return;
    setPendingRemoteRequest(true);
    socket
      .timeout(5000)
      .emit(
        "remote-control:request",
        { roomId, sharerSocketId: target },
        (
          error: Error | null,
          response?: { ok?: boolean; requestId?: string; error?: string },
        ) => {
          if (error || !response?.ok) {
            setPendingRemoteRequest(false);
            setPendingRemoteRequestId(null);
            setRemoteNotice(response?.error ?? "请求失败");
          } else setPendingRemoteRequestId(response.requestId ?? null);
        },
      );
  };
  const respondRemote = (accepted: boolean) => {
    if (!pendingRemote) return;
    socket.emit("remote-control:respond", {
      requestId: pendingRemote.requestId,
      accepted,
    });
    setPendingRemote(null);
  };
  const stopRemote = () => {
    if (remoteSession)
      socket.emit("remote-control:stop", {
        sessionId: remoteSession.sessionId,
      });
    else if (pendingRemoteRequestId)
      socket.emit("remote-control:cancel", {
        requestId: pendingRemoteRequestId,
      });
    if (remoteSession?.role === "sharer")
      void window.coveRemoteControl?.setActive(null);
    const cancelledRequest = !remoteSession && Boolean(pendingRemoteRequestId);
    setPendingRemoteRequest(false);
    setPendingRemoteRequestId(null);
    setPendingRemote(null);
    setRemoteSession(null);
    if (cancelledRequest) setRemoteNotice("远程控制请求已取消");
  };
  const sendRemoteInput = useCallback((inputValue: RemoteControlInput) => {
    const current = remoteRef.current;
    if (current?.role === "controller")
      socket.emit("remote-control:input", {
        sessionId: current.sessionId,
        input: inputValue,
      });
  }, []);
  const muteMember = (member: RoomMember) => {
    if (!roomId || !isOwner || member.isOwner) return;
    socket
      .timeout(5000)
      .emit(
        "room:set-muted",
        { roomId, targetSocketId: member.socketId, muted: !member.isMuted },
        (error: Error | null, response?: { ok?: boolean; error?: string }) => {
          if (error || !response?.ok)
            window.alert(response?.error ?? error?.message ?? "禁言操作失败");
          else setMemberMenu(null);
        },
      );
  };
  const removeMember = (member: RoomMember) => {
    if (
      !roomId ||
      !isOwner ||
      member.isOwner ||
      !window.confirm(`确定将“${member.username}”移出房间吗？`)
    )
      return;
    socket
      .timeout(5000)
      .emit(
        "room:kick",
        { roomId, targetSocketId: member.socketId },
        (error: Error | null, response?: { ok?: boolean; error?: string }) => {
          if (error || !response?.ok)
            window.alert(response?.error ?? error?.message ?? "移出房间失败");
          else setMemberMenu(null);
        },
      );
  };
  const applyRoomSettings = (changes: Record<string, unknown>) => {
    if (!roomId) return;
    socket.timeout(5000).emit(
      "room:update-settings",
      { roomId, ...changes },
      (
        error: Error | null,
        response?: {
          ok?: boolean;
          room?: RoomWithAppearance;
          error?: string;
        },
      ) => {
        if (error || !response?.ok) {
          window.alert(response?.error ?? error?.message ?? "设置保存失败");
          return;
        }
        if (response.room) {
          setRoom(response.room);
          setRooms((current) =>
            current.map((item) =>
              item.id === response.room!.id ? response.room! : item,
            ),
          );
        }
        setRoomSettings(null);
        refreshRooms();
      },
    );
  };
  const leave = () => {
    rtc.leaveVoice();
    navigate("/");
  };
  const retryJoin = () => {
    if (!roomId || joining) return;
    setJoinError("");
    setJoinRetryNonce((current) => current + 1);
  };
  const roomTop =
    theme === "dark"
      ? roomColor(room?.backgroundTopDark, ROOM_DARK_TOP)
      : roomColor(room?.backgroundTop, ROOM_LIGHT_TOP);
  const roomBottom =
    theme === "dark"
      ? roomColor(room?.backgroundBottomDark, ROOM_DARK_BOTTOM)
      : roomColor(room?.backgroundBottom, ROOM_LIGHT_BOTTOM);
  const appearanceStyle = {
    "--room-top": roomTop,
    "--room-bottom": roomBottom,
    "--member-width": "340px",
  } as React.CSSProperties;
  const foreground =
    (colorLuminance(roomTop) + colorLuminance(roomBottom)) /
      2 <
    0.45
      ? "light"
      : "dark";
  if (!room || !roomSynced || !messagesLoaded)
    return (
      <div className={`cove-v2-loading foreground-${foreground}`} style={appearanceStyle}>
        <section>
          {joinError ? (
            <>
              <h2>
                {room?.hasPassword
                  ? `「${room.name}」被加密`
                  : `无法进入「${room?.name ?? "频道"}」`}
              </h2>
              <p>{joinError}</p>
              {room?.hasPassword && (
                <input
                  value={joinPassword}
                  onChange={(event) => setJoinPassword(event.target.value)}
                  type="password"
                  placeholder="房间密码"
                />
              )}
            </>
          ) : (
            <>
              <LoaderCircle size={24} className="spin" />
              <p>{joining ? "正在加入频道…" : "加载频道…"}</p>
            </>
          )}
          <div>
            <button onClick={() => navigate("/")}>返回</button>
            {joinError && (
              <button onClick={retryJoin}>
                {room?.hasPassword ? "进入" : "重试"}
              </button>
            )}
          </div>
        </section>
      </div>
    );
  const mode = rtc.localScreen
    ? "self"
    : rtc.remoteScreen
      ? "watching"
      : rtc.availableScreens.length
        ? "available"
        : "idle";
  const remoteState: "available" | "pending" | "active" | "unsupported" =
    remoteSession?.role === "controller"
      ? "active"
      : pendingRemoteRequest
        ? "pending"
        : rtc.remoteScreen &&
            roomMembers.find(
              (member) => member.socketId === rtc.remoteScreen?.socketId,
            )?.canReceiveRemoteControl &&
            window.coveRemoteControl?.supported
          ? "available"
          : "unsupported";
  return (
    <main className={`prototype-page cove-v2-page foreground-${foreground}`}>
      <div
        className={`cove-shell ${sidebarOpen ? "nav-wide" : "nav-narrow"} mode-${mode} foreground-${foreground} ${chatVisible ? "chat-open" : "chat-closed"}`}
        style={appearanceStyle}
      >
        <NavigationRailV2
          rooms={rooms}
          activeRoom={roomId ?? ""}
          profileName={profile.username}
          onRoom={(id) => navigate(`/room/${id}`)}
          expanded={sidebarOpen}
          setExpanded={setSidebarOpen}
          onSettings={() => {
            setGlobalSettingsPage("audio");
            setGlobalSettings(true);
          }}
          onRoomSettings={setRoomSettings}
          onCreate={() => setShowCreateRoom(true)}
        />
        <section className="workspace">
          {!shareLayout ? (
            <>
              <header className="workspace-header">
                <span className="workspace-room-avatar">
                  {room.avatarUrl ? (
                    <img src={room.avatarUrl} alt="" />
                  ) : (
                    room.name.slice(0, 1)
                  )}
                </span>
                <div>
                  <h1>{room.name}</h1>
                  <span className="voice-count-line">
                    <Microphone size={16} weight="fill" />
                    {rtc.voiceMembers.length} 人语音中
                  </span>
                </div>
              </header>
              <div className="member-list-view">
                <div className="member-rows">
                  {sortedMembers.map((member) => {
                    const voice = rtc.voiceMembers.find(
                      (item) => item.socketId === member.socketId,
                    );
                    const isSelf = member.socketId === socket.id;
                    const screen =
                      Boolean(member.isSharingScreen) ||
                      (isSelf && Boolean(rtc.localScreen)) ||
                      rtc.availableScreens.some(
                        (item) => item.socketId === member.socketId,
                      );
                    // 只根据独立的 application-audio producer 显示音频标识。
                    // 屏幕共享自带的 screen-audio 不应让“共享音频”联动亮起。
                    const audio =
                      (isSelf && rtc.isApplicationAudioSharing) ||
                      rtc.remoteApplicationAudios.some(
                        (item) => item.socketId === member.socketId,
                      );
                    const volume = isSelf
                      ? inputVolume
                      : (rtc.memberVolumes[member.socketId] ?? 1) * 100;
                    const sharedVolume = getSharedAudioVolume(member, isSelf);
                    const level =
                      rtc.speakingLevels[member.socketId] ??
                      (isSelf
                        ? rtc.speakingLevels[rtc.localSocketId ?? ""] ?? 0
                        : 0);
                    const speaking = Boolean(
                      voice &&
                        level > 0.08 &&
                        !voice.isMuted &&
                        !(isSelf && rtc.isMuted),
                    );
                    return (
                      <article
                        className={`member-row ${isSelf ? "self" : ""} ${screen ? "has-watch" : ""} ${voice ? "in-voice" : "not-in-voice"}`}
                        key={member.socketId}
                      >
                        <button
                          className="member-identity"
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setMemberMenu({
                              member,
                              x: event.clientX,
                              y: event.clientY,
                            });
                          }}
                          onClick={() =>
                            isSelf
                              ? setShowProfile(true)
                              : setViewingProfile(member)
                          }
                        >
                          <MemberAvatar
                            member={{
                              ...member,
                              isMuted: Boolean(
                                member.isMuted ||
                                  voice?.isMuted ||
                                (isSelf && rtc.isMuted),
                              ),
                            }}
                            inVoice={Boolean(voice)}
                            speaking={speaking}
                          />
                          <span className="member-name">
                            <b>
                              {isSelf
                                ? `${member.username}（你）`
                                : profileRemarks[member.userId] ||
                                  member.username}
                            </b>
                          </span>
                          <SharedBadges screen={screen} audio={audio} />
                        </button>
                        {voice && (
                          <div className="member-audio-stack">
                            <VolumeControl
                              value={volume}
                              onChange={(value) =>
                                isSelf
                                  ? setInputVolume(value)
                                  : rtc.setMemberVolume(
                                      member.socketId,
                                      member.userId,
                                      value / 100,
                                    )
                              }
                              icon={isSelf ? "mic" : "speaker"}
                              label={
                                isSelf
                                  ? "麦克风发送音量"
                                  : `${member.username} 的音量`
                              }
                              muted={
                                isSelf
                                  ? rtc.isMuted
                                  : (rtc.memberVolumes[member.socketId] ?? 1) ===
                                    0
                              }
                              level={level}
                              onMute={
                                isSelf
                                  ? rtc.toggleMute
                                  : () =>
                                      rtc.toggleMemberMute(
                                        member.socketId,
                                        member.userId,
                                      )
                              }
                            />
                            {audio && (
                              <VolumeControl
                                value={sharedVolume * 100}
                                onChange={(value) =>
                                  setSharedAudioVolume(
                                    member,
                                    isSelf,
                                    value / 100,
                                  )
                                }
                                icon="share"
                                muted={sharedVolume === 0}
                                onMute={() =>
                                  toggleSharedAudioMute(member, isSelf)
                                }
                                label={
                                  isSelf
                                    ? "共享发送音量"
                                    : `${member.username} 的共享音频音量`
                                }
                              />
                            )}
                          </div>
                        )}
                        {screen && !isSelf && (
                          <button
                            className="watch-button"
                            onClick={() => {
                              const target = rtc.availableScreens.find(
                                (item) => item.socketId === member.socketId,
                              );
                              if (target) rtc.watchScreen(target.socketId);
                            }}
                          >
                            <Eye size={18} />
                            观看共享
                          </button>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="member-strip">
                <div className="strip-scroll">
                  {sortedMembers.map((member) => {
                    const voice = rtc.voiceMembers.find(
                      (item) => item.socketId === member.socketId,
                    );
                    const screen =
                      rtc.remoteScreen?.socketId === member.socketId ||
                      Boolean(rtc.localScreen && member.socketId === socket.id);
                    // screen-audio 属于屏幕共享的附属轨道，不等同于独立的
                    // “共享音频”功能；这里只显示 application-audio。
                    const audio =
                      (member.socketId === socket.id &&
                        rtc.isApplicationAudioSharing) ||
                      rtc.remoteApplicationAudios.some(
                        (item) => item.socketId === member.socketId,
                      );
                    const isSelf = member.socketId === socket.id;
                    const sharedVolume = getSharedAudioVolume(member, isSelf);
                    const level =
                      rtc.speakingLevels[member.socketId] ??
                      (isSelf
                        ? rtc.speakingLevels[rtc.localSocketId ?? ""] ?? 0
                        : 0);
                    const speaking = Boolean(
                      voice &&
                        level > 0.08 &&
                        !voice.isMuted &&
                        !(isSelf && rtc.isMuted),
                    );
                    return (
                      <div className="strip-member" key={member.socketId}>
                        <button
                          className="strip-member-button"
                          onContextMenu={(event) => {
                            if (member.socketId === socket.id) return;
                            event.preventDefault();
                            setMemberMenu({
                              member,
                              x: event.clientX,
                              y: event.clientY,
                            });
                          }}
                          onClick={() =>
                            member.socketId === socket.id
                              ? setShowProfile(true)
                              : setViewingProfile(member)
                          }
                        >
                          <MemberAvatar
                            member={{
                              ...member,
                              isMuted: Boolean(
                                member.isMuted ||
                                  (member.socketId === socket.id &&
                                    rtc.isMuted) ||
                                  rtc.voiceMembers.find(
                                    (voice) =>
                                      voice.socketId === member.socketId,
                                )?.isMuted,
                              ),
                            }}
                            inVoice={Boolean(voice)}
                            speaking={speaking}
                          />
                          <b>
                            {member.socketId === socket.id
                              ? `${member.username}（你）`
                              : member.username}
                          </b>
                          <SharedBadges screen={screen} audio={audio} />
                        </button>
                        {voice && (
                          <div className="vertical-volume-popover popover-card">
                            <VerticalVolume
                              value={
                                member.socketId === socket.id
                                  ? inputVolume
                                  : (rtc.memberVolumes[member.socketId] ?? 1) *
                                    100
                              }
                              onChange={(value) =>
                                member.socketId === socket.id
                                  ? setInputVolume(value)
                                  : rtc.setMemberVolume(
                                      member.socketId,
                                      member.userId,
                                      value / 100,
                                    )
                              }
                              label="语音"
                              icon={isSelf ? "mic" : "speaker"}
                              muted={
                                isSelf
                                  ? rtc.isMuted
                                  : (rtc.memberVolumes[member.socketId] ?? 1) ===
                                    0
                              }
                              level={level}
                              onMute={
                                isSelf
                                  ? rtc.toggleMute
                                  : () =>
                                      rtc.toggleMemberMute(
                                        member.socketId,
                                        member.userId,
                                      )
                              }
                            />
                            {audio && (
                              <VerticalVolume
                                value={sharedVolume * 100}
                                onChange={(value) =>
                                  setSharedAudioVolume(
                                    member,
                                    isSelf,
                                    value / 100,
                                  )
                                }
                                label="共享"
                                colorClass="purple"
                                icon="share"
                                muted={sharedVolume === 0}
                                onMute={() =>
                                  toggleSharedAudioMute(member, isSelf)
                                }
                              />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="strip-chat-button-anchor">
                  <button
                    type="button"
                    className={`strip-chat-button ${chatOpen ? "active" : ""}`}
                    onClick={() => {
                      setChatOpen((value) => !value);
                      setUnread(0);
                    }}
                  >
                    <ChatCircleDots size={19} weight="fill" />
                    <span>聊天</span>
                    {unread > 0 && <i>{unread}</i>}
                  </button>
                </div>
              </div>
              <div className="share-layout-body">
                <ShareViewV2
                  rtc={rtc}
                  debug={debug}
                  onToggleDebug={() => {
                    setDebug((value) => !value);
                    rtc.toggleStats();
                  }}
                  remoteControl={{
                    state: remoteState,
                    notice: remoteNotice,
                    sharerActive: remoteSession?.role === "sharer",
                    controllerName: remoteSession?.controllerName,
                  }}
                  onInput={sendRemoteInput}
                  onRequestRemote={requestRemote}
                  onStopRemote={stopRemote}
                  onEnd={() =>
                    rtc.localScreen
                      ? rtc.stopScreenShare()
                      : rtc.stopWatchingScreen()
                  }
                  diagnosticsCompact={diagnosticsCompact}
                  onToggleDiagnosticsCompact={() =>
                    setDiagnosticsCompact((value) => !value)
                  }
                />
              </div>
            </>
          )}
        </section>
        <div className="chat-slot">
          {chatVisible && (
            <ChatPanelV2
              key={roomId}
              messages={messages}
              profile={profile}
              serverURL={serverURL}
              input={input}
              setInput={setInput}
              onSend={sendMessage}
              onSendImages={sendImages}
              compact={shareLayout}
              unread={unread}
              fontSize={chatFontSize}
              onFontSizeChange={updateChatFontSize}
              hasOlderMessages={hasOlderMessages}
              loadingOlderMessages={loadingOlderMessages}
              historyLoadVersion={historyLoadVersion}
              onLoadOlderMessages={loadOlderMessages}
            />
          )}
        </div>
        <ControlBallV2
          rtc={rtc}
          mode={mode}
          onLeave={leave}
          onLeaveVoice={rtc.leaveVoice}
          onStartScreen={() => openScreenModal(false)}
          onEditScreen={() => openScreenModal(true)}
          onStartAudio={() => void openAudioModal()}
          onToggleDebug={() => {
            setDebug((value) => !value);
            rtc.toggleStats();
          }}
          debug={debug}
          onOpenDevices={() => {
            setGlobalSettingsPage("audio");
            setGlobalSettings(true);
          }}
          onOpenSoundboard={openSoundboard}
          soundboardButtonRef={soundboardButtonRef}
          onSoundboardHoverStart={openSoundboardQuick}
          onSoundboardHoverEnd={closeSoundboardQuick}
        />
        {showAudioModal && (
          <AudioShareMenuV2
            sources={audioSources}
            loading={audioLoading}
            onClose={closeAudioModal}
            onRefresh={() => void refreshAudioSources()}
            onSystemAudio={() => {
              closeAudioModal();
              void rtc.startSystemAudioShare();
            }}
            onApplicationAudio={(source) => {
              closeAudioModal();
              void rtc.startApplicationAudioShare(source);
            }}
          />
        )}
      </div>
      {memberMenu && (
        <MemberMenu
          member={memberMenu.member}
          x={memberMenu.x}
          y={memberMenu.y}
          onClose={() => setMemberMenu(null)}
          onProfile={() => {
            setMemberMenu(null);
            setViewingProfile(memberMenu.member);
          }}
          onRemark={() => {
            setMemberMenu(null);
            setViewingProfile(memberMenu.member);
          }}
          onMute={() => muteMember(memberMenu.member)}
          onRemove={() => removeMember(memberMenu.member)}
          canModerate={isOwner && !memberMenu.member.isOwner}
        />
      )}
      {showCreateRoom && (
        <CreateRoomDialog
          name={newRoomName}
          maxMembers={newRoomLimit}
          password={newRoomPassword}
          submitting={creatingRoom}
          onName={setNewRoomName}
          onMaxMembers={setNewRoomLimit}
          onPassword={setNewRoomPassword}
          onSubmit={() => void createRoom()}
          onClose={() => setShowCreateRoom(false)}
        />
      )}
      {roomSettings && (
        <RoomAppearanceSettings
          room={roomSettings}
          onSave={applyRoomSettings}
          onClose={() => setRoomSettings(null)}
          onDelete={() => {
            const targetRoomId = roomSettings?.id;
            if (targetRoomId) deleteRoomById(targetRoomId);
          }}
          theme={theme}
        />
      )}
      {globalSettings && (
        <GlobalSettingsV2
          profile={profile}
          accountId={accountId}
          onProfileChange={onProfileChange}
          onLogout={onLogout}
          inputVolume={inputVolume}
          outputVolume={outputVolume}
          setInputVolume={setInputVolume}
          setOutputVolume={setOutputVolume}
          rtc={rtc}
          initialPage={globalSettingsPage}
          onClose={() => setGlobalSettings(false)}
          theme={theme}
          onThemeChange={onThemeChange}
        />
      )}
      <SoundPackPanel
        socket={socket}
        roomId={roomId!}
        serverURL={serverURL}
        outputDeviceId={rtc.selectedAudioOutputId}
        inVoice={rtc.inVoice}
        disabled={!sessionReady || !roomSynced}
        hideTrigger
        open={showSoundboard}
        onClose={() => setShowSoundboard(false)}
        compact
        anchorRef={soundboardButtonRef}
        quickOpen={showSoundboardQuick}
        onQuickOpen={openSoundboardQuick}
        onQuickClose={closeSoundboardQuick}
      />
      {showProfile && (
        <ProfileModal
          profile={profile}
          serverURL={serverURL}
          onSave={onProfileChange}
          onClose={() => setShowProfile(false)}
        />
      )}
      {viewingProfile && (
        <UserProfileModal
          userId={viewingProfile.userId}
          username={viewingProfile.username}
          avatarUrl={viewingProfile.avatarUrl}
          remark={profileRemarks[viewingProfile.userId]}
          onSaveRemark={(remark) =>
            setProfileRemarks((current) =>
              saveProfileRemark(current, viewingProfile.userId, remark),
            )
          }
          onClose={() => setViewingProfile(null)}
        />
      )}
      {showScreenModal && (
        <ScreenShareSettingsV2
          preset={pendingPreset}
          fps={pendingFps}
          audio={pendingAudio}
          gameMode={pendingGameMode}
          nativeResolution={pendingNativeResolution}
          onNativeResolution={setPendingNativeResolution}
          confirmLabel={editingScreen ? "更新共享" : "开始共享"}
          onPreset={setPendingPreset}
          onFps={setPendingFps}
          onAudio={() => setPendingAudio((value) => !value)}
          onGameMode={() =>
            setPendingGameMode((value) => {
              const next = !value;
              if (next) setPendingFps(60);
              return next;
            })
          }
          onConfirm={() => {
            const shouldUpdate = editingScreen && rtc.isSharing;
            setEditingScreen(false);
            setShowScreenModal(false);
            const update = shouldUpdate
              ? rtc.updateScreenShare
              : rtc.startScreenShare;
            void update(
              pendingPreset,
              pendingFps,
              pendingAudio,
              pendingGameMode,
              pendingNativeResolution,
            );
          }}
          onCancel={() => {
            setEditingScreen(false);
            setShowScreenModal(false);
          }}
        />
      )}
      {pendingRemote && (
        <div className="modal-scrim">
          <section className="remote-request popover-card">
            <MousePointer2 size={25} />
            <h2>远程控制请求</h2>
            <p>{pendingRemote.controllerName} 请求控制你正在共享的屏幕。</p>
            <div>
              <button onClick={() => respondRemote(false)}>拒绝</button>
              <button
                className="primary-wide"
                onClick={() => respondRemote(true)}
              >
                允许本次控制
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
