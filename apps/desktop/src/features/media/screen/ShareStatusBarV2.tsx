import {
  MonitorPlay,
  PhoneDisconnect,
  SquaresFour,
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
}) {
  const appFullscreen = fullscreenMode === 'app';
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
        <ShareOperationsMenu self={self} annotations={annotations} remoteState={remoteState}
          cooldownSeconds={remoteCooldownSeconds} onRemote={onRemote} onStopRemote={onStopRemote} />
        <div className="fullscreen-stack">
          <button onClick={appFullscreen ? onAppFull : onFull}>
            <SquaresFour size={17} />
            {appFullscreen ? '退出全屏' : '全屏'}
          </button>
          {!appFullscreen && (
            <button className="application-fullscreen" onClick={onAppFull}>
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
