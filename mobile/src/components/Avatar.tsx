import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { avatarCropPresentation } from '../avatarCrop';
import { colors } from '../theme';

interface Props {
  username: string;
  avatarUrl?: string | null;
  /** Diameter in dp. */
  size?: number;
  /** Corner radius; defaults to a soft squircle (size * 0.32). */
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

function initials(name: string) {
  const trimmed = name.trim();
  return (trimmed.slice(0, 2) || 'C').toUpperCase();
}

export function Avatar({ username, avatarUrl, size = 32, borderRadius, style, accessibilityLabel }: Props) {
  const crop = avatarUrl ? avatarCropPresentation(avatarUrl) : null;
  const source = crop?.source ?? avatarUrl ?? null;
  const radius = borderRadius ?? Math.round(size * 0.32);
  const fontSize = Math.max(9, Math.round(size * 0.34));
  return (
    <View
      style={[styles.frame, { width: size, height: size, borderRadius: radius }, style]}
      accessibilityLabel={accessibilityLabel ?? `${username} 的头像`}
      accessibilityRole="image"
    >
      {source ? (
        crop ? (
          <Image
            source={{ uri: source }}
            style={{
              position: 'absolute',
              width: size * crop.zoom,
              height: size * crop.zoom,
              left: (size - size * crop.zoom) / 2 + crop.offsetX * size * crop.zoom,
              top: (size - size * crop.zoom) / 2 + crop.offsetY * size * crop.zoom,
            }}
            resizeMode="cover"
          />
        ) : (
          <Image source={{ uri: source }} style={styles.image} resizeMode="cover" />
        )
      ) : (
        <Text style={[styles.fallback, { fontSize }]}>{initials(username)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cyanSoft,
  },
  image: { width: '100%', height: '100%' },
  fallback: { color: colors.cyan, fontWeight: '800' },
});
