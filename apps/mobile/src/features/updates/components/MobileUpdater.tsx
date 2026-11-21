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
  Modal,
  NativeEventEmitter,
  NativeModules,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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
  SOURCE_NAMES,
  UPDATE_SOURCES,
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
import { type CoveColors } from '../../settings/theme';
import { useCoveTheme, useThemedStyles } from '../../settings/ThemeProvider';
import { UPDATE_DOWNLOAD_BASE_URL } from '../updateConfig';
import { subscribeClientUpgrade } from '../versionPolicy';

interface UpdateBridge {
  getInstalledVersion(): Promise<InstalledVersion>;
  getUpdateServerBaseUrl?(): Promise<string>;
  setUpdateServerBaseUrl?(address: string): Promise<string>;
  fetchUpdateFeed(source: UpdateSource, serverURL: string): Promise<string>;
  downloadApk(
    source: UpdateSource,
    serverURL: string,
    release: AndroidRelease,
    requestId: string,
  ): Promise<string>;
  cancelDownload(requestId: string): Promise<void>;
  installApk(sha256: string): Promise<void>;
  openInstallSettings(): Promise<void>;
  addListener(event: string): void;
  removeListeners(count: number): void;
}
interface DownloadProgress {
  requestId: string;
  sha256: string;
  phase: 'downloading' | 'verifying';
  receivedBytes: number;
  totalBytes: number;
}
interface DownloadOperation {
  id: string;
  release: AndroidRelease;
}
const UpdateContext = createContext<{
  version: string;
  check: () => void;
} | null>(null);
const ignoreServerSelection = (_serverURL: string) => {};
// Kept for existing login/room callers. Chat servers do not become update sources.
export function useMobileUpdateServerSelection() {
  return ignoreServerSelection;
}
const RECHECK_INTERVAL = 6 * 60 * 60 * 1000;
let downloadSequence = 0;
const bridgeFor = () => {
  const bridge = NativeModules.CoveMobileUpdate as UpdateBridge | undefined;
  if (!bridge)
    throw new Error(
      '当前安装包缺少应用内更新组件，请使用包含此功能的官方客户端。',
    );
  return bridge;
};

