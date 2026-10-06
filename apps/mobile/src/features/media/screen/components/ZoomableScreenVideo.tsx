import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { RTCView } from 'react-native-webrtc';
import {
  clampZoom,
  ORIGINAL_ZOOM,
  pinchZoom,
  type Point,
  type Size,
  type ZoomTransform,
} from '../screenZoom';

// Secondary pointers often report unreliable locationX/locationY on Android.
// Distance and pan deltas are translation-invariant in page space; the pinch
// focal point is converted back to view space with a measured origin.
function touches(event: GestureResponderEvent): Point[] {
  return event.nativeEvent.touches.slice(0, 2).map(touch => ({
    x: typeof touch.pageX === 'number' ? touch.pageX : touch.locationX,
    y: typeof touch.pageY === 'number' ? touch.pageY : touch.locationY,
  }));
}
const midpoint = (points: Point[]) =>
  points.length > 1
    ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }
    : points[0];
const distance = (points: Point[]) =>
  points.length > 1
    ? Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)
    : 0;

export function ZoomableScreenVideo({ streamURL }: { streamURL: string }) {
  const surfaceRef = useRef<View>(null);
  const viewport = useRef<Size>({ width: 1, height: 1 });
  const origin = useRef<Point>({ x: 0, y: 0 });
  const video = useRef<Size | undefined>(undefined);
  const transform = useRef<ZoomTransform>({ ...ORIGINAL_ZOOM });
  const gesture = useRef<{
    count: number;
    middle: Point;
    distance: number;
    start: ZoomTransform;
  } | null>(null);
  const animated = useRef({
    scale: new Animated.Value(1),
    x: new Animated.Value(0),
    y: new Animated.Value(0),
  }).current;
  const [percent, setPercent] = useState(100);
  const apply = (next: ZoomTransform) => {
    transform.current = next;
    animated.scale.setValue(next.scale);
    animated.x.setValue(next.x);
    animated.y.setValue(next.y);
    setPercent(Math.round(next.scale * 100));
  };
  const reset = () => {
    gesture.current = null;
    apply({ ...ORIGINAL_ZOOM });
  };
  const syncOrigin = () => {
    surfaceRef.current?.measureInWindow((x, y) => {
      origin.current = { x, y };
    });
  };
  const localPoint = (point: Point): Point => ({
    x: point.x - origin.current.x,
    y: point.y - origin.current.y,
  });
  const begin = (points: Point[]) => {
    gesture.current = points.length
      ? {
          count: points.length,
          middle: midpoint(points),
          distance: distance(points),
          start: { ...transform.current },
        }
      : null;
  };

  const responder = useRef(
    PanResponder.create({
      // Claim the first finger immediately. Waiting for touches.length >= 2 fails
      // on Android: the second pointer-down often never re-enters
      // onStartShouldSet* once a parent ScrollView owns the gesture.
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderGrant: event => {
        syncOrigin();
        begin(touches(event));
      },
      onPanResponderMove: event => {
        const points = touches(event);
        const initial = gesture.current;
        if (!points.length) return;
        // Finger count changes (1↔2) re-baseline instead of applying a stale pinch.
        if (!initial || initial.count !== points.length) {
          begin(points);
          return;
        }
        const middle = midpoint(points);
        const next =
          points.length === 2 && initial.distance > 1
            ? pinchZoom(
                initial.start,
                localPoint(initial.middle),
                localPoint(middle),
                distance(points) / initial.distance,
                viewport.current,
                video.current,
              )
            : clampZoom(
                {
                  ...initial.start,
                  x: initial.start.x + middle.x - initial.middle.x,
                  y: initial.start.y + middle.y - initial.middle.y,
                },
                viewport.current,
                video.current,
              );
        apply(next);
      },
      onPanResponderRelease: () => {
        gesture.current = null;
      },
      onPanResponderTerminate: () => {
        gesture.current = null;
      },
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
    }),
  ).current;

  useEffect(() => {
    video.current = undefined;
    reset();
  }, [streamURL]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={styles.viewport}>
      <View
        ref={surfaceRef}
        collapsable={false}
        style={StyleSheet.absoluteFill}
        {...responder.panHandlers}
        onLayout={event => {
          const { width, height } = event.nativeEvent.layout;
          const sizeChanged =
            viewport.current.width !== width ||
            viewport.current.height !== height;
          viewport.current = { width, height };
          syncOrigin();
          // Layout can fire for status-bar/rotation/parent reflow. Only re-clamp
          // when the surface actually resized — never wipe the user's zoom.
          if (sizeChanged)
            apply(
              clampZoom(transform.current, viewport.current, video.current),
            );
        }}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              transform: [
                { translateX: animated.x },
                { translateY: animated.y },
                { scale: animated.scale },
              ],
            },
          ]}
        >
          <RTCView
            streamURL={streamURL}
            objectFit="contain"
            mirror={false}
            style={StyleSheet.absoluteFill}
            onDimensionsChange={event => {
              const { width, height } = event.nativeEvent;
              if (width > 0 && height > 0) {
                video.current = { width, height };
                apply(
                  clampZoom(transform.current, viewport.current, video.current),
                );
              }
            }}
          />
        </Animated.View>
      </View>
      <View pointerEvents="box-none" style={styles.zoomControls}>
        {percent > 100 ? (
          <TouchableOpacity
            onPress={reset}
            style={styles.reset}
            accessibilityLabel="还原共享画面缩放"
          >
            <Text style={styles.hint}>{percent}% · 还原</Text>
          </TouchableOpacity>
        ) : (
          <Text pointerEvents="none" style={styles.hint}>
            双指缩放
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: {
    flex: 1,
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  zoomControls: { position: 'absolute', bottom: 10, left: 10 },
  reset: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  hint: { color: 'rgba(255,255,255,0.7)', fontSize: 11 },
});
