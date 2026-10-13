import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  BackHandler,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import type { Socket } from 'socket.io-client';
import { RoomListScreen } from '../src/features/rooms/screens/RoomListScreen';
import { CoveThemeProvider } from '../src/features/settings/ThemeProvider';
import { palettes } from '../src/features/settings/theme';
import { serverFetch } from '../src/features/connection/serverSecurity';
import type { Room, SessionConfig } from '../src/types';

jest.mock('lucide-react-native', () => {
  const MockReact = require('react');
  return new Proxy(
    {},
    {
      get: (_target, name: string) => () =>
        MockReact.createElement('Icon', { name }),
    },
  );
});
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
  },
}));
jest.mock('../src/features/connection/serverSecurity', () => ({
  serverFetch: jest.fn(),
}));
jest.mock('../src/features/profiles/profileRemarks', () => ({
  loadProfileRemarks: jest.fn(async () => ({})),
  getProfileDisplayName: (name: string) => name,
}));
jest.mock('../src/features/updates/components/MobileUpdater', () => ({
  MobileUpdateButton: 'MobileUpdateButton',
}));
jest.mock('../src/features/keyboard/useKeyboardInset', () => ({
  useKeyboardInset: () => ({
    scrollView: { current: null },
    bottomInset: 40,
    onScroll: jest.fn(),
    onLayout: jest.fn(),
    onContentSizeChange: jest.fn(),
    bindInput: jest.fn(),
    unbindInput: jest.fn(),
  }),
}));

const room: Room = {
  id: 'room-1',
  name: '一起看电影和讨论这个周末的计划这是一段很长的中文房间名称',
  createdAt: 0,
  ownerName: '林间',
  maxMembers: 5,
  hasPassword: true,
};
const config: SessionConfig = {
  username: '小雨',
  serverURL: 'https://synthetic.example.test:51758',
  clientId: 'synthetic-device',
  accountToken: 'synthetic-token',
  accountId: 'synthetic-self',
  email: 'synthetic@example.test',
};
type CreateCallback = (
  error: Error | null,
  result?: { room?: Room; error?: string },
) => void;

