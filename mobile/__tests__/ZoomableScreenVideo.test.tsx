import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { PanResponder, Text, TouchableOpacity, View } from 'react-native';
import { ZoomableScreenVideo } from '../src/components/ZoomableScreenVideo';
jest.mock('react-native-webrtc', () => ({ RTCView: 'RTCView' }));

function createResponderSpy() {
  return jest.spyOn(PanResponder, 'create').mockImplementation(config => ({
    panHandlers: {
      onResponderGrant: config.onPanResponderGrant,
      onResponderMove: config.onPanResponderMove,
      onStartShouldSetResponder: config.onStartShouldSetPanResponder,
      onStartShouldSetResponderCapture: config.onStartShouldSetPanResponderCapture,
      onMoveShouldSetResponder: config.onMoveShouldSetPanResponder,
      onMoveShouldSetResponderCapture: config.onMoveShouldSetPanResponderCapture,
    },
    getInteractionHandle: () => null,
  }) as any);
}

const pinchEvent = (distance: number, usePageCoords = false) => {
  const points = [
    { x: 100 - distance / 2, y: 50 },
    { x: 100 + distance / 2, y: 50 },
  ];
  return {
    nativeEvent: {
      touches: points.map(point => usePageCoords
        ? { pageX: point.x, pageY: point.y, locationX: point.x, locationY: point.y }
        : { locationX: point.x, locationY: point.y }),
    },
  };
};

const surfaceOf = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findAllByType(View).find(view => view.props.onResponderMove)!;

test('two-finger movement zooms, reset restores, and a new stream clears the old zoom', async () => {
  const spy = createResponderSpy();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<ZoomableScreenVideo streamURL="stream-a" />); });
  const surface = () => surfaceOf(renderer);
  await act(async () => surface().props.onLayout({ nativeEvent: { layout: { width: 200, height: 100, x: 0, y: 0 } } }));
  expect(surface().props.onStartShouldSetResponder(pinchEvent(100))).toBe(true);
  await act(async () => surface().props.onResponderGrant(pinchEvent(100)));
  await act(async () => surface().props.onResponderMove(pinchEvent(200)));
  expect(renderer.root.findAllByType(Text).some(text => JSON.stringify(text.props.children).includes('200'))).toBe(true);
  await act(async () => renderer.root.findByType(TouchableOpacity).props.onPress());
  expect(renderer.root.findAllByType(TouchableOpacity)).toHaveLength(0);
  await act(async () => surface().props.onResponderGrant(pinchEvent(100)));
  await act(async () => surface().props.onResponderMove(pinchEvent(250)));
  expect(renderer.root.findAllByType(TouchableOpacity)).toHaveLength(1);
  await act(async () => renderer.update(<ZoomableScreenVideo streamURL="stream-b" />));
  expect(renderer.root.findAllByType(TouchableOpacity)).toHaveLength(0);
  await act(async () => renderer.unmount());
  spy.mockRestore();
});

test('claims the gesture on the first finger so a later pinch is not lost to a parent scroll view', async () => {
  const spy = createResponderSpy();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<ZoomableScreenVideo streamURL="stream-a" />); });
  const surface = () => surfaceOf(renderer);
  await act(async () => surface().props.onLayout({ nativeEvent: { layout: { width: 200, height: 100, x: 0, y: 0 } } }));
  const oneFinger = { nativeEvent: { touches: [{ locationX: 40, locationY: 40 }] } };
  expect(surface().props.onStartShouldSetResponder(oneFinger)).toBe(true);
  expect(surface().props.onStartShouldSetResponderCapture(oneFinger)).toBe(true);
  expect(surface().props.onMoveShouldSetResponderCapture(pinchEvent(120))).toBe(true);
  await act(async () => renderer.unmount());
  spy.mockRestore();
});

test('incidental layout changes keep the current zoom instead of snapping back to 100%', async () => {
  const spy = createResponderSpy();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<ZoomableScreenVideo streamURL="stream-a" />); });
  const surface = () => surfaceOf(renderer);
  await act(async () => surface().props.onLayout({ nativeEvent: { layout: { width: 200, height: 100, x: 0, y: 0 } } }));
  await act(async () => surface().props.onResponderGrant(pinchEvent(100)));
  await act(async () => surface().props.onResponderMove(pinchEvent(200)));
  expect(renderer.root.findAllByType(Text).some(text => JSON.stringify(text.props.children).includes('200'))).toBe(true);
  // Same size, different origin — status-bar hide / parent reflow.
  await act(async () => surface().props.onLayout({ nativeEvent: { layout: { width: 200, height: 100, x: 0, y: 24 } } }));
  expect(renderer.root.findAllByType(Text).some(text => JSON.stringify(text.props.children).includes('200'))).toBe(true);
  await act(async () => renderer.unmount());
  spy.mockRestore();
});

test('page-space touch coordinates drive pinch zoom', async () => {
  const spy = createResponderSpy();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<ZoomableScreenVideo streamURL="stream-a" />); });
  const surface = () => surfaceOf(renderer);
  await act(async () => surface().props.onLayout({ nativeEvent: { layout: { width: 200, height: 100, x: 0, y: 0 } } }));
  await act(async () => surface().props.onResponderGrant(pinchEvent(80, true)));
  await act(async () => surface().props.onResponderMove(pinchEvent(160, true)));
  expect(renderer.root.findAllByType(Text).some(text => JSON.stringify(text.props.children).includes('200'))).toBe(true);
  await act(async () => renderer.unmount());
  spy.mockRestore();
});
