import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { socket } from '../connection/socket';
import { useWebRTC, type Fps } from '../media/useWebRTC';

import { UPDATE_CENTER_DETAILS_EVENT } from '../updates/update';
import { getProfileDisplayName, loadProfileRemarks } from '../profiles/profileRemarks';
import { createRoomPayload } from './roomSettings';
import { sortRoomMembers } from './memberOrdering';
import { useShareLayout } from './useShareLayout';
import {
  CHAT_IMAGE_MAX_BATCH,
  chatImageMimeType,
  collectChatImageFiles,
  validateChatImageFile,
} from '../chat/chatImages';
import { serverFetch } from '../connection/serverSecurity';
import type { Message, RoomMember, RoomState, UserProfile } from '../../types';
import { type RemoteControlInput } from '../remote-control/remoteControl';
import type { ApplicationAudioSource } from '../media/application-audio/applicationAudio';
import {
  RemoteControlLifecycle,
  type RemoteControlSession,
} from '../remote-control/remoteControlSession';
import type { AppTheme } from '../settings/theme';
import {
  RoomWithAppearance,
  roomColor,
  ROOM_DARK_TOP,
  ROOM_LIGHT_TOP,
  ROOM_DARK_BOTTOM,
  ROOM_LIGHT_BOTTOM,
  colorLuminance,
} from './appearance';
import {
  ChatFontSize,
  readChatFontSize,
  CHAT_FONT_SIZE_STORAGE_KEY,
} from '../settings/ChatFontMenu';
import { GlobalSettingsPage } from '../settings/components/GlobalSettingsV2';
import { mergeChatMessages, readFileAsDataUrl } from '../chat/ChatPanelV2';

import '../../styles/ui-v2.css';
export interface ChatRoomProps {
  profile: UserProfile;
  accountId: string;
  onProfileChange: (profile: UserProfile) => void;
  onLogout: () => void;
  serverURL: string;
  sessionReady: boolean;
  theme: AppTheme;
  onThemeChange: (theme: AppTheme) => void;
}
export interface RemoteControlRequest {
  requestId: string;
  roomId: string;
  controllerName: string;
  controllerUserId?: string;
}
const REMOTE_CONTROL_REQUEST_COOLDOWN_SECONDS = 10;
export interface MessageHistoryCursor {
  timestamp: number;
  id: string;
}
export interface MessageHistoryResponse {
  ok?: boolean;
  messages?: Message[];
  hasMore?: boolean;
  cursor?: MessageHistoryCursor | null;
}

