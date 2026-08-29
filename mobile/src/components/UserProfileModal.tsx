import { useEffect, useRef, useState } from 'react';
import { Image, Modal, StyleSheet, Text, TextInput, TouchableOpacity, View, type GestureResponderEvent } from 'react-native';
import { Check, Hash, Mic, MicOff, Minus, Plus, UserRound, Volume2, VolumeX, X } from 'lucide-react-native';
import { colors } from '../theme';

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
  const [draft, setDraft] = useState(remark);
  const volumeTrackWidth = useRef(1);

  useEffect(() => setDraft(remark), [remark, userId, visible]);

  const updateVolumeFromTouch = (event: GestureResponderEvent) => {
    if (!onVolumeChange) return;
    const next = Math.max(0, Math.min(2, event.nativeEvent.locationX / volumeTrackWidth.current * 2));
    onVolumeChange(next);
  };

  const volumePercent = Math.round(volume * 100);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.cover}>
            <TouchableOpacity style={styles.close} onPress={onClose}><X size={19} color={colors.textMuted} /></TouchableOpacity>
          </View>
          <View style={styles.body}>
            <View style={styles.avatar}>
              {avatarUrl
                ? <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
                : <Text style={styles.avatarText}>{username.trim().slice(0, 2).toUpperCase() || 'C'}</Text>}
            </View>
            <Text style={styles.title}>{remark || username}</Text>
            {remark ? <Text style={styles.username}>用户名：{username}</Text> : null}

            <View style={[styles.voiceCard, !inVoice ? styles.voiceCardIdle : isMicOn ? styles.voiceCardOn : styles.voiceCardOff]}>
              {!inVoice
                ? <MicOff size={18} color={colors.textFaint} />
                : isMicOn
                  ? <Mic size={18} color={colors.green} />
                  : <MicOff size={18} color={colors.red} />}
              <View style={styles.voiceCopy}>
                <Text style={[styles.voiceTitle, inVoice && isMicOn ? styles.voiceTitleOn : inVoice ? styles.voiceTitleOff : undefined]}>
                  {!inVoice ? '未加入语音' : isMicOn ? '麦克风已开启' : '麦克风已关闭'}
                </Text>
                <Text style={styles.voiceHint}>{inVoice ? '状态由服务器实时同步' : '当前不在语音频道内'}</Text>
              </View>
            </View>

            {inVoice && onVolumeChange ? (
              <View style={styles.volumeCard}>
                <View style={styles.volumeHeading}>
                  {volume === 0 ? <VolumeX size={18} color={colors.textFaint} /> : <Volume2 size={18} color={colors.cyan} />}
                  <Text style={styles.volumeLabel}>此用户音量</Text>
                  <Text style={styles.volumeValue}>{volumePercent}%</Text>
                </View>
                <View style={styles.volumeControls}>
                  <TouchableOpacity
                    style={styles.volumeStep}
                    accessibilityLabel={`降低${username}的音量`}
                    onPress={() => onVolumeChange(volume - 0.1)}
                  >
                    <Minus size={16} color={colors.textMuted} />
                  </TouchableOpacity>
                  <View
                    style={styles.volumeTrack}
                    accessibilityLabel={`${username}的音量，当前${volumePercent}%`}
                    onLayout={event => { volumeTrackWidth.current = Math.max(1, event.nativeEvent.layout.width); }}
                    onStartShouldSetResponder={() => true}
                    onMoveShouldSetResponder={() => true}
                    onResponderGrant={updateVolumeFromTouch}
                    onResponderMove={updateVolumeFromTouch}
                  >
                    <View style={styles.volumeRail} />
                    <View style={[styles.volumeFill, { width: `${Math.min(100, volumePercent / 2)}%` }]} />
                    <View style={[styles.volumeThumb, { left: `${Math.min(100, volumePercent / 2)}%` }]} />
                    <View style={styles.volumeUnityMark} />
                  </View>
                  <TouchableOpacity
                    style={styles.volumeStep}
                    accessibilityLabel={`提高${username}的音量`}
                    onPress={() => onVolumeChange(volume + 0.1)}
                  >
                    <Plus size={16} color={colors.textMuted} />
                  </TouchableOpacity>
                </View>
                <Text style={styles.volumeHint}>100% 为原始音量，最高可放大到 200%。</Text>
              </View>
            ) : null}

            <View style={styles.idCard}>
              <View style={styles.idHeading}><Hash size={14} color={colors.textFaint} /><Text style={styles.idLabel}>用户 ID</Text></View>
              <Text selectable style={styles.idValue}>{userId}</Text>
            </View>

            <Text style={styles.fieldLabel}>我的备注</Text>
            <View style={styles.inputRow}>
              <UserRound size={18} color={colors.textFaint} />
              <TextInput value={draft} onChangeText={setDraft} maxLength={64} placeholder="添加仅自己可见的备注" placeholderTextColor={colors.textFaint} style={styles.input} />
            </View>
            <Text style={styles.hint}>备注只保存在这台设备，不会通知对方。</Text>
            <TouchableOpacity style={styles.save} onPress={() => { onSaveRemark(draft); onClose(); }} activeOpacity={0.8}>
              <Check size={18} color="#082f49" /><Text style={styles.saveText}>保存备注</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 18, backgroundColor: 'rgba(0,0,0,0.72)' },
  card: { width: '100%', maxWidth: 430, overflow: 'hidden', borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 26, backgroundColor: '#17171b' },
  cover: { height: 92, backgroundColor: 'rgba(34,211,238,0.10)' },
  close: { position: 'absolute', top: 14, right: 14, width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.25)' },
  body: { paddingHorizontal: 22, paddingBottom: 22 },
  avatar: { width: 84, height: 84, marginTop: -42, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderWidth: 4, borderColor: '#17171b', borderRadius: 28, backgroundColor: colors.cyanSoft },
  avatarImage: { width: '100%', height: '100%' },
  avatarText: { color: colors.cyan, fontSize: 25, fontWeight: '800' },
  title: { marginTop: 13, color: colors.text, fontSize: 22, fontWeight: '800' },
  username: { marginTop: 4, color: colors.textFaint, fontSize: 11 },
  voiceCard: { minHeight: 58, marginTop: 17, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 15 },
  voiceCardIdle: { borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.03)' },
  voiceCardOn: { borderColor: 'rgba(74,222,128,0.22)', backgroundColor: colors.greenSoft },
  voiceCardOff: { borderColor: 'rgba(248,113,113,0.22)', backgroundColor: colors.redSoft },
  voiceCopy: { flex: 1 },
  voiceTitle: { color: colors.textMuted, fontSize: 12, fontWeight: '800' },
  voiceTitleOn: { color: colors.green },
  voiceTitleOff: { color: colors.red },
  voiceHint: { marginTop: 3, color: colors.textFaint, fontSize: 9 },
  volumeCard: { marginTop: 12, padding: 13, borderWidth: 1, borderColor: 'rgba(103,232,249,0.18)', borderRadius: 15, backgroundColor: colors.cyanSoft },
  volumeHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  volumeLabel: { flex: 1, color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  volumeValue: { minWidth: 42, color: colors.cyan, fontSize: 12, fontWeight: '800', textAlign: 'right', fontVariant: ['tabular-nums'] },
  volumeControls: { marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  volumeStep: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.06)' },
  volumeTrack: { flex: 1, height: 28, justifyContent: 'center', overflow: 'visible' },
  volumeRail: { position: 'absolute', right: 0, left: 0, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.12)' },
  volumeFill: { position: 'absolute', left: 0, height: 5, borderRadius: 3, backgroundColor: colors.cyan },
  volumeThumb: { position: 'absolute', width: 15, height: 15, marginLeft: -7.5, borderWidth: 2, borderColor: '#ecfeff', borderRadius: 8, backgroundColor: colors.cyan },
  volumeUnityMark: { position: 'absolute', left: '50%', width: 2, height: 10, marginLeft: -1, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.35)' },
  volumeHint: { marginTop: 8, color: colors.textFaint, fontSize: 9 },
  idCard: { marginTop: 17, padding: 13, borderWidth: 1, borderColor: colors.border, borderRadius: 15, backgroundColor: 'rgba(0,0,0,0.18)' },
  idHeading: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  idLabel: { color: colors.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  idValue: { marginTop: 8, color: colors.cyan, fontSize: 12 },
  fieldLabel: { marginTop: 17, marginBottom: 7, color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  inputRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 13, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.04)' },
  input: { flex: 1, color: colors.text, fontSize: 14 },
  hint: { marginTop: 7, color: colors.textFaint, fontSize: 10 },
  save: { height: 48, marginTop: 19, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 14, backgroundColor: '#cffafe' },
  saveText: { color: '#082f49', fontSize: 14, fontWeight: '800' },
});
