import { useCoveSession } from './src/features/connection/useCoveSession';
import { useCallback, useEffect } from 'react';

import { ActivityIndicator, StatusBar, StyleSheet, Text, View } from 'react-native';
import { WifiOff } from 'lucide-react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RoomListScreen } from './src/features/rooms/screens/RoomListScreen';
import { RoomScreen } from './src/features/rooms/screens/RoomScreen';
import { LoginScreen } from './src/features/accounts/screens/LoginScreen';


import { colors } from './src/features/settings/theme';


import { MobileUpdateProvider, useMobileUpdateServerSelection } from './src/features/updates/components/MobileUpdater';




export default function App() {
  return <SafeAreaProvider><MobileUpdateProvider><CoveSession /></MobileUpdateProvider></SafeAreaProvider>;
}

function CoveSession() {
  const { loadingConfig, config, savingConfig, authError, handleLogin, rememberedServers, handleForget, probeServerSecurity, socket, selectedRoom, sessionReady, leaveRoom, setSelectedRoom, handleChangeServer, connectionError, insets } = useCoveSession();
  const selectUpdateServer = useMobileUpdateServerSelection();
  useEffect(() => {
    if (config?.serverURL) selectUpdateServer(config.serverURL);
  }, [config?.serverURL, selectUpdateServer]);
  const probeSelectedServer = useCallback((serverURL: string, allowInvalidServerCertificate: boolean) => {
    selectUpdateServer(serverURL);
    return probeServerSecurity(serverURL, allowInvalidServerCertificate);
  }, [probeServerSecurity, selectUpdateServer]);

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
      rememberedServers={rememberedServers} onForget={handleForget} onProbeServerSecurity={probeSelectedServer} />;
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
