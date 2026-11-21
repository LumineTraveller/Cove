import type { AnnotationStroke } from '@cove/contracts';

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
