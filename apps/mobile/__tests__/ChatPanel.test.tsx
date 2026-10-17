import TestRenderer, { act } from 'react-test-renderer';
import {
  DeviceEventEmitter,
  FlatList,
  Keyboard,
  NativeModules,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  ChatPanel,
  useComposerKeyboardInset,
} from '../src/features/chat/components/ChatPanel';

jest.mock('lucide-react-native', () => ({
  MessageCircle: 'MessageCircle',
  Send: 'Send',
  X: 'X',
}));

test('cancels the initial scroll when chat closes or unmounts', async () => {
  const requestFrame = jest
    .spyOn(globalThis, 'requestAnimationFrame')
    .mockReturnValue(42);
  const cancelFrame = jest
    .spyOn(globalThis, 'cancelAnimationFrame')
    .mockImplementation(() => {});
  const socket = { on: jest.fn(), off: jest.fn() };
  const props = {
    socket: socket as never,
    roomId: 'room',
    serverURL: 'http://server.test:3001',
    username: 'Alice',
    members: [],
    profileRemarks: {},
    ready: false,
    onClose: () => {},
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = TestRenderer.create(<ChatPanel {...props} visible />);
    });
    expect(requestFrame).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer!.update(<ChatPanel {...props} visible={false} />);
    });
    expect(cancelFrame).toHaveBeenCalledWith(42);
    cancelFrame.mockClear();
    requestFrame.mockReturnValue(43);
    await act(async () => {
      renderer!.update(<ChatPanel {...props} visible />);
    });
    await act(async () => {
      renderer!.unmount();
    });
    renderer = undefined;
    expect(cancelFrame).toHaveBeenCalledWith(43);
  } finally {
    if (renderer)
      await act(async () => {
        renderer!.unmount();
      });
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  }
});

test('loads realtime messages and sends text to the current room', async () => {
  const listeners = new Map<string, (...args: any[]) => void>();
  const socket = {
    on: jest.fn((event: string, listener: (...args: any[]) => void) =>
      listeners.set(event, listener),
    ),
    off: jest.fn(),
    emit: jest.fn(
      (event: string, payload: any, callback?: (...args: any[]) => void) => {
        if (event === 'room:history')
          callback?.(null, { ok: true, messages: [] });
      },
    ),
    timeout: jest.fn(function (this: any) {
      return this;
    }),
  };
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => [],
  })) as jest.Mock;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ChatPanel
        visible
        socket={socket as never}
        roomId="room"
        serverURL="http://server.test:3001"
        username="Alice"
        members={[]}
        profileRemarks={{ 'public-bob': 'Bobby' }}
        ready
        onClose={() => {}}
      />,
    );
  });

  await act(async () =>
    listeners.get('message:new')?.({
      id: 'message',
      roomId: 'room',
      author: 'Bob',
      authorUserId: 'public-bob',
      content: '你好',
      type: 'chat',
      timestamp: 1,
    }),
  );
  expect(
    renderer.root
      .findAllByType(Text)
      .some((node) => node.props.children === '你好'),
  ).toBe(true);
  expect(
    renderer.root
      .findAllByType(Text)
      .some((node) => node.props.children === 'Bobby'),
  ).toBe(true);
  await act(async () =>
    listeners.get('message:new')?.({
      id: 'system-message',
      roomId: 'room',
      author: 'Cove',
      content: '[Bob] 加入了语音',
      contentUsername: 'Bob',
      contentUserId: 'public-bob',
      type: 'system',
      timestamp: 2,
    }),
  );
  expect(
    renderer.root
      .findAllByType(Text)
      .some((node) => node.props.children === '[Bobby] 加入了语音'),
  ).toBe(true);

  const input = renderer.root.findByProps({
    placeholder: '发送消息',
  }) as TestRenderer.ReactTestInstance;
  await act(async () => input.props.onChangeText('  手机消息  '));
  const send = renderer.root
    .findAllByType(TouchableOpacity)
    .find((node) => node.props.accessibilityLabel === '发送消息')!;
  await act(async () => send.props.onPress());
  expect(socket.emit).toHaveBeenCalledWith('message:send', {
    roomId: 'room',
    content: '手机消息',
  });
  expect(renderer.root.findByType(TextInput).props.value).toBe('');
  await act(async () => renderer.unmount());
});

