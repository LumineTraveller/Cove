import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedVideoPoint, remoteMouseButton } from '../src/remoteControl';

test('remote pointer excludes top and bottom letterbox bars', () => {
  const rect = { left: 0, top: 0, width: 1000, height: 1000 };
  assert.equal(normalizedVideoPoint(500, 50, rect, 1920, 1080), null);
  const center = normalizedVideoPoint(500, 500, rect, 1920, 1080);
  assert.ok(center);
  assert.equal(center.x, 0.5);
  assert.equal(center.y, 0.5);
});

test('remote pointer maps exact video edges', () => {
  const rect = { left: 10, top: 20, width: 1600, height: 900 };
  assert.deepEqual(normalizedVideoPoint(10, 20, rect, 1920, 1080), { x: 0, y: 0 });
  assert.deepEqual(normalizedVideoPoint(1610, 920, rect, 1920, 1080), { x: 1, y: 1 });
  assert.equal(normalizedVideoPoint(500, 500, rect, 0, 1080), null);
});

test('browser mouse buttons map only supported controls', () => {
  assert.equal(remoteMouseButton(0), 'left');
  assert.equal(remoteMouseButton(1), 'middle');
  assert.equal(remoteMouseButton(2), 'right');
  assert.equal(remoteMouseButton(4), null);
});
