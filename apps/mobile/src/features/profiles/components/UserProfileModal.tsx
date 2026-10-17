import { useEffect, useRef, useState } from 'react';
import {
  Modal,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type GestureResponderEvent,
} from 'react-native';
import {
  Check,
  Hash,
  Mic,
  MicOff,
  Minus,
  Plus,
  UserRound,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react-native';
import { type CoveColors } from '../../settings/theme';
import { useCoveTheme, useThemedStyles } from '../../settings/ThemeProvider';
import { Avatar } from './Avatar';
import { SafeAreaView } from 'react-native-safe-area-context';

interface Props {
  visible: boolean;
  userId: string;
  username: string;
  avatarUrl?: string | null;
  remark?: string;
  inVoice?: boolean;
  isMicOn?: boolean;
  volume?: number;
  onVolumeChange?: (volume: number) => void;
  onSaveRemark: (remark: string) => void;
  onClose: () => void;
}

export function UserProfileModal({
  visible,
  userId,
  username,
  avatarUrl,
  remark = '',
  inVoice = false,
  isMicOn = false,
  volume = 1,
  onVolumeChange,
  onSaveRemark,
  onClose,
}: Props) {
  const { colors } = useCoveTheme();
  const styles = useThemedStyles(createStyles);
  const [draft, setDraft] = useState(remark);
  const [remarkFocused, setRemarkFocused] = useState(false);
  const volumeTrackWidth = useRef(1);

  useEffect(() => setDraft(remark), [remark, userId, visible]);

  // locationX is only stable when the track itself is the hit target; the fill
  // and thumb must not receive touches or the value jumps while dragging.
  const updateVolumeFromTouch = (event: GestureResponderEvent) => {
    if (!onVolumeChange) return;
    const next = Math.max(
      0,
      Math.min(2, (event.nativeEvent.locationX / volumeTrackWidth.current) * 2),
    );
    onVolumeChange(next);
  };

  const stepVolume = (delta: number) => {
    if (!onVolumeChange) return;
    onVolumeChange(Math.max(0, Math.min(2, volume + delta)));
  };

  const volumePercent = Math.round(volume * 100);
  const displayName = remark || username;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <SafeAreaView
        style={styles.backdrop}
        edges={['top', 'right', 'bottom', 'left']}
      >
        <KeyboardAvoidingView
          style={styles.keyboard}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.card}>
              <View style={styles.cover}>
                <TouchableOpacity
                  style={styles.close}
                  onPress={onClose}
                  accessibilityLabel="关闭用户资料"
                  accessibilityRole="button"
                >
                  <X size={19} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              <View style={styles.body}>
                <Avatar
                  username={displayName}
                  avatarUrl={avatarUrl}
                  size={84}
                  borderRadius={28}
                  style={styles.avatar}
                />
                <Text style={styles.title}>{displayName}</Text>
                {remark ? (
                  <Text style={styles.username}>原用户名：{username}</Text>
                ) : null}

                <View
                  style={[
                    styles.voiceCard,
                    !inVoice
                      ? styles.voiceCardIdle
                      : isMicOn
                      ? styles.voiceCardOn
                      : styles.voiceCardOff,
                  ]}
                >
                  {!inVoice ? (
                    <MicOff size={18} color={colors.textFaint} />
                  ) : isMicOn ? (
                    <Mic size={18} color={colors.green} />
                  ) : (
                    <MicOff size={18} color={colors.red} />
                  )}
                  <View style={styles.voiceCopy}>
                    <Text
                      style={[
                        styles.voiceTitle,
                        inVoice && isMicOn
                          ? styles.voiceTitleOn
                          : inVoice
                          ? styles.voiceTitleOff
                          : undefined,
                      ]}
                    >
                      {!inVoice
                        ? '未加入语音'
                        : isMicOn
                        ? '麦克风已开启'
                        : '麦克风已关闭'}
                    </Text>
                    <Text style={styles.voiceHint}>
                      {inVoice ? '正在语音频道中' : '当前不在语音频道内'}
                    </Text>
                  </View>
                </View>

                {inVoice && onVolumeChange ? (
                  <View style={styles.volumeCard}>
                    <View style={styles.volumeHeading}>
                      {volume === 0 ? (
                        <VolumeX size={18} color={colors.textFaint} />
                      ) : (
                        <Volume2 size={18} color={colors.blue} />
                      )}
                      <Text style={styles.volumeLabel}>此用户音量</Text>
                      <Text style={styles.volumeValue}>{volumePercent}%</Text>
                    </View>
                    <View style={styles.volumeControls}>
                      <TouchableOpacity
                        style={styles.volumeStep}
                        accessibilityLabel={`降低${displayName}的音量`}
                        onPress={() => stepVolume(-0.1)}
                      >
                        <Minus size={16} color={colors.textMuted} />
                      </TouchableOpacity>
                      <View
                        style={styles.volumeTrack}
                        accessible
                        accessibilityRole="adjustable"
                        accessibilityValue={{
                          min: 0,
                          max: 200,
                          now: volumePercent,
                          text: `${volumePercent}%`,
                        }}
                        accessibilityActions={[
                          { name: 'increment', label: '提高音量' },
                          { name: 'decrement', label: '降低音量' },
                        ]}
                        onAccessibilityAction={event =>
                          stepVolume(
                            event.nativeEvent.actionName === 'increment'
                              ? 0.1
                              : -0.1,
                          )
                        }
                        accessibilityLabel={`${displayName}的音量，当前${volumePercent}%`}
                        onLayout={event => {
                          volumeTrackWidth.current = Math.max(
                            1,
                            event.nativeEvent.layout.width,
                          );
                        }}
                        onStartShouldSetResponder={() => true}
                        onStartShouldSetResponderCapture={() => true}
                        onMoveShouldSetResponder={() => true}
                        onMoveShouldSetResponderCapture={() => true}
                        onResponderGrant={updateVolumeFromTouch}
                        onResponderMove={updateVolumeFromTouch}
                        onResponderTerminationRequest={() => false}
                      >
                        <View pointerEvents="none" style={styles.volumeRail} />
                        <View
                          pointerEvents="none"
                          style={[
                            styles.volumeFill,
                            { width: `${Math.min(100, volumePercent / 2)}%` },
                          ]}
                        />
                        <View
                          pointerEvents="none"
                          style={[
                            styles.volumeThumb,
                            { left: `${Math.min(100, volumePercent / 2)}%` },
                          ]}
                        />
                        <View
                          pointerEvents="none"
                          style={styles.volumeUnityMark}
                        />
                      </View>
                      <TouchableOpacity
                        style={styles.volumeStep}
                        accessibilityLabel={`提高${displayName}的音量`}
                        onPress={() => stepVolume(0.1)}
                      >
                        <Plus size={16} color={colors.textMuted} />
                      </TouchableOpacity>
                    </View>
                    <Text style={styles.volumeHint}>
                      100% 为原始音量，最高可放大到 200%。
                    </Text>
                  </View>
                ) : null}

                <View style={styles.idCard}>
                  <View style={styles.idHeading}>
                    <Hash size={14} color={colors.textFaint} />
                    <Text style={styles.idLabel}>用户 ID</Text>
                  </View>
                  <Text selectable style={styles.idValue}>
                    {userId}
                  </Text>
                </View>

                <Text style={styles.fieldLabel}>我的备注</Text>
                <View
                  style={[
                    styles.inputRow,
                    remarkFocused && styles.inputFocused,
                  ]}
                >
                  <UserRound size={18} color={colors.textFaint} />
                  <TextInput
                    accessibilityLabel="我的备注"
                    value={draft}
                    onChangeText={setDraft}
                    onFocus={() => setRemarkFocused(true)}
                    onBlur={() => setRemarkFocused(false)}
                    maxLength={64}
                    placeholder="添加仅自己可见的备注"
                    placeholderTextColor={colors.textFaint}
                    style={styles.input}
                  />
                </View>
                <Text style={styles.hint}>
                  备注只保存在这台设备，不会通知对方。
                </Text>
                <TouchableOpacity
                  style={styles.save}
                  onPress={() => {
                    onSaveRemark(draft);
                    onClose();
                  }}
                  activeOpacity={0.8}
                >
                  <Check size={18} color={colors.onConfirm} />
                  <Text style={styles.saveText}>保存备注</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const createStyles = (colors: CoveColors) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 18,
      backgroundColor: colors.overlay,
    },
    keyboard: { flex: 1, width: '100%' },
    scroll: {
      flexGrow: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 12,
    },
    card: {
      width: '100%',
      maxWidth: 430,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: 20,
      backgroundColor: colors.dialog,
    },
    cover: { height: 92, backgroundColor: colors.blueSoft },
    close: {
      position: 'absolute',
      top: 14,
      right: 14,
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 12,
      backgroundColor: colors.surface,
    },
    body: { paddingHorizontal: 22, paddingBottom: 22 },
    avatar: { marginTop: -42, borderWidth: 4, borderColor: colors.dialog },
    title: {
      marginTop: 13,
      color: colors.text,
      fontSize: 22,
      fontWeight: '800',
    },
    username: { marginTop: 4, color: colors.textFaint, fontSize: 13 },
    voiceCard: {
      minHeight: 58,
      marginTop: 17,
      paddingHorizontal: 13,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderWidth: 1,
      borderRadius: 15,
    },
    voiceCardIdle: {
      borderColor: colors.border,
      backgroundColor: colors.surfaceRaised,
    },
    voiceCardOn: {
      borderColor: colors.greenSoft,
      backgroundColor: colors.greenSoft,
    },
    voiceCardOff: {
      borderColor: colors.redSoft,
      backgroundColor: colors.redSoft,
    },
    voiceCopy: { flex: 1 },
    voiceTitle: { color: colors.textMuted, fontSize: 12, fontWeight: '800' },
    voiceTitleOn: { color: colors.green },
    voiceTitleOff: { color: colors.red },
    voiceHint: { marginTop: 3, color: colors.textFaint, fontSize: 12 },
    volumeCard: {
      marginTop: 12,
      padding: 13,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: 15,
      backgroundColor: colors.blueSoft,
    },
    volumeHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    volumeLabel: {
      flex: 1,
      color: colors.textMuted,
      fontSize: 12,
      fontWeight: '700',
    },
    volumeValue: {
      minWidth: 42,
      color: colors.blue,
      fontSize: 12,
      fontWeight: '800',
      textAlign: 'right',
      fontVariant: ['tabular-nums'],
    },
    volumeControls: {
      marginTop: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    volumeStep: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      backgroundColor: colors.surfaceRaised,
    },
    volumeTrack: {
      flex: 1,
      height: 44,
      justifyContent: 'center',
      overflow: 'visible',
    },
    volumeRail: {
      position: 'absolute',
      right: 0,
      left: 0,
      height: 5,
      borderRadius: 3,
      backgroundColor: colors.surfaceRaised,
    },
    volumeFill: {
      position: 'absolute',
      left: 0,
      height: 5,
      borderRadius: 3,
      backgroundColor: colors.blue,
    },
    volumeThumb: {
      position: 'absolute',
      width: 15,
      height: 15,
      marginLeft: -7.5,
      borderWidth: 2,
      borderColor: colors.onPrimary,
      borderRadius: 8,
      backgroundColor: colors.blue,
    },
    volumeUnityMark: {
      position: 'absolute',
      left: '50%',
      width: 2,
      height: 10,
      marginLeft: -1,
      borderRadius: 1,
      backgroundColor: colors.textMuted,
    },
    volumeHint: {
      marginTop: 8,
      color: colors.textFaint,
      fontSize: 12,
      lineHeight: 18,
    },
    idCard: {
      marginTop: 17,
      padding: 13,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 15,
      backgroundColor: colors.surface,
    },
    idHeading: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    idLabel: {
      color: colors.textFaint,
      fontSize: 12,
      fontWeight: '700',
      letterSpacing: 1,
    },
    idValue: { marginTop: 8, color: colors.blue, fontSize: 12 },
    fieldLabel: {
      marginTop: 17,
      marginBottom: 7,
      color: colors.textMuted,
      fontSize: 12,
      fontWeight: '600',
    },
    inputRow: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
      paddingHorizontal: 13,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: 14,
      backgroundColor: colors.surfaceRaised,
    },
    input: { flex: 1, color: colors.text, fontSize: 14 },
    inputFocused: { borderColor: colors.blue, backgroundColor: colors.input },
    hint: {
      marginTop: 7,
      color: colors.textFaint,
      fontSize: 12,
      lineHeight: 18,
    },
    save: {
      height: 48,
      marginTop: 19,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderRadius: 14,
      backgroundColor: colors.confirm,
    },
    saveText: { color: colors.onConfirm, fontSize: 14, fontWeight: '800' },
  });
