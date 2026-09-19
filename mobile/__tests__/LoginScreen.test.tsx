import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Platform, Switch, Text, TextInput, TouchableOpacity } from 'react-native';
import { LoginScreen } from '../src/screens/LoginScreen';

jest.mock('lucide-react-native', () => ({ LockKeyhole: 'LockKeyhole', LogIn: 'LogIn', Mail: 'Mail', Server: 'Server', UserRound: 'UserRound' }));

const enabledSecurity = {
  enabled: true,
  configured: true,
  bootstrapAvailable: false,
  tokenEpoch: 1,
  authorized: false,
  secureTransportRequired: false,
};
const disabledSecurity = { ...enabledSecurity, enabled: false, configured: false, tokenEpoch: 0 };

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

async function finishProbe() {
  await act(async () => {
    jest.advanceTimersByTime(350);
    await Promise.resolve();
  });
}

test('certificate switch is opt-in, resets on endpoint change, and does not apply to HTTP', async () => {
  Platform.OS = 'android';
  const submit = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<LoginScreen saving={false} onSubmit={submit} onProbeServerSecurity={async () => enabledSecurity} />); });
  const inputs = () => renderer.root.findAllByType(TextInput);
  const serverInput = () => inputs().find(item => item.props.keyboardType === 'url')!;
  await act(async () => serverInput().props.onChangeText('https://host.test:51758'));
  await finishProbe();
  await act(async () => inputs().find(item => item.props.keyboardType === 'email-address')!.props.onChangeText('alice@example.com'));
  await act(async () => inputs().find(item => item.props.secureTextEntry)!.props.onChangeText('password'));
  expect(renderer.root.findByType(Switch).props.value).toBe(false);
  await act(async () => renderer.root.findByType(Switch).props.onValueChange(true));
  await finishProbe();
  await act(async () => inputs().filter(item => item.props.secureTextEntry)[1]!.props.onChangeText('server-password'));
  const submitButton = () => renderer.root.findAllByType(TouchableOpacity).at(-1)!;
  await act(async () => submitButton().props.onPress());
  expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({
    mode: 'login', email: 'alice@example.com', password: 'password',
    serverPassword: 'server-password', bootstrapToken: '',
    serverURL: 'https://host.test:51758', allowInvalidServerCertificate: true,
  }));
  await act(async () => serverInput().props.onChangeText('https://host.test:51759'));
  expect(renderer.root.findByType(Switch).props.value).toBe(false);
  await finishProbe();
  await act(async () => serverInput().props.onChangeText('http://host.test:51758'));
  await finishProbe();
  expect(renderer.root.findAllByType(Switch)).toHaveLength(0);
  await act(async () => submitButton().props.onPress());
  expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ serverURL: 'http://host.test:51758', allowInvalidServerCertificate: false }));
  await act(async () => renderer.unmount());
}, 20_000);

test('saved enabled server prefills address/email but still requires the server password', async () => {
  const saved = { username: 'Alice', serverURL: 'https://one.test', email: 'alice@test.com', clientId: 'device', accountId: 'account', accountToken: 'saved-token' };
  const forget = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<LoginScreen saving={false} onSubmit={jest.fn()} rememberedServers={[saved]} onForget={forget} onProbeServerSecurity={async () => enabledSecurity} />); });
  await finishProbe();
  const inputs = renderer.root.findAllByType(TextInput);
  expect(inputs.find(input => input.props.keyboardType === 'url')!.props.value).toBe(saved.serverURL);
  expect(inputs.find(input => input.props.keyboardType === 'email-address')!.props.value).toBe(saved.email);
  expect(inputs.find(input => input.props.secureTextEntry)!.props.value).toBe('');
  await act(async () => renderer.root.findByProps({ accessibilityLabel: `填写并连接 ${saved.serverURL}` }).props.onPress());
  expect(renderer.root.findAllByType(TextInput).filter(input => input.props.secureTextEntry)[1]!.props.value).toBe('');
  await act(async () => renderer.root.findByProps({ accessibilityLabel: `忘记 ${saved.serverURL}` }).props.onPress());
  expect(forget).toHaveBeenCalledWith(saved);
  await act(async () => renderer.unmount());
});

test('disabled server keeps the legacy login form and does not require a server password', async () => {
  const submit = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<LoginScreen saving={false} onSubmit={submit} onProbeServerSecurity={async () => disabledSecurity} />); });
  const inputs = () => renderer.root.findAllByType(TextInput);
  await act(async () => inputs().find(input => input.props.keyboardType === 'url')!.props.onChangeText('https://legacy.test'));
  await finishProbe();
  await act(async () => inputs().find(input => input.props.keyboardType === 'email-address')!.props.onChangeText('legacy@example.com'));
  await act(async () => inputs().find(input => input.props.secureTextEntry)!.props.onChangeText('password-123'));
  expect(inputs().filter(input => input.props.secureTextEntry)).toHaveLength(1);
  const submitButton = renderer.root.findAllByType(TouchableOpacity).at(-1)!;
  expect(submitButton.props.disabled).toBe(false);
  await act(async () => submitButton.props.onPress());
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({
    serverURL: 'https://legacy.test',
    serverPassword: '',
    bootstrapToken: '',
  }));
  await act(async () => renderer.unmount());
});

test('uninitialized server requires an available bootstrap credential before submit', async () => {
  const unavailable = { ...enabledSecurity, configured: false, bootstrapAvailable: false };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<LoginScreen saving={false} onSubmit={jest.fn()} onProbeServerSecurity={async () => unavailable} />); });
  const inputs = () => renderer.root.findAllByType(TextInput);
  await act(async () => inputs().find(input => input.props.keyboardType === 'url')!.props.onChangeText('https://new.test'));
  await finishProbe();
  expect(inputs().some(input => input.props.placeholder === '一次性凭据')).toBe(false);
  expect(renderer.root.findAllByType(TouchableOpacity).at(-1)!.props.disabled).toBe(true);
  expect(renderer.root.findAllByType(Text).some(item => String(item.props.children).includes('尚未配置一次性初始化凭据'))).toBe(true);
  await act(async () => renderer.unmount());
});
