import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Moon, Sun } from 'lucide-react-native';
import {
  useCoveTheme,
  useThemedStyles,
} from '../features/settings/ThemeProvider';
import { metrics, type CoveColors } from '../features/settings/theme';
export function BrandMark({ size = 42 }: { size?: number }) {
  return (
    <Image
      source={require('../../assets/cove-icon.png')}
      style={{ width: size, height: size, borderRadius: Math.round(size / 3) }}
      accessibilityLabel="Cove"
    />
  );
}
export function IconButton({
  label,
  onPress,
  children,
  disabled = false,
  style,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.icon,
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}
export function CoveButton({
  title,
  onPress,
  disabled = false,
  loading = false,
  tone = 'primary',
  icon,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  tone?: 'primary' | 'secondary' | 'screen' | 'danger';
  icon?: ReactNode;
}) {
  const { colors } = useCoveTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        styles[tone],
        pressed && styles.pressed,
        (disabled || loading) && styles.disabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          color={tone === 'primary' ? colors.onPrimary : colors.text}
        />
      ) : (
        icon
      )}
      <Text
        style={[
          styles.buttonText,
          tone === 'primary' && { color: colors.onPrimary },
          tone === 'screen' && { color: colors.onScreen },
          tone === 'danger' && { color: colors.red },
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}
export function ThemeToggle() {
  const { theme, colors, setTheme } = useCoveTheme();
  return (
    <IconButton
      label={theme === 'light' ? '切换深色模式' : '切换浅色模式'}
      onPress={() => setTheme(theme === 'light' ? 'dark' : 'light')}
    >
      {theme === 'light' ? (
        <Moon size={20} color={colors.textMuted} />
      ) : (
        <Sun size={20} color={colors.textMuted} />
      )}
    </IconButton>
  );
}
export function ScreenHeader({
  title,
  subtitle,
  leading,
  trailing,
}: {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.header}>
      {leading}
      <View style={styles.headerCopy}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
    </View>
  );
}
const createStyles = (colors: CoveColors) =>
  StyleSheet.create({
    header: {
      minHeight: 72,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: metrics.page,
      paddingVertical: 12,
      backgroundColor: colors.navigation,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    headerCopy: { flex: 1, minWidth: 0 },
    title: { fontSize: 20, fontWeight: '700', color: colors.text },
    subtitle: {
      marginTop: 3,
      fontSize: 12,
      lineHeight: 18,
      color: colors.textMuted,
    },
    icon: {
      width: metrics.touch,
      height: metrics.touch,
      borderRadius: metrics.radius,
      justifyContent: 'center',
      alignItems: 'center',
    },
    button: {
      minHeight: 48,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderRadius: metrics.radius,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    primary: { backgroundColor: colors.blue },
    secondary: { backgroundColor: colors.surfaceRaised },
    screen: { backgroundColor: colors.screenAction },
    danger: { backgroundColor: colors.redSoft },
    buttonText: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.text,
      textAlign: 'center',
      flexShrink: 1,
    },
    pressed: { opacity: 0.75 },
    disabled: { opacity: 0.45 },
  });
