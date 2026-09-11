import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateHasDetails } from '../electron/update-state';

const now = Date.now();

test('update detail card hides for idle, not-available and disabled states', () => {
  assert.equal(updateHasDetails({ status: 'idle' }, now), false);
  assert.equal(updateHasDetails({ status: 'not-available', version: '1.1.0' }, now), false);
  assert.equal(updateHasDetails({ status: 'disabled', message: '不可用' }, now), false);
});

test('update detail card stays visible through every busy and finished stage', () => {
  assert.equal(updateHasDetails({ status: 'checking' }, now), true);
  assert.equal(updateHasDetails({ status: 'available', version: '1.1.1' }, now), true);
  assert.equal(updateHasDetails({ status: 'downloading', percent: 12, stageStartedAt: now }, now), true);
  assert.equal(updateHasDetails({ status: 'finalizing', percent: 100, stageStartedAt: now }, now), true);
  assert.equal(updateHasDetails({ status: 'downloaded', version: '1.1.1' }, now), true);
  assert.equal(updateHasDetails({ status: 'installing', stageStartedAt: now }, now), true);
});

test('update detail card stays visible for errors and stalled stages', () => {
  assert.equal(updateHasDetails({ status: 'error', failedStage: 'checking' }, now), true);
  assert.equal(updateHasDetails({ status: 'error', errorDetail: 'boom' }, now), true);
  assert.equal(
    updateHasDetails({ status: 'downloading', percent: 40, lastActivityAt: now - 31_000 }, now),
    true,
  );
});
