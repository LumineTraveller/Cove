import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Keyboard,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ChevronRight,
  DoorOpen,
  LockKeyhole,
  Plus,
  Server,
  Settings,
  Users,
  WifiOff,
  X,
} from 'lucide-react-native';
import type { Socket } from 'socket.io-client';
import {
  BrandMark,
  CoveButton,
  IconButton,
  ScreenHeader,
} from '../../../components/CoveUi';
import { useCoveTheme, useThemedStyles } from '../../settings/ThemeProvider';
import { metrics, type CoveColors } from '../../settings/theme';
import { MobileSettings } from '../../settings/components/MobileSettings';
import { useKeyboardInset } from '../../keyboard/useKeyboardInset';
import type { Room, SessionConfig } from '../../../types';
import { ROOM_LIMIT_PRESETS, roomLimit, roomPassword } from '../roomSettings';
import { serverFetch } from '../../connection/serverSecurity';
import {
  getProfileDisplayName,
  loadProfileRemarks,
  type ProfileRemarks,
} from '../../profiles/profileRemarks';

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
  const { theme, colors } = useCoveTheme();
  const styles = useThemedStyles(createStyles);
  const [page, setPage] = useState<'rooms' | 'settings'>('rooms');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [profileRemarks, setProfileRemarks] = useState<ProfileRemarks>({});
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [membersByRoom, setMembersByRoom] = useState<Record<string, string[]>>(
    {},
  );
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
  const loadGeneration = useRef(0);
  const invalidateRoomLoads = useCallback(() => {
    ++loadGeneration.current;
  }, []);

  useEffect(() => {
    let active = true;
    loadProfileRemarks().then(remarks => {
      if (active) setProfileRemarks(remarks);
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!sessionReady) {
      setCurrentUserId(null);
      return;
    }
    let active = true;
    socket.timeout(5_000).emit(
      'presence:get',
      (
        error: Error | null,
        snapshot?: {
          ok?: boolean;
          onlineUsers?: Array<{ socketId: string; userId?: string }>;
        },
      ) => {
        if (active && !error && snapshot?.ok)
          setCurrentUserId(
            snapshot.onlineUsers?.find(user => user.socketId === socket.id)
              ?.userId ?? null,
          );
      },
    );
    return () => {
      active = false;
    };
  }, [sessionReady, socket]);
  useEffect(() => {
    if (page !== 'settings') return;
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        setPage('rooms');
        return true;
      },
    );
    return () => subscription.remove();
  }, [page]);
  useEffect(
    () => () => {
      ++createGeneration.current;
      ++loadGeneration.current;
    },
    [],
  );

  const displayName = getProfileDisplayName(
    config.username,
    currentUserId,
    profileRemarks,
  );
  const closeCreate = useCallback(() => {
    ++createGeneration.current;
    creatingRef.current = false;
    setCreating(false);
    setCreateOpen(false);
    setCreateError(null);
    setPassword('');
    Keyboard.dismiss();
  }, []);
  const openCreate = () => {
    if (!sessionReady || !socket.connected) return;
    ++createGeneration.current;
    creatingRef.current = false;
    setCreating(false);
    setName('');
    setLimit('');
    setPassword('');
    setCreateError(null);
    setCreateOpen(true);
  };
  const createRoom = () => {
    if (creatingRef.current) return;
    if (!sessionReady || !socket.connected)
      return setCreateError('连接恢复后再创建房间。');
    const trimmedName = name.trim();
    if (!trimmedName) return setCreateError('请输入房间名称');
    let maxMembers: number | null;
    let safePassword: string | undefined;
    try {
      maxMembers = roomLimit(limit);
      safePassword = roomPassword(password);
    } catch (error) {
      return setCreateError(
        error instanceof Error ? error.message : String(error),
      );
    }
    const generation = ++createGeneration.current;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    socket.timeout(6_000).emit(
      'room:create',
      {
        name: trimmedName,
        maxMembers,
        ...(safePassword !== undefined ? { password: safePassword } : {}),
      },
      (
        timeoutError: Error | null,
        result?: { room?: Room; error?: string },
      ) => {
        if (generation !== createGeneration.current) return;
        creatingRef.current = false;
        setCreating(false);
        if (timeoutError || !result?.room)
          return setCreateError(result?.error ?? '创建房间超时，请重试。');
        closeCreate();
        setName('');
        setLimit('');
        onSelectRoom(result.room);
      },
    );
  };

  const loadRooms = useCallback(async () => {
    if (!sessionReady) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await serverFetch(config.serverURL, '/api/rooms');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const updated = (await response.json()) as Room[];
      if (generation === loadGeneration.current) setRooms(updated);
    } catch (cause) {
      if (generation === loadGeneration.current)
        setLoadError(cause instanceof Error ? cause.message : '无法加载房间');
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [config.serverURL, sessionReady]);
  useEffect(() => {
    loadRooms();
    return invalidateRoomLoads;
  }, [loadRooms, invalidateRoomLoads]);
  useEffect(() => {
    const onRooms = (updated: Room[]) => {
      ++loadGeneration.current;
      setRooms(updated);
      setLoadError(null);
      setLoading(false);
    };
    const onMembers = ({
      roomId,
      members,
    }: {
      roomId: string;
      members: string[];
    }) => setMembersByRoom(current => ({ ...current, [roomId]: members }));
    socket.on('rooms:updated', onRooms);
    socket.on('room:members:global', onMembers);
    return () => {
      socket.off('rooms:updated', onRooms);
      socket.off('room:members:global', onMembers);
    };
  }, [socket]);

  const roomHeader = (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="账户与服务器设置"
        onPress={() => setPage('settings')}
        style={({ pressed }) => [
          styles.profileStrip,
          pressed && styles.pressed,
        ]}
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {Array.from(displayName)[0] || '你'}
          </Text>
        </View>
        <View style={styles.profileCopy}>
          <Text style={styles.username} numberOfLines={2}>
            {displayName}
          </Text>
          <View style={styles.serverLine}>
            <Server size={12} color={colors.textMuted} />
            <Text style={styles.serverText} numberOfLines={1}>
              {config.serverURL}
            </Text>
          </View>
        </View>
        <ChevronRight size={19} color={colors.textFaint} />
      </Pressable>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionCopy}>
          <Text style={styles.sectionTitle}>房间</Text>
          <Text style={styles.sectionHint}>
            {rooms.length
              ? `${rooms.length} 个房间`
              : '和朋友一起聊天、语音与共享屏幕'}
          </Text>
        </View>
        <IconButton
          label="新建房间"
          onPress={openCreate}
          disabled={!sessionReady || !socket.connected}
          style={styles.addButton}
        >
          <Plus size={22} color={colors.onPrimary} />
        </IconButton>
      </View>
    </View>
  );
  const emptyState = !sessionReady ? (
    <View style={styles.empty}>
      <ActivityIndicator color={colors.blue} />
      <Text style={styles.emptyTitle}>正在连接服务器</Text>
      <Text style={styles.emptyText}>连接恢复后即可进入房间。</Text>
    </View>
  ) : loading ? (
    <View style={styles.empty}>
      <ActivityIndicator color={colors.blue} />
      <Text style={styles.emptyText}>正在加载房间</Text>
    </View>
  ) : loadError ? (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, styles.errorIcon]}>
        <WifiOff size={25} color={colors.red} />
      </View>
      <Text style={styles.emptyTitle}>暂时无法加载房间</Text>
      <Text style={styles.emptyText}>检查网络连接后重试。</Text>
      <Text style={styles.errorDetail}>{loadError}</Text>
      <CoveButton
        title="重新加载"
        onPress={() => {
          loadRooms();
        }}
        tone="secondary"
      />
    </View>
  ) : (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <DoorOpen size={26} color={colors.textMuted} />
      </View>
      <Text style={styles.emptyTitle}>还没有房间</Text>
      <Text style={styles.emptyText}>新建一个房间，邀请朋友加入。</Text>
      <CoveButton
        title="新建房间"
        onPress={openCreate}
        icon={<Plus size={18} color={colors.onPrimary} />}
      />
    </View>
  );

  return (
    <SafeAreaView
      style={styles.safeArea}
      edges={['top', 'right', 'bottom', 'left']}
    >
      <StatusBar
        barStyle={theme === 'dark' ? 'light-content' : 'dark-content'}
        backgroundColor={colors.navigation}
      />
      {page === 'settings' ? (
        <MobileSettings
          config={config}
          displayName={displayName}
          onChangeServer={onChangeServer}
        />
      ) : (
        <>
          <ScreenHeader
            title="Cove"
            subtitle="连接朋友的语音与屏幕"
            leading={<BrandMark />}
            trailing={
              <View style={styles.connectionStatus}>
                <View
                  style={[
                    styles.statusDot,
                    sessionReady && styles.statusOnline,
                  ]}
                />
                <Text style={styles.connectionText}>
                  {sessionReady ? '已连接' : '连接中'}
                </Text>
              </View>
            }
          />
          <FlatList
            style={styles.roomList}
            data={sessionReady && !loadError ? rooms : []}
            keyExtractor={item => item.id}
            contentContainerStyle={styles.list}
            ListHeaderComponent={roomHeader}
            refreshControl={
              <RefreshControl
                refreshing={sessionReady && loading && rooms.length > 0}
                onRefresh={() => {
                  loadRooms();
                }}
                tintColor={colors.blue}
                colors={[colors.blue]}
              />
            }
            ListEmptyComponent={emptyState}
            renderItem={({ item }) => {
              const memberCount = membersByRoom[item.id]?.length ?? 0;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`进入房间 ${item.name}${
                    item.hasPassword ? '，需要密码' : ''
                  }`}
                  onPress={() => onSelectRoom(item)}
                  style={({ pressed }) => [
                    styles.roomRow,
                    pressed && styles.roomPressed,
                  ]}
                >
                  <View style={styles.roomIcon}>
                    <DoorOpen size={22} color={colors.textMuted} />
                  </View>
                  <View style={styles.roomCopy}>
                    <View style={styles.roomNameLine}>
                      <Text style={styles.roomName} numberOfLines={2}>
                        {item.name}
                      </Text>
                      {item.hasPassword && (
                        <LockKeyhole size={13} color={colors.textFaint} />
                      )}
                    </View>
                    <Text style={styles.ownerName} numberOfLines={1}>
                      {item.ownerName
                        ? `房主 ${getProfileDisplayName(
                            item.ownerName,
                            item.ownerUserId,
                            profileRemarks,
                          )}`
                        : '等待朋友加入'}
                    </Text>
                    <View style={styles.roomMeta}>
                      <Users size={12} color={colors.textFaint} />
                      <Text style={styles.roomMetaText}>
                        {memberCount} 人
                        {item.maxMembers ? ` · 上限 ${item.maxMembers} 人` : ''}
                      </Text>
                    </View>
                  </View>
                  <ChevronRight size={20} color={colors.textFaint} />
                </Pressable>
              );
            }}
          />
        </>
      )}
      <View style={styles.bottomNav}>
        {(['rooms', 'settings'] as const).map(target => (
          <Pressable
            key={target}
            accessibilityRole="tab"
            accessibilityLabel={target === 'rooms' ? '房间' : '设置'}
            accessibilityState={{ selected: page === target }}
            onPress={() => setPage(target)}
            style={({ pressed }) => [
              styles.navButton,
              page === target && styles.navActive,
              pressed && styles.pressed,
            ]}
          >
            {target === 'rooms' ? (
              <DoorOpen
                size={21}
                color={page === target ? colors.blue : colors.textMuted}
              />
            ) : (
              <Settings
                size={21}
                color={page === target ? colors.blue : colors.textMuted}
              />
            )}
            <Text
              style={[
                styles.navLabel,
                page === target && styles.navLabelActive,
              ]}
            >
              {target === 'rooms' ? '房间' : '设置'}
            </Text>
          </Pressable>
        ))}
      </View>
      <Modal
        visible={createOpen}
        animationType="slide"
        onRequestClose={closeCreate}
      >
        {createOpen && (
          <CreateRoomForm
            name={name}
            limit={limit}
            password={password}
            setName={setName}
            setLimit={setLimit}
            setPassword={setPassword}
            creating={creating}
            error={createError}
            connected={sessionReady && socket.connected}
            onClose={closeCreate}
            onCreate={createRoom}
          />
        )}
      </Modal>
    </SafeAreaView>
  );
}

