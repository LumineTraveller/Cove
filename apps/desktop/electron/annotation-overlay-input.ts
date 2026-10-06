import type { AnnotationPoint } from '@cove/contracts';

export type AnnotationOverlayInput =
  | { type: 'stroke-start'; tool: 'pen' | 'eraser'; color: string; width: number; point: AnnotationPoint }
  | { type: 'stroke-point'; point: AnnotationPoint }
  | { type: 'stroke-end' | 'clear' | 'exit' }
  | { type: 'laser'; point: AnnotationPoint | null };

const point = (value: unknown): value is AnnotationPoint => Boolean(value && typeof value === 'object' &&
  ['x', 'y'].every(key => { const n = (value as Record<string, unknown>)[key];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1; }));

/** Only this session's native drawing window may submit these bounded commands. */
export function validOverlayInput(value: unknown): value is AnnotationOverlayInput {
  if (!value || typeof value !== 'object') return false;
  const event = value as AnnotationOverlayInput;
  switch (event.type) {
    case 'exit': case 'clear': case 'stroke-end': return true;
    case 'stroke-point': return point(event.point);
    case 'laser': return event.point === null || point(event.point);
    case 'stroke-start': return point(event.point) && (event.tool === 'pen' || event.tool === 'eraser') &&
      typeof event.color === 'string' && /^#[\da-f]{6}$/i.test(event.color) &&
      typeof event.width === 'number' && Number.isFinite(event.width) && event.width >= .0005 && event.width <= .08;
    default: return false;
  }
}
