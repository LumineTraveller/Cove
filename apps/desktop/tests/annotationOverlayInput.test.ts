import test from 'node:test';
import assert from 'node:assert/strict';
import { validOverlayInput } from '../electron/annotation-overlay-input';

test('native overlay input accepts bounded drawing and cleanup messages', () => {
  for (const type of ['stroke-end', 'clear', 'exit']) assert.equal(validOverlayInput({ type }), true);
  assert.equal(validOverlayInput({ type: 'laser', point: null }), true);
  assert.equal(validOverlayInput({ type: 'stroke-point', point: { x: 0, y: 1 } }), true);
  assert.equal(validOverlayInput({ type: 'stroke-start', tool: 'pen', color: '#ab12EF', width: .01, point: { x: .3, y: .7 } }), true);
});

test('native overlay input rejects outside-source points and non-drawing commands', () => {
  for (const point of [{ x: -0.01, y: .5 }, { x: .5, y: 1.01 }, { x: NaN, y: 0 }, { x: Infinity, y: 0 }, null])
    assert.equal(validOverlayInput({ type: 'stroke-point', point }), false);
  for (const change of [{ tool: 'click' }, { color: 'red' }, { width: 10 }, { width: NaN }])
    assert.equal(validOverlayInput({ type: 'stroke-start', tool: 'eraser', color: '#ffffff', width: .01, point: { x: .2, y: .2 }, ...change }), false);
  assert.equal(validOverlayInput({ type: 'remote-input', point: { x: .2, y: .2 } }), false);
  assert.equal(validOverlayInput(null), false);
});
