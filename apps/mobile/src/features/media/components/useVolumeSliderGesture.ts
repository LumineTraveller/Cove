import { useRef } from 'react';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';

/** Own the complete drag, including moves outside the visual rail/row. */
export function useVolumeSliderGesture(
  onChange: (value: number) => void,
  maximum = 1,
) {
  const width = useRef(1);
  const origin = useRef<number | null>(null);
  const change = (event: GestureResponderEvent) => {
    const { pageX, locationX } = event.nativeEvent;
    const x =
      origin.current !== null && Number.isFinite(pageX)
        ? pageX - origin.current
        : locationX;
    if (Number.isFinite(x))
      onChange(Math.max(0, Math.min(maximum, (x / width.current) * maximum)));
  };
  return {
    hitSlop: { top: 16, bottom: 16, left: 8, right: 8 },
    onLayout: (event: LayoutChangeEvent) => {
      width.current = Math.max(1, event.nativeEvent.layout.width);
    },
    onStartShouldSetResponder: () => true,
    onStartShouldSetResponderCapture: () => true,
    onMoveShouldSetResponder: () => true,
    onMoveShouldSetResponderCapture: () => true,
    onResponderGrant: (event: GestureResponderEvent) => {
      const { pageX, locationX } = event.nativeEvent;
      origin.current =
        Number.isFinite(pageX) && Number.isFinite(locationX)
          ? pageX - locationX
          : null;
      change(event);
      // Match PanResponder's default: block the Android native ScrollView from
      // intercepting this drag when the finger drifts vertically.
      return true;
    },
    onResponderMove: change,
    onResponderRelease: () => {
      origin.current = null;
    },
    onResponderTerminate: () => {
      origin.current = null;
    },
    onResponderTerminationRequest: () => false,
  };
}
