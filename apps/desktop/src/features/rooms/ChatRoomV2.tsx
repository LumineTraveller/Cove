import { useLayoutEffect, useRef } from 'react';
import { useRoomController, type ChatRoomProps } from './useRoomController';
import { useSharedChatLayout } from './useSharedChatLayout';

import {
  CaretLeft,
  CaretRight,
  DoorOpen,
  Eye,
  CircleNotch as LoaderCircle,
  Microphone,
  MicrophoneSlash,
  Cursor as MousePointer2,
} from '@phosphor-icons/react';
import { socket } from '../connection/socket';

import { ProfileModal } from '../profiles/components/ProfileModal';
import { UserProfileModal } from '../profiles/components/UserProfileModal';
import { SoundPackPanel } from '../soundpacks/components/SoundPackPanel';
import { CreateRoomDialog } from './components/CreateRoomDialog';

import { getProfileDisplayName, saveProfileRemark } from '../profiles/profileRemarks';

import { resolveRoomAvatarUrl } from './appearance';

import { GlobalSettingsV2 } from '../settings/components/GlobalSettingsV2';
import { ChatPanelV2 } from '../chat/ChatPanelV2';
import { NavigationRailV2 } from './components/NavigationRailV2';
import { MemberAvatar, SharedBadges } from '../profiles/MemberAvatar';
import { VolumeControl, VerticalVolume } from '../media/components/VolumeControl';
import { ShareViewV2 } from '../media/screen/ShareViewV2';
import { ControlBallV2 } from '../media/components/ControlBallV2';
import { AudioShareMenuV2 } from '../media/application-audio/AudioShareMenuV2';
import { RoomAppearanceSettings } from './components/RoomAppearanceSettings';
import { ScreenShareSettingsV2 } from '../media/screen/ScreenShareSettingsV2';
import '../../styles/ui-v2.css';
export type { RoomWithAppearance } from './appearance';
export { RoomAppearanceSettings } from './components/RoomAppearanceSettings';
export type { GlobalSettingsPage } from '../settings/components/GlobalSettingsV2';
export { GlobalSettingsV2 } from '../settings/components/GlobalSettingsV2';
export { NavigationRailV2 } from './components/NavigationRailV2';