function CreateRoomForm({
  name,
  limit,
  password,
  setName,
  setLimit,
  setPassword,
  creating,
  connected,
  error,
  onClose,
  onCreate,
}: {
  name: string;
  limit: string;
  password: string;
  setName: (value: string) => void;
  setLimit: (value: string) => void;
  setPassword: (value: string) => void;
  creating: boolean;
  connected: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: () => void;
}) {
  const { theme, colors } = useCoveTheme();
  const styles = useThemedStyles(createStyles);
  const keyboard = useKeyboardInset();
  const [focused, setFocused] = useState<string | null>(null);
  const nameRef = useRef<TextInput>(null);
  const limitRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const inputFocus = (field: string, input: TextInput | null) => {
    setFocused(field);
    keyboard.bindInput(input);
  };
  const inputBlur = (field: string, input: TextInput | null) => {
    setFocused(current => (current === field ? null : current));
    keyboard.unbindInput(input);
  };
  return (
    <SafeAreaView
      style={styles.safeArea}
      edges={['top', 'right', 'bottom', 'left']}
    >
      <StatusBar
        barStyle={theme === 'dark' ? 'light-content' : 'dark-content'}
        backgroundColor={colors.navigation}
      />
      <ScreenHeader
        title="新建房间"
        subtitle="设置房间名称与加入方式"
        leading={
          <View style={styles.headerRoomIcon}>
            <DoorOpen size={22} color={colors.textMuted} />
          </View>
        }
        trailing={
          <IconButton label="取消创建房间" onPress={onClose}>
            <X size={22} color={colors.textMuted} />
          </IconButton>
        }
      />
      <ScrollView
        ref={keyboard.scrollView}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onScroll={keyboard.onScroll}
        scrollEventThrottle={16}
        onLayout={keyboard.onLayout}
        onContentSizeChange={keyboard.onContentSizeChange}
        contentContainerStyle={[
          styles.formScroll,
          { paddingBottom: metrics.page + keyboard.bottomInset },
        ]}
      >
        <View style={styles.form}>
          <Text style={styles.label}>房间名称</Text>
          <TextInput
            ref={nameRef}
            accessibilityLabel="房间名称"
            value={name}
            onChangeText={setName}
            placeholder="给房间起个名字"
            placeholderTextColor={colors.textFaint}
            style={[styles.input, focused === 'name' && styles.inputFocused]}
            onFocus={() => inputFocus('name', nameRef.current)}
            onBlur={() => inputBlur('name', nameRef.current)}
            maxLength={80}
            editable={!creating}
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
          />
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>人数上限</Text>
            <Text style={styles.fieldHint}>选择不限，或设置 1–1000 人。</Text>
            <View style={styles.presetRow}>
              {ROOM_LIMIT_PRESETS.map(value => (
                <Pressable
                  key={value || 'unlimited'}
                  accessibilityRole="button"
                  accessibilityLabel={value ? `上限 ${value} 人` : '人数不限'}
                  accessibilityState={{
                    selected: limit === value,
                    disabled: creating,
                  }}
                  disabled={creating}
                  style={({ pressed }) => [
                    styles.preset,
                    limit === value && styles.presetActive,
                    pressed && styles.pressed,
                  ]}
                  onPress={() => setLimit(value)}
                >
                  <Text
                    style={[
                      styles.presetText,
                      limit === value && styles.presetTextActive,
                    ]}
                  >
                    {value || '不限'}
                  </Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              ref={limitRef}
              accessibilityLabel="自定义人数上限"
              value={limit}
              onChangeText={setLimit}
              placeholder="自定义人数"
              placeholderTextColor={colors.textFaint}
              keyboardType="number-pad"
              style={[styles.input, focused === 'limit' && styles.inputFocused]}
              onFocus={() => inputFocus('limit', limitRef.current)}
              onBlur={() => inputBlur('limit', limitRef.current)}
              maxLength={4}
              editable={!creating}
            />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>房间密码（可选）</Text>
            <TextInput
              ref={passwordRef}
              accessibilityLabel="房间密码"
              value={password}
              onChangeText={setPassword}
              placeholder="留空即可直接加入"
              placeholderTextColor={colors.textFaint}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.input,
                focused === 'password' && styles.inputFocused,
              ]}
              onFocus={() => inputFocus('password', passwordRef.current)}
              onBlur={() => inputBlur('password', passwordRef.current)}
              maxLength={128}
              editable={!creating}
              returnKeyType="done"
              onSubmitEditing={onCreate}
            />
          </View>
          {error && (
            <View style={styles.formErrorBox}>
              <Text accessibilityRole="alert" style={styles.formError}>
                {error}
              </Text>
            </View>
          )}
          {!connected && (
            <Text style={styles.formError}>
              连接已断开，恢复连接后可继续创建。
            </Text>
          )}
          <View style={styles.formAction}>
            <CoveButton
              title={creating ? '创建中…' : '创建并进入'}
              onPress={onCreate}
              disabled={!connected}
              loading={creating}
              icon={<Plus size={18} color={colors.onPrimary} />}
            />
            <CoveButton title="取消" onPress={onClose} tone="secondary" />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: CoveColors) =>
  StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: colors.navigation },
    roomList: { flex: 1, backgroundColor: colors.background },
    list: {
      flexGrow: 1,
      width: '100%',
      maxWidth: metrics.contentWidth,
      alignSelf: 'center',
      padding: metrics.page,
      gap: 8,
      paddingBottom: 28,
    },
    profileStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 14,
      marginBottom: 24,
      borderRadius: metrics.cardRadius,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.blueSoft,
    },
    avatarText: { color: colors.blue, fontSize: 18, fontWeight: '700' },
    profileCopy: { flex: 1, minWidth: 0 },
    username: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '700',
      lineHeight: 22,
    },
    serverLine: {
      flexDirection: 'row',
      gap: 5,
      alignItems: 'center',
      marginTop: 5,
    },
    serverText: {
      flex: 1,
      color: colors.textMuted,
      fontSize: 11,
      lineHeight: 16,
    },
    connectionStatus: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    connectionText: { color: colors.textMuted, fontSize: 11 },
    statusDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.textFaint,
    },
    statusOnline: { backgroundColor: colors.green },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingBottom: 14,
    },
    sectionCopy: { flex: 1, minWidth: 0 },
    sectionTitle: { color: colors.text, fontSize: 23, fontWeight: '700' },
    sectionHint: {
      color: colors.textMuted,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 5,
    },
    addButton: { backgroundColor: colors.blue },
    roomRow: {
      minHeight: 86,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 13,
      padding: 12,
      borderRadius: 15,
      backgroundColor: colors.navigation,
      borderWidth: 1,
      borderColor: colors.border,
    },
    roomPressed: { backgroundColor: colors.blueSoft, borderColor: colors.blue },
    roomIcon: {
      width: 44,
      height: 44,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceRaised,
    },
    roomCopy: { flex: 1, minWidth: 0 },
    roomNameLine: { flexDirection: 'row', gap: 6, alignItems: 'center' },
    roomName: {
      flexShrink: 1,
      color: colors.text,
      fontSize: 15,
      fontWeight: '700',
      lineHeight: 22,
    },
    ownerName: {
      color: colors.textMuted,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 3,
    },
    roomMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginTop: 5,
    },
    roomMetaText: { color: colors.textFaint, fontSize: 11, lineHeight: 16 },
    empty: {
      flexGrow: 1,
      minHeight: 240,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      paddingVertical: 28,
      paddingHorizontal: 16,
    },
    emptyIcon: {
      width: 64,
      height: 64,
      borderRadius: 20,
      backgroundColor: colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
    },
    errorIcon: { backgroundColor: colors.redSoft },
    emptyTitle: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '700',
      textAlign: 'center',
    },
    emptyText: {
      color: colors.textMuted,
      fontSize: 13,
      lineHeight: 20,
      textAlign: 'center',
    },
    errorDetail: {
      color: colors.textFaint,
      fontSize: 11,
      lineHeight: 17,
      textAlign: 'center',
    },
    bottomNav: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 20,
      paddingVertical: 8,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.navigation,
    },
    navButton: {
      flex: 1,
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderRadius: 14,
    },
    navActive: { backgroundColor: colors.blueSoft },
    navLabel: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
    navLabelActive: { color: colors.blue },
    headerRoomIcon: {
      width: 42,
      height: 42,
      borderRadius: 14,
      backgroundColor: colors.surfaceRaised,
      justifyContent: 'center',
      alignItems: 'center',
    },
    formScroll: { flexGrow: 1, padding: metrics.page },
    form: {
      width: '100%',
      maxWidth: metrics.contentWidth,
      alignSelf: 'center',
      gap: 9,
    },
    fieldGroup: { gap: 9, marginTop: 16 },
    label: {
      color: colors.textMuted,
      fontSize: 12,
      fontWeight: '600',
      lineHeight: 18,
    },
    fieldHint: { color: colors.textFaint, fontSize: 12, lineHeight: 18 },
    input: {
      minHeight: metrics.input,
      color: colors.text,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: metrics.radius,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      backgroundColor: colors.navigation,
    },
    inputFocused: { borderColor: colors.blue },
    presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    preset: {
      minWidth: 44,
      minHeight: 44,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 13,
      paddingVertical: 10,
      borderRadius: 12,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    presetActive: {
      backgroundColor: colors.blueSoft,
      borderColor: colors.blue,
    },
    presetText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
    presetTextActive: { color: colors.blue },
    formErrorBox: {
      padding: 12,
      backgroundColor: colors.redSoft,
      borderRadius: 12,
      marginTop: 8,
    },
    formError: { color: colors.red, fontSize: 13, lineHeight: 20 },
    formAction: { gap: 10, marginTop: 20 },
    pressed: { opacity: 0.75 },
  });
