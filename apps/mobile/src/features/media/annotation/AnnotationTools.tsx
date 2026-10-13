import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { AnnotationTool } from '@cove/contracts';
import { useCoveTheme } from '../../settings/ThemeProvider';
import type { useScreenAnnotations } from './useScreenAnnotations';

export type MobileAnnotationTool = AnnotationTool | 'laser';
export function AnnotationTools({
  annotations,
  tool,
  setTool,
  color,
  setColor,
  width,
  setWidth,
}: {
  annotations: ReturnType<typeof useScreenAnnotations>;
  tool: MobileAnnotationTool;
  setTool: (value: MobileAnnotationTool) => void;
  color: string;
  setColor: (value: string) => void;
  width: number;
  setWidth: (value: number) => void;
}) {
  const { colors } = useCoveTheme();
  const action = (
    label: string,
    onPress: () => void,
    selected = false,
    disabled = false,
  ) => (
    <TouchableOpacity
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        {
          backgroundColor: selected ? colors.blueSoft : colors.surface,
          borderColor: selected ? colors.blue : colors.border,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Text
        style={{ color: selected ? colors.blue : colors.text, fontSize: 13 }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
  return (
    <View style={styles.container} testID="screen-annotation-tools">
      <ScrollView
        horizontal
        contentContainerStyle={styles.row}
        showsHorizontalScrollIndicator={false}
      >
        {action(
          annotations.localActive
            ? '结束批注'
            : annotations.isRequestPending
            ? '等待批注许可'
            : '批注',
          () => {
            if (annotations.localActive) annotations.exit();
            else void annotations.start();
          },
          annotations.localActive,
          !annotations.ready ||
            !annotations.state?.enabled ||
            Boolean(annotations.pendingAction),
        )}
        {annotations.localActive && (
          <>
            {action(
              '画笔',
              () => setTool('pen'),
              tool === 'pen',
              !annotations.canDraw,
            )}
            {action(
              '橡皮',
              () => setTool('eraser'),
              tool === 'eraser',
              !annotations.canDraw,
            )}
            {action(
              '指示',
              () => setTool('laser'),
              tool === 'laser',
              !annotations.canDraw,
            )}
            {action(
              width === 0.006 ? '粗线' : '细线',
              () => setWidth(width === 0.006 ? 0.012 : 0.006),
              false,
              !annotations.canDraw,
            )}
            {['#FF5A5F', '#FFD166', '#36C5F0', '#FFFFFF'].map(value => (
              <TouchableOpacity
                key={value}
                accessibilityLabel={`批注颜色${value}`}
                accessibilityState={{ selected: color === value }}
                onPress={() => setColor(value)}
                style={[
                  styles.colorButton,
                  {
                    borderColor: color === value ? colors.blue : colors.border,
                  },
                ]}
              >
                <View style={[styles.swatch, { backgroundColor: value }]} />
              </TouchableOpacity>
            ))}
            {action(
              '清空批注',
              () => {
                void annotations.clear();
              },
              false,
              !annotations.canDraw || Boolean(annotations.pendingAction),
            )}
          </>
        )}
      </ScrollView>
      {annotations.error ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.hint, { color: colors.red }]}
        >
          {annotations.error}
        </Text>
      ) : !annotations.state?.enabled && annotations.ready ? (
        <Text style={[styles.hint, { color: colors.textMuted }]}>
          共享者已关闭批注
        </Text>
      ) : annotations.isRequestPending ? (
        <Text style={[styles.hint, { color: colors.textMuted }]}>
          正在等待共享者处理现有权限设置
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingTop: 8, paddingBottom: 6 },
  row: { gap: 7, paddingHorizontal: 2 },
  button: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  colorButton: {
    width: 44,
    height: 44,
    borderWidth: 2,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  swatch: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#89919C',
  },
  hint: { fontSize: 12, lineHeight: 18, paddingTop: 5, paddingHorizontal: 2 },
});
