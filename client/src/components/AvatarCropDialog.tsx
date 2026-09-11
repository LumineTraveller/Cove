import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Check, Minus, Plus, X } from "@phosphor-icons/react";
import { prepareAvatar, type AvatarCrop } from "../profile";

interface Props {
  file: File;
  onCancel: () => void;
  onConfirm: (avatarUrl: string) => void | Promise<void>;
}

const MAX_ZOOM = 3;

export function AvatarCropDialog({ file, onCancel, onConfirm }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ pointerX: 0, pointerY: 0 });
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);
  const [stageSize, setStageSize] = useState(280);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const isGif = file.type.toLowerCase() === "image/gif" || /\.gif$/i.test(file.name);

  useEffect(() => {
    let active = true;
    const reader = new FileReader();
    const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    const inferredType = extension === "gif"
      ? "image/gif"
      : extension === "jpg" || extension === "jpeg"
        ? "image/jpeg"
        : extension === "webp"
          ? "image/webp"
          : extension === "png"
            ? "image/png"
            : "application/octet-stream";
    const previewBlob = file.type ? file : new Blob([file], { type: inferredType });
    reader.onload = () => {
      if (active && typeof reader.result === "string") setPreviewSrc(reader.result);
    };
    reader.onerror = () => {
      if (active) setError("无法读取图片，请重新选择");
    };
    reader.readAsDataURL(previewBlob);
    return () => {
      active = false;
      reader.abort();
    };
  }, [file]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setStageSize(entry.contentRect.width);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const baseScale = sourceSize
    ? Math.max(stageSize / sourceSize.width, stageSize / sourceSize.height)
    : 1;
  const imageWidth = sourceSize ? sourceSize.width * baseScale * zoom : stageSize;
  const imageHeight = sourceSize ? sourceSize.height * baseScale * zoom : stageSize;
  const clampOffsetForZoom = (next: { x: number; y: number }, nextZoom: number) => {
    const nextWidth = sourceSize ? sourceSize.width * baseScale * nextZoom : stageSize;
    const nextHeight = sourceSize ? sourceSize.height * baseScale * nextZoom : stageSize;
    const maxOffsetX = Math.max(0, (nextWidth - stageSize) / 2);
    const maxOffsetY = Math.max(0, (nextHeight - stageSize) / 2);
    return {
      x: Math.max(-maxOffsetX, Math.min(maxOffsetX, next.x)),
      y: Math.max(-maxOffsetY, Math.min(maxOffsetY, next.y)),
    };
  };
  const clampOffset = (next: { x: number; y: number }) => clampOffsetForZoom(next, zoom);

  const setZoomAndClamp = (nextZoom: number) => {
    const normalizedZoom = Math.max(1, Math.min(MAX_ZOOM, nextZoom));
    setZoom(normalizedZoom);
    setOffset((current) => clampOffsetForZoom(current, normalizedZoom));
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const crop: AvatarCrop = {
        offsetX: offset.x,
        offsetY: offset.y,
        zoom,
        previewSize: stageSize,
      };
      await onConfirm(await prepareAvatar(file, crop));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "头像处理失败");
      setBusy(false);
    }
  };

  return (
    <div className="avatar-crop-scrim" role="dialog" aria-modal="true" aria-labelledby="avatar-crop-title" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <section className="avatar-crop-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header className="avatar-crop-header">
          <div>
            <small>头像预览</small>
            <h2 id="avatar-crop-title">调整头像取景</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onCancel} disabled={busy} aria-label="取消头像裁剪"><X size={19} /></button>
        </header>
        <div className="avatar-crop-body">
          <div
            ref={stageRef}
            className={`avatar-crop-stage ${dragging ? "dragging" : ""}`}
            onPointerDown={(event) => {
              if (!sourceSize || busy) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              dragRef.current = { pointerX: event.clientX, pointerY: event.clientY };
              setDragging(true);
            }}
            onPointerMove={(event) => {
              if (!dragging) return;
              const dx = event.clientX - dragRef.current.pointerX;
              const dy = event.clientY - dragRef.current.pointerY;
              dragRef.current = { pointerX: event.clientX, pointerY: event.clientY };
              setOffset((current) => clampOffset({ x: current.x + dx, y: current.y + dy }));
            }}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
          >
            <img
              src={previewSrc ?? undefined}
              alt="头像取景预览"
              draggable={false}
              onLoad={(event) => setSourceSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              onError={() => setError("无法读取图片，请重新选择")}
              style={{ width: imageWidth, height: imageHeight, transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)` }}
            />
            {!previewSrc && !error && <span className="avatar-crop-loading">正在读取图片…</span>}
            <span className="avatar-crop-guide" aria-hidden="true" />
          </div>
          <p className="avatar-crop-hint">拖动图片调整取景位置{isGif ? " · GIF 将保留动画" : ""}</p>
          <div className="avatar-crop-controls">
            <button type="button" className="icon-btn" onClick={() => setZoomAndClamp(zoom - 0.25)} disabled={busy || zoom <= 1} aria-label="缩小"><Minus size={17} /></button>
            <input type="range" min="1" max={MAX_ZOOM} step="0.05" value={zoom} onChange={(event) => setZoomAndClamp(Number(event.target.value))} disabled={busy} aria-label="头像缩放" />
            <button type="button" className="icon-btn" onClick={() => setZoomAndClamp(zoom + 0.25)} disabled={busy || zoom >= MAX_ZOOM} aria-label="放大"><Plus size={17} /></button>
            <button type="button" className="avatar-crop-reset" onClick={() => { setOffset({ x: 0, y: 0 }); setZoom(1); }} disabled={busy}><ArrowClockwise size={15} />重置</button>
          </div>
          {error && <p className="avatar-crop-error" role="alert">{error}</p>}
        </div>
        <footer className="avatar-crop-actions">
          <button type="button" className="plain-action" onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className="primary-wide" onClick={() => void confirm()} disabled={busy || !sourceSize}><Check size={17} />{busy ? "处理中" : "使用此头像"}</button>
        </footer>
      </section>
    </div>
  );
}