function createChatFixture() {
  const listeners = new Map<string, (...args: any[]) => void>();
  const historyReplies: ((error: Error | null, result?: any) => void)[] = [];
  const socket = {
    connected: true,
    id: 'self',
    on: jest.fn((event: string, listener: (...args: any[]) => void) =>
      listeners.set(event, listener),
    ),
    off: jest.fn((event: string) => listeners.delete(event)),
    emit: jest.fn(
      (event: string, _payload: any, callback?: (...args: any[]) => void) => {
        if (event === 'room:history' && callback) historyReplies.push(callback);
      },
    ),
    timeout: jest.fn(function (this: any) {
      return this;
    }),
  };
  const props = {
    visible: true,
    socket: socket as never,
    roomId: 'room',
    serverURL: 'http://server.test:3001',
    username: 'Alice',
    members: [],
    profileRemarks: {},
    ready: true,
    onClose: jest.fn(),
  };
  return { socket, listeners, historyReplies, props };
}

function chatButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType(TouchableOpacity)
    .find((node) => node.props.accessibilityLabel === label)!;
}

test('two send presses before React updates emit a single message', async () => {
  const fixture = createChatFixture();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ChatPanel {...fixture.props} />);
  });
  await act(async () =>
    renderer.root.findByType(TextInput).props.onChangeText('  同一条消息  '),
  );
  const send = chatButton(renderer, '发送消息');
  await act(async () => {
    send.props.onPress();
    send.props.onPress();
  });
  expect(
    fixture.socket.emit.mock.calls.filter(
      ([event]) => event === 'message:send',
    ),
  ).toEqual([['message:send', { roomId: 'room', content: '同一条消息' }]]);
  expect(renderer.root.findByType(TextInput).props.value).toBe('');
  await act(async () => renderer.unmount());
});

test('disconnection prevents sends and preserves the draft for reconnect', async () => {
  const fixture = createChatFixture();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ChatPanel {...fixture.props} />);
  });
  await act(async () =>
    renderer.root.findByType(TextInput).props.onChangeText('断网后继续发送'),
  );
  fixture.socket.connected = false;
  await act(async () =>
    renderer.update(<ChatPanel {...fixture.props} ready={false} />),
  );
  expect(chatButton(renderer, '发送消息').props.disabled).toBe(true);
  await act(async () => chatButton(renderer, '发送消息').props.onPress());
  expect(
    fixture.socket.emit.mock.calls.filter(
      ([event]) => event === 'message:send',
    ),
  ).toHaveLength(0);
  expect(renderer.root.findByType(TextInput).props.value).toBe(
    '断网后继续发送',
  );
  fixture.socket.connected = true;
  await act(async () => renderer.update(<ChatPanel {...fixture.props} />));
  await act(async () => chatButton(renderer, '发送消息').props.onPress());
  expect(fixture.socket.emit).toHaveBeenCalledWith('message:send', {
    roomId: 'room',
    content: '断网后继续发送',
  });
  await act(async () => renderer.unmount());
});

test('history retry merges realtime messages and ignores old room responses', async () => {
  const fixture = createChatFixture();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ChatPanel {...fixture.props} />);
  });
  await act(async () => fixture.historyReplies[0](new Error('offline')));
  await act(async () =>
    chatButton(renderer, '重新加载聊天记录').props.onPress(),
  );
  expect(fixture.historyReplies).toHaveLength(2);
  const message = {
    id: 'live',
    roomId: 'room',
    author: 'Bob',
    content: '新消息',
    type: 'chat',
    timestamp: 1,
  };
  await act(async () => fixture.listeners.get('message:new')!(message));
  await act(async () =>
    fixture.historyReplies[1](null, { ok: true, messages: [message] }),
  );
  expect(
    renderer.root
      .findAllByType(Text)
      .filter((node) => node.props.children === '新消息'),
  ).toHaveLength(1);
  expect(
    renderer.root
      .findAllByType(Text)
      .some(
        (node) =>
          typeof node.props.children === 'string' &&
          node.props.children.includes('加载失败'),
      ),
  ).toBe(false);
  await act(async () =>
    renderer.root.findByType(TextInput).props.onChangeText('旧房间草稿'),
  );
  await act(async () =>
    renderer.update(<ChatPanel {...fixture.props} roomId="next-room" />),
  );
  await act(async () =>
    fixture.historyReplies[1](null, {
      ok: true,
      messages: [{ ...message, id: 'stale', content: '过期回复' }],
    }),
  );
  expect(renderer.root.findByType(TextInput).props.value).toBe('');
  expect(
    renderer.root
      .findAllByType(Text)
      .some((node) => ['过期回复', '新消息'].includes(node.props.children)),
  ).toBe(false);
  await act(async () => renderer.unmount());
});

