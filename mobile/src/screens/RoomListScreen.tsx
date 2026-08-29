import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ChevronRight, Radio, Server, Users, WifiOff } from 'lucide-react-native';
import type { Socket } from 'socket.io-client';
import { colors } from '../theme';
import type { Room, SessionConfig } from '../types';
import { MobileUpdateButton } from '../components/MobileUpdater';

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
        <View><Text style={styles.sectionTitle}>房间</Text><Text style={styles.sectionHint}>手机端只能加入现有房间</Text></View>
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
  sectionHeader: { paddingHorizontal: 19, paddingTop: 28, paddingBottom: 12 },
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
