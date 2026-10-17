import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { flattenSoundpackGroups, moveSoundpackToGroup, resolveSoundpackDrop, resolveSoundpackGroup, swapSoundpackGroups, type SoundpackGroup, type SoundpackGroupGeometry } from './soundpackGroups';
import { SORTABLE_SPRING_EASING } from '../sorting/useSortableList';

const FLIP_DURATION_MS = 480;
const SETTLE_DURATION_MS = 380;
type MotionRect = Pick<DOMRect, 'left' | 'top'>;

/** Animate from the last visible positions, including an interrupted transition. */
export function animateSoundpackLayout(
  before: ReadonlyMap<string, MotionRect>,
  elements: ReadonlyMap<string, HTMLElement>,
  reducedMotion: boolean,
): Map<HTMLElement, Animation> {
  const animations = new Map<HTMLElement, Animation>();
  if (reducedMotion) return animations;
  for (const [id, element] of elements) {
    const previous = before.get(id);
    if (!previous || typeof element.animate !== 'function') continue;
    const current = element.getBoundingClientRect();
    const x = previous.left - current.left;
    const y = previous.top - current.top;
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;
    animations.set(element, element.animate([
      { transform: `translate3d(${x}px, ${y}px, 0)` },
      { transform: 'translate3d(0, 0, 0)' },
    ], { duration: FLIP_DURATION_MS, easing: SORTABLE_SPRING_EASING }));
  }
  return animations;
}

