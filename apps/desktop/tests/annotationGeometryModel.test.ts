import assert from 'node:assert/strict';
import test from 'node:test';

import type { AnnotationStroke } from '@cove/contracts';

import {
  clampRectToBounds,
  getContainedVideoRect,
  mapClientPointToAnnotationPoint,
  placeRectNearAnchor,
} from '../src/features/media/annotation/annotationGeometry';
import {
  mergeAnnotationStroke,
  preferNewerAnnotationState,
  renderAnnotationStrokes,
  upsertAnnotationStroke,
} from '../src/features/media/annotation/annotationModel';

test('video mapping ignores letterboxes and normalizes points within the visible video', () => {
  const video = getContainedVideoRect({ left: 0, top: 0, width: 400, height: 400 }, 16, 9);
  assert.deepEqual(video, { left: 0, top: 87.5, width: 400, height: 225 });
  assert.equal(mapClientPointToAnnotationPoint(200, 80, video!), null);
  assert.deepEqual(mapClientPointToAnnotationPoint(200, 200, video!), { x: 0.5, y: 0.5 });
  assert.deepEqual(mapClientPointToAnnotationPoint(400, 312.5, video!), { x: 1, y: 1 });
  assert.equal(getContainedVideoRect({ left: 0, top: 0, width: 0, height: 20 }, 16, 9), null);
});

test('floating controls are kept inside resized display bounds and placed around their anchor', () => {
  const bounds = { left: 20, top: 30, width: 320, height: 180 };
  assert.deepEqual(
    clampRectToBounds({ left: 310, top: 205, width: 60, height: 60 }, bounds),
    { left: 280, top: 150, width: 60, height: 60 },
  );
  const placement = placeRectNearAnchor(
    { left: 160, top: 180, width: 44, height: 44 },
    { width: 52, height: 176 },
    bounds,
  );
  assert.equal(placement.side, 'top');
  assert.ok(placement.rect.left >= bounds.left);
  assert.ok(placement.rect.top >= bounds.top);
  assert.ok(placement.rect.left + placement.rect.width <= bounds.left + bounds.width);
  assert.ok(placement.rect.top + placement.rect.height <= bounds.top + bounds.height);
});

test('stroke chunks merge monotonically and duplicate/late acknowledgements do not duplicate points', () => {
  const p0 = { x: 0.1, y: 0.1 };
  const p1 = { x: 0.2, y: 0.2 };
  const p2 = { x: 0.3, y: 0.3 };
  const p3 = { x: 0.4, y: 0.4 };
  const base = stroke('stroke-1', [p0, p1]);
  const extended = mergeAnnotationStroke(base, stroke('stroke-1', [p1, p2, p3]));
  assert.deepEqual(extended.points, [p0, p1, p2, p3]);
  assert.deepEqual(mergeAnnotationStroke(extended, stroke('stroke-1', [p0, p1])).points, [p0, p1, p2, p3]);
  assert.deepEqual(mergeAnnotationStroke(extended, stroke('stroke-1', [p2, p3])).points, [p0, p1, p2, p3]);
  assert.equal(upsertAnnotationStroke([extended], stroke('stroke-1', [p1, p2, p3])).length, 1);

  const newest = { revision: 8, marker: 'new' };
  const lateAck = { revision: 7, marker: 'late' };
  assert.equal(preferNewerAnnotationState(newest, lateAck), newest);
});

test('eraser is replayed in server order with destination-out composition', () => {
  const operations: string[] = [];
  let composite: GlobalCompositeOperation = 'source-over';
  const context = {
    save() {},
    restore() {},
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() { operations.push(composite); },
    arc() {},
    fill() { operations.push(composite); },
    set globalCompositeOperation(value: GlobalCompositeOperation) { composite = value; },
    set lineWidth(_value: number) {},
    set lineCap(_value: CanvasLineCap) {},
    set lineJoin(_value: CanvasLineJoin) {},
    set strokeStyle(_value: string | CanvasGradient | CanvasPattern) {},
    set fillStyle(_value: string | CanvasGradient | CanvasPattern) {},
  } as unknown as CanvasRenderingContext2D;
  renderAnnotationStrokes(
    context,
    [
      stroke('first', [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }]),
      stroke('erase', [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }], 'eraser'),
      stroke('last', [{ x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 }]),
    ],
    { left: 0, top: 0, width: 100, height: 100 },
  );
  assert.deepEqual(operations, ['source-over', 'destination-out', 'source-over']);
});

function stroke(
  id: string,
  points: AnnotationStroke['points'],
  tool: AnnotationStroke['tool'] = 'pen',
): AnnotationStroke {
  return {
    id,
    authorSocketId: 'author-1',
    tool,
    color: '#FF0000',
    width: 0.01,
    points,
  };
}
