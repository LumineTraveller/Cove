import assert from 'node:assert/strict';
import test from 'node:test';
import { annotationStrokeWidth, eraserCursor } from '../src/features/media/annotation/annotationCursor';

const svg = (cursor: string) => decodeURIComponent(cursor.match(/data:image\/svg\+xml,([^\"]+)/)![1]);
test('cursor follows the same width and small-video clamp as transmitted strokes', () => {
  assert.equal(annotationStrokeWidth(24, 600) * 600, 24);
  assert.equal(annotationStrokeWidth(24, 100) * 100, 8);
  assert.equal(annotationStrokeWidth(1, 600), 1 / 600);
});
test('eraser uses a centered transparent white circle with a contrast outline', () => {
  const cursor = eraserCursor(24), image = svg(cursor);
  assert.match(cursor, /\) 15 15, crosshair$/);
  assert.match(image, /width="30" height="30"/);
  assert.match(image, /fill="none" stroke="#fff"/);
  assert.match(image, /stroke="#000" stroke-opacity=".65"/);
  assert.match(image, /r="11.25"/); // 2r + 1.5px outline = actual 24px diameter.
});
test('cursor size updates with the selected eraser width', () => {
  assert.notEqual(eraserCursor(8), eraserCursor(36));
  assert.match(svg(eraserCursor(36)), /r="17.25"/);
});
test('small and invalid cursor sizes stay finite and below native cursor limits', () => {
  for (const size of [1, 8.4, NaN, Infinity, -1, 1000]) {
    const cursor = eraserCursor(size);
    assert.doesNotMatch(cursor, /NaN|Infinity/);
    const image = svg(cursor), width = Number(image.match(/width="([^\"]+)"/)![1]);
    assert.ok(width <= 46 && width >= 7);
    assert.ok(Number(image.match(/r="([^\"]+)"/)![1]) > 0);
  }
});
