import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator, AppState, Linking, Modal, NativeModules, Platform,
  ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { checkAndroidUpdate, releaseURL, SOURCE_NAMES, withUpdateTimeout, type InstalledVersion, type UpdateCandidate, type UpdateSource } from '../mobileUpdate';
import { colors } from '../theme';

interface UpdateBridge {
  getInstalledVersion(): Promise<InstalledVersion>;
  fetchUpdateFeed(source: UpdateSource): Promise<string>;
}
const UpdateContext = createContext<{ version: string; check: () => void } | null>(null);
const RECHECK_INTERVAL = 6 * 60 * 60 * 1000;

export function MobileUpdateButton() {
  const updater = useContext(UpdateContext);
  if (!updater || Platform.OS !== 'android') return null;
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="检查手机端更新" onPress={updater.check} style={styles.versionButton}>
      <Text style={styles.version}>Cove {updater.version ? `v${updater.version}` : 'Mobile'} · 检查更新</Text>
    </TouchableOpacity>
  );
}

export function MobileUpdateProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState('');
  const [visible, setVisible] = useState(false);
  const [checking, setChecking] = useState(false);
  const [candidate, setCandidate] = useState<UpdateCandidate | null>(null);
  const [source, setSource] = useState<UpdateSource>('github');
  const [message, setMessage] = useState('');
  const [opening, setOpening] = useState(false);
  const mounted = useRef(false);
  const running = useRef(false);
  const nextAutomaticCheck = useRef(0);
  const prompted = useRef<number | null>(null);

  const check = useCallback(async (manual = false) => {
    if (Platform.OS !== 'android') return;
    if (manual) setVisible(true);
    if (running.current || (!manual && Date.now() < nextAutomaticCheck.current)) return;
    running.current = true;
    setChecking(true);
    setCandidate(null);
    setMessage('');
    try {
      const bridge = NativeModules.CoveMobileUpdate as UpdateBridge | undefined;
      if (!bridge) throw new Error('当前安装包未包含更新模块，请安装新版手机端');
      const installed = await withUpdateTimeout(bridge.getInstalledVersion(), 5000);
      if (!mounted.current) return;
      setVersion(installed.versionName);
      const result = await checkAndroidUpdate(installed, s => bridge.fetchUpdateFeed(s));
      if (!mounted.current) return;
      // Retry soon when one mirror is unavailable; that mirror may carry a newer release.
      nextAutomaticCheck.current = Date.now() + (result.errors.length ? 60_000 : RECHECK_INTERVAL);
      setCandidate(result.candidate);
      setMessage(result.errors.length ? `${result.errors.join('；')}，已使用可用来源检查。` : '');
      if (result.candidate) {
        setSource(result.candidate.sources[0]);
        if (manual || prompted.current !== result.candidate.release.versionCode) {
          prompted.current = result.candidate.release.versionCode;
          setVisible(true);
        }
      }
    } catch (error) {
      if (!mounted.current) return;
      nextAutomaticCheck.current = Date.now() + 60_000;
      setMessage(error instanceof Error ? error.message : '更新检查失败，请稍后重试');
    } finally {
      running.current = false;
      if (mounted.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const timer = setTimeout(() => { void check(); }, 1000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void check();
    });
    return () => { mounted.current = false; clearTimeout(timer); subscription.remove(); };
  }, [check]);

  const openDownload = async (download: boolean) => {
    if (!candidate || opening) return;
    setOpening(true);
    try {
      await Linking.openURL(releaseURL(candidate.release, source, download));
      if (mounted.current) setVisible(false);
    } catch {
      if (mounted.current) setMessage('无法打开浏览器，请尝试另一更新源或打开发布页面。');
    } finally { if (mounted.current) setOpening(false); }
  };

  return (
    <UpdateContext.Provider value={{ version, check: () => { void check(true); } }}>
      {children}
      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
        <View style={styles.overlay}>
          <View style={styles.card}>
            <Text style={styles.title}>{checking ? '正在检查手机端更新' : candidate ? `发现 Cove v${candidate.release.versionName}` : '手机端更新'}</Text>
            {!!version && <Text style={styles.hint}>当前版本：{version}</Text>}
            {checking ? <ActivityIndicator color={colors.cyan} style={styles.spinner} /> : candidate ? (
              <>
                <ScrollView style={styles.notes}><Text style={styles.body}>{candidate.release.notes || '此版本未提供更新说明。'}</Text></ScrollView>
                <Text style={styles.hint}>安装包：{(candidate.release.size / 1024 / 1024).toFixed(1)} MB · 下载来源</Text>
                <View style={styles.sources}>
                  {candidate.sources.map(s => (
                    <TouchableOpacity key={s} accessibilityRole="button" accessibilityState={{ selected: s === source }} onPress={() => setSource(s)} style={[styles.source, s === source && styles.selected]}>
                      <Text style={styles.body}>{SOURCE_NAMES[s]}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.hint}>将通过浏览器下载 APK，下载后需你确认安装。不会中断通话或自动安装。</Text>
                <TouchableOpacity accessibilityRole="button" disabled={opening} onPress={() => { void openDownload(true); }} style={styles.primary}>
                  <Text style={styles.primaryText}>{opening ? '正在打开' : '在浏览器中下载更新'}</Text>
                </TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" disabled={opening} onPress={() => { void openDownload(false); }} style={styles.secondary}>
                  <Text style={styles.body}>打开发布页面</Text>
                </TouchableOpacity>
              </>
            ) : <Text style={styles.body}>{message ? '未能完整确认更新状态。' : '未发现可用的手机端更新。'}</Text>}
            {!!message && !checking && <Text style={styles.hint}>{message}</Text>}
            <View style={styles.actions}>
              {!checking && <TouchableOpacity accessibilityRole="button" onPress={() => { void check(true); }} style={styles.secondary}><Text style={styles.body}>重新检查</Text></TouchableOpacity>}
              <TouchableOpacity accessibilityRole="button" onPress={() => setVisible(false)} style={styles.secondary}><Text style={styles.body}>{candidate ? '稍后再说' : '关闭'}</Text></TouchableOpacity>
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
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 22, padding: 22, maxHeight: '85%' },
  title: { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 10 },
  body: { color: colors.text, fontSize: 14, lineHeight: 21 },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginVertical: 7 },
  notes: { maxHeight: 220, marginVertical: 10 },
  spinner: { margin: 24 },
  sources: { flexDirection: 'row', gap: 10, marginVertical: 6 },
  source: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14 },
  selected: { borderColor: colors.cyan, backgroundColor: colors.cyanSoft },
  primary: { backgroundColor: colors.cyan, borderRadius: 12, alignItems: 'center', padding: 13, marginTop: 12 },
  primaryText: { color: '#0f172a', fontSize: 14, fontWeight: '700' },
  secondary: { padding: 10, alignItems: 'center' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 },
});
