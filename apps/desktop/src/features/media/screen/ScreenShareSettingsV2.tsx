import { X } from '@phosphor-icons/react';
import { SCREEN_PRESETS, type Fps, type ScreenPreset } from '../useWebRTC';
import { SCREEN_FPS_OPTIONS } from './screenCapture';

export function ScreenShareSettingsV2({
  preset,
  fps,
  audio,
  gameMode,
  nativeResolution,
  gpuEncoding,
  gpuEncodingUnavailableReason,
  smoothPlayback,
  remoteControlActive = false,
  onPreset,
  onFps,
  onAudio,
  onGameMode,
  onNativeResolution,
  onGpuEncoding,
  onSmoothPlayback,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  preset: ScreenPreset;
  fps: Fps;
  audio: boolean;
  gameMode: boolean;
  nativeResolution: boolean;
  gpuEncoding: boolean;
  gpuEncodingUnavailableReason?: string;
  smoothPlayback: boolean;
  remoteControlActive?: boolean;
  onPreset: (preset: ScreenPreset) => void;
  onFps: (fps: Fps) => void;
  onAudio: () => void;
  onGameMode: () => void;
  onNativeResolution: (enabled: boolean) => void;
  onGpuEncoding: (enabled: boolean) => void;
  onSmoothPlayback: (enabled: boolean) => void;
  confirmLabel: string;
  busy?: boolean;
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
        <div className="screen-settings-options">
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
                  disabled={nativeResolution || busy}
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
              disabled={busy}
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
                  disabled={busy}
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
            <input type="checkbox" disabled={busy} checked={gameMode} onChange={onGameMode} />
          </label>
          <label className="settings-toggle-card computer-audio-toggle">
            <span>
              <b>共享电脑音频</b>
              <small>排除 Cove 自身声音，作为屏幕共享附带音频</small>
            </span>
            <input type="checkbox" disabled={busy} checked={audio} onChange={onAudio} />
          </label>
          <label className="settings-toggle-card">
            <span>
              <b id="screen-gpu-encoding-label">采用GPU编码</b>
              <small id="screen-gpu-encoding-description">
                {gpuEncodingUnavailableReason ?? '用显卡编码整屏画面，降低 CPU 占用'}
              </small>
            </span>
            <input
              type="checkbox"
              aria-labelledby="screen-gpu-encoding-label"
              aria-describedby="screen-gpu-encoding-description"
              disabled={busy || Boolean(gpuEncodingUnavailableReason)}
              checked={gpuEncoding}
              onChange={(event) => onGpuEncoding(event.target.checked)}
            />
          </label>
          <label className="settings-toggle-card">
            <span>
              <b id="screen-smooth-playback-label">平滑观看</b>
              <small id="screen-smooth-playback-description">
                {remoteControlActive ? '远程控制中，已切换为低延迟播放' : '增加少量播放缓冲，减轻短时卡顿'}
              </small>
            </span>
            <input
              type="checkbox"
              aria-labelledby="screen-smooth-playback-label"
              aria-describedby="screen-smooth-playback-description"
              disabled={busy || remoteControlActive}
              checked={smoothPlayback && !remoteControlActive}
              onChange={(event) => onSmoothPlayback(event.target.checked)}
            />
          </label>
        </div>
        <button className="primary-wide yellow" disabled={busy} aria-busy={busy} onClick={onConfirm}>
          {busy ? '正在开始共享…' : confirmLabel}
        </button>
      </div>
    </div>
  );
}
