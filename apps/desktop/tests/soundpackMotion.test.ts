import assert from 'node:assert/strict';
import { test } from 'node:test';
import { animateSoundpackLayout, soundpackOverlayTransform } from '../src/features/soundpacks/useSoundpackGroups';

function elementAt(left: number, top: number) {
  const calls: { keyframes: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
  const animation = { cancel() {} } as Animation;
  const element = {
    getBoundingClientRect: () => ({ left, top }),
    animate: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      calls.push({ keyframes, options });
      return animation;
    },
  } as unknown as HTMLElement;
  return { element, calls, animation };
}

test('same-group and cross-group layout changes animate every displaced surviving card', () => {
  const first = elementAt(110, 0);
  const second = elementAt(0, 200);
  const stationary = elementAt(220, 0);
  const added = elementAt(0, 300);
  const before = new Map([
    ['first', { left: 0, top: 0 }],
    ['second', { left: 110, top: 0 }],
    ['stationary', { left: 220, top: 0 }],
    ['removed', { left: 0, top: 100 }],
  ]);
  const animations = animateSoundpackLayout(before, new Map([
    ['first', first.element], ['second', second.element], ['stationary', stationary.element], ['added', added.element],
  ]), false);
  assert.equal(animations.size, 2);
  assert.equal(animations.get(first.element), first.animation);
  assert.deepEqual(first.calls[0].keyframes, [{ transform: 'translate3d(-110px, 0px, 0)' }, { transform: 'translate3d(0, 0, 0)' }]);
  assert.deepEqual(second.calls[0].keyframes, [{ transform: 'translate3d(110px, -200px, 0)' }, { transform: 'translate3d(0, 0, 0)' }]);
  assert.equal(first.calls[0].options.duration, 480);
  assert.equal(stationary.calls.length, 0);
  assert.equal(added.calls.length, 0);
});

test('group swaps animate the whole group once and reduced motion skips animation', () => {
  const first = elementAt(0, 200);
  const second = elementAt(0, 0);
  const before = new Map([['first', { left: 0, top: 0 }], ['second', { left: 0, top: 200 }]]);
  const elements = new Map([['first', first.element], ['second', second.element]]);
  assert.equal(animateSoundpackLayout(before, elements, true).size, 0);
  assert.equal(first.calls.length + second.calls.length, 0);
  assert.equal(animateSoundpackLayout(before, elements, false).size, 2);
  assert.equal(first.calls.length + second.calls.length, 2);
  assert.deepEqual(first.calls[0].keyframes[0], { transform: 'translate3d(0px, -200px, 0)' });
  assert.deepEqual(second.calls[0].keyframes[0], { transform: 'translate3d(0px, 200px, 0)' });
});

test('interrupted transitions continue from their captured visible positions', () => {
  const card = elementAt(220, 100);
  animateSoundpackLayout(new Map([['card', { left: 85.5, top: 30 }]]), new Map([['card', card.element]]), false);
  assert.deepEqual(card.calls[0].keyframes[0], { transform: 'translate3d(-134.5px, -70px, 0)' });
  const unchanged = elementAt(220.2, 100.1);
  assert.equal(animateSoundpackLayout(new Map([['card', { left: 220, top: 100 }]]), new Map([['card', unchanged.element]]), false).size, 0);
});

test('pointer following preserves grab offset and changes both axes without changing hit geometry', () => {
  const rect = { left: 100, top: 200 };
  const offset = { x: 20, y: 10 };
  assert.equal(soundpackOverlayTransform(rect, { x: 120, y: 210 }, offset), 'translate3d(0px, 0px, 0)');
  assert.equal(soundpackOverlayTransform(rect, { x: 240, y: 350 }, offset), 'translate3d(120px, 140px, 0)');
  assert.equal(soundpackOverlayTransform(rect, { x: 10, y: 50 }, offset), 'translate3d(-110px, -160px, 0)');
  assert.deepEqual(rect, { left: 100, top: 200 });
});
