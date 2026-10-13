import {
  containedVideoRect,
  normalizedScreenPoint,
} from '../src/features/media/annotation/annotationGeometry';
const original = { scale: 1, x: 0, y: 0 };

test('portrait contain bars are excluded and the video edges map exactly', () => {
  const viewport = { width: 400, height: 400 },
    video = { width: 1600, height: 900 };
  expect(containedVideoRect(viewport, video)).toEqual({
    left: 0,
    top: 87.5,
    width: 400,
    height: 225,
  });
  expect(
    normalizedScreenPoint({ x: 200, y: 20 }, viewport, video, original),
  ).toBeNull();
  expect(
    normalizedScreenPoint({ x: 0, y: 87.5 }, viewport, video, original),
  ).toEqual({ x: 0, y: 0 });
  expect(
    normalizedScreenPoint({ x: 400, y: 312.5 }, viewport, video, original),
  ).toEqual({ x: 1, y: 1 });
});
test('landscape contains a phone source with inert side bars', () => {
  const viewport = { width: 900, height: 400 },
    video = { width: 400, height: 800 };
  expect(
    normalizedScreenPoint({ x: 20, y: 200 }, viewport, video, original),
  ).toBeNull();
  expect(
    normalizedScreenPoint({ x: 450, y: 200 }, viewport, video, original),
  ).toEqual({ x: 0.5, y: 0.5 });
});
test('zoom and pan invert to source coordinates used by both drawing and control', () => {
  const viewport = { width: 400, height: 400 },
    video = { width: 800, height: 400 };
  expect(
    normalizedScreenPoint({ x: 100, y: 100 }, viewport, video, {
      scale: 2,
      x: 0,
      y: 0,
    }),
  ).toEqual({ x: 0.375, y: 0.25 });
  expect(
    normalizedScreenPoint({ x: 200, y: 200 }, viewport, video, {
      scale: 2,
      x: 100,
      y: -20,
    }),
  ).toEqual({ x: 0.375, y: 0.55 });
  expect(
    normalizedScreenPoint({ x: -1, y: 100 }, viewport, video, {
      scale: 2,
      x: 0,
      y: 0,
    }),
  ).toBeNull();
});
test('subpixel contain rounding preserves the topmost physical pixel', () => {
  expect(
    normalizedScreenPoint(
      { x: 853, y: 0 },
      { width: 1707, height: 1067 },
      { width: 2560, height: 1600 },
      original,
      1.5,
    )?.y,
  ).toBe(0);
  expect(
    normalizedScreenPoint(
      { x: 100, y: 0 },
      { width: 200, height: 120 },
      { width: 200, height: 100 },
      original,
      1.5,
    ),
  ).toBeNull();
});
test('unknown and invalid video geometry never creates an arbitrary input position', () => {
  expect(
    normalizedScreenPoint(
      { x: 0, y: 0 },
      { width: 100, height: 100 },
      undefined,
      original,
    ),
  ).toBeNull();
  expect(
    containedVideoRect({ width: 0, height: 100 }, { width: 100, height: 100 }),
  ).toBeNull();
  expect(
    normalizedScreenPoint(
      { x: NaN, y: 0 },
      { width: 100, height: 100 },
      { width: 100, height: 100 },
      original,
    ),
  ).toBeNull();
});
