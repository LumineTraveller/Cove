import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { PaintBrush, Circle, Eraser, Trash, SlidersHorizontal, X, Check } from '@phosphor-icons/react';
import type { AnnotationPoint, AnnotationStroke } from '@cove/contracts';
import type { useScreenAnnotations } from './useScreenAnnotations';
import { getContainedVideoRect, mapClientPointToAnnotationPoint } from './annotationGeometry';
import { renderAnnotationStrokes } from './annotationModel';
import { annotationStrokeWidth, eraserCursor } from './annotationCursor';
import './annotationUI.css';

type Tool = 'pen' | 'laser' | 'eraser';
type Position = { x: number; y: number };
type Bounds = { left: number; top: number; width: number; height: number };
const icons = { pen: PaintBrush, laser: Circle, eraser: Eraser };
const colors = ['#ef4444', '#3b82f6', '#facc15', '#22c55e', '#a855f7', '#ffffff'];
const TOOL_WIDTH = 52, BALL_SIZE = 44;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(Math.max(low, high), value));
const positionIn = (position: Position, width: number, height: number, bounds: Bounds): Position => ({
  x: clamp(position.x, 0, bounds.width - width), y: clamp(position.y, 0, bounds.height - height),
});

/** Tools use the whole host; drawing coordinates use only the contained video. */
export function ScreenAnnotationLayer({ annotations, self, videoHostRef }: {
  annotations: ReturnType<typeof useScreenAnnotations>;
  self: boolean;
  videoHostRef: RefObject<HTMLDivElement>;
}) {
  const [bounds, setBounds] = useState<Bounds>({ left: 0, top: 0, width: 0, height: 0 });
  const [contentBounds, setContentBounds] = useState<Bounds>(bounds);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(colors[0]);
  const [penWidth, setPenWidth] = useState(4);
  const [eraserWidth, setEraserWidth] = useState(24);
  const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState<Position>({ x: 12, y: 12 });
  const [panel, setPanel] = useState<'pen' | 'eraser' | 'manage' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapseAction = useRef<() => void>(() => {});
  const pointerInTools = useRef(false);
  const adjustingTools = useRef(false);
  const keyboardInTools = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ballRef = useRef<HTMLButtonElement>(null);
  const activeButtonRefs = useRef<Partial<Record<Tool, HTMLButtonElement | null>>>({});
  const drawing = useRef<{ id: string; tool: 'pen' | 'eraser'; color: string; width: number; last: AnnotationPoint } | null>(null);
  const dragging = useRef<{ clientX: number; clientY: number; origin: Position; moved: boolean } | null>(null);
  const minDimension = Math.min(contentBounds.width, contentBounds.height);
  const maxWidth = Math.max(1, Math.min(40, Math.floor(minDimension * 0.08)));
  const toolbarHeight = Math.min(self ? 272 : 228, Math.max(0, bounds.height));
  const currentWidth = tool === 'eraser' ? eraserWidth : penWidth;
  const currentEraserCursor = useMemo(() => eraserCursor(
    annotationStrokeWidth(eraserWidth, minDimension) * minDimension,
  ), [eraserWidth, minDimension]);
  const cancelCollapse = () => {
    if (collapseTimer.current !== null) clearTimeout(collapseTimer.current);
    collapseTimer.current = null;
  };
  const containsTool = (target: EventTarget | null) => target instanceof Node &&
    Boolean(toolbarRef.current?.contains(target) || panelRef.current?.contains(target));
  const scheduleCollapse = () => {
    if (collapsed || !annotations.localActive || !annotations.canDraw ||
        adjustingTools.current || collapseTimer.current !== null) return;
    collapseTimer.current = setTimeout(() => {
      collapseTimer.current = null;
      if (!pointerInTools.current && !adjustingTools.current &&
          !(keyboardInTools.current && containsTool(document.activeElement))) collapseAction.current();
    }, 500);
  };
  const toolInteractions = {
    onPointerEnter: () => { pointerInTools.current = true; cancelCollapse(); },
    onPointerLeave: () => { pointerInTools.current = false; scheduleCollapse(); },
    onPointerDownCapture: () => { keyboardInTools.current = false; adjustingTools.current = true; cancelCollapse(); },
    onPointerUpCapture: (event: React.PointerEvent<HTMLDivElement>) => {
      adjustingTools.current = false;
      pointerInTools.current = containsTool(document.elementFromPoint(event.clientX, event.clientY));
      if (!pointerInTools.current) scheduleCollapse();
    },
    onPointerCancel: () => { adjustingTools.current = false; scheduleCollapse(); },
    onKeyDownCapture: () => { keyboardInTools.current = true; cancelCollapse(); },
    onFocusCapture: (event: React.FocusEvent<HTMLDivElement>) => {
      if (!adjustingTools.current && event.target.matches(':focus-visible')) keyboardInTools.current = true;
      if (keyboardInTools.current) cancelCollapse();
    },
    onBlurCapture: (event: React.FocusEvent<HTMLDivElement>) => {
      if (containsTool(event.relatedTarget)) return;
      keyboardInTools.current = false;
      if (!pointerInTools.current) scheduleCollapse();
    },
  };
  useEffect(() => {
    cancelCollapse(); pointerInTools.current = false; adjustingTools.current = false; keyboardInTools.current = false;
    return cancelCollapse;
  }, [annotations.state?.sessionId, annotations.localActive, annotations.canDraw, collapsed]);
  useEffect(() => {
    if (!annotations.localActive || !annotations.canDraw || collapsed) return;
    // Native range inputs may keep the drag outside the panel and deliver the
    // release elsewhere. Always finish that interaction before restarting the
    // leave timer; otherwise a lost panel pointerup pins the toolbar open.
    const finishAdjustment = (event: PointerEvent) => {
      if (!adjustingTools.current) return;
      adjustingTools.current = false;
      pointerInTools.current = event.type !== 'pointercancel' &&
        containsTool(document.elementFromPoint(event.clientX, event.clientY));
      if (!pointerInTools.current) scheduleCollapse();
    };
    window.addEventListener('pointerup', finishAdjustment, true);
    window.addEventListener('pointercancel', finishAdjustment, true);
    return () => {
      window.removeEventListener('pointerup', finishAdjustment, true);
      window.removeEventListener('pointercancel', finishAdjustment, true);
    };
  }, [annotations.localActive, annotations.canDraw, collapsed]);

  useLayoutEffect(() => {
    // A disabled annotation layer has no geometry or canvas to maintain. In
    // particular, don't force layout + React updates on every window resize.
    if (!annotations.state?.enabled) return;
    const host = videoHostRef.current;
    const video = host?.querySelector('video');
    if (!host || !video) return;
    const measure = () => {
      const hr = host.getBoundingClientRect();
      const rect = getContainedVideoRect(video.getBoundingClientRect(), video.videoWidth, video.videoHeight);
      const next = rect ? { left: rect.left - hr.left, top: rect.top - hr.top, width: rect.width, height: rect.height }
        : { left: 0, top: 0, width: 0, height: 0 };
      setContentBounds(previous => Object.keys(next).every(key => Math.abs(previous[key as keyof Bounds] - next[key as keyof Bounds]) < 0.1) ? previous : next);
      setBounds(previous => Math.abs(previous.width - hr.width) < 0.1 && Math.abs(previous.height - hr.height) < 0.1
        ? previous : { left: 0, top: 0, width: hr.width, height: hr.height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host); observer.observe(video);
    video.addEventListener('loadedmetadata', measure); video.addEventListener('resize', measure);
    document.addEventListener('fullscreenchange', measure);
    measure();
    return () => {
      observer.disconnect(); video.removeEventListener('loadedmetadata', measure); video.removeEventListener('resize', measure);
      document.removeEventListener('fullscreenchange', measure);
    };
  }, [videoHostRef, annotations.state?.sessionId, annotations.state?.enabled]);

  useLayoutEffect(() => {
    setPosition(previous => {
      const next = positionIn(previous, collapsed ? BALL_SIZE : TOOL_WIDTH, collapsed ? BALL_SIZE : toolbarHeight, bounds);
      return next.x === previous.x && next.y === previous.y ? previous : next;
    });
  }, [bounds, collapsed, toolbarHeight]);

  useEffect(() => {
    setCollapsed(false); setPanel(null); setPosition({ x: 12, y: 12 }); drawing.current = null;
  }, [annotations.state?.sessionId]);
  useLayoutEffect(() => {
    if (!annotations.localActive || !annotations.canDraw) {
      drawing.current = null; dragging.current = null; setPanel(null);
    } else setCollapsed(false);
  }, [annotations.localActive, annotations.canDraw]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !contentBounds.width || !contentBounds.height) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(contentBounds.width * ratio); canvas.height = Math.round(contentBounds.height * ratio);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, contentBounds.width, contentBounds.height);
    const strokes: AnnotationStroke[] = [...(annotations.state?.strokes ?? []), ...annotations.optimisticStrokes];
    renderAnnotationStrokes(context, strokes, { left: 0, top: 0, width: contentBounds.width, height: contentBounds.height });
  }, [annotations.state?.strokes, annotations.optimisticStrokes, annotations.state?.enabled, contentBounds]);

  const point = (event: { clientX: number; clientY: number }) => {
    const rect = contentRef.current?.getBoundingClientRect();
    return rect ? mapClientPointToAnnotationPoint(event.clientX, event.clientY, rect) : null;
  };
  const collapseAtTool = () => {
    cancelCollapse();
    if (collapsed) return;
    const icon = activeButtonRefs.current[tool]?.getBoundingClientRect();
    const rect = rootRef.current?.getBoundingClientRect();
    const anchor = icon && rect ? { x: icon.left + icon.width / 2 - rect.left - BALL_SIZE / 2,
      y: icon.top + icon.height / 2 - rect.top - BALL_SIZE / 2 } : position;
    setPosition(positionIn(anchor, BALL_SIZE, BALL_SIZE, bounds)); setPanel(null); setCollapsed(true);
  };
  useLayoutEffect(() => { collapseAction.current = collapseAtTool; });
  const expand = () => {
    cancelCollapse();
    // Keep the selected tool at the ball anchor where space permits, then clamp
    // the entire capsule *before* displaying it near the bottom/right edges.
    const selectedIndex = tool === 'pen' ? 0 : tool === 'laser' ? 1 : 2;
    const next = positionIn({ x: position.x - 4, y: position.y - 4 - selectedIndex * 44 }, TOOL_WIDTH, toolbarHeight, bounds);
    setPosition(next); setCollapsed(false);
    requestAnimationFrame(() => activeButtonRefs.current[tool]?.focus({ preventScroll: true }));
  };
  const openPanel = (next: typeof panel) => {
    const panelWidth = Math.min(232, Math.max(0, bounds.width - TOOL_WIDTH - 8));
    setPosition(previous => positionIn({ ...previous, x: Math.min(previous.x, bounds.width - TOOL_WIDTH - 8 - panelWidth) }, TOOL_WIDTH, toolbarHeight, bounds));
    setPanel(previous => previous === next ? null : next);
  };
  const chooseTool = (next: Tool) => {
    if (next === tool && next !== 'laser') openPanel(next);
    else { setTool(next); setPanel(null); annotations.sendLaser(null); }
  };
  const stopDrawing = () => {
    const stroke = drawing.current;
    if (stroke) annotations.sendStroke(stroke.tool, stroke.color, stroke.width, [], stroke.id, true);
    drawing.current = null;
  };
  const exitTools = () => {
    cancelCollapse();
    annotations.exit();
    if (!document.fullscreenElement) requestAnimationFrame(() =>
      videoHostRef.current?.closest('.share-view')?.querySelector<HTMLButtonElement>('.share-operations-trigger')?.focus({ preventScroll: true }));
  };
  const ToolIcon = icons[tool];
  const popoverWidth = Math.min(232, Math.max(0, bounds.width - TOOL_WIDTH - 8));
  const popoverLeft = Math.min(position.x + TOOL_WIDTH + 8, bounds.width - popoverWidth);
  const popoverTop = clamp(position.y, 0, bounds.height - Math.min(240, bounds.height));
  const visible = contentBounds.width > 0 && contentBounds.height > 0 && annotations.state?.enabled;
  if (!visible) return null;
  return <div ref={rootRef} className={`screen-annotation-layer tool-${tool}`} style={bounds}
    onKeyDown={event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      if (panel) { setPanel(null); activeButtonRefs.current[tool]?.focus(); }
      else { exitTools(); }
    }}>
    <div ref={contentRef} className="annotation-content-layer" style={contentBounds}>
    <canvas ref={canvasRef} className="annotation-canvas" aria-label="共享批注画布" />
    {Object.entries(annotations.laserPoints).map(([author, laser]) => <i key={author} className="annotation-laser-dot"
      style={{ left: `${laser.x * 100}%`, top: `${laser.y * 100}%` }} aria-hidden="true" />)}
    {annotations.localActive && annotations.canDraw && <div className="annotation-input-surface" tabIndex={0}
      style={tool === 'eraser' ? { cursor: currentEraserCursor } : undefined}
      aria-label={`批注${tool === 'pen' ? '画笔' : tool === 'laser' ? '激光笔' : '橡皮'}区域`}
      onPointerEnter={() => { pointerInTools.current = false; scheduleCollapse(); }}
      onContextMenu={event => event.preventDefault()}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary) return;
        const mapped = point(event);
        if (!mapped) { stopDrawing(); annotations.sendLaser(null); return; }
        event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
        keyboardInTools.current = false; pointerInTools.current = false;
        event.currentTarget.setPointerCapture(event.pointerId); scheduleCollapse();
        if (tool === 'laser') { annotations.sendLaser(mapped); return; }
        const width = annotationStrokeWidth(currentWidth, minDimension);
        const stroke = { id: crypto.randomUUID(), tool, color, width, last: mapped };
        drawing.current = stroke;
        if (annotations.sendStroke(tool, color, width, [mapped], stroke.id) === null) drawing.current = null;
      }}
      onPointerMove={event => {
        const mapped = point(event);
        if (!mapped) { stopDrawing(); annotations.sendLaser(null); return; }
        event.stopPropagation();
        // Closing a hovered settings panel removes its DOM node without a
        // reliable pointerleave. Real movement on the canvas is authoritative.
        pointerInTools.current = false; scheduleCollapse();
        if (tool === 'laser') { annotations.sendLaser(mapped); return; }
        const stroke = drawing.current;
        if (!stroke || (stroke.last.x === mapped.x && stroke.last.y === mapped.y)) return;
        if (annotations.sendStroke(stroke.tool, stroke.color, stroke.width, [mapped], stroke.id) === null) drawing.current = null;
        else stroke.last = mapped;
      }}
      onPointerUp={event => {
        const stroke = drawing.current, mapped = point(event);
        if (stroke && mapped && (mapped.x !== stroke.last.x || mapped.y !== stroke.last.y))
          annotations.sendStroke(stroke.tool, stroke.color, stroke.width, [mapped], stroke.id);
        stopDrawing();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { stopDrawing(); annotations.sendLaser(null); }}
      onLostPointerCapture={stopDrawing}
      onPointerLeave={() => { if (tool === 'laser') annotations.sendLaser(null); }} />}
    </div>
    {annotations.localActive && annotations.error && <p className="annotation-layer-status" role="status">{annotations.error}</p>}
    {annotations.localActive && annotations.canDraw && (collapsed ?
      <button ref={ballRef} className="annotation-tool-ball" style={{ left: position.x, top: position.y }}
        aria-label="展开批注工具" title="点击展开批注工具，拖动调整位置"
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.stopPropagation(); dragging.current = { clientX: event.clientX, clientY: event.clientY, origin: position, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={event => {
          const drag = dragging.current; if (!drag) return;
          const dx = event.clientX - drag.clientX, dy = event.clientY - drag.clientY;
          if (Math.hypot(dx, dy) > 4) drag.moved = true;
          if (drag.moved) setPosition(positionIn({ x: drag.origin.x + dx, y: drag.origin.y + dy }, BALL_SIZE, BALL_SIZE, bounds));
        }} onPointerUp={event => {
          const drag = dragging.current; dragging.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          if (drag && !drag.moved) expand();
        }} onPointerCancel={() => { dragging.current = null; }}
        onClick={event => { if (event.detail === 0) expand(); }}>
        <ToolIcon size={21} weight={tool === 'laser' ? 'fill' : 'regular'} />
        {self && Boolean(annotations.state?.requests.length) && <span className="annotation-request-count">{annotations.state!.requests.length}</span>}
      </button> : <div className="annotation-toolbar" ref={toolbarRef} {...toolInteractions}
        style={{ left: position.x, top: position.y, maxHeight: toolbarHeight,
          transformOrigin: `26px ${26 + (tool === 'pen' ? 0 : tool === 'laser' ? 1 : 2) * 44}px` }} role="toolbar" aria-label="批注工具">
        {(['pen', 'laser', 'eraser'] as Tool[]).map(item => {
          const Icon = icons[item], label = item === 'pen' ? '画笔' : item === 'laser' ? '激光笔' : '橡皮';
          return <button key={item} ref={button => { activeButtonRefs.current[item] = button; }}
            className={tool === item ? 'selected' : ''} aria-label={label} title={item === 'laser' ? label : `${label}（再次点击调整）`}
            aria-pressed={tool === item} onClick={() => chooseTool(item)}><Icon size={21} weight={item === 'laser' ? 'fill' : 'regular'} /></button>;
        })}
        <button aria-label="清屏" title="清屏" onClick={() => { void annotations.clear(); }}><Trash size={21} /></button>
        {self && <button aria-label="管理批注权限" title="管理批注权限" aria-expanded={panel === 'manage'} onClick={() => openPanel('manage')}>
          <SlidersHorizontal size={21} />{Boolean(annotations.state?.requests.length) && <span className="annotation-request-count">{annotations.state!.requests.length}</span>}
        </button>}
        <button aria-label="退出批注" title="退出批注（保留共享批注）" onClick={exitTools}><X size={21} /></button>
      </div>)}
    {annotations.localActive && annotations.canDraw && !collapsed && panel && <div className="annotation-tool-panel" ref={panelRef} {...toolInteractions}
      style={{ left: popoverLeft, top: popoverTop, width: popoverWidth, maxHeight: Math.min(240, bounds.height) }}>
      <header>{panel === 'manage' ? '批注权限' : panel === 'pen' ? '画笔设置' : '橡皮设置'}
        <button aria-label="关闭批注选项" onClick={() => setPanel(null)}><X size={15} /></button>
      </header>
      {panel === 'pen' && <div className="annotation-colors">{colors.map(item => <button key={item}
        aria-label={`画笔颜色 ${item}`} aria-pressed={color === item} style={{ background: item }} onClick={() => setColor(item)}>
        {color === item && <Check size={13} color={item === '#ffffff' || item === '#facc15' ? '#15191f' : '#fff'} />}
      </button>)}<input type="color" value={color} aria-label="自定义画笔颜色" onChange={event => setColor(event.target.value)} /></div>}
      {(panel === 'pen' || panel === 'eraser') && <label className="annotation-width-control">
        <span>粗细 <b>{Math.min(panel === 'pen' ? penWidth : eraserWidth, maxWidth)} px</b></span>
        <input type="range" min={1} max={panel === 'pen' ? Math.min(20, maxWidth) : maxWidth}
          value={Math.min(panel === 'pen' ? penWidth : eraserWidth, maxWidth)} aria-label={panel === 'pen' ? '画笔粗细' : '橡皮粗细'}
          onChange={event => (panel === 'pen' ? setPenWidth : setEraserWidth)(Number(event.target.value))} />
      </label>}
      {panel === 'manage' && <>
        <button aria-label="允许批注" aria-pressed={annotations.annotationsAllowed} disabled={Boolean(annotations.pendingAction)}
          onClick={() => { void annotations.setAnnotationsAllowed(!annotations.annotationsAllowed); }}>
          {annotations.annotationsAllowed ? '关闭批注' : '允许批注'}
        </button>
        <p>批注开启时，同频道观看者可直接绘画，无需逐人批准。</p>
      </>}
      {annotations.error && <p role="status" className="annotation-menu-error">{annotations.error}</p>}
    </div>}
  </div>;
}