test('reading earlier messages leaves the scroll position and offers a new message action', async () => {
  const fixture = createChatFixture();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ChatPanel {...fixture.props} />);
  });
  const list = renderer.root.findByType(FlatList);
  await act(async () => list.props.onContentSizeChange(320, 1600));
  await act(async () =>
    list.props.onScroll({
      nativeEvent: {
        contentOffset: { y: 0 },
        contentSize: { height: 1600 },
        layoutMeasurement: { height: 500 },
      },
    }),
  );
  await act(async () =>
    fixture.listeners.get('message:new')!({
      id: 'new',
      roomId: 'room',
      author: 'Bob',
      content: '后来的一条消息',
      type: 'chat',
      timestamp: 1,
    }),
  );
  expect(chatButton(renderer, '查看新消息')).toBeDefined();
  await act(async () => chatButton(renderer, '查看新消息').props.onPress());
  expect(
    renderer.root
      .findAllByType(TouchableOpacity)
      .some((node) => node.props.accessibilityLabel === '查看新消息'),
  ).toBe(false);
  await act(async () => renderer.unmount());
});

describe('Android composer keyboard', () => {
  let keyboard: ReturnType<typeof useComposerKeyboardInset>;
  let renderer: TestRenderer.ReactTestRenderer;
  let listeners: Map<string, (...args: any[]) => void>;
  let viewportHeight: number;
  const originalPlatform = Platform.OS;
  const originalKeyboard = NativeModules.CoveKeyboard;
  function Harness({ visible = true }: { visible?: boolean }) {
    keyboard = useComposerKeyboardInset(visible);
    return null;
  }
  beforeEach(async () => {
    Platform.OS = 'android';
    NativeModules.CoveKeyboard = undefined;
    listeners = new Map();
    viewportHeight = 640;
    jest.spyOn(Keyboard, 'metrics').mockReturnValue(undefined);
    jest.spyOn(Keyboard, 'addListener').mockImplementation((name, listener) => {
      listeners.set(name, listener);
      return { remove: jest.fn(() => listeners.delete(name)) } as never;
    });
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
    });
    keyboard!.container.current = {
      measureInWindow: (callback: any) => callback(0, 24, 320, viewportHeight),
    } as View;
  });
  afterEach(async () => {
    await act(async () => renderer.unmount());
    jest.restoreAllMocks();
    Platform.OS = originalPlatform;
    NativeModules.CoveKeyboard = originalKeyboard;
  });
  test('lifts the composer only for the part obscured by the keyboard, then clears when hidden', async () => {
    await act(async () =>
      listeners.get('keyboardDidShow')!({
        endCoordinates: { screenY: 424, screenX: 0, height: 240, width: 320 },
      }),
    );
    expect(keyboard.inset).toBe(240);
    viewportHeight = 400;
    await act(async () => keyboard.updateInset());
    expect(keyboard.inset).toBe(0);
    viewportHeight = 640;
    await act(async () =>
      listeners.get('keyboardDidChangeFrame')!({
        endCoordinates: { screenY: 380, screenX: 0, height: 284, width: 320 },
      }),
    );
    expect(keyboard.inset).toBe(284);
    await act(async () => listeners.get('keyboardDidHide')!());
    expect(keyboard.inset).toBe(0);
  });
  test('uses the normalized native IME top and ignores a late initial frame', async () => {
    await act(async () => renderer.unmount());
    let resolveInitial!: (frame: any) => void;
    NativeModules.CoveKeyboard = {
      getKeyboardFrame: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      ),
      addListener: jest.fn(),
      removeListeners: jest.fn(),
    };
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
    });
    keyboard!.container.current = {
      measureInWindow: (callback: any) => callback(0, 24, 320, viewportHeight),
    } as View;
    await act(async () =>
      DeviceEventEmitter.emit('coveKeyboardFrame', {
        visible: true,
        top: 424,
        height: 240,
        width: 320,
      }),
    );
    expect(keyboard.inset).toBe(240);
    await act(async () =>
      resolveInitial({ visible: false, top: 664, height: 0, width: 320 }),
    );
    expect(keyboard.inset).toBe(240);
    await act(async () => renderer.update(<Harness visible={false} />));
    expect(keyboard.inset).toBe(0);
    expect(listeners.size).toBe(0);
  });
});
