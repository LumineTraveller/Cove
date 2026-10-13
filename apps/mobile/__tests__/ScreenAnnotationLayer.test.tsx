import TestRenderer, { act } from 'react-test-renderer';
import type { AnnotationStroke } from '@cove/contracts';
import { ScreenAnnotationLayer } from '../src/features/media/annotation/ScreenAnnotationLayer';
jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: 'Svg',
  Circle: 'Circle',
  Defs: 'Defs',
  G: 'G',
  Mask: 'Mask',
  Path: 'Path',
  Rect: 'Rect',
}));
const stroke = (
  id: string,
  tool: 'pen' | 'eraser',
  x: number,
): AnnotationStroke => ({
  id,
  tool,
  authorSocketId: 'peer',
  color: '#FF0000',
  width: 0.01,
  points: [{ x, y: 0.5 }],
});

test('eraser masks earlier ink while later pen strokes remain outside that mask', async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ScreenAnnotationLayer
        viewport={{ width: 400, height: 400 }}
        video={{ width: 800, height: 400 }}
        strokes={[
          stroke('first', 'pen', 0.2),
          stroke('erase', 'eraser', 0.2),
          stroke('later', 'pen', 0.2),
        ]}
      />,
    );
  });
  const svg = renderer.root.findByType('Svg' as any);
  expect(renderer.root.findAllByType('Mask' as any)).toHaveLength(1);
  const group = renderer.root.findByType('G' as any);
  expect(group.findByType('Circle' as any).props.cx).toBe(80);
  const later = svg.children.filter(
    child => typeof child !== 'string' && child.type === ('Circle' as any),
  );
  expect(later).toHaveLength(1);
  expect((later[0] as TestRenderer.ReactTestInstance).props.cy).toBe(200);
  expect((later[0] as TestRenderer.ReactTestInstance).props.r).toBe(1);
  await act(async () => renderer.unmount());
});
test('laser markers map into the same contain rectangle and never capture touches', async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ScreenAnnotationLayer
        viewport={{ width: 400, height: 400 }}
        video={{ width: 800, height: 400 }}
        strokes={[]}
        lasers={{ peer: { x: 1, y: 0 } }}
      />,
    );
  });
  expect(renderer.root.findByType('Svg' as any).props.pointerEvents).toBe(
    'none',
  );
  expect(renderer.root.findByType('Circle' as any).props).toMatchObject({
    cx: 400,
    cy: 100,
  });
  await act(async () => renderer.unmount());
});
test('unknown source dimensions do not display a misleading annotation position', async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ScreenAnnotationLayer
        viewport={{ width: 400, height: 400 }}
        strokes={[stroke('first', 'pen', 0.2)]}
      />,
    );
  });
  expect(renderer.toJSON()).toBeNull();
  await act(async () => renderer.unmount());
});
