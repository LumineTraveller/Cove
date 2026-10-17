import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Moon, Server, Sun, UserRound } from 'lucide-react-native';
import {
  BrandMark,
  CoveButton,
  ScreenHeader,
} from '../../../components/CoveUi';
import type { SessionConfig } from '../../../types';
import { MobileUpdateButton } from '../../updates/components/MobileUpdater';
import { useCoveTheme, useThemedStyles } from '../ThemeProvider';
import { metrics, type CoveColors } from '../theme';

export function MobileSettings({
  config,
  displayName,
  onChangeServer,
}: {
  config: SessionConfig;
  displayName: string;
  onChangeServer: () => void;
}) {
  const { theme, colors, setTheme } = useCoveTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.root}>
      <ScreenHeader
        title="设置"
        subtitle="Cove 偏好设置"
        leading={<BrandMark />}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.profile}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {Array.from(displayName)[0] || '你'}
            </Text>
          </View>
          <View style={styles.profileCopy}>
            <Text style={styles.profileName}>{displayName}</Text>
            <Text style={styles.profileHint}>账号与服务器</Text>
          </View>
        </View>
        <Text style={styles.sectionTitle}>外观</Text>
        <View style={styles.themeControl}>
          {(['light', 'dark'] as const).map(mode => (
            <Pressable
              key={mode}
              accessibilityRole="button"
              accessibilityLabel={mode === 'light' ? '浅色模式' : '深色模式'}
              accessibilityState={{ selected: mode === theme }}
              onPress={() => setTheme(mode)}
              style={({ pressed }) => [
                styles.themeOption,
                mode === theme && styles.themeSelected,
                pressed && styles.pressed,
              ]}
            >
              {mode === 'light' ? (
                <Sun
                  size={19}
                  color={mode === theme ? colors.blue : colors.textMuted}
                />
              ) : (
                <Moon
                  size={19}
                  color={mode === theme ? colors.blue : colors.textMuted}
                />
              )}
              <Text
                style={[
                  styles.themeText,
                  mode === theme && styles.themeSelectedText,
                ]}
              >
                {mode === 'light' ? '浅色' : '深色'}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.sectionTitle}>账号与服务器</Text>
        <View style={styles.card}>
          <View style={styles.cardHeading}>
            <UserRound size={18} color={colors.textMuted} />
            <Text style={styles.cardTitle}>当前账号</Text>
          </View>
          <Text style={styles.fieldLabel}>昵称</Text>
          <Text selectable style={styles.value}>
            {config.username}
          </Text>
          <Text style={styles.fieldLabel}>邮箱</Text>
          <Text selectable style={styles.value}>
            {config.email}
          </Text>
          <Text style={styles.fieldLabel}>账号</Text>
          <Text selectable style={styles.value}>
            #{config.accountId.replace(/^#/, '')}
          </Text>
        </View>
        <View style={styles.card}>
          <View style={styles.cardHeading}>
            <Server size={18} color={colors.textMuted} />
            <Text style={styles.cardTitle}>服务器</Text>
          </View>
          <Text selectable style={styles.serverURL}>
            {config.serverURL}
          </Text>
          <CoveButton
            title="切换账号或服务器"
            onPress={onChangeServer}
            tone="secondary"
            icon={<Server size={18} color={colors.textMuted} />}
          />
        </View>
        <Text style={styles.sectionTitle}>应用更新</Text>
        <View style={styles.updateCard}>
          <MobileUpdateButton />
        </View>
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: CoveColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    content: {
      flexGrow: 1,
      width: '100%',
      maxWidth: metrics.contentWidth,
      alignSelf: 'center',
      padding: metrics.page,
      gap: 12,
      paddingBottom: 28,
    },
    profile: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      paddingVertical: 8,
      marginBottom: 6,
    },
    avatar: {
      width: 56,
      height: 56,
      borderRadius: 18,
      backgroundColor: colors.blueSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: { color: colors.blue, fontSize: 23, fontWeight: '700' },
    profileCopy: { flex: 1, minWidth: 0 },
    profileName: {
      color: colors.text,
      fontSize: 20,
      fontWeight: '700',
      lineHeight: 28,
    },
    profileHint: {
      color: colors.textMuted,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 4,
    },
    sectionTitle: {
      color: colors.textMuted,
      fontSize: 12,
      fontWeight: '700',
      lineHeight: 18,
      marginTop: 10,
    },
    themeControl: {
      flexDirection: 'row',
      gap: 4,
      padding: 4,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      backgroundColor: colors.surface,
    },
    themeOption: {
      flex: 1,
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderRadius: 10,
    },
    themeSelected: {
      backgroundColor: colors.navigation,
      borderWidth: 1,
      borderColor: colors.borderStrong,
    },
    themeText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
    themeSelectedText: { color: colors.blue },
    card: {
      gap: 8,
      padding: 16,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: metrics.cardRadius,
      backgroundColor: colors.navigation,
    },
    cardHeading: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingBottom: 5,
    },
    cardTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
    fieldLabel: {
      color: colors.textMuted,
      fontSize: 11,
      lineHeight: 16,
      marginTop: 4,
    },
    value: { color: colors.text, fontSize: 14, lineHeight: 22 },
    serverURL: {
      color: colors.text,
      fontSize: 14,
      lineHeight: 22,
      marginBottom: 8,
    },
    updateCard: {
      padding: 6,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: metrics.cardRadius,
      backgroundColor: colors.navigation,
    },
    pressed: { opacity: 0.75 },
  });
