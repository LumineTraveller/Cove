import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AppState, Linking, Modal, NativeModules, Platform, Text, TouchableOpacity, type AppStateStatus } from 'react-native';
import { MobileUpdateButton, MobileUpdateProvider } from '../src/components/MobileUpdater';

jest.setTimeout(20000);

const feed = JSON.stringify({ schemaVersion: 1, platform: 'android', release: {
  versionName: '0.4.0', versionCode: 6, minAndroidApi: 24, packageName: 'com.cove.mobile',
  tag: 'mobile-v0.4.0', filename: 'Cove-Mobile-0.4.0.apk', size: 1024, sha256: 'a'.repeat(64), notes: '更新说明',
} });
let renderer: TestRenderer.ReactTestRenderer;
let onState: (state: AppStateStatus) => void;
const fetchFeed = jest.fn();
const getVersion = jest.fn();
const visible = () => renderer.root.findByType(Modal).props.visible;
const press = async (label: string) => {
  const button = renderer.root.findAllByType(TouchableOpacity).find(b => b.props.accessibilityLabel === label || b.findAllByType(Text).some(t => t.props.children === label));
  expect(button).toBeTruthy();
  await act(async () => button!.props.onPress());
};

beforeEach(() => {
  jest.useFakeTimers();
  Platform.OS = 'android';
  NativeModules.CoveMobileUpdate = { getInstalledVersion: getVersion, fetchUpdateFeed: fetchFeed };
  getVersion.mockReset().mockResolvedValue({ versionName: '0.3.1', versionCode: 5, androidApi: 36 });
  fetchFeed.mockReset().mockResolvedValue(feed);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, callback) => { onState = callback; return { remove: jest.fn() }; });
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  jest.restoreAllMocks();
  jest.useRealTimers();
});
async function mount() {
  await act(async () => { renderer = TestRenderer.create(<MobileUpdateProvider><MobileUpdateButton /></MobileUpdateProvider>); });
}

test('automatically detects on launch, shows notes, allows mirror switch and browser APK download', async () => {
  await mount();
  expect(visible()).toBe(false);
  await act(async () => jest.advanceTimersByTimeAsync(1001));
  expect(getVersion).toHaveBeenCalledTimes(1);
  expect(fetchFeed).toHaveBeenCalledTimes(2);
  expect(visible()).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain('更新说明');
  expect(Linking.openURL).not.toHaveBeenCalled();
  await press('Gitee');
  await press('在浏览器中下载更新');
  expect(Linking.openURL).toHaveBeenCalledWith('https://gitee.com/LumineTraveller/Cove/releases/download/mobile-v0.4.0/Cove-Mobile-0.4.0.apk');
  expect(visible()).toBe(false);
});

test('automatic network failure stays silent; manual check explains failure', async () => {
  fetchFeed.mockRejectedValue(new Error('offline'));
  await mount();
  await act(async () => jest.advanceTimersByTimeAsync(1001));
  expect(visible()).toBe(false);
  await press('检查手机端更新');
  expect(visible()).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain('均无法检查更新');
});

test('failure to open browser keeps the dialog usable with an explanatory message', async () => {
  jest.mocked(Linking.openURL).mockRejectedValue(new Error('no browser'));
  await mount();
  await act(async () => jest.advanceTimersByTimeAsync(1001));
  await press('在浏览器中下载更新');
  expect(visible()).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain('无法打开浏览器');
  await press('稍后再说');
  expect(visible()).toBe(false);
});

test('foreground checks are throttled and do not repeatedly prompt the same version', async () => {
  await mount();
  await act(async () => jest.advanceTimersByTimeAsync(1001));
  await press('稍后再说');
  await act(async () => onState('active'));
  expect(fetchFeed).toHaveBeenCalledTimes(2);
  await act(async () => jest.advanceTimersByTimeAsync(6 * 60 * 60 * 1000));
  await act(async () => onState('active'));
  expect(fetchFeed).toHaveBeenCalledTimes(4);
  expect(visible()).toBe(false);
  await press('检查手机端更新');
  expect(visible()).toBe(true);
});

test('manual re-click while checking shares request; stuck bridge times out and can close', async () => {
  getVersion.mockReturnValue(new Promise(() => {}));
  await mount();
  await press('检查手机端更新');
  await press('检查手机端更新');
  expect(getVersion).toHaveBeenCalledTimes(1);
  await act(async () => jest.advanceTimersByTimeAsync(5001));
  expect(JSON.stringify(renderer.toJSON())).toContain('更新检查超时');
  await press('关闭');
  expect(visible()).toBe(false);
});
