import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Modal, StyleSheet, TouchableOpacity } from 'react-native';
import type { Socket } from 'socket.io-client';
import { RoomScreen } from '../src/screens/RoomScreen';
import { useMobileMedia } from '../src/useMobileMedia';
import type { Room, SessionConfig } from '../src/types';

jest.mock('lucide-react-native', () => {
  const React = require('react');
  return new Proxy({}, { get: (_target, name: string) => () => React.createElement('Icon', { name }) });
});
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('../src/useMobileMedia', () => ({ useMobileMedia: jest.fn() }));
jest.mock('../src/profileRemarks', () => ({
  loadProfileRemarks: jest.fn(async () => ({})),
  saveProfileRemark: jest.fn(),
  getProfileDisplayName: (name: string) => name,
}));
jest.mock('../src/components/Avatar', () => ({ Avatar: 'Avatar' }));
jest.mock('../src/components/ZoomableScreenVideo', () => ({ ZoomableScreenVideo: 'ZoomableScreenVideo' }));
jest.mock('../src/components/ChatPanel', () => ({ ChatPanel: 'ChatPanel' }));
jest.mock('../src/components/Soundboard', () => ({ Soundboard: 'Soundboard' }));
jest.mock('../src/components/UserProfileModal', () => ({ UserProfileModal: 'UserProfileModal' }));

const room: Room = { id: 'test-room', name: '测试房间', createdAt: 0, ownerName: 'Alice', maxMembers: null, hasPassword: false };
const config: SessionConfig = { username: 'Bob', serverURL: 'http://localhost', clientId: 'device', accountToken: 'test', accountId: 'bob', email: 'bob@example.test' };

