import TestRenderer, { act } from 'react-test-renderer';
import type { AnnotationState, AnnotationStrokeEvent } from '@cove/contracts';
import {
  useScreenAnnotations,
  type UseScreenAnnotationsOptions,
} from '../src/features/media/annotation/useScreenAnnotations';
import { upsertAnnotationStroke } from '../src/features/media/annotation/annotationModel';

let result: ReturnType<typeof useScreenAnnotations>,
  renderer: TestRenderer.ReactTestRenderer;
let handlers: Map<string, (...args: any[]) => void>,
  socket: any,
  server: AnnotationState,
  held: ((ack: any) => void)[],
  holdGet: boolean;
const snapshot = (
  overrides: Partial<AnnotationState> = {},
): AnnotationState => ({
  roomId: 'room',
  sharerSocketId: 'desktop',
  sessionId: 'screen1',
  revision: 1,
  enabled: true,
  permission: 'everyone',
  remoteControlAllowed: true,
  strokes: [],
  grants: [],
  requests: [],
  ...overrides,
});
function Harness(props: Partial<UseScreenAnnotationsOptions>) {
  result = useScreenAnnotations({
    socket,
    roomId: 'room',
    sharerSocketId: 'desktop',
    sessionId: 'screen1',
    self: false,
    active: true,
    ...props,
  });
  return null;
}
beforeEach(async () => {
  jest.useFakeTimers();
  handlers = new Map();
  server = snapshot();
  held = [];
  holdGet = false;
  socket = {
    id: 'viewer',
    connected: true,
    on: jest.fn((event, fn) => handlers.set(event, fn)),
    off: jest.fn(event => handlers.delete(event)),
    emit: jest.fn((event, payload, ack) => {
      if (event === 'annotation:get') {
        if (holdGet) held.push(ack);
        else ack({ ok: true, state: server });
      } else if (event === 'annotation:draw') {
        const stroke = { ...payload.stroke, authorSocketId: socket.id };
        server = {
          ...server,
          revision: server.revision + 1,
          strokes: upsertAnnotationStroke(server.strokes, stroke),
        };
        handlers.get('annotation:stroke')?.({
          sessionId: server.sessionId,
          revision: server.revision,
          stroke,
        });
        ack?.({ ok: true, revision: server.revision });
      } else if (event === 'annotation:configure') {
        server = {
          ...server,
          revision: server.revision + 1,
          ...payload,
          target: undefined,
        };
        ack?.({ ok: true, state: server });
      } else ack?.({ ok: true, state: server });
    }),
  };
  socket.volatile = { emit: socket.emit };
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  jest.useRealTimers();
});

