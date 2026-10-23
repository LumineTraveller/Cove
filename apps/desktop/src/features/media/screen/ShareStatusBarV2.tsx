import {
  MonitorPlay,
  PhoneDisconnect,
  SquaresFour,
  PictureInPicture,
} from '@phosphor-icons/react';
import { VolumeControl } from '../components/VolumeControl';
import { ShareOperationsMenu } from '../annotation/ShareOperationsMenu';
import type { useScreenAnnotations } from '../annotation/useScreenAnnotations';

export function ShareStatusBarV2({
  self,
  sharer,
  volume,
  onVolume,
  muted,
  onMute,
  onRemote,
  remoteState,
  remoteCooldownSeconds,
  onStopRemote,
  onFull,
  onEnd,
  fullscreenMode,
  onAppFull,
  hasAudio,
  annotations,
  pictureInPicture,
}: {
  self: boolean;
  sharer: string;
  volume: number;
  onVolume: (value: number) => void;
  muted: boolean;
  onMute: () => void;
  onRemote: () => void;
  remoteState: 'available' | 'pending' | 'active' | 'unsupported';
  remoteCooldownSeconds: number;
  onStopRemote: () => void;
  onFull: () => void;
  onEnd: () => void;
  fullscreenMode: string | null;
  onAppFull: () => void;
  hasAudio: boolean;
  annotations: ReturnType<typeof useScreenAnnotations>;
  pictureInPicture?: {
    active: boolean;
    pending: boolean;
    disabled: boolean;
    disabledReason?: string;
    open(): Promise<void>;
    close(): Promise<void>;
  };
}) {
  const appFullscreen = fullscreenMode === 'app';
  const floating = pictureInPicture?.active || pictureInPicture?.pending;
  return (
    <div className="share-status-bar">
      <div className="share-status-left">
        <b>{self ? '你的共享' : `${sharer}的共享`}</b>
        {hasAudio && (
          <VolumeControl
            value={volume}
            onChange={onVolume}
            label={self ? '共享发送音量' : '共享观看音量'}
            muted={muted}
            onMute={onMute}
          />
        )}
      </div>
      <div className="share-status-actions">
        {!floating && <ShareOperationsMenu self={self} annotations={annotations} remoteState={remoteState}
          cooldownSeconds={remoteCooldownSeconds} onRemote={onRemote} onStopRemote={onStopRemote} />}
        {pictureInPicture && <button className="floating-view-toggle"
          aria-pressed={pictureInPicture.active}
          disabled={pictureInPicture.pending || (!pictureInPicture.active && pictureInPicture.disabled)}
          title={pictureInPicture.active ? '关闭小窗并返回主窗口' : pictureInPicture.disabledReason}
          onClick={() => { void (pictureInPicture.active ? pictureInPicture.close() : pictureInPicture.open()); }}>
          <PictureInPicture size={17} />
          {pictureInPicture.pending ? '正在切换…' : pictureInPicture.active ? '返回主窗口' : '置顶小窗'}
        </button>}
        <div className="fullscreen-stack">
          <button disabled={floating} onClick={appFullscreen ? onAppFull : onFull}>
            <SquaresFour size={17} />
            {appFullscreen ? '退出全屏' : '全屏'}
          </button>
          {!appFullscreen && (
            <button className="application-fullscreen" disabled={floating} onClick={onAppFull}>
              <MonitorPlay size={17} />
              应用全屏
            </button>
          )}
        </div>
        <button className="end-share" onClick={onEnd}>
          <PhoneDisconnect size={17} />
          {self ? '结束共享' : '结束观看'}
        </button>
      </div>
    </div>
  );
}
