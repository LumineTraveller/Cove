import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  gridTargetIndex,
  moveItem,
  verticalTargetIndex,
  type SortableRowGeometry,
} from '../sortableList';

// 与 CSS 无关的弹簧缓动：起步快、末端轻微回弹，用于每行独立归位。
export const SORTABLE_SPRING_EASING =
  'linear(0, 0.006, 0.025 2.8%, 0.101 6.1%, 0.539 18.9%, 0.721 25.3%, 0.849 31.5%, 0.937 38.1%, 0.968 41.8%, 0.991 45.7%, 1.006 50.1%, 1.015 55%, 1.017 63.9%, 1.001 85.3%, 1)';

const DRAG_THRESHOLD_PX = 5;
// 让位动画放慢一些，配合弹簧缓动与错峰，观感更柔和。
const FLIP_DURATION_MS = 480;
const SETTLE_DURATION_MS = 380;
const FLIP_STAGGER_MS = 14;
const FLIP_STAGGER_MAX_MS = 90;

// 拖拽期间挂在 <body> 上的状态类。overlay 为了不挡住命中测试被设为
// pointer-events:none，因此它自己的 cursor:grabbing 永远不生效；光标会由指针
// 扫过的下层元素（按钮、滑块等 cursor:pointer）接管，出现跳变。用这个类在
// 拖拽期间统一压制整棵子树的光标。
const DRAG_CURSOR_CLASS = 'sortable-dragging';

let dragCursorOwners = 0;

function acquireDragCursor() {
  if (dragCursorOwners === 0) document.body.classList.add(DRAG_CURSOR_CLASS);
  dragCursorOwners += 1;
}

function releaseDragCursor() {
  dragCursorOwners = Math.max(0, dragCursorOwners - 1);
  if (dragCursorOwners === 0) document.body.classList.remove(DRAG_CURSOR_CLASS);
}

export type SortableLayout = 'vertical' | 'grid';

interface OverlayState {
  id: string;
  rect: { left: number; top: number; width: number; height: number };
  offsetX: number;
  offsetY: number;
}

interface PointerDragState {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  sourceIndex: number;
  order: string[];
  rows: SortableRowGeometry[];
  targetIndex: number;
  moved: boolean;
  /** 是否已经持有 body 上的拖拽光标类，保证成对释放。 */
  cursorAcquired: boolean;
}

interface KeyboardDragState {
  id: string;
  order: string[];
  sourceIndex: number;
  targetIndex: number;
}

export interface UseSortableListOptions {
  ids: string[];
  onCommit: (orderedIds: string[]) => void;
  disabled?: boolean;
  layout?: SortableLayout;
}