export function MobileUpdateButton() {
  const styles = useThemedStyles(createStyles);
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
  const { colors } = useCoveTheme();
  const styles = useThemedStyles(createStyles);
  const [version, setVersion] = useState('');
  const [visible, setVisible] = useState(false);
  const [checking, setChecking] = useState(false);
  const [required, setRequired] = useState(false);
  const [candidate, setCandidate] = useState<UpdateCandidate | null>(null);
  const [selectedSource, setSource] = useState<UpdateSource | null>(null);
  const [serverBase, setServerBase] = useState('');
  const [serverAddress, setServerAddress] = useState('');
  const [savingServer, setSavingServer] = useState(false);
  const [message, setMessage] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [verifiedHash, setVerifiedHash] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [installPermission, setInstallPermission] = useState(false);
  const openingRef = useRef(false);
  const pendingInstallSettings = useRef<{ hash: string; opened: Promise<void> } | null>(null);
  const serverAddressEdited = useRef(false);
  const serverSave = useRef(false);
  const mounted = useRef(false);
  const running = useRef(false);
  const checkGeneration = useRef(0);
  const downloadOperation = useRef<DownloadOperation | null>(null);
  const nextAutomaticCheck = useRef(0);
  const prompted = useRef<number | null>(null);
  const requiredRef = useRef(false);
  const minimum = useRef<string>(MOBILE_MINIMUM_VERSION);
  const automaticDownloadDeclined = useRef(false);
  const foreground = useRef(
    AppState.currentState !== 'background' &&
      AppState.currentState !== 'inactive',
  );
  const invalidateChecks = useCallback(() => {
    ++checkGeneration.current;
    running.current = false;
  }, []);

  const cancel = useCallback(async (background = false) => {
    const operation = downloadOperation.current;
    if (!operation) return;
    downloadOperation.current = null;
    automaticDownloadDeclined.current = true;
    if (mounted.current) {
      setDownloading(false);
      setProgress(null);
      setVerifiedHash(null);
      setMessage(
        background
          ? '应用进入后台，下载已中断。返回后可点击重试；未完成的安装包会安全重新下载。'
          : '下载已取消，未启动安装。可点击重新下载。',
      );
    }
    try {
      await withUpdateTimeout(bridgeFor().cancelDownload(operation.id), 5000);
    } catch {
      if (mounted.current && !downloadOperation.current)
        setMessage(
          '取消请求未获确认。请返回应用后重新检查更新；安装仍需要单独确认。',
        );
    }
  }, []);

  const install = useCallback(async (hash: string) => {
    if (!mounted.current || !foreground.current || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    try {
      const bridge = bridgeFor();
      if (typeof bridge.installApk !== 'function')
        throw new Error('当前安装包缺少系统安装组件。');
      await bridge.installApk(hash);
      if (mounted.current) {
        setInstallPermission(false);
        setMessage('已打开 Android 安装确认。');
      }
    } catch (error) {
      if (mounted.current) {
        const permissionRequired =
          (error as { code?: string } | null)?.code === 'INSTALL_PERMISSION_REQUIRED';
        setInstallPermission(permissionRequired);
        if (!permissionRequired) setVerifiedHash(null);
        setMessage(error instanceof Error ? error.message : '无法启动安装，请重试。');
      }
    } finally {
      openingRef.current = false;
      if (mounted.current) setOpening(false);
    }
  }, []);

  const startDownload = useCallback(
    async (update: UpdateCandidate, selected: UpdateSource, serverURL: string) => {
      if (downloadOperation.current || openingRef.current || !foreground.current) return;
      const operation = {
        id: `apk-${Date.now().toString(36)}-${++downloadSequence}`,
        release: update.release,
      };
      downloadOperation.current = operation;
      setDownloading(true);
      setProgress({
        requestId: operation.id,
        sha256: update.release.sha256,
        phase: 'downloading',
        receivedBytes: 0,
        totalBytes: update.release.size,
      });
      setVerifiedHash(null);
      setInstallPermission(false);
      setMessage('正在下载更新，请保持 Cove 在前台。');
      let verified: string | null = null;
      try {
        const bridge = bridgeFor();
        if (
          typeof bridge.downloadApk !== 'function' ||
          typeof bridge.cancelDownload !== 'function' ||
          typeof bridge.addListener !== 'function' ||
          typeof bridge.removeListeners !== 'function'
        )
          throw new Error(
            '当前安装包缺少完整的应用内更新组件，请使用包含此功能的官方客户端。',
          );
        const hash = await withUpdateTimeout(
          bridge.downloadApk(selected, selected === 'cloud' ? serverURL : '', update.release, operation.id),
          6 * 60 * 1000,
        );
        if (!mounted.current || downloadOperation.current !== operation) return;
        if (hash !== update.release.sha256)
          throw new Error('安装包校验结果与清单不一致，已拒绝安装。');
        verified = hash;
        setVerifiedHash(hash);
        setMessage('校验完成，正在打开安装确认。');
      } catch (error) {
        if (!mounted.current || downloadOperation.current !== operation) return;
        automaticDownloadDeclined.current = true;
        // The ID ensures a late timeout cannot cancel a newer download.
        try {
          void bridgeFor()
            .cancelDownload(operation.id)
            .catch(() => {});
        } catch {}
        setVerifiedHash(null);
        setMessage(
          error instanceof Error
            ? error.message
            : '更新下载或校验失败，请重试。',
        );
      } finally {
        if (downloadOperation.current === operation) {
          downloadOperation.current = null;
          if (mounted.current) {
            setDownloading(false);
            setProgress(null);
          }
        }
      }
      // Android moves Cove to the background when it opens the installer.
      // Clear the completed download first so the background callback cannot cancel it.
      if (verified) await install(verified);
    },
    [install],
  );

  const check = useCallback(
    async (manual = false) => {
      if (Platform.OS !== 'android') return;
      if (manual) setVisible(true);
      if (
        running.current ||
        downloadOperation.current ||
        openingRef.current ||
        (!manual && Date.now() < nextAutomaticCheck.current)
      )
        return;
      running.current = true;
      const generation = ++checkGeneration.current;
      const current = () =>
        mounted.current && generation === checkGeneration.current;
      setChecking(true);
      setMessage('');
      try {
        const bridge = bridgeFor();
        const installed = await withUpdateTimeout(
          bridge.getInstalledVersion(),
          5000,
        );
        if (!current()) return;
        setVersion(installed.versionName);
        requiredRef.current =
          requiredRef.current ||
          !isSupportedClientVersion(installed.versionName, minimum.current);
        setRequired(requiredRef.current);
        if (requiredRef.current) setVisible(true);
        const address = bridge.getUpdateServerBaseUrl
          ? await withUpdateTimeout(bridge.getUpdateServerBaseUrl(), 5000)
          : UPDATE_DOWNLOAD_BASE_URL;
        if (!current()) return;
        const serverURL = getMobileUpdateServerBaseUrl(address);
        setServerBase(serverURL ?? '');
        if (!serverAddressEdited.current) setServerAddress(serverURL ?? '');
        const sources: UpdateSource[] = serverURL
          ? ['github', 'cloud']
          : ['github'];
        const result = await checkAndroidUpdate(
          installed,
          s => bridge.fetchUpdateFeed(s, s === 'cloud' ? serverURL ?? '' : ''),
          sources,
        );
        if (!current()) return;
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
        if (verifiedHash !== update?.release.sha256) {
          setVerifiedHash(null);
          setInstallPermission(false);
        }
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
            `需要 Cove ${minimum.current} 或更新版本，官方更新源尚无适配安装包。请恢复网络后重试或联系管理员。`,
          );
          return;
        }
        if (update) {
          if (
            manual ||
            requiredRef.current ||
            prompted.current !== update.release.versionCode
          ) {
            prompted.current = update.release.versionCode;
            setVisible(true);
          }
          if (
            requiredRef.current &&
            !automaticDownloadDeclined.current &&
            verifiedHash !== update.release.sha256
          )
            void startDownload(update, update.sources[0], serverURL ?? '');
        }
      } catch (error) {
        if (!current()) return;
        nextAutomaticCheck.current = Date.now() + 60_000;
        setMessage(
          (error instanceof Error
            ? error.message
            : '更新检查失败，请稍后重试。') +
            (requiredRef.current
              ? ' 当前版本无法连接，请恢复网络后重试；登录记录仍保留。'
              : ''),
        );
        if (requiredRef.current) setVisible(true);
      } finally {
        if (generation === checkGeneration.current) {
          running.current = false;
          if (mounted.current) setChecking(false);
        }
      }
    },
    [startDownload, verifiedHash],
  );
  const checkRef = useRef(check);
  checkRef.current = check;

  useEffect(() => {
    mounted.current = true;
    const bridge = NativeModules.CoveMobileUpdate as UpdateBridge | undefined;
    const progressSubscription =
      Platform.OS === 'android' &&
      bridge &&
      typeof bridge.addListener === 'function' &&
      typeof bridge.removeListeners === 'function'
        ? new NativeEventEmitter(bridge).addListener(
            'CoveMobileApkProgress',
            (event: DownloadProgress) => {
              const operation = downloadOperation.current;
              if (
                !mounted.current ||
                !operation ||
                event.requestId !== operation.id ||
                event.sha256 !== operation.release.sha256 ||
                event.totalBytes !== operation.release.size ||
                !Number.isSafeInteger(event.receivedBytes) ||
                event.receivedBytes < 0 ||
                event.receivedBytes > event.totalBytes ||
                (event.phase !== 'downloading' && event.phase !== 'verifying')
              )
                return;
              setProgress(previous =>
                previous &&
                previous.requestId === event.requestId &&
                previous.receivedBytes > event.receivedBytes
                  ? previous
                  : event,
              );
            },
          )
        : undefined;
    const unsubscribe = subscribeClientUpgrade(policy => {
      minimum.current = policy.minimumClientVersion;
      requiredRef.current = true;
      setRequired(true);
      setVisible(true);
      void checkRef.current(true);
    });
    const timer = setTimeout(() => {
      void checkRef.current();
    }, 1000);
    const subscription = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      if (state === 'active') {
        const pending = pendingInstallSettings.current;
        if (pending) {
          pendingInstallSettings.current = null;
          void pending.opened.then(() => install(pending.hash), () => {});
        } else void checkRef.current(requiredRef.current);
      } else void cancel(true);
    });
    return () => {
      mounted.current = false;
      pendingInstallSettings.current = null;
      invalidateChecks();
      const operation = downloadOperation.current;
      downloadOperation.current = null;
      if (operation)
        void bridge?.cancelDownload?.(operation.id).catch(() => {});
      unsubscribe();
      clearTimeout(timer);
      subscription.remove();
      progressSubscription?.remove();
    };
  }, [cancel, install, invalidateChecks]);

  const openInstallSettings = async () => {
    if (!verifiedHash || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    try {
      const bridge = bridgeFor();
      if (typeof bridge.openInstallSettings !== 'function')
        throw new Error('当前安装包缺少系统安装权限设置组件。');
      const opened = withUpdateTimeout(bridge.openInstallSettings(), 5000);
      pendingInstallSettings.current = { hash: verifiedHash, opened };
      await opened;
      if (mounted.current)
        setMessage('允许 Cove 安装更新后，返回应用即可继续。');
    } catch (error) {
      pendingInstallSettings.current = null;
      if (mounted.current)
        setMessage(
          error instanceof Error
            ? error.message
            : '无法打开系统安装权限设置，请重试。',
        );
    } finally {
      openingRef.current = false;
      if (mounted.current) setOpening(false);
    }
  };

  const saveServer = async () => {
    if (serverSave.current || running.current || downloadOperation.current || openingRef.current) return;
    const raw = serverAddress.trim();
    const address = raw ? getMobileUpdateServerBaseUrl(raw) : '';
    if (address === null) {
      setMessage('请输入 HTTPS 更新服务器地址。');
      return;
    }
    serverSave.current = true;
    setSavingServer(true);
    try {
      const bridge = bridgeFor();
      if (!bridge.setUpdateServerBaseUrl) throw new Error('当前版本无法保存更新服务器。');
      const saved = await withUpdateTimeout(bridge.setUpdateServerBaseUrl(address), 5000);
      if (!mounted.current) return;
      serverAddressEdited.current = false;
      setServerBase(saved);
      setServerAddress(saved);
      setCandidate(null);
      setVerifiedHash(null);
      setInstallPermission(false);
      invalidateChecks();
      void check(true);
    } catch (error) {
      if (mounted.current)
        setMessage(error instanceof Error ? error.message : '无法保存更新服务器。');
    } finally {
      serverSave.current = false;
      if (mounted.current) setSavingServer(false);
    }
  };

  const close = () => {
    if (requiredRef.current || openingRef.current) return;
    void cancel();
    setVisible(false);
  };
  const percentage = progress
    ? Math.floor((progress.receivedBytes / progress.totalBytes) * 100)
    : 0;
  const source = selectedSource ?? candidate?.sources[0] ?? 'github';
  const sourceBusy = checking || downloading || opening || savingServer;
  const canDownload = candidate?.sources.includes(source) &&
    (source !== 'cloud' || (serverBase !== '' && serverAddress === serverBase));

  return (
    <UpdateContext.Provider
      value={{
        version,
        check: () => {
          void check(true);
        },
      }}
    >
      {required ? (
        <View style={styles.overlay}>
          <Text style={styles.body}>
            需要升级 Cove 后继续连接。登录记录和本地设置已保留。
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
          <ScrollView
            style={styles.card}
            contentContainerStyle={styles.cardContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.title}>
              {required
                ? '必须升级 Cove'
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
            <Text style={styles.hint}>下载源</Text>
            <View style={styles.sources}>
              {UPDATE_SOURCES.map(item => (
                <TouchableOpacity
                  key={item}
                  accessibilityRole="button"
                  accessibilityState={{ selected: item === source, disabled: sourceBusy }}
                  disabled={sourceBusy}
                  onPress={() => setSource(item)}
                  style={[styles.source, item === source && styles.selected]}
                >
                  <Text style={styles.body}>{SOURCE_NAMES[item]}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {source === 'cloud' && (
              <View style={styles.serverSettings}>
                <Text style={styles.hint}>更新服务器地址</Text>
                <TextInput
                  style={styles.serverInput}
                  accessibilityLabel="更新服务器地址"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  placeholder="https://"
                  placeholderTextColor={colors.textFaint}
                  editable={!sourceBusy}
                  value={serverAddress}
                  onChangeText={value => {
                    serverAddressEdited.current = true;
                    setServerAddress(value);
                  }}
                />
                <TouchableOpacity
                  accessibilityRole="button"
                  disabled={sourceBusy || serverAddress === serverBase}
                  onPress={() => { void saveServer(); }}
                  style={styles.secondary}
                >
                  <Text style={styles.body}>{savingServer ? '正在保存…' : '保存并检查'}</Text>
                </TouchableOpacity>
              </View>
            )}
            {checking ? (
              <ActivityIndicator color={colors.blue} style={styles.spinner} />
            ) : candidate ? (
              <>
                <ScrollView style={styles.notes}>
                  <Text style={styles.body}>
                    {candidate.release.notes || '此版本未提供更新说明。'}
                  </Text>
                </ScrollView>
                <Text style={styles.hint}>
                  安装包：{(candidate.release.size / 1024 / 1024).toFixed(1)} MB
                </Text>
                {!candidate.sources.includes(source) && (source !== 'cloud' || serverBase !== '') && (
                  <Text style={styles.hint}>此下载源暂无这个版本，请选择可用的下载源。</Text>
                )}
                {downloading ? (
                  <>
                    {progress?.phase === 'verifying' ? (
                      <>
                        <ActivityIndicator
                          color={colors.blue}
                          style={styles.spinner}
                        />
                        <Text style={styles.body}>
                          正在校验安装包、应用版本和签名…
                        </Text>
                      </>
                    ) : (
                      <>
                        <View
                          accessibilityRole="progressbar"
                          accessibilityLabel="更新下载进度"
                          accessibilityValue={{
                            min: 0,
                            max: 100,
                            now: percentage,
                          }}
                          style={styles.progressTrack}
                        >
                          <View
                            style={[
                              styles.progressFill,
                              { width: `${percentage}%` },
                            ]}
                          />
                        </View>
                        <Text style={styles.body}>
                          已下载{' '}
                          {(
                            (progress?.receivedBytes ?? 0) /
                            1024 /
                            1024
                          ).toFixed(1)}{' '}
                          / {(candidate.release.size / 1024 / 1024).toFixed(1)}{' '}
                          MB（{percentage}%）
                        </Text>
                      </>
                    )}
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
                      if (installPermission) void openInstallSettings();
                      else void install(candidate.release.sha256);
                    }}
                    style={styles.primary}
                  >
                    <Text style={styles.primaryText}>
                      {opening ? '正在打开安装确认…' : installPermission ? '打开安装权限设置' : '重新打开安装确认'}
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    accessibilityRole="button"
                    disabled={
                      sourceBusy || !canDownload ||
                      (required &&
                        !isSupportedClientVersion(
                          candidate.release.versionName,
                          minimum.current,
                        ))
                    }
                    onPress={() => {
                      if (!canDownload) return;
                      automaticDownloadDeclined.current = false;
                      void startDownload(candidate, source, serverBase);
                    }}
                    style={styles.primary}
                  >
                    <Text style={styles.primaryText}>下载并安装更新</Text>
                  </TouchableOpacity>
                )}
              </>
            ) : (
              <Text style={styles.body}>
                {message ? '未能确认更新状态。' : '未发现可用的手机端更新。'}
              </Text>
            )}
            {!!message && (
              <Text accessibilityLiveRegion="polite" style={styles.hint}>
                {message}
              </Text>
            )}
            <View style={styles.actions}>
              {!checking && (
                <TouchableOpacity
                  accessibilityRole="button"
                  disabled={sourceBusy}
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
                    {candidate ? '以后再说' : '关闭'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </ScrollView>
        </View>
      </Modal>
    </UpdateContext.Provider>
  );
}

const createStyles = (colors: CoveColors) =>
  StyleSheet.create({
    versionButton: {
      minHeight: 44,
      justifyContent: 'center',
      alignSelf: 'center',
      padding: 10,
    },
    version: { color: colors.textFaint, fontSize: 11 },
    overlay: {
      flex: 1,
      backgroundColor: colors.overlay,
      justifyContent: 'center',
      padding: 20,
      alignItems: 'center',
    },
    card: {
      width: '100%',
      maxWidth: 560,
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 22,
      maxHeight: '85%',
    },
    cardContent: { padding: 22 },
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
    serverSettings: { marginBottom: 12 },
    serverInput: {
      minHeight: 44,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      color: colors.text,
      paddingHorizontal: 12,
    },
    sources: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
      marginVertical: 6,
    },
    source: {
      minHeight: 44,
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 14,
    },
    selected: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
    progressTrack: {
      height: 8,
      borderRadius: 4,
      overflow: 'hidden',
      backgroundColor: colors.blueSoft,
      marginVertical: 12,
    },
    progressFill: { height: '100%', backgroundColor: colors.blue },
    primary: {
      backgroundColor: colors.blue,
      borderRadius: 12,
      alignItems: 'center',
      padding: 13,
      marginTop: 12,
    },
    primaryText: { color: colors.onPrimary, fontSize: 14, fontWeight: '700' },
    secondary: {
      minHeight: 44,
      justifyContent: 'center',
      padding: 10,
      alignItems: 'center',
    },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 },
  });
