import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text, TextInput, TouchableOpacity } from 'react-native';
import { ChatPanel } from '../src/components/ChatPanel';

jest.mock('lucide-react-native', () => ({ MessageCircle: 'MessageCircle', Send: 'Send', X: 'X' }));

test('loads realtime messages and sends text to the current room', async () => {
  const listeners = new Map<string, (...args: any[]) => void>();
  const socket = {
    on: jest.fn((event: string, listener: (...args: any[]) => void) => listeners.set(event, listener)),
    off: jest.fn(),
    emit: jest.fn(),
  };
  globalThis.fetch = jest.fn(async () => ({ ok: true, json: async () => [] })) as jest.Mock;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ChatPanel
      visible socket={socket as never} roomId="room" serverURL="http://server.test:3001"
      username="Alice" ready onClose={() => {}}
    />);
  });

  await act(async () => listeners.get('message:new')?.({
    id: 'message', roomId: 'room', author: 'Bob', content: '你好', type: 'chat', timestamp: 1,
  }));
  expect(renderer.root.findAllByType(Text).some(node => node.props.children === '你好')).toBe(true);

  const input = renderer.root.findByProps({ placeholder: '发送消息' }) as TestRenderer.ReactTestInstance;
  await act(async () => input.props.onChangeText('  手机消息  '));
  const send = renderer.root.findAllByType(TouchableOpacity).find(node => node.props.accessibilityLabel === '发送消息')!;
  await act(async () => send.props.onPress());
  expect(socket.emit).toHaveBeenCalledWith('message:send', { roomId: 'room', content: '手机消息' });
  expect(renderer.root.findByType(TextInput).props.value).toBe('');
  await act(async () => renderer.unmount());
});
