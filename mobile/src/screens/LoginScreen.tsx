import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LockKeyhole, LogIn, Mail, Server, UserRound } from 'lucide-react-native';
import type { AccountAuthRequest, AccountAuthMode } from '../accountAuth';
import { validAccountEmail } from '../accountAuth';
import { colors } from '../theme';
import { httpsOrigin } from '../serverCertificate';
import { MobileUpdateButton } from '../components/MobileUpdater';
import type { RememberedServer } from '../storage';

interface Props {
  saving: boolean;
  error?: string | null;
  onSubmit: (request: AccountAuthRequest) => void;
  rememberedServers?: RememberedServer[];
  onResume?: (server: RememberedServer) => void;
  onForget?: (server: RememberedServer) => void;
}

export function LoginScreen({ saving, error, onSubmit, rememberedServers = [], onResume, onForget }: Props) {
  const [mode, setMode] = useState<AccountAuthMode>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState(rememberedServers[0]?.email ?? '');
  const [password, setPassword] = useState('');
  const [serverURL, setServerURL] = useState(rememberedServers[0]?.serverURL ?? '');
  const [certificateException, setCertificateException] = useState(rememberedServers[0]?.allowInvalidServerCertificate === true);
  useEffect(() => {
    const saved = rememberedServers[0];
    if (saved && !serverURL.trim() && !email.trim()) {
      setServerURL(saved.serverURL); setEmail(saved.email);
      setCertificateException(saved.allowInvalidServerCertificate === true);
    }
  }, [rememberedServers, serverURL, email]);
  const canUseException = Platform.OS === 'android' && !!httpsOrigin(serverURL);
  const submit = () => onSubmit({
    mode,
    username,
    email,
    password,
    serverURL,
    allowInvalidServerCertificate: canUseException && certificateException,
  });
  const canSubmit = validAccountEmail(email)
    && password.length >= 8
    && !!serverURL.trim()
    && (mode === 'login' || !!username.trim())
    && !saving;
  const publicHttp = /^http:\/\/(?!localhost(?::|\/|$)|127\.0\.0\.1(?::|\/|$))/i.test(serverURL.trim());

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.brandMark}><Text style={styles.brandLetter}>C</Text></View>
          <Text style={styles.title}>Cove</Text>
          <Text style={styles.subtitle}>朋友语音与屏幕共享</Text>

          <View style={styles.card}>
            {mode === 'login' && rememberedServers.length > 0 && <View style={styles.rememberedList}>
              <Text style={styles.help}>记住的服务器 · 有效登录可直接恢复</Text>
              {rememberedServers.map(saved => <View key={saved.serverURL} style={styles.rememberedRow}>
                <TouchableOpacity style={styles.rememberedEntry} disabled={saving} onPress={() => {
                  setServerURL(saved.serverURL); setEmail(saved.email); setPassword('');
                  setCertificateException(saved.allowInvalidServerCertificate === true);
                  if (saved.accountToken) onResume?.(saved);
                }} accessibilityLabel={`${saved.accountToken ? '继续连接' : '填入账号'} ${saved.serverURL}`}>
                  <Text style={styles.rememberedTitle} numberOfLines={1}>{saved.serverURL}</Text>
                  <Text style={styles.help} numberOfLines={1}>{saved.email} · {saved.accountToken ? '继续连接' : '填入账号'}</Text>
                </TouchableOpacity>
                {onForget && <TouchableOpacity disabled={saving} onPress={() => onForget(saved)} accessibilityLabel={`忘记 ${saved.serverURL}`}><Text style={styles.forget}>忘记</Text></TouchableOpacity>}
              </View>)}
            </View>}
            <View style={styles.modePicker}>
              {(['login', 'register'] as const).map(value => (
                <TouchableOpacity
                  key={value}
                  style={[styles.modeButton, mode === value && styles.modeButtonActive]}
                  onPress={() => setMode(value)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: mode === value }}
                >
                  <Text style={[styles.modeText, mode === value && styles.modeTextActive]}>{value === 'login' ? '登录' : '注册'}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {mode === 'register' && (
              <>
                <Text style={styles.label}>用户名</Text>
                <View style={styles.inputShell}>
                  <UserRound size={19} color={colors.textFaint} />
                  <TextInput
                    style={styles.input}
                    value={username}
                    onChangeText={setUsername}
                    placeholder="你的名字"
                    placeholderTextColor={colors.textFaint}
                    autoCapitalize="none"
                    maxLength={64}
                  />
                </View>
              </>
            )}

            <Text style={[styles.label, mode === 'register' && styles.secondLabel]}>邮箱</Text>
            <View style={styles.inputShell}>
              <Mail size={19} color={colors.textFaint} />
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={setEmail}
                placeholder="name@example.com"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="emailAddress"
              />
            </View>
            <Text style={styles.help}>目前只检查邮箱格式，不会发送验证邮件。</Text>

            <Text style={[styles.label, styles.secondLabel]}>密码</Text>
            <View style={styles.inputShell}>
              <LockKeyhole size={19} color={colors.textFaint} />
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                placeholder="至少 8 个字符"
                placeholderTextColor={colors.textFaint}
                secureTextEntry
                textContentType={mode === 'register' ? 'newPassword' : 'password'}
                autoCapitalize="none"
              />
            </View>

            <Text style={[styles.label, styles.secondLabel]}>服务器地址</Text>
            <View style={styles.inputShell}>
              <Server size={19} color={colors.textFaint} />
              <TextInput
                style={styles.input}
                value={serverURL}
                onChangeText={value => {
                  if (httpsOrigin(value) !== httpsOrigin(serverURL)) setCertificateException(false);
                  setServerURL(value);
                }}
                placeholder="https://example.com:3001"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                onSubmitEditing={() => canSubmit && submit()}
              />
            </View>
            <Text style={styles.help}>填写与桌面客户端相同的 Cove 服务器地址，此项不会被隐藏。</Text>
            {publicHttp && <Text style={styles.httpWarning}>公网 HTTP 会明文传输登录凭据，正式使用账号前应配置 HTTPS。</Text>}
            {canUseException && (
              <>
                <View style={styles.certificateRow}>
                  <Text style={styles.certificateLabel}>允许此服务器使用不受信任的证书</Text>
                  <Switch accessibilityLabel="允许此服务器使用不受信任的证书" value={certificateException} onValueChange={setCertificateException} />
                </View>
                <Text style={styles.help}>仅对当前 HTTPS 主机和端口生效。开启后无法可靠核验服务器身份，请只用于你信任的服务器。</Text>
              </>
            )}

            {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}

            <TouchableOpacity
              style={[styles.submit, !canSubmit && styles.disabled]}
              disabled={!canSubmit}
              onPress={submit}
              activeOpacity={0.82}
            >
              {saving ? <ActivityIndicator color="#0f172a" /> : <LogIn size={19} color="#0f172a" />}
              <Text style={styles.submitText}>{saving ? '正在验证' : mode === 'login' ? '登录 Cove' : '注册并进入'}</Text>
            </TouchableOpacity>
          </View>
          <MobileUpdateButton />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  rememberedList: { marginBottom: 18, gap: 8 },
  rememberedRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.2)' },
  rememberedEntry: { flex: 1 },
  rememberedTitle: { color: colors.textMuted, fontSize: 12 },
  forget: { color: colors.textFaint, fontSize: 11, padding: 4 },
  certificateRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 8 },
  certificateLabel: { flex: 1, color: colors.textMuted, fontSize: 12 },
  safeArea: { flex: 1, backgroundColor: colors.background },
  keyboard: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 22, paddingVertical: 28 },
  brandMark: {
    width: 68, height: 68, borderRadius: 23, alignSelf: 'center', alignItems: 'center',
    justifyContent: 'center', backgroundColor: colors.cyanSoft, borderWidth: 1,
    borderColor: 'rgba(103,232,249,0.24)',
  },
  brandLetter: { color: colors.cyan, fontSize: 31, fontWeight: '800' },
  title: { color: colors.text, fontSize: 32, fontWeight: '800', textAlign: 'center', marginTop: 17 },
  subtitle: { color: colors.textMuted, fontSize: 15, textAlign: 'center', marginTop: 7, marginBottom: 26 },
  card: { padding: 21, borderRadius: 25, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  modePicker: { flexDirection: 'row', padding: 4, marginBottom: 18, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.24)' },
  modeButton: { flex: 1, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  modeButtonActive: { backgroundColor: 'rgba(255,255,255,0.12)' },
  modeText: { color: colors.textFaint, fontSize: 13, fontWeight: '700' },
  modeTextActive: { color: colors.text },
  label: { color: 'rgba(244,244,245,0.62)', fontSize: 13, fontWeight: '600', marginBottom: 8, marginLeft: 2 },
  secondLabel: { marginTop: 17 },
  inputShell: {
    height: 50, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14,
    borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(0,0,0,0.22)',
  },
  input: { flex: 1, height: '100%', color: colors.text, fontSize: 14, paddingVertical: 0 },
  help: { color: colors.textFaint, fontSize: 11, lineHeight: 17, marginTop: 9, marginHorizontal: 2 },
  httpWarning: { color: colors.red, fontSize: 11, lineHeight: 17, marginTop: 8, marginHorizontal: 2 },
  error: { marginTop: 14, padding: 11, overflow: 'hidden', borderRadius: 12, color: colors.red, fontSize: 11, lineHeight: 16, backgroundColor: colors.redSoft },
  submit: {
    height: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
    borderRadius: 14, backgroundColor: '#ecfeff', marginTop: 22,
  },
  submitText: { color: '#0f172a', fontSize: 15, fontWeight: '800' },
  disabled: { opacity: 0.32 },
});
