import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Modal,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronRight, Plus, Radio, Server, Users, WifiOff, X } from 'lucide-react-native';
import type { Socket } from 'socket.io-client';
import { colors } from '../theme';
import type { Room, SessionConfig } from '../types';
import { MobileUpdateButton } from '../components/MobileUpdater';
import { roomLimit, roomPassword } from '../roomSettings';

interface Props {
  socket: Socket;
  config: SessionConfig;
  sessionReady: boolean;
  onSelectRoom: (room: Room) => void;
  onChangeServer: () => void;
}

export function RoomListScreen({
  socket,
  config,
  sessionReady,
  onSelectRoom,
  onChangeServer,
}: Props) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [membersByRoom, setMembersByRoom] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [limit, setLimit] = useState('');
  const [password, setPassword] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const createGeneration = useRef(0);

  const createRoom = () => {
    if (creatingRef.current || !sessionReady || !socket.connected) return;
    const trimmedName = name.trim();
    if (!trimmedName) return setCreateError('请输入房间名称');
    let maxMembers: number | null; let safePassword: string | undefined;
    try { maxMembers = roomLimit(limit); safePassword = roomPassword(password); } catch (error) { return setCreateError(error instanceof Error ? error.message : String(error)); }
    const generation = ++createGeneration.current;
    creatingRef.current = true;
    setCreating(true); setCreateError(null);
    socket.timeout(6000).emit('room:create', { name: trimmedName, maxMembers, ...(safePassword !== undefined ? { password: safePassword } : {}) }, (timeoutError: Error | null, result?: { room?: Room; error?: string }) => {
      if (generation !== createGeneration.current) return;
      creatingRef.current = false;
      setCreating(false);
      if (timeoutError || !result?.room) return setCreateError(result?.error ?? '创建房间超时');
      setCreateOpen(false); setName(''); setLimit(''); setPassword(''); onSelectRoom(result.room);
    });
  };

  const loadRooms = useCallback(async () => {
    if (!sessionReady) return;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`${config.serverURL}/api/rooms`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setRooms(await response.json() as Room[]);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : '无法加载房间');
    } finally {
      setLoading(false);
    }
  }, [config.serverURL, sessionReady]);

  useEffect(() => { loadRooms(); }, [loadRooms]);

  useEffect(() => {
    const onRooms = (updated: Room[]) => setRooms(updated);
    const onMembers = ({ roomId, members }: { roomId: string; members: string[] }) => {
      setMembersByRoom(current => ({ ...current, [roomId]: members }));
    };
    socket.on('rooms:updated', onRooms);
    socket.on('room:members:global', onMembers);
    return () => {
      socket.off('rooms:updated', onRooms);
      socket.off('room:members:global', onMembers);
    };
  }, [socket]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>COVE MOBILE</Text>
          <Text style={styles.title}>选择房间</Text>
        </View>
        <View style={[styles.statusDot, sessionReady && styles.statusOnline]} />
      </View>

      <View style={styles.profileStrip}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{config.username.slice(0, 2)}</Text></View>
        <View style={styles.profileCopy}>
          <Text style={styles.username} numberOfLines={1}>{config.username}</Text>
          <View style={styles.serverLine}>
            <Server size={11} color={colors.textFaint} />
            <Text style={styles.serverText} numberOfLines={1}>{config.serverURL}</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.switchButton} onPress={onChangeServer}>
          <Text style={styles.switchText}>切换</Text>
        </TouchableOpacity>
      </View>

      <MobileUpdateButton />
      <View style={styles.sectionHeader}>
        <View><Text style={styles.sectionTitle}>房间</Text><Text style={styles.sectionHint}>创建或加入房间</Text></View>
        <TouchableOpacity style={styles.createButton} onPress={() => setCreateOpen(true)}><Plus size={16} color="#082f49" /><Text style={styles.createButtonText}>创建</Text></TouchableOpacity>
      </View>

      {!sessionReady ? (
        <View style={styles.empty}>
          <ActivityIndicator color={colors.cyan} />
          <Text style={styles.emptyText}>正在连接服务器</Text>
        </View>
      ) : loadError ? (
        <TouchableOpacity style={styles.empty} onPress={loadRooms}>
          <WifiOff size={23} color={colors.red} />
          <Text style={styles.emptyText}>加载失败，点按重试</Text>
          <Text style={styles.errorDetail}>{loadError}</Text>
        </TouchableOpacity>
      ) : (
        <FlatList
          data={rooms}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.list, rooms.length === 0 && styles.emptyList]}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={loadRooms} tintColor={colors.cyan} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Radio size={23} color={colors.textFaint} />
              <Text style={styles.emptyText}>暂时没有可加入的房间</Text>
            </View>
          }
          renderItem={({ item }) => {
            const memberCount = membersByRoom[item.id]?.length ?? 0;
            return (
              <TouchableOpacity style={styles.roomRow} onPress={() => onSelectRoom(item)} activeOpacity={0.78}>
                <View style={styles.roomIcon}><Radio size={20} color={colors.cyan} /></View>
                <View style={styles.roomCopy}>
                  <Text style={styles.roomName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.ownerName} numberOfLines={1}>
                    {item.ownerName ? `房主 ${item.ownerName}` : '等待房主进入'}
                  </Text>
                </View>
                {memberCount > 0 && (
                  <View style={styles.memberCount}><Users size={12} color={colors.textMuted} /><Text style={styles.memberCountText}>{memberCount}</Text></View>
                )}
                <ChevronRight size={19} color={colors.textFaint} />
              </TouchableOpacity>
            );
          }}
        />
      )}
      <Modal visible={createOpen} animationType="slide" onRequestClose={() => { createGeneration.current += 1; setCreateOpen(false); }}>
        <SafeAreaView style={styles.modal} edges={['top','right','bottom','left']}>
          <View style={styles.modalHeader}><Text style={styles.modalTitle}>创建房间</Text><TouchableOpacity onPress={() => setCreateOpen(false)}><X size={21} color={colors.textMuted} /></TouchableOpacity></View>
          <View style={styles.form}>
            <Text style={styles.label}>房间名称</Text><TextInput value={name} onChangeText={setName} placeholder="例如：周末闲聊" placeholderTextColor={colors.textFaint} style={styles.input} maxLength={80} />
            <Text style={styles.label}>人数上限（含房主）</Text><View style={styles.presetRow}>{['','2','5','10','20'].map(value => <TouchableOpacity key={value || 'unlimited'} style={[styles.preset, limit === value && styles.presetActive]} onPress={() => setLimit(value)}><Text style={[styles.presetText, limit === value && styles.presetTextActive]}>{value || '不限'}</Text></TouchableOpacity>)}<TextInput value={limit} onChangeText={setLimit} placeholder="自定义" placeholderTextColor={colors.textFaint} keyboardType="number-pad" style={styles.customInput} /> </View>
            <Text style={styles.label}>密码（可选）</Text><TextInput value={password} onChangeText={setPassword} placeholder="留空表示无密码" placeholderTextColor={colors.textFaint} secureTextEntry style={styles.input} maxLength={128} />
            {createError && <Text style={styles.formError}>{createError}</Text>}
            <TouchableOpacity style={styles.submit} disabled={creating} onPress={createRoom}><Text style={styles.submitText}>{creating ? '创建中…' : '创建并进入'}</Text></TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 17, paddingBottom: 18 },
  eyebrow: { color: colors.cyan, fontSize: 10, letterSpacing: 1.5, fontWeight: '800' },
  title: { color: colors.text, fontSize: 28, fontWeight: '800', marginTop: 4 },
  statusDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#52525b' },
  statusOnline: { backgroundColor: '#34d399' },
  profileStrip: { flexDirection: 'row', alignItems: 'center', gap: 11, marginHorizontal: 16, padding: 12, borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  avatar: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cyanSoft },
  avatarText: { color: colors.cyan, fontSize: 13, fontWeight: '800' },
  profileCopy: { flex: 1, minWidth: 0 },
  username: { color: colors.text, fontSize: 14, fontWeight: '700' },
  serverLine: { flexDirection: 'row', gap: 4, alignItems: 'center', marginTop: 4 },
  serverText: { flex: 1, color: colors.textFaint, fontSize: 10 },
  switchButton: { paddingHorizontal: 11, paddingVertical: 8, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.07)' },
  switchText: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 19, paddingTop: 28, paddingBottom: 12 },
  createButton: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 10, backgroundColor: colors.cyan },
  createButtonText: { color: '#082f49', fontSize: 12, fontWeight: '800' },
  presetRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }, preset: { paddingHorizontal: 10, paddingVertical: 9, borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }, presetActive: { backgroundColor: colors.cyan, borderColor: colors.cyan }, presetText: { color: colors.textMuted, fontSize: 11, fontWeight: '700' }, presetTextActive: { color: '#082f49' }, customInput: { minWidth: 72, color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 8, backgroundColor: colors.surface },
  modal: { flex: 1, backgroundColor: colors.background }, modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: colors.border }, modalTitle: { color: colors.text, fontSize: 20, fontWeight: '800' }, form: { padding: 20, gap: 9 }, label: { color: colors.textMuted, fontSize: 12, fontWeight: '700', marginTop: 9 }, input: { color: colors.text, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 11, backgroundColor: colors.surface }, formError: { color: colors.red, fontSize: 12 }, submit: { alignItems: 'center', padding: 14, borderRadius: 12, backgroundColor: colors.cyan, marginTop: 12 }, submitText: { color: '#082f49', fontWeight: '800' },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  sectionHint: { color: colors.textFaint, fontSize: 11, marginTop: 4 },
  list: { paddingHorizontal: 16, paddingBottom: 28, gap: 9 },
  emptyList: { flexGrow: 1 },
  roomRow: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 11, padding: 11, borderWidth: 1, borderColor: colors.border, borderRadius: 18, backgroundColor: colors.surface },
  roomIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cyanSoft },
  roomCopy: { flex: 1, minWidth: 0 },
  roomName: { color: colors.text, fontSize: 15, fontWeight: '700' },
  ownerName: { color: colors.textFaint, fontSize: 11, marginTop: 5 },
  memberCount: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 5, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.06)' },
  memberCountText: { color: colors.textMuted, fontSize: 10 },
  empty: { flex: 1, minHeight: 160, alignItems: 'center', justifyContent: 'center', gap: 9, paddingHorizontal: 24 },
  emptyText: { color: colors.textMuted, fontSize: 13 },
  errorDetail: { color: colors.textFaint, fontSize: 10, textAlign: 'center' },
});
