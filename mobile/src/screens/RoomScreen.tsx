import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  ArrowLeft,
  CheckCircle2,
  Crown,
  Eye,
  EyeOff,
  Expand,
  Headphones,
  Mic,
  MicOff,
  MonitorPlay,
  Minus,
  PhoneOff,
  Plus,
  ShieldAlert,
  Users,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react-native';
import { RTCView } from 'react-native-webrtc';
import type { Socket } from 'socket.io-client';
import { Soundboard } from '../components/Soundboard';
import { UserProfileModal } from '../components/UserProfileModal';
import { loadProfileRemarks, saveProfileRemark, type ProfileRemarks } from '../profileRemarks';
import { colors } from '../theme';
import type { Room, RoomMember, RoomState, SessionConfig } from '../types';
import { useMobileMedia } from '../useMobileMedia';

interface Props {
  socket: Socket;
  config: SessionConfig;
  room: Room;
  sessionReady: boolean;
  onBack: () => void;
}

function initials(name: string) {
  return name.trim().slice(0, 2) || 'C';
}

export function RoomScreen({ socket, config, room, sessionReady, onBack }: Props) {
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [roomReady, setRoomReady] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [viewingProfile, setViewingProfile] = useState<RoomMember | null>(null);
  const [profileRemarks, setProfileRemarks] = useState<ProfileRemarks>({});
  const media = useMobileMedia(socket, room.id);

  useEffect(() => {
    let active = true;
    loadProfileRemarks().then(remarks => { if (active) setProfileRemarks(remarks); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!sessionReady) {
      setRoomReady(false);
      return;
    }
    let active = true;
    socket.timeout(6_000).emit(
      'room:join',
      room.id,
      (timeoutError: Error | null, response?: { ok: boolean; error?: string }) => {
        if (!active) return;
        if (timeoutError || response?.ok === false) {
          setJoinError(response?.error ?? '加入房间超时');
          setRoomReady(false);
          return;
        }
        setJoinError(null);
        setRoomReady(true);
      },
    );
    return () => {
      active = false;
      media.leaveVoice();
      socket.emit('room:leave', room.id);
    };
  // Media state must not re-run the room join lifecycle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, sessionReady, socket]);

  useEffect(() => {
    const onState = (state: RoomState) => {
      if (state.roomId === room.id) setMembers(state.members);
    };
    const onDeleted = ({ roomId }: { roomId: string }) => {
      if (roomId === room.id) onBack();
    };
    socket.on('room:state', onState);
    socket.on('room:deleted', onDeleted);
    return () => {
      socket.off('room:state', onState);
      socket.off('room:deleted', onDeleted);
    };
  }, [onBack, room.id, socket]);

  const screenURL = media.remoteScreen?.stream.toURL();
  useEffect(() => {
    if (!screenURL) setFullscreen(false);
  }, [screenURL]);
  const sharerName = useMemo(() => {
    const socketId = media.remoteScreen?.socketId;
    if (!socketId) return undefined;
    return members.find(member => member.socketId === socketId)?.username;
  }, [media.remoteScreen, members]);

  const screenContent = screenURL ? (
    <RTCView streamURL={screenURL} objectFit="contain" mirror={false} style={styles.video} />
  ) : media.availableScreens.length > 0 ? (
    <View style={styles.shareAvailable}>
      <View style={styles.shareAvailableIcon}><MonitorPlay size={30} color="#082f49" /></View>
      <Text style={styles.shareAvailableTitle}>{media.availableScreens.length} 位成员正在共享屏幕</Text>
      <Text style={styles.shareAvailableText}>选择一位成员观看，其他共享不会消耗视频流量</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.shareChoices}>
        {media.availableScreens.map(screen => {
          const name = members.find(member => member.socketId === screen.socketId)?.username ?? '成员';
          return (
            <TouchableOpacity key={screen.videoProducerId} style={styles.watchButton} onPress={() => media.watchScreen(screen.socketId)} activeOpacity={0.8}>
              <Eye size={16} color="#082f49" />
              <Text style={styles.watchButtonText} numberOfLines={1}>{name}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  ) : (
    <View style={styles.screenEmpty}>
      <View style={styles.screenEmptyIcon}><MonitorPlay size={29} color={colors.textFaint} /></View>
      <Text style={styles.screenEmptyTitle}>等待屏幕共享</Text>
      <Text style={styles.screenEmptyText}>有人共享时，你可以自行选择是否观看</Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
      <View style={styles.header}>
        <TouchableOpacity style={styles.iconButton} onPress={onBack}><ArrowLeft size={21} color={colors.textMuted} /></TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.roomName} numberOfLines={1}>{room.name}</Text>
          <Text style={styles.ownerName} numberOfLines={1}>{room.ownerName ? `房主 ${room.ownerName}` : '房间'}</Text>
        </View>
        <View style={[styles.mediaState, media.connectionState === 'connected' && styles.mediaConnected]}>
          {media.connectionState === 'connected'
            ? <CheckCircle2 size={17} color={colors.green} />
            : <Headphones size={17} color={colors.textFaint} />}
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {(joinError || media.error) && (
          <TouchableOpacity style={styles.errorBanner} onPress={() => { setJoinError(null); media.clearError(); }}>
            <ShieldAlert size={18} color={colors.red} />
            <Text style={styles.errorText}>{joinError ?? media.error}</Text>
          </TouchableOpacity>
        )}

        <View style={styles.screenStage}>
          {screenContent}
          {screenURL && (
            <View style={styles.screenOverlay}>
              <Text style={styles.sharer}>{sharerName ?? '正在共享'}</Text>
              <View style={styles.screenActions}>
                <TouchableOpacity style={styles.expandButton} onPress={() => setFullscreen(true)}><Expand size={18} color={colors.text} /></TouchableOpacity>
                <TouchableOpacity style={styles.expandButton} onPress={media.stopWatchingScreen}><EyeOff size={18} color={colors.red} /></TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {screenURL && media.availableScreens.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.shareSwitcher}>
            {media.availableScreens.map(screen => {
              const selected = media.watchingScreenPeerId === screen.socketId;
              const name = members.find(member => member.socketId === screen.socketId)?.username ?? '成员';
              return (
                <TouchableOpacity
                  key={screen.videoProducerId}
                  disabled={selected}
                  style={[styles.shareSwitchButton, selected && styles.shareSwitchButtonActive]}
                  onPress={() => media.watchScreen(screen.socketId)}
                  activeOpacity={0.78}
                >
                  <MonitorPlay size={14} color={selected ? '#083344' : colors.textMuted} />
                  <Text style={[styles.shareSwitchText, selected && styles.shareSwitchTextActive]} numberOfLines={1}>{name}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {screenURL && (
          <View style={styles.screenVolumeCard}>
            {media.screenReceiveVolume === 0 ? <VolumeX size={18} color={colors.textMuted} /> : <Volume2 size={18} color={colors.cyan} />}
            <Text style={styles.screenVolumeLabel}>共享音量</Text>
            <TouchableOpacity style={styles.volumeStep} onPress={() => media.setScreenReceiveVolume(media.screenReceiveVolume - 0.1)}><Minus size={16} color={colors.textMuted} /></TouchableOpacity>
            <Text style={styles.screenVolumeValue}>{Math.round(media.screenReceiveVolume * 100)}%</Text>
            <TouchableOpacity style={styles.volumeStep} onPress={() => media.setScreenReceiveVolume(media.screenReceiveVolume + 0.1)}><Plus size={16} color={colors.textMuted} /></TouchableOpacity>
          </View>
        )}

        <View style={styles.memberCard}>
          <View style={styles.sectionHeading}>
            <View style={styles.sectionIcon}><Users size={18} color={colors.cyan} /></View>
            <View><Text style={styles.sectionTitle}>房间成员</Text><Text style={styles.sectionSubtitle}>{members.length} 人在线{media.inVoice ? ` · ${media.voiceMembers.length} 人在语音` : ''}</Text></View>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.memberList}>
            {members.map(member => {
              const voiceMember = media.voiceMembers.find(voice => voice.socketId === member.socketId);
              const showVoiceState = media.inVoice && !!voiceMember;
              return (
                <TouchableOpacity
                  style={styles.memberChip}
                  key={member.socketId}
                  disabled={member.socketId === socket.id}
                  onPress={() => setViewingProfile(member)}
                  activeOpacity={0.75}
                >
                  <View style={styles.miniAvatar}><Text style={styles.miniAvatarText}>{initials(member.username)}</Text></View>
                  <View>
                    <Text style={styles.memberName}>{profileRemarks[member.userId] || member.username}</Text>
                    {profileRemarks[member.userId] ? <Text style={styles.memberUsername}>{member.username}</Text> : null}
                  </View>
                  {member.isOwner && <Crown size={13} color="#fcd34d" />}
                  {showVoiceState && voiceMember.isMuted && <MicOff size={13} color={colors.red} />}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        <Soundboard socket={socket} roomId={room.id} serverURL={config.serverURL} ready={roomReady} inVoice={media.inVoice} />
        <View style={styles.bottomSpacer} />
      </ScrollView>

      <View style={styles.voiceControls}>
        {!media.inVoice ? (
          <TouchableOpacity
            style={[styles.joinVoice, (!roomReady || media.joining) && styles.controlDisabled]}
            disabled={!roomReady || media.joining}
            onPress={media.joinVoice}
            activeOpacity={0.8}
          >
            {media.joining ? <ActivityIndicator color="#164e63" /> : <Headphones size={20} color="#164e63" />}
            <Text style={styles.joinVoiceText}>{media.joining ? '正在加入' : '加入语音'}</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              style={[styles.micControl, media.isMuted && styles.micMuted, media.isForceMuted && styles.forceMuted]}
              disabled={media.isForceMuted}
              onPress={media.toggleMute}
              activeOpacity={0.78}
            >
              {media.isMuted ? <MicOff size={20} color={media.isForceMuted ? colors.red : colors.amber} /> : <Mic size={20} color={colors.green} />}
              <Text style={[styles.micText, media.isMuted && styles.micMutedText, media.isForceMuted && styles.forceMutedText]}>
                {media.isForceMuted ? '已被房主禁言' : media.isMuted ? '麦克风已关' : '麦克风已开'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.leaveControl} onPress={media.leaveVoice}><PhoneOff size={20} color={colors.red} /></TouchableOpacity>
          </>
        )}
      </View>

      <Modal visible={fullscreen} animationType="fade" supportedOrientations={['portrait', 'landscape']} onRequestClose={() => setFullscreen(false)}>
        <View style={styles.fullscreen}>
          <StatusBar hidden />
          {screenURL ? <RTCView streamURL={screenURL} objectFit="contain" mirror={false} style={styles.fullscreenVideo} /> : null}
          <TouchableOpacity style={styles.closeFullscreen} onPress={() => setFullscreen(false)}><X size={22} color={colors.text} /></TouchableOpacity>
        </View>
      </Modal>

      {viewingProfile && (
        <UserProfileModal
          visible
          userId={viewingProfile.userId}
          username={viewingProfile.username}
          avatarUrl={viewingProfile.avatarUrl}
          remark={profileRemarks[viewingProfile.userId]}
          onSaveRemark={remark => {
            saveProfileRemark(profileRemarks, viewingProfile.userId, remark)
              .then(setProfileRemarks)
              .catch(() => {});
          }}
          onClose={() => setViewingProfile(null)}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  header: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  iconButton: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  headerCopy: { flex: 1, minWidth: 0 },
  roomName: { color: colors.text, fontSize: 18, fontWeight: '700' },
  ownerName: { color: colors.textFaint, fontSize: 11, marginTop: 3 },
  mediaState: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.05)' },
  mediaConnected: { backgroundColor: colors.greenSoft },
  scrollContent: { paddingTop: 14 },
  errorBanner: { flexDirection: 'row', alignItems: 'center', gap: 9, marginHorizontal: 14, marginBottom: 10, padding: 11, borderWidth: 1, borderColor: 'rgba(248,113,113,0.2)', borderRadius: 13, backgroundColor: colors.redSoft },
  errorText: { flex: 1, color: colors.red, fontSize: 11, lineHeight: 16 },
  screenStage: { position: 'relative', aspectRatio: 16 / 9, marginHorizontal: 14, marginBottom: 14, overflow: 'hidden', borderWidth: 1, borderColor: colors.border, borderRadius: 20, backgroundColor: '#020203' },
  video: { width: '100%', height: '100%', backgroundColor: '#000' },
  screenEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  screenEmptyIcon: { width: 58, height: 58, marginBottom: 12, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.045)' },
  screenEmptyTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  screenEmptyText: { color: colors.textFaint, fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 7 },
  shareAvailable: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, backgroundColor: 'rgba(34,211,238,0.07)' },
  shareAvailableIcon: { width: 54, height: 54, marginBottom: 9, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: '#a5f3fc' },
  shareAvailableTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  shareAvailableText: { marginTop: 4, color: colors.textFaint, fontSize: 10 },
  shareChoices: { paddingTop: 10, gap: 7 },
  watchButton: { maxWidth: 150, minWidth: 108, height: 38, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 13, backgroundColor: '#cffafe' },
  watchButtonText: { color: '#082f49', fontSize: 13, fontWeight: '800' },
  screenOverlay: { position: 'absolute', right: 9, bottom: 9, left: 9, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sharer: { maxWidth: '75%', color: colors.text, fontSize: 10, paddingHorizontal: 9, paddingVertical: 7, overflow: 'hidden', borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.72)' },
  expandButton: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.72)' },
  screenActions: { flexDirection: 'row', gap: 7 },
  screenVolumeCard: { minHeight: 48, marginHorizontal: 14, marginTop: -5, marginBottom: 14, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderColor: colors.border, borderRadius: 15, backgroundColor: colors.surface },
  screenVolumeLabel: { flex: 1, color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  screenVolumeValue: { width: 40, color: colors.text, fontSize: 11, textAlign: 'center', fontVariant: ['tabular-nums'] },
  volumeStep: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.05)' },
  shareSwitcher: { paddingHorizontal: 14, paddingBottom: 12, gap: 7 },
  shareSwitchButton: { maxWidth: 150, height: 36, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', gap: 7, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface },
  shareSwitchButtonActive: { borderColor: 'rgba(103,232,249,0.38)', backgroundColor: '#a5f3fc' },
  shareSwitchText: { maxWidth: 108, color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  shareSwitchTextActive: { color: '#083344' },
  memberCard: { marginHorizontal: 14, marginBottom: 12, padding: 15, borderWidth: 1, borderColor: colors.border, borderRadius: 19, backgroundColor: colors.surface },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 12 },
  sectionIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cyanSoft },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  sectionSubtitle: { color: colors.textFaint, fontSize: 10, marginTop: 4 },
  memberList: { gap: 8 },
  memberChip: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 7, paddingLeft: 7, paddingRight: 9, borderRadius: 13, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.035)' },
  miniAvatar: { width: 26, height: 26, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cyanSoft },
  miniAvatarText: { color: colors.cyan, fontSize: 9, fontWeight: '800' },
  memberName: { color: 'rgba(244,244,245,0.7)', fontSize: 11 },
  memberUsername: { marginTop: 2, color: colors.textFaint, fontSize: 8 },
  bottomSpacer: { height: 85 },
  voiceControls: { position: 'absolute', right: 0, bottom: 0, left: 0, minHeight: 74, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.borderStrong, backgroundColor: 'rgba(12,12,15,0.98)' },
  joinVoice: { flex: 1, height: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, borderRadius: 15, backgroundColor: '#ecfeff' },
  joinVoiceText: { color: '#164e63', fontSize: 15, fontWeight: '800' },
  controlDisabled: { opacity: 0.35 },
  micControl: { flex: 1, height: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, borderRadius: 15, backgroundColor: colors.greenSoft },
  micMuted: { backgroundColor: colors.amberSoft },
  forceMuted: { backgroundColor: colors.redSoft },
  micText: { color: colors.green, fontSize: 14, fontWeight: '700' },
  micMutedText: { color: colors.amber },
  forceMutedText: { color: colors.red },
  leaveControl: { width: 52, height: 50, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.redSoft },
  fullscreen: { flex: 1, backgroundColor: '#000' },
  fullscreenVideo: { flex: 1, backgroundColor: '#000' },
  closeFullscreen: { position: 'absolute', top: 18, right: 18, width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.7)' },
});
