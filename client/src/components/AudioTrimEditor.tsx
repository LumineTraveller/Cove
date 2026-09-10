import { useEffect, useRef, useState } from "react";
import { Check, Pause, Play, RotateCcw, X } from "lucide-react";

interface Props {
  fileName: string;
  buffer: AudioBuffer;
  queueLabel?: string;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: (start: number, end: number) => void;
  onPreview: (start: number, end: number) => void;
}

function formatTime(value: number) {
  const seconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function AudioTrimEditor({
  fileName,
  buffer,
  queueLabel,
  busy = false,
  error,
  onCancel,
  onConfirm,
  onPreview,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const duration = Math.max(0.001, buffer.duration);
  const [startRatio, setStartRatio] = useState(0);
  const [endRatio, setEndRatio] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [viewCenter, setViewCenter] = useState(0.5);
  const [hoveredBoundary, setHoveredBoundary] = useState<"start" | "end" | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    setStartRatio(0);
    setEndRatio(1);
    setZoom(1);
    setViewCenter(0.5);
    setHoveredBoundary(null);
    setPreviewing(false);
  }, [buffer]);

  const viewSpan = 1 / zoom;
  const viewStart = Math.max(0, Math.min(1 - viewSpan, viewCenter - viewSpan / 2));
  const viewEnd = viewStart + viewSpan;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(rect.width * ratio));
      const height = Math.max(1, Math.floor(rect.height * ratio));
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, width, height);
      context.fillStyle = "rgba(112, 140, 180, 0.46)";
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
        buffer.getChannelData(index),
      );
      const visibleStart = Math.floor(viewStart * buffer.length);
      const visibleEnd = Math.max(visibleStart + 1, Math.ceil(viewEnd * buffer.length));
      const visibleLength = Math.max(1, visibleEnd - visibleStart);
      const middle = height / 2;
      const half = Math.max(1, height * 0.42);
      for (let x = 0; x < width; x += 1) {
        const from = visibleStart + Math.floor((x / width) * visibleLength);
        const to = Math.max(from + 1, visibleStart + Math.floor(((x + 1) / width) * visibleLength));
        let peak = 0;
        for (const channel of channels) {
          for (let sample = from; sample < Math.min(to, channel.length); sample += 1)
            peak = Math.max(peak, Math.abs(channel[sample]));
        }
        const bar = Math.max(1, peak * half);
        context.fillRect(x, middle - bar, 1, bar * 2);
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [buffer, viewStart, viewEnd]);

  const start = startRatio * duration;
  const end = endRatio * duration;
  const localStartRatio = Math.max(0, Math.min(1, (startRatio - viewStart) / viewSpan));
  const localEndRatio = Math.max(0, Math.min(1, (endRatio - viewStart) / viewSpan));
  const selectionWidth = Math.max(0, localEndRatio - localStartRatio) * 100;

  const updateStart = (value: number) => {
    setStartRatio(Math.min(viewStart + value * viewSpan, endRatio - 0.001));
    setPreviewing(false);
  };
  const updateEnd = (value: number) => {
    setEndRatio(Math.max(viewStart + value * viewSpan, startRatio + 0.001));
    setPreviewing(false);
  };
  const preview = () => {
    setPreviewing(true);
    onPreview(start, end);
  };

  const setZoomLevel = (nextZoom: number) => {
    const next = Math.max(1, Math.min(15, nextZoom));
    const nextSpan = 1 / next;
    const selectionCenter = (startRatio + endRatio) / 2;
    setZoom(next);
    setViewCenter(Math.max(nextSpan / 2, Math.min(1 - nextSpan / 2, next > 1 ? selectionCenter : 0.5)));
    setHoveredBoundary(null);
  };

  const boundaryAtPoint = (event: React.PointerEvent | React.WheelEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const local = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const tolerance = Math.max(0.018, 12 / rect.width);
    const startDistance = Math.abs(local - localStartRatio);
    const endDistance = Math.abs(local - localEndRatio);
    if (startDistance > tolerance && endDistance > tolerance) return null;
    return startDistance <= endDistance ? "start" : "end";
  };

  const adjustBoundaryWithWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const boundary = boundaryAtPoint(event);
    if (!boundary) return;
    event.preventDefault();
    const step = 0.005;
    const delta = event.deltaY < 0 ? -step : step;
    if (boundary === "start") setStartRatio((value) => Math.max(0, Math.min(endRatio - 0.001, value + delta / duration)));
    else setEndRatio((value) => Math.min(1, Math.max(startRatio + 0.001, value + delta / duration)));
    setPreviewing(false);
  };

  return (
    <div className="audio-trim-layer" role="dialog" aria-modal="true" aria-labelledby="audio-trim-title">
      <section className="audio-trim-dialog">
        <header className="audio-trim-header">
          <div className="audio-trim-heading">
            <small>添加语音包{queueLabel ? ` · ${queueLabel}` : ""}</small>
            <h2 id="audio-trim-title">剪辑音频片段</h2>
            <p title={fileName}>{fileName}</p>
          </div>
          <button type="button" className="audio-trim-close" onClick={onCancel} disabled={busy} aria-label="取消添加">
            <X size={19} />
          </button>
        </header>

        <div className="audio-trim-body">
          <div className="audio-trim-waveform-wrap">
            <div className="audio-trim-waveform-toolbar">
              <span>波形查看</span>
              <output>×{zoom.toFixed(zoom >= 2 ? 0 : 1)}</output>
              <button type="button" onClick={() => setZoomLevel(zoom - 1)} disabled={busy || zoom <= 1} aria-label="缩小波形">−</button>
              <button type="button" onClick={() => setZoomLevel(zoom + 1)} disabled={busy || zoom >= 15} aria-label="放大波形">＋</button>
              <button type="button" className="audio-trim-overview" onClick={() => setZoomLevel(1)} disabled={busy || zoom <= 1}>全览</button>
            </div>
            <div
              className={`audio-trim-waveform ${hoveredBoundary ? `boundary-${hoveredBoundary}-hover` : ""}`}
              aria-label="音频波形选择区域"
              onPointerMove={(event) => setHoveredBoundary(boundaryAtPoint(event))}
              onPointerLeave={() => setHoveredBoundary(null)}
              onWheel={adjustBoundaryWithWheel}
            >
            <canvas ref={canvasRef} aria-hidden="true" />
            <span
              className="audio-trim-selection"
              style={{ left: `${localStartRatio * 100}%`, width: `${selectionWidth}%` }}
              aria-hidden="true"
            />
            <input
              className="audio-trim-range audio-trim-range-start"
              type="range"
              min="0"
              max="1"
              step="0.001"
              value={localStartRatio}
              onChange={(event) => updateStart(Number(event.target.value))}
              disabled={busy}
              aria-label="片段开始位置"
            />
            <input
              className="audio-trim-range audio-trim-range-end"
              type="range"
              min="0"
              max="1"
              step="0.001"
              value={localEndRatio}
              onChange={(event) => updateEnd(Number(event.target.value))}
              disabled={busy}
              aria-label="片段结束位置"
            />
            </div>
            <label className="audio-trim-pan">
              <span>查看位置</span>
              <input
                type="range"
                min={viewSpan / 2}
                max={1 - viewSpan / 2}
                step="0.001"
                value={viewCenter}
                onChange={(event) => setViewCenter(Number(event.target.value))}
                disabled={busy || zoom <= 1}
                aria-label="波形查看位置"
              />
            </label>
          </div>
          <div className="audio-trim-times">
            <span>开始 {formatTime(start)}</span>
            <span>选中 {formatTime(end - start)}</span>
            <span>结束 {formatTime(end)}</span>
          </div>
          <p className="audio-trim-hint">拖动两侧滑块选择连续片段；悬停在边界上滚轮可按 5ms 微调。</p>
          {error && <p className="audio-trim-error" role="alert">{error}</p>}
        </div>

        <footer className="audio-trim-actions">
          <button type="button" className="audio-trim-secondary" onClick={preview} disabled={busy}>
            {previewing ? <Pause size={16} /> : <Play size={16} />}
            {previewing ? "试听中" : "试听片段"}
          </button>
          <button type="button" className="audio-trim-reset" onClick={() => { setStartRatio(0); setEndRatio(1); setPreviewing(false); }} disabled={busy} title="恢复整段音频">
            <RotateCcw size={15} />
            整段
          </button>
          <button type="button" className="audio-trim-primary" onClick={() => onConfirm(start, end)} disabled={busy || end <= start}>
            <Check size={16} />
            {busy ? "处理中…" : "裁剪并添加"}
          </button>
        </footer>
      </section>
    </div>
  );
}
