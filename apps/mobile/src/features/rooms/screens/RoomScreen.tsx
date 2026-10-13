import { useRoomStyles } from './roomStyles';
import { InlineVolumeSlider } from '../../media/components/InlineVolumeSlider';
export { InlineVolumeSlider } from '../../media/components/InlineVolumeSlider';
import { useRoomController, type MobileRoomProps } from '../useRoomController';
import { createContext, useContext, useRef, type ReactNode } from 'react';

import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StatusBar,
  Switch,
  Text,
  TouchableOpacity,
  View,
  TextInput,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  AudioLines,
  CheckCircle2,
  Crown,
  Eye,
  EyeOff,
  Expand,
  Headphones,
  MessageCircle,
  Mic,
  MicOff,
  Monitor,
  MonitorPlay,
  PhoneOff,
  ShieldAlert,
  Smartphone,
  Users,
  Volume2,
  VolumeX,
  X,
  Settings,
  SlidersHorizontal,
  ScreenShare,
  Square,
} from 'lucide-react-native';
import { ZoomableScreenVideo } from '../../media/screen/components/ZoomableScreenVideo';
import { Avatar } from '../../profiles/components/Avatar';
import { ROOM_LIMIT_PRESETS } from '../roomSettings';

import { Soundboard } from '../../soundpacks/components/Soundboard';
import { ChatPanel } from '../../chat/components/ChatPanel';
import { UserProfileModal } from '../../profiles/components/UserProfileModal';
import {
  getProfileDisplayName,
  saveProfileRemark,
} from '../../profiles/profileRemarks';
import { useCoveTheme } from '../../settings/ThemeProvider';
import { useKeyboardInset } from '../../keyboard/useKeyboardInset';

import { NOISE_MODES } from '../../media/microphone/microphoneNoise';
import {
  inputDeviceLabel,
  outputDeviceLabel,
} from '../../media/audio/audioDevices';

const FormKeyboardContext = createContext<Pick<
  ReturnType<typeof useKeyboardInset>,
  'bindInput' | 'unbindInput'
> | null>(null);