describe('desktop-style mobile lobby and settings', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let socket: Socket;
  let onSelectRoom: jest.Mock;
  let onChangeServer: jest.Mock;
  let creates: { payload: unknown; callback: CreateCallback }[];
  let connected: boolean;
  const render = () => (
    <CoveThemeProvider>
      <RoomListScreen
        socket={socket}
        config={config}
        sessionReady={connected}
        onSelectRoom={onSelectRoom}
        onChangeServer={onChangeServer}
      />
    </CoveThemeProvider>
  );
  const button = (label: string) =>
    renderer.root
      .findAll(
        node =>
          node.props.accessibilityLabel === label &&
          typeof node.props.onPress === 'function',
      )
      .at(0)!;
  const input = (label: string) =>
    renderer.root
      .findAllByType(TextInput)
      .find(node => node.props.accessibilityLabel === label)!;
  const modal = () => renderer.root.findByType(Modal);
  const texts = () =>
    renderer.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .map(children =>
        Array.isArray(children) ? children.flat(2).join('') : String(children),
      )
      .join(' ');
  const roomHandler = (event: string) =>
    (socket.on as jest.Mock).mock.calls.find(([name]) => name === event)![1];
  async function press(label: string) {
    await act(async () => button(label).props.onPress());
  }
  async function fill(label: string, value: string) {
    await act(async () => input(label).props.onChangeText(value));
  }
  async function create(name = '新的房间') {
    await press('新建房间');
    await fill('房间名称', name);
    await press('创建并进入');
  }

  beforeEach(async () => {
    creates = [];
    connected = true;
    onSelectRoom = jest.fn();
    onChangeServer = jest.fn();
    jest
      .mocked(serverFetch)
      .mockReset()
      .mockResolvedValue({ ok: true, json: async () => [room] } as Response);
    const emit = jest.fn((event: string, ...args: any[]) => {
      if (event === 'presence:get')
        args[0](null, { ok: true, onlineUsers: [] });
      if (event === 'room:create')
        creates.push({ payload: args[0], callback: args[1] });
    });
    socket = {
      id: 'self',
      connected: true,
      timeout: jest.fn(() => ({ emit })),
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as Socket;
    await act(async () => {
      renderer = TestRenderer.create(render());
    });
  }, 30_000);
  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount());
    jest.restoreAllMocks();
  });

  test('keeps room selection and live counts, password indication, and long Chinese labels', async () => {
    expect(serverFetch).toHaveBeenCalledWith(config.serverURL, '/api/rooms');
    await act(async () =>
      roomHandler('room:members:global')({
        roomId: room.id,
        members: ['one', 'two'],
      }),
    );
    expect(texts()).toContain('2 人');
    expect(texts()).toContain(room.name);
    await press(`进入房间 ${room.name}，需要密码`);
    expect(onSelectRoom).toHaveBeenCalledWith(room);
    const roomTitle = renderer.root
      .findAllByType(Text)
      .find(node => node.props.children === room.name)!;
    expect(roomTitle.props.numberOfLines).toBe(2);
  });

  test.each(['取消创建房间', '取消', 'android-back'])(
    'cancel via %s invalidates old response and permits a new request',
    async cancel => {
      await create();
      expect(creates).toHaveLength(1);
      if (cancel === 'android-back')
        await act(async () => modal().props.onRequestClose());
      else await press(cancel);
      expect(modal().props.visible).toBe(false);
      await create('第二个房间');
      expect(creates).toHaveLength(2);
      await act(async () =>
        creates[0].callback(null, { room: { ...room, id: 'old' } }),
      );
      expect(onSelectRoom).not.toHaveBeenCalled();
      expect(modal().props.visible).toBe(true);
      expect(button('创建中…').props.disabled).toBe(true);
      await act(async () =>
        creates[1].callback(null, { room: { ...room, id: 'new' } }),
      );
      expect(onSelectRoom).toHaveBeenCalledTimes(1);
      expect(onSelectRoom).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'new' }),
      );
      expect(modal().props.visible).toBe(false);
    },
  );

  test('guards repeated taps even before the pending render, and retries a failed create', async () => {
    await press('新建房间');
    await fill('房间名称', '计划');
    await fill('房间密码', 'safe-room-secret');
    await press('上限 5 人');
    const submit = button('创建并进入').props.onPress;
    await act(async () => {
      submit();
      submit();
    });
    expect(creates).toHaveLength(1);
    expect(creates[0].payload).toEqual({
      name: '计划',
      maxMembers: 5,
      password: 'safe-room-secret',
    });
    await act(async () =>
      creates[0].callback(null, { error: '房间名称已存在' }),
    );
    expect(texts()).toContain('房间名称已存在');
    expect(input('房间名称').props.value).toBe('计划');
    await press('创建并进入');
    expect(creates).toHaveLength(2);
  });

  test('validates room fields and leaves the protocol unchanged for an unlimited room', async () => {
    await press('新建房间');
    await press('创建并进入');
    expect(texts()).toContain('请输入房间名称');
    await fill('房间名称', '  无密码房间  ');
    await fill('自定义人数上限', '0');
    await press('创建并进入');
    expect(creates).toHaveLength(0);
    await press('人数不限');
    await fill('房间密码', ' ');
    await press('创建并进入');
    expect(creates).toHaveLength(0);
    await fill('房间密码', '');
    await press('创建并进入');
    expect(creates[0].payload).toEqual({
      name: '无密码房间',
      maxMembers: null,
    });
  });

  test('rejects creation while disconnected and reloads after reconnection', async () => {
    connected = false;
    (socket as any).connected = false;
    await act(async () => renderer.update(render()));
    expect(texts()).toContain('正在连接服务器');
    expect(button('新建房间').props.disabled).toBe(true);
    await press('新建房间');
    expect(modal().props.visible).toBe(false);
    connected = true;
    (socket as any).connected = true;
    await act(async () => renderer.update(render()));
    expect(serverFetch).toHaveBeenCalledTimes(2);
    expect(button('新建房间').props.disabled).toBe(false);
  });

  test('room loading errors offer recovery and cannot override a newer request', async () => {
    jest.mocked(serverFetch).mockRejectedValueOnce(new Error('offline'));
    await act(async () =>
      renderer.root.findByType(FlatList).props.refreshControl.props.onRefresh(),
    );
    expect(texts()).toContain('暂时无法加载房间');
    await press('重新加载');
    expect(texts()).toContain(room.name);
    let staleResolve!: (value: Response) => void;
    jest.mocked(serverFetch).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          staleResolve = resolve;
        }),
    );
    await act(async () =>
      renderer.root.findByType(FlatList).props.refreshControl.props.onRefresh(),
    );
    await act(async () =>
      renderer.root.findByType(FlatList).props.refreshControl.props.onRefresh(),
    );
    await act(async () =>
      staleResolve({
        ok: true,
        json: async () => [{ ...room, name: '过时的响应' }],
      } as Response),
    );
    expect(texts()).not.toContain('过时的响应');
    expect(texts()).toContain(room.name);
  });

  test('settings preserve account/server details, switch themes, and use the existing server switch callback', async () => {
    await press('设置');
    expect(texts()).toContain(config.email);
    expect(texts()).toContain(config.accountId);
    expect(texts()).toContain(config.serverURL);
    await press('深色模式');
    expect(button('深色模式').props.accessibilityState.selected).toBe(true);
    const selectedStyle = StyleSheet.flatten(
      button('深色模式').props.style({ pressed: false }),
    );
    expect(selectedStyle.backgroundColor).toBe(palettes.dark.navigation);
    await press('切换账号或服务器');
    expect(onChangeServer).toHaveBeenCalledTimes(1);
    await press('房间');
    const listStyle = StyleSheet.flatten(
      renderer.root.findByType(FlatList).props.style,
    );
    expect(listStyle.backgroundColor).toBe(palettes.dark.background);
    expect(texts()).not.toContain(config.accountToken);
  });

  test.each(['response', 'error'])(
    'realtime room broadcast wins over a pending HTTP %s',
    async outcome => {
      let resolve!: (value: Response) => void;
      let reject!: (error: Error) => void;
      jest.mocked(serverFetch).mockImplementationOnce(
        () =>
          new Promise((res, rej) => {
            resolve = res;
            reject = rej;
          }),
      );
      await act(async () =>
        renderer.root
          .findByType(FlatList)
          .props.refreshControl.props.onRefresh(),
      );
      await act(async () =>
        roomHandler('rooms:updated')([{ ...room, name: '实时新房间' }]),
      );
      await act(async () => {
        if (outcome === 'response')
          resolve({
            ok: true,
            json: async () => [{ ...room, name: '过时的房间' }],
          } as Response);
        else reject(new Error('HTTP 503'));
      });
      expect(texts()).toContain('实时新房间');
      expect(texts()).not.toContain('过时的房间');
      expect(texts()).not.toContain('暂时无法加载房间');
    },
  );

  test('hardware back from settings returns to the room list', async () => {
    let back!: () => boolean;
    jest
      .spyOn(BackHandler, 'addEventListener')
      .mockImplementation((_event, handler) => {
        back = handler as () => boolean;
        return { remove: jest.fn() };
      });
    await press('账户与服务器设置');
    await act(async () => expect(back()).toBe(true));
    expect(button('房间').props.accessibilityState.selected).toBe(true);
  });

  test('create form is scrollable with keyboard inset, and late callbacks after unmount are ignored', async () => {
    await create();
    const scroll = modal().findByType(ScrollView);
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    expect(
      StyleSheet.flatten(scroll.props.contentContainerStyle).paddingBottom,
    ).toBe(60);
    await act(async () => renderer.unmount());
    await act(async () => creates[0].callback(null, { room }));
    expect(onSelectRoom).not.toHaveBeenCalled();
  });
});
