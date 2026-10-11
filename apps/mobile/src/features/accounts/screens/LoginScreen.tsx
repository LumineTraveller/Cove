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
import { colors } from '../../settings/theme';
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
  onServerURLChange?: (value: string) => void;
  onForget?: (server: RememberedServer) => void;
  onProbeServerSecurity?: (
    serverURL: string,
    allowInvalidServerCertificate: boolean,
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
}: Props) {
  const keyboard = useKeyboardInset(18);
  const inputRefs = useRef<Record<string, TextInput | null>>({});
  const keyboardBindInput = keyboard.bindInput;
  const keyboardUnbindInput = keyboard.unbindInput;
  const bindInput = useCallback(
    (name: string) => ({
      ref: (node: TextInput | null) => {
        inputRefs.current[name] = node;
      },
      onFocus: () => keyboardBindInput(inputRefs.current[name]),
      onBlur: () => keyboardUnbindInput(inputRefs.current[name]),
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
  }, [serverURL, certificateException, canUseException, onProbeServerSecurity]);
  const securityStatus =
    securityProbe.phase === 'ready' ? securityProbe.status : null;
  const securityEnabled = securityStatus?.enabled === true;
  const bootstrapRequired =
    securityEnabled && securityStatus.configured === false;
  const bootstrapAvailable =
    bootstrapRequired && securityStatus.bootstrapAvailable;
  const securityReady = securityProbe.phase === 'ready';
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
    password.length >= 8 &&
    securityReady &&
    (!securityEnabled || serverPassword.length >= 8) &&
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
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
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
          <View style={styles.brandMark}>
            <Image
              source={require('../../../../assets/cove-icon.png')}
              style={styles.brandIcon}
              accessibilityLabel="Cove"
            />
          </View>
          <Text style={styles.title}>Cove</Text>
          <Text style={styles.subtitle}>朋友语音与屏幕共享</Text>

          <View style={styles.card}>
            {mode === 'login' && rememberedServers.length > 0 && (
              <View style={styles.rememberedList}>
                <Text style={styles.help}>记住的服务器 · 地址和账号已保留</Text>
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
                        disabled={saving}
                        onPress={() => {
                          forgetPassword(saved.serverURL, saved.email);
                          onForget(saved);
                        }}
                        accessibilityLabel={`忘记 ${saved.serverURL}`}
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
                  <Text style={styles.help}>记住的账号密码</Text>
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
                          accessibilityLabel={`取消记忆 ${account.serverURL} ${account.email}`}
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

            {mode === 'register' && (
              <>
                <Text style={styles.label}>用户名</Text>
                <View style={styles.inputShell}>
                  <UserRound size={19} color={colors.textFaint} />
                  <TextInput
                    {...bindInput('username')}
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
              style={[styles.label, mode === 'register' && styles.secondLabel]}
            >
              邮箱
            </Text>
            <View style={styles.inputShell}>
              <Mail size={19} color={colors.textFaint} />
              <TextInput
                {...bindInput('email')}
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
            <Text style={styles.help}>
              目前只检查邮箱格式，不会发送验证邮件。
            </Text>

            <Text style={[styles.label, styles.secondLabel]}>密码</Text>
            <View style={styles.inputShell}>
              <LockKeyhole size={19} color={colors.textFaint} />
              <TextInput
                {...bindInput('password')}
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

            <View style={styles.certificateRow}>
              <TouchableOpacity
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
                <Text style={styles.certificateLabel}>
                  {rememberAccountPassword ? '☑' : '☐'} 记住账号密码
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.help}>
              只记住账号密码；服务器访问密码仍需填写。
            </Text>
            <TouchableOpacity
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
                      setPasswordMemoryAvailable(status.available && status.ok);
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
              <Text style={styles.help}>清除已记住密码</Text>
            </TouchableOpacity>
            {passwordMemoryNotice ? (
              <Text style={styles.help} accessibilityRole="alert">
                {passwordMemoryNotice}
              </Text>
            ) : null}

            {securityEnabled && (
              <>
                <Text style={[styles.label, styles.secondLabel]}>
                  服务器访问密码
                </Text>
                <View style={styles.inputShell}>
                  <Server size={19} color={colors.textFaint} />
                  <TextInput
                    {...bindInput('serverPassword')}
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
                    <View style={styles.inputShell}>
                      <LockKeyhole size={19} color={colors.textFaint} />
                      <TextInput
                        {...bindInput('bootstrapToken')}
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
              </>
            )}

            <Text style={[styles.label, styles.secondLabel]}>服务器地址</Text>
            <View style={styles.inputShell}>
              <Server size={19} color={colors.textFaint} />
              <TextInput
                {...bindInput('serverURL')}
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
            <Text style={styles.help}>
              填写与桌面客户端相同的 Cove 服务器地址，此项不会被隐藏。
            </Text>
            {securityProbe.phase === 'checking' && (
              <Text style={styles.help}>正在识别服务器状态…</Text>
            )}
            {securityProbe.phase === 'unavailable' && (
              <Text style={styles.httpWarning}>
                无法识别服务器状态，请检查地址和网络。
              </Text>
            )}
            {publicHttp && (
              <Text style={styles.httpWarning}>
                公网 HTTP 会明文传输服务器和账号凭据，正式使用前应配置 HTTPS。
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
                    onValueChange={setCertificateException}
                  />
                </View>
                <Text style={styles.help}>
                  仅对当前 HTTPS
                  主机和端口生效。开启后无法可靠核验服务器身份，请只用于你信任的服务器。
                </Text>
              </>
            )}

            {error ? (
              <Text style={styles.error} accessibilityRole="alert">
                {error}
              </Text>
            ) : null}

            <TouchableOpacity
              style={[styles.submit, !canSubmit && styles.disabled]}
              disabled={!canSubmit}
              onPress={submit}
              activeOpacity={0.82}
            >
              {saving ? (
                <ActivityIndicator color="#0f172a" />
              ) : (
                <LogIn size={19} color="#0f172a" />
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
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  rememberedList: { marginBottom: 18, gap: 8 },
  rememberedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  rememberedEntry: { flex: 1 },
  rememberedTitle: { color: colors.textMuted, fontSize: 12 },
  forget: { color: colors.textFaint, fontSize: 11, padding: 4 },
  certificateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    gap: 8,
  },
  certificateLabel: { flex: 1, color: colors.textMuted, fontSize: 12 },
  safeArea: { flex: 1, backgroundColor: colors.background },
  keyboard: { flex: 1 },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 22,
    paddingVertical: 28,
  },
  contentKeyboardOpen: { justifyContent: 'flex-start' },
  brandMark: {
    width: 68,
    height: 68,
    borderRadius: 23,
    alignSelf: 'center',
    overflow: 'hidden',
    backgroundColor: colors.cyanSoft,
    borderWidth: 1,
    borderColor: 'rgba(103,232,249,0.24)',
  },
  brandIcon: { width: '100%', height: '100%' },
  title: {
    color: colors.text,
    fontSize: 32,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: 17,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 15,
    textAlign: 'center',
    marginTop: 7,
    marginBottom: 26,
  },
  card: {
    padding: 21,
    borderRadius: 25,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modePicker: {
    flexDirection: 'row',
    padding: 4,
    marginBottom: 18,
    borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.24)',
  },
  modeButton: {
    flex: 1,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
  },
  modeButtonActive: { backgroundColor: 'rgba(255,255,255,0.12)' },
  modeText: { color: colors.textFaint, fontSize: 13, fontWeight: '700' },
  modeTextActive: { color: colors.text },
  label: {
    color: 'rgba(244,244,245,0.62)',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
    marginLeft: 2,
  },
  secondLabel: { marginTop: 17 },
  inputShell: {
    height: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(0,0,0,0.22)',
  },
  input: {
    flex: 1,
    height: '100%',
    color: colors.text,
    fontSize: 14,
    paddingVertical: 0,
  },
  help: {
    color: colors.textFaint,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 9,
    marginHorizontal: 2,
  },
  httpWarning: {
    color: colors.red,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 8,
    marginHorizontal: 2,
  },
  error: {
    marginTop: 14,
    padding: 11,
    overflow: 'hidden',
    borderRadius: 12,
    color: colors.red,
    fontSize: 11,
    lineHeight: 16,
    backgroundColor: colors.redSoft,
  },
  submit: {
    height: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    borderRadius: 14,
    backgroundColor: '#ecfeff',
    marginTop: 22,
  },
  submitText: { color: '#0f172a', fontSize: 15, fontWeight: '800' },
  disabled: { opacity: 0.32 },
});
