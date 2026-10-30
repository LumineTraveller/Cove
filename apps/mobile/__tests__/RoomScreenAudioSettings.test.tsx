import TestRenderer, { act } from 'react-test-renderer';
import {
  Modal,
  StyleSheet, Text,
  TouchableOpacity } from 'react-native';
import type { Socket } from 'socket.io-client';
import { RoomScreen } from '../src/features/rooms/screens/RoomScreen';
import { useMobileMedia } from '../src/features/media/useMobileMedia';
import type { Room, SessionConfig } from '../src/types';
let mockRemote: any;
jest.mock('../src/features/remote-control/useRemoteControlPolicy', () => ({
  useRemoteControlPolicy: () => true,
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

  test('mobile removes sharing, annotation and media status entries', () => {
    const labels = renderer.root
      .findAllByType(TouchableOpacity)
      .map(node => node.props.accessibilityLabel ?? '');
    expect(labels.some(label => /批注|共享设置|媒体状态/.test(label))).toBe(
      false,
    );
    expect(
      renderer.root.findAllByProps({ testID: 'own-screen-sharing' }),
    ).toHaveLength(0);
    expect(media.startScreenShare).not.toHaveBeenCalled();
  });
  async function watch() {
    media.remoteScreen = {
      socketId: 'desktop',
      consumerId: 'video',
      stream: { toURL: () => 'synthetic-screen' },
    };
    media.availableScreens = [
      { socketId: 'desktop', videoProducerId: 'producer' },
    ];
    media.watchingScreenPeerId = 'desktop';
    media.screenReceiveVolume = 0.6;
    media.setScreenReceiveVolume = jest.fn();
    await rerender();
  }
  test('receiving screen volume remains available outside voice and in audio settings', async () => {
    media.inVoice = false;
    await watch();
    const slider = renderer.root.findByProps({
      accessibilityLabel: '共享屏幕音量',
    });
    expect(slider.props.accessibilityValue.now).toBe(60);
    await act(async () => button('将共享屏幕静音').props.onPress());
    expect(media.setScreenReceiveVolume).toHaveBeenCalledWith(0);
    await openAudio();
    expect(
      audioModal().findAllByProps({ accessibilityLabel: '共享屏幕音量' })
        .length,
    ).toBeGreaterThan(0);
  });
  test('fullscreen gives video the full stage and opens volume only on demand', async () => {
    await watch();
    await act(async () => button('全屏观看共享').props.onPress());
    const modal = audioModal();
    expect(modal.props.statusBarTranslucent).toBe(true);
    expect(modal.props.navigationBarTranslucent).toBe(true);
    expect(
      modal.findAllByProps({ accessibilityLabel: '共享屏幕音量' }),
    ).toHaveLength(0);
    expect(
      modal.findAllByProps({ accessibilityLabel: '申请远控' }),
    ).toHaveLength(0);
    await act(async () => button('全屏共享音量').props.onPress());
    expect(
      modal.findByProps({ accessibilityLabel: '共享屏幕音量' }).props
        .accessibilityValue.now,
    ).toBe(60);
    await act(async () => button('全屏共享音量').props.onPress());
    expect(
      modal.findAllByProps({ accessibilityLabel: '共享屏幕音量' }),
    ).toHaveLength(0);
  });
  test('toolbar text has an explicit centered line box and never wraps as separate flex rows', () => {
    const toolbar = renderer.root
        .findByProps({ testID: 'room-toolbar' });
    for (const node of toolbar.findAllByType(TouchableOpacity))
      expect(StyleSheet.flatten(node.props.style).flexWrap).toBe('nowrap');
    for (const node of toolbar.findAllByType(Text))
      expect(StyleSheet.flatten(node.props.style)).toEqual(
      expect.objectContaining({
          includeFontPadding: false,
          textAlignVertical: 'center',
          lineHeight: 18,
        }),
      );
  });
  test('remote pointer input is preserved without a mobile drawing mode', async () => {
    await watch();
    mockRemote.session = {
      sessionId: 'remote-session',
      role: 'controller',
      sharerSocketId: 'desktop',
    };
    await rerender();
    const surface = renderer.root.findAllByType('ZoomableScreenVideo' as any)[0];
    await act(async () => {
      surface.props.interaction.onStart({ x: 0.5, y: 0.5 });
      surface.props.interaction.onMove({ x: 0.6, y: 0.6 });
      surface.props.interaction.onEnd();
    });
    expect(mockRemote.button).toHaveBeenCalledWith('left', true, {
      x: 0.5,
      y: 0.5,
    });
    expect(mockRemote.button).toHaveBeenCalledWith('left', false, { x: 0.6, y: 0.6 });
    expect(mockRemote.pointer).toHaveBeenCalledTimes(1);
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
