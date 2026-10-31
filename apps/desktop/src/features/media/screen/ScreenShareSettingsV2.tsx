import { X } from '@phosphor-icons/react';
import { SCREEN_PRESETS, type Fps, type ScreenPreset } from '../useWebRTC';
import { SCREEN_FPS_OPTIONS } from './screenCapture';

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
          {gameMode ? `游戏模式持续以所选 ${fps} FPS 为目标。` : '画面变化时使用所选帧率，静止后降到 15 FPS。'}{' '}
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
        <section className="media-choice-section">
          <span>帧率</span>
          <div className="choice-grid fps-grid">
            {SCREEN_FPS_OPTIONS.map((value) => (
              <button
                key={value}
                className={fps === value ? 'active' : ''}
                onClick={() => onFps(value)}
              >
                {value} fps
              </button>
            ))}
          </div>
        </section>
        <label className="settings-toggle-card">
          <span>
            <b>游戏模式</b>
            <small>持续使用所选帧率，优先稳定动态画面</small>
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
