import { useCoveSession } from './src/features/connection/useCoveSession';
import { useCallback, useEffect } from 'react';

import {
  ActivityIndicator,
  StatusBar,
  StyleSheet,
  Text,
  View,
  Pressable,
} from 'react-native';
import { WifiOff } from 'lucide-react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RoomListScreen } from './src/features/rooms/screens/RoomListScreen';
import { RoomScreen } from './src/features/rooms/screens/RoomScreen';
import { LoginScreen } from './src/features/accounts/screens/LoginScreen';

import { type CoveColors } from './src/features/settings/theme';
import {
  CoveThemeProvider,
  useCoveTheme,
  useThemedStyles,
} from './src/features/settings/ThemeProvider';
import { BrandMark } from './src/components/CoveUi';

import {
  MobileUpdateProvider,
  useMobileUpdateServerSelection,
} from './src/features/updates/components/MobileUpdater';

export default function App() {
  return (
    <CoveThemeProvider>
      <SafeAreaProvider>
        <MobileUpdateProvider>
          <CoveSession />
        </MobileUpdateProvider>
      </SafeAreaProvider>
    </CoveThemeProvider>
  );
}

function CoveSession() {
  const { theme, colors } = useCoveTheme();
  const styles = useThemedStyles(createStyles);
  const {
    loadingConfig,
    config,
    savingConfig,
    authError,
    handleLogin,
    rememberedServers,
    lastServerURL,
    resumeError,
    retryAutoLogin,
    cancelAutoLogin,
    handleServerURLChange,
    handleForget,
    probeServerSecurity,
    invalidateServerSecurityScope,
    socket,
    selectedRoom,
    sessionReady,
    leaveRoom,
    setSelectedRoom,
    handleChangeServer,
    connectionError,
    insets,
  } = useCoveSession();
  const selectUpdateServer = useMobileUpdateServerSelection();
  useEffect(() => {
    if (config?.serverURL) selectUpdateServer(config.serverURL);
  }, [config?.serverURL, selectUpdateServer]);
  const probeSelectedServer = useCallback(
    (
      serverURL: string,
      allowInvalidServerCertificate: boolean,
      email?: string,
      isAccountScopeCurrent?: () => boolean,
    ) => {
      selectUpdateServer(serverURL);
      return probeServerSecurity(
        serverURL,
        allowInvalidServerCertificate,
        email,
        isAccountScopeCurrent,
      );
    },
    [probeServerSecurity, selectUpdateServer],
  );

  if (loadingConfig) {
    return (
      <View style={styles.splash}>
        <StatusBar
          barStyle={theme === 'dark' ? 'light-content' : 'dark-content'}
          backgroundColor={colors.background}
        />
        <BrandMark size={64} />
        <ActivityIndicator color={colors.blue} style={styles.splashSpinner} />
      </View>
    );
  }

  if (!config) {
    if (resumeError)
      return (
        <View style={styles.splash}>
          <BrandMark size={64} />
          <Text style={[styles.resumeText, { color: colors.text }]}>
            {resumeError}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={retryAutoLogin}
            style={styles.resumeButton}
          >
            <Text style={{ color: colors.blue }}>重试连接</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={cancelAutoLogin}
            style={styles.resumeButton}
          >
            <Text style={{ color: colors.text }}>返回登录</Text>
          </Pressable>
        </View>
      );
    return (
      <LoginScreen
        saving={savingConfig}
        error={authError}
        onSubmit={handleLogin}
        rememberedServers={rememberedServers}
        useRememberedSession
        lastServerURL={lastServerURL}
        onServerURLChange={handleServerURLChange}
        onForget={handleForget}
        onProbeServerSecurity={probeSelectedServer}
        onInvalidateServerSecurityScope={invalidateServerSecurityScope}
      />
    );
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
        <View style={styles.splash}>
          <ActivityIndicator color={colors.blue} />
        </View>
      )}

      {connectionError && (
        <View style={[styles.connectionBanner, { top: insets.top + 10 }]}>
          <WifiOff size={16} color={colors.red} />
          <Text style={styles.connectionText} numberOfLines={2}>
            {connectionError}
          </Text>
        </View>
      )}
    </View>
  );
}

const createStyles = (colors: CoveColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    splash: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background,
    },
    splashSpinner: { marginTop: 20 },
    resumeText: {
      marginTop: 24,
      marginHorizontal: 24,
      textAlign: 'center',
      lineHeight: 22,
    },
    resumeButton: {
      minHeight: 48,
      justifyContent: 'center',
      paddingHorizontal: 24,
    },
    connectionBanner: {
      position: 'absolute',
      right: 16,
      left: 16,
      zIndex: 100,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
      paddingHorizontal: 13,
      paddingVertical: 12,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      backgroundColor: colors.redSoft,
    },
    connectionText: {
      flex: 1,
      color: colors.red,
      fontSize: 13,
      lineHeight: 18,
    },
  });
