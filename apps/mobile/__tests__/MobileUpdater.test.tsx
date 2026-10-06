
import TestRenderer, { act } from 'react-test-renderer';
import { AppState, Linking, Modal, NativeModules, Platform, Text, TouchableOpacity, type AppStateStatus } from 'react-native';
import { MobileUpdateButton, MobileUpdateProvider } from '../src/features/updates/components/MobileUpdater';
import * as updateConfig from '../src/features/updates/updateConfig';

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
  jest.replaceProperty(updateConfig, 'UPDATE_DOWNLOAD_BASE_URL', 'https://download.example.test');
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

test('launch without any login or chat server uses configured update server and browser APK download', async () => {
  await mount();
  expect(visible()).toBe(false);
  await act(async () => jest.advanceTimersByTimeAsync(1001));
  expect(getVersion).toHaveBeenCalledTimes(1);
  expect(fetchFeed).toHaveBeenCalledTimes(2);
  expect(fetchFeed).toHaveBeenCalledWith('cloud', updateConfig.UPDATE_DOWNLOAD_BASE_URL);
  expect(visible()).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain('更新说明');
  expect(Linking.openURL).not.toHaveBeenCalled();
  await press('更新服务器');
  await press('在浏览器中下载更新');
  expect(Linking.openURL).toHaveBeenCalledWith(`${updateConfig.UPDATE_DOWNLOAD_BASE_URL}/releases/mobile-v0.4.0/Cove-Mobile-0.4.0.apk`);
  expect(visible()).toBe(false);
});

test('an insecure download configuration falls back to GitHub', async () => {
  jest.replaceProperty(updateConfig, 'UPDATE_DOWNLOAD_BASE_URL', 'http://download.example.test');
  await mount();
  await act(async () => jest.advanceTimersByTimeAsync(1001));
  expect(fetchFeed).toHaveBeenCalledTimes(1);
  expect(fetchFeed).toHaveBeenCalledWith('github', '');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('更新服务器');
});

test('blank download address checks GitHub only on startup and manual retry', async () => {
  jest.replaceProperty(updateConfig, 'UPDATE_DOWNLOAD_BASE_URL', '');
  await mount();
  await act(async () => jest.advanceTimersByTimeAsync(1001));
  expect(fetchFeed.mock.calls).toEqual([['github', '']]);
  expect(JSON.stringify(renderer.toJSON())).not.toContain('更新服务器');
  await press('稍后再说');
  await press('检查手机端更新');
  expect(fetchFeed.mock.calls).toEqual([['github', ''], ['github', '']]);
  await press('在浏览器中下载更新');
  expect(Linking.openURL).toHaveBeenCalledWith('https://github.com/LumineTraveller/Cove/releases/download/mobile-v0.4.0/Cove-Mobile-0.4.0.apk');
});

test('custom download address is used consistently by startup, manual check and APK download', async () => {
  jest.replaceProperty(updateConfig, 'UPDATE_DOWNLOAD_BASE_URL', 'https://download.example.test/cove/');
  await mount();
  await act(async () => jest.advanceTimersByTimeAsync(1001));
  expect(fetchFeed).toHaveBeenCalledWith('cloud', 'https://download.example.test/cove');
  await press('稍后再说');
  await press('检查手机端更新');
  expect(fetchFeed).toHaveBeenCalledTimes(4);
  await press('在浏览器中下载更新');
  expect(Linking.openURL).toHaveBeenCalledWith('https://download.example.test/cove/releases/mobile-v0.4.0/Cove-Mobile-0.4.0.apk');
});

test('GitHub failure does not prevent startup update detection from configured server', async () => {
  fetchFeed.mockImplementation(source => source === 'github' ? Promise.reject(new Error('offline')) : Promise.resolve(feed));
  await mount();
  await act(async () => jest.advanceTimersByTimeAsync(1001));
  expect(visible()).toBe(true);
  await press('在浏览器中下载更新');
  expect(Linking.openURL).toHaveBeenCalledWith(`${updateConfig.UPDATE_DOWNLOAD_BASE_URL}/releases/mobile-v0.4.0/Cove-Mobile-0.4.0.apk`);
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
