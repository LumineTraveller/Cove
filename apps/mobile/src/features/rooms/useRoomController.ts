import { useEffect, useMemo, useRef, useState } from 'react';

import { roomSettingsPayload } from './roomSettings';
import type { Socket } from 'socket.io-client';

import {
  getProfileDisplayName,
  loadProfileRemarks,
  type ProfileRemarks,
} from '../profiles/profileRemarks';

import type { Room, RoomMember, RoomState, SessionConfig } from '../../types';
import { useMobileMedia } from '../media/useMobileMedia';

export interface MobileRoomProps {
  socket: Socket;
  config: SessionConfig;
  room: Room;
  sessionReady: boolean;
  onBack: () => void;
}
export interface InlineVolumeSliderProps {
  value: number;
  label: string;
  onChange: (value: number) => void;
}

export function useRoomController({
  socket,
  room,
  sessionReady,
  onBack,
}: MobileRoomProps) {
  const [roomMeta, setRoomMeta] = useState({
    maxMembers: room.maxMembers,
    hasPassword: room.hasPassword,
  });
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [roomReady, setRoomReady] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinPassword, setJoinPassword] = useState('');
  const [passwordPrompt, setPasswordPrompt] = useState(false);
  const joinPasswordRef = useRef('');
  const [joinPending, setJoinPending] = useState(false);
  const joinGeneration = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioSettingsOpen, setAudioSettingsOpen] = useState(false);
  const [screenShareSettingsOpen, setScreenShareSettingsOpen] = useState(false);
  const [includeScreenAudio, setIncludeScreenAudio] = useState(false);
  const [settingsLimit, setSettingsLimit] = useState(
    room.maxMembers ? String(room.maxMembers) : '',
  );
  const [settingsPassword, setSettingsPassword] = useState('');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsPending, setSettingsPending] = useState(false);
  const settingsPendingRef = useRef(false);
  const joinPendingRef = useRef(false);
  const joinBlockedRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [soundboardOpen, setSoundboardOpen] = useState(false);
  const [viewingProfile, setViewingProfile] = useState<RoomMember | null>(null);
  const [profileRemarks, setProfileRemarks] = useState<ProfileRemarks>({});
  const [roomOwnerName, setRoomOwnerName] = useState(room.ownerName);
  const [roomOwnerUserId, setRoomOwnerUserId] = useState(
    room.ownerUserId ?? null,
  );
  const screenVolumeBeforeMute = useRef(1);
  const media = useMobileMedia(socket, room.id);
  const audioSettingsBusy =
    media.joining || media.noiseSwitching || media.audioDeviceSwitching;
  const setScreenVolume = (volume: number) => {
    const normalized = Math.max(0, Math.min(1, volume));
    if (normalized > 0) screenVolumeBeforeMute.current = normalized;
    media.setScreenReceiveVolume(normalized);
  };
  const toggleScreenVolumeMute = () => {
    if (media.screenReceiveVolume > 0) {
      screenVolumeBeforeMute.current = media.screenReceiveVolume;
      media.setScreenReceiveVolume(0);
    } else {
      media.setScreenReceiveVolume(screenVolumeBeforeMute.current || 1);
    }
  };
  useEffect(() => {
    let active = true;
    loadProfileRemarks().then(remarks => {
      if (active) setProfileRemarks(remarks);
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    setRoomOwnerName(room.ownerName);
    setRoomOwnerUserId(room.ownerUserId ?? null);
  }, [room.id, room.ownerName, room.ownerUserId]);
  const saveRoomSettings = (clearPassword = false) => {
    if (!sessionReady || !roomReady || settingsPendingRef.current) return;
    let payload: ReturnType<typeof roomSettingsPayload>;
    try {
      payload = roomSettingsPayload(
        room.id,
        settingsLimit,
        settingsPassword,
        clearPassword,
      );
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : '设置无效');
      return;
    }
    settingsPendingRef.current = true;
    setSettingsPending(true);
    setSettingsError(null);
    socket
      .timeout(6_000)
      .emit(
        'room:update-settings',
        payload,
        (
          error: Error | null,
          result?: { ok: boolean; room?: Room; error?: string },
        ) => {
          settingsPendingRef.current = false;
          setSettingsPending(false);
          if (error || !result?.ok) {
            setSettingsError(result?.error ?? '保存失败，请重试');
            return;
          }
          if (result.room)
            setRoomMeta({
              maxMembers: result.room.maxMembers,
              hasPassword: result.room.hasPassword,
            });
          setSettingsPassword('');
          setSettingsOpen(false);
        },
      );
  };
  const joinRoom = (password?: string) => {
    if (!sessionReady || joinPendingRef.current || joinBlockedRef.current)
      return;
    const generation = ++joinGeneration.current;
    joinPendingRef.current = true;
    setJoinPending(true);
    if (password !== undefined) joinPasswordRef.current = password;
    socket
      .timeout(6_000)
      .emit(
        'room:join',
        {
          roomId: room.id,
          ...(joinPasswordRef.current
            ? { password: joinPasswordRef.current }
            : {}),
        },
        (
          timeoutError: Error | null,
          response?: { ok: boolean; error?: string; code?: string },
        ) => {
          if (generation !== joinGeneration.current || joinBlockedRef.current)
            return;
          joinPendingRef.current = false;
          setJoinPending(false);
          if (timeoutError || !response?.ok) {
            setJoinError(response?.error ?? '加入房间超时');
            setRoomReady(false);
            if (
              response?.code === 'PASSWORD_REQUIRED' ||
              response?.code === 'INVALID_PASSWORD'
            )
              setPasswordPrompt(true);
            return;
          }
          setJoinError(null);
          setPasswordPrompt(false);
          setRoomReady(true);
        },
      );
  };
  useEffect(() => {
    joinPendingRef.current = false;
    setJoinPending(false);
    if (!sessionReady) {
      joinGeneration.current += 1;
      setRoomReady(false);
      return;
    }
    joinRoom();
    return () => {
      joinGeneration.current += 1;
      joinPendingRef.current = false;
    };
    // Media state must not re-run the room join lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, sessionReady, socket]);
  useEffect(
    () => () => {
      joinGeneration.current += 1;
      joinPasswordRef.current = '';
      media.leaveVoice();
      if (socket.connected) socket.emit('room:leave', room.id);
      else
        socket.once('connect', () => {
          if (socket.recovered) socket.emit('room:leave', room.id);
        });
      // Only actually leaving the room tears down media, not a temporary disconnect.
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room.id, socket],
  );
  useEffect(() => {
    const onState = (state: RoomState) => {
      if (state.roomId === room.id) {
        setMembers(state.members);
        setRoomOwnerName(state.ownerName);
        setRoomOwnerUserId(state.ownerUserId ?? null);
        setRoomMeta({
          maxMembers: state.maxMembers,
          hasPassword: state.hasPassword,
        });
      }
    };
    const onDeleted = ({ roomId }: { roomId: string }) => {
      if (roomId === room.id) {
        joinBlockedRef.current = true;
        joinGeneration.current += 1;
        setRoomReady(false);
        onBack();
      }
    };
    const onKicked = ({ roomId }: { roomId: string }) => {
      if (roomId === room.id) {
        joinBlockedRef.current = true;
        joinGeneration.current += 1;
        setRoomReady(false);
        onBack();
      }
    };
    socket.on('room:state', onState);
    socket.on('room:deleted', onDeleted);
    socket.on('room:kicked', onKicked);
    return () => {
      socket.off('room:state', onState);
      socket.off('room:deleted', onDeleted);
      socket.off('room:kicked', onKicked);
    };
  }, [onBack, room.id, socket]);
  const screenURL = media.remoteScreen?.stream.toURL();
  useEffect(() => {
    if (!screenURL) setFullscreen(false);
  }, [screenURL]);
  const sharerName = useMemo(() => {
    const socketId = media.remoteScreen?.socketId;
    if (!socketId) return undefined;
    const member =
      members.find(candidate => candidate.socketId === socketId) ??
      media.voiceMembers.find(candidate => candidate.socketId === socketId);
    return member
      ? getProfileDisplayName(member.username, member.userId, profileRemarks)
      : undefined;
  }, [media.remoteScreen, media.voiceMembers, members, profileRemarks]);
  const ownerMember = members.find(member => member.isOwner);
  const displayOwnerName = getProfileDisplayName(
    ownerMember?.username ?? roomOwnerName ?? '',
    ownerMember?.userId ?? roomOwnerUserId,
    profileRemarks,
  );
  const displayScreenSharer = (socketId: string) => {
    const member =
      members.find(candidate => candidate.socketId === socketId) ??
      media.voiceMembers.find(candidate => candidate.socketId === socketId);
    return member
      ? getProfileDisplayName(member.username, member.userId, profileRemarks)
      : '成员';
  };
  return {
    screenURL,
    media,
    displayScreenSharer,
    displayOwnerName,
    members,
    setSettingsLimit,
    roomMeta,
    setSettingsPassword,
    setSettingsError,
    setSettingsOpen,
    setChatOpen,
    setSoundboardOpen,
    setAudioSettingsOpen,
    joinError,
    setJoinError,
    roomReady,
    passwordPrompt,
    joinPending,
    joinRoom,
    sharerName,
    setFullscreen,
    setScreenShareSettingsOpen,
    toggleScreenVolumeMute,
    setScreenVolume,
    profileRemarks,
    setViewingProfile,
    screenShareSettingsOpen,
    includeScreenAudio,
    setIncludeScreenAudio,
    audioSettingsOpen,
    audioSettingsBusy,
    fullscreen,
    joinPassword,
    setJoinPassword,
    settingsOpen,
    settingsPending,
    settingsLimit,
    settingsPassword,
    settingsError,
    saveRoomSettings,
    chatOpen,
    soundboardOpen,
    viewingProfile,
    setProfileRemarks,
  };
}
