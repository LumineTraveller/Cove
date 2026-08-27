import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LogIn, Server, UserRound } from 'lucide-react-native';
import { colors } from '../theme';
import { httpsOrigin } from '../serverCertificate';
import { MobileUpdateButton } from '../components/MobileUpdater';

interface Props {
  initialName?: string;
  initialServer?: string;
  saving: boolean;
  onSubmit: (username: string, serverURL: string, allowInvalidServerCertificate: boolean) => void;
}

export function LoginScreen({ initialName = '', initialServer = '', saving, onSubmit }: Props) {
  const [username, setUsername] = useState(initialName);
  const [serverURL, setServerURL] = useState(initialServer);
  const [certificateException, setCertificateException] = useState(false);
  const canUseException = Platform.OS === 'android' && !!httpsOrigin(serverURL);
  const submit = () => onSubmit(username, serverURL, canUseException && certificateException);
  const canSubmit = !!username.trim() && !!serverURL.trim() && !saving;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.content}>
          <View style={styles.brandMark}><Text style={styles.brandLetter}>C</Text></View>
          <Text style={styles.title}>Cove</Text>
          <Text style={styles.subtitle}>朋友语音与屏幕共享</Text>

          <View style={styles.card}>
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
            {canUseException && (
              <>
                <View style={styles.certificateRow}>
                  <Text style={styles.certificateLabel}>允许此服务器使用不受信任的证书</Text>
                  <Switch accessibilityLabel="允许此服务器使用不受信任的证书" value={certificateException} onValueChange={setCertificateException} />
                </View>
                <Text style={styles.help}>仅对当前 HTTPS 主机和端口生效。开启后无法可靠核验服务器身份，请只用于你信任的服务器。</Text>
              </>
            )}

            <TouchableOpacity
              style={[styles.submit, !canSubmit && styles.disabled]}
              disabled={!canSubmit}
              onPress={submit}
              activeOpacity={0.82}
            >
              <LogIn size={19} color="#0f172a" />
              <Text style={styles.submitText}>{saving ? '正在保存' : '连接服务器'}</Text>
            </TouchableOpacity>
          </View>
          <MobileUpdateButton />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  certificateRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 8 },
  certificateLabel: { flex: 1, color: colors.textMuted, fontSize: 12 },
  safeArea: { flex: 1, backgroundColor: colors.background },
  keyboard: { flex: 1 },
  content: { flex: 1, justifyContent: 'center', paddingHorizontal: 22, paddingBottom: 26 },
  brandMark: {
    width: 68, height: 68, borderRadius: 23, alignSelf: 'center', alignItems: 'center',
    justifyContent: 'center', backgroundColor: colors.cyanSoft, borderWidth: 1,
    borderColor: 'rgba(103,232,249,0.24)',
  },
  brandLetter: { color: colors.cyan, fontSize: 31, fontWeight: '800' },
  title: { color: colors.text, fontSize: 32, fontWeight: '800', textAlign: 'center', marginTop: 17 },
  subtitle: { color: colors.textMuted, fontSize: 15, textAlign: 'center', marginTop: 7, marginBottom: 26 },
  card: { padding: 21, borderRadius: 25, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  label: { color: 'rgba(244,244,245,0.62)', fontSize: 13, fontWeight: '600', marginBottom: 8, marginLeft: 2 },
  secondLabel: { marginTop: 17 },
  inputShell: {
    height: 50, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14,
    borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(0,0,0,0.22)',
  },
  input: { flex: 1, height: '100%', color: colors.text, fontSize: 14, paddingVertical: 0 },
  help: { color: colors.textFaint, fontSize: 11, lineHeight: 17, marginTop: 9, marginHorizontal: 2 },
  submit: {
    height: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
    borderRadius: 14, backgroundColor: '#ecfeff', marginTop: 22,
  },
  submitText: { color: '#0f172a', fontSize: 15, fontWeight: '800' },
  disabled: { opacity: 0.32 },
});
