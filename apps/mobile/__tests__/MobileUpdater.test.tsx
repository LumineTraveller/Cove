import TestRenderer, { act } from 'react-test-renderer';
import { useEffect } from 'react';
import {
  AppState,
  DeviceEventEmitter,
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
  useMobileUpdateServerSelection,
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
  versionCode: 17,
  minAndroidApi: 24,
  packageName: 'com.cove.mobile',
  tag: 'mobile-v0.9.0',
  filename: 'Cove-Mobile-0.9.0.apk',
  size: 1024 * 1024,
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
let renderer: TestRenderer.ReactTestRenderer | undefined;
let onState: (state: AppStateStatus) => void;
const fetchFeed = jest.fn(),
  getVersion = jest.fn(),
  download = jest.fn(),
  install = jest.fn(),
  cancelDownload = jest.fn(),
  openSettings = jest.fn();
const visible = () => renderer!.root.findByType(Modal).props.visible;
const label = (name: string) =>
  renderer!.root
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
const contents = () => JSON.stringify(renderer!.toJSON());
const requestId = () =>
  download.mock.calls[download.mock.calls.length - 1][3] as string;
const progress = (id: string, receivedBytes: number, overrides = {}) =>
  act(async () => {
    DeviceEventEmitter.emit('CoveMobileApkProgress', {
      requestId: id,
      sha256: release.sha256,
      phase: 'downloading',
      receivedBytes,
      totalBytes: release.size,
      ...overrides,
    });
  });
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
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
  getVersion.mockReset().mockResolvedValue({
    versionName: '0.8.3',
    versionCode: 16,
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
  jest.spyOn(Linking, 'openURL').mockReset().mockResolvedValue(true);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  jest.restoreAllMocks();
  jest.useRealTimers();
});
function SelectServer({ serverURL }: { serverURL: string }) {
  const selectServer = useMobileUpdateServerSelection();
  useEffect(() => {
    selectServer(serverURL);
  }, [selectServer, serverURL]);
  return null;
}
async function mount(serverURL = '') {
  await act(async () => {
    renderer = TestRenderer.create(
      <MobileUpdateProvider>
        <SelectServer serverURL={serverURL} />
        <MobileUpdateButton />
        <Text>session remains usable</Text>
      </MobileUpdateProvider>,
    );
  });
}
async function startup(serverURL = '') {
  await mount(serverURL);
  await act(async () => jest.advanceTimersByTimeAsync(1001));
}

test('startup prompts and downloads in app only after the user clicks, then requires a separate install action', async () => {
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
    expect.stringMatching(/^apk-/),
  );
  expect(install).not.toHaveBeenCalled();
  await press('安装已校验更新');
  expect(install).toHaveBeenCalledWith(release.sha256);
  expect(Linking.openURL).not.toHaveBeenCalled();
});

test('chat server selection never becomes a download source or browser fallback', async () => {
  jest.replaceProperty(updateConfig, 'UPDATE_DOWNLOAD_BASE_URL', '');
  await startup('https://untrusted-chat.example.test');
  expect(fetchFeed.mock.calls).toEqual([['github', '']]);
  expect(label('从服务器下载')).toBeUndefined();
  expect(label('打开发布页面')).toBeUndefined();
  expect(label('浏览器备用下载更新')).toBeUndefined();
  await press('下载并校验更新');
  expect(download).toHaveBeenCalledWith(
    'github',
    '',
    release,
    expect.any(String),
  );
  expect(Linking.openURL).not.toHaveBeenCalled();
});

test('a failed source uses its confirmed mirror without opening a browser', async () => {
  fetchFeed.mockImplementation(source =>
    source === 'github'
      ? Promise.reject(new Error('offline'))
      : Promise.resolve(feed()),
  );
  await startup();
  await press('下载并校验更新');
  expect(download).toHaveBeenCalledWith(
    'cloud',
    updateConfig.UPDATE_DOWNLOAD_BASE_URL,
    release,
    expect.any(String),
  );
  expect(Linking.openURL).not.toHaveBeenCalled();
});

test('offline automatic failure keeps supported sessions usable and manual retry explains it', async () => {
  fetchFeed.mockRejectedValue(new Error('offline'));
  await startup();
  expect(visible()).toBe(false);
  expect(contents()).toContain('session remains usable');
  await press('检查手机端更新');
  expect(contents()).toContain('均无法检查更新');
  fetchFeed.mockResolvedValue(feed());
  await press('重新检查');
  expect(label('下载并校验更新')).toBeTruthy();
  expect(Linking.openURL).not.toHaveBeenCalled();
});

