import { View, StyleSheet } from 'react-native';
import { type CoveColors } from '../../settings/theme';
import { useThemedStyles } from '../../settings/ThemeProvider';
import { useVolumeSliderGesture } from './useVolumeSliderGesture';
interface InlineVolumeSliderProps {
  value: number;
  label: string;
  onChange: (value: number) => void;
}
export function InlineVolumeSlider({
  value,
  label,
  onChange,
}: InlineVolumeSliderProps) {
  const styles = useThemedStyles(createStyles);
  const gesture = useVolumeSliderGesture(onChange);
  const normalized = Math.max(0, Math.min(1, value));
  const percentage = Math.round(normalized * 100);
  return (
    <View
      style={styles.volumeSlider}
      {...gesture}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{
        min: 0,
        max: 100,
        now: percentage,
        text: `${percentage}%`,
      }}
      accessibilityActions={[
        { name: 'decrement', label: '降低音量' },
        { name: 'increment', label: '提高音量' },
      ]}
      onAccessibilityAction={event =>
        onChange(
          Math.max(
            0,
            Math.min(
              1,
              normalized +
                (event.nativeEvent.actionName === 'increment' ? 0.05 : -0.05),
            ),
          ),
        )
      }
    >
      <View pointerEvents="none" style={styles.volumeSliderRail} />
      <View
        pointerEvents="none"
        style={[styles.volumeSliderFill, { width: `${percentage}%` }]}
      />
      <View
        pointerEvents="none"
        style={[styles.volumeSliderThumb, { left: `${percentage}%` }]}
      />
    </View>
  );
}
const createStyles = (colors: CoveColors) =>
  StyleSheet.create({
    volumeSlider: { flex: 1, height: 48, justifyContent: 'center' },
    volumeSliderRail: {
      position: 'absolute',
      right: 0,
      left: 0,
      height: 5,
      borderRadius: 3,
      backgroundColor: colors.surfaceRaised,
    },
    volumeSliderFill: {
      position: 'absolute',
      left: 0,
      height: 5,
      borderRadius: 3,
      backgroundColor: colors.blue,
    },
    volumeSliderThumb: {
      position: 'absolute',
      width: 15,
      height: 15,
      marginLeft: -7.5,
      borderWidth: 2,
      borderColor: colors.onPrimary,
      borderRadius: 8,
      backgroundColor: colors.blue,
    },
  });
