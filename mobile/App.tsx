import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WifiOff } from 'lucide-react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Socket } from 'socket.io-client';
import { RoomListScreen } from './src/screens/RoomListScreen';
import { RoomScreen } from './src/screens/RoomScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { createCoveSocket } from './src/socket';
import { clearServerConfig, forgetRememberedServer, readRememberedServers, readSessionConfig, saveSessionConfig, type RememberedServer } from './src/storage';
import { colors } from './src/theme';
import type { Room, SessionConfig } from './src/types';
import { configureServerCertificate } from './src/serverCertificate';
import { MobileUpdateProvider } from './src/components/MobileUpdater';
import { authenticateAccount, type AccountAuthRequest } from './src/accountAuth';

export default function App() {
  return <SafeAreaProvider><MobileUpdateProvider><CoveSession /></MobileUpdateProvider></SafeAreaProvider>;
}

function CoveSession() {
  const insets = useSafeAreaInsets();
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [config, setConfig] = useState<SessionConfig | null>(null);
  const [rememberedServers, setRememberedServers] = useState<RememberedServer[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);

  useEffect(() => {
    readSessionConfig()
      .then(async saved => { setConfig(saved); setRememberedServers(await readRememberedServers()); })
      .catch(() => setAuthError('无法读取本机登录信息，请重新登录。'))
      .finally(() => setLoadingConfig(false));
  }, []);

  useEffect(() => {
    if (!config) {
      setSocket(null);
      setSessionReady(false);
      return;
    }

    const nextSocket = createCoveSocket(config.serverURL);
    let active = true;
    const register = () => {
      if (!active) return;
      setConnectionError(null);
      setSessionReady(false);
      nextSocket.timeout(8_000).emit('user:register', {
        username: config.username,
        avatarUrl: null,
        clientId: config.clientId,
        authToken: config.accountToken,
        platform: 'mobile',
      }, (timeoutError: Error | null, response?: { ok: boolean; error?: string }) => {
        if (!active) return;
        if (timeoutError || response?.ok === false) {
          if (response?.error?.includes('登录已失效')) {
            setSavingConfig(true);
            setSelectedRoom(null);
            setConfig(null);
            setAuthError(response.error);
            clearServerConfig().then(readRememberedServers).then(setRememberedServers).catch(() => {}).finally(() => setSavingConfig(false));
            return;
          }
          setConnectionError(response?.error ?? '服务器身份注册超时');
          setSessionReady(false);
          return;
        }
        setConnectionError(null);
        setSessionReady(true);
      });
    };
    const disconnect = () => {
      if (!active) return;
      setSessionReady(false);
      setConnectionError('服务器连接已中断，正在自动重试');
    };
    const connectError = (cause: Error) => {
      if (!active) return;
      setSessionReady(false);
      setConnectionError(`无法连接服务器：${cause.message}`);
    };

    nextSocket.on('connect', register);
    nextSocket.on('disconnect', disconnect);
    nextSocket.on('connect_error', connectError);
    setSocket(nextSocket);
    // Native HTTPS policy must be ready before HTTP polling or WSS starts.
    configureServerCertificate(config.serverURL, config.allowInvalidServerCertificate === true)
      .then(() => { if (active) nextSocket.connect(); })
      .catch(cause => { if (active) connectError(cause instanceof Error ? cause : new Error(String(cause))); });

    return () => {
      active = false;
      nextSocket.off('connect', register);
      nextSocket.off('disconnect', disconnect);
      nextSocket.off('connect_error', connectError);
      nextSocket.disconnect();
    };
  }, [config]);

  const handleLogin = async (request: AccountAuthRequest) => {
    setSavingConfig(true);
    setAuthError(null);
    try {
      await configureServerCertificate(request.serverURL, request.allowInvalidServerCertificate);
      const result = await authenticateAccount(request);
      setConfig(await saveSessionConfig({
        username: result.account.username,
        serverURL: request.serverURL,
        accountToken: result.token,
        accountId: result.account.id,
        email: result.account.email,
        allowInvalidServerCertificate: request.allowInvalidServerCertificate,
      }));
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingConfig(false);
    }
  };

  const handleChangeServer = async () => {
    if (savingConfig) return;
    setSavingConfig(true);
    try {
      // Switching servers disconnects this session, but keeps its valid login token.
      await clearServerConfig({ forgetSession: false });
      setRememberedServers(await readRememberedServers());
      setSelectedRoom(null);
      setConfig(null);
      setConnectionError(null);
      await configureServerCertificate('', false);
    } catch (error) { setConnectionError(error instanceof Error ? error.message : '无法保存服务器登录记录'); }
    finally { setSavingConfig(false); }
  };

  const handleResume = async (saved: RememberedServer) => {
    if (!saved.accountToken || savingConfig) return;
    setSavingConfig(true); setAuthError(null);
    try {
      await configureServerCertificate(saved.serverURL, saved.allowInvalidServerCertificate === true);
      setConfig(await saveSessionConfig({ ...saved, accountToken: saved.accountToken }));
    } catch (error) { setAuthError(error instanceof Error ? error.message : '无法恢复登录'); }
    finally { setSavingConfig(false); }
  };

  const handleForget = async (saved: RememberedServer) => {
    if (savingConfig) return;
    setSavingConfig(true); setAuthError(null);
    try {
      if (saved.accountToken) fetch(`${saved.serverURL}/api/auth/logout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: saved.accountToken }),
      }).catch(() => {});
      await forgetRememberedServer(saved.serverURL);
      setRememberedServers(await readRememberedServers());
    } catch (error) { setAuthError(error instanceof Error ? error.message : '无法移除登录记忆'); }
    finally { setSavingConfig(false); }
  };

  const leaveRoom = useCallback(() => setSelectedRoom(null), []);

  if (loadingConfig) {
    return (
      <View style={styles.splash}>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <View style={styles.brand}><Text style={styles.brandText}>C</Text></View>
        <ActivityIndicator color={colors.cyan} style={styles.splashSpinner} />
      </View>
    );
  }

  if (!config) {
    return <LoginScreen saving={savingConfig} error={authError} onSubmit={handleLogin}
      rememberedServers={rememberedServers} onResume={handleResume} onForget={handleForget} />;
  }

  return (
    <View style={styles.root}>
        {socket ? (
          selectedRoom ? (
            <RoomScreen
              socket={socket}
              config={config}
              room={selectedRoom}
              sessionReady={sessionReady}
              onBack={leaveRoom}
            />
          ) : (
            <RoomListScreen
              socket={socket}
              config={config}
              sessionReady={sessionReady}
              onSelectRoom={setSelectedRoom}
              onChangeServer={handleChangeServer}
            />
          )
        ) : (
          <View style={styles.splash}><ActivityIndicator color={colors.cyan} /></View>
        )}

        {connectionError && (
          <View style={[styles.connectionBanner, { top: insets.top + 10 }]}>
            <WifiOff size={16} color={colors.red} />
            <Text style={styles.connectionText} numberOfLines={2}>{connectionError}</Text>
          </View>
        )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  brand: { width: 68, height: 68, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cyanSoft, borderWidth: 1, borderColor: 'rgba(103,232,249,0.24)' },
  brandText: { color: colors.cyan, fontSize: 31, fontWeight: '800' },
  splashSpinner: { marginTop: 20 },
  connectionBanner: { position: 'absolute', right: 12, left: 12, zIndex: 100, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 13, paddingVertical: 11, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(248,113,113,0.22)', backgroundColor: 'rgba(49,19,24,0.97)' },
  connectionText: { flex: 1, color: colors.red, fontSize: 11, lineHeight: 15 },
});
