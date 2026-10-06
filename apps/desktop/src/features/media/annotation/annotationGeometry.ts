export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface AnnotationRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface AnnotationSize {
  width: number;
  height: number;
}

export interface AnchoredRect {
  rect: AnnotationRect;
  side: 'top' | 'bottom';
}

const isFiniteRect = (rect: AnnotationRect) =>
  Number.isFinite(rect.left) &&
  Number.isFinite(rect.top) &&
  Number.isFinite(rect.width) &&
  Number.isFinite(rect.height) &&
  rect.width >= 0 &&
  rect.height >= 0;

/** Returns the video pixels' visible content box for `object-fit: contain`. */
export function getContainedVideoRect(
  containerRect: AnnotationRect,
  videoWidth: number,
  videoHeight: number,
): AnnotationRect | null {
  if (
    !isFiniteRect(containerRect) ||
    containerRect.width <= 0 ||
    containerRect.height <= 0 ||
    !Number.isFinite(videoWidth) ||
    !Number.isFinite(videoHeight) ||
    videoWidth <= 0 ||
    videoHeight <= 0
  )
    return null;

  const videoRatio = videoWidth / videoHeight;
  const boxRatio = containerRect.width / containerRect.height;
  if (videoRatio >= boxRatio) {
    const width = containerRect.width;
    const height = width / videoRatio;
    return {
      left: containerRect.left,
      top: containerRect.top + (containerRect.height - height) / 2,
      width,
      height,
    };
  }

  const height = containerRect.height;
  const width = height * videoRatio;
  return {
    left: containerRect.left + (containerRect.width - width) / 2,
    top: containerRect.top,
    width,
    height,
  };
}

/** Map a screen pointer into normalized video coordinates; black bars return null. */
export function mapClientPointToAnnotationPoint(
  clientX: number,
  clientY: number,
  videoRect: AnnotationRect,
): AnnotationPoint | null {
  if (
    !isFiniteRect(videoRect) ||
    videoRect.width <= 0 ||
    videoRect.height <= 0 ||
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY)
  )
    return null;
  const right = videoRect.left + videoRect.width;
  const bottom = videoRect.top + videoRect.height;
  if (clientX < videoRect.left || clientX > right || clientY < videoRect.top || clientY > bottom)
    return null;

  return {
    x: clamp((clientX - videoRect.left) / videoRect.width, 0, 1),
    y: clamp((clientY - videoRect.top) / videoRect.height, 0, 1),
  };
}

/** Keep a floating tool rectangle visible inside the current display bounds. */
export function clampRectToBounds(rect: AnnotationRect, bounds: AnnotationRect): AnnotationRect {
  if (!isFiniteRect(rect) || !isFiniteRect(bounds)) return rect;
  const width = Math.min(rect.width, bounds.width);
  const height = Math.min(rect.height, bounds.height);
  return {
    left: clamp(rect.left, bounds.left, bounds.left + bounds.width - width),
    top: clamp(rect.top, bounds.top, bounds.top + bounds.height - height),
    width,
    height,
  };
}

/** Place a tool capsule above/below its anchor, then clamp it to the display. */
export function placeRectNearAnchor(
  anchor: AnnotationRect,
  size: AnnotationSize,
  bounds: AnnotationRect,
  gap = 8,
): AnchoredRect {
  const width = Math.max(0, Math.min(size.width, bounds.width));
  const height = Math.max(0, Math.min(size.height, bounds.height));
  const centerX = anchor.left + anchor.width / 2;
  const belowTop = anchor.top + anchor.height + gap;
  const aboveTop = anchor.top - height - gap;
  const bottomEdge = bounds.top + bounds.height;
  const hasRoomBelow = belowTop + height <= bottomEdge;
  const hasRoomAbove = aboveTop >= bounds.top;
  const belowSpace = Math.max(0, bottomEdge - belowTop);
  const aboveSpace = Math.max(0, anchor.top - gap - bounds.top);
  const side: AnchoredRect['side'] = hasRoomBelow
    ? 'bottom'
    : hasRoomAbove
      ? 'top'
      : belowSpace >= aboveSpace
        ? 'bottom'
        : 'top';
  const rect = {
    left: centerX - width / 2,
    top: side === 'bottom' ? belowTop : aboveTop,
    width,
    height,
  };
  return { rect: clampRectToBounds(rect, bounds), side };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
