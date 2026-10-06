import { X } from '@phosphor-icons/react';
import { SCREEN_PRESETS, type Fps, type ScreenPreset } from '../useWebRTC';

export function ScreenShareSettingsV2({
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
          {gameMode ? '游戏模式以 60 FPS 和稳定动态画面为目标。' : '根据画面变化自动调整帧率。'}{' '}
          视频码率上限为 200 Mbps，实际速率由网络与设备能力决定。
        </p>
        <section className={`media-choice-section ${nativeResolution ? 'disabled' : ''}`}>
          <span>分辨率</span>
          <div className="choice-grid resolution-grid">
            {(Object.keys(SCREEN_PRESETS) as ScreenPreset[]).map((value) => (
              <button
                key={value}
                disabled={nativeResolution}
                className={preset === value ? 'active' : ''}
                onClick={() => onPreset(value)}
              >
                {value === '1440p' ? '1440p 2K' : SCREEN_PRESETS[value].label}
              </button>
            ))}
          </div>
        </section>
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
        {/* 游戏模式把帧率锁在 60，与原生分辨率锁定分辨率档位是同一种情况，
            整行灰化并禁用两个按钮，保持两行的禁用表现一致。 */}
        <section className={`media-choice-section ${gameMode ? 'disabled' : ''}`}>
          <span>帧率</span>
          <div className="choice-grid">
            <button
              className={fps === 30 ? 'active' : ''}
              disabled={gameMode}
              onClick={() => onFps(30)}
            >
              30 fps
            </button>
            <button
              className={fps === 60 ? 'active' : ''}
              disabled={gameMode}
              onClick={() => onFps(60)}
            >
              60 fps
            </button>
          </div>
        </section>
        <label className="settings-toggle-card">
          <span>
            <b>游戏模式</b>
            <small>以 60 FPS 和稳定动态画面为目标</small>
          </span>
          <input type="checkbox" checked={gameMode} onChange={onGameMode} />
        </label>
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
