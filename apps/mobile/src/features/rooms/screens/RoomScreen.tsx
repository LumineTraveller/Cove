import { useRoomStyles } from './roomStyles';
import { InlineVolumeSlider } from '../../media/components/InlineVolumeSlider';
export { InlineVolumeSlider } from '../../media/components/InlineVolumeSlider';
import { useRoomController, type MobileRoomProps } from '../useRoomController';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

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
  useWindowDimensions,
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
import { useScreenAnnotations } from '../../media/annotation/useScreenAnnotations';
import { ScreenAnnotationLayer } from '../../media/annotation/ScreenAnnotationLayer';
import {
  AnnotationTools,
  type MobileAnnotationTool,
} from '../../media/annotation/AnnotationTools';
import type { AnnotationPoint } from '@cove/contracts';
import { useMobileRemoteControl } from '../../remote-control/useMobileRemoteControl';
import { MobileDiagnostics } from '../../media/diagnostics/MobileDiagnosticsModal';
import { Avatar } from '../../profiles/components/Avatar';
import { ROOM_LIMIT_PRESETS } from '../roomSettings';

import { Soundboard } from '../../soundpacks/components/Soundboard';
import { useSoundboard } from '../../soundpacks/useSoundboard';
import { SoundpackPlayer } from '../../soundpacks/components/SoundpackPlayer';
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

  const soundboard = useSoundboard({
    socket,
    roomId: room.id,
    serverURL: config.serverURL,
    accountId: config.accountId ?? config.clientId,
    ready: roomReady,
    inVoice: media.inVoice,
    outputDeviceId: media.selectedAudioOutputId,
  });
  const watching = media.availableScreens.find(
    screen => screen.socketId === media.watchingScreenPeerId,
  );
  const annotations = useScreenAnnotations({
    socket,
    roomId: room.id,
    sharerSocketId: watching?.socketId ?? '',
    sessionId: watching?.videoProducerId ?? null,
    self: false,
    active: roomReady && Boolean(screenURL),
  });
  const ownAnnotations = useScreenAnnotations({
    socket,
    roomId: room.id,
    sharerSocketId: socket.id ?? '',
    sessionId: media.screenProducerId ?? null,
    self: true,
    active: roomReady && media.sharingScreen,
  });
  const remote = useMobileRemoteControl({
    socket,
    roomId: room.id,
    targetSocketId: watching?.socketId ?? null,
    allowed:
      roomReady && Boolean(screenURL) && annotations.remoteControlAllowed,
  });
  const [annotationTool, setAnnotationTool] =
    useState<MobileAnnotationTool>('pen');
  const [annotationColor, setAnnotationColor] = useState('#FF5A5F');
  const [annotationWidth, setAnnotationWidth] = useState(0.006);
  const [ownAnnotationsOpen, setOwnAnnotationsOpen] = useState(false);
  const [remoteKeyboardOpen, setRemoteKeyboardOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [remoteText, setRemoteText] = useState('');
  const remoteTextRef = useRef(remoteText);
  remoteTextRef.current = remoteText;
  const sendRemoteText = async () => {
    const value = remoteTextRef.current;
    if (await remote.typeText(value)) {
      if (remoteTextRef.current === value) setRemoteText('');
    }
  };
  const windowSize = useWindowDimensions();
  const [ownCanvasSize, setOwnCanvasSize] = useState({ width: 1, height: 1 });
  const touchState = useRef<{
    strokeId?: string;
    point: AnnotationPoint;
    pressed: boolean;
  }>({ point: { x: 0.5, y: 0.5 }, pressed: false });
  const actions = useRef({
    annotations,
    remote,
    annotationTool,
    annotationColor,
    annotationWidth,
  });
  actions.current = {
    annotations,
    remote,
    annotationTool,
    annotationColor,
    annotationWidth,
  };
  const controlling = Boolean(remote.session) && !annotations.localActive;
  const setRemoteInputEnabled = remote.setInputEnabled;
  useEffect(() => {
    setRemoteInputEnabled(controlling);
    if (!controlling) setRemoteKeyboardOpen(false);
  }, [controlling, setRemoteInputEnabled]);
  const interaction = useMemo(() => {
    if (!annotations.canDraw && !controlling) return undefined;
    const end = () => {
      const current = actions.current;
      if (touchState.current.pressed)
        current.remote.button('left', false, touchState.current.point);
      touchState.current.pressed = false;
      if (touchState.current.strokeId)
        current.annotations.finishStroke(touchState.current.strokeId);
      touchState.current.strokeId = undefined;
      current.annotations.sendLaser(null);
    };
    const start = (point: AnnotationPoint) => {
      const current = actions.current;
      touchState.current.point = point;
      if (current.remote.session && !current.annotations.localActive) {
        current.remote.button('left', true, point);
        touchState.current.pressed = true;
      } else if (current.annotationTool === 'laser')
        current.annotations.sendLaser(point);
      else {
        const id = `mobile-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2)}`;
        touchState.current.strokeId =
          current.annotations.sendStroke(
            current.annotationTool,
            current.annotationColor,
            current.annotationWidth,
            [point],
            id,
            false,
          ) ?? undefined;
      }
    };
    return {
      onStart: start,
      onMove: (point: AnnotationPoint | null) => {
        if (!point) return end();
        const current = actions.current;
        touchState.current.point = point;
        if (current.remote.session && !current.annotations.localActive)
          current.remote.pointer(point);
        else if (current.annotationTool === 'laser')
          current.annotations.sendLaser(point);
        else if (touchState.current.strokeId)
          current.annotations.sendStroke(
            current.annotationTool,
            current.annotationColor,
            current.annotationWidth,
            [point],
            touchState.current.strokeId,
            false,
          );
        else start(point);
      },
      onEnd: end,
    };
  }, [annotations.canDraw, controlling]);
  const annotationOverlay = (
    viewport: { width: number; height: number },
    video?: { width: number; height: number },
  ) => (
    <ScreenAnnotationLayer
      viewport={viewport}
      video={video}
      strokes={[
        ...(annotations.state?.strokes ?? []),
        ...annotations.optimisticStrokes,
      ]}
      lasers={annotations.laserPoints}
    />
  );
  const remoteTargetSupported =
    members.find(member => member.socketId === watching?.socketId)
      ?.canReceiveRemoteControl === true;
  const remoteAction = (
    label: string,
    action: () => void,
    disabled = false,
  ) => (
    <TouchableOpacity
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{
        disabled:
          disabled ||
          (Boolean(remote.session) && !controlling && label !== '结束远控'),
      }}
      disabled={
        disabled ||
        (Boolean(remote.session) && !controlling && label !== '结束远控')
      }
      onPress={action}
      style={[
        styles.toolbarAction,
        {
          minHeight: 44,
          paddingHorizontal: 12,
          opacity:
            disabled ||
            (Boolean(remote.session) && !controlling && label !== '结束远控')
              ? 0.5
              : 1,
        },
      ]}
    >
      <Text style={styles.toolbarText}>{label}</Text>
    </TouchableOpacity>
  );
  const screenTools = (
    <View style={{ backgroundColor: colors.background, paddingHorizontal: 8 }}>
      {(annotations.localActive || remote.session) && (
        <Text
          testID="screen-interaction-mode"
          accessibilityLiveRegion="polite"
          style={styles.sectionSubtitle}
        >
          {annotations.localActive
            ? remote.session ? '批注模式 · 远控输入已暂停' : '批注模式 · 单指绘制，双指缩放'
            : '远控模式 · 单指操作桌面，双指缩放'}
        </Text>
      )}
      <AnnotationTools
        annotations={annotations}
        tool={annotationTool}
        setTool={value => {interaction?.onEnd(); setAnnotationTool(value);}}
        color={annotationColor}
        setColor={value => {interaction?.onEnd(); setAnnotationColor(value);}}
        width={annotationWidth}
        setWidth={value => {interaction?.onEnd(); setAnnotationWidth(value);}}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {remote.session ? (
          <>
            {remoteAction('结束远控', remote.stop)}
            {remoteAction('键盘输入', () => setRemoteKeyboardOpen(true))}
            {remoteAction('右键', () =>
              remote.click(touchState.current.point, 'right'),
            )}
            {remoteAction('向上滚动', () =>
              remote.wheel(touchState.current.point, 0, -120),
            )}
            {remoteAction('向下滚动', () =>
              remote.wheel(touchState.current.point, 0, 120),
            )}
            {[
              'Enter',
              'Escape',
              'Tab',
              'Backspace',
              'ArrowUp',
              'ArrowDown',
              'ArrowLeft',
              'ArrowRight',
            ].map(code => remoteAction(code, () => remote.shortcut([code])))}
            {remoteAction('复制', () =>
              remote.shortcut(['ControlLeft', 'KeyC']),
            )}
            {remoteAction('粘贴', () =>
              remote.shortcut(['ControlLeft', 'KeyV']),
            )}
          </>
        ) : remote.pending ? (
          remoteAction('取消远控请求', remote.cancel)
        ) : (
          remoteAction(
            '申请远控',
            () => {
              annotations.exit();
              remote.request();
            },
            !remoteTargetSupported || !annotations.remoteControlAllowed,
          )
        )}
      </ScrollView>
      {remote.error && (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.formError, { paddingBottom: 6 }]}
        >
          {remote.error}
        </Text>
      )}
      {!remoteTargetSupported && (
        <Text style={styles.sectionSubtitle}>
          此共享端不支持系统被控；手机可控制支持的 Windows 共享端。
        </Text>
      )}
    </View>
  );

  const screenContent = screenURL ? (
    <ZoomableScreenVideo
      key={screenURL}
      streamURL={screenURL}
      interaction={interaction}
      overlay={annotationOverlay}
    />
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
        {media.availableScreens.map(screen => {
          const name = displayScreenSharer(screen.socketId);
          return (
            <TouchableOpacity
              key={screen.videoProducerId}
              style={styles.watchButton}
              onPress={() => media.watchScreen(screen.socketId)}
              disabled={media.screenWatchingBusy}
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
            member => member.socketId === socket.id && member.isOwner,
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
        {roomReady && (
          <TouchableOpacity
            style={styles.toolbarAction}
            accessibilityLabel="媒体状态"
            onPress={() => setDiagnosticsOpen(true)}
          >
            <Text style={styles.toolbarText}>媒体状态</Text>
          </TouchableOpacity>
        )}
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

        {screenURL && !fullscreen && screenTools}
        {media.sharingScreen && (
          <TouchableOpacity
            style={styles.toolbarAction}
            accessibilityLabel="管理我的共享批注"
            onPress={() => setOwnAnnotationsOpen(true)}
          >
            <Text style={styles.toolbarText}>
              共享批注 · {ownAnnotations.state?.strokes.length ?? 0} 笔
            </Text>
          </TouchableOpacity>
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
            {media.availableScreens.map(screen => {
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
          media.applicationAudioShares.map(share => {
            const owner = members.find(
              member => member.socketId === share.socketId,
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
                    onChange={volume =>
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
            {members.map(member => {
              const voiceMember = media.voiceMembers.find(
                voice => voice.socketId === member.socketId,
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
                  当前 Android 采集通道以 30 FPS
                  运行。观看帧率由共享源与设备决定；系统会提示屏幕录制授权。
                </Text>
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
              {NOISE_MODES.map(option => {
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
                media.audioOutputs.map(device => {
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
                media.audioInputs.map(device => {
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
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={{ flex: 1 }}>
              {screenURL ? (
                <ZoomableScreenVideo
                  key={screenURL}
                  streamURL={screenURL}
                  interaction={interaction}
                  overlay={annotationOverlay}
                />
              ) : null}
            </View>
            <SafeAreaView edges={['bottom', 'left', 'right']}>
              {screenURL && screenTools}
            </SafeAreaView>
          </KeyboardAvoidingView>
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
        visible={ownAnnotationsOpen && media.sharingScreen}
        supportedOrientations={['portrait', 'landscape']}
        onRequestClose={() => setOwnAnnotationsOpen(false)}
      >
        <SafeAreaView
          style={styles.toolModal}
          edges={['top', 'right', 'bottom', 'left']}
        >
          <View style={styles.toolHeader}>
            <View style={styles.headerCopy}>
              <Text style={styles.toolTitle}>我的共享批注</Text>
              <Text style={styles.toolSubtitle}>
                只在 Cove 内显示，不覆盖其他应用
              </Text>
            </View>
            <TouchableOpacity
              style={styles.iconButton}
              accessibilityLabel="关闭我的共享批注"
              onPress={() => setOwnAnnotationsOpen(false)}
            >
              <X size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <View
            style={[styles.audioSettingsSection, { paddingHorizontal: 16 }]}
          >
            <View style={styles.ownScreenCard}>
              <Text style={styles.sectionTitle}>允许所有观看者直接批注</Text>
              <Switch
                value={ownAnnotations.annotationsAllowed}
                disabled={
                  !ownAnnotations.ready || Boolean(ownAnnotations.pendingAction)
                }
                onValueChange={value => {
                  void ownAnnotations.setAnnotationsAllowed(value);
                }}
              />
            </View>
            <Text style={styles.sectionSubtitle}>
              画布显示共享视频的归一化位置；Android 无法显示 Windows
              的系统全屏覆盖层。
            </Text>
            {ownAnnotations.error && (
              <Text style={styles.formError}>{ownAnnotations.error}</Text>
            )}
            {ownAnnotations.state?.requests.map(request => (
              <View key={request.socketId} style={styles.ownScreenCard}>
                <Text style={styles.sectionTitle}>
                  {request.username}申请批注
                </Text>
                <TouchableOpacity
                  style={styles.toolbarAction}
                  onPress={() => {
                    void ownAnnotations.respond(request.socketId, true);
                  }}
                >
                  <Text style={styles.toolbarText}>允许</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.toolbarAction}
                  onPress={() => {
                    void ownAnnotations.respond(request.socketId, false);
                  }}
                >
                  <Text style={styles.toolbarText}>拒绝</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
          <View
            style={{ flex: 1, backgroundColor: '#111827', margin: 16 }}
            onLayout={event => setOwnCanvasSize(event.nativeEvent.layout)}
          >
            <ScreenAnnotationLayer
              viewport={ownCanvasSize}
              video={media.sharedScreenSize ?? windowSize}
              strokes={ownAnnotations.state?.strokes ?? []}
              lasers={ownAnnotations.laserPoints}
            />
          </View>
        </SafeAreaView>
      </Modal>

      <Modal
        visible={remoteKeyboardOpen && controlling}
        supportedOrientations={['portrait', 'landscape']}
        onRequestClose={() => setRemoteKeyboardOpen(false)}
      >
        <SafeAreaView
          style={styles.toolModal}
          edges={['top', 'right', 'bottom', 'left']}
        >
          <View style={styles.toolHeader}>
            <View style={styles.headerCopy}>
              <Text style={styles.toolTitle}>远控键盘</Text>
              <Text style={styles.toolSubtitle}>
                输入英文、数字与符号，中文输入法需要共享端完成。
              </Text>
            </View>
            <TouchableOpacity
              style={styles.iconButton}
              accessibilityLabel="关闭远控键盘"
              onPress={() => setRemoteKeyboardOpen(false)}
            >
              <X size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <RoomFormScroll contentStyle={styles.toolContent}>
            <Text style={styles.formLabel}>发送到共享端的按键</Text>
            <RoomFormInput
              value={remoteText}
              onChangeText={setRemoteText}
              maxLength={256}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="英文、数字和符号"
              placeholderTextColor={colors.textFaint}
              style={styles.input}
              accessibilityLabel="远控键盘输入"
              onSubmitEditing={() => {
                void sendRemoteText();
              }}
            />
            <TouchableOpacity
              style={styles.submit}
              disabled={!remoteText || !remote.session}
              onPress={() => {
                void sendRemoteText();
              }}
              accessibilityLabel="发送远控键盘输入"
            >
              <Text style={styles.submitText}>发送按键</Text>
            </TouchableOpacity>
            {remote.error && (
              <Text style={styles.formError}>{remote.error}</Text>
            )}
          </RoomFormScroll>
        </SafeAreaView>
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
              {ROOM_LIMIT_PRESETS.map(value => (
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
              controller={soundboard}
              visible={soundboardOpen}
              profileRemarks={profileRemarks}
              showHeading={false}
            />
          </ScrollView>
        </SafeAreaView>
      </Modal>
      <SoundpackPlayer controller={soundboard} />
      <MobileDiagnostics
        visible={diagnosticsOpen}
        collect={media.collectDiagnostics}
        onClose={() => setDiagnosticsOpen(false)}
      />

      {viewingProfile && (
        <UserProfileModal
          visible
          userId={viewingProfile.userId}
          username={viewingProfile.username}
          avatarUrl={viewingProfile.avatarUrl}
          remark={profileRemarks[viewingProfile.userId]}
          inVoice={media.voiceMembers.some(
            member => member.socketId === viewingProfile.socketId,
          )}
          isMicOn={
            !media.voiceMembers.find(
              member => member.socketId === viewingProfile.socketId,
            )?.isMuted
          }
          volume={media.memberVolumes[viewingProfile.socketId] ?? 1}
          onVolumeChange={volume =>
            media.setMemberVolume(viewingProfile.socketId, volume)
          }
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