test('foreground checks retain throttling and avoid repeating ordinary prompts', async () => {
  await startup();
  await press('以后再说');
  await act(async () => onState('active'));
  expect(fetchFeed).toHaveBeenCalledTimes(2);
  await act(async () => jest.advanceTimersByTimeAsync(6 * 60 * 60 * 1000));
  await act(async () => onState('active'));
  expect(fetchFeed).toHaveBeenCalledTimes(4);
  expect(visible()).toBe(false);
});

test.each(['0.7.9', '0.8.0-rc.1'])(
  'unsupported %s blocks connection and downloads but never auto-installs',
  async versionName => {
    getVersion.mockResolvedValue({
      versionName,
      versionCode: 12,
      androidApi: 36,
    });
    await startup();
    expect(contents()).not.toContain('session remains usable');
    expect(contents()).toContain('必须升级');
    expect(download).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
    expect(label('以后再说')).toBeUndefined();
    await act(async () =>
      renderer!.root.findByType(Modal).props.onRequestClose(),
    );
    expect(visible()).toBe(true);
  },
);

test('mandatory offline state retains credentials and a foreground check recovers', async () => {
  getVersion.mockResolvedValue({
    versionName: '0.7.9',
    versionCode: 12,
    androidApi: 36,
  });
  fetchFeed.mockRejectedValue(new Error('offline'));
  await startup();
  expect(contents()).toContain('登录记录仍保留');
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
  expect(contents()).toContain('最低要求');
});