function RoomFormScroll({
  children,
  contentStyle,
}: {
  children: ReactNode;
  contentStyle: StyleProp<ViewStyle>;
}) {
  const keyboard = useKeyboardInset();
  const styles = useRoomStyles();
  return (
    <KeyboardAvoidingView
      style={styles.keyboard}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        ref={keyboard.scrollView}
        contentContainerStyle={[
          contentStyle,
          { paddingBottom: 20 + keyboard.bottomInset },
        ]}
        onScroll={keyboard.onScroll}
        onLayout={keyboard.onLayout}
        onContentSizeChange={keyboard.onContentSizeChange}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <FormKeyboardContext.Provider value={keyboard}>
          {children}
        </FormKeyboardContext.Provider>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function RoomFormInput(props: TextInputProps) {
  const keyboard = useContext(FormKeyboardContext);
  const input = useRef<TextInput>(null);
  return (
    <TextInput
      {...props}
      ref={input}
      onFocus={() => keyboard?.bindInput(input.current)}
      onBlur={() => keyboard?.unbindInput(input.current)}
    />
  );
}

export function RoomScreen({
  socket,
  config,
  room,
  sessionReady,
  onBack,
}: MobileRoomProps) {
  const { theme, colors } = useCoveTheme();
  const styles = useRoomStyles();
  const {
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
  } = useRoomController({ socket, config, room, sessionReady, onBack });

  const screenContent = screenURL ? (
    <ZoomableScreenVideo key={screenURL} streamURL={screenURL} />
  ) : media.availableScreens.length > 0 ? (
    <View style={styles.shareAvailable}>
      <View style={styles.shareAvailableIcon}>
        <MonitorPlay size={30} color={colors.onScreen} />
      </View>
      <Text style={styles.shareAvailableTitle}>
        {media.availableScreens.length} 位成员正在共享屏幕
      </Text>
      <Text style={styles.shareAvailableText}>
        选择一位成员观看，其他共享不会消耗视频流量
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.shareChoices}
      >
        {media.availableScreens.map((screen) => {
          const name = displayScreenSharer(screen.socketId);
          return (
            <TouchableOpacity
              key={screen.videoProducerId}
              style={styles.watchButton}
              onPress={() => media.watchScreen(screen.socketId)}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={`观看${name}的共享屏幕`}
            >
              <Eye size={16} color={colors.onScreen} />
              <Text style={styles.watchButtonText} numberOfLines={1}>
                {name}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  ) : (
    <View style={styles.screenEmpty}>
      <View style={styles.screenEmptyIcon}>
        <MonitorPlay size={29} color={colors.amber} />
      </View>
      <Text style={styles.screenEmptyTitle}>等待屏幕共享</Text>
      <Text style={styles.screenEmptyText}>
        有人共享时，你可以自行选择是否观看
      </Text>
    </View>
  );

  return (
    <SafeAreaView
      style={styles.safeArea}
      edges={['top', 'right', 'bottom', 'left']}
    >
      <StatusBar
        barStyle={theme === 'dark' ? 'light-content' : 'dark-content'}
        backgroundColor={colors.background}
      />
      <View style={styles.header} testID="room-header">
        <TouchableOpacity
          style={styles.iconButton}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="离开房间"
        >
          <ArrowLeft size={21} color={colors.textMuted} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.roomName} numberOfLines={2}>
            {room.name}
          </Text>
          <Text style={styles.ownerName} numberOfLines={1}>
            {displayOwnerName ? `房主 ${displayOwnerName}` : '房间'}
          </Text>
        </View>
        <View style={styles.headerActions}>
          {members.some(
            (member) => member.socketId === socket.id && member.isOwner,
          ) && (
            <TouchableOpacity
              style={styles.headerAction}
              onPress={() => {
                setSettingsLimit(
                  roomMeta.maxMembers ? String(roomMeta.maxMembers) : '',
                );
                setSettingsPassword('');
                setSettingsError(null);
                setSettingsOpen(true);
              }}
              accessibilityLabel="房间设置"
            >
              <Settings size={20} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>
      <View style={styles.toolbar} testID="room-toolbar">
        <TouchableOpacity
          style={[styles.toolbarAction, styles.toolbarChat]}
          onPress={() => setChatOpen(true)}
          accessibilityLabel="打开聊天"
        >
          <MessageCircle size={18} color={colors.blue} />
          <Text style={[styles.toolbarText, styles.toolbarChatText]}>聊天</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.toolbarAction}
          onPress={() => setSoundboardOpen(true)}
          accessibilityLabel="打开语音包"
        >
          <AudioLines size={18} color={colors.purple} />
          <Text style={styles.toolbarText}>语音包</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.toolbarAction,
            media.connectionState === 'connected' && styles.mediaConnected,
          ]}
          onPress={() => {
            setAudioSettingsOpen(true);
            void media.refreshAudioDevices();
          }}
          accessibilityRole="button"
          accessibilityLabel="音频设置"
          accessibilityHint="设置麦克风降噪和输入输出设备"
        >
          <SlidersHorizontal
            size={17}
            color={
              media.connectionState === 'connected'
                ? colors.green
                : colors.textMuted
            }
          />
          <Text
            style={[
              styles.toolbarText,
              media.connectionState === 'connected' &&
                styles.toolbarConnectedText,
            ]}
          >
            音频设置
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.roomScroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {!roomReady && !passwordPrompt && !joinError && (
          <View style={styles.statusBanner} accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.blue} />
            <Text style={styles.statusText}>
              {sessionReady ? '正在加入房间…' : '连接已断开，正在重新连接…'}
            </Text>
          </View>
        )}
        {(joinError || media.error) && (
          <TouchableOpacity
            style={styles.errorBanner}
            onPress={() => {
              setJoinError(null);
              media.clearError();
            }}
          >
            <ShieldAlert size={18} color={colors.red} />
            <Text style={styles.errorText}>{joinError ?? media.error}</Text>
          </TouchableOpacity>
        )}

        {!roomReady && !passwordPrompt && joinError && (
          <TouchableOpacity
            style={styles.submit}
            disabled={joinPending || !sessionReady}
            onPress={() => joinRoom()}
          >
            <Text style={styles.submitText}>
              {joinPending ? '正在加入…' : '重新尝试加入房间'}
            </Text>
          </TouchableOpacity>
        )}

        {(screenURL || media.availableScreens.length > 0) && (
          <View
            style={[styles.screenStage, screenURL && styles.screenStageVideo]}
          >
            {screenContent}
            {screenURL && (
              <View style={styles.screenOverlay}>
                <Text style={styles.sharer} numberOfLines={2}>
                  {sharerName ?? '正在共享'}
                </Text>
                <View style={styles.screenActions}>
                  <TouchableOpacity
                    style={styles.expandButton}
                    onPress={() => setFullscreen(true)}
                    accessibilityLabel="全屏查看共享"
                  >
                    <Expand size={18} color={colors.onVideo} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.expandButton}
                    onPress={media.stopWatchingScreen}
                    accessibilityLabel="停止观看共享"
                  >
                    <EyeOff size={18} color={colors.red} />
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        )}

        {media.canShareScreen !== false && (
          <View style={styles.ownScreenCard} testID="own-screen-sharing">
            <View style={styles.ownScreenCopy}>
              <ScreenShare size={20} color={colors.amber} />
              <View style={styles.ownScreenText}>
                <Text style={styles.sectionTitle}>
                  {media.sharingScreen ? '正在共享我的屏幕' : '共享我的屏幕'}
                </Text>
                <Text style={styles.sectionSubtitle}>
                  {media.sharingScreen
                    ? `${
                        media.sharingScreenAudio ? '画面与播放音频' : '仅画面'
                      } · ${media.screenViewerCount} 人观看`
                    : media.screenSharingBusy
                    ? '等待系统授权或连接…'
                    : media.inVoice
                    ? '将手机画面分享给房间成员'
                    : '加入语音后即可共享'}
                </Text>
              </View>
            </View>
            {media.sharingScreen || media.screenSharingBusy ? (
              <TouchableOpacity
                style={styles.stopShareButton}
                onPress={media.stopScreenShare}
                accessibilityRole="button"
                accessibilityLabel={
                  media.sharingScreen ? '停止共享我的屏幕' : '取消发起屏幕共享'
                }
              >
                <Square size={15} color={colors.red} />
                <Text style={styles.stopShareText}>
                  {media.sharingScreen ? '停止' : '取消'}
                </Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.startShareButton}
                onPress={() => {
                  media.clearScreenSharingError();
                  setScreenShareSettingsOpen(true);
                }}
                accessibilityRole="button"
                accessibilityLabel="打开屏幕共享设置"
              >
                <Text style={styles.startShareText}>共享</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        {media.screenSharingError && (
          <TouchableOpacity
            style={styles.errorBanner}
            onPress={media.clearScreenSharingError}
            accessibilityLabel="关闭屏幕共享错误提示"
          >
            <ShieldAlert size={18} color={colors.red} />
            <Text style={styles.errorText}>{media.screenSharingError}</Text>
          </TouchableOpacity>
        )}

        {screenURL && media.availableScreens.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.shareSwitcher}
          >
            {media.availableScreens.map((screen) => {
              const selected = media.watchingScreenPeerId === screen.socketId;
              const name = displayScreenSharer(screen.socketId);
              return (
                <TouchableOpacity
                  key={screen.videoProducerId}
                  disabled={selected}
                  style={[
                    styles.shareSwitchButton,
                    selected && styles.shareSwitchButtonActive,
                  ]}
                  onPress={() => media.watchScreen(screen.socketId)}
                  activeOpacity={0.78}
                >
                  <MonitorPlay
                    size={14}
                    color={selected ? colors.onScreen : colors.textMuted}
                  />
                  <Text
                    style={[
                      styles.shareSwitchText,
                      selected && styles.shareSwitchTextActive,
                    ]}
                    numberOfLines={1}
                  >
                    {name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {screenURL && (
          <View style={styles.screenVolumeCard}>
            <TouchableOpacity
              style={styles.volumeIconButton}
              accessibilityLabel={
                media.screenReceiveVolume === 0
                  ? '取消共享屏幕静音'
                  : '将共享屏幕静音'
              }
              onPress={toggleScreenVolumeMute}
            >
              {media.screenReceiveVolume === 0 ? (
                <VolumeX size={18} color={colors.red} />
              ) : (
                <Volume2 size={18} color={colors.blue} />
              )}
            </TouchableOpacity>
            <Text style={styles.screenVolumeLabel}>共享音量</Text>
            <InlineVolumeSlider
              value={media.screenReceiveVolume}
              label="共享屏幕音量"
              onChange={setScreenVolume}
            />
            <Text style={styles.screenVolumeValue}>
              {Math.round(media.screenReceiveVolume * 100)}%
            </Text>
          </View>
        )}

        {media.inVoice &&
          media.applicationAudioShares.map((share) => {
            const owner = members.find(
              (member) => member.socketId === share.socketId,
            );
            const name = owner
              ? profileRemarks[owner.userId] || owner.username
              : '成员';
            return (
              <View key={share.producerId} style={styles.applicationAudioCard}>
                <View style={styles.applicationAudioHeading}>
                  <AudioLines size={22} color={colors.purple} />
                  <View style={styles.applicationAudioCopy}>
                    <Text style={styles.sectionTitle}>{name} 正在共享音频</Text>
                    <Text style={styles.sectionSubtitle} numberOfLines={2}>
                      {share.label} · 仅音频，无需观看屏幕
                    </Text>
                  </View>
                </View>
                <View style={styles.applicationAudioControls}>
                  <TouchableOpacity
                    accessibilityLabel={`${name}的应用音频${
                      share.volume === 0 ? '取消静音' : '静音'
                    }`}
                    style={styles.volumeIconButton}
                    onPress={() =>
                      media.setApplicationAudioVolume(
                        share.producerId,
                        share.volume === 0 ? 1 : 0,
                      )
                    }
                  >
                    {share.volume === 0 ? (
                      <VolumeX size={18} color={colors.red} />
                    ) : (
                      <Volume2 size={18} color={colors.blue} />
                    )}
                  </TouchableOpacity>
                  <InlineVolumeSlider
                    value={share.volume}
                    label={`${name}的应用音频音量`}
                    onChange={(volume) =>
                      media.setApplicationAudioVolume(share.producerId, volume)
                    }
                  />
                  <Text style={styles.screenVolumeValue}>
                    {Math.round(share.volume * 100)}%
                  </Text>
                </View>
              </View>
            );
          })}

        <View style={styles.memberCard}>
          <View style={styles.sectionHeading}>
            <View style={styles.sectionIcon}>
              <Users size={18} color={colors.blue} />
            </View>
            <View style={styles.sectionHeadingCopy}>
              <Text style={styles.sectionTitle}>房间成员</Text>
              <Text style={styles.sectionSubtitle}>
                {members.length} 人在线
                {media.inVoice
                  ? ` · ${media.voiceMembers.length} 人在语音`
                  : ''}
              </Text>
            </View>
          </View>
          <View style={styles.memberList}>
            {!members.length && (
              <Text style={styles.sectionSubtitle}>
                {roomReady ? '正在同步成员…' : '连接后显示房间成员'}
              </Text>
            )}
            {members.map((member) => {
              const voiceMember = media.voiceMembers.find(
                (voice) => voice.socketId === member.socketId,
              );
              const showVoiceState = !!voiceMember;
              const displayName = getProfileDisplayName(
                member.username,
                member.userId,
                profileRemarks,
              );
              return (
                <TouchableOpacity
                  style={styles.memberChip}
                  key={member.socketId}
                  disabled={member.socketId === socket.id}
                  onPress={() => setViewingProfile(member)}
                  activeOpacity={0.75}
                >
                  <Avatar
                    username={displayName}
                    avatarUrl={member.avatarUrl}
                    size={40}
                    borderRadius={20}
                  />
                  <View style={styles.memberCopy}>
                    <Text style={styles.memberName}>{displayName}</Text>
                    {profileRemarks[member.userId] ? (
                      <Text style={styles.memberUsername}>
                        原用户名：{member.username}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.memberIndicators}>
                    {member.isOwner && <Crown size={15} color={colors.amber} />}
                    {member.platform === 'mobile' ? (
                      <Smartphone size={13} color={colors.textFaint} />
                    ) : member.platform === 'desktop' ? (
                      <Monitor size={13} color={colors.textFaint} />
                    ) : null}
                    {showVoiceState &&
                      (voiceMember.isMuted ? (
                        <MicOff size={13} color={colors.red} />
                      ) : (
                        <Mic size={13} color={colors.green} />
                      ))}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </ScrollView>

      <View style={styles.voiceControls} testID="voice-controls">
        {!media.inVoice ? (
          <TouchableOpacity
            style={[
              styles.joinVoice,
              (!roomReady || media.joining) && styles.controlDisabled,
            ]}
            disabled={!roomReady || media.joining}
            onPress={media.joinVoice}
            activeOpacity={0.8}
          >
            {media.joining ? (
              <ActivityIndicator color={colors.green} />
            ) : (
              <Headphones size={20} color={colors.green} />
            )}
            <Text style={styles.joinVoiceText}>
              {media.joining ? '正在加入' : '加入语音'}
            </Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              style={[
                styles.micControl,
                media.isMuted && styles.micMuted,
                media.isForceMuted && styles.forceMuted,
              ]}
              disabled={media.isForceMuted}
              onPress={media.toggleMute}
              accessibilityLabel={
                media.isForceMuted
                  ? '已被房主禁言'
                  : media.isMuted
                  ? '开启麦克风'
                  : '关闭麦克风'
              }
              activeOpacity={0.78}
            >
              {media.isMuted ? (
                <MicOff
                  size={20}
                  color={media.isForceMuted ? colors.red : colors.amber}
                />
              ) : (
                <Mic size={20} color={colors.green} />
              )}
              <Text
                style={[
                  styles.micText,
                  media.isMuted && styles.micMutedText,
                  media.isForceMuted && styles.forceMutedText,
                ]}
              >
                {media.isForceMuted
                  ? '已被房主禁言'
                  : media.isMuted
                  ? '麦克风已关'
                  : '麦克风已开'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.leaveControl}
              onPress={media.leaveVoice}
              accessibilityLabel="退出语音"
            >
              <PhoneOff size={20} color={colors.red} />
            </TouchableOpacity>
          </>
        )}
      </View>

      <Modal
        visible={screenShareSettingsOpen}
        animationType="slide"
        onRequestClose={() => {
          if (media.screenSharingBusy) media.stopScreenShare();
          setScreenShareSettingsOpen(false);
        }}
      >
        <SafeAreaView
          style={styles.toolModal}
          edges={['top', 'right', 'bottom', 'left']}
        >
          <View style={styles.toolHeader}>
            <View style={[styles.toolHeaderIcon, styles.toolScreenIcon]}>
              <ScreenShare size={19} color={colors.amber} />
            </View>
            <View style={styles.headerCopy}>
              <Text style={styles.toolTitle}>共享手机屏幕</Text>
              <Text style={styles.toolSubtitle}>画面共享 · 可选播放音频</Text>
            </View>
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => {
                if (media.screenSharingBusy) media.stopScreenShare();
                setScreenShareSettingsOpen(false);
              }}
              accessibilityLabel="关闭屏幕共享设置"
            >
              <X size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.audioSettingsContent}>
            <View style={styles.screenShareOption}>
              <View style={styles.ownScreenText}>
                <Text style={styles.sectionTitle}>同时共享音频</Text>
                <Text style={styles.sectionSubtitle}>
                  共享视频、游戏等应用播放的声音，不改变麦克风设置。
                </Text>
              </View>
              <Switch
                value={includeScreenAudio && !!media.canShareScreenAudio}
                disabled={media.screenSharingBusy || !media.canShareScreenAudio}
                onValueChange={setIncludeScreenAudio}
                accessibilityLabel="同时共享音频"
                trackColor={{ false: colors.borderStrong, true: colors.screen }}
                thumbColor={colors.onScreen}
              />
            </View>
            <Text style={styles.sectionSubtitle}>
              {media.canShareScreenAudio
                ? '部分应用禁止音频录制，其声音不会被共享。Cove 通话声音不会重复共享。'
                : '共享音频需要 Android 10 或更新版本，此设备仍可共享画面。'}
            </Text>
            <View style={styles.screenPrivacyNote}>
              <ShieldAlert size={20} color={colors.amber} />
              <Text style={styles.screenPrivacyText}>
                开始后请在系统窗口确认共享范围。注意保护屏幕上的聊天、通知和个人信息；可随时在此处或系统录屏指示中停止。
              </Text>
            </View>
            {!media.inVoice && (
              <Text style={styles.noiseHint}>加入语音后才能开始共享屏幕。</Text>
            )}
            {media.screenSharingError && (
              <Text style={styles.errorText}>{media.screenSharingError}</Text>
            )}
            <TouchableOpacity
              style={[
                styles.submit,
                styles.screenSubmit,
                (media.screenSharingBusy || !media.inVoice) &&
                  styles.controlDisabled,
              ]}
              disabled={media.screenSharingBusy || !media.inVoice}
              accessibilityRole="button"
              accessibilityLabel="开始共享手机屏幕"
              onPress={async () => {
                if (
                  await media.startScreenShare(
                    includeScreenAudio && !!media.canShareScreenAudio,
                  )
                )
                  setScreenShareSettingsOpen(false);
              }}
            >
              {media.screenSharingBusy ? (
                <ActivityIndicator color={colors.onScreen} />
              ) : (
                <ScreenShare size={20} color={colors.onScreen} />
              )}
              <Text style={[styles.submitText, styles.screenSubmitText]}>
                {media.screenSharingBusy ? '正在启动共享…' : '开始共享'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal
        visible={audioSettingsOpen}
        animationType="slide"
        onRequestClose={() => setAudioSettingsOpen(false)}
      >
        <SafeAreaView
          style={styles.toolModal}
          edges={['top', 'right', 'bottom', 'left']}
        >
          <View style={styles.toolHeader}>
            <View style={[styles.toolHeaderIcon, styles.toolVoiceIcon]}>
              <Headphones size={19} color={colors.green} />
            </View>
            <View style={styles.headerCopy}>
              <Text style={styles.toolTitle}>音频设置</Text>
              <Text style={styles.toolSubtitle}>降噪 · 麦克风 · 声音输出</Text>
            </View>
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => setAudioSettingsOpen(false)}
              accessibilityLabel="关闭音频设置"
            >
              <X size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView
            contentContainerStyle={styles.audioSettingsContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.audioSettingsSection}>
              <Text style={styles.sectionTitle}>麦克风降噪</Text>
              <Text style={styles.noiseHint}>
                默认使用系统降噪，也可切换 RNNoise。两种降噪不会叠加。
              </Text>
              {media.noiseSwitching && (
                <Text style={styles.noiseHint}>正在切换降噪…</Text>
              )}
              {NOISE_MODES.map((option) => {
                const selected = media.noiseMode === option.value;
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[
                      styles.noiseOption,
                      selected && styles.noiseOptionActive,
                    ]}
                    disabled={audioSettingsBusy || option.disabled === true}
                    accessibilityRole="radio"
                    accessibilityLabel={option.label}
                    accessibilityState={{
                      checked: selected,
                      disabled: audioSettingsBusy || option.disabled === true,
                    }}
                    onPress={() => {
                      void media.selectNoiseMode(option.value);
                    }}
                    activeOpacity={option.disabled ? 1 : 0.78}
                  >
                    <Text
                      style={[
                        styles.noiseOptionText,
                        selected && styles.noiseOptionTextActive,
                        option.disabled && styles.noiseOptionTextDisabled,
                      ]}
                    >
                      {option.label}
                    </Text>
                    {selected ? (
                      <CheckCircle2 size={18} color={colors.blue} />
                    ) : null}
                  </TouchableOpacity>
                );
              })}
              {media.noiseError ? (
                <Text style={styles.formError}>{media.noiseError}</Text>
              ) : null}
            </View>

            <View style={styles.audioSettingsSection}>
              <Text style={styles.sectionTitle}>输入输出设备</Text>
              <Text style={styles.noiseHint}>
                选择麦克风和声音输出。通话中切换会立即生效。
              </Text>
              {media.audioDeviceSwitching && (
                <Text style={styles.noiseHint}>正在切换音频设备…</Text>
              )}

              <Text style={styles.deviceSectionTitle}>输出设备</Text>
              {media.audioOutputs.length === 0 ? (
                <Text style={styles.noiseHint}>暂无可切换输出设备</Text>
              ) : (
                media.audioOutputs.map((device) => {
                  const selected = media.selectedAudioOutputId === device.id;
                  return (
                    <TouchableOpacity
                      key={device.id}
                      style={[
                        styles.noiseOption,
                        selected && styles.noiseOptionActive,
                      ]}
                      disabled={audioSettingsBusy}
                      accessibilityRole="radio"
                      accessibilityLabel={`输出设备：${
                        device.label ||
                        outputDeviceLabel(device.id, media.audioOutputs)
                      }`}
                      accessibilityState={{
                        checked: selected,
                        disabled: audioSettingsBusy,
                      }}
                      onPress={async () => {
                        await media.selectAudioOutput(device.id);
                      }}
                      activeOpacity={0.78}
                    >
                      <Text
                        style={[
                          styles.noiseOptionText,
                          selected && styles.noiseOptionTextActive,
                        ]}
                      >
                        {device.label ||
                          outputDeviceLabel(device.id, media.audioOutputs)}
                      </Text>
                      {selected ? (
                        <CheckCircle2 size={18} color={colors.blue} />
                      ) : null}
                    </TouchableOpacity>
                  );
                })
              )}

              <Text style={styles.deviceSectionTitle}>输入设备</Text>
              {media.audioInputs.length === 0 ? (
                <Text style={styles.noiseHint}>暂无可切换输入设备</Text>
              ) : (
                media.audioInputs.map((device) => {
                  const selected = media.selectedAudioInputId === device.id;
                  return (
                    <TouchableOpacity
                      key={device.id}
                      style={[
                        styles.noiseOption,
                        selected && styles.noiseOptionActive,
                      ]}
                      disabled={audioSettingsBusy}
                      accessibilityRole="radio"
                      accessibilityLabel={`输入设备：${
                        device.label ||
                        inputDeviceLabel(device.id, media.audioInputs)
                      }`}
                      accessibilityState={{
                        checked: selected,
                        disabled: audioSettingsBusy,
                      }}
                      onPress={async () => {
                        await media.selectAudioInput(device.id);
                      }}
                      activeOpacity={0.78}
                    >
                      <Text
                        style={[
                          styles.noiseOptionText,
                          selected && styles.noiseOptionTextActive,
                        ]}
                      >
                        {device.label ||
                          inputDeviceLabel(device.id, media.audioInputs)}
                      </Text>
                      {selected ? (
                        <CheckCircle2 size={18} color={colors.blue} />
                      ) : null}
                    </TouchableOpacity>
                  );
                })
              )}

              {media.audioDeviceError ? (
                <Text style={styles.formError}>{media.audioDeviceError}</Text>
              ) : null}
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal
        visible={fullscreen}
        animationType="fade"
        supportedOrientations={['portrait', 'landscape']}
        onRequestClose={() => setFullscreen(false)}
      >
        <View style={styles.fullscreen}>
          <StatusBar hidden />
          {screenURL ? (
            <ZoomableScreenVideo key={screenURL} streamURL={screenURL} />
          ) : null}
          <SafeAreaView style={styles.fullscreenSafe} edges={['top', 'right']}>
            <TouchableOpacity
              style={styles.closeFullscreen}
              onPress={() => setFullscreen(false)}
              accessibilityLabel="关闭全屏共享"
            >
              <X size={22} color={colors.onVideo} />
            </TouchableOpacity>
          </SafeAreaView>
        </View>
      </Modal>

      <Modal
        visible={passwordPrompt && !roomReady}
        transparent
        animationType="fade"
        onRequestClose={onBack}
      >
        <SafeAreaView
          style={styles.promptBackdrop}
          edges={['top', 'right', 'bottom', 'left']}
        >
          <RoomFormScroll contentStyle={styles.promptScroll}>
            <View style={styles.promptCard}>
              <Text style={styles.modalTitle}>输入房间密码</Text>
              <Text style={styles.sectionSubtitle}>{room.name}</Text>
              {joinError && <Text style={styles.formError}>{joinError}</Text>}
              <Text style={styles.formLabel}>房间密码</Text>
              <RoomFormInput
                value={joinPassword}
                onChangeText={setJoinPassword}
                secureTextEntry
                maxLength={128}
                autoFocus
                placeholder="房间密码"
                placeholderTextColor={colors.textFaint}
                style={styles.input}
                editable={!joinPending}
                accessibilityLabel="房间密码"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="go"
                onSubmitEditing={() => joinRoom(joinPassword)}
              />
              <TouchableOpacity
                style={[styles.submit, joinPending && styles.controlDisabled]}
                disabled={joinPending}
                onPress={() => joinRoom(joinPassword)}
              >
                <Text style={styles.submitText}>
                  {joinPending ? '验证中…' : '进入房间'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.clearPassword} onPress={onBack}>
                <Text style={styles.cancelText}>取消并返回</Text>
              </TouchableOpacity>
            </View>
          </RoomFormScroll>
        </SafeAreaView>
      </Modal>

      <Modal
        visible={settingsOpen}
        animationType="slide"
        onRequestClose={() => setSettingsOpen(false)}
      >
        <SafeAreaView
          style={styles.toolModal}
          edges={['top', 'right', 'bottom', 'left']}
        >
          <View style={styles.toolHeader}>
            <View style={styles.toolHeaderIcon}>
              <Settings size={20} color={colors.blue} />
            </View>
            <View style={styles.headerCopy}>
              <Text style={styles.toolTitle}>房间设置</Text>
              <Text style={styles.toolSubtitle}>{room.name}</Text>
            </View>
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => setSettingsOpen(false)}
              accessibilityLabel="关闭房间设置"
            >
              <X size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <RoomFormScroll contentStyle={styles.toolContent}>
            <Text style={styles.formLabel}>人数上限（含房主）</Text>
            <View style={styles.limitPresets}>
              {ROOM_LIMIT_PRESETS.map((value) => (
                <TouchableOpacity
                  key={value || 'unlimited'}
                  style={[
                    styles.limitPreset,
                    settingsLimit === value && styles.limitPresetActive,
                  ]}
                  disabled={settingsPending}
                  onPress={() => setSettingsLimit(value)}
                  accessibilityRole="radio"
                  accessibilityLabel={`人数上限：${value || '不限'}`}
                  accessibilityState={{
                    checked: settingsLimit === value,
                    disabled: settingsPending,
                  }}
                >
                  <Text style={styles.limitPresetText}>{value || '不限'}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <RoomFormInput
              value={settingsLimit}
              onChangeText={setSettingsLimit}
              editable={!settingsPending}
              keyboardType="number-pad"
              placeholder="自定义人数，留空表示不限"
              placeholderTextColor={colors.textFaint}
              style={styles.input}
              accessibilityLabel="自定义人数上限"
            />
            <Text style={styles.formLabel}>新密码（留空保持不变）</Text>
            <RoomFormInput
              value={settingsPassword}
              onChangeText={setSettingsPassword}
              editable={!settingsPending}
              secureTextEntry
              maxLength={128}
              placeholder="保持不变"
              placeholderTextColor={colors.textFaint}
              style={styles.input}
              accessibilityLabel="新房间密码"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.sectionSubtitle}>
              修改密码不影响现有成员；降低上限只限制新成员加入。
            </Text>
            {settingsError && (
              <Text style={styles.formError}>{settingsError}</Text>
            )}
            <TouchableOpacity
              style={[
                styles.submit,
                styles.confirmSubmit,
                settingsPending && styles.controlDisabled,
              ]}
              disabled={settingsPending || !sessionReady}
              onPress={() => saveRoomSettings()}
            >
              <Text style={[styles.submitText, styles.confirmSubmitText]}>
                {settingsPending ? '保存中…' : '保存设置'}
              </Text>
            </TouchableOpacity>
            {roomMeta.hasPassword && (
              <TouchableOpacity
                style={styles.clearPassword}
                disabled={settingsPending || !sessionReady}
                onPress={() => saveRoomSettings(true)}
              >
                <Text style={styles.clearPasswordText}>取消房间密码</Text>
              </TouchableOpacity>
            )}
          </RoomFormScroll>
        </SafeAreaView>
      </Modal>

      <ChatPanel
        visible={chatOpen}
        socket={socket}
        roomId={room.id}
        serverURL={config.serverURL}
        username={config.username}
        members={members}
        profileRemarks={profileRemarks}
        ready={roomReady}
        onClose={() => setChatOpen(false)}
      />

      <Modal
        visible={soundboardOpen}
        animationType="slide"
        onRequestClose={() => setSoundboardOpen(false)}
      >
        <SafeAreaView
          style={styles.toolModal}
          edges={['top', 'right', 'bottom', 'left']}
        >
          <View style={styles.toolHeader}>
            <View style={styles.toolHeaderIcon}>
              <AudioLines size={19} color={colors.purple} />
            </View>
            <View style={styles.headerCopy}>
              <Text style={styles.toolTitle}>语音包</Text>
              <Text style={styles.toolSubtitle}>
                {media.inVoice
                  ? '点按语音包即可在当前语音频道播放'
                  : '加入语音后才能播放语音包'}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => setSoundboardOpen(false)}
              accessibilityLabel="关闭语音包"
            >
              <X size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView
            contentContainerStyle={styles.soundboardContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <Soundboard
              socket={socket}
              roomId={room.id}
              serverURL={config.serverURL}
              ready={roomReady}
              inVoice={media.inVoice}
              profileRemarks={profileRemarks}
              showHeading={false}
            />
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {viewingProfile && (
        <UserProfileModal
          visible
          userId={viewingProfile.userId}
          username={viewingProfile.username}
          avatarUrl={viewingProfile.avatarUrl}
          remark={profileRemarks[viewingProfile.userId]}
          inVoice={media.voiceMembers.some(
            (member) => member.socketId === viewingProfile.socketId,
          )}
          isMicOn={
            !media.voiceMembers.find(
              (member) => member.socketId === viewingProfile.socketId,
            )?.isMuted
          }
          volume={media.memberVolumes[viewingProfile.socketId] ?? 1}
          onVolumeChange={(volume) =>
            media.setMemberVolume(viewingProfile.socketId, volume)
          }
          onSaveRemark={(remark) => {
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
