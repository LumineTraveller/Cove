import type { AnnotationPoint, AnnotationStroke } from '@cove/contracts';

import type { AnnotationRect } from './annotationGeometry';

/** Merge a later chunk into the stroke, dropping an already received suffix. */
export function mergeAnnotationStroke(
  existing: AnnotationStroke,
  incoming: AnnotationStroke,
): AnnotationStroke {
  if (existing.id !== incoming.id) return incoming;
  return {
    ...existing,
    ...incoming,
    points: appendDistinctPoints(existing.points, incoming.points),
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

function appendDistinctPoints(
  existing: readonly AnnotationPoint[],
  incoming: readonly AnnotationPoint[],
): AnnotationPoint[] {
  if (incoming.length === 0) return [...existing];
  if (containsPoints(existing, incoming)) return [...existing];
  if (containsPoints(incoming, existing)) return [...incoming];
  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (!samePoint(existing[existing.length - overlap + index], incoming[index])) {
        matches = false;
        break;
      }
    }
    if (matches) return [...existing, ...incoming.slice(overlap)];
  }
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (!samePoint(incoming[incoming.length - overlap + index], existing[index])) {
        matches = false;
        break;
      }
    }
    if (matches) return [...incoming.slice(0, incoming.length - overlap), ...existing];
  }
  return [...existing, ...incoming];
}

function containsPoints(haystack: readonly AnnotationPoint[], needle: readonly AnnotationPoint[]) {
  if (needle.length === 0) return true;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matches = true;
    for (let index = 0; index < needle.length; index += 1) {
      if (!samePoint(haystack[start + index], needle[index])) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function samePoint(left: AnnotationPoint, right: AnnotationPoint) {
  return left.x === right.x && left.y === right.y;
}