describe('room audio settings', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let media: any;
  let socket: Socket;
  beforeEach(async () => {
    media = {
      inVoice: true, joining: false, isMuted: false, isForceMuted: false,
      connectionState: 'connected', voiceMembers: [], availableScreens: [], applicationAudioShares: [], memberVolumes: {},
      noiseMode: 'rnnoise', noiseSwitching: false, noiseError: null,
      audioDeviceSwitching: false, audioDeviceError: null,
      audioInputs: [{ id: 'default', label: '系统默认麦克风' }, { id: 'usb-mic', label: 'USB 麦克风' }],
      audioOutputs: [{ id: 'out-speaker', label: '扬声器' }, { id: 'out-bluetooth', label: '蓝牙耳机' }],
      selectedAudioInputId: 'default', selectedAudioOutputId: 'out-speaker',
      refreshAudioDevices: jest.fn(async () => null), selectNoiseMode: jest.fn(async () => {}),
      selectAudioInput: jest.fn(async () => {}), selectAudioOutput: jest.fn(async () => {}),
      joinVoice: jest.fn(), leaveVoice: jest.fn(), toggleMute: jest.fn(),
    };
    (useMobileMedia as jest.Mock).mockImplementation(() => media);
    const timeoutEmit = jest.fn((_event, _payload, callback) => callback(null, { ok: true }));
    socket = { id: 'self', connected: true, timeout: jest.fn(() => ({ emit: timeoutEmit })), on: jest.fn(), off: jest.fn(), emit: jest.fn() } as unknown as Socket;
    await act(async () => { renderer = TestRenderer.create(<RoomScreen socket={socket} config={config} room={room} sessionReady onBack={jest.fn()} />); });
  });
  afterEach(async () => { await act(async () => renderer.unmount()); });

  const button = (label: string) => renderer.root.findAllByType(TouchableOpacity).find(node => node.props.accessibilityLabel === label)!;
  async function openAudio() { await act(async () => button('音频设置').props.onPress()); }
  async function rerender() { await act(async () => renderer.update(<RoomScreen socket={socket} config={config} room={room} sessionReady onBack={jest.fn()} />)); }
  const audioModal = () => renderer.root.findAllByType(Modal).find(node => node.props.visible)!;

  test('rightmost top action opens audio settings and footer only keeps call controls', async () => {
    const topActions = renderer.root.findAllByType(TouchableOpacity).filter(node => ['打开聊天', '打开语音包', '音频设置'].includes(node.props.accessibilityLabel));
    expect(topActions.map(node => node.props.accessibilityLabel)).toEqual(['打开聊天', '打开语音包', '音频设置']);
    const footer = renderer.root.findByProps({ testID: 'voice-controls' });
    expect(footer.findAllByType(TouchableOpacity).map(node => node.props.accessibilityLabel)).toEqual(['关闭麦克风', '退出语音']);
    expect(StyleSheet.flatten(footer.props.style).position).toBeUndefined();
    await openAudio();
    expect(media.refreshAudioDevices).toHaveBeenCalledTimes(1);
    expect(button('RNNoise（改进）').props.accessibilityState.checked).toBe(true);
    expect(button('输出设备：扬声器').props.accessibilityState.checked).toBe(true);
    expect(button('输入设备：系统默认麦克风').props.accessibilityState.checked).toBe(true);
  });

  test('noise and both device choices use existing media callbacks without closing', async () => {
    await openAudio();
    await act(async () => button('系统降噪').props.onPress());
    await act(async () => button('输出设备：蓝牙耳机').props.onPress());
    await act(async () => button('输入设备：USB 麦克风').props.onPress());
    expect(media.selectNoiseMode).toHaveBeenCalledWith('system');
    expect(media.selectAudioOutput).toHaveBeenCalledWith('out-bluetooth');
    expect(media.selectAudioInput).toHaveBeenCalledWith('usb-mic');
    media.noiseMode = 'system';
    media.selectedAudioOutputId = 'out-bluetooth';
    media.selectedAudioInputId = 'usb-mic';
    await rerender();
    expect(button('系统降噪').props.accessibilityState.checked).toBe(true);
    expect(button('输出设备：蓝牙耳机').props.accessibilityState.checked).toBe(true);
    expect(button('输入设备：USB 麦克风').props.accessibilityState.checked).toBe(true);
    expect(audioModal().props.visible).toBe(true);
    expect(media.leaveVoice).not.toHaveBeenCalled();
    await act(async () => button('关闭音频设置').props.onPress());
    expect(renderer.root.findAllByType(Modal).some(node => node.props.visible)).toBe(false);
    expect(media.leaveVoice).not.toHaveBeenCalled();
  });

  test('owner room settings remain separate and audio settings stay at the far right', async () => {
    const onRoomState = (socket.on as jest.Mock).mock.calls.find(([name]) => name === 'room:state')![1];
    await act(async () => onRoomState({
      roomId: room.id, maxMembers: null, hasPassword: false, ownerName: 'Bob',
      members: [{ socketId: 'self', userId: 'bob', username: 'Bob', isOwner: true, isMuted: false }],
    }));
    const topActions = renderer.root.findAllByType(TouchableOpacity).filter(node => ['房间设置', '打开聊天', '打开语音包', '音频设置'].includes(node.props.accessibilityLabel));
    expect(topActions.map(node => node.props.accessibilityLabel)).toEqual(['房间设置', '打开聊天', '打开语音包', '音频设置']);
  });

  test.each(['joining', 'noiseSwitching', 'audioDeviceSwitching'])('%s disables settings choices but keeps close available', async (busy) => {
    media[busy] = true;
    await rerender();
    await openAudio();
    expect(button('系统降噪').props.disabled).toBe(true);
    expect(button('输出设备：蓝牙耳机').props.disabled).toBe(true);
    expect(button('输入设备：USB 麦克风').props.disabled).toBe(true);
    expect(button('关闭音频设置').props.disabled).not.toBe(true);
  });

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
    expect(renderer.root.findAllByType(Modal).some(node => node.props.visible)).toBe(false);
  });

  test('mic mute and leave still work; before joining only the join control is present', async () => {
    await act(async () => button('关闭麦克风').props.onPress());
    await act(async () => button('退出语音').props.onPress());
    expect(media.toggleMute).toHaveBeenCalledTimes(1);
    expect(media.leaveVoice).toHaveBeenCalledTimes(1);
    media.inVoice = false;
    await rerender();
    const controls = renderer.root.findByProps({ testID: 'voice-controls' }).findAllByType(TouchableOpacity);
    expect(controls).toHaveLength(1);
    await act(async () => controls[0].props.onPress());
    expect(media.joinVoice).toHaveBeenCalledTimes(1);
  });
});
