import { useState } from 'react';
import { Image, Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Check, Hash, UserRound, X } from 'lucide-react-native';
import { colors } from '../theme';

interface Props {
  visible: boolean;
  userId: string;
  username: string;
  avatarUrl?: string | null;
  remark?: string;
  onSaveRemark: (remark: string) => void;
  onClose: () => void;
}

export function UserProfileModal({ visible, userId, username, avatarUrl, remark = '', onSaveRemark, onClose }: Props) {
  const [draft, setDraft] = useState(remark);
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

            <View style={styles.idCard}>
              <View style={styles.idHeading}><Hash size={14} color={colors.textFaint} /><Text style={styles.idLabel}>用户 ID</Text></View>
              <Text selectable style={styles.idValue}>{userId}</Text>
            </View>

            <Text style={styles.fieldLabel}>我的备注</Text>
            <View style={styles.inputRow}>
              <UserRound size={18} color={colors.textFaint} />
              <TextInput value={draft} onChangeText={setDraft} maxLength={64} placeholder="添加仅自己可见的备注" placeholderTextColor={colors.textFaint} style={styles.input} autoFocus />
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
