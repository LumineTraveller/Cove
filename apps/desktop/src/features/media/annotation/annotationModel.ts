import type { AnnotationPoint, AnnotationStroke } from '@cove/contracts';

import type { AnnotationRect } from './annotationGeometry';

/** Append an accepted chunk. Event revisions handle duplicate delivery. */
export function mergeAnnotationStroke(
  existing: AnnotationStroke,
  incoming: AnnotationStroke,
): AnnotationStroke {
  if (existing.id !== incoming.id) return incoming;
  return {
    ...existing,
    ...incoming,
    points: [...existing.points, ...incoming.points],
  };
}

/** Add a stroke or update its existing slot without changing draw/erase order. */
export function upsertAnnotationStroke(
  strokes: readonly AnnotationStroke[],
  incoming: AnnotationStroke,
): AnnotationStroke[] {
  const index = strokes.findIndex((stroke) => stroke.id === incoming.id);
  if (index === -1) return [...strokes, incoming];
  const next = [...strokes];
  next[index] = mergeAnnotationStroke(next[index], incoming);
  return next;
}

/** Extend each confirmed stroke in place, preserving its draw/erase order. */
export function composeAnnotationStrokes(
  confirmed: readonly AnnotationStroke[],
  optimistic: readonly AnnotationStroke[],
): AnnotationStroke[] {
  const pending = new Map(optimistic.map(stroke => [stroke.id, stroke]));
  const result = confirmed.map(stroke => {
    const local = pending.get(stroke.id);
    pending.delete(stroke.id);
    return local?.authorSocketId === stroke.authorSocketId && local.points.length > stroke.points.length
      ? { ...stroke, points: local.points } : stroke;
  });
  return [...result, ...pending.values()];
}

/** Merge a server snapshot monotonically so a late ACK cannot roll back state. */
export function preferNewerAnnotationState<T extends { revision: number }>(
  current: T | null,
  incoming: T,
): T {
  return current && current.revision > incoming.revision ? current : incoming;
}

/**
 * Replay strokes in server order. Destination-out erases only the pixels under
 * each eraser path, so later strokes remain visible over earlier erasures.
 */
export function renderAnnotationStrokes(
  context: CanvasRenderingContext2D,
  strokes: readonly AnnotationStroke[],
  rect: AnnotationRect,
) {
  context.save();
  context.clearRect(rect.left, rect.top, rect.width, rect.height);
  for (const stroke of strokes) drawAnnotationStroke(context, stroke, rect);
  context.restore();
}

export function drawAnnotationStroke(
  context: CanvasRenderingContext2D,
  stroke: Pick<AnnotationStroke, 'tool' | 'color' | 'width' | 'points'>,
  rect: AnnotationRect,
) {
  if (!stroke.points.length || rect.width <= 0 || rect.height <= 0) return;
  const lineWidth = stroke.width * Math.min(rect.width, rect.height);
  if (!Number.isFinite(lineWidth) || lineWidth <= 0) return;

  context.save();
  context.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
  context.lineWidth = lineWidth;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.beginPath();
  const first = toCanvasPoint(stroke.points[0], rect);
  if (stroke.points.length === 1) {
    context.arc(first.x, first.y, lineWidth / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.moveTo(first.x, first.y);
    for (let index = 1; index < stroke.points.length; index += 1) {
      const point = toCanvasPoint(stroke.points[index], rect);
      context.lineTo(point.x, point.y);
    }
    context.stroke();
  }
  context.restore();
}

export function toCanvasPoint(point: AnnotationPoint, rect: AnnotationRect) {
  return {
    x: rect.left + point.x * rect.width,
    y: rect.top + point.y * rect.height,
  };
}
