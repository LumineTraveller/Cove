import { clampZoom, ORIGINAL_ZOOM, pinchZoom } from '../src/screenZoom';

const viewport = { width: 200, height: 100 };
test('pinch keeps the content under an off-center focal point', () => {
  expect(pinchZoom(ORIGINAL_ZOOM, { x: 150, y: 50 }, { x: 150, y: 50 }, 2, viewport)).toEqual({ scale: 2, x: -50, y: 0 });
});
test('a moving pinch can zoom and pan together', () => {
  expect(pinchZoom(ORIGINAL_ZOOM, { x: 100, y: 50 }, { x: 130, y: 65 }, 2, viewport)).toEqual({ scale: 2, x: 30, y: 15 });
});
test('zoom stays within 1-4x, panning is bounded, and reducing to 1x recenters', () => {
  expect(clampZoom({ scale: 2, x: 999, y: -999 }, viewport)).toEqual({ scale: 2, x: 100, y: -50 });
  expect(clampZoom({ scale: 0.5, x: 10, y: -10 }, viewport)).toEqual(ORIGINAL_ZOOM);
  expect(clampZoom({ scale: 8, x: 0, y: 0 }, viewport).scale).toBe(4);
});
test('letterboxed video does not pan into empty space', () => {
  expect(clampZoom({ scale: 2, x: 999, y: 999 }, viewport, { width: 100, height: 100 })).toEqual({ scale: 2, x: 0, y: 50 });
});
