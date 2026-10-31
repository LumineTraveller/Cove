import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameIntervalWindow } from '../src/features/media/diagnostics/frameIntervals';
import { FRAME_STABILITY_DEFINITION, frameStabilityLabel, frameStabilityDetail } from '../src/features/media/diagnostics/frameStabilityView';

test('one percent low labels distinguish absent, insufficient, complete and stale observations', () => {
  const window = createFrameIntervalWindow();
  assert.equal(frameStabilityLabel(null), '—');
  window.observe(0, 0);
  assert.equal(frameStabilityLabel(window.snapshot(0)), '采样中');
  for (let frame = 1; frame <= 120; frame++) window.observe(frame * 1_000 / 120, frame * 1_000 / 120);
  assert.equal(frameStabilityLabel(window.snapshot(1_000)), '120.0 fps');
  assert.equal(frameStabilityLabel(window.snapshot(2_001)), '暂无新帧');
});

test('incomplete frame coverage never displays an estimated low FPS', () => {
  const window = createFrameIntervalWindow();
  for (let frame = 0; frame <= 120; frame++)
    window.observe(frame * 10, frame * 10, frame === 60 ? 2 : 0);
  const snapshot = window.snapshot(1_200);
  assert.equal(frameStabilityLabel(snapshot), '采样不完整');
  assert.match(frameStabilityDetail(snapshot), /120个间隔，漏采2帧/);
  assert.doesNotMatch(frameStabilityLabel(snapshot), /fps/);
});

test('export definitions distinguish delivery and composition without changing other timing definitions', () => {
  assert.equal(FRAME_STABILITY_DEFINITION.windowMs, 30_000);
  assert.equal(FRAME_STABILITY_DEFINITION.minimumIntervals, 100);
  assert.equal(Object.isFrozen(FRAME_STABILITY_DEFINITION), true);
  assert.match(FRAME_STABILITY_DEFINITION.formula, /mean\(slowest ceil/);
  assert.match(FRAME_STABILITY_DEFINITION.presentation, /not physical display/);
  assert.match(FRAME_STABILITY_DEFINITION.nativeDelivery, /not raw DXGI/);
});
