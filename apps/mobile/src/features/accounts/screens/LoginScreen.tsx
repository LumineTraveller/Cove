import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
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
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  LockKeyhole,
  LogIn,
  Mail,
  Server,
  UserRound,
} from 'lucide-react-native';
import type { AccountAuthRequest, AccountAuthMode } from '../accountAuth';
import { validAccountEmail } from '../accountAuth';
import {
  clearAccountPasswords,
  invalidateAccountPasswordSave,
  listAccountPasswords,
  normalizeAccountPasswordScope,
  passwordMemoryStatus,
  readAccountPassword,
  removeAccountPassword,
  PASSWORD_MEMORY_FAILED,
  PASSWORD_MEMORY_UNAVAILABLE,
  type RememberedAccountPassword,
} from '../accountPasswordMemory';
import { metrics, type CoveColors } from '../../settings/theme';
import { useCoveTheme, useThemedStyles } from '../../settings/ThemeProvider';
import { BrandMark, ThemeToggle } from '../../../components/CoveUi';
import { httpsOrigin } from '../../connection/serverCertificate';
import { MobileUpdateButton } from '../../updates/components/MobileUpdater';
import type { RememberedServer } from '../../settings/storage';
import {
  normalizeServerSecurityURL,
  readServerSecurityStatus,
  type ServerSecurityStatus,
} from '../../connection/serverSecurity';
import { useKeyboardInset } from '../../keyboard/useKeyboardInset';

type ServerSecurityProbe =
  | {
      phase: 'idle' | 'checking' | 'invalid' | 'unavailable';
      status?: undefined;
    }
  | { phase: 'ready'; status: ServerSecurityStatus };

interface Props {
  saving: boolean;
  error?: string | null;
  onSubmit: (request: AccountAuthRequest) => void;
  rememberedServers?: RememberedServer[];
  lastServerURL?: string;
  useRememberedSession?: boolean;
  onServerURLChange?: (value: string) => void;
  onForget?: (server: RememberedServer) => void;
  onProbeServerSecurity?: (
    serverURL: string,
    allowInvalidServerCertificate: boolean,
    email?: string,
  ) => Promise<ServerSecurityStatus>;
}

const noRememberedServers: RememberedServer[] = [];

