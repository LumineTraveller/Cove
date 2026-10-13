import TestRenderer, { act } from 'react-test-renderer';
import { PanResponder, Text, TouchableOpacity, View } from 'react-native';
import { ZoomableScreenVideo } from '../src/features/media/screen/components/ZoomableScreenVideo';
jest.mock('react-native-webrtc', () => ({ RTCView: 'RTCView' }));

function createResponderSpy() {
  return jest.spyOn(PanResponder, 'create').mockImplementation(
    config =>
      ({
        panHandlers: {
          onResponderGrant: config.onPanResponderGrant,
          onResponderMove: config.onPanResponderMove,
          onResponderRelease: config.onPanResponderRelease,
          onStartShouldSetResponder: config.onStartShouldSetPanResponder,
          onStartShouldSetResponderCapture:
            config.onStartShouldSetPanResponderCapture,
          onMoveShouldSetResponder: config.onMoveShouldSetPanResponder,
          onMoveShouldSetResponderCapture:
            config.onMoveShouldSetPanResponderCapture,
        },
        getInteractionHandle: () => null,
      } as any),
  );
}

const pinchEvent = (distance: number, usePageCoords = false) => {
  const points = [
    { x: 100 - distance / 2, y: 50 },
    { x: 100 + distance / 2, y: 50 },
  ];
  return {
    nativeEvent: {
      touches: points.map(point =>
        usePageCoords
          ? {
              pageX: point.x,
              pageY: point.y,
              locationX: point.x,
              locationY: point.y,
            }
          : { locationX: point.x, locationY: point.y },
      ),
    },
  };
};

const surfaceOf = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findAllByType(View).find(view => view.props.onResponderMove)!;

test('two-finger movement zooms, reset restores, and a new stream clears the old zoom', async () => {
  const spy = createResponderSpy();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ZoomableScreenVideo streamURL="stream-a" />,
    );
  });
  const surface = () => surfaceOf(renderer);
  await act(async () =>
    surface().props.onLayout({
      nativeEvent: { layout: { width: 200, height: 100, x: 0, y: 0 } },
    }),
  );
  expect(surface().props.onStartShouldSetResponder(pinchEvent(100))).toBe(true);
  await act(async () => surface().props.onResponderGrant(pinchEvent(100)));
  await act(async () => surface().props.onResponderMove(pinchEvent(200)));
  expect(
    renderer.root
      .findAllByType(Text)
      .some(text => JSON.stringify(text.props.children).includes('200')),
  ).toBe(true);
  await act(async () =>
    renderer.root.findByType(TouchableOpacity).props.onPress(),
  );
  expect(renderer.root.findAllByType(TouchableOpacity)).toHaveLength(0);
  await act(async () => surface().props.onResponderGrant(pinchEvent(100)));
  await act(async () => surface().props.onResponderMove(pinchEvent(250)));
  expect(renderer.root.findAllByType(TouchableOpacity)).toHaveLength(1);
  await act(async () =>
    renderer.update(<ZoomableScreenVideo streamURL="stream-b" />),
  );
  expect(renderer.root.findAllByType(TouchableOpacity)).toHaveLength(0);
  await act(async () => renderer.unmount());
  spy.mockRestore();
});

test('claims the gesture on the first finger so a later pinch is not lost to a parent scroll view', async () => {
  const spy = createResponderSpy();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ZoomableScreenVideo streamURL="stream-a" />,
    );
  });
  const surface = () => surfaceOf(renderer);
  await act(async () =>
    surface().props.onLayout({
      nativeEvent: { layout: { width: 200, height: 100, x: 0, y: 0 } },
    }),
  );
  const oneFinger = {
    nativeEvent: { touches: [{ locationX: 40, locationY: 40 }] },
  };
  expect(surface().props.onStartShouldSetResponder(oneFinger)).toBe(true);
  expect(surface().props.onStartShouldSetResponderCapture(oneFinger)).toBe(
    true,
  );
  expect(surface().props.onMoveShouldSetResponderCapture(pinchEvent(120))).toBe(
    true,
  );
  await act(async () => renderer.unmount());
  spy.mockRestore();
});