test('everyone viewers draw directly without a permission request', async () => {
  await act(async () => {
    await result.start();
  });
  expect(result.canDraw).toBe(true);
  await act(async () => {
    result.sendStroke(
      'pen',
      '#FF0000',
      0.006,
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      'mobile-stroke',
      true,
    );
  });
  expect(
    socket.emit.mock.calls.some(
      (call: any[]) => call[0] === 'annotation:request',
    ),
  ).toBe(false);
  expect(result.state?.strokes[0].points).toEqual([
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ]);
});
test('disabled or sharer-only sessions do not emit drawing', async () => {
  await act(async () => {
    handlers.get('annotation:state')!(
      snapshot({ enabled: false, revision: 2 }),
    );
    await result.start();
  });
  expect(result.canDraw).toBe(false);
  await act(async () => {
    result.sendStroke(
      'pen',
      '#FF0000',
      0.006,
      [{ x: 0.2, y: 0.2 }],
      'forbidden',
      true,
    );
  });
  expect(
    socket.emit.mock.calls.some((call: any[]) => call[0] === 'annotation:draw'),
  ).toBe(false);
});
test('legacy request policy sends only the existing protocol request and awaits a grant', async () => {
  server = snapshot({ permission: 'request', revision: 2 });
  await act(async () => {
    handlers.get('annotation:state')!(server);
    await result.start();
  });
  expect(result.canDraw).toBe(false);
  expect(
    socket.emit.mock.calls.filter(
      (call: any[]) => call[0] === 'annotation:request',
    ),
  ).toHaveLength(1);
  await act(async () => {
    handlers.get('annotation:state')!(
      snapshot({ permission: 'request', grants: ['viewer'], revision: 3 }),
    );
  });
  expect(result.canDraw).toBe(true);
});
test('late snapshots and duplicate chunks cannot roll back or duplicate accepted ink', async () => {
  const stroke = {
    id: 'one',
    authorSocketId: 'peer',
    tool: 'pen' as const,
    color: '#FF0000',
    width: 0.006,
    points: [{ x: 0.2, y: 0.3 }],
  };
  const event: AnnotationStrokeEvent = {
    sessionId: 'screen1',
    revision: 2,
    stroke,
  };
  await act(async () => {
    handlers.get('annotation:stroke')!(event);
    handlers.get('annotation:stroke')!(event);
    handlers.get('annotation:state')!(snapshot());
  });
  expect(result.state?.revision).toBe(2);
  expect(result.state?.strokes[0].points).toHaveLength(1);
});
test('permission revocation immediately clears local drawing input and pending optimistic ink', async () => {
  await act(async () => {
    await result.start();
    result.sendStroke('pen', '#FF0000', 0.006, [{ x: 0.2, y: 0.2 }], 'first');
  });
  await act(async () => {
    handlers.get('annotation:state')!(
      snapshot({ enabled: false, revision: 3 }),
    );
  });
  expect(result.canDraw).toBe(false);
  expect(result.optimisticStrokes).toEqual([]);
  const count = socket.emit.mock.calls.length;
  await act(async () => {
    result.sendStroke('pen', '#FF0000', 0.006, [{ x: 0.4, y: 0.4 }], 'first');
    jest.advanceTimersByTime(100);
  });
  expect(socket.emit.mock.calls.length).toBe(count);
});
test('disconnect cancels local input; recovery requires a new snapshot and explicit local start', async () => {
  await act(async () => {
    await result.start();
    socket.connected = false;
    handlers.get('disconnect')!();
  });
  expect(result.canDraw).toBe(false);
  await act(async () => {
    socket.connected = true;
    handlers.get('connect')!();
  });
  expect(result.ready).toBe(true);
  expect(result.localActive).toBe(false);
});
test('a late ACK for the old producer is ignored after a target change', async () => {
  holdGet = true;
  await act(async () => {
    renderer.update(<Harness sessionId="screen2" />);
  });
  await act(async () => {
    renderer.update(<Harness sessionId="screen3" />);
  });
  await act(async () => {
    held[0]({ ok: true, state: snapshot({ sessionId: 'screen2' }) });
  });
  expect(result.state).toBeNull();
  await act(async () => {
    held[1]({ ok: true, state: snapshot({ sessionId: 'screen3' }) });
  });
  expect(result.state?.sessionId).toBe('screen3');
});
test('long strokes use bounded chunks and server-compatible normalized finite points', async () => {
  await act(async () => {
    await result.start();
    result.sendStroke(
      'pen',
      'invalid',
      Infinity,
      Array.from({ length: 145 }, (_, index) => ({ x: index / 100, y: -1 })),
      'long',
      true,
    );
  });
  act(() => {
    jest.advanceTimersByTime(200);
  });
  const payloads = socket.emit.mock.calls
    .filter((call: any[]) => call[0] === 'annotation:draw')
    .map((call: any[]) => call[1].stroke);
  expect(payloads).toHaveLength(3);
  expect(
    payloads.every(
      (stroke: any) =>
        stroke.points.length <= 64 &&
        stroke.width >= 0.0005 &&
        stroke.color === '#FFFFFF',
    ),
  ).toBe(true);
  expect(
    payloads
      .flatMap((stroke: any) => stroke.points)
      .every((point: any) => point.x >= 0 && point.x <= 1 && point.y === 0),
  ).toBe(true);
});
test('laser cursors expire and tool exit keeps shared canvas enabled', async () => {
  await act(async () => {
    await result.start();
    handlers.get('annotation:laser')!({
      sessionId: 'screen1',
      authorSocketId: 'peer',
      point: { x: 0.5, y: 0.5 },
    });
  });
  expect(result.laserPoints.peer).toEqual({ x: 0.5, y: 0.5 });
  await act(async () => {
    jest.advanceTimersByTime(2600);
    result.exit();
  });
  expect(result.laserPoints).toEqual({});
  expect(result.state?.enabled).toBe(true);
  expect(result.localActive).toBe(false);
});
test('mobile sharer opens everyone permission for a new producer without taking touch input', async () => {
  server = snapshot({ sharerSocketId: 'viewer', revision: 0, enabled: false });
  await act(async () => {
    renderer.update(<Harness sharerSocketId="viewer" self />);
  });
  expect(
    socket.emit.mock.calls.some(
      (call: any[]) =>
        call[0] === 'annotation:configure' &&
        call[1].enabled === true &&
        call[1].permission === 'everyone',
    ),
  ).toBe(true);
  expect(result.localActive).toBe(false);
});
