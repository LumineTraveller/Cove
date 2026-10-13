import TestRenderer, { act } from 'react-test-renderer';
import { Modal, StyleSheet, Text, TouchableOpacity } from 'react-native';
import type { Socket } from 'socket.io-client';
import { RoomScreen } from '../src/features/rooms/screens/RoomScreen';
import { useMobileMedia } from '../src/features/media/useMobileMedia';
import type { Room, SessionConfig } from '../src/types';
let mockAnnotations: any;
let mockRemote: any;
jest.mock('../src/features/media/annotation/useScreenAnnotations', () => ({
  useScreenAnnotations: () => mockAnnotations,
}));
jest.mock('../src/features/remote-control/useMobileRemoteControl', () => ({
  useMobileRemoteControl: () => mockRemote,
}));

jest.mock('lucide-react-native', () => {
  const React = require('react');
  return new Proxy(
    {},
    {
      get: (_target, name: string) => () =>
        React.createElement('Icon', { name }),
    },
  );
});
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
}));
jest.mock('../src/features/media/useMobileMedia', () => ({
  useMobileMedia: jest.fn(),
}));
jest.mock('../src/features/profiles/profileRemarks', () => ({
  loadProfileRemarks: jest.fn(async () => ({})),
  saveProfileRemark: jest.fn(),
  getProfileDisplayName: (name: string) => name,
}));
jest.mock('../src/features/profiles/components/Avatar', () => ({
  Avatar: 'Avatar',
}));
jest.mock(
  '../src/features/media/screen/components/ZoomableScreenVideo',
  () => ({ ZoomableScreenVideo: 'ZoomableScreenVideo' }),
);
jest.mock('../src/features/chat/components/ChatPanel', () => ({
  ChatPanel: 'ChatPanel',
}));
jest.mock('../src/features/soundpacks/components/Soundboard', () => ({
  Soundboard: 'Soundboard',
}));
jest.mock('../src/features/profiles/components/UserProfileModal', () => ({
  UserProfileModal: 'UserProfileModal',
}));

const room: Room = {
  id: 'test-room',
  name: '测试房间',
  createdAt: 0,
  ownerName: 'Alice',
  maxMembers: null,
  hasPassword: false,
};
const config: SessionConfig = {
  username: 'Bob',
  serverURL: 'http://localhost',
  clientId: 'device',
  accountToken: 'test',
  accountId: 'bob',
  email: 'bob@example.test',
};

