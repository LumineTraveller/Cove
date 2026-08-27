import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Platform, Switch, TextInput, TouchableOpacity } from 'react-native';
import { LoginScreen } from '../src/screens/LoginScreen';

jest.mock('lucide-react-native', () => ({ LogIn: 'LogIn', Server: 'Server', UserRound: 'UserRound' }));

test('certificate switch is opt-in, resets on endpoint change, and does not apply to HTTP', async () => {
  Platform.OS = 'android';
  const submit = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<LoginScreen initialName="Alice" initialServer="https://host.test:51758" saving={false} onSubmit={submit} />); });
  expect(renderer.root.findByType(Switch).props.value).toBe(false);
  await act(async () => renderer.root.findByType(Switch).props.onValueChange(true));
  await act(async () => renderer.root.findByType(TouchableOpacity).props.onPress());
  expect(submit).toHaveBeenLastCalledWith('Alice', 'https://host.test:51758', true);
  const serverInput = () => renderer.root.findAllByType(TextInput).find(item => item.props.keyboardType === 'url')!;
  await act(async () => serverInput().props.onChangeText('https://host.test:51759'));
  expect(renderer.root.findByType(Switch).props.value).toBe(false);
  await act(async () => serverInput().props.onChangeText('http://host.test:51758'));
  expect(renderer.root.findAllByType(Switch)).toHaveLength(0);
  await act(async () => renderer.root.findByType(TouchableOpacity).props.onPress());
  expect(submit).toHaveBeenLastCalledWith('Alice', 'http://host.test:51758', false);
  await act(async () => renderer.unmount());
}, 20_000);