export function LoginScreen({
  saving,
  error,
  onSubmit,
  rememberedServers = noRememberedServers,
  lastServerURL,
  onServerURLChange,
  onForget,
  onProbeServerSecurity,
  useRememberedSession = false,
}: Props) {
  const { theme, colors } = useCoveTheme();
  const styles = useThemedStyles(createStyles);
  const [focusedInput, setFocusedInput] = useState<string | null>(null);
  const viewport = useWindowDimensions();
  const keyboard = useKeyboardInset(18);
  const inputRefs = useRef<Record<string, TextInput | null>>({});
  const keyboardBindInput = keyboard.bindInput;
  const keyboardUnbindInput = keyboard.unbindInput;
  const bindInput = useCallback(
    (name: string) => ({
      ref: (node: TextInput | null) => {
        inputRefs.current[name] = node;
      },
      onFocus: () => {
        setFocusedInput(name);
        keyboardBindInput(inputRefs.current[name]);
      },
      onBlur: () => {
        setFocusedInput(current => (current === name ? null : current));
        keyboardUnbindInput(inputRefs.current[name]);
      },
    }),
    [keyboardBindInput, keyboardUnbindInput],
  );
  const [mode, setMode] = useState<AccountAuthMode>('login');
  const [username, setUsername] = useState('');
  const initialServerURL =
    lastServerURL ?? rememberedServers[0]?.serverURL ?? '';
  const initialAccount = rememberedServers.find(
    saved =>
      normalizeServerSecurityURL(saved.serverURL) ===
      normalizeServerSecurityURL(initialServerURL),
  );
  const [email, setEmail] = useState(initialAccount?.email ?? '');
  const [password, setPassword] = useState('');
  const [serverPassword, setServerPassword] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [serverURL, setServerURL] = useState(initialServerURL);
  const [certificateException, setCertificateException] = useState(
    initialAccount?.allowInvalidServerCertificate === true,
  );
  const [rememberAccountPassword, setRememberAccountPassword] = useState(false);
  const [passwordMemoryAvailable, setPasswordMemoryAvailable] = useState(false);
  const [passwordMemoryNotice, setPasswordMemoryNotice] = useState('');
  const [storedAccounts, setStoredAccounts] = useState<
    RememberedAccountPassword[]
  >([]);
  const mounted = useRef(false);
  const passwordFillGeneration = useRef(0);
  const accountListGeneration = useRef(0);
  const passwordFromMemory = useRef(false);
  const serverEdited = useRef(false);
  const emailEdited = useRef(false);
  const restoredScope = useRef('');
  const modeRef = useRef(mode);
  const scopeRef = useRef({ serverURL, email });
  modeRef.current = mode;
  scopeRef.current = { serverURL, email };
  const invalidatePasswordFill = useCallback(() => {
    passwordFillGeneration.current += 1;
    invalidateAccountPasswordSave(
      scopeRef.current.serverURL,
      scopeRef.current.email,
    );
    passwordFromMemory.current = false;
    setPassword('');
    setRememberAccountPassword(false);
  }, []);
  const fillRememberedPassword = useCallback(
    (address: string, account: string) => {
      const generation = ++passwordFillGeneration.current;
      const scope = normalizeAccountPasswordScope(address, account)?.key;
      if (!scope) return;
      void readAccountPassword(address, account).then(result => {
        if (
          !mounted.current ||
          generation !== passwordFillGeneration.current ||
          modeRef.current !== 'login' ||
          normalizeAccountPasswordScope(
            scopeRef.current.serverURL,
            scopeRef.current.email,
          )?.key !== scope
        )
          return;
        setPasswordMemoryAvailable(result.available && result.ok);
        setPasswordMemoryNotice(
          !result.available
            ? PASSWORD_MEMORY_UNAVAILABLE
            : !result.ok
            ? PASSWORD_MEMORY_FAILED
            : '',
        );
        if (result.ok && result.password) {
          passwordFromMemory.current = true;
          setPassword(result.password);
          setRememberAccountPassword(true);
        }
      });
    },
    [],
  );
  const refreshAccounts = useCallback(() => {
    const generation = ++accountListGeneration.current;
    void listAccountPasswords().then(result => {
      if (
        mounted.current &&
        generation === accountListGeneration.current &&
        result.ok
      )
        setStoredAccounts(result.accounts);
    });
  }, []);
  useEffect(() => {
    mounted.current = true;
    void passwordMemoryStatus().then(result => {
      if (!mounted.current) return;
      setPasswordMemoryAvailable(result.available && result.ok);
      if (!result.available || !result.ok)
        setPasswordMemoryNotice(
          result.available
            ? PASSWORD_MEMORY_FAILED
            : PASSWORD_MEMORY_UNAVAILABLE,
        );
    });
    refreshAccounts();
    return () => {
      mounted.current = false;
      passwordFillGeneration.current += 1;
      accountListGeneration.current += 1;
      invalidateAccountPasswordSave(
        scopeRef.current.serverURL,
        scopeRef.current.email,
      );
    };
  }, [refreshAccounts]);
  const [securityProbe, setSecurityProbe] = useState<ServerSecurityProbe>({
    phase: 'idle',
  });
  const [securityProbeRevision, setSecurityProbeRevision] = useState(0);
  useEffect(() => {
    if (serverEdited.current || emailEdited.current) return;
    const address = lastServerURL ?? rememberedServers[0]?.serverURL ?? '';
    const saved = rememberedServers.find(
      entry =>
        normalizeServerSecurityURL(entry.serverURL) ===
        normalizeServerSecurityURL(address),
    );
    const account = saved?.email ?? '';
    const scope = normalizeAccountPasswordScope(address, account)?.key ?? '';
    if (
      scopeRef.current.serverURL !== address ||
      scopeRef.current.email !== account
    ) {
      invalidatePasswordFill();
      scopeRef.current = { serverURL: address, email: account };
      setServerURL(address);
      setEmail(account);
      setCertificateException(saved?.allowInvalidServerCertificate === true);
    }
    if (
      scope &&
      restoredScope.current !== scope &&
      modeRef.current === 'login'
    ) {
      restoredScope.current = scope;
      fillRememberedPassword(address, account);
    }
  }, [
    rememberedServers,
    lastServerURL,
    fillRememberedPassword,
    invalidatePasswordFill,
  ]);
  const selectAccount = (
    address: string,
    account: string,
    allowInvalidCertificate = false,
  ) => {
    invalidatePasswordFill();
    serverEdited.current = true;
    emailEdited.current = true;
    scopeRef.current = { serverURL: address, email: account };
    setServerURL(address);
    setEmail(account);
    setServerPassword('');
    setBootstrapToken('');
    setCertificateException(allowInvalidCertificate);
    setPasswordMemoryNotice('');
    onServerURLChange?.(address);
    fillRememberedPassword(address, account);
  };
  const forgetPassword = (
    address: string,
    account: string,
    clearInput = true,
  ) => {
    const scope = normalizeAccountPasswordScope(address, account)?.key;
    accountListGeneration.current += 1;
    setStoredAccounts(entries =>
      entries.filter(
        entry =>
          normalizeAccountPasswordScope(entry.serverURL, entry.email)?.key !==
          scope,
      ),
    );
    if (
      normalizeAccountPasswordScope(
        scopeRef.current.serverURL,
        scopeRef.current.email,
      )?.key === scope
    ) {
      if (clearInput || passwordFromMemory.current) invalidatePasswordFill();
      else {
        passwordFillGeneration.current += 1;
        setRememberAccountPassword(false);
      }
    }
    const generation = passwordFillGeneration.current;
    void removeAccountPassword(address, account).then(result => {
      if (!result.ok)
        Alert.alert(
          '未能取消密码记忆',
          '无法确认取消密码记忆，旧密码可能仍保存在本机，请重试。',
        );
      if (!mounted.current) return;
      if (!result.ok && generation === passwordFillGeneration.current)
        setPasswordMemoryNotice(PASSWORD_MEMORY_FAILED);
      refreshAccounts();
    });
  };
  const canUseException = Platform.OS === 'android' && !!httpsOrigin(serverURL);
  useEffect(() => {
    if (saving) return;
    const normalized = normalizeServerSecurityURL(serverURL);
    if (!serverURL.trim()) {
      setSecurityProbe({ phase: 'idle' });
      return;
    }
    if (!normalized) {
      setSecurityProbe({ phase: 'invalid' });
      return;
    }
    let active = true;
    setSecurityProbe({ phase: 'checking' });
    const timer = setTimeout(() => {
      const probe = onProbeServerSecurity
        ? onProbeServerSecurity(
            normalized,
            canUseException && certificateException,
            email,
          )
        : readServerSecurityStatus(normalized);
      void probe
        .then(status => {
          if (!active) return;
          setSecurityProbe({ phase: 'ready', status });
          if (!status.enabled || status.configured) setBootstrapToken('');
          if (!status.enabled) setServerPassword('');
        })
        .catch(() => {
          if (active) setSecurityProbe({ phase: 'unavailable' });
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    serverURL,
    certificateException,
    canUseException,
    onProbeServerSecurity,
    securityProbeRevision,
    email,
    error,
    saving,
  ]);
  const securityStatus =
    securityProbe.phase === 'ready' ? securityProbe.status : null;
  const securityEnabled = securityStatus?.enabled === true;
  const serverPasswordRequired =
    securityEnabled && securityStatus?.authorized !== true;
  const bootstrapRequired =
    securityEnabled && securityStatus.configured === false;
  const bootstrapAvailable =
    bootstrapRequired && securityStatus.bootstrapAvailable;
  const securityReady = securityProbe.phase === 'ready';
  const rememberedSession =
    useRememberedSession &&
    mode === 'login' &&
    rememberedServers.find(
      saved =>
        !!saved.accountToken &&
        normalizeServerSecurityURL(saved.serverURL) ===
          normalizeServerSecurityURL(serverURL) &&
        saved.email.toLowerCase() === email.trim().toLowerCase(),
    );
  const submit = () =>
    onSubmit({
      mode,
      username,
      email,
      password,
      rememberAccountPassword,
      serverURL,
      serverPassword,
      bootstrapToken,
      allowInvalidServerCertificate: canUseException && certificateException,
    });
  const canSubmit =
    validAccountEmail(email) &&
    (!!rememberedSession || password.length >= 8) &&
    securityReady &&
    (!serverPasswordRequired || serverPassword.length >= 8) &&
    (!bootstrapRequired || (bootstrapAvailable && !!bootstrapToken.trim())) &&
    !!serverURL.trim() &&
    (mode === 'login' || !!username.trim()) &&
    !saving;
  const publicHttp =
    /^http:\/\/(?!localhost(?::|\/|$)|127\.0\.0\.1(?::|\/|$))/i.test(
      serverURL.trim(),
    );

  return (
    <SafeAreaView
      style={styles.safeArea}
      edges={['top', 'right', 'bottom', 'left']}
    >
      <StatusBar
        barStyle={theme === 'dark' ? 'light-content' : 'dark-content'}
        backgroundColor={colors.background}
      />
      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={keyboard.scrollView}
          onScroll={keyboard.onScroll}
          onLayout={keyboard.onLayout}
          onContentSizeChange={keyboard.onContentSizeChange}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[
            styles.content,
            keyboard.keyboardHeight > 0
              ? { paddingBottom: 28 + keyboard.bottomInset }
              : null,
            keyboard.keyboardHeight > 0 ? styles.contentKeyboardOpen : null,
          ]}
        >
          <View style={styles.contentColumn}>
            <View style={styles.brandHeader}>
              <View style={styles.brand}>
                <BrandMark size={44} />
                <Text style={styles.brandName}>Cove</Text>
              </View>
              <ThemeToggle />
            </View>
            {keyboard.keyboardHeight === 0 &&
              viewport.height >= 640 &&
              viewport.height >= viewport.width && (
                <Image
                  source={require('../../../../assets/cove-login-poster.png')}
                  style={styles.hero}
                  resizeMode="cover"
                  accessible={false}
                  importantForAccessibility="no"
                />
              )}
            <Text style={styles.eyebrow}>
              {mode === 'login' ? '欢迎回来' : '从这里开始'}
            </Text>
            <Text style={styles.title}>
              {mode === 'login' ? '登录 Cove' : '创建 Cove 账号'}
            </Text>
            <Text style={styles.subtitle}>
              {mode === 'login'
                ? '连接你的频道，继续和朋友保持联系。'
                : '创建账号后即可加入或创建频道。'}
            </Text>

            <View style={styles.card}>
              <View style={styles.modePicker}>
                {(['login', 'register'] as const).map(value => (
                  <TouchableOpacity
                    key={value}
                    style={[
                      styles.modeButton,
                      mode === value && styles.modeButtonActive,
                    ]}
                    disabled={saving}
                    onPress={() => {
                      invalidatePasswordFill();
                      modeRef.current = value;
                      setMode(value);
                    }}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: mode === value }}
                  >
                    <Text
                      style={[
                        styles.modeText,
                        mode === value && styles.modeTextActive,
                      ]}
                    >
                      {value === 'login' ? '登录' : '注册'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {mode === 'login' && rememberedServers.length > 0 && (
                <View style={styles.rememberedList}>
                  <Text style={styles.sectionLabel}>已保存账号</Text>
                  {rememberedServers.map(saved => (
                    <View key={saved.serverURL} style={styles.rememberedRow}>
                      <TouchableOpacity
                        style={styles.rememberedEntry}
                        disabled={saving}
                        onPress={() =>
                          selectAccount(
                            saved.serverURL,
                            saved.email,
                            saved.allowInvalidServerCertificate === true,
                          )
                        }
                        accessibilityLabel={`填写并连接 ${saved.serverURL}`}
                        accessibilityRole="button"
                      >
                        <Text style={styles.rememberedTitle} numberOfLines={1}>
                          {saved.serverURL}
                        </Text>
                        <Text style={styles.help} numberOfLines={1}>
                          {saved.email} · 点击继续
                        </Text>
                      </TouchableOpacity>
                      {onForget && (
                        <TouchableOpacity
                          style={styles.forgetButton}
                          disabled={saving}
                          onPress={() => {
                            forgetPassword(saved.serverURL, saved.email);
                            onForget(saved);
                          }}
                          accessibilityLabel={`忘记 ${saved.serverURL}`}
                          accessibilityRole="button"
                        >
                          <Text style={styles.forget}>忘记</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  ))}
                </View>
              )}
              {mode === 'login' &&
                storedAccounts.some(
                  account =>
                    !rememberedServers.some(
                      saved =>
                        normalizeAccountPasswordScope(
                          saved.serverURL,
                          saved.email,
                        )?.key ===
                        normalizeAccountPasswordScope(
                          account.serverURL,
                          account.email,
                        )?.key,
                    ),
                ) && (
                  <View style={styles.rememberedList}>
                    <Text style={styles.sectionLabel}>已记住密码的账号</Text>
                    {storedAccounts
                      .filter(
                        account =>
                          !rememberedServers.some(
                            saved =>
                              normalizeAccountPasswordScope(
                                saved.serverURL,
                                saved.email,
                              )?.key ===
                              normalizeAccountPasswordScope(
                                account.serverURL,
                                account.email,
                              )?.key,
                          ),
                      )
                      .map(account => (
                        <View
                          key={
                            normalizeAccountPasswordScope(
                              account.serverURL,
                              account.email,
                            )?.key
                          }
                          style={styles.rememberedRow}
                        >
                          <TouchableOpacity
                            style={styles.rememberedEntry}
                            disabled={saving}
                            accessibilityLabel={`填写已记住账号 ${account.serverURL} ${account.email}`}
                            accessibilityRole="button"
                            onPress={() =>
                              selectAccount(
                                account.serverURL,
                                account.email,
                                rememberedServers.find(
                                  saved =>
                                    normalizeServerSecurityURL(
                                      saved.serverURL,
                                    ) === account.serverURL,
                                )?.allowInvalidServerCertificate === true,
                              )
                            }
                          >
                            <Text
                              style={styles.rememberedTitle}
                              numberOfLines={1}
                            >
                              {account.serverURL}
                            </Text>
                            <Text style={styles.help} numberOfLines={1}>
                              {account.email} · 点击继续
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.forgetButton}
                            accessibilityLabel={`取消记忆 ${account.serverURL} ${account.email}`}
                            accessibilityRole="button"
                            onPress={() =>
                              forgetPassword(account.serverURL, account.email)
                            }
                          >
                            <Text style={styles.forget}>取消记忆</Text>
                          </TouchableOpacity>
                        </View>
                      ))}
                  </View>
                )}
              <View style={styles.connectionPanel}>
                <Text style={styles.sectionLabel}>服务器连接</Text>
                {!!rememberedSession && (
                  <Text style={styles.help}>
                    {serverPasswordRequired
                      ? '账号已记住，只需验证服务器密码；账号密码可留空。'
                      : '账号已记住，可直接继续登录；账号密码可留空。'}
                  </Text>
                )}
                <Text style={[styles.label, styles.secondLabel]}>
                  服务器地址
                </Text>
                <View
                  style={[
                    styles.inputShell,
                    focusedInput === 'serverURL' && styles.inputFocused,
                  ]}
                >
                  <Server size={19} color={colors.textFaint} />
                  <TextInput
                    {...bindInput('serverURL')}
                    accessibilityLabel="服务器地址"
                    style={styles.input}
                    value={serverURL}
                    editable={!saving}
                    onChangeText={value => {
                      serverEdited.current = true;
                      invalidatePasswordFill();
                      if (httpsOrigin(value) !== httpsOrigin(serverURL))
                        setCertificateException(false);
                      scopeRef.current = { serverURL: value, email };
                      setServerURL(value);
                      setServerPassword('');
                      setBootstrapToken('');
                      onServerURLChange?.(value);
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
                <Text style={styles.help}>连接到你所在的 Cove 空间。</Text>
                {securityProbe.phase === 'checking' && (
                  <View
                    style={styles.probeRow}
                    accessibilityLiveRegion="polite"
                  >
                    <ActivityIndicator size="small" color={colors.blue} />
                    <Text style={styles.probeText}>正在检查服务器…</Text>
                  </View>
                )}
                {securityProbe.phase === 'unavailable' && (
                  <View style={styles.probeError}>
                    <Text
                      style={styles.probeErrorText}
                      accessibilityRole="alert"
                    >
                      无法连接服务器，请检查地址或网络。
                    </Text>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel="重试连接服务器"
                      disabled={saving}
                      style={styles.retryButton}
                      onPress={() =>
                        setSecurityProbeRevision(value => value + 1)
                      }
                    >
                      <Text style={styles.retryText}>重试</Text>
                    </TouchableOpacity>
                  </View>
                )}
                {securityProbe.phase === 'invalid' && (
                  <Text style={styles.httpWarning} accessibilityRole="alert">
                    请输入有效的 HTTP 或 HTTPS 服务器地址。
                  </Text>
                )}
                {publicHttp && (
                  <Text style={styles.httpWarning}>
                    公网 HTTP 会明文传输服务器和账号凭据，正式使用前应配置
                    HTTPS。
                  </Text>
                )}
                {canUseException && (
                  <>
                    <View style={styles.certificateRow}>
                      <Text style={styles.certificateLabel}>
                        允许此服务器使用不受信任的证书
                      </Text>
                      <Switch
                        accessibilityLabel="允许此服务器使用不受信任的证书"
                        value={certificateException}
                        disabled={saving}
                        trackColor={{
                          false: colors.borderStrong,
                          true: colors.blue,
                        }}
                        thumbColor={colors.background}
                        onValueChange={setCertificateException}
                      />
                    </View>
                    <Text style={styles.help}>
                      仅对当前 HTTPS
                      主机和端口生效。开启后无法可靠核验服务器身份，请只用于你信任的服务器。
                    </Text>
                  </>
                )}
              </View>
              {mode === 'register' && (
                <>
                  <Text style={styles.label}>用户名</Text>
                  <View
                    style={[
                      styles.inputShell,
                      focusedInput === 'username' && styles.inputFocused,
                    ]}
                  >
                    <UserRound size={19} color={colors.textFaint} />
                    <TextInput
                      {...bindInput('username')}
                      accessibilityLabel="用户名"
                      style={styles.input}
                      value={username}
                      editable={!saving}
                      onChangeText={setUsername}
                      placeholder="你的名字"
                      placeholderTextColor={colors.textFaint}
                      autoCapitalize="none"
                      maxLength={64}
                    />
                  </View>
                </>
              )}

              <Text
                style={[
                  styles.label,
                  mode === 'register' && styles.secondLabel,
                ]}
              >
                邮箱
              </Text>
              <View
                style={[
                  styles.inputShell,
                  focusedInput === 'email' && styles.inputFocused,
                ]}
              >
                <Mail size={19} color={colors.textFaint} />
                <TextInput
                  {...bindInput('email')}
                  accessibilityLabel="邮箱"
                  style={styles.input}
                  value={email}
                  editable={!saving}
                  onChangeText={value => {
                    emailEdited.current = true;
                    invalidatePasswordFill();
                    scopeRef.current = { serverURL, email: value };
                    setEmail(value);
                  }}
                  placeholder="name@example.com"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  textContentType="emailAddress"
                />
              </View>

              <Text style={[styles.label, styles.secondLabel]}>密码</Text>
              <View
                style={[
                  styles.inputShell,
                  focusedInput === 'password' && styles.inputFocused,
                ]}
              >
                <LockKeyhole size={19} color={colors.textFaint} />
                <TextInput
                  {...bindInput('password')}
                  accessibilityLabel="账号密码"
                  style={styles.input}
                  value={password}
                  editable={!saving}
                  onChangeText={value => {
                    passwordFillGeneration.current += 1;
                    invalidateAccountPasswordSave(serverURL, email);
                    passwordFromMemory.current = false;
                    setPassword(value);
                  }}
                  placeholder="至少 8 个字符"
                  placeholderTextColor={colors.textFaint}
                  secureTextEntry
                  textContentType={
                    mode === 'register' ? 'newPassword' : 'password'
                  }
                  autoCapitalize="none"
                />
              </View>

              <View style={styles.memoryRow}>
                <TouchableOpacity
                  style={styles.memoryToggle}
                  accessibilityRole="checkbox"
                  accessibilityLabel="记住账号密码"
                  accessibilityState={{
                    checked: rememberAccountPassword,
                    disabled:
                      !rememberAccountPassword &&
                      (!passwordMemoryAvailable || saving),
                  }}
                  disabled={
                    !rememberAccountPassword &&
                    (!passwordMemoryAvailable || saving)
                  }
                  onPress={() => {
                    passwordFillGeneration.current += 1;
                    const selected = !rememberAccountPassword;
                    setRememberAccountPassword(selected);
                    if (!selected) forgetPassword(serverURL, email, false);
                  }}
                >
                  <View
                    style={[
                      styles.checkbox,
                      rememberAccountPassword && styles.checkboxChecked,
                    ]}
                  >
                    {rememberAccountPassword ? (
                      <Text style={styles.checkmark}>✓</Text>
                    ) : null}
                  </View>
                  <Text style={styles.memoryLabel}>
                    记住账号密码（系统加密）
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.clearMemoryButton}
                  accessibilityRole="button"
                  accessibilityLabel="清除已记住的账号密码"
                  onPress={() => {
                    invalidatePasswordFill();
                    accountListGeneration.current += 1;
                    setStoredAccounts([]);
                    const generation = passwordFillGeneration.current;
                    void clearAccountPasswords().then(result => {
                      if (!result.ok)
                        Alert.alert(
                          '未能清除账号密码',
                          '无法确认清除账号密码，旧密码可能仍保存在本机，请重试。',
                        );
                      if (
                        !mounted.current ||
                        generation !== passwordFillGeneration.current
                      )
                        return;
                      setPasswordMemoryNotice(
                        result.ok
                          ? '已清除记住的账号密码，账号记录仍保留。'
                          : PASSWORD_MEMORY_FAILED,
                      );
                      refreshAccounts();
                      if (result.ok)
                        void passwordMemoryStatus().then(status => {
                          if (
                            !mounted.current ||
                            generation !== passwordFillGeneration.current
                          )
                            return;
                          setPasswordMemoryAvailable(
                            status.available && status.ok,
                          );
                          if (!status.available || !status.ok)
                            setPasswordMemoryNotice(
                              status.available
                                ? PASSWORD_MEMORY_FAILED
                                : PASSWORD_MEMORY_UNAVAILABLE,
                            );
                        });
                    });
                  }}
                >
                  <Text style={styles.clearMemoryText}>清除已记住密码</Text>
                </TouchableOpacity>
              </View>
              {serverPasswordRequired && (
                <Text style={styles.help}>
                  只记住账号密码；服务器访问密码仍需填写。
                </Text>
              )}
              {passwordMemoryNotice ? (
                <Text style={styles.help} accessibilityRole="alert">
                  {passwordMemoryNotice}
                </Text>
              ) : null}

              {serverPasswordRequired && (
                <View style={styles.securityPanel}>
                  <Text style={styles.sectionLabel}>服务器访问保护</Text>
                  <Text style={[styles.label, styles.secondLabel]}>
                    服务器访问密码
                  </Text>
                  <View
                    style={[
                      styles.inputShell,
                      focusedInput === 'serverPassword' && styles.inputFocused,
                    ]}
                  >
                    <Server size={19} color={colors.textFaint} />
                    <TextInput
                      {...bindInput('serverPassword')}
                      accessibilityLabel="服务器访问密码"
                      style={styles.input}
                      value={serverPassword}
                      editable={!saving}
                      onChangeText={setServerPassword}
                      placeholder="至少 8 个字符"
                      placeholderTextColor={colors.textFaint}
                      secureTextEntry
                      textContentType="password"
                      autoCapitalize="none"
                    />
                  </View>
                  <Text style={styles.help}>
                    它独立于账号密码，用于解锁这个 Cove 服务器。
                  </Text>

                  {bootstrapAvailable && (
                    <>
                      <Text style={[styles.label, styles.secondLabel]}>
                        一次性初始化凭据
                      </Text>
                      <View
                        style={[
                          styles.inputShell,
                          focusedInput === 'bootstrapToken' &&
                            styles.inputFocused,
                        ]}
                      >
                        <LockKeyhole size={19} color={colors.textFaint} />
                        <TextInput
                          {...bindInput('bootstrapToken')}
                          accessibilityLabel="一次性初始化凭据"
                          style={styles.input}
                          value={bootstrapToken}
                          editable={!saving}
                          onChangeText={setBootstrapToken}
                          placeholder="一次性凭据"
                          placeholderTextColor={colors.textFaint}
                          secureTextEntry
                          textContentType="password"
                          autoCapitalize="none"
                        />
                      </View>
                    </>
                  )}
                  {bootstrapRequired && !bootstrapAvailable && (
                    <Text style={styles.help}>
                      服务器管理员尚未配置一次性初始化凭据，暂时无法完成初始化。
                    </Text>
                  )}
                </View>
              )}

              {error ? (
                <Text style={styles.error} accessibilityRole="alert">
                  {error}
                </Text>
              ) : null}

              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={
                  mode === 'login' ? '登录 Cove' : '注册并进入'
                }
                accessibilityState={{ disabled: !canSubmit, busy: saving }}
                style={[styles.submit, !canSubmit && styles.disabled]}
                disabled={!canSubmit}
                onPress={submit}
                activeOpacity={0.82}
              >
                {saving ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <LogIn size={19} color={colors.onPrimary} />
                )}
                <Text style={styles.submitText}>
                  {saving
                    ? '正在验证'
                    : mode === 'login'
                    ? '登录 Cove'
                    : '注册并进入'}
                </Text>
              </TouchableOpacity>
            </View>
            <MobileUpdateButton />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const createStyles = (colors: CoveColors) =>
  StyleSheet.create({
    contentColumn: {
      width: '100%',
      maxWidth: metrics.contentWidth,
      alignSelf: 'center',
    },
    brandHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 28,
    },
    brand: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    brandName: {
      color: colors.text,
      fontSize: 24,
      fontWeight: '700',
      letterSpacing: -0.7,
    },
    hero: {
      width: '100%',
      height: 160,
      borderRadius: 18,
      marginBottom: 24,
      backgroundColor: colors.blueSoft,
    },
    eyebrow: {
      color: colors.blue,
      fontSize: 13,
      fontWeight: '700',
      marginBottom: 8,
    },
    sectionLabel: {
      color: colors.textMuted,
      fontSize: 13,
      fontWeight: '700',
      lineHeight: 19,
    },
    rememberedList: { marginBottom: 18, gap: 8 },
    rememberedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 4,
      borderRadius: metrics.radius,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    rememberedEntry: {
      flex: 1,
      minWidth: 0,
      minHeight: metrics.touch,
      paddingVertical: 9,
      justifyContent: 'center',
    },
    rememberedTitle: {
      color: colors.text,
      fontSize: 13,
      fontWeight: '600',
      lineHeight: 19,
    },
    forgetButton: {
      minWidth: metrics.touch,
      minHeight: metrics.touch,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 6,
    },
    forget: { color: colors.textMuted, fontSize: 12 },
    memoryRow: {
      marginTop: 10,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: 4,
    },
    memoryToggle: {
      minHeight: metrics.touch,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
      paddingVertical: 8,
    },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: 5,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      backgroundColor: colors.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkboxChecked: { backgroundColor: colors.blue, borderColor: colors.blue },
    checkmark: {
      color: colors.onPrimary,
      fontSize: 14,
      lineHeight: 18,
      fontWeight: '700',
    },
    memoryLabel: {
      color: colors.textMuted,
      fontSize: 12,
      lineHeight: 19,
      flexShrink: 1,
    },
    clearMemoryButton: {
      minHeight: metrics.touch,
      alignSelf: 'flex-start',
      paddingVertical: 12,
      paddingHorizontal: 2,
      justifyContent: 'center',
    },
    clearMemoryText: { color: colors.blue, fontSize: 12, lineHeight: 18 },
    connectionPanel: {
      marginBottom: 20,
      paddingBottom: 20,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    securityPanel: {
      marginTop: 20,
      padding: 14,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.blueSoft,
    },
    probeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 12,
    },
    probeText: {
      color: colors.textMuted,
      fontSize: 12,
      lineHeight: 18,
      flexShrink: 1,
    },
    probeError: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 12,
      paddingLeft: 12,
      borderRadius: 12,
      backgroundColor: colors.redSoft,
    },
    probeErrorText: {
      color: colors.red,
      fontSize: 12,
      lineHeight: 19,
      flex: 1,
      paddingVertical: 10,
    },
    retryButton: {
      minHeight: metrics.touch,
      minWidth: metrics.touch,
      paddingHorizontal: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    retryText: { color: colors.red, fontSize: 13, fontWeight: '700' },
    certificateRow: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: metrics.touch,
      marginTop: 12,
      paddingVertical: 8,
      gap: 8,
    },
    certificateLabel: {
      flex: 1,
      color: colors.textMuted,
      fontSize: 12,
      lineHeight: 19,
    },
    safeArea: { flex: 1, backgroundColor: colors.background },
    keyboard: { flex: 1 },
    content: {
      flexGrow: 1,
      justifyContent: 'flex-start',
      paddingHorizontal: metrics.page,
      paddingVertical: 24,
    },
    contentKeyboardOpen: { justifyContent: 'flex-start' },
    title: {
      color: colors.text,
      fontSize: 30,
      fontWeight: '700',
      letterSpacing: -1,
      lineHeight: 38,
    },
    subtitle: {
      color: colors.textMuted,
      fontSize: 14,
      lineHeight: 22,
      marginTop: 8,
      marginBottom: 24,
    },
    card: {
      padding: 18,
      borderRadius: metrics.cardRadius,
      backgroundColor: colors.dialog,
      borderWidth: 1,
      borderColor: colors.border,
    },
    modePicker: {
      flexDirection: 'row',
      padding: 4,
      marginBottom: 18,
      borderRadius: 15,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    modeButton: {
      flex: 1,
      minHeight: metrics.touch,
      paddingVertical: 10,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
    },
    modeButtonActive: { backgroundColor: colors.dialog },
    modeText: { color: colors.textFaint, fontSize: 14, fontWeight: '700' },
    modeTextActive: { color: colors.blue },
    label: {
      color: colors.textMuted,
      fontSize: 13,
      fontWeight: '600',
      marginBottom: 8,
      marginLeft: 2,
    },
    secondLabel: { marginTop: 17 },
    inputShell: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 11,
      paddingHorizontal: 14,
      borderRadius: metrics.radius,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.input,
    },
    inputFocused: { borderColor: colors.blue, backgroundColor: colors.dialog },
    input: {
      flex: 1,
      minWidth: 0,
      minHeight: 50,
      color: colors.text,
      fontSize: 15,
      paddingVertical: 12,
    },
    help: {
      color: colors.textFaint,
      fontSize: 12,
      lineHeight: 19,
      marginTop: 9,
      marginHorizontal: 2,
    },
    httpWarning: {
      color: colors.amber,
      fontSize: 12,
      lineHeight: 19,
      marginTop: 8,
      marginHorizontal: 2,
    },
    error: {
      marginTop: 14,
      padding: 11,
      overflow: 'hidden',
      borderRadius: 12,
      color: colors.red,
      fontSize: 13,
      lineHeight: 20,
      backgroundColor: colors.redSoft,
    },
    submit: {
      minHeight: 52,
      paddingVertical: 13,
      paddingHorizontal: 14,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 9,
      borderRadius: metrics.radius,
      backgroundColor: colors.blue,
      marginTop: 22,
    },
    submitText: {
      color: colors.onPrimary,
      fontSize: 15,
      fontWeight: '700',
      flexShrink: 1,
    },
    disabled: { opacity: 0.45 },
  });