test('incidental layout changes keep the current zoom instead of snapping back to 100%', async () => {
  const spy = createResponderSpy();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ZoomableScreenVideo streamURL="stream-a" />,
    );
  });
  const surface = () => surfaceOf(renderer);
  await act(async () =>
    surface().props.onLayout({
      nativeEvent: { layout: { width: 200, height: 100, x: 0, y: 0 } },
    }),
  );
  await act(async () => surface().props.onResponderGrant(pinchEvent(100)));
  await act(async () => surface().props.onResponderMove(pinchEvent(200)));
  expect(
    renderer.root
      .findAllByType(Text)
      .some(text => JSON.stringify(text.props.children).includes('200')),
  ).toBe(true);
  // Same size, different origin — status-bar hide / parent reflow.
  await act(async () =>
    surface().props.onLayout({
      nativeEvent: { layout: { width: 200, height: 100, x: 0, y: 24 } },
    }),
  );
  expect(
    renderer.root
      .findAllByType(Text)
      .some(text => JSON.stringify(text.props.children).includes('200')),
  ).toBe(true);
  await act(async () => renderer.unmount());
  spy.mockRestore();
});

test('page-space touch coordinates drive pinch zoom', async () => {
  const spy = createResponderSpy();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ZoomableScreenVideo streamURL="stream-a" />,
    );
  });
  const surface = () => surfaceOf(renderer);
  await act(async () =>
    surface().props.onLayout({
      nativeEvent: { layout: { width: 200, height: 100, x: 0, y: 0 } },
    }),
  );
  await act(async () => surface().props.onResponderGrant(pinchEvent(80, true)));
  await act(async () => surface().props.onResponderMove(pinchEvent(160, true)));
  expect(
    renderer.root
      .findAllByType(Text)
      .some(text => JSON.stringify(text.props.children).includes('200')),
  ).toBe(true);
  await act(async () => renderer.unmount());
  spy.mockRestore();
});

test('drawing uses the source rectangle, excludes bars and inverts pinch zoom', async () => {
  const spy = createResponderSpy();
  const interaction = {
    onStart: jest.fn(),
    onMove: jest.fn(),
    onEnd: jest.fn(),
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ZoomableScreenVideo streamURL="screen" interaction={interaction} />,
    );
  });
  const surface = () => surfaceOf(renderer);
  const finger = (x: number, y: number) => ({
    nativeEvent: { touches: [{ locationX: x, locationY: y }] },
  });
  await act(async () => {
    surface().props.onLayout({
      nativeEvent: { layout: { width: 200, height: 100, x: 0, y: 0 } },
    });
  });
  await act(async () => {
    renderer.root
      .findByType('RTCView' as any)
      .props.onDimensionsChange({ nativeEvent: { width: 400, height: 100 } });
  });
  await act(async () => {
    surface().props.onResponderGrant(finger(100, 0));
    surface().props.onResponderRelease();
  });
  expect(interaction.onStart).not.toHaveBeenCalled();
  await act(async () => {
    surface().props.onResponderGrant(finger(0, 25));
  });
  expect(interaction.onStart).toHaveBeenLastCalledWith({ x: 0, y: 0 });
  await act(async () => {
    surface().props.onResponderMove(finger(100, 50));
  });
  expect(interaction.onMove).toHaveBeenLastCalledWith({ x: 0.5, y: 0.5 });
  await act(async () => {
    surface().props.onResponderRelease();
    surface().props.onResponderGrant(pinchEvent(100));
    surface().props.onResponderMove(pinchEvent(200));
    surface().props.onResponderRelease();
  });
  await act(async () => {
    surface().props.onResponderGrant(finger(100, 0));
  });
  expect(interaction.onStart).toHaveBeenLastCalledWith({ x: 0.5, y: 0 });
  await act(async () => renderer.unmount());
  spy.mockRestore();
});

