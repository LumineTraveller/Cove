import { useEffect, useRef, useState } from 'react';
import { MicrophoneNoiseControl } from '../../media/microphone/components/MicrophoneNoiseControl';
import {
  ArrowClockwise,
  Check,
  DoorOpen,
  DownloadSimple,
  Headphones,
  Info,
  CircleNotch as LoaderCircle,
  Radio,
  Moon,
  Sun,
  Trash,
  UploadSimple,
  UserCircle,
  X,
} from '@phosphor-icons/react';
import { useWebRTC } from '../../media/useWebRTC';
import { AvatarCropDialog } from '../../profiles/components/AvatarCropDialog';
import { UpdateCenter } from '../../updates/components/UpdateCenter';
import packageInfo from '../../../../package.json';
import type { UserProfile } from '../../../types';
import type { AppTheme } from '../theme';
import { pickAboutQuote, type AboutQuote } from '../aboutQuotes';
import { getServerDownloadUrl, SERVER_DOWNLOAD_LINKS_ENABLED } from '../../updates/serverUpdateUrl';
import { VolumeControl } from '../../media/components/VolumeControl';
import { openExternalLink } from '../../chat/ChatPanelV2';

export type GlobalSettingsPage = 'audio' | 'account' | 'update' | 'about';

export function GlobalSettingsV2({
  profile,
  accountId,
  onProfileChange,
  onLogout,
  serverURL,
  inputVolume,
  outputVolume,
  setInputVolume,
  setOutputVolume,
  rtc,
  onClose,
  initialPage = 'audio',
  theme,
  onThemeChange,
}: {
  profile: UserProfile;
  accountId: string;
  onProfileChange: (profile: UserProfile) => void;
  onLogout: () => void;
  serverURL: string;
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
  const [aboutQuote, setAboutQuote] = useState<AboutQuote>(() => pickAboutQuote());
  const [name, setName] = useState(profile.username);
  const [avatar, setAvatar] = useState(profile.avatarUrl);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [draftAudioInputId, setDraftAudioInputId] = useState(rtc.selectedAudioInputId);
  const [draftAudioOutputId, setDraftAudioOutputId] = useState(rtc.selectedAudioOutputId);
  const [audioActionBusy, setAudioActionBusy] = useState(false);
  const serverDownloadUrl = getServerDownloadUrl(serverURL);
  const audioDeviceSelectionChanged =
    draftAudioInputId !== rtc.selectedAudioInputId ||
    draftAudioOutputId !== rtc.selectedAudioOutputId;

  useEffect(() => {
    setName(profile.username);
    setAvatar(profile.avatarUrl);
  }, [profile.username, profile.avatarUrl]);

  useEffect(() => {
    setPage(initialPage);
  }, [initialPage]);

  useEffect(() => {
    if (page !== 'about') return;
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
      rtc.audioInputSwitching ||
      rtc.microphoneNoiseSwitching
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
    ['audio', <Headphones size={19} />, '音频设备'],
    ['account', <UserCircle size={19} />, '账号与服务器'],
    ['update', <DownloadSimple size={19} />, '检查更新'],
    ['about', <Info size={19} />, '关于应用'],
  ];
  return (
    <div
      className="modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="settings-modal global-settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <aside>
          <h2>设置</h2>
          {nav.map(([id, icon, label]) => (
            <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}>
              {icon}
              {label}
            </button>
          ))}
          <div className="settings-theme-control">
            <span>
              {theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
              <b>深色模式</b>
            </span>
            <button
              type="button"
              className={`theme-switch ${theme === 'dark' ? 'active' : ''}`}
              role="switch"
              aria-checked={theme === 'dark'}
              aria-label="切换深色模式"
              onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
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
            <button className="icon-btn" onClick={onClose} aria-label="关闭设置">
              <X size={20} />
            </button>
          </header>
          {page === 'audio' && (
            <div className="settings-page">
              <label className="field">
                <span>默认输入设备</span>
                <select
                  value={draftAudioInputId}
                  disabled={
                    audioActionBusy ||
                    rtc.audioDevicesRefreshing ||
                    rtc.audioInputSwitching ||
                    rtc.microphoneNoiseSwitching
                  }
                  onChange={(event) => setDraftAudioInputId(event.target.value)}
                >
                  <option value="default">系统默认麦克风</option>
                  {draftAudioInputId !== 'default' &&
                    !rtc.audioInputDevices.some(
                      (device) => device.deviceId === draftAudioInputId,
                    ) && <option value={draftAudioInputId}>此前选择的麦克风（当前不可用）</option>}
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
              <MicrophoneNoiseControl
                mode={rtc.microphoneNoiseMode}
                busy={rtc.microphoneNoiseSwitching}
                disabled={audioActionBusy || rtc.audioInputSwitching || rtc.isJoining}
                error={rtc.microphoneNoiseError}
                onChange={(mode) => void rtc.selectMicrophoneNoiseMode(mode)}
              />
              <label className="field">
                <span>默认输出设备</span>
                <select
                  value={draftAudioOutputId}
                  disabled={audioActionBusy || rtc.audioDevicesRefreshing}
                  onChange={(event) => setDraftAudioOutputId(event.target.value)}
                >
                  <option value="default">系统默认扬声器</option>
                  {draftAudioOutputId !== 'default' &&
                    !rtc.audioOutputDevices.some(
                      (device) => device.deviceId === draftAudioOutputId,
                    ) && <option value={draftAudioOutputId}>此前选择的扬声器（当前不可用）</option>}
                  {rtc.audioOutputDevices.map((device) => (
                    <option value={device.deviceId} key={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>
              <VolumeControl value={outputVolume} onChange={setOutputVolume} label="默认输出音量" />
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
                  {rtc.audioDevicesRefreshing ? '检测中' : '检测设备'}
                </button>
                <button
                  className="plain-action"
                  disabled={
                    audioActionBusy ||
                    rtc.audioDevicesRefreshing ||
                    rtc.audioInputSwitching ||
                    rtc.microphoneNoiseSwitching
                  }
                  onClick={() => void handleAudioDeviceAction()}
                >
                  {audioActionBusy || rtc.audioInputSwitching ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <ArrowClockwise size={17} />
                  )}
                  {audioActionBusy || rtc.audioInputSwitching
                    ? '处理中'
                    : audioDeviceSelectionChanged
                    ? '更改'
                    : '刷新'}
                </button>
              </div>
              <p className="audio-device-action-hint">
                {audioDeviceSelectionChanged
                  ? '设备选择已暂存，点击“更改”后应用。'
                  : rtc.inVoice
                  ? '刷新会重新建立当前音频连接，不会结束屏幕共享。'
                  : '未加入语音时，刷新会重新检测当前设备状态。'}
              </p>
              {rtc.audioDeviceError && <p className="field-error">{rtc.audioDeviceError}</p>}
            </div>
          )}
          {page === 'account' && (
            <div className="settings-page">
              <section className="profile-editor">
                <span className="profile-avatar-preview">
                  {avatar ? <img src={avatar} alt="个人头像" /> : name[0] ?? '你'}
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
                      <button className="subtle-danger" onClick={() => setAvatar(null)}>
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
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) setCropFile(file);
                      event.currentTarget.value = '';
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
                <input value={accountId ? `#${accountId.replace(/^#/, '')}` : '#未知'} readOnly />
              </label>
              <label className="field">
                <span>服务器地址</span>
                <input value={window.localStorage.getItem('cove_server_url') ?? ''} readOnly />
              </label>
              <div className="account-danger-zone">
                <button className="logout-wide" onClick={onLogout}>
                  <DoorOpen size={17} />
                  退出登录
                </button>
              </div>
            </div>
          )}
          {page === 'update' && (
            <div className="settings-page update-settings-page">
              <UpdateCenter embedded serverURL={serverURL} />
            </div>
          )}
          {page === 'about' && (
            <div className="empty-settings about-settings">
              <div className="about-settings-main">
                <img className="about-app-icon" src="./assets/cove-icon.png" alt="Cove" />
                <h3>Cove</h3>
                <p>连接朋友的语音与屏幕。</p>
                <small>桌面客户端 · v{packageInfo.version}</small>
                <nav className="about-links" aria-label="Cove 页面链接">
                  <a
                    href="https://github.com/LumineTraveller/Cove"
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={(event) =>
                      openExternalLink(event, 'https://github.com/LumineTraveller/Cove')
                    }
                  >
                    GitHub
                  </a>
                  {SERVER_DOWNLOAD_LINKS_ENABLED && (
                    <a
                      href={serverDownloadUrl ?? '#'}
                      target="_blank"
                      rel="noreferrer noopener"
                      onClick={(event) => {
                        if (!serverDownloadUrl) {
                          event.preventDefault();
                          return;
                        }
                        openExternalLink(event, serverDownloadUrl);
                      }}
                    >
                      服务器下载
                    </a>
                  )}
                </nav>
              </div>
              <button
                type="button"
                className="about-quote"
                onClick={() => setAboutQuote((previous) => pickAboutQuote(previous))}
                title="点击换一句"
              >
                “{aboutQuote.text}”
              </button>
            </div>
          )}
        </main>
      </section>
      {cropFile && (
        <AvatarCropDialog
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onConfirm={(avatarUrl) => {
            setAvatar(avatarUrl);
            setCropFile(null);
          }}
        />
      )}
    </div>
  );
}