export function soundpackOverlayTransform(rect: MotionRect, point: { x: number; y: number }, offset: { x: number; y: number }): string {
  return `translate3d(${point.x - offset.x - rect.left}px, ${point.y - offset.y - rect.top}px, 0)`;
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

interface DragSession {
  kind: 'sound' | 'group';
  id: string;
  sourceGroupId: string;
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  rect: { left: number; top: number; width: number; height: number; };
  base: SoundpackGroup[];
  geometry: SoundpackGroupGeometry[];
  moved: boolean;
}

export function useSoundpackGroups({ groups, onCommit, disabled, scrollRef, scopeKey }: {
  groups: SoundpackGroup[];
  onCommit: (groups: SoundpackGroup[]) => void;
  disabled: boolean;
  scrollRef: React.RefObject<HTMLDivElement>;
  scopeKey?: string;
}) {
  const [preview, setPreview] = useState(groups);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [keyboardId, setKeyboardId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<DragSession | null>(null);
  const [settleToken, setSettleToken] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [pointerSession, setPointerSession] = useState<number | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const groupElements = useRef(new Map<string, HTMLElement>());
  const rowCallbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const groupCallbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const session = useRef<DragSession | null>(null);
  const keyboardBase = useRef<{ kind: 'sound' | 'group'; id: string; base: SoundpackGroup[]; } | null>(null);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const pointRef = useRef({ x: 0, y: 0 });
  const suppressClick = useRef(false);
  const scrollFrame = useRef<number | null>(null);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const pointerFrame = useRef<number | null>(null);
  const settleTimer = useRef<number | null>(null);
  const settling = useRef<DragSession | null>(null);
  const layoutAnimations = useRef(new Map<HTMLElement, Animation>());
  const pendingFlip = useRef<{ kind: DragSession['kind']; rects: Map<string, MotionRect> } | null>(null);
  const targetGroup = useRef<HTMLElement | null>(null);
  const groupsKey = JSON.stringify(groups);
  const previousGroupsKey = useRef(groupsKey);
  const previousScope = useRef(scopeKey);

  const motionElements = useCallback((kind: DragSession['kind']) => {
    if (kind === 'group') return new Map(groupElements.current);
    const elements = new Map([...rows.current].map(([id, element]) => [`row:${id}`, element]));
    for (const [id, group] of groupElements.current) {
      const divider = group.querySelector<HTMLElement>('[data-soundpack-divider]');
      if (divider) elements.set(`divider:${id}`, divider);
    }
    return elements;
  }, []);
  const cancelLayoutAnimations = useCallback(() => {
    for (const animation of layoutAnimations.current.values()) animation.cancel();
    layoutAnimations.current.clear();
  }, []);

  const applyPreview = useCallback((next: SoundpackGroup[], animate = true) => {
    if (JSON.stringify(next) === JSON.stringify(previewRef.current)) return;
    const kind = session.current?.kind ?? keyboardBase.current?.kind ?? 'sound';
    const elements = motionElements(kind);
    // Read the current visual positions before cancelling our own animations.
    // The next transition then continues from those positions instead of jumping.
    pendingFlip.current = animate && !prefersReducedMotion()
      ? { kind, rects: new Map([...elements].map(([id, element]) => [id, element.getBoundingClientRect()])) }
      : null;
    cancelLayoutAnimations();
    previewRef.current = next;
    setPreview(next);
  }, [cancelLayoutAnimations, motionElements]);

  const syncOverlayTransform = useCallback(() => {
    const active = session.current;
    if (!active?.moved || !overlayRef.current) return;
    overlayRef.current.style.transform = soundpackOverlayTransform(active.rect, pointRef.current, { x: active.offsetX, y: active.offsetY });
  }, []);

  const resetOverlay = useCallback(() => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = null;
    settling.current = null;
    overlayRef.current?.getAnimations().forEach(animation => animation.cancel());
    overlayRef.current?.removeAttribute('data-soundpack-settling');
    setOverlay(null);
    setDraggingId(null);
    setDraggingGroupId(null);
  }, []);

  useLayoutEffect(() => {
    const before = pendingFlip.current;
    pendingFlip.current = null;
    if (before) layoutAnimations.current = animateSoundpackLayout(before.rects, motionElements(before.kind), prefersReducedMotion());
    syncOverlayTransform();
    const dropped = settling.current;
    if (!dropped || settleTimer.current !== null) return;
    const element = overlayRef.current;
    const group = groupElements.current.get(dropped.id);
    const destination = dropped.kind === 'sound'
      ? placeholderRef.current
      : group?.querySelector<HTMLElement>('[data-soundpack-divider]') ?? group;
    if (!element || !destination || prefersReducedMotion() || typeof element.animate !== 'function') {
      resetOverlay();
      return;
    }
    // Layout animations may translate a destination divider. The drop flies to
    // its final layout position, so the overlay and divider arrive together.
    const destinationAnimation = layoutAnimations.current.get(dropped.kind === 'group' && group ? group : destination);
    const currentTime = destinationAnimation?.currentTime;
    if (destinationAnimation) destinationAnimation.currentTime = FLIP_DURATION_MS;
    const slot = destination.getBoundingClientRect();
    if (destinationAnimation && currentTime !== undefined) destinationAnimation.currentTime = currentTime;
    element.setAttribute('data-soundpack-settling', 'true');
    element.animate([
      { transform: soundpackOverlayTransform(dropped.rect, pointRef.current, { x: dropped.offsetX, y: dropped.offsetY }) },
      { transform: `translate3d(${slot.left - dropped.rect.left}px, ${slot.top - dropped.rect.top}px, 0)` },
    ], { duration: SETTLE_DURATION_MS, easing: SORTABLE_SPRING_EASING, fill: 'forwards' });
    settleTimer.current = window.setTimeout(resetOverlay, SETTLE_DURATION_MS + 20);
  }, [preview, settleToken, motionElements, resetOverlay, syncOverlayTransform]);
  useEffect(() => {
    if (!session.current && !keyboardBase.current && !settling.current) applyPreview(groupsRef.current, false);
  }, [groupsKey, applyPreview]);

  const register = useCallback((id: string, isGroup: boolean) => {
    const callbacks = isGroup ? groupCallbacks.current : rowCallbacks.current;
    const elements = isGroup ? groupElements.current : rows.current;
    let callback = callbacks.get(id);
    if (!callback) {
      callback = (element) => { if (element) elements.set(id, element); else elements.delete(id); };
      callbacks.set(id, callback);
    }
    return callback;
  }, []);

  const captureGeometry = useCallback((base: SoundpackGroup[]) => {
    cancelLayoutAnimations();
    const scroll = scrollRef.current?.scrollTop ?? 0;
    return base.flatMap((group) => {
      const element = groupElements.current.get(group.id);
      if (!element) return [];
      const rect = element.getBoundingClientRect();
      return [{
        id: group.id, left: rect.left, top: rect.top + scroll, width: rect.width, height: rect.height,
        rows: group.soundIds.flatMap((id) => {
          const row = rows.current.get(id)?.getBoundingClientRect();
          return row ? [{ id, top: row.top + scroll, left: row.left, width: row.width, height: row.height }] : [];
        }),
      }];
    });
  }, [cancelLayoutAnimations, scrollRef]);

  const updateAtPoint = useCallback(() => {
    const active = session.current;
    if (!active?.moved) return;
    const current = pointRef.current;
    const y = current.y + (scrollRef.current?.scrollTop ?? 0);
    if (active.kind === 'group') {
      const target = resolveSoundpackGroup(active.geometry, y);
      if (target) {
        targetGroup.current?.removeAttribute('data-soundpack-drop-target');
        targetGroup.current = groupElements.current.get(target.id) ?? null;
        targetGroup.current?.setAttribute('data-soundpack-drop-target', 'true');
        applyPreview(swapSoundpackGroups(active.base, active.id, target.id));
      }
    } else {
      const target = resolveSoundpackDrop(active.geometry, active.sourceGroupId, active.id, current.x, y);
      if (target) {
        targetGroup.current?.removeAttribute('data-soundpack-drop-target');
        targetGroup.current = groupElements.current.get(target.groupId) ?? null;
        targetGroup.current?.setAttribute('data-soundpack-drop-target', 'true');
        applyPreview(moveSoundpackToGroup(active.base, active.id, target));
      }
    }
  }, [applyPreview, scrollRef]);

  const releasePointer = useCallback(() => {
    session.current = null;
    keyboardBase.current = null;
    setKeyboardId(null);
    setPointerSession(null);
    if (pointerFrame.current !== null) cancelAnimationFrame(pointerFrame.current);
    pointerFrame.current = null;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    targetGroup.current?.removeAttribute('data-soundpack-drop-target');
    targetGroup.current = null;
    document.body.classList.remove('soundpack-dragging');
  }, []);
  const clear = useCallback(() => {
    releasePointer();
    resetOverlay();
    cancelLayoutAnimations();
    pendingFlip.current = null;
  }, [cancelLayoutAnimations, releasePointer, resetOverlay]);
  const cancel = useCallback(() => {
    applyPreview(groupsRef.current, false);
    clear();
  }, [applyPreview, clear]);
  const finish = useCallback((commit: boolean, event?: PointerEvent) => {
    const active = session.current;
    if (!active) return;
    if (event) pointRef.current = { x: event.clientX, y: event.clientY };
    if (active.moved) {
      suppressClick.current = true;
      if (commit) {
        updateAtPoint();
        settling.current = active;
        setSettleToken(token => token + 1);
        commitRef.current(previewRef.current);
      } else applyPreview(groupsRef.current);
      setAnnouncement(commit ? '已放下' : '已取消排序');
    }
    releasePointer();
    if (!commit || !active.moved) resetOverlay();
  }, [applyPreview, releasePointer, resetOverlay, updateAtPoint]);
  useEffect(() => {
    const changedScope = previousScope.current !== scopeKey;
    previousScope.current = scopeKey;
    if (!changedScope && previousGroupsKey.current === groupsKey) return;
    previousGroupsKey.current = groupsKey;
    if (changedScope || session.current || keyboardBase.current || (settling.current && groupsKey !== JSON.stringify(previewRef.current))) {
      clear();
      setAnnouncement('列表已更新，已取消排序');
    }
    applyPreview(groupsRef.current, false);
  }, [groupsKey, scopeKey, applyPreview, clear]);
  useEffect(() => {
    const blur = () => {
      if (!session.current && !keyboardBase.current && !settling.current) return;
      applyPreview(groupsRef.current);
      clear();
    };
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, [applyPreview, clear]);

  useEffect(() => {
    if (pointerSession === null) return;
    const autoScroll = () => {
      const active = session.current;
      const scroller = scrollRef.current;
      if (!active?.moved || !scroller) return;
      const rect = scroller.getBoundingClientRect();
      const y = pointRef.current.y;
      const speed = y < rect.top + 28 ? -Math.min(12, (rect.top + 28 - y) / 3) : y > rect.bottom - 28 ? Math.min(12, (y - rect.bottom + 28) / 3) : 0;
      if (speed) { scroller.scrollTop += speed; updateAtPoint(); }
      scrollFrame.current = requestAnimationFrame(autoScroll);
    };
    const move = (event: PointerEvent) => {
      const active = session.current;
      if (!active || event.pointerId !== active.pointerId) return;
      pointRef.current = { x: event.clientX, y: event.clientY };
      if (!active.moved) {
        if (Math.hypot(event.clientX - active.startX, event.clientY - active.startY) < 5) return;
        active.geometry = captureGeometry(active.base);
        active.moved = true;
        setOverlay(active);
        if (active.kind === 'sound') setDraggingId(active.id);
        else setDraggingGroupId(active.id);
        document.body.classList.add('soundpack-dragging');
        setAnnouncement(active.kind === 'sound' ? '已拾起语音包，Esc 取消' : '已拾起分组，Esc 取消');
        scrollFrame.current = requestAnimationFrame(autoScroll);
      }
      if (pointerFrame.current === null) pointerFrame.current = requestAnimationFrame(() => {
        pointerFrame.current = null;
        syncOverlayTransform();
        updateAtPoint();
      });
    };
    const up = (event: PointerEvent) => { if (event.pointerId === pointerSession) finish(true, event); };
    const cancel = (event: PointerEvent) => { if (event.pointerId === pointerSession) finish(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); finish(false); } };
    const resize = () => finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', resize);
    const scroller = scrollRef.current;
    scroller?.addEventListener('scroll', updateAtPoint);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', resize);
      scroller?.removeEventListener('scroll', updateAtPoint);
    };
  }, [pointerSession, captureGeometry, finish, scrollRef, syncOverlayTransform, updateAtPoint]);
  useEffect(() => () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    if (pointerFrame.current !== null) cancelAnimationFrame(pointerFrame.current);
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    overlayRef.current?.getAnimations().forEach(animation => animation.cancel());
    cancelLayoutAnimations();
    targetGroup.current?.removeAttribute('data-soundpack-drop-target');
    document.body.classList.remove('soundpack-dragging');
  }, [cancelLayoutAnimations]);
  useEffect(() => {
    if (!disabled || (!session.current && !keyboardBase.current)) return;
    applyPreview(groupsRef.current);
    clear();
  }, [disabled, applyPreview, clear]);

  const begin = useCallback((kind: 'sound' | 'group', id: string, event: ReactPointerEvent<HTMLElement>) => {
    if (disabledRef.current || event.button !== 0 || session.current || keyboardBase.current) return;
    if (kind === 'sound' && (event.target as HTMLElement).closest('button:not([data-soundpack-play]),a,input,textarea,select,[data-sortable-ignore]')) return;
    // A new drag must not inherit a previous drop's forwards-filled animation
    // or delayed cleanup, which could freeze or remove its reused portal node.
    resetOverlay();
    cancelLayoutAnimations();
    const element = kind === 'sound' ? rows.current.get(id) : event.currentTarget;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const base = previewRef.current;
    const sourceGroupId = kind === 'group' ? id : base.find((group) => group.soundIds.includes(id))?.id;
    if (!sourceGroupId) return;
    if (kind === 'group') { event.preventDefault(); event.stopPropagation(); }
    suppressClick.current = false;
    pointRef.current = { x: event.clientX, y: event.clientY };
    session.current = {
      kind, id, sourceGroupId, base, geometry: [], pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, moved: false
    };
    setPointerSession(event.pointerId);
  }, [cancelLayoutAnimations, resetOverlay]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>, id: string, kind: 'sound' | 'group' = 'sound'): boolean => {
    if (disabledRef.current || session.current) return false;
    const active = keyboardBase.current;
    if (!active) {
      if (event.key !== ' ' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
      event.preventDefault();
      resetOverlay();
      cancelLayoutAnimations();
      keyboardBase.current = { kind, id, base: previewRef.current };
      setKeyboardId(id);
      if (kind === 'sound') setDraggingId(id); else setDraggingGroupId(id);
      setAnnouncement('已拾起，方向键调整，空格放下，Esc 取消');
      return true;
    }
    if (active.id !== id) return false;
    if (['Escape', ' ', 'Enter'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Escape') applyPreview(groupsRef.current); else commitRef.current(previewRef.current);
      clear();
      if (kind === 'group') requestAnimationFrame(() => groupElements.current.get(id)?.focus());
      return true;
    }
    const direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : 0;
    if (!direction) return false;
    event.preventDefault();
    const current = previewRef.current;
    if (kind === 'group') {
      const index = current.findIndex((group) => group.id === id);
      const target = current[index + direction];
      if (target) applyPreview(swapSoundpackGroups(current, id, target.id));
    } else {
      const groupIndex = current.findIndex((group) => group.soundIds.includes(id));
      const group = current[groupIndex];
      if (!group) { applyPreview(groupsRef.current); clear(); return true; }
      const index = group.soundIds.indexOf(id);
      const targetIndex = index + direction;
      const targetGroup = targetIndex < 0 ? current[groupIndex - 1] : targetIndex >= group.soundIds.length ? current[groupIndex + 1] : group;
      if (targetGroup) applyPreview(moveSoundpackToGroup(current, id, { groupId: targetGroup.id, index: targetGroup === group ? targetIndex : direction < 0 ? targetGroup.soundIds.length : 0 }));
    }
    requestAnimationFrame(() => (kind === 'sound' ? rows.current.get(id) : groupElements.current.get(id)?.querySelector<HTMLElement>('[data-soundpack-divider]'))?.focus());
    return true;
  }, [applyPreview, cancelLayoutAnimations, clear, resetOverlay]);
  const getRowProps = (id: string) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => begin('sound', id, event),
    tabIndex: disabled ? -1 : 0,
    'aria-grabbed': draggingId === id,
    'aria-roledescription': '可拖动语音包',
    'data-soundpack-id': id,
    style: { touchAction: 'none' as const },
  });
  const getDividerProps = (id: string) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => begin('group', id, event),
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => { handleKeyDown(event, id, 'group'); },
    'aria-grabbed': draggingGroupId === id,
    'data-soundpack-divider': id,
    disabled,
  });
  const overlayStyle: CSSProperties | undefined = overlay ? {
    position: 'fixed', left: overlay.rect.left, top: overlay.rect.top, width: overlay.rect.width, height: overlay.rect.height,
    margin: 0, transform: soundpackOverlayTransform(overlay.rect, pointRef.current, { x: overlay.offsetX, y: overlay.offsetY }), pointerEvents: 'none',
  } : undefined;
  return {
    groups: preview, orderedIds: flattenSoundpackGroups(preview), draggingId, draggingGroupId, keyboardId,
    overlay: overlay?.kind === 'sound' ? overlay : null, groupOverlay: overlay?.kind === 'group' ? overlay : null,
    overlayStyle, overlayHeight: overlay?.rect.height ?? 0, overlayRef, placeholderRef, announcement,
    registerRow: (id: string) => register(id, false), registerGroup: (id: string) => register(id, true),
    getRowProps, getDividerProps, handleKeyDown, cancel,
    consumeClickSuppression: () => { const suppressed = suppressClick.current; suppressClick.current = false; return suppressed; },
  };
}
