import TestRenderer, { act } from 'react-test-renderer';
import {
  AppState,
  Linking,
  Modal,
  NativeModules,
  Platform,
  Text,
  TouchableOpacity,
  type AppStateStatus,
} from 'react-native';
import {
  MobileUpdateButton,
  MobileUpdateProvider,
} from '../src/features/updates/components/MobileUpdater';
import * as updateConfig from '../src/features/updates/updateConfig';
import type { ClientUpgradePolicy } from '../src/features/updates/versionPolicy';
let mockUpgradeListener: (policy: ClientUpgradePolicy) => void;
jest.mock('../src/features/updates/versionPolicy', () => ({
  ...jest.requireActual('../src/features/updates/versionPolicy'),
  subscribeClientUpgrade: (listener: typeof mockUpgradeListener) => {
    mockUpgradeListener = listener;
    return jest.fn();
  },
}));
jest.setTimeout(20000);
const release = {
  versionName: '0.9.0',
  versionCode: 14,
  minAndroidApi: 24,
  packageName: 'com.cove.mobile',
  tag: 'mobile-v0.9.0',
  filename: 'Cove-Mobile-0.9.0.apk',
  size: 1024,
  sha256: 'a'.repeat(64),
  notes: '更新说明',
};
const feed = (item = release, minimum = '0.8.0') =>
  JSON.stringify({
    schemaVersion: 1,
    platform: 'android',
    minimumClientVersion: minimum,
    release: item,
  });
let renderer: TestRenderer.ReactTestRenderer;
let onState: (state: AppStateStatus) => void;
const fetchFeed = jest.fn(),
  getVersion = jest.fn(),
  download = jest.fn(),
  install = jest.fn(),
  cancelDownload = jest.fn(),
  openSettings = jest.fn();
const visible = () => renderer.root.findByType(Modal).props.visible;
const label = (name: string) =>
  renderer.root
    .findAllByType(TouchableOpacity)
    .find(
      button =>
        button.props.accessibilityLabel === name ||
        button.findAllByType(Text).some(text => text.props.children === name),
    );
const press = async (name: string) => {
  const button = label(name);
  expect(button).toBeTruthy();
  await act(async () => button!.props.onPress());
};
const contents = () => JSON.stringify(renderer.toJSON());
beforeEach(() => {
  jest.useFakeTimers();
  jest.replaceProperty(
    updateConfig,
    'UPDATE_DOWNLOAD_BASE_URL',
    'https://download.example.test',
  );
  Platform.OS = 'android';
  NativeModules.CoveMobileUpdate = {
    getInstalledVersion: getVersion,
    fetchUpdateFeed: fetchFeed,
    downloadApk: download,
    cancelDownload,
    installApk: install,
    openInstallSettings: openSettings,
  };
  getVersion
    .mockReset()
    .mockResolvedValue({
      versionName: '0.8.0',
      versionCode: 13,
      androidApi: 36,
    });
  fetchFeed.mockReset().mockResolvedValue(feed());
  download.mockReset().mockResolvedValue(release.sha256);
  install.mockReset().mockResolvedValue(undefined);
  cancelDownload.mockReset().mockResolvedValue(undefined);
  openSettings.mockReset().mockResolvedValue(undefined);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, callback) => {
    onState = callback;
    return { remove: jest.fn() };
  });
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  jest.restoreAllMocks();
  jest.useRealTimers();
});
async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(
      <MobileUpdateProvider>
        <MobileUpdateButton />
        <Text>session remains usable</Text>
      </MobileUpdateProvider>,
    );
  });
}
async function startup() {
  await mount();
  await act(async () => jest.advanceTimersByTimeAsync(1001));
}

