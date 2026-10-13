import type { AnnotationPoint, AnnotationStroke } from '@cove/contracts';

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
  const index = strokes.findIndex(stroke => stroke.id === incoming.id);
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
      if (
        !samePoint(existing[existing.length - overlap + index], incoming[index])
      ) {
        matches = false;
        break;
      }
    }
    if (matches) return [...existing, ...incoming.slice(overlap)];
  }
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (
        !samePoint(incoming[incoming.length - overlap + index], existing[index])
      ) {
        matches = false;
        break;
      }
    }
    if (matches)
      return [...incoming.slice(0, incoming.length - overlap), ...existing];
  }
  return [...existing, ...incoming];
}

function containsPoints(
  haystack: readonly AnnotationPoint[],
  needle: readonly AnnotationPoint[],
) {
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
