import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Modal,
  NativeModules,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  compareSemanticVersions,
  isSupportedClientVersion,
} from '@cove/contracts';
import {
  checkAndroidUpdate,
  getMobileUpdateServerBaseUrl,
  manualServerApkURL,
  releaseURL,
  SOURCE_NAMES,
  withUpdateTimeout,
  type AndroidRelease,
  type InstalledVersion,
  type UpdateCandidate,
  type UpdateSource,
} from '../mobileUpdate';
import {
  MOBILE_RELEASE_VERSION,
  MOBILE_MINIMUM_VERSION,
} from '../../connection/clientVersion';
import { colors } from '../../settings/theme';
import { UPDATE_DOWNLOAD_BASE_URL } from '../updateConfig';
import { safeUpgradeURL, subscribeClientUpgrade } from '../versionPolicy';

interface UpdateBridge {
  getInstalledVersion(): Promise<InstalledVersion>;
  fetchUpdateFeed(source: UpdateSource, serverURL: string): Promise<string>;
  downloadApk(
    source: UpdateSource,
    serverURL: string,
    release: AndroidRelease,
  ): Promise<string>;
  cancelDownload(): Promise<void>;
  installApk(sha256: string): Promise<void>;
  openInstallSettings(): Promise<void>;
}
const UpdateContext = createContext<{
  version: string;
  check: () => void;
  selectServer: (serverURL: string) => void;
} | null>(null);
const ignoreServerSelection = (_serverURL: string) => {};
export function useMobileUpdateServerSelection() {
  return useContext(UpdateContext)?.selectServer ?? ignoreServerSelection;
}
const RECHECK_INTERVAL = 6 * 60 * 60 * 1000;
const bridgeFor = () => {
  const bridge = NativeModules.CoveMobileUpdate as UpdateBridge | undefined;
  if (!bridge)
    throw new Error('当前安装包未包含更新模块，请手动安装新版手机端。');
  return bridge;
};

export function MobileUpdateButton() {
  const updater = useContext(UpdateContext);
  if (!updater || Platform.OS !== 'android') return null;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="检查手机端更新"
      onPress={updater.check}
      style={styles.versionButton}
    >
      <Text style={styles.version}>
        Cove {updater.version ? `v${updater.version}` : 'Mobile'} · 检查更新
      </Text>
    </TouchableOpacity>
  );
}

