import type { AnnotationPoint, AnnotationStroke } from '@cove/contracts';

export interface AnnotationOverlayFrame {
  strokes: AnnotationStroke[];
  lasers: AnnotationPoint[];
}

const unit = (value: unknown): value is number => typeof value === 'number' &&
  Number.isFinite(value) && value >= 0 && value <= 1;
const point = (value: unknown): value is AnnotationPoint => Boolean(value &&
  typeof value === 'object' && unit((value as AnnotationPoint).x) && unit((value as AnnotationPoint).y));

/** IPC is a local mirror of the existing authorized annotation session. */
export function validOverlayFrame(value: unknown): value is AnnotationOverlayFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as AnnotationOverlayFrame;
  if (!Array.isArray(frame.strokes) || frame.strokes.length > 800 ||
      !Array.isArray(frame.lasers) || frame.lasers.length > 128 || !frame.lasers.every(point)) return false;
  let points = 0;
  return frame.strokes.every(stroke => {
    if (!stroke || (stroke.tool !== 'pen' && stroke.tool !== 'eraser') ||
        typeof stroke.color !== 'string' || !/^#[\da-f]{6}$/i.test(stroke.color) ||
        !unit(stroke.width) || stroke.width < 0.0005 || stroke.width > 0.08 ||
        !Array.isArray(stroke.points) || stroke.points.length > 2048) return false;
    points += stroke.points.length;
    return points <= 32000 && stroke.points.every(point);
  });
}