describe('room audio settings', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let media: any;
  let socket: Socket;
  // Cold React Native/icon initialization can exceed 5s on a Windows CI host.
  // Only fixture setup gets extra time; all behavior assertions keep 5s.
  beforeEach(async () => {
    mockAnnotations = {
      ready: true,
      localActive: false,
      canDraw: false,
      remoteControlAllowed: true,
      state: { enabled: true, strokes: [], requests: [] },
      optimisticStrokes: [],
      laserPoints: {},
      pendingAction: null,
      error: null,
      isRequestPending: false,
      annotationsAllowed: true,
      start: jest.fn(async () => {
        mockAnnotations.localActive = true;
        mockAnnotations.canDraw = true;
      }),
      exit: jest.fn(() => {
        mockAnnotations.localActive = false;
        mockAnnotations.canDraw = false;
      }),
      sendStroke: jest.fn((_tool, _color, _width, _points, id) => id),
      sendLaser: jest.fn(),
      finishStroke: jest.fn(),
      clear: jest.fn(),
      setAnnotationsAllowed: jest.fn(),
      respond: jest.fn(),
    };
    mockRemote = {
      session: null,
      pending: null,
      error: null,
      setInputEnabled: jest.fn(),
      request: jest.fn(),
      cancel: jest.fn(),
      stop: jest.fn(),
      button: jest.fn(),
      pointer: jest.fn(),
      click: jest.fn(),
      wheel: jest.fn(),
      shortcut: jest.fn(),
      typeText: jest.fn(),
    };
    media = {
      inVoice: true,
      joining: false,
      isMuted: false,
      isForceMuted: false,
      connectionState: 'connected',
      voiceMembers: [],
      availableScreens: [],
      applicationAudioShares: [],
      memberVolumes: {},
      noiseMode: 'system',
      noiseSwitching: false,
      noiseError: null,
      audioDeviceSwitching: false,
      audioDeviceError: null,
      audioInputs: [
        { id: 'default', label: '系统默认麦克风' },
        { id: 'usb-mic', label: 'USB 麦克风' },
      ],
      audioOutputs: [
        { id: 'out-speaker', label: '扬声器' },
        { id: 'out-bluetooth', label: '蓝牙耳机' },
      ],
      selectedAudioInputId: 'default',
      selectedAudioOutputId: 'out-speaker',
      refreshAudioDevices: jest.fn(async () => null),
      selectNoiseMode: jest.fn(async () => {}),
      selectAudioInput: jest.fn(async () => {}),
      selectAudioOutput: jest.fn(async () => {}),
      joinVoice: jest.fn(),
      leaveVoice: jest.fn(),
      toggleMute: jest.fn(),
      canShareScreen: true,
      canShareScreenAudio: true,
      sharingScreen: false,
      sharingScreenAudio: false,
      screenSharingBusy: false,
      screenViewerCount: 0,
      screenSharingError: null,
      startScreenShare: jest.fn(async () => true),
      stopScreenShare: jest.fn(),
      clearScreenSharingError: jest.fn(),
    };
    (useMobileMedia as jest.Mock).mockImplementation(() => media);
    const timeoutEmit = jest.fn((_event, _payload, callback) =>
      callback(null, { ok: true }),
    );
    socket = {
      id: 'self',
      connected: true,
      timeout: jest.fn(() => ({ emit: timeoutEmit })),
      on: jest.fn(),
      off: jest.fn(),
      emit: jest.fn(),
    } as unknown as Socket;
    await act(async () => {
      renderer = TestRenderer.create(
        <RoomScreen
          socket={socket}
          config={config}
          room={room}
          sessionReady
          onBack={jest.fn()}
        />,
      );
    });
  }, 30_000);
  afterEach(async () => {
    await act(async () => renderer.unmount());
  });

  const button = (label: string) =>
    renderer.root
      .findAllByType(TouchableOpacity)
      .find(node => node.props.accessibilityLabel === label)!;
  async function openAudio() {
    await act(async () => button('音频设置').props.onPress());
  }
  async function rerender() {
    await act(async () =>
      renderer.update(
        <RoomScreen
          socket={socket}
          config={config}
          room={room}
          sessionReady
          onBack={jest.fn()}
        />,
      ),
    );
  }
  const audioModal = () =>
    renderer.root.findAllByType(Modal).find(node => node.props.visible)!;

  test('labelled toolbar opens audio settings and footer only keeps call controls', async () => {
    const topActions = renderer.root
      .findAllByType(TouchableOpacity)
      .filter(node =>
        ['打开聊天', '打开语音包', '音频设置'].includes(
          node.props.accessibilityLabel,
        ),
      );
    expect(topActions.map(node => node.props.accessibilityLabel)).toEqual([
      '打开聊天',
      '打开语音包',
      '音频设置',
    ]);
    expect(
      renderer.root
        .findByProps({ testID: 'room-header' })
        .findAllByType(TouchableOpacity)
        .map(node => node.props.accessibilityLabel),
    ).toEqual(['离开房间']);
    expect(
      renderer.root
        .findByProps({ testID: 'room-toolbar' })
        .findAllByType(TouchableOpacity)
        .map(node => node.props.accessibilityLabel),
    ).toEqual(['打开聊天', '打开语音包', '音频设置']);
    const footer = renderer.root.findByProps({ testID: 'voice-controls' });
    expect(
      footer
        .findAllByType(TouchableOpacity)
        .map(node => node.props.accessibilityLabel),
    ).toEqual(['关闭麦克风', '退出语音']);
    expect(StyleSheet.flatten(footer.props.style).position).toBeUndefined();
    await openAudio();
    expect(media.refreshAudioDevices).toHaveBeenCalledTimes(1);
    expect(button('系统降噪').props.accessibilityState.checked).toBe(true);
    expect(button('RNNoise').props.disabled).not.toBe(true);
    expect(button('输出设备：扬声器').props.accessibilityState.checked).toBe(
      true,
    );
    expect(
      button('输入设备：系统默认麦克风').props.accessibilityState.checked,
    ).toBe(true);
  });

  test('noise and both device choices use existing media callbacks without closing', async () => {
    await openAudio();
    await act(async () => button('系统降噪').props.onPress());
    await act(async () => button('RNNoise').props.onPress());
    await act(async () => button('输出设备：蓝牙耳机').props.onPress());
    await act(async () => button('输入设备：USB 麦克风').props.onPress());
    expect(media.selectNoiseMode).toHaveBeenCalledWith('system');
    expect(media.selectNoiseMode).toHaveBeenCalledWith('rnnoise');
    expect(media.selectAudioOutput).toHaveBeenCalledWith('out-bluetooth');
    expect(media.selectAudioInput).toHaveBeenCalledWith('usb-mic');
    media.noiseMode = 'system';
    media.selectedAudioOutputId = 'out-bluetooth';
    media.selectedAudioInputId = 'usb-mic';
    await rerender();
    expect(button('系统降噪').props.accessibilityState.checked).toBe(true);
    expect(button('输出设备：蓝牙耳机').props.accessibilityState.checked).toBe(
      true,
    );
    expect(
      button('输入设备：USB 麦克风').props.accessibilityState.checked,
    ).toBe(true);
    expect(audioModal().props.visible).toBe(true);
    expect(media.leaveVoice).not.toHaveBeenCalled();
    await act(async () => button('关闭音频设置').props.onPress());
    expect(
      renderer.root.findAllByType(Modal).some(node => node.props.visible),
    ).toBe(false);
    expect(media.leaveVoice).not.toHaveBeenCalled();
  });

  test('owner room settings stay in the header and member names can wrap', async () => {
    const onRoomState = (socket.on as jest.Mock).mock.calls.find(
      ([name]) => name === 'room:state',
    )![1];
    await act(async () =>
      onRoomState({
        roomId: room.id,
        maxMembers: null,
        hasPassword: false,
        ownerName: 'Bob',
        members: [
          {
            socketId: 'self',
            userId: 'bob',
            username: 'Bob',
            isOwner: true,
            isMuted: false,
          },
        ],
      }),
    );
    const topActions = renderer.root
      .findAllByType(TouchableOpacity)
      .filter(node =>
        ['房间设置', '打开聊天', '打开语音包', '音频设置'].includes(
          node.props.accessibilityLabel,
        ),
      );
    expect(topActions.map(node => node.props.accessibilityLabel)).toEqual([
      '房间设置',
      '打开聊天',
      '打开语音包',
      '音频设置',
    ]);
    expect(
      renderer.root
        .findByProps({ testID: 'room-header' })
        .findAllByType(TouchableOpacity)
        .map(node => node.props.accessibilityLabel),
    ).toEqual(['离开房间', '房间设置']);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('等待屏幕共享');
  });

  test.each(['joining', 'noiseSwitching', 'audioDeviceSwitching'])(
    '%s disables settings choices but keeps close available',
    async busy => {
      media[busy] = true;
      await rerender();
      await openAudio();
      expect(button('系统降噪').props.disabled).toBe(true);
      expect(button('输出设备：蓝牙耳机').props.disabled).toBe(true);
      expect(button('输入设备：USB 麦克风').props.disabled).toBe(true);
      expect(button('关闭音频设置').props.disabled).not.toBe(true);
    },
  );

  test('empty devices and switching errors remain visible in the scrollable settings', async () => {
    media.audioInputs = [];
    media.audioOutputs = [];
    media.noiseError = '降噪切换失败，已保留原模式';
    media.audioDeviceError = '读取音频设备失败';
    await rerender();
    await openAudio();
    const content = JSON.stringify(renderer.toJSON());
    expect(content).toContain('暂无可切换输出设备');
    expect(content).toContain('暂无可切换输入设备');
    expect(content).toContain(media.noiseError);
    expect(content).toContain(media.audioDeviceError);
    await act(async () => audioModal().props.onRequestClose());
    expect(
      renderer.root.findAllByType(Modal).some(node => node.props.visible),
    ).toBe(false);
  });

  test('mic mute and leave still work; before joining only the join control is present', async () => {
    await act(async () => button('关闭麦克风').props.onPress());
    await act(async () => button('退出语音').props.onPress());
    expect(media.toggleMute).toHaveBeenCalledTimes(1);
    expect(media.leaveVoice).toHaveBeenCalledTimes(1);
    media.inVoice = false;
    await rerender();
    const controls = renderer.root
      .findByProps({ testID: 'voice-controls' })
      .findAllByType(TouchableOpacity);
    expect(controls).toHaveLength(1);
    await act(async () => controls[0].props.onPress());
    expect(media.joinVoice).toHaveBeenCalledTimes(1);
  });

  test('screen sharing keeps optional audio and honestly describes the fixed native capture rate', async () => {
    const card = renderer.root.findByProps({ testID: 'own-screen-sharing' });
    expect(StyleSheet.flatten(card.props.style).position).toBeUndefined();
    expect(StyleSheet.flatten(card.props.style).flexDirection).toBe('row');
    await act(async () => button('打开屏幕共享设置').props.onPress());
    const content = JSON.stringify(renderer.toJSON());
    expect(content).toContain('同时共享音频');
    expect(content).not.toContain('分辨率');
    expect(content).toContain('30 FPS');
    expect(content).toContain('观看帧率由共享源与设备决定');
    expect(content).not.toContain('120 FPS');
    expect(
      renderer.root.findAllByProps({ accessibilityRole: 'radio' }),
    ).not.toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({
          accessibilityLabel: expect.stringContaining('FPS'),
        }),
      }),
    );
    await act(async () => button('开始共享手机屏幕').props.onPress());
    expect(media.startScreenShare).toHaveBeenCalledWith(false);
    expect(
      renderer.root.findAllByType(Modal).some(node => node.props.visible),
    ).toBe(false);
    media.sharingScreen = true;
    media.sharingScreenAudio = true;
    media.screenViewerCount = 2;
    await rerender();
    await act(async () => button('停止共享我的屏幕').props.onPress());
    expect(media.stopScreenShare).toHaveBeenCalledTimes(1);
    expect(media.leaveVoice).not.toHaveBeenCalled();
    expect(
      renderer.root
        .findByProps({ testID: 'voice-controls' })
        .findAllByType(TouchableOpacity),
    ).toHaveLength(2);
  });

  test('starting annotation during a remote session paints locally instead of sending remote input', async () => {
    media.remoteScreen = {
      socketId: 'desktop',
      consumerId: 'video',
      stream: { toURL: () => 'synthetic-screen' },
    };
    media.availableScreens = [
      { socketId: 'desktop', videoProducerId: 'producer' },
    ];
    media.watchingScreenPeerId = 'desktop';
    mockRemote.session = {
      sessionId: 'remote-session',
      role: 'controller',
      sharerSocketId: 'desktop',
    };
    await rerender();
    const surface = () =>
      renderer.root.findAllByType('ZoomableScreenVideo' as any)[0];
    await act(async () => {
      surface().props.interaction.onStart({ x: 0.5, y: 0.5 });
      surface().props.interaction.onMove({ x: 0.6, y: 0.6 });
    });
    expect(mockRemote.button).toHaveBeenCalledWith('left', true, {
      x: 0.5,
      y: 0.5,
    });
    expect(mockRemote.pointer).toHaveBeenCalledTimes(1);
    await act(async () => {
      button('批注').props.onPress();
    });
    await rerender();
    expect(mockRemote.setInputEnabled).toHaveBeenLastCalledWith(false);
    expect(button('键盘输入').props.disabled).toBe(true);
    expect(
      renderer.root.findAllByProps({ testID: 'screen-interaction-mode' })[0]
        .props.children,
    ).toContain('批注模式');
    const remoteButtons = mockRemote.button.mock.calls.length;
    await act(async () => {
      surface().props.interaction.onStart({ x: 0.2, y: 0.2 });
      surface().props.interaction.onMove({ x: 0.3, y: 0.3 });
    });
    expect(mockAnnotations.sendStroke).toHaveBeenCalledTimes(2);
    expect(mockRemote.button).toHaveBeenCalledTimes(remoteButtons);
    expect(mockRemote.pointer).toHaveBeenCalledTimes(1);
    await act(async () => {
      button('结束批注').props.onPress();
    });
    await rerender();
    expect(mockRemote.setInputEnabled).toHaveBeenLastCalledWith(true);
    await act(async () => {
      surface().props.interaction.onStart({ x: 0.4, y: 0.4 });
    });
    expect(mockRemote.button).toHaveBeenLastCalledWith('left', true, {
      x: 0.4,
      y: 0.4,
    });
  });

  test('sharing authorization can be canceled without locking other call controls', async () => {
    await act(async () => button('打开屏幕共享设置').props.onPress());
    media.screenSharingBusy = true;
    await rerender();
    expect(button('开始共享手机屏幕').props.disabled).toBe(true);
    await act(async () => button('关闭屏幕共享设置').props.onPress());
    expect(media.stopScreenShare).toHaveBeenCalledTimes(1);
    expect(media.leaveVoice).not.toHaveBeenCalled();
  });

  test('sharing options can be viewed before joining while capture remains disabled', async () => {
    media.inVoice = false;
    await rerender();
    expect(button('打开屏幕共享设置').props.disabled).not.toBe(true);
    await act(async () => button('打开屏幕共享设置').props.onPress());
    expect(button('开始共享手机屏幕').props.disabled).toBe(true);
    expect(
      renderer.root
        .findAllByType(Text)
        .some(node => node.props.children === '加入语音后才能开始共享屏幕。'),
    ).toBe(true);
    expect(media.startScreenShare).not.toHaveBeenCalled();
    await act(async () => button('关闭屏幕共享设置').props.onPress());
    expect(
      renderer.root.findAllByType(Modal).some(node => node.props.visible),
    ).toBe(false);
  });

  test('room settings preserve existing payloads, prevent double saves, and can close while pending', async () => {
    const onRoomState = (socket.on as jest.Mock).mock.calls.find(
      ([name]) => name === 'room:state',
    )![1];
    await act(async () =>
      onRoomState({
        roomId: room.id,
        maxMembers: null,
        hasPassword: false,
        ownerName: 'Bob',
        members: [
          {
            socketId: 'self',
            userId: 'bob',
            username: 'Bob',
            isOwner: true,
            isMuted: false,
          },
        ],
      }),
    );
    await act(async () => button('房间设置').props.onPress());
    await act(async () => button('人数上限：5').props.onPress());
    const timeoutEmit = jest.fn();
    (socket.timeout as jest.Mock).mockReturnValue({ emit: timeoutEmit });
    const saveAction = renderer.root
      .findAllByType(TouchableOpacity)
      .find(node =>
        node
          .findAllByType(Text)
          .some(text => text.props.children === '保存设置'),
      )!;
    await act(async () => {
      saveAction.props.onPress();
      saveAction.props.onPress();
    });
    expect(timeoutEmit).toHaveBeenCalledTimes(1);
    expect(timeoutEmit.mock.calls[0][0]).toBe('room:update-settings');
    expect(timeoutEmit.mock.calls[0][1]).toEqual(
      expect.objectContaining({ roomId: room.id, maxMembers: 5 }),
    );
    await act(async () => button('关闭房间设置').props.onPress());
    expect(
      renderer.root.findAllByType(Modal).some(node => node.props.visible),
    ).toBe(false);
  });
});