export function MobileUpdateProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState('');
  const [visible, setVisible] = useState(false);
  const [checking, setChecking] = useState(false);
  const [required, setRequired] = useState(false);
  const [candidate, setCandidate] = useState<UpdateCandidate | null>(null);
  const [source, setSource] = useState<UpdateSource>('github');
  const [message, setMessage] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [verifiedHash, setVerifiedHash] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [installPermission, setInstallPermission] = useState(false);
  const [manualServerURL, selectServer] = useState('');
  const mounted = useRef(false);
  const running = useRef(false);
  const downloadRunning = useRef(false);
  const downloadGeneration = useRef(0);
  const nextAutomaticCheck = useRef(0);
  const prompted = useRef<number | null>(null);
  const requiredRef = useRef(false);
  const minimum = useRef<string>(MOBILE_MINIMUM_VERSION);
  const fallbackURL = useRef<string | null>(null);
  const invalidateDownload = useCallback(() => {
    ++downloadGeneration.current;
  }, []);

  const startDownload = useCallback(
    async (update: UpdateCandidate, selected: UpdateSource) => {
      if (downloadRunning.current) return;
      downloadRunning.current = true;
      const generation = ++downloadGeneration.current;
      setDownloading(true);
      setVerifiedHash(null);
      setInstallPermission(false);
      setMessage('正在通过 HTTPS 下载并校验安装包，请保持网络连接。');
      try {
        const bridge = bridgeFor();
        if (typeof bridge.downloadApk !== 'function')
          throw new Error('当前更新模块不支持校验下载，请从发布页面手动更新。');
        const serverURL =
          selected === 'cloud'
            ? getMobileUpdateServerBaseUrl(UPDATE_DOWNLOAD_BASE_URL) ?? ''
            : '';
        const hash = await withUpdateTimeout(
          bridge.downloadApk(selected, serverURL, update.release),
          6 * 60 * 1000,
        );
        if (!mounted.current || generation !== downloadGeneration.current)
          return;
        if (hash !== update.release.sha256)
          throw new Error('安装包校验结果与清单不一致，已拒绝安装。');
        setVerifiedHash(hash);
        setMessage(
          '下载完成，已校验文件、应用版本与签名。点击安装后由 Android 请求确认。',
        );
      } catch (error) {
        if (!mounted.current || generation !== downloadGeneration.current)
          return;
        void bridgeFor()
          .cancelDownload()
          .catch(() => {});
        setVerifiedHash(null);
        setMessage(
          error instanceof Error
            ? error.message
            : '更新下载或校验失败，请重试。',
        );
      } finally {
        if (generation === downloadGeneration.current) {
          downloadRunning.current = false;
          if (mounted.current) setDownloading(false);
        }
      }
    },
    [],
  );

  const check = useCallback(
    async (manual = false) => {
      if (Platform.OS !== 'android') return;
      if (manual) setVisible(true);
      if (
        running.current ||
        downloadRunning.current ||
        (!manual && Date.now() < nextAutomaticCheck.current)
      )
        return;
      running.current = true;
      setChecking(true);
      setMessage('');
      try {
        const bridge = bridgeFor();
        const installed = await withUpdateTimeout(
          bridge.getInstalledVersion(),
          5000,
        );
        if (!mounted.current) return;
        setVersion(installed.versionName);
        requiredRef.current =
          requiredRef.current ||
          !isSupportedClientVersion(installed.versionName, minimum.current);
        setRequired(requiredRef.current);
        if (requiredRef.current) setVisible(true);
        const serverURL = getMobileUpdateServerBaseUrl(
          UPDATE_DOWNLOAD_BASE_URL,
        );
        const sources: UpdateSource[] = serverURL
          ? ['github', 'cloud']
          : ['github'];
        const result = await checkAndroidUpdate(
          installed,
          s => bridge.fetchUpdateFeed(s, s === 'cloud' ? serverURL ?? '' : ''),
          sources,
        );
        if (!mounted.current) return;
        if (
          (compareSemanticVersions(
            result.minimumClientVersion,
            minimum.current,
          ) ?? 0) > 0
        )
          minimum.current = result.minimumClientVersion;
        requiredRef.current =
          requiredRef.current ||
          !isSupportedClientVersion(installed.versionName, minimum.current);
        setRequired(requiredRef.current);
        nextAutomaticCheck.current =
          Date.now() + (result.errors.length ? 60_000 : RECHECK_INTERVAL);
        const update = result.candidate;
        setCandidate(update);
        if (verifiedHash !== update?.release.sha256) setVerifiedHash(null);
        setMessage(
          result.errors.length
            ? `${result.errors.join('；')}，已使用可用来源检查。`
            : '',
        );
        if (
          requiredRef.current &&
          (!update ||
            !isSupportedClientVersion(
              update.release.versionName,
              minimum.current,
            ))
        ) {
          setVisible(true);
          setMessage(
            `需要 Cove ${minimum.current} 或更新版本，但更新源尚无适配安装包。请重试或联系服务器管理员。`,
          );
          return;
        }
        if (update) {
          setSource(update.sources[0]);
          if (
            manual ||
            requiredRef.current ||
            prompted.current !== update.release.versionCode
          ) {
            prompted.current = update.release.versionCode;
            setVisible(true);
          }
          if (requiredRef.current)
            void startDownload(update, update.sources[0]);
        }
      } catch (error) {
        if (!mounted.current) return;
        nextAutomaticCheck.current = Date.now() + 60_000;
        setMessage(
          (error instanceof Error
            ? error.message
            : '更新检查失败，请稍后重试') +
            (requiredRef.current
              ? '。当前版本不能连接；请恢复网络后重试，登录记录仍保留。'
              : ''),
        );
        if (requiredRef.current) setVisible(true);
      } finally {
        running.current = false;
        if (mounted.current) setChecking(false);
      }
    },
    [startDownload, verifiedHash],
  );
  const checkRef = useRef(check);
  checkRef.current = check;

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeClientUpgrade(policy => {
      if (
        (compareSemanticVersions(
          policy.minimumClientVersion,
          minimum.current,
        ) ?? 0) > 0
      )
        minimum.current = policy.minimumClientVersion;
      fallbackURL.current = safeUpgradeURL(policy.downloadUrl);
      requiredRef.current = true;
      setRequired(true);
      setVisible(true);
      void checkRef.current(true);
    });
    const timer = setTimeout(() => {
      void checkRef.current();
    }, 1000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void checkRef.current(requiredRef.current);
    });
    return () => {
      mounted.current = false;
      invalidateDownload();
      unsubscribe();
      clearTimeout(timer);
      subscription.remove();
      const bridge = NativeModules.CoveMobileUpdate as UpdateBridge | undefined;
      if (downloadRunning.current)
        void bridge?.cancelDownload?.().catch(() => {});
    };
  }, [invalidateDownload]);

  const install = async () => {
    if (!verifiedHash || opening) return;
    setOpening(true);
    try {
      await bridgeFor().installApk(verifiedHash);
      if (mounted.current)
        setMessage('已打开 Android 安装确认。若取消安装，可返回再次点击安装。');
    } catch (error) {
      if (mounted.current) {
        setInstallPermission(
          (error as { code?: string }).code === 'INSTALL_PERMISSION_REQUIRED',
        );
        setMessage(
          error instanceof Error ? error.message : '无法启动安装，请重试。',
        );
      }
    } finally {
      if (mounted.current) setOpening(false);
    }
  };

  const openBrowser = async (download: boolean) => {
    if (!candidate || opening) return;
    setOpening(true);
    try {
      await Linking.openURL(releaseURL(candidate.release, source, download));
      if (mounted.current && !requiredRef.current) setVisible(false);
    } catch {
      if (mounted.current)
        setMessage('无法打开浏览器，请尝试另一更新源或重试。');
    } finally {
      if (mounted.current) setOpening(false);
    }
  };

  const openServerBrowser = async () => {
    if (opening || !manualServerURL) return;
    setOpening(true);
    try {
      const base = getMobileUpdateServerBaseUrl(manualServerURL);
      if (!base)
        throw new Error(
          '当前服务器没有可用的 HTTPS 下载地址，请使用 GitHub 备用下载。',
        );
      const bridge = bridgeFor();
      // This server is queried only after this explicit click, never by the
      // startup/foreground checks or the verified native APK downloader.
      const [raw, installed] = await Promise.all([
        withUpdateTimeout(bridge.fetchUpdateFeed('cloud', base)),
        withUpdateTimeout(bridge.getInstalledVersion(), 5000),
      ]);
      const url = manualServerApkURL(
        base,
        raw,
        installed,
        candidate?.release,
        minimum.current,
      );
      await Linking.openURL(url);
      if (mounted.current)
        setMessage('已在系统浏览器打开服务器安装包，请下载后手动确认安装。');
    } catch (error) {
      if (mounted.current)
        setMessage(
          (error instanceof Error ? error.message : '服务器下载失败。') +
            ' 可重试或使用 GitHub 备用下载。',
        );
    } finally {
      if (mounted.current) setOpening(false);
    }
  };

  const cancel = async () => {
    ++downloadGeneration.current;
    await bridgeFor()
      .cancelDownload()
      .catch(() => {});
    downloadRunning.current = false;
    if (mounted.current) {
      setDownloading(false);
      setVerifiedHash(null);
      setMessage('下载已取消，未启动安装。可点击下载重试。');
    }
  };
  const close = () => {
    if (!requiredRef.current) setVisible(false);
  };

  return (
    <UpdateContext.Provider
      value={{
        version,
        selectServer,
        check: () => {
          void check(true);
        },
      }}
    >
      {required ? (
        <View style={styles.overlay}>
          <Text style={styles.body}>
            需要更新 Cove 后才能连接。登录记录和本地数据已保留。
          </Text>
        </View>
      ) : (
        children
      )}
      <Modal
        visible={visible || required}
        transparent
        animationType="fade"
        onRequestClose={close}
      >
        <View style={styles.overlay}>
          <View style={styles.card}>
            <Text style={styles.title}>
              {required
                ? '必须更新 Cove'
                : checking
                ? '正在检查手机端更新'
                : candidate
                ? `发现 Cove v${candidate.release.versionName}`
                : '手机端更新'}
            </Text>
            <Text style={styles.hint}>
              当前版本：{version || MOBILE_RELEASE_VERSION}
              {required ? ` · 最低要求：${minimum.current}` : ''}
            </Text>
            {checking ? (
              <ActivityIndicator color={colors.cyan} style={styles.spinner} />
            ) : candidate ? (
              <>
                <ScrollView style={styles.notes}>
                  <Text style={styles.body}>
                    {candidate.release.notes || '此版本未提供更新说明。'}
                  </Text>
                </ScrollView>
                <Text style={styles.hint}>
                  安装包：{(candidate.release.size / 1024 / 1024).toFixed(1)} MB
                  · 下载来源
                </Text>
                <View style={styles.sources}>
                  {candidate.sources.map(s => (
                    <TouchableOpacity
                      key={s}
                      accessibilityRole="button"
                      accessibilityState={{ selected: s === source }}
                      disabled={downloading}
                      onPress={() => setSource(s)}
                      style={[styles.source, s === source && styles.selected]}
                    >
                      <Text style={styles.body}>{SOURCE_NAMES[s]}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.hint}>
                  安装包会保存到 Cove 私有目录并核验完整性与签名。安装需要你在
                  Android 确认；不会静默安装或删除登录数据。
                </Text>
                {downloading ? (
                  <>
                    <ActivityIndicator
                      color={colors.cyan}
                      style={styles.spinner}
                    />
                    <TouchableOpacity
                      accessibilityRole="button"
                      onPress={() => {
                        void cancel();
                      }}
                      style={styles.secondary}
                    >
                      <Text style={styles.body}>取消下载</Text>
                    </TouchableOpacity>
                  </>
                ) : verifiedHash === candidate.release.sha256 ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    disabled={opening}
                    onPress={() => {
                      void install();
                    }}
                    style={styles.primary}
                  >
                    <Text style={styles.primaryText}>安装已校验更新</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    accessibilityRole="button"
                    disabled={
                      opening ||
                      (required &&
                        !isSupportedClientVersion(
                          candidate.release.versionName,
                          minimum.current,
                        ))
                    }
                    onPress={() => {
                      void startDownload(candidate, source);
                    }}
                    style={styles.primary}
                  >
                    <Text style={styles.primaryText}>下载并校验更新</Text>
                  </TouchableOpacity>
                )}
                {installPermission && (
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => {
                      void bridgeFor()
                        .openInstallSettings()
                        .catch(error => setMessage(String(error)));
                    }}
                    style={styles.secondary}
                  >
                    <Text style={styles.body}>打开安装权限设置</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  accessibilityRole="button"
                  disabled={opening || downloading}
                  onPress={() => {
                    void openBrowser(source !== 'github');
                  }}
                  style={styles.secondary}
                >
                  <Text style={styles.body}>
                    {source === 'github'
                      ? '打开发布页面'
                      : '在浏览器中下载更新'}
                  </Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={styles.body}>
                {message
                  ? '未能完整确认更新状态。'
                  : '未发现可用的手机端更新。'}
              </Text>
            )}
            {!!message && <Text style={styles.hint}>{message}</Text>}
            <TouchableOpacity
              accessibilityRole="button"
              disabled={opening || downloading || !manualServerURL}
              onPress={() => {
                void openServerBrowser();
              }}
              style={styles.secondary}
            >
              <Text style={styles.body}>从服务器下载</Text>
            </TouchableOpacity>
            {!manualServerURL && (
              <Text style={styles.hint}>
                请先在登录页选择服务器，再从服务器下载。
              </Text>
            )}
            {!candidate && (
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => {
                  void Linking.openURL(
                    'https://github.com/LumineTraveller/Cove/releases',
                  ).catch(() =>
                    setMessage('无法打开 GitHub 备用下载，请重试。'),
                  );
                }}
                style={styles.secondary}
              >
                <Text style={styles.body}>GitHub 备用下载</Text>
              </TouchableOpacity>
            )}
            {required && fallbackURL.current && (
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => {
                  void Linking.openURL(fallbackURL.current!).catch(() =>
                    setMessage('无法打开下载入口，请重试。'),
                  );
                }}
                style={styles.secondary}
              >
                <Text style={styles.body}>打开服务器更新入口</Text>
              </TouchableOpacity>
            )}
            <View style={styles.actions}>
              {!checking && (
                <TouchableOpacity
                  accessibilityRole="button"
                  disabled={downloading}
                  onPress={() => {
                    void check(true);
                  }}
                  style={styles.secondary}
                >
                  <Text style={styles.body}>重新检查</Text>
                </TouchableOpacity>
              )}
              {!required && (
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={close}
                  style={styles.secondary}
                >
                  <Text style={styles.body}>
                    {candidate ? '稍后再说' : '关闭'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </UpdateContext.Provider>
  );
}

const styles = StyleSheet.create({
  versionButton: { alignSelf: 'center', padding: 10 },
  version: { color: colors.textFaint, fontSize: 11 },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 22,
    padding: 22,
    maxHeight: '85%',
  },
  title: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 10,
  },
  body: { color: colors.text, fontSize: 14, lineHeight: 21 },
  hint: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
    marginVertical: 7,
  },
  notes: { maxHeight: 220, marginVertical: 10 },
  spinner: { margin: 24 },
  sources: { flexDirection: 'row', gap: 10, marginVertical: 6 },
  source: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  selected: { borderColor: colors.cyan, backgroundColor: colors.cyanSoft },
  primary: {
    backgroundColor: colors.cyan,
    borderRadius: 12,
    alignItems: 'center',
    padding: 13,
    marginTop: 12,
  },
  primaryText: { color: '#0f172a', fontSize: 14, fontWeight: '700' },
  secondary: { padding: 10, alignItems: 'center' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 },
});
