import { useRef } from 'react';
import { View, StyleSheet, type GestureResponderEvent } from 'react-native';
import { colors } from '../../settings/theme';
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
  const trackWidth = useRef(1);
  const normalized = Math.max(0, Math.min(1, value));
  const percentage = Math.round(normalized * 100);
  // locationX must stay relative to the track. Keep rail/fill/thumb out of the
  // hit target so a drag that starts on the thumb cannot jump coordinate frames
  // and make the value flicker back and forth.
  const updateFromTouch = (event: GestureResponderEvent) => {
    onChange(
      Math.max(
        0,
        Math.min(1, event.nativeEvent.locationX / trackWidth.current),
      ),
    );
  };

  return (
    <View
      style={styles.volumeSlider}
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
          normalized +
            (event.nativeEvent.actionName === 'increment' ? 0.05 : -0.05),
        )
      }
      onLayout={event => {
        trackWidth.current = Math.max(1, event.nativeEvent.layout.width);
      }}
      onStartShouldSetResponder={() => true}
      onStartShouldSetResponderCapture={() => true}
      onMoveShouldSetResponder={() => true}
      onMoveShouldSetResponderCapture={() => true}
      onResponderGrant={updateFromTouch}
      onResponderMove={updateFromTouch}
      onResponderTerminationRequest={() => false}
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
const styles = StyleSheet.create({
  volumeSlider: { flex: 1, height: 32, justifyContent: 'center' },
  volumeSliderRail: {
    position: 'absolute',
    right: 0,
    left: 0,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.13)',
  },
  volumeSliderFill: {
    position: 'absolute',
    left: 0,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.cyan,
  },
  volumeSliderThumb: {
    position: 'absolute',
    width: 15,
    height: 15,
    marginLeft: -7.5,
    borderWidth: 2,
    borderColor: '#ecfeff',
    borderRadius: 8,
    backgroundColor: colors.cyan,
  },
});
