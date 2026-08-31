import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Platform, Switch, TextInput, TouchableOpacity } from 'react-native';
import { LoginScreen } from '../src/screens/LoginScreen';

jest.mock('lucide-react-native', () => ({ LockKeyhole: 'LockKeyhole', LogIn: 'LogIn', Mail: 'Mail', Server: 'Server', UserRound: 'UserRound' }));

test('certificate switch is opt-in, resets on endpoint change, and does not apply to HTTP', async () => {
  Platform.OS = 'android';
  const submit = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<LoginScreen saving={false} onSubmit={submit} />); });
  const inputs = () => renderer.root.findAllByType(TextInput);
  const serverInput = () => inputs().find(item => item.props.keyboardType === 'url')!;
  await act(async () => serverInput().props.onChangeText('https://host.test:51758'));
  await act(async () => inputs().find(item => item.props.keyboardType === 'email-address')!.props.onChangeText('alice@example.com'));
  await act(async () => inputs().find(item => item.props.secureTextEntry)!.props.onChangeText('password'));
  expect(renderer.root.findByType(Switch).props.value).toBe(false);
  await act(async () => renderer.root.findByType(Switch).props.onValueChange(true));
  const submitButton = () => renderer.root.findAllByType(TouchableOpacity).at(-1)!;
  await act(async () => submitButton().props.onPress());
  expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({
    mode: 'login', email: 'alice@example.com', password: 'password',
    serverURL: 'https://host.test:51758', allowInvalidServerCertificate: true,
  }));
  await act(async () => serverInput().props.onChangeText('https://host.test:51759'));
  expect(renderer.root.findByType(Switch).props.value).toBe(false);
  await act(async () => serverInput().props.onChangeText('http://host.test:51758'));
  expect(renderer.root.findAllByType(Switch)).toHaveLength(0);
  await act(async () => submitButton().props.onPress());
  expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ serverURL: 'http://host.test:51758', allowInvalidServerCertificate: false }));
  await act(async () => renderer.unmount());
}, 20_000);

test('saved server prefills address/email and resumes by token without filling a password', async () => {
  const saved = { username: 'Alice', serverURL: 'https://one.test', email: 'alice@test.com', clientId: 'device', accountId: 'account', accountToken: 'saved-token' };
  const resume = jest.fn(); const forget = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<LoginScreen saving={false} onSubmit={jest.fn()} rememberedServers={[saved]} onResume={resume} onForget={forget} />); });
  const inputs = renderer.root.findAllByType(TextInput);
  expect(inputs.find(input => input.props.keyboardType === 'url')!.props.value).toBe(saved.serverURL);
  expect(inputs.find(input => input.props.keyboardType === 'email-address')!.props.value).toBe(saved.email);
  expect(inputs.find(input => input.props.secureTextEntry)!.props.value).toBe('');
  await act(async () => renderer.root.findByProps({ accessibilityLabel: `继续连接 ${saved.serverURL}` }).props.onPress());
  expect(resume).toHaveBeenCalledWith(saved);
  await act(async () => renderer.root.findByProps({ accessibilityLabel: `忘记 ${saved.serverURL}` }).props.onPress());
  expect(forget).toHaveBeenCalledWith(saved);
  await act(async () => renderer.unmount());
});
