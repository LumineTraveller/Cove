import {
  Microphone,
  MicrophoneSlash,
  SpeakerHigh,
  SpeakerSlash,
  Waveform,
} from '@phosphor-icons/react';

export const clamp = (value: number) => Math.max(0, Math.min(200, Number(value)));

export function VolumeControl({
  value,
  onChange,
  label,
  icon = 'speaker',
  muted = false,
  onMute,
  level = 0,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  icon?: 'speaker' | 'mic' | 'share';
  muted?: boolean;
  onMute?: () => void;
  /** 实时音量电平（0~1），显示在可调节轨道上。 */
  level?: number;
}) {
  const shown = muted ? 0 : Math.round(clamp(value));
  const liveLevel = Math.max(0, Math.min(1, Number(level) || 0));
  // 电平条以"当前音量位置"为上限封顶（滑块满量程 200，位置 = shown/200）。
  // 用 min 封顶而不是乘比值：乘法会让低音量时整条电平被等比压扁、看不出波动。
  const meterLevel = muted ? 0 : Math.min(liveLevel * 2, shown / 200);
  const Icon =
    icon === 'mic'
      ? muted
        ? MicrophoneSlash
        : Microphone
      : icon === 'share'
      ? Waveform
      : muted
      ? SpeakerSlash
      : SpeakerHigh;
  return (
    <div className={`volume-control volume-${icon}`}>
      <button
        className="volume-icon"
        onClick={onMute}
        aria-label={muted ? `恢复${label}` : `静音${label}`}
        title={muted ? `恢复${label}` : `静音${label}`}
      >
        <Icon size={17} weight={muted ? 'regular' : 'fill'} />
      </button>
      <label
        style={
          {
            '--volume-position': `${shown / 2}%`,
            '--volume-level': `${meterLevel * 100}%`,
          } as React.CSSProperties
        }
      >
        <span className="sr-only">{label}</span>
        <span className="volume-live-level" aria-hidden="true" />
        <span className="volume-thumb" aria-hidden="true" />
        <input
          type="range"
          min="0"
          max="200"
          step="1"
          value={shown}
          onChange={(event) => onChange(Number(event.target.value))}
          onWheel={(event) => {
            event.preventDefault();
            onChange(clamp(shown + (event.deltaY < 0 ? 1 : -1)));
          }}
          aria-label={label}
        />
        <output>{shown}%</output>
      </label>
    </div>
  );
}

export function VerticalVolume({
  value,
  onChange,
  label,
  colorClass = '',
  level = 0,
  muted = false,
  icon = 'speaker',
  onMute,
  onDraggingChange,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  colorClass?: string;
  level?: number;
  muted?: boolean;
  icon?: 'speaker' | 'mic' | 'share';
  onMute?: () => void;
  onDraggingChange?: (dragging: boolean) => void;
}) {
  const shown = muted ? 0 : Math.round(clamp(value));
  const liveLevel = Math.max(0, Math.min(1, Number(level) || 0));
  // 与横向控件一致：以当前音量位置封顶，用 min 而非乘比值。
  const meterLevel = muted ? 0 : Math.min(liveLevel * 2, shown / 200);
  const Icon =
    icon === 'mic'
      ? muted
        ? MicrophoneSlash
        : Microphone
      : icon === 'share'
      ? Waveform
      : muted
      ? SpeakerSlash
      : SpeakerHigh;
  return (
    <div
      className={`vertical-volume ${colorClass}`}
      style={
        {
          '--volume-position': `${shown / 2}%`,
          '--volume-level': `${meterLevel * 100}%`,
        } as React.CSSProperties
      }
    >
      <output>{shown}%</output>
      <span className="vertical-volume-track">
        <span className="vertical-live-level" aria-hidden="true" />
        <span className="vertical-volume-thumb" aria-hidden="true" />
        <input
          type="range"
          min="0"
          max="200"
          step="1"
          value={shown}
          onChange={(event) => onChange(Number(event.target.value))}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            // Keep receiving range updates even when the pointer leaves this
            // narrow track during a drag.
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // Native range dragging remains available if capture is unsupported.
            }
            onDraggingChange?.(true);
          }}
          onPointerUp={() => onDraggingChange?.(false)}
          onPointerCancel={() => onDraggingChange?.(false)}
          onLostPointerCapture={() => onDraggingChange?.(false)}
          onWheel={(event) => {
            event.preventDefault();
            onChange(clamp(shown + (event.deltaY < 0 ? 1 : -1)));
          }}
          aria-label={label}
        />
      </span>
      {onMute ? (
        <button
          type="button"
          className={`vertical-mute ${muted ? 'muted' : ''}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onMute();
          }}
          aria-label={muted ? `恢复${label}` : `静音${label}`}
          title={muted ? `恢复${label}` : `静音${label}`}
        >
          <Icon size={14} weight={muted ? 'regular' : 'fill'} />
        </button>
      ) : (
        <span className="vertical-volume-label">{label}</span>
      )}
    </div>
  );
}
