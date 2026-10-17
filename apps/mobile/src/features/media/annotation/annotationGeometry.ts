import type { AnnotationPoint } from '@cove/contracts';
import type { Point, Size, ZoomTransform } from '../screen/screenZoom';

export interface VideoRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function containedVideoRect(
  viewport: Size,
  video?: Size,
): VideoRect | null {
  if (
    !video ||
    ![viewport.width, viewport.height, video.width, video.height].every(
      value => Number.isFinite(value) && value > 0,
    )
  )
    return null;
  const fit = Math.min(
    viewport.width / video.width,
    viewport.height / video.height,
  );
  const width = video.width * fit;
  const height = video.height * fit;
  return {
    left: (viewport.width - width) / 2,
    top: (viewport.height - height) / 2,
    width,
    height,
  };
}

/** Invert the same center-based native transform used for the video and ink. */
export function normalizedScreenPoint(
  point: Point,
  viewport: Size,
  video: Size | undefined,
  transform: ZoomTransform,
  pixelRatio = 1,
): AnnotationPoint | null {
  const rect = containedVideoRect(viewport, video);
  if (
    !rect ||
    ![point.x, point.y, transform.x, transform.y, transform.scale].every(
      Number.isFinite,
    ) ||
    transform.scale < 1
  )
    return null;
  if (
    point.x < 0 ||
    point.y < 0 ||
    point.x > viewport.width ||
    point.y > viewport.height
  )
    return null;
  const x =
    (point.x - viewport.width / 2 - transform.x) / transform.scale +
    viewport.width / 2;
  const y =
    (point.y - viewport.height / 2 - transform.y) / transform.scale +
    viewport.height / 2;
  // Keep the topmost physical pixel reachable when contain rounding is <1px,
  // while intentional letterbox bars remain inert for drawing and remote input.
  const tolerance =
    1 / (Number.isFinite(pixelRatio) ? Math.max(1, pixelRatio) : 1);
  const left = rect.left <= tolerance ? 0 : rect.left;
  const top = rect.top <= tolerance ? 0 : rect.top;
  const right =
    rect.left <= tolerance ? viewport.width : rect.left + rect.width;
  const bottom =
    rect.top <= tolerance ? viewport.height : rect.top + rect.height;
  if (x < left || x > right || y < top || y > bottom) return null;
  return {
    x: Math.max(0, Math.min(1, (x - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (y - rect.top) / rect.height)),
  };
}