test('first press after a scroll uses its nonzero current origin and ignores an old measurement', async () => {
  const spy = createResponderSpy();
  const React = require('react');
  const realUseRef = React.useRef;
  const refs: any[] = [];
  const refSpy = jest
    .spyOn(React, 'useRef')
    .mockImplementation((value: unknown) => {
      const ref = realUseRef(value);
      refs.push(ref);
      return ref;
    });
  const callbacks: ((x: number, y: number) => void)[] = [];
  const interaction = {
    onStart: jest.fn(),
    onMove: jest.fn(),
    onEnd: jest.fn(),
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <ZoomableScreenVideo streamURL="screen" interaction={interaction} />,
      );
    });
    refs[0].current = {
      measureInWindow: (callback: (x: number, y: number) => void) =>
        callbacks.push(callback),
    };
    const surface = () => surfaceOf(renderer);
    const layout = {
      nativeEvent: { layout: { width: 200, height: 100, x: 20, y: 100 } },
    };
    await act(async () => {
      surface().props.onLayout(layout);
    });
    callbacks.shift()!(20, 100);
    await act(async () => {
      renderer.root
        .findByType('RTCView' as any)
        .props.onDimensionsChange({ nativeEvent: { width: 200, height: 100 } });
      surface().props.onLayout(layout);
    });
    const event = {
      nativeEvent: {
        touches: [{ pageX: 140, pageY: 130, locationX: 100, locationY: 50 }],
      },
    };
    // The scroll moved the target from (20,100) to (40,80), without onLayout.
    await act(async () => {
      surface().props.onResponderGrant(event);
    });
    expect(interaction.onStart).toHaveBeenLastCalledWith({ x: 0.5, y: 0.5 });
    callbacks.shift()!(20, 100); // stale async callback cannot undo calibration
    await act(async () => {
      surface().props.onResponderMove(event);
    });
    expect(interaction.onMove).toHaveBeenLastCalledWith({ x: 0.5, y: 0.5 });
    await act(async () => {
      surface().props.onResponderRelease();
      surface().props.onResponderGrant({
        nativeEvent: {
          touches: [{ pageX: 140, pageY: 90, locationX: 100, locationY: 50 }],
        },
      });
    });
    expect(interaction.onStart).toHaveBeenLastCalledWith({ x: 0.5, y: 0.5 });
  } finally {
    refSpy.mockRestore();
    if (renderer) await act(async () => renderer.unmount());
    spy.mockRestore();
  }
});

test('a page-only press waits for a fresh measurement and a released press cannot start late', async () => {
  const spy = createResponderSpy();
  const React = require('react');
  const realUseRef = React.useRef;
  const refs: any[] = [];
  const refSpy = jest
    .spyOn(React, 'useRef')
    .mockImplementation((value: unknown) => {
      const ref = realUseRef(value);
      refs.push(ref);
      return ref;
    });
  const callbacks: ((x: number, y: number) => void)[] = [];
  const interaction = {
    onStart: jest.fn(),
    onMove: jest.fn(),
    onEnd: jest.fn(),
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <ZoomableScreenVideo streamURL="screen" interaction={interaction} />,
      );
    });
    refs[0].current = {
      measureInWindow: (callback: (x: number, y: number) => void) =>
        callbacks.push(callback),
    };
    const surface = () => surfaceOf(renderer);
    await act(async () => {
      surface().props.onLayout({
        nativeEvent: { layout: { width: 200, height: 100 } },
      });
    });
    callbacks.shift()!(20, 100);
    await act(async () => {
      renderer.root
        .findByType('RTCView' as any)
        .props.onDimensionsChange({ nativeEvent: { width: 200, height: 100 } });
    });
    const event = { nativeEvent: { touches: [{ pageX: 140, pageY: 130 }] } };
    await act(async () => {
      surface().props.onResponderGrant(event);
      surface().props.onResponderMove(event);
    });
    expect(interaction.onStart).not.toHaveBeenCalled();
    await act(async () => {
      callbacks.shift()!(40, 80);
    });
    expect(interaction.onStart).toHaveBeenLastCalledWith({ x: 0.5, y: 0.5 });
    await act(async () => {
      surface().props.onResponderRelease();
      surface().props.onResponderGrant(event);
      surface().props.onResponderRelease();
      callbacks.shift()!(40, 80);
    });
    expect(interaction.onStart).toHaveBeenCalledTimes(1);
  } finally {
    refSpy.mockRestore();
    if (renderer) await act(async () => renderer.unmount());
    spy.mockRestore();
  }
});