test('incompatible feed never downloads a downgrade', async () => {
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

test('integrity failure cannot install and explicit retry verifies again', async () => {
  download.mockResolvedValue('wrong-hash');
  await startup();
  await press('下载并校验更新');
  expect(contents()).toContain('校验结果与清单不一致');
  expect(label('安装已校验更新')).toBeUndefined();
  expect(cancelDownload).toHaveBeenCalledWith(requestId());
  download.mockResolvedValue(release.sha256);
  await press('下载并校验更新');
  expect(label('安装已校验更新')).toBeTruthy();
});

test('progress comes from matching native byte counts and rejects stale, invalid or mismatched events', async () => {
  download.mockReturnValue(new Promise(() => {}));
  await startup();
  await press('下载并校验更新');
  const id = requestId();
  await progress(id, release.size / 2);
  expect(contents()).toContain('50');
  const progressbar = () =>
    renderer!.root.findAll(
      node => node.props.accessibilityLabel === '更新下载进度',
    )[0];
  expect(progressbar().props.accessibilityValue.now).toBe(50);
  await progress('old-request', release.size);
  await progress(id, release.size, { sha256: 'b'.repeat(64) });
  await progress(id, release.size, { totalBytes: release.size + 1 });
  await progress(id, release.size + 1);
  await progress(id, NaN);
  await progress(id, release.size / 4);
  expect(progressbar().props.accessibilityValue.now).toBe(50);
  await progress(id, release.size, { phase: 'verifying' });
  expect(contents()).toContain('正在校验安装包');
  expect(label('安装已校验更新')).toBeUndefined();
});

test('cancel and immediate retry isolate old completion, progress and cancellation from the new request', async () => {
  const finishes: ((hash: string) => void)[] = [];
  download.mockImplementation(
    () => new Promise(resolve => finishes.push(resolve)),
  );
  await startup();
  await press('下载并校验更新');
  const oldId = requestId();
  await press('取消下载');
  expect(cancelDownload).toHaveBeenCalledWith(oldId);
  await press('下载并校验更新');
  const newId = requestId();
  expect(newId).not.toBe(oldId);
  await act(async () => finishes[0](release.sha256));
  await progress(oldId, release.size);
  expect(label('安装已校验更新')).toBeUndefined();
  expect(label('取消下载')).toBeTruthy();
  expect(cancelDownload.mock.calls).toEqual([[oldId]]);
  await act(async () => finishes[1](release.sha256));
  expect(label('安装已校验更新')).toBeTruthy();
  expect(install).not.toHaveBeenCalled();
});

test('background interruption cancels by ID and requires an explicit safe retry', async () => {
  let finish!: (hash: string) => void;
  getVersion.mockResolvedValue({
    versionName: '0.7.9',
    versionCode: 12,
    androidApi: 36,
  });
  download.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await startup();
  const id = requestId();
  await act(async () => onState('background'));
  expect(cancelDownload).toHaveBeenCalledWith(id);
  expect(contents()).toContain('应用进入后台');
  await act(async () => finish(release.sha256));
  await act(async () => onState('active'));
  expect(download).toHaveBeenCalledTimes(1);
  expect(label('安装已校验更新')).toBeUndefined();
  await press('下载并校验更新');
  expect(download).toHaveBeenCalledTimes(2);
});

test('download deadline cancels only its request and exposes retry without installation', async () => {
  download.mockReturnValue(new Promise(() => {}));
  await startup();
  await press('下载并校验更新');
  const id = requestId();
  await act(async () => jest.advanceTimersByTimeAsync(6 * 60 * 1000 + 1));
  expect(cancelDownload).toHaveBeenCalledWith(id);
  expect(label('安装已校验更新')).toBeUndefined();
  expect(label('下载并校验更新')).toBeTruthy();
});

test('a check finishing after backgrounding never starts a new automatic download', async () => {
  const feeds: ((raw: string) => void)[] = [];
  getVersion.mockResolvedValue({
    versionName: '0.7.9',
    versionCode: 12,
    androidApi: 36,
  });
  fetchFeed.mockImplementation(
    () => new Promise(resolve => feeds.push(resolve)),
  );
  await startup();
  await act(async () => onState('background'));
  await act(async () => feeds.forEach(resolve => resolve(feed())));
  expect(download).not.toHaveBeenCalled();
  fetchFeed.mockResolvedValue(feed());
  await act(async () => onState('active'));
  expect(download).toHaveBeenCalledTimes(1);
});

test('permission refusal opens settings only by a separate user action and never auto-installs on return', async () => {
  install.mockRejectedValue(
    Object.assign(new Error('请允许安装来源'), {
      code: 'INSTALL_PERMISSION_REQUIRED',
    }),
  );
  await startup();
  await press('下载并校验更新');
  await press('安装已校验更新');
  expect(openSettings).not.toHaveBeenCalled();
  await press('打开安装权限设置');
  expect(openSettings).toHaveBeenCalledTimes(1);
  await act(async () => onState('background'));
  await act(async () => onState('active'));
  expect(install).toHaveBeenCalledTimes(1);
  expect(cancelDownload).not.toHaveBeenCalled();
  await press('安装已校验更新');
  expect(install).toHaveBeenCalledTimes(2);
  expect(openSettings).toHaveBeenCalledTimes(1);
  install.mockResolvedValue(undefined);
  await press('安装已校验更新');
  expect(install).toHaveBeenCalledTimes(3);
});

test('a changed or missing downloaded package cannot be installed again without verification', async () => {
  install.mockRejectedValue(
    Object.assign(new Error('安装包已失效，请重新校验'), {
      code: 'APK_INSTALL',
    }),
  );
  await startup();
  await press('下载并校验更新');
  await press('安装已校验更新');
  expect(label('安装已校验更新')).toBeUndefined();
  expect(label('下载并校验更新')).toBeTruthy();
});

test('missing update module gives a clear message while keeping supported sessions usable', async () => {
  delete NativeModules.CoveMobileUpdate;
  await startup();
  await press('检查手机端更新');
  expect(contents()).toContain('缺少应用内更新组件');
  expect(contents()).toContain('session remains usable');
  expect(Linking.openURL).not.toHaveBeenCalled();
});

test('storage and acceptance identity failures remain visible and never launch installation', async () => {
  download.mockRejectedValue(
    Object.assign(new Error('存储空间不足，请腾出空间后重试。'), {
      code: 'APK_STORAGE',
    }),
  );
  await startup();
  await press('下载并校验更新');
  expect(contents()).toContain('存储空间不足');
  download.mockRejectedValue(
    Object.assign(
      new Error('此独立测试包与正式 Cove 的应用身份不同，不能安装正式更新。'),
      { code: 'APK_IDENTITY' },
    ),
  );
  await press('下载并校验更新');
  expect(contents()).toContain('应用身份不同');
  expect(install).not.toHaveBeenCalled();
});

test('unmount cancels active work, and a remounted updater does not restore unverified completion', async () => {
  let finish!: (hash: string) => void;
  download.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await startup();
  await press('下载并校验更新');
  const id = requestId();
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(cancelDownload).toHaveBeenCalledWith(id);
  await act(async () => finish(release.sha256));
  await startup();
  expect(label('安装已校验更新')).toBeUndefined();
  expect(label('下载并校验更新')).toBeTruthy();
});

test('hung native version reads time out without locking the supported app', async () => {
  getVersion.mockReturnValue(new Promise(() => {}));
  await mount();
  await press('检查手机端更新');
  await act(async () => jest.advanceTimersByTimeAsync(5001));
  expect(contents()).toContain('更新检查超时');
  expect(contents()).toContain('session remains usable');
  await press('关闭');
  expect(visible()).toBe(false);
});
