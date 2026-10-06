import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useSortableList } from '../../src/features/sorting/useSortableList';
import '../../src/styles/index.css';

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function Fixture() {
  const [items, setItems] = useState(['a', 'b', 'c', 'd']);
  const sortable = useSortableList({
    ids: items,
    onCommit: (ordered) => setItems(ordered),
    layout: 'grid',
  });

  return (
    <ul id="list" data-order={sortable.orderedIds.join('')}>
      {sortable.orderedIds.map((id) =>
        id === sortable.draggingId && !sortable.keyboardId ? (
          <li
            key={id}
            ref={sortable.placeholderRef}
            className="placeholder"
            style={{ height: sortable.overlayHeight }}
            data-placeholder="true"
          />
        ) : (
          <li
            key={id}
            id={`item-${id}`}
            ref={sortable.registerRow(id)}
            {...sortable.getRowProps(id)}
            data-keyboard-lifted={sortable.keyboardId === id ? 'true' : undefined}
            onKeyDown={(event) => sortable.handleKeyDown(event, id)}
          >
            {id}
          </li>
        ),
      )}
      <div id="status" role="status" aria-live="polite">
        {sortable.announcement}
      </div>
      {sortable.overlay && sortable.overlayStyle && (
        <div id="overlay" className="soundpack-item-overlay" ref={sortable.overlayRef} style={sortable.overlayStyle}>
          {sortable.overlay.id}
        </div>
      )}
    </ul>
  );
}

const fire = (target: EventTarget, type: string, x: number, y: number) => {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 11,
      pointerType: 'mouse',
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: x,
      clientY: y,
    }),
  );
};

const key = (element: Element, value: string) => {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
};

declare global {
  interface Window {
    sortableQa: {
      order: () => string[];
      dragging: () => string | null;
      lastDrag: { overlayVisible: boolean; zIndex: number; elementAtPoint: string | null } | null;
      drag: (fromId: string, toId: string) => Promise<string[]>;
      dragBetween: (fromId: string, leftId: string, rightId: string) => Promise<string[]>;
      keyboard: (id: string, keys: string[]) => Promise<string[]>;
      rapidRedrag: (
        fromId1: string,
        toId1: string,
        fromId2: string,
        toId2: string,
      ) => Promise<{
        order: string[];
        overlayDuring: boolean;
        placeholderHeight: number;
        overlayNearPointer: boolean;
      }>;
    };
  }
}

const elementAt = (id: string) => document.getElementById(`item-${id}`)!;

const runDrag = async (fromId: string, endX: number, endY: number) => {
  const fromRect = elementAt(fromId).getBoundingClientRect();
  const startX = fromRect.left + fromRect.width / 2;
  const startY = fromRect.top + fromRect.height / 2;
  fire(elementAt(fromId), 'pointerdown', startX, startY);
  for (let step = 1; step <= 10; step += 1) {
    fire(window, 'pointermove', startX + ((endX - startX) * step) / 10, startY + ((endY - startY) * step) / 10);
    await frame();
  }
  const overlay = document.getElementById('overlay');
  const style = overlay ? getComputedStyle(overlay) : null;
  const elementAtPoint = document.elementFromPoint(endX, endY);
  window.sortableQa.lastDrag = {
    overlayVisible: Boolean(overlay),
    zIndex: style ? Number(style.zIndex) : 0,
    elementAtPoint: elementAtPoint ? (elementAtPoint.id || elementAtPoint.className || elementAtPoint.tagName) : null,
  };
  fire(window, 'pointerup', endX, endY);
  await delay(520);
  return window.sortableQa.order();
};

window.sortableQa = {
  lastDrag: null,
  order: () =>
    [...document.querySelectorAll<HTMLElement>('#list li')]
      .filter((element) => element.dataset.placeholder !== 'true')
      .map((element) => element.textContent?.trim() ?? ''),
  dragging: () => document.querySelector<HTMLElement>('#list li[data-sortable-dragging="true"]')?.textContent?.trim() ?? null,
  async drag(fromId, toId) {
    const rect = elementAt(toId).getBoundingClientRect();
    return runDrag(fromId, rect.left + rect.width / 2, rect.top + rect.height / 2);
  },
  async dragBetween(fromId, leftId, rightId) {
    const left = elementAt(leftId).getBoundingClientRect();
    const right = elementAt(rightId).getBoundingClientRect();
    return runDrag(fromId, (left.right + right.left) / 2, left.top + left.height / 2);
  },
  async keyboard(id, keys) {
    const element = elementAt(id);
    element.focus();
    for (const value of keys) {
      key(element, value);
      await frame();
    }
    await delay(80);
    return window.sortableQa.order();
  },
  // 回归：第一次拖放的 settle 定时器（约 400ms）还在飞时就立刻抓起下一个，
  // 在定时器应触发之后仍按住不放，检查 overlay 不被抽走、占位不塌、卡片跟手。
  async rapidRedrag(fromId1, toId1, fromId2, toId2) {
    const dragTo = async (fromId: string, toId: string) => {
      const toRect = elementAt(toId).getBoundingClientRect();
      const endX = toRect.left + toRect.width / 2;
      const endY = toRect.top + toRect.height / 2;
      const fromRect = elementAt(fromId).getBoundingClientRect();
      const startX = fromRect.left + fromRect.width / 2;
      const startY = fromRect.top + fromRect.height / 2;
      fire(elementAt(fromId), 'pointerdown', startX, startY);
      for (let step = 1; step <= 8; step += 1) {
        fire(window, 'pointermove', startX + ((endX - startX) * step) / 8, startY + ((endY - startY) * step) / 8);
        await frame();
      }
      return { endX, endY };
    };

    const first = await dragTo(fromId1, toId1);
    fire(window, 'pointerup', first.endX, first.endY);
    await delay(60);

    const second = await dragTo(fromId2, toId2);
    // 越过上一次 settle 定时器的触发点（首次 drop 后约 400ms），仍按住观察。
    await delay(520);

    const overlay = document.getElementById('overlay');
    const overlayRect = overlay?.getBoundingClientRect() ?? null;
    const placeholder = document.querySelector<HTMLElement>('#list li[data-placeholder="true"]');
    const placeholderHeight = placeholder?.getBoundingClientRect().height ?? 0;
    const overlayNearPointer = overlayRect
      ? second.endX >= overlayRect.left - 2 &&
        second.endX <= overlayRect.right + 2 &&
        second.endY >= overlayRect.top - 2 &&
        second.endY <= overlayRect.bottom + 2
      : false;

    fire(window, 'pointerup', second.endX, second.endY);
    await delay(520);
    return {
      order: window.sortableQa.order(),
      overlayDuring: Boolean(overlay),
      placeholderHeight,
      overlayNearPointer,
    };
  },
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
