import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { PanResponder, Text, TouchableOpacity, View } from 'react-native';
import { ZoomableScreenVideo } from '../src/components/ZoomableScreenVideo';
jest.mock('react-native-webrtc', () => ({ RTCView: 'RTCView' }));

test('two-finger movement zooms, reset restores, and a new stream clears the old zoom', async () => {
  const spy = jest.spyOn(PanResponder, 'create').mockImplementation(config => ({
    panHandlers: { onResponderGrant: config.onPanResponderGrant, onResponderMove: config.onPanResponderMove, onStartShouldSetResponder: config.onStartShouldSetPanResponder },
    getInteractionHandle: () => null,
  }) as any);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<ZoomableScreenVideo streamURL="stream-a" />); });
  const surface = () => renderer.root.findAllByType(View).find(view => view.props.onResponderMove)!;
  const event = (distance: number) => ({ nativeEvent: { touches: [{ locationX: 100 - distance / 2, locationY: 50 }, { locationX: 100 + distance / 2, locationY: 50 }] } });
  await act(async () => surface().props.onLayout({ nativeEvent: { layout: { width: 200, height: 100, x: 0, y: 0 } } }));
  expect(surface().props.onStartShouldSetResponder(event(100))).toBe(true);
  await act(async () => surface().props.onResponderGrant(event(100)));
  await act(async () => surface().props.onResponderMove(event(200)));
  expect(renderer.root.findAllByType(Text).some(text => JSON.stringify(text.props.children).includes('200'))).toBe(true);
  await act(async () => renderer.root.findByType(TouchableOpacity).props.onPress());
  expect(renderer.root.findAllByType(TouchableOpacity)).toHaveLength(0);
  await act(async () => surface().props.onResponderGrant(event(100)));
  await act(async () => surface().props.onResponderMove(event(250)));
  expect(renderer.root.findAllByType(TouchableOpacity)).toHaveLength(1);
  await act(async () => renderer.update(<ZoomableScreenVideo streamURL="stream-b" />));
  expect(renderer.root.findAllByType(TouchableOpacity)).toHaveLength(0);
  await act(async () => renderer.unmount());
  spy.mockRestore();
});
