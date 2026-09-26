import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { View } from 'react-native';

jest.mock('lucide-react-native', () => {
  const React = require('react');
  const icon = (name: string) => () => React.createElement('Icon', { name });
  return new Proxy({}, { get: (_target, prop: string) => icon(prop) });
});
jest.mock('react-native-webrtc', () => ({ RTCView: 'RTCView' }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));
jest.mock('../src/useMobileMedia', () => ({ useMobileMedia: () => ({}) }));
jest.mock('../src/components/ZoomableScreenVideo', () => ({ ZoomableScreenVideo: 'ZoomableScreenVideo' }));
jest.mock('../src/components/ChatPanel', () => ({ ChatPanel: 'ChatPanel' }));
jest.mock('../src/components/Soundboard', () => ({ Soundboard: 'Soundboard' }));

import { InlineVolumeSlider } from '../src/screens/RoomScreen';
import { UserProfileModal } from '../src/components/UserProfileModal';

const touchAt = (locationX: number) => ({ nativeEvent: { locationX, pageX: locationX, locationY: 4 } });

function findTrack(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType(View).find(view => typeof view.props.onResponderMove === 'function' && typeof view.props.onLayout === 'function')!;
}

test('volume slider ignores the thumb hit target so dragging cannot flicker', async () => {
  const changes: number[] = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <InlineVolumeSlider value={0.5} label="音量" onChange={value => changes.push(value)} />,
    );
  });
  const track = findTrack(renderer);
  await act(async () => track.props.onLayout({ nativeEvent: { layout: { width: 200, height: 32, x: 0, y: 0 } } }));

  // Rail/fill/thumb must not become the touch target, or locationX jumps.
  const nonHitChildren = renderer.root.findAllByType(View).filter(view => view.props.pointerEvents === 'none');
  expect(nonHitChildren.length).toBeGreaterThanOrEqual(3);

  await act(async () => track.props.onResponderGrant(touchAt(100)));
  await act(async () => track.props.onResponderMove(touchAt(50)));
  await act(async () => track.props.onResponderMove(touchAt(180)));
  // locationX is always read against the 200px track: 50% → 25% → 90%.
  expect(changes).toEqual([0.5, 0.25, 0.9]);
  await act(async () => renderer.unmount());
});

test('profile volume track keeps children out of the hit target and maps touch onto 0-200%', async () => {
  const changes: number[] = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <UserProfileModal
        visible
        userId="user-1"
        username="alice"
        inVoice
        volume={1}
        onVolumeChange={value => changes.push(value)}
        onSaveRemark={() => {}}
        onClose={() => {}}
      />,
    );
  });
  const track = findTrack(renderer);
  await act(async () => track.props.onLayout({ nativeEvent: { layout: { width: 100, height: 28, x: 0, y: 0 } } }));

  const nonHitChildren = renderer.root.findAllByType(View).filter(view => view.props.pointerEvents === 'none');
  expect(nonHitChildren.length).toBeGreaterThanOrEqual(4);

  await act(async () => track.props.onResponderGrant(touchAt(25)));
  // 25 / 100 * 2 = 0.5
  expect(changes.at(-1)).toBeCloseTo(0.5, 5);

  await act(async () => track.props.onResponderMove(touchAt(200)));
  // Clamped to the 200% ceiling instead of overshooting.
  expect(changes.at(-1)).toBe(2);

  await act(async () => renderer.unmount());
});
