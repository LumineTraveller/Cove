import { useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, Text, TouchableOpacity, View, type GestureResponderEvent } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { clampZoom, ORIGINAL_ZOOM, pinchZoom, type Point, type Size, type ZoomTransform } from '../screenZoom';

function touches(event: GestureResponderEvent): Point[] {
  return event.nativeEvent.touches.slice(0, 2).map(touch => ({ x: touch.locationX, y: touch.locationY }));
}
const midpoint = (points: Point[]) => points.length > 1
  ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } : points[0];
const distance = (points: Point[]) => points.length > 1 ? Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) : 0;

export function ZoomableScreenVideo({ streamURL }: { streamURL: string }) {
  const viewport = useRef<Size>({ width: 1, height: 1 });
  const video = useRef<Size | undefined>(undefined);
  const transform = useRef<ZoomTransform>({ ...ORIGINAL_ZOOM });
  const gesture = useRef<{ count: number; middle: Point; distance: number; start: ZoomTransform } | null>(null);
  const animated = useRef({ scale: new Animated.Value(1), x: new Animated.Value(0), y: new Animated.Value(0) }).current;
  const [percent, setPercent] = useState(100);
  const apply = (next: ZoomTransform) => {
    transform.current = next;
    animated.scale.setValue(next.scale); animated.x.setValue(next.x); animated.y.setValue(next.y);
    setPercent(Math.round(next.scale * 100));
  };
  const reset = () => { gesture.current = null; apply({ ...ORIGINAL_ZOOM }); };
  const begin = (points: Point[]) => {
    gesture.current = points.length ? { count: points.length, middle: midpoint(points), distance: distance(points), start: { ...transform.current } } : null;
  };
  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: event => event.nativeEvent.touches.length >= 2 || transform.current.scale > 1,
    onMoveShouldSetPanResponderCapture: event => event.nativeEvent.touches.length >= 2 || transform.current.scale > 1,
    onPanResponderGrant: event => begin(touches(event)),
    onPanResponderMove: event => {
      const points = touches(event);
      const initial = gesture.current;
      if (!points.length) return;
      if (!initial || initial.count !== points.length) { begin(points); return; }
      const middle = midpoint(points);
      const next = points.length === 2 && initial.distance > 1
        ? pinchZoom(initial.start, initial.middle, middle, distance(points) / initial.distance, viewport.current, video.current)
        : clampZoom({ ...initial.start, x: initial.start.x + middle.x - initial.middle.x, y: initial.start.y + middle.y - initial.middle.y }, viewport.current, video.current);
      apply(next);
    },
    onPanResponderRelease: () => { gesture.current = null; },
    onPanResponderTerminate: () => { gesture.current = null; },
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
  })).current;

  useEffect(() => { video.current = undefined; reset(); }, [streamURL]); // eslint-disable-line react-hooks/exhaustive-deps

  return <View style={styles.viewport}>
    <View style={StyleSheet.absoluteFill} {...responder.panHandlers}
      onLayout={event => { viewport.current = event.nativeEvent.layout; reset(); }}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { transform: [{ translateX: animated.x }, { translateY: animated.y }, { scale: animated.scale }] }]}>
        <RTCView streamURL={streamURL} objectFit="contain" mirror={false} style={StyleSheet.absoluteFill}
          onDimensionsChange={event => {
            const { width, height } = event.nativeEvent;
            if (width > 0 && height > 0) { video.current = { width, height }; apply(clampZoom(transform.current, viewport.current, video.current)); }
          }} />
      </Animated.View>
    </View>
    <View pointerEvents="box-none" style={styles.zoomControls}>
      {percent > 100
        ? <TouchableOpacity onPress={reset} style={styles.reset} accessibilityLabel="还原共享画面缩放"><Text style={styles.hint}>{percent}% · 还原</Text></TouchableOpacity>
        : <Text pointerEvents="none" style={styles.hint}>双指缩放</Text>}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  viewport: { flex: 1, width: '100%', height: '100%', overflow: 'hidden', backgroundColor: '#000' },
  zoomControls: { position: 'absolute', bottom: 10, left: 10 },
  reset: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.65)' },
  hint: { color: 'rgba(255,255,255,0.7)', fontSize: 11 },
});
