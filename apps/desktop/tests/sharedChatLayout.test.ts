import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedChatNeedsDrawer, MIN_DOCKED_SHARE_WIDTH } from '../src/features/rooms/sharedChatLayout';

test('opening the rail above the old viewport breakpoint switches shared chat to a drawer', () => {
  assert.equal(sharedChatNeedsDrawer(1040, 72, 270), false);
  assert.equal(sharedChatNeedsDrawer(1040, 280, 270), true);
});
test('presentation depends on actual room and chat widths, not whether chat is already open', () => {
  assert.equal(sharedChatNeedsDrawer(1440, 280, 288), false);
  assert.equal(sharedChatNeedsDrawer(900, 72, 270), true);
  assert.equal(sharedChatNeedsDrawer(1000, 72, 270), false);
  assert.equal(sharedChatNeedsDrawer(1000, 280, 270), true);
});
test('the exact remaining-width boundary has a stable inclusive docked endpoint', () => {
  const width = MIN_DOCKED_SHARE_WIDTH + 280 + 270;
  assert.equal(sharedChatNeedsDrawer(width - 1, 280, 270), true);
  for (let i = 0; i < 10; i++) assert.equal(sharedChatNeedsDrawer(width, 280, 270), false);
  assert.equal(sharedChatNeedsDrawer(width + 1, 280, 270), false);
});
