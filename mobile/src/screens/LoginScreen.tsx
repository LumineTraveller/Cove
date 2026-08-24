import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LogIn, Server, UserRound } from 'lucide-react-native';
import { colors } from '../theme';

interface Props {
  initialName?: string;
  initialServer?: string;
  saving: boolean;
  onSubmit: (username: string, serverURL: string) => void;
}

export function LoginScreen({ initialName = '', initialServer = '', saving, onSubmit }: Props) {
  const [username, setUsername] = useState(initialName);
  const [serverURL, setServerURL] = useState(initialServer);
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
                onChangeText={setServerURL}
                placeholder="https://example.com:3001"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                onSubmitEditing={() => canSubmit && onSubmit(username, serverURL)}
              />
            </View>
            <Text style={styles.help}>填写与桌面客户端相同的 Cove 服务器地址，此项不会被隐藏。</Text>

            <TouchableOpacity
              style={[styles.submit, !canSubmit && styles.disabled]}
              disabled={!canSubmit}
              onPress={() => onSubmit(username, serverURL)}
              activeOpacity={0.82}
            >
              <LogIn size={19} color="#0f172a" />
              <Text style={styles.submitText}>{saving ? '正在保存' : '连接服务器'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
