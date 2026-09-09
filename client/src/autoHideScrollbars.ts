const SCROLLBAR_HIDE_DELAY = 900;

type ScrollTimer = ReturnType<typeof window.setTimeout>;

function hasScrollableOverflow(element: Element) {
  const style = window.getComputedStyle(element);
  const vertical = /^(auto|scroll|overlay)$/.test(style.overflowY);
  const horizontal = /^(auto|scroll|overlay)$/.test(style.overflowX);
  return (
    (vertical && element.scrollHeight > element.clientHeight + 1) ||
    (horizontal && element.scrollWidth > element.clientWidth + 1)
  );
}

function findScrollContainer(target: EventTarget | null) {
  let current = target instanceof Element ? target : null;
  while (current) {
    if (hasScrollableOverflow(current)) return current;
    current = current.parentElement;
  }

  const root = document.scrollingElement ?? document.documentElement;
  return hasScrollableOverflow(root) ? root : null;
}

function isScrollKey(key: string) {
  return (
    key === "PageUp" ||
    key === "PageDown" ||
    key === "Home" ||
    key === "End" ||
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === " "
  );
}

/**
 * Keep scroll indicators quiet until the user actually interacts with a
 * scrollable surface.  Event delegation covers modal/list nodes mounted
 * after startup without adding listeners to every transient element.
 */
export function installAutoHideScrollbars() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }

  const timers = new WeakMap<Element, ScrollTimer>();
  const activeContainers = new Set<Element>();

  const reveal = (target: EventTarget | null) => {
    const container = findScrollContainer(target);
    if (!container) return;
    const previousTimer = timers.get(container);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    container.classList.add("scrollbar-active");
    activeContainers.add(container);
    timers.set(
      container,
      window.setTimeout(() => {
        container.classList.remove("scrollbar-active");
        timers.delete(container);
        activeContainers.delete(container);
      }, SCROLLBAR_HIDE_DELAY),
    );
  };

  const onScroll = (event: Event) => reveal(event.target);
  const onWheel = (event: WheelEvent) => reveal(event.target);
  const onPointerDown = (event: PointerEvent) => reveal(event.target);
  const onTouchStart = (event: TouchEvent) => reveal(event.target);
  const onFocusIn = (event: FocusEvent) => reveal(event.target);
  const onKeyDown = (event: KeyboardEvent) => {
    if (isScrollKey(event.key)) reveal(event.target);
  };

  document.addEventListener("scroll", onScroll, true);
  document.addEventListener("wheel", onWheel, { capture: true, passive: true });
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("touchstart", onTouchStart, {
    capture: true,
    passive: true,
  });
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("keydown", onKeyDown, true);

  return () => {
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("wheel", onWheel, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("touchstart", onTouchStart, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("keydown", onKeyDown, true);
    activeContainers.forEach((container) => {
      const timer = timers.get(container);
      if (timer !== undefined) window.clearTimeout(timer);
      container.classList.remove("scrollbar-active");
    });
    activeContainers.clear();
  };
}