test('switching draw/control mode ends the held gesture and only a new press resumes input', async () => {
  const spy = createResponderSpy();
  const control = { onStart: jest.fn(), onMove: jest.fn(), onEnd: jest.fn() };
  const drawing = { onStart: jest.fn(), onMove: jest.fn(), onEnd: jest.fn() };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ZoomableScreenVideo streamURL="screen" interaction={control} />,
    );
  });
  const surface = () => surfaceOf(renderer);
  const finger = {
    nativeEvent: {
      touches: [{ pageX: 140, pageY: 130, locationX: 100, locationY: 50 }],
    },
  };
  await act(async () => {
    surface().props.onLayout({
      nativeEvent: { layout: { width: 200, height: 100 } },
    });
    renderer.root
      .findByType('RTCView' as any)
      .props.onDimensionsChange({ nativeEvent: { width: 200, height: 100 } });
    surface().props.onResponderGrant(finger);
  });
  expect(control.onStart).toHaveBeenCalledTimes(1);
  await act(async () => {
    renderer.update(
      <ZoomableScreenVideo streamURL="screen" interaction={drawing} />,
    );
  });
  await act(async () => {
    surface().props.onResponderMove(finger);
  });
  expect(control.onEnd).toHaveBeenCalledTimes(1);
  expect(drawing.onStart).not.toHaveBeenCalled();
  expect(drawing.onMove).not.toHaveBeenCalled();
  await act(async () => {
    surface().props.onResponderRelease();
    surface().props.onResponderGrant(finger);
  });
  expect(drawing.onStart).toHaveBeenCalledTimes(1);
  await act(async () => {
    renderer.update(
      <ZoomableScreenVideo streamURL="screen" interaction={control} />,
    );
  });
  await act(async () => {
    surface().props.onResponderMove(finger);
  });
  expect(control.onStart).toHaveBeenCalledTimes(1);
  expect(control.onMove).not.toHaveBeenCalled();
  await act(async () => {
    surface().props.onResponderRelease();
    surface().props.onResponderGrant(finger);
  });
  expect(control.onStart).toHaveBeenCalledTimes(2);
  await act(async () => {
    renderer.update(
      <ZoomableScreenVideo streamURL="new-screen" interaction={control} />,
    );
  });
  expect(control.onEnd).toHaveBeenCalledTimes(2);
  await act(async () => renderer.unmount());
  spy.mockRestore();
});

test('unreliable secondary local coordinates do not affect a nonzero-origin pinch', async () => {
  const spy = createResponderSpy();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ZoomableScreenVideo streamURL="screen" />);
  });
  const surface = () => surfaceOf(renderer);
  await act(async () => {
    surface().props.onLayout({
      nativeEvent: { layout: { width: 200, height: 100 } },
    });
  });
  await act(async () => {
    surface().props.onResponderGrant({
      nativeEvent: {
        touches: [{ pageX: 90, pageY: 130, locationX: 50, locationY: 50 }],
      },
    });
  });
  const pinch = (distance: number) => ({
    nativeEvent: {
      touches: [
        {
          pageX: 140 - distance / 2,
          pageY: 130,
          locationX: -900,
          locationY: -900,
        },
        {
          pageX: 140 + distance / 2,
          pageY: 130,
          locationX: 8000,
          locationY: 8000,
        },
      ],
    },
  });
  await act(async () => {
    surface().props.onResponderMove(pinch(100));
    surface().props.onResponderMove(pinch(200));
  });
  expect(
    renderer.root
      .findAllByType(Text)
      .some(text => JSON.stringify(text.props.children).includes('200')),
  ).toBe(true);
  await act(async () => renderer.unmount());
  spy.mockRestore();
});
