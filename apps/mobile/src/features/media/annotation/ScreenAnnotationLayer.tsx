import { useId, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Circle, Defs, G, Mask, Path, Rect } from 'react-native-svg';
import type { AnnotationPoint, AnnotationStroke } from '@cove/contracts';
import type { Size } from '../screen/screenZoom';
import { containedVideoRect, type VideoRect } from './annotationGeometry';

function strokeShape(
  stroke: AnnotationStroke,
  rect: VideoRect,
  color: string,
  key: string,
) {
  if (!stroke.points.length) return null;
  const width = stroke.width * Math.min(rect.width, rect.height);
  const points = stroke.points.map(point => ({
    x: rect.left + point.x * rect.width,
    y: rect.top + point.y * rect.height,
  }));
  if (points.length === 1)
    return (
      <Circle
        key={key}
        cx={points[0].x}
        cy={points[0].y}
        r={width / 2}
        fill={color}
      />
    );
  return (
    <Path
      key={key}
      d={points
        .map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`)
        .join(' ')}
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  );
}

/** Ordered masks erase earlier ink; strokes painted afterwards stay visible. */
export function ScreenAnnotationLayer({
  viewport,
  video,
  strokes,
  lasers = {},
}: {
  viewport: Size;
  video?: Size;
  strokes: readonly AnnotationStroke[];
  lasers?: Record<string, AnnotationPoint>;
}) {
  const prefix = useId().replace(/[^A-Za-z0-9]/g, '');
  const rect = containedVideoRect(viewport, video);
  if (!rect) return null;
  const masks: ReactNode[] = [];
  let ink: ReactNode[] = [];
  strokes.forEach((stroke, index) => {
    if (stroke.tool === 'eraser') {
      const id = `erase${prefix}${index}`;
      masks.push(
        <Mask
          key={id}
          id={id}
          maskUnits="userSpaceOnUse"
          x={0}
          y={0}
          width={viewport.width}
          height={viewport.height}
        >
          <Rect
            x={0}
            y={0}
            width={viewport.width}
            height={viewport.height}
            fill="white"
          />
          {strokeShape(stroke, rect, 'black', id)}
        </Mask>,
      );
      ink = [
        <G key={id} mask={`url(#${id})`}>
          {ink}
        </G>,
      ];
    } else ink.push(strokeShape(stroke, rect, stroke.color, `ink${index}`));
  });
  return (
    <Svg
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      width={viewport.width}
      height={viewport.height}
      viewBox={`0 0 ${viewport.width} ${viewport.height}`}
    >
      <Defs>{masks}</Defs>
      {ink}
      {Object.entries(lasers).map(([id, point]) => (
        <Circle
          key={id}
          cx={rect.left + point.x * rect.width}
          cy={rect.top + point.y * rect.height}
          r={5}
          fill="#EF4444"
          stroke="white"
          strokeWidth={1.5}
        />
      ))}
    </Svg>
  );
}