test('ordinary startup prompts without login and only downloads after user clicks', async () => {
  await startup();
  expect(fetchFeed.mock.calls).toEqual([
    ['github', ''],
    ['cloud', updateConfig.UPDATE_DOWNLOAD_BASE_URL],
  ]);
  expect(visible()).toBe(true);
  expect(download).not.toHaveBeenCalled();
  expect(contents()).toContain('session remains usable');
  await press('下载并校验更新');
  expect(download).toHaveBeenCalledWith(
    'cloud',
    updateConfig.UPDATE_DOWNLOAD_BASE_URL,
    release,
  );
  expect(install).not.toHaveBeenCalled();
  await press('安装已校验更新');
  expect(install).toHaveBeenCalledWith(release.sha256);
});
test('blank download configuration checks GitHub and preserves browser release fallback', async () => {
  jest.replaceProperty(updateConfig, 'UPDATE_DOWNLOAD_BASE_URL', '');
  await startup();
  expect(fetchFeed.mock.calls).toEqual([['github', '']]);
  await press('打开发布页面');
  expect(Linking.openURL).toHaveBeenCalledWith(
    'https://github.com/LumineTraveller/Cove/releases/tag/mobile-v0.9.0',
  );
  expect(visible()).toBe(false);
});
test('partial source failure uses the mirror and ordinary browser APK fallback', async () => {
  fetchFeed.mockImplementation(source =>
    source === 'github'
      ? Promise.reject(new Error('offline'))
      : Promise.resolve(feed()),
  );
  await startup();
  await press('在浏览器中下载更新');
  expect(Linking.openURL).toHaveBeenCalledWith(
    'https://download.example.test/releases/mobile-v0.9.0/Cove-Mobile-0.9.0.apk',
  );
});
test('offline automatic failure is silent for supported clients, manual retry explains it', async () => {
  fetchFeed.mockRejectedValue(new Error('offline'));
  await startup();
  expect(visible()).toBe(false);
  expect(contents()).toContain('session remains usable');
  await press('检查手机端更新');
  expect(contents()).toContain('均无法检查更新');
});
test('foreground checks retain throttle and avoid repeated ordinary prompts', async () => {
  await startup();
  await press('稍后再说');
  await act(async () => onState('active'));
  expect(fetchFeed).toHaveBeenCalledTimes(2);
  await act(async () => jest.advanceTimersByTimeAsync(6 * 60 * 60 * 1000));
  await act(async () => onState('active'));
  expect(fetchFeed).toHaveBeenCalledTimes(4);
  expect(visible()).toBe(false);
});
test.each(['0.7.9', '0.8.0-rc.1'])(
  'unsupported %s blocks connection, auto-downloads and never auto-installs',
  async versionName => {
    getVersion.mockResolvedValue({
      versionName,
      versionCode: 12,
      androidApi: 36,
    });
    await startup();
    expect(contents()).not.toContain('session remains usable');
    expect(contents()).toContain('必须更新');
    expect(download).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
    expect(label('稍后再说')).toBeUndefined();
    await act(async () =>
      renderer.root.findByType(Modal).props.onRequestClose(),
    );
    expect(visible()).toBe(true);
  },
);
test('required offline state retains credentials and foreground retry recovers', async () => {
  getVersion.mockResolvedValue({
    versionName: '0.7.9',
    versionCode: 12,
    androidApi: 36,
  });
  fetchFeed.mockRejectedValue(new Error('offline'));
  await startup();
  expect(contents()).toContain('登录记录仍保留');
  expect(visible()).toBe(true);
  expect(download).not.toHaveBeenCalled();
  fetchFeed.mockResolvedValue(feed());
  await act(async () => onState('active'));
  expect(download).toHaveBeenCalledTimes(1);
});
test('remote policy and higher feed minimum select the mandatory upgrade path', async () => {
  const update = {
    ...release,
    versionName: '1.0.0',
    tag: 'mobile-v1.0.0',
    filename: 'Cove-Mobile-1.0.0.apk',
  };
  fetchFeed.mockResolvedValue(feed(update, '1.0.0'));
  await startup();
  expect(download).toHaveBeenCalledTimes(1);
  await act(async () =>
    mockUpgradeListener({
      minimumClientVersion: '1.0.0',
      upgradeRequired: true,
    }),
  );
  expect(contents()).not.toContain('session remains usable');
  expect(contents()).toContain('最低要求：');
});
test('incompatible feed does not download a downgrade or loop', async () => {
  getVersion.mockResolvedValue({
    versionName: '0.7.9',
    versionCode: 12,
    androidApi: 36,
  });
  fetchFeed.mockResolvedValue(
    feed({
      ...release,
      versionName: '0.7.8',
      tag: 'mobile-v0.7.8',
      filename: 'Cove-Mobile-0.7.8.apk',
    }),
  );
  await startup();
  expect(download).not.toHaveBeenCalled();
  expect(contents()).toContain('尚无适配安装包');
  expect(label('下载并校验更新')).toBeUndefined();
});
test('integrity failure cannot install, and explicit retry verifies again', async () => {
  download.mockResolvedValue('wrong-hash');
  await startup();
  await press('下载并校验更新');
  expect(contents()).toContain('校验结果与清单不一致');
  expect(label('安装已校验更新')).toBeUndefined();
  download.mockResolvedValue(release.sha256);
  await press('下载并校验更新');
  expect(label('安装已校验更新')).toBeTruthy();
});
test('cancelled download ignores late completion and never exposes stale installation', async () => {
  let finish!: (hash: string) => void;
  download.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await startup();
  await press('下载并校验更新');
  await press('取消下载');
  await act(async () => finish(release.sha256));
  expect(cancelDownload).toHaveBeenCalled();
  expect(label('安装已校验更新')).toBeUndefined();
  expect(install).not.toHaveBeenCalled();
});
test('install permission requires a separate user settings action and retry', async () => {
  install.mockRejectedValue(
    Object.assign(new Error('请自行允许安装更新'), {
      code: 'INSTALL_PERMISSION_REQUIRED',
    }),
  );
  await startup();
  await press('下载并校验更新');
  await press('安装已校验更新');
  expect(openSettings).not.toHaveBeenCalled();
  await press('打开安装权限设置');
  expect(openSettings).toHaveBeenCalledTimes(1);
  install.mockResolvedValue(undefined);
  await press('安装已校验更新');
  expect(install).toHaveBeenCalledTimes(2);
});
test('hung native version bridge times out without falsely locking supported app', async () => {
  getVersion.mockReturnValue(new Promise(() => {}));
  await mount();
  await press('检查手机端更新');
  await act(async () => jest.advanceTimersByTimeAsync(5001));
  expect(contents()).toContain('更新检查超时');
  expect(contents()).toContain('session remains usable');
  await press('关闭');
  expect(visible()).toBe(false);
});