export function useSortableList({
  ids,
  onCommit,
  disabled = false,
  layout = 'vertical',
}: UseSortableListOptions) {
  const [orderedIds, setOrderedIds] = useState(ids);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [keyboardId, setKeyboardId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [pointerSession, setPointerSession] = useState<number | null>(null);

  const rowRefs = useRef(new Map<string, HTMLElement>());
  const refCallbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const pendingFlipRef = useRef<Map<string, DOMRect> | null>(null);
  const [flipToken, setFlipToken] = useState(0);

  const idsRef = useRef(ids);
  idsRef.current = ids;
  const orderedRef = useRef(orderedIds);
  orderedRef.current = orderedIds;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const pointerRef = useRef<PointerDragState | null>(null);
  const keyboardRef = useRef<KeyboardDragState | null>(null);
  const latestPointRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);

  const idsKey = ids.join('\u0000');
  useEffect(() => {
    if (pointerRef.current || keyboardRef.current) return;
    setOrderedIds((current) => (current.join('\u0000') === idsKey ? current : idsRef.current));
  }, [idsKey]);

  const registerRow = useCallback((id: string) => {
    let callback = refCallbacks.current.get(id);
    if (!callback) {
      callback = (element: HTMLElement | null) => {
        if (element) rowRefs.current.set(id, element);
        else {
          rowRefs.current.delete(id);
          refCallbacks.current.delete(id);
        }
      };
      refCallbacks.current.set(id, callback);
    }
    return callback;
  }, []);

  /**
   * 量出每一行的「布局位置」。
   *
   * 这里必须是布局位置而不是视觉位置：一次拖拽会在几百毫秒内连续触发多次换序，
   * 上一次的 FLIP 动画往往还在播放。如果直接读 getBoundingClientRect()，拿到的是
   * 动画中途的插值位置——一个既非起点也非终点的脏值，用它算出的 delta 会让卡片
   * 先闪到错误位置再重新滑动。
   *
   * 做法分三步，顺序很关键：
   * 1. 先 cancel 掉进行中的动画（cancel 只是标记，样式回退要等下一次样式重算）；
   * 2. 读一次 offsetHeight 强制同步重算，把取消真正落实；
   * 3. 才做真正的测量。
   */
  const measureRows = useCallback((cancelAnimations: boolean) => {
    const elements = [...rowRefs.current.values()];
    if (cancelAnimations) {
      for (const element of elements) {
        for (const animation of element.getAnimations()) animation.cancel();
      }
      // 强制刷掉待处理的样式重算，确保 cancel 已经生效——否则下面测到的仍是
      // 动画中途的视觉位置。
      if (elements.length) void elements[0].offsetHeight;
    }
    const rects = new Map<string, DOMRect>();
    for (const [id, element] of rowRefs.current) {
      rects.set(id, element.getBoundingClientRect());
    }
    return rects;
  }, []);

  /** 应用新的顺序，并让未拖动的行从旧位置 FLIP 到新位置。 */
  const applyOrder = useCallback(
    (next: string[]) => {
      // 顺序没变也要把进行中的动画收干净：否则残留的 FLIP 会在下一次换序时
      // 被当成基准读进去，造成同样形式的跳变。
      pendingFlipRef.current = measureRows(true);
      if (next.join('\u0000') === orderedRef.current.join('\u0000')) {
        pendingFlipRef.current = null;
        return;
      }
      setOrderedIds(next);
      setFlipToken((token) => token + 1);
    },
    [measureRows],
  );

  useLayoutEffect(() => {
    const before = pendingFlipRef.current;
    pendingFlipRef.current = null;
    if (!before) return;
    const activeId = pointerRef.current?.id ?? keyboardRef.current?.id;
    const targetIndex = pointerRef.current?.targetIndex ?? keyboardRef.current?.targetIndex ?? -1;
    const currentOrder = orderedRef.current;
    for (const [id, element] of rowRefs.current) {
      if (id === activeId) continue;
      const previous = before.get(id);
      if (!previous) continue;
      // 布局已由 React 更新，这里读到的是新位置。动画本身不带 transform，
      // 因此不会影响这次测量。
      const current = element.getBoundingClientRect();
      const deltaX = previous.left - current.left;
      const deltaY = previous.top - current.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;
      const index = currentOrder.indexOf(id);
      const delay = targetIndex >= 0
        ? Math.min(FLIP_STAGGER_MAX_MS, Math.abs(index - targetIndex) * FLIP_STAGGER_MS)
        : 0;
      element.animate(
        [
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        {
          duration: FLIP_DURATION_MS,
          easing: SORTABLE_SPRING_EASING,
          delay,
          // 终点固定等于布局位置，所以不需要保持终态；但要用 'backwards' 让
          // stagger 延迟期间也停在起始位移上，否则延迟中的卡片会先闪回原位。
          fill: 'backwards',
        },
      );
    }
  }, [flipToken]);

  const syncOverlayTransform = useCallback(() => {
    const element = overlayRef.current;
    const drag = pointerRef.current;
    const point = latestPointRef.current;
    if (!element || !drag || !point || !drag.moved) return;
    const row = drag.rows.find((item) => item.id === drag.id);
    if (!row) return;
    element.style.transform = `translate3d(${point.x - drag.offsetX - row.left}px, ${point.y - drag.offsetY - row.top}px, 0)`;
  }, []);

  const computeTarget = useCallback((drag: PointerDragState, x: number, y: number) => {
    const row = drag.rows.find((item) => item.id === drag.id);
    if (layoutRef.current === 'grid') {
      // 网格命中应以被拖卡片的中心，而不是鼠标按下的偏移点为准。
      // 这样从卡片左侧/右侧抓取时，横向落位仍与视觉上的卡片位置一致。
      const centerX = x - drag.offsetX + (row?.width ?? 0) / 2;
      const centerY = y - drag.offsetY + (row?.height ?? 0) / 2;
      return gridTargetIndex(drag.rows, drag.id, centerX, centerY);
    }
    const centerY = y - drag.offsetY + (row?.height ?? 0) / 2;
    return verticalTargetIndex(drag.rows, drag.id, centerY);
  }, []);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = pointerRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      latestPointRef.current = { x: event.clientX, y: event.clientY };
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX)
          return;
        drag.order = orderedRef.current;
        drag.sourceIndex = drag.order.indexOf(drag.id);
        drag.rows = drag.order.flatMap((id) => {
          const element = rowRefs.current.get(id);
          if (!element) return [];
          const rect = element.getBoundingClientRect();
          return [{ id, top: rect.top, left: rect.left, width: rect.width, height: rect.height }];
        });
        const row = drag.rows.find((item) => item.id === drag.id);
        if (!row) {
          pointerRef.current = null;
          setPointerSession(null);
          return;
        }
        drag.moved = true;
        setOverlay({
          id: drag.id,
          rect: { left: row.left, top: row.top, width: row.width, height: row.height },
          offsetX: drag.offsetX,
          offsetY: drag.offsetY,
        });
        setDraggingId(drag.id);
        acquireDragCursor();
        drag.cursorAcquired = true;
        setAnnouncement(`已拾起，共 ${drag.order.length} 个，正在拖动排序`);
      }
      if (frameRef.current === null) {
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          const current = pointerRef.current;
          const point = latestPointRef.current;
          if (!current || !point || !current.moved) return;
          syncOverlayTransform();
          const target = computeTarget(current, point.x, point.y);
          if (target !== current.targetIndex) {
            current.targetIndex = target;
            applyOrder(moveItem(current.order, current.sourceIndex, target));
            setAnnouncement(`已移动到第 ${target + 1} 位，共 ${current.order.length} 个`);
          }
        });
      }
    },
    [applyOrder, computeTarget, syncOverlayTransform],
  );

  const finishPointerDrag = useCallback(
    (commit: boolean) => {
      const drag = pointerRef.current;
      if (!drag) return;
      if (drag.moved) {
        suppressClickRef.current = true;
        const point = latestPointRef.current;
        const row = drag.rows.find((item) => item.id === drag.id);
        const placeholder = placeholderRef.current;
        const overlayElement = overlayRef.current;
        if (commit) {
          if (row && point && placeholder && overlayElement) {
            const slot = placeholder.getBoundingClientRect();
            overlayElement.animate(
              [
                {
                  transform: `translate3d(${point.x - drag.offsetX - row.left}px, ${point.y - drag.offsetY - row.top}px, 0)`,
                },
                {
                  transform: `translate3d(${slot.left - row.left}px, ${slot.top - row.top}px, 0)`,
                },
              ],
              { duration: SETTLE_DURATION_MS, easing: SORTABLE_SPRING_EASING, fill: 'forwards' },
            );
            if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
            settleTimerRef.current = window.setTimeout(() => {
              settleTimerRef.current = null;
              setOverlay(null);
            }, SETTLE_DURATION_MS + 20);
          } else {
            setOverlay(null);
          }
          onCommitRef.current(orderedRef.current);
          setAnnouncement('已放下');
        } else {
          applyOrder(drag.order);
          setOverlay(null);
          setAnnouncement('已取消排序');
        }
      }
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (drag.cursorAcquired) {
        drag.cursorAcquired = false;
        releaseDragCursor();
      }
      pointerRef.current = null;
      setDraggingId(null);
      setPointerSession(null);
    },
    [applyOrder],
  );

  useEffect(() => {
    if (pointerSession === null) return;
    const move = (event: PointerEvent) => onPointerMove(event);
    const up = (event: PointerEvent) => {
      if (event.pointerId === pointerSession) finishPointerDrag(true);
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === pointerSession) finishPointerDrag(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finishPointerDrag(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
    };
  }, [pointerSession, onPointerMove, finishPointerDrag]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      // 组件在拖拽中被卸载时（例如面板关闭）兜底移除光标类，避免残留。
      const drag = pointerRef.current;
      if (drag?.cursorAcquired) {
        drag.cursorAcquired = false;
        releaseDragCursor();
      }
    },
    [],
  );

  const beginPointerDrag = useCallback((id: string, event: ReactPointerEvent<HTMLElement>) => {
    if (disabledRef.current || event.button !== 0 || pointerRef.current || keyboardRef.current) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select, [data-sortable-ignore]')) return;
    const element = rowRefs.current.get(id);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    suppressClickRef.current = false;
    latestPointRef.current = { x: event.clientX, y: event.clientY };
    const order = orderedRef.current;
    pointerRef.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      sourceIndex: order.indexOf(id),
      order,
      rows: [],
      targetIndex: order.indexOf(id),
      moved: false,
      cursorAcquired: false,
    };
    setPointerSession(event.pointerId);
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>, id: string): boolean => {
      if (disabledRef.current) return false;
      const active = keyboardRef.current;
      if (!active) {
        if (event.key !== ' ' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
          return false;
        const order = orderedRef.current;
        if (order.length < 2) return false;
        event.preventDefault();
        keyboardRef.current = { id, order, sourceIndex: order.indexOf(id), targetIndex: order.indexOf(id) };
        setKeyboardId(id);
        setDraggingId(id);
        setAnnouncement(`已拾起，共 ${order.length} 个，用方向键调整顺序，空格放下，Esc 取消`);
        return true;
      }
      if (active.id !== id) return false;
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        onCommitRef.current(orderedRef.current);
        keyboardRef.current = null;
        setKeyboardId(null);
        setDraggingId(null);
        setAnnouncement('已放下');
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        applyOrder(active.order);
        keyboardRef.current = null;
        setKeyboardId(null);
        setDraggingId(null);
        setAnnouncement('已取消排序');
        return true;
      }
      const backwards = event.key === 'ArrowUp' || (layoutRef.current === 'grid' && event.key === 'ArrowLeft');
      const forwards = event.key === 'ArrowDown' || (layoutRef.current === 'grid' && event.key === 'ArrowRight');
      if (!backwards && !forwards) return false;
      event.preventDefault();
      const length = active.order.length;
      const target = Math.max(0, Math.min(length - 1, active.targetIndex + (backwards ? -1 : 1)));
      if (target === active.targetIndex) return true;
      active.targetIndex = target;
      applyOrder(moveItem(active.order, active.sourceIndex, target));
      setAnnouncement(`已移动到第 ${target + 1} 位，共 ${length} 个`);
      window.requestAnimationFrame(() => rowRefs.current.get(active.id)?.focus());
      return true;
    },
    [applyOrder],
  );

  const consumeClickSuppression = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  const getRowProps = useCallback(
    (id: string) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => beginPointerDrag(id, event),
      tabIndex: disabled || orderedIds.length < 2 ? -1 : 0,
      'aria-grabbed': draggingId === id || keyboardId === id,
      'aria-roledescription': '可拖动排序项',
      'data-sortable-dragging': draggingId === id ? 'true' : undefined,
      style: { touchAction: 'none' as const },
    }),
    [beginPointerDrag, disabled, draggingId, keyboardId, orderedIds.length],
  );

  const overlayStyle: CSSProperties | undefined = overlay
    ? (() => {
        const point = latestPointRef.current;
        const x = (point?.x ?? overlay.rect.left + overlay.offsetX) - overlay.offsetX - overlay.rect.left;
        const y = (point?.y ?? overlay.rect.top + overlay.offsetY) - overlay.offsetY - overlay.rect.top;
        return {
          position: 'fixed',
          left: overlay.rect.left,
          top: overlay.rect.top,
          width: overlay.rect.width,
          height: overlay.rect.height,
          margin: 0,
          transform: `translate3d(${x}px, ${y}px, 0)`,
          pointerEvents: 'none',
        };
      })()
    : undefined;

  return {
    orderedIds,
    draggingId,
    keyboardId,
    overlay,
    overlayRef,
    overlayStyle,
    overlayHeight: overlay?.rect.height ?? 0,
    placeholderRef,
    announcement,
    registerRow,
    getRowProps,
    handleKeyDown,
    consumeClickSuppression,
  };
}