export default function ChatRoomV2({
  profile,
  accountId,
  onProfileChange,
  onLogout,
  serverURL,
  sessionReady,
  theme,
  onThemeChange,
}: ChatRoomProps) {
  const {
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
  } = useRoomController({
    profile,
    accountId,
    onProfileChange,
    onLogout,
    serverURL,
    sessionReady,
    theme,
    onThemeChange,
  });

  const chatSlotRef = useRef<HTMLDivElement>(null);
  const chatToggleRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const sharedChatDrawer = useSharedChatLayout(shellRef, shareLayout, sidebarOpen, Boolean(room && roomSynced && messagesLoaded));
  useLayoutEffect(() => {
    if (!chatVisible && chatSlotRef.current?.contains(document.activeElement))
      chatToggleRef.current?.focus({ preventScroll: true });
  }, [chatVisible]);

  if (!room || !roomSynced || !messagesLoaded)
    return (
      <div className={`cove-v2-loading foreground-${foreground}`} style={appearanceStyle}>
        <section>
          {joinError ? (
            <>
              <h2>
                {room?.hasPassword
                  ? `「${room.name}」被加密`
                  : `无法进入「${room?.name ?? '频道'}」`}
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
              <p>{joining ? '正在加入频道…' : '加载频道…'}</p>
            </>
          )}
          <div>
            <button onClick={() => navigate('/')}>返回</button>
            {joinError && (
              <button onClick={retryJoin}>{room?.hasPassword ? '进入' : '重试'}</button>
            )}
          </div>
        </section>
      </div>
    );
  const mode = rtc.localScreen
    ? 'self'
    : rtc.remoteScreen
    ? 'watching'
    : rtc.availableScreens.length
    ? 'available'
    : 'idle';
  const remoteState: 'available' | 'pending' | 'active' | 'unsupported' =
    remoteSession?.role === 'controller'
      ? 'active'
      : pendingRemoteRequest
      ? 'pending'
      : rtc.remoteScreen &&
        roomMembers.find((member) => member.socketId === rtc.remoteScreen?.socketId)
          ?.canReceiveRemoteControl &&
        window.coveRemoteControl?.supported
      ? 'available'
      : 'unsupported';
  const remoteSharer = rtc.remoteScreen
    ? roomMembers.find((member) => member.socketId === rtc.remoteScreen?.socketId)
    : null;
  const sharedScreenSharerName = rtc.remoteScreen
    ? remoteSharer
      ? getProfileDisplayName(remoteSharer.username, remoteSharer.userId, profileRemarks)
      : (() => {
          const voiceSharer = rtc.voiceMembers.find(
            (member) => member.socketId === rtc.remoteScreen?.socketId,
          );
          return voiceSharer
            ? getProfileDisplayName(voiceSharer.username, voiceSharer.userId, profileRemarks)
            : '成员';
        })()
    : '你';
  return (
    <main className={`prototype-page cove-v2-page foreground-${foreground}`}>
      <div
        ref={shellRef}
        className={`cove-shell ${
          sidebarOpen ? 'nav-wide' : 'nav-narrow'
        } mode-${mode} foreground-${foreground} ${chatVisible ? 'chat-open' : 'chat-closed'} ${
          animateShareChat ? 'share-chat-animated' : ''
        } ${
          animateLayoutControls ? 'layout-controls-animated' : ''
        } ${sharedChatDrawer ? 'share-chat-drawer' : ''}`}
        style={appearanceStyle}
      >
        <NavigationRailV2
          rooms={rooms}
          activeRoom={roomId ?? ''}
          profileName={getProfileDisplayName(
            profile.username,
            roomMembers.find((member) => member.socketId === socket.id)?.userId,
            profileRemarks,
          )}
          onRoom={(id) => navigate(`/room/${id}`)}
          expanded={sidebarOpen}
          setExpanded={setSidebarOpen}
          onSettings={() => {
            setGlobalSettingsPage('audio');
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
                    <img src={resolveRoomAvatarUrl(room.avatarUrl) ?? undefined} alt="" />
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
                    const displayName = getProfileDisplayName(
                      member.username,
                      member.userId,
                      profileRemarks,
                    );
                    const screen =
                      Boolean(member.isSharingScreen) ||
                      (isSelf && Boolean(rtc.localScreen)) ||
                      rtc.availableScreens.some((item) => item.socketId === member.socketId);
                    // 只根据独立的 application-audio producer 显示音频标识。
                    // 屏幕共享自带的 screen-audio 不应让“共享音频”联动亮起。
                    const audio =
                      (isSelf && rtc.isApplicationAudioSharing) ||
                      rtc.remoteApplicationAudios.some((item) => item.socketId === member.socketId);
                    const volume = isSelf
                      ? inputVolume
                      : (rtc.memberVolumes[member.socketId] ?? 1) * 100;
                    const sharedVolume = getSharedAudioVolume(member, isSelf);
                    const level =
                      rtc.speakingLevels[member.socketId] ??
                      (isSelf ? rtc.speakingLevels[rtc.localSocketId ?? ''] ?? 0 : 0);
                    const speaking = Boolean(
                      voice && level > 0.08 && !voice.isMuted && !(isSelf && rtc.isMuted),
                    );
                    return (
                      <article
                        className={`member-row ${isSelf ? 'self' : ''} ${
                          screen ? 'has-watch' : ''
                        } ${voice ? 'in-voice' : 'not-in-voice'}`}
                        key={member.socketId}
                        onContextMenu={(event) => {
                          // 房主右键唤出成员操作；非房主只屏蔽浏览器菜单。
                          openMemberMenu(event, member, isSelf);
                        }}
                      >
                        <button
                          className="member-identity"
                          onContextMenu={(event) => event.preventDefault()}
                          onClick={() =>
                            isSelf ? setShowProfile(true) : setViewingProfile(member)
                          }
                        >
                          <MemberAvatar
                            member={{
                              ...member,
                              ...(isSelf
                                ? {
                                    username: profile.username,
                                    avatarUrl: profile.avatarUrl,
                                  }
                                : {}),
                              username: isSelf
                                ? getProfileDisplayName(
                                    profile.username,
                                    member.userId,
                                    profileRemarks,
                                  )
                                : displayName,
                              isMuted: Boolean(
                                member.isMuted || voice?.isMuted || (isSelf && rtc.isMuted),
                              ),
                            }}
                            inVoice={Boolean(voice)}
                            speaking={speaking}
                          />
                          <span className="member-name">
                            <b>{isSelf ? `${displayName}（你）` : displayName}</b>
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
                                  : rtc.setMemberVolume(member.socketId, member.userId, value / 100)
                              }
                              icon={isSelf ? 'mic' : 'speaker'}
                              label={isSelf ? '麦克风发送音量' : `${displayName} 的音量`}
                              muted={
                                isSelf
                                  ? rtc.isMuted
                                  : (rtc.memberVolumes[member.socketId] ?? 1) === 0
                              }
                              level={level}
                              onMute={
                                isSelf
                                  ? rtc.toggleMute
                                  : () => rtc.toggleMemberMute(member.socketId, member.userId)
                              }
                            />
                            {audio && (
                              <VolumeControl
                                value={sharedVolume * 100}
                                onChange={(value) =>
                                  setSharedAudioVolume(member, isSelf, value / 100)
                                }
                                icon="share"
                                level={rtc.sharedAudioLevels[member.socketId] ?? 0}
                                muted={sharedVolume === 0}
                                onMute={() => toggleSharedAudioMute(member, isSelf)}
                                label={isSelf ? '共享发送音量' : `${displayName} 的共享音频音量`}
                              />
                            )}
                          </div>
                        )}
                        {rtc.inVoice && screen && !isSelf && (
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
                      (member.socketId === socket.id && rtc.isApplicationAudioSharing) ||
                      rtc.remoteApplicationAudios.some((item) => item.socketId === member.socketId);
                    const isSelf = member.socketId === socket.id;
                    const onVolumeDraggingChange = (dragging: boolean) =>
                      setDraggingVolumeMember((current) =>
                        dragging ? member.socketId : current === member.socketId ? null : current,
                      );
                    const displayName = getProfileDisplayName(
                      member.username,
                      member.userId,
                      profileRemarks,
                    );
                    const sharedVolume = getSharedAudioVolume(member, isSelf);
                    const level =
                      rtc.speakingLevels[member.socketId] ??
                      (isSelf ? rtc.speakingLevels[rtc.localSocketId ?? ''] ?? 0 : 0);
                    const speaking = Boolean(
                      voice && level > 0.08 && !voice.isMuted && !(isSelf && rtc.isMuted),
                    );
                    return (
                      <div className="strip-member" key={member.socketId}>
                        <button
                          className="strip-member-button"
                          onContextMenu={(event) => openMemberMenu(event, member, isSelf)}
                          onClick={() =>
                            member.socketId === socket.id
                              ? setShowProfile(true)
                              : setViewingProfile(member)
                          }
                        >
                          <MemberAvatar
                            member={{
                              ...member,
                              ...(isSelf
                                ? {
                                    username: profile.username,
                                    avatarUrl: profile.avatarUrl,
                                  }
                                : {}),
                              username: isSelf
                                ? getProfileDisplayName(
                                    profile.username,
                                    member.userId,
                                    profileRemarks,
                                  )
                                : displayName,
                              isMuted: Boolean(
                                member.isMuted ||
                                  (member.socketId === socket.id && rtc.isMuted) ||
                                  rtc.voiceMembers.find(
                                    (voice) => voice.socketId === member.socketId,
                                  )?.isMuted,
                              ),
                            }}
                            inVoice={Boolean(voice)}
                            speaking={speaking}
                          />
                          <b>
                            {member.socketId === socket.id ? `${displayName}（你）` : displayName}
                          </b>
                          <SharedBadges screen={screen} audio={audio} />
                        </button>
                        {voice && (
                          <div
                            className={`vertical-volume-popover popover-card${
                              draggingVolumeMember === member.socketId ? ' is-dragging' : ''
                            }`}
                          >
                            <VerticalVolume
                              value={
                                member.socketId === socket.id
                                  ? inputVolume
                                  : (rtc.memberVolumes[member.socketId] ?? 1) * 100
                              }
                              onChange={(value) =>
                                member.socketId === socket.id
                                  ? setInputVolume(value)
                                  : rtc.setMemberVolume(member.socketId, member.userId, value / 100)
                              }
                              label="语音"
                              onDraggingChange={onVolumeDraggingChange}
                              icon={isSelf ? 'mic' : 'speaker'}
                              muted={
                                isSelf
                                  ? rtc.isMuted
                                  : (rtc.memberVolumes[member.socketId] ?? 1) === 0
                              }
                              level={level}
                              onMute={
                                isSelf
                                  ? rtc.toggleMute
                                  : () => rtc.toggleMemberMute(member.socketId, member.userId)
                              }
                            />
                            {audio && (
                              <VerticalVolume
                                value={sharedVolume * 100}
                                onChange={(value) =>
                                  setSharedAudioVolume(member, isSelf, value / 100)
                                }
                                label="共享"
                                onDraggingChange={onVolumeDraggingChange}
                                colorClass="purple"
                                icon="share"
                                level={rtc.sharedAudioLevels[member.socketId] ?? 0}
                                muted={sharedVolume === 0}
                                onMute={() => toggleSharedAudioMute(member, isSelf)}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="share-layout-body">
                <ShareViewV2
                  rtc={rtc}
                  roomId={roomId ?? ''}
                  sharerName={sharedScreenSharerName}
                  debug={debug}
                  onToggleDebug={() => {
                    setDebug((value) => !value);
                    rtc.toggleStats();
                  }}
                  remoteControl={{
                    state: remoteState,
                    sharerActive: remoteSession?.role === 'sharer',
                    controllerName: remoteSession?.controllerName
                      ? getProfileDisplayName(
                          remoteSession.controllerName,
                          remoteSession.controllerUserId,
                          profileRemarks,
                        )
                      : undefined,
                    cooldownSeconds: remoteRequestCooldownSeconds,
                  }}
                  onInput={sendRemoteInput}
                  onRequestRemote={requestRemote}
                  onStopRemote={stopRemote}
                  onEnd={() => (rtc.localScreen ? rtc.stopScreenShare() : rtc.stopWatchingScreen())}
                  diagnosticsCompact={diagnosticsCompact}
                  onToggleDiagnosticsCompact={() => setDiagnosticsCompact((value) => !value)}
                />
              </div>
            </>
          )}
        </section>
        <div
          ref={chatSlotRef}
          id="shared-chat-panel"
          className="chat-slot"
          aria-hidden={!chatVisible}
          {...(!chatVisible ? { inert: '' } : {})}
        >
          {/* 面板必须保持挂载：窄窗口的共享态靠 translateX 把抽屉移出视野，卸载后
              滑出动画只会带走一块空背景。未共享时它一直是可见的。 */}
          <ChatPanelV2
            key={roomId}
            messages={messages}
            profile={profile}
            serverURL={serverURL}
            roomBottom={roomBottom}
            roomForeground={foreground === 'light' ? '#fff' : '#15191f'}
            currentUserId={roomMembers.find((member) => member.socketId === socket.id)?.userId}
            profileRemarks={profileRemarks}
            getMemberAvatar={(userId, username) =>
              roomMembers.find((member) =>
                userId ? member.userId === userId : member.username === username,
              )?.avatarUrl
            }
            input={input}
            setInput={setInput}
            onSend={sendMessage}
            onSendImages={sendImages}
            imageError={imageError}
            onDismissImageError={() => setImageError(null)}
            onImageError={setImageError}
            compact={shareLayout}
            unread={unread}
            fontSize={chatFontSize}
            onFontSizeChange={updateChatFontSize}
            hasOlderMessages={hasOlderMessages}
            loadingOlderMessages={loadingOlderMessages}
            historyLoadVersion={historyLoadVersion}
            onLoadOlderMessages={loadOlderMessages}
          />
        </div>
        {shareLayout && (
          <div className="chat-edge-toggle-anchor">
            <svg className="chat-edge-seam" aria-hidden="true" focusable="false">
              <defs>
                <linearGradient
                  id="shared-chat-seam-gradient"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="100%"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0%" stopColor="var(--room-top)" />
                  <stop offset="100%" stopColor="var(--room-bottom)" />
                </linearGradient>
                <clipPath id="shared-chat-seam-clip" clipPathUnits="userSpaceOnUse">
                  <path d="M43.5 32 C43.5 52 5 64 5 84 C5 104 43.5 116 43.5 136 L43.5 32 Z" />
                </clipPath>
              </defs>
              <rect className="chat-edge-seam-fill" x="0" y="0" width="44" height="100%" />
              <path
                className="chat-edge-seam-line"
                d="M43.5 0 V32 C43.5 52 5 64 5 84 C5 104 43.5 116 43.5 136"
              />
              <line className="chat-edge-seam-line" x1="43.5" y1="136" x2="43.5" y2="100%" />
            </svg>
            <button
              ref={chatToggleRef}
              type="button"
              className={`chat-edge-toggle ${chatOpen ? 'active' : ''}`}
              onClick={() => {
                setChatOpen((value) => !value);
                setUnread(0);
              }}
              aria-expanded={chatOpen}
              aria-controls="shared-chat-panel"
              aria-label={`${chatOpen ? '收起聊天' : '展开聊天'}${
                unread > 0 ? `，${unread}条未读消息` : ''
              }`}
              title={chatOpen ? '收起聊天' : '展开聊天'}
            >
              {chatOpen ? (
                <CaretRight size={20} weight="bold" />
              ) : (
                <CaretLeft size={20} weight="bold" />
              )}
              {unread > 0 && <i aria-live="polite">{unread}</i>}
            </button>
          </div>
        )}
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
            setGlobalSettingsPage('audio');
            setGlobalSettings(true);
          }}
          onOpenSoundboard={openSoundboard}
          soundboardButtonRef={soundboardButtonRef}
          soundboardAnchorRef={soundboardAnchorRef}
          onSoundboardHoverStart={openSoundboardQuick}
          onSoundboardHoverEnd={closeSoundboardQuick}
        />
        {showAudioModal && (
          <AudioShareMenuV2
            sources={audioSources}
            loading={audioLoading}
            error={audioSourceError}
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
          serverURL={serverURL}
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
        profileRemarks={profileRemarks}
        outputDeviceId={rtc.selectedAudioOutputId}
        inVoice={rtc.inVoice}
        disabled={!sessionReady || !roomSynced}
        hideTrigger
        open={showSoundboard}
        onClose={() => setShowSoundboard(false)}
        compact
        anchorRef={soundboardAnchorRef}
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
          confirmLabel={editingScreen ? '更新共享' : '开始共享'}
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
            setRemoteNotice('');
            setEditingScreen(false);
            setShowScreenModal(false);
            const update = shouldUpdate ? rtc.updateScreenShare : rtc.startScreenShare;
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
      {/* 远程控制的结束/取消播报是可确认的弹窗：作为状态条里的常驻文字时，
          它既容易被忽略，又会在下一次操作前一直留在屏幕上。 */}
      {remoteNotice && (
        <div
          className="modal-scrim"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRemoteNotice('');
          }}
        >
          <section
            className="remote-notice-dialog popover-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="remote-notice-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <MousePointer2 size={25} />
            <h2 id="remote-notice-title">远程控制</h2>
            <p>{remoteNotice}</p>
            <button className="primary-wide" onClick={() => setRemoteNotice('')}>
              知道了
            </button>
          </section>
        </div>
      )}
      {/* 房主右键成员唤出的操作菜单；成员栏与共享态成员条共用同一份。 */}
      {memberMenu && (
        <>
          <div
            className="menu-click-away"
            onMouseDown={() => setMemberMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMemberMenu(null);
            }}
          />
          <div
            className="member-context popover-card"
            role="menu"
            aria-label={`${memberMenu.username} 的操作`}
            style={{ left: memberMenu.x, top: memberMenu.y }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => applyMemberMute(!memberMenu.muted)}
            >
              {memberMenu.muted ? <Microphone size={16} /> : <MicrophoneSlash size={16} />}
              {memberMenu.muted ? '取消语音禁言' : '语音禁言'}
            </button>
            <button type="button" role="menuitem" className="danger-row" onClick={kickMember}>
              <DoorOpen size={16} />
              移出房间
            </button>
          </div>
        </>
      )}
      {pendingRemote && (
        <div
          className="modal-scrim remote-request-scrim"
          onMouseDown={(event) => {
            // 点击外部等同拒绝：绝不会因为误触而授权控制。
            if (event.target === event.currentTarget) respondRemote(false);
          }}
        >
          <section
            className="remote-request popover-card"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <MousePointer2 size={25} />
            <h2>远程控制请求</h2>
            <p aria-live="polite">
              {`${getProfileDisplayName(
                pendingRemote.controllerName,
                pendingRemote.controllerUserId,
                profileRemarks,
              )} 请求控制你正在共享的屏幕。`}
            </p>
            <div>
              <button onClick={() => respondRemote(false)}>拒绝</button>
              <button className="primary-wide" onClick={() => respondRemote(true)}>
                允许本次控制
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