export function useRoomController({ profile, serverURL, sessionReady, theme }: ChatRoomProps) {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const rtc = useWebRTC(socket, roomId ?? '');
  const inputVolume = rtc.microphoneVolume * 100;
  const setInputVolume = (value: number) => rtc.setMicrophoneVolume(value / 100);
  const sharedAudioMuteRestore = useRef<Record<string, number>>({});
  const sharedAudioKey = (member: RoomMember, isSelf: boolean) =>
    isSelf ? 'self-application' : `remote:${member.socketId}`;
  const getSharedAudioVolume = (member: RoomMember, isSelf: boolean) =>
    isSelf
      ? rtc.applicationAudioShareVolume
      : rtc.applicationAudioReceiveVolumes[member.socketId] ?? 1;
  const setSharedAudioVolume = (member: RoomMember, isSelf: boolean, value: number) => {
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
      setSharedAudioVolume(member, isSelf, sharedAudioMuteRestore.current[key] ?? 1);
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
  const [roomSynced, setRoomSynced] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [joinRetryNonce, setJoinRetryNonce] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [historyLoadVersion, setHistoryLoadVersion] = useState(0);
  const [input, setInput] = useState('');
  const [imageError, setImageError] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [chatFontSize, setChatFontSize] = useState<ChatFontSize>(readChatFontSize);
  const shareLayout = Boolean(rtc.localScreen || rtc.remoteScreen);
  const { chatOpen, animateShareChat, setChatOpen, sidebarOpen, setSidebarOpen, animateLayoutControls } =
    useShareLayout(shareLayout);
  const [roomSettings, setRoomSettings] = useState<RoomWithAppearance | null>(null);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomLimit, setNewRoomLimit] = useState('');
  const [newRoomPassword, setNewRoomPassword] = useState('');
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [globalSettings, setGlobalSettings] = useState(false);
  const [globalSettingsPage, setGlobalSettingsPage] = useState<GlobalSettingsPage>('audio');
  const [showSoundboard, setShowSoundboard] = useState(false);
  const [showSoundboardQuick, setShowSoundboardQuick] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [viewingProfile, setViewingProfile] = useState<RoomMember | null>(null);
  const [profileRemarks, setProfileRemarks] = useState(loadProfileRemarks);
  const [showScreenModal, setShowScreenModal] = useState(false);
  const [editingScreen, setEditingScreen] = useState(false);
  const [pendingPreset, setPendingPreset] = useState<'540p' | '720p' | '1080p' | '1440p'>('720p');
  const [pendingFps, setPendingFps] = useState<Fps>(30);
  const [pendingAudio, setPendingAudio] = useState(false);
  const [pendingGameMode, setPendingGameMode] = useState(false);
  const [pendingNativeResolution, setPendingNativeResolution] = useState(false);
  const [showAudioModal, setShowAudioModal] = useState(false);
  const [audioSources, setAudioSources] = useState<ApplicationAudioSource[]>([]);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioSourceError, setAudioSourceError] = useState('');
  const [pendingRemote, setPendingRemote] = useState<RemoteControlRequest | null>(null);
  const [pendingRemoteRequest, setPendingRemoteRequest] = useState(false);
  const [pendingRemoteRequestId, setPendingRemoteRequestId] = useState<string | null>(null);
  const [remoteRequestCooldownSeconds, setRemoteRequestCooldownSeconds] = useState(0);
  const [remoteSession, setRemoteSession] = useState<RemoteControlSession | null>(null);
  const [remoteNotice, setRemoteNotice] = useState('');
  const [memberMenu, setMemberMenu] = useState<{
    socketId: string;
    username: string;
    muted: boolean;
    x: number;
    y: number;
  } | null>(null);
  const [draggingVolumeMember, setDraggingVolumeMember] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const [diagnosticsCompact, setDiagnosticsCompact] = useState(false);
  useEffect(() => {
    const socketId = socket.id;
    if (!socketId) return;
    setRoomMembers((current) => {
      let changed = false;
      const next = current.map((member) => {
        if (member.socketId !== socketId && member.username !== profile.username) return member;
        if (member.username === profile.username && member.avatarUrl === profile.avatarUrl)
          return member;
        changed = true;
        return { ...member, username: profile.username, avatarUrl: profile.avatarUrl };
      });
      return changed ? next : current;
    });
  }, [profile.username, profile.avatarUrl, roomId]);
  useEffect(() => {
    setImageError(null);
  }, [roomId]);
  const outputVolume = rtc.masterOutputVolume * 100;
  const setOutputVolume = (value: number) => rtc.setMasterOutputVolume(value / 100);
  const updateChatFontSize = (value: ChatFontSize) => {
    setChatFontSize(value);
    try {
      window.localStorage.setItem(CHAT_FONT_SIZE_STORAGE_KEY, value);
    } catch {
      // 本地存储不可用时仍即时应用字号。
    }
  };
  const remoteLifecycleRef = useRef<RemoteControlLifecycle | null>(null);
  const roomSyncedRef = useRef(false);
  const joinPasswordRef = useRef('');
  const roomJoinGenerationRef = useRef(0);
  const messageHistoryCursorRef = useRef<MessageHistoryCursor | null>(null);
  const historyGenerationRef = useRef(0);
  const imageBusy = useRef(false);
  const soundboardButtonRef = useRef<HTMLButtonElement>(null);
  const soundboardAnchorRef = useRef<HTMLDivElement>(null);
  const soundboardHoverTimer = useRef<number | null>(null);
  joinPasswordRef.current = joinPassword;
  const chatVisible = !shareLayout || chatOpen;
  const isRoomOwner = roomMembers.some((member) => member.socketId === socket.id && member.isOwner);
  const chatVisibleRef = useRef(chatVisible);
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
    soundboardHoverTimer.current = window.setTimeout(() => {
      setShowSoundboardQuick(false);
      soundboardHoverTimer.current = null;
    }, 180);
  };
  const openSoundboard = () => {
    clearSoundboardHoverTimer();
    setShowSoundboardQuick(false);
    setShowSoundboard((current) => !current);
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
    roomSyncedRef.current = roomSynced;
  }, [roomSynced]);
  useEffect(() => {
    // Remote-control messages are meaningful only while a share is visible.
    // Clear the transient state as soon as both local and remote media leave
    // the layout so an old “屏幕共享已结束” notice cannot leak into a later
    // share session.
    if (shareLayout) return;
    setRemoteNotice('');
    setPendingRemote(null);
    setPendingRemoteRequest(false);
    setPendingRemoteRequestId(null);
    setRemoteSession(null);
  }, [shareLayout]);
  useEffect(() => {
    // 聊天栏重新可见时，清除之前在收起期间累积的提示。
    if (chatVisible) setUnread(0);
  }, [chatVisible]);
  useEffect(() => {
    const handleUpdateDetails = () => {
      setGlobalSettingsPage('update');
      setGlobalSettings(true);
    };
    window.addEventListener(UPDATE_CENTER_DETAILS_EVENT, handleUpdateDetails);
    return () => window.removeEventListener(UPDATE_CENTER_DETAILS_EVENT, handleUpdateDetails);
  }, []);
  const refreshRooms = useCallback(() => {
    serverFetch(serverURL, '/api/rooms')
      .then((response) => (response.ok ? response.json() : []))
      .then((data) =>
        setRooms((current) =>
          (data as RoomWithAppearance[]).map((room) => ({
            ...room,
            isOwner: room.isOwner ?? current.find((item) => item.id === room.id)?.isOwner,
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
          isOwner: room.isOwner ?? current.find((item) => item.id === room.id)?.isOwner,
          count: voiceCounts[room.id] ?? room.count ?? 0,
        })),
      );
    const onCounts = (next: Record<string, number>) => {
      setVoiceCounts(next);
      setRooms((current) => current.map((room) => ({ ...room, count: next[room.id] ?? 0 })));
    };
    socket.on('rooms:updated', onRooms);
    socket.on('voice:counts', onCounts);
    socket
      .timeout(5000)
      .emit(
        'rooms:get',
        (error: Error | null, response?: { ok?: boolean; rooms?: RoomWithAppearance[] }) => {
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
      socket.off('rooms:updated', onRooms);
      socket.off('voice:counts', onCounts);
    };
  }, [refreshRooms, voiceCounts]);
  useEffect(() => {
    const next = rooms.find((item) => item.id === roomId);
    if (next) setRoom((current) => (current ? { ...current, ...next } : current));
  }, [rooms, roomId]);
  useEffect(() => {
    if (!roomId) return;
    let active = true;
    serverFetch(serverURL, `/api/rooms/${roomId}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('房间不存在'))))
      .then((next) => {
        if (active) setRoom(next as RoomWithAppearance);
      })
      .catch(() => {
        if (active) navigate('/');
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
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
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
      setJoinError('');
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
        scheduleRetry('加入频道超时，请检查服务器连接后重试');
        return;
      }

      requestInFlight = true;
      const requestId = ++requestSerial;
      const payload = {
        roomId,
        ...(joinPasswordRef.current ? { password: joinPasswordRef.current } : {}),
      };
      socket
        .timeout(5_000)
        .emit(
          'room:join',
          payload,
          (error: Error | null, response: { ok?: boolean; error?: string; code?: string }) => {
            if (
              !active ||
              generation !== roomJoinGenerationRef.current ||
              requestId !== requestSerial
            )
              return;
            requestInFlight = false;
            if (error) {
              if (!socket.connected || error.message === 'operation has timed out') {
                scheduleRetry('加入频道超时，请检查服务器连接后重试');
              } else {
                failJoin(error.message || '无法加入频道');
              }
              return;
            }
            if (!response?.ok) {
              // The server's joinPending guard is transient; retry it instead
              // of exposing a false room failure during a reconnect race.
              if (response?.code === 'RATE_LIMITED' && response.error === '正在加入，请稍候') {
                scheduleRetry('加入频道超时，请检查服务器连接后重试');
              } else if (response?.code === 'NOT_REGISTERED') {
                scheduleRetry('登录连接正在恢复，请稍候');
              } else {
                failJoin(response?.error ?? '无法加入频道');
              }
              return;
            }
            joined = true;
            clearRetryTimer();
            retryCount = 0;
            socket.off('connect', onConnect);
            setJoining(false);
            setJoinError('');
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
      scheduleRetry('登录连接正在恢复，请稍候');
    };

    setJoining(true);
    setRoomSynced(false);
    setJoinError('');
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    attemptJoin();
    return () => {
      active = false;
      requestSerial += 1;
      requestInFlight = false;
      clearRetryTimer();
      roomJoinGenerationRef.current += 1;
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [roomId, sessionReady, joinRetryNonce]);
  useEffect(() => {
    if (!roomId) return;
    const leaveVoice = rtc.leaveVoice;
    return () => {
      if (socket.connected) socket.emit('room:leave', roomId);
      else
        socket.once('connect', () => {
          if (socket.recovered) socket.emit('room:leave', roomId);
        });
      leaveVoice();
    };
  }, [roomId]);
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
        'room:history',
        { roomId },
        (error: Error | null, response?: MessageHistoryResponse) => {
          if (!active || generation !== historyGenerationRef.current) return;
          if (!error && response?.ok) {
            const history = response.messages ?? [];
            setMessages((current) => mergeChatMessages(current, history));
            messageHistoryCursorRef.current =
              response.cursor ??
              (history[0] ? { timestamp: history[0].timestamp, id: history[0].id } : null);
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
    if (!roomId || !roomSynced || !hasOlderMessages || loadingOlderMessages || !before) return;
    const generation = historyGenerationRef.current;
    setLoadingOlderMessages(true);
    socket
      .timeout(6000)
      .emit(
        'room:history',
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
          messageHistoryCursorRef.current =
            response.cursor ??
            (older[0] ? { timestamp: older[0].timestamp, id: older[0].id } : null);
          setHasOlderMessages(Boolean(response.hasMore));
        },
      );
  }, [hasOlderMessages, loadingOlderMessages, roomId, roomSynced]);
  useEffect(() => {
    if (!roomId) return;
    const onMessage = (message: Message) => {
      if (message.roomId !== roomId || !roomSyncedRef.current) return;
      setMessages((current) =>
        current.some((item) => item.id === message.id) ? current : [...current, message],
      );
      if (!chatVisibleRef.current) setUnread((current) => current + 1);
    };
    const onState = (state: RoomState) => {
      if (state.roomId !== roomId) return;
      setRoomMembers(state.members);
      setRoom((current) =>
        current
          ? {
              ...current,
              name: state.name ?? current.name,
              ownerName: state.ownerName,
              ownerUserId: state.ownerUserId ?? current.ownerUserId,
              maxMembers: state.maxMembers,
              hasPassword: state.hasPassword,
              avatarUrl: state.avatarUrl ?? current.avatarUrl,
              backgroundTop: state.backgroundTop ?? current.backgroundTop,
              backgroundBottom: state.backgroundBottom ?? current.backgroundBottom,
              backgroundTopDark: state.backgroundTopDark ?? current.backgroundTopDark,
              backgroundBottomDark: state.backgroundBottomDark ?? current.backgroundBottomDark,
            }
          : current,
      );
      setRoomSynced(true);
    };
    const onDeleted = ({ roomId: deleted }: { roomId: string }) => {
      if (deleted === roomId) navigate('/', { replace: true });
    };
    // 被房主移出频道后必须真的离开房间界面，否则会停留在已经失去成员身份的房间。
    const onKicked = ({
      roomId: kicked,
      by,
      byUserId,
    }: {
      roomId: string;
      by?: string;
      byUserId?: string;
    }) => {
      if (kicked !== roomId) return;
      navigate('/', {
        replace: true,
        state: {
          roomKickNotice: `你已被${getProfileDisplayName(
            by ?? '房主',
            byUserId,
            profileRemarks,
          )}移出频道。`,
        },
      });
    };
    socket.on('message:new', onMessage);
    socket.on('room:state', onState);
    socket.on('room:deleted', onDeleted);
    socket.on('room:kicked', onKicked);
    return () => {
      socket.off('message:new', onMessage);
      socket.off('room:state', onState);
      socket.off('room:deleted', onDeleted);
      socket.off('room:kicked', onKicked);
    };
  }, [roomId, navigate, profileRemarks]);
  useEffect(() => {
    const bridge = window.coveRemoteControl;
    const lifecycle = new RemoteControlLifecycle({
      roomId: roomId ?? '',
      socket,
      bridge,
      onSession: (session) => {
        setRemoteSession(session);
        setPendingRemoteRequest(false);
        setPendingRemoteRequestId(null);
        setPendingRemote(null);
      },
      onNotice: setRemoteNotice,
    });
    remoteLifecycleRef.current = lifecycle;
    const onRequested = (request: RemoteControlRequest) => {
      if (request.roomId !== roomId) return;
      setPendingRemote(request);
      // 审批界面必须立刻可见：窗口在后台/被遮挡时也要拉到最前。
      void window.coveWindow?.focus();
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
      if (!accepted) {
        lifecycle.cancelExpectedStart();
        setRemoteNotice(error ?? '远程控制请求未获批准');
      }
    };
    const onRequestCancelled = ({ requestId, reason }: { requestId: string; reason?: string }) => {
      lifecycle.cancelExpectedStart();
      setPendingRemote((current) => (current?.requestId === requestId ? null : current));
      setPendingRemoteRequestId((current) => (current === requestId ? null : current));
      setRemoteNotice(reason ?? '远程控制请求已取消');
    };
    socket.on('remote-control:requested', onRequested);
    socket.on('remote-control:request-result', onResult);
    socket.on('remote-control:request-cancelled', onRequestCancelled);
    return () => {
      socket.off('remote-control:requested', onRequested);
      socket.off('remote-control:request-result', onResult);
      socket.off('remote-control:request-cancelled', onRequestCancelled);
      lifecycle.dispose();
      if (remoteLifecycleRef.current === lifecycle) remoteLifecycleRef.current = null;
    };
  }, [roomId]);
  useEffect(() => {
    if (remoteRequestCooldownSeconds <= 0) return;
    const timer = window.setTimeout(() => {
      setRemoteRequestCooldownSeconds((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [remoteRequestCooldownSeconds]);
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
    socket.emit('message:send', { roomId, content: input.trim() });
    setInput('');
  };
  const sendImages = async (files: FileList | File[] | null) => {
    const images = files ? collectChatImageFiles(files) : [];
    if (!images.length || !roomId || imageBusy.current) return;
    if (images.length > CHAT_IMAGE_MAX_BATCH) {
      setImageError(`一次最多发送 ${CHAT_IMAGE_MAX_BATCH} 张图片。`);
      return;
    }
    for (const file of images) {
      const validationError = validateChatImageFile(file);
      if (validationError) {
        setImageError(validationError);
        return;
      }
    }
    setImageError(null);
    imageBusy.current = true;
    try {
      for (const file of images) {
        const dataUrl = await readFileAsDataUrl(file);
        const response = await serverFetch(serverURL, `/api/rooms/${roomId}/images`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: dataUrl.slice(dataUrl.indexOf(',') + 1),
            mimeType: chatImageMimeType(file) ?? file.type,
            socketId: socket.id,
          }),
        });
        const result = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) throw new Error(result.error ?? `图片上传失败（${response.status}）`);
      }
    } catch (error) {
      setImageError(error instanceof Error ? error.message : '图片发送失败');
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
    setAudioSourceError('');
    try {
      setAudioSources(await window.coveApplicationAudio.listSources());
    } catch (error) {
      setAudioSourceError(error instanceof Error ? error.message : '请刷新后重试。');
    } finally {
      setAudioLoading(false);
    }
  }, []);
  const openAudioModal = () => {
    setShowAudioModal(true);
    void refreshAudioSources();
  };
  const openScreenModal = (editing: boolean) => {
    setRemoteNotice('');
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
      window.alert(error instanceof Error ? error.message : '频道设置无效');
      return;
    }
    setCreatingRoom(true);
    socket
      .timeout(5000)
      .emit(
        'room:create',
        payload,
        (error: Error | null, response?: { room?: RoomWithAppearance; error?: string }) => {
          setCreatingRoom(false);
          if (error || !response?.room) {
            window.alert(response?.error ?? error?.message ?? '创建频道失败');
            return;
          }
          setShowCreateRoom(false);
          setNewRoomName('');
          setNewRoomLimit('');
          setNewRoomPassword('');
          navigate(`/room/${response.room.id}`);
        },
      );
  };
  const deleteRoomById = (targetRoomId: string) => {
    if (!targetRoomId) return;
    socket
      .timeout(5000)
      .emit(
        'room:delete',
        { roomId: targetRoomId },
        (error: Error | null, response?: { ok?: boolean; error?: string }) => {
          if (error || !response?.ok) {
            window.alert(response?.error ?? error?.message ?? '删除频道失败');
            return;
          }
          // The settings dialog can be opened for any owned room in the rail,
          // not only the room currently shown in the URL.  Close the dialog
          // and remove exactly the room confirmed by the user; the room:
          // deleted listener handles navigation when that room is current.
          setRooms((current) => current.filter((item) => item.id !== targetRoomId));
          setRoomSettings((current) => (current?.id === targetRoomId ? null : current));
        },
      );
  };
  const requestRemote = () => {
    const target = rtc.remoteScreen?.socketId;
    if (!target || !roomId || pendingRemoteRequest) return;
    if (remoteRequestCooldownSeconds > 0) {
      setRemoteNotice(`请等待 ${remoteRequestCooldownSeconds} 秒后再发送远程控制申请。`);
      return;
    }
    if (!remoteLifecycleRef.current?.expectStart('controller')) return;
    setRemoteNotice('');
    setPendingRemoteRequest(true);
    setRemoteRequestCooldownSeconds(REMOTE_CONTROL_REQUEST_COOLDOWN_SECONDS);
    socket
      .timeout(5000)
      .emit(
        'remote-control:request',
        { roomId, sharerSocketId: target },
        (error: Error | null, response?: { ok?: boolean; requestId?: string; error?: string }) => {
          if (error || !response?.ok) {
            remoteLifecycleRef.current?.cancelExpectedStart();
            setPendingRemoteRequest(false);
            setPendingRemoteRequestId(null);
            setRemoteNotice(response?.error ?? '请求失败');
          } else setPendingRemoteRequestId(response.requestId ?? null);
        },
      );
  };
  const respondRemote = (accepted: boolean) => {
    if (!pendingRemote) return;
    if (accepted) {
      if (!remoteLifecycleRef.current?.expectStart('sharer')) {
        setPendingRemote(null);
        setRemoteNotice('连接已断开，远程控制未启动');
        return;
      }
      socket.emit('remote-control:respond', {
        requestId: pendingRemote.requestId,
        accepted: true,
      });
      setPendingRemote(null);
      return;
    }
    socket.emit('remote-control:respond', {
      requestId: pendingRemote.requestId,
      accepted,
    });
    setPendingRemote(null);
  };
  const stopRemote = () => {
    if (!remoteSession && pendingRemoteRequestId && socket.connected)
      socket.emit('remote-control:cancel', {
        requestId: pendingRemoteRequestId,
      });
    remoteLifecycleRef.current?.stop();
    const cancelledRequest = !remoteSession && Boolean(pendingRemoteRequestId);
    setPendingRemoteRequest(false);
    setPendingRemoteRequestId(null);
    setPendingRemote(null);
    setRemoteSession(null);
    if (cancelledRequest) setRemoteNotice('远程控制请求已取消');
  };
  const sendRemoteInput = useCallback((inputValue: RemoteControlInput) => {
    remoteLifecycleRef.current?.send(inputValue);
  }, []);
  const openMemberMenu = (event: MouseEvent, member: RoomMember, isSelf: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isRoomOwner || isSelf) return;
    setMemberMenu({
      socketId: member.socketId,
      username: getProfileDisplayName(member.username, member.userId, profileRemarks),
      muted: Boolean(member.isMuted),
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 188)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 104)),
    });
  };
  const applyMemberMute = (muted: boolean) => {
    const target = memberMenu;
    if (!roomId || !target) return;
    setMemberMenu(null);
    socket
      .timeout(5000)
      .emit(
        'room:set-muted',
        { roomId, targetSocketId: target.socketId, muted },
        (error: Error | null, response?: { ok?: boolean; error?: string }) => {
          if (error || !response?.ok) window.alert(response?.error ?? error?.message ?? '操作失败');
        },
      );
  };
  const kickMember = () => {
    const target = memberMenu;
    if (!roomId || !target) return;
    setMemberMenu(null);
    socket
      .timeout(5000)
      .emit(
        'room:kick',
        { roomId, targetSocketId: target.socketId },
        (error: Error | null, response?: { ok?: boolean; error?: string }) => {
          if (error || !response?.ok) window.alert(response?.error ?? error?.message ?? '操作失败');
        },
      );
  };
  const applyRoomSettings = (changes: Record<string, unknown>) => {
    if (!roomId) return;
    socket.timeout(5000).emit(
      'room:update-settings',
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
          window.alert(response?.error ?? error?.message ?? '设置保存失败');
          return;
        }
        if (response.room) {
          setRoom(response.room);
          setRooms((current) =>
            current.map((item) => (item.id === response.room!.id ? response.room! : item)),
          );
        }
        setRoomSettings(null);
        refreshRooms();
      },
    );
  };
  const leave = () => {
    rtc.leaveVoice();
    navigate('/');
  };
  const retryJoin = () => {
    if (!roomId || joining) return;
    setJoinError('');
    setJoinRetryNonce((current) => current + 1);
  };
  const roomTop =
    theme === 'dark'
      ? roomColor(room?.backgroundTopDark, ROOM_DARK_TOP)
      : roomColor(room?.backgroundTop, ROOM_LIGHT_TOP);
  const roomBottom =
    theme === 'dark'
      ? roomColor(room?.backgroundBottomDark, ROOM_DARK_BOTTOM)
      : roomColor(room?.backgroundBottom, ROOM_LIGHT_BOTTOM);
  const appearanceStyle = {
    '--room-top': roomTop,
    '--room-bottom': roomBottom,
    '--member-width': '340px',
  } as React.CSSProperties;
  const foreground =
    (colorLuminance(roomTop) + colorLuminance(roomBottom)) / 2 < 0.45 ? 'light' : 'dark';
  return {
    room,
    roomSynced,
    messagesLoaded,
    foreground,
    appearanceStyle,
    joinError,
    joinPassword,
    setJoinPassword,
    joining,
    navigate,
    retryJoin,
    rtc,
    remoteSession,
    pendingRemoteRequest,
    roomMembers,
    profileRemarks,
    sidebarOpen,
    chatVisible,
    rooms,
    roomId,
    setSidebarOpen,
    setGlobalSettingsPage,
    setGlobalSettings,
    setRoomSettings,
    setShowCreateRoom,
    shareLayout,
    animateShareChat,
    animateLayoutControls,
    sortedMembers,
    inputVolume,
    getSharedAudioVolume,
    openMemberMenu,
    setShowProfile,
    setViewingProfile,
    setInputVolume,
    setSharedAudioVolume,
    toggleSharedAudioMute,
    setDraggingVolumeMember,
    draggingVolumeMember,
    debug,
    setDebug,
    remoteRequestCooldownSeconds,
    sendRemoteInput,
    requestRemote,
    stopRemote,
    diagnosticsCompact,
    setDiagnosticsCompact,
    messages,
    roomBottom,
    input,
    setInput,
    sendMessage,
    sendImages,
    imageError,
    setImageError,
    unread,
    chatFontSize,
    updateChatFontSize,
    hasOlderMessages,
    loadingOlderMessages,
    historyLoadVersion,
    loadOlderMessages,
    chatOpen,
    setChatOpen,
    setUnread,
    leave,
    openScreenModal,
    openAudioModal,
    openSoundboard,
    soundboardButtonRef,
    soundboardAnchorRef,
    openSoundboardQuick,
    closeSoundboardQuick,
    showAudioModal,
    audioSources,
    audioLoading,
    audioSourceError,
    closeAudioModal,
    refreshAudioSources,
    showCreateRoom,
    newRoomName,
    newRoomLimit,
    newRoomPassword,
    creatingRoom,
    setNewRoomName,
    setNewRoomLimit,
    setNewRoomPassword,
    createRoom,
    roomSettings,
    applyRoomSettings,
    deleteRoomById,
    globalSettings,
    outputVolume,
    setOutputVolume,
    globalSettingsPage,
    showSoundboard,
    setShowSoundboard,
    showSoundboardQuick,
    showProfile,
    viewingProfile,
    setProfileRemarks,
    showScreenModal,
    pendingPreset,
    pendingFps,
    pendingAudio,
    pendingGameMode,
    pendingNativeResolution,
    setPendingNativeResolution,
    editingScreen,
    setPendingPreset,
    setPendingFps,
    setPendingAudio,
    setPendingGameMode,
    setRemoteNotice,
    setEditingScreen,
    setShowScreenModal,
    remoteNotice,
    memberMenu,
    setMemberMenu,
    applyMemberMute,
    kickMember,
    pendingRemote,
    respondRemote,
  };
}
