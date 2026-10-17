import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  NativeEventEmitter,
  NativeModules,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
  type KeyboardMetrics,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MessageCircle, Send, X } from 'lucide-react-native';
import type { Socket } from 'socket.io-client';
import { metrics, type CoveColors } from '../../settings/theme';
import { useCoveTheme, useThemedStyles } from '../../settings/ThemeProvider';
import type { Message, RoomMember } from '../../../types';
import { authorizedResourceURL } from '../../connection/serverSecurity';
import {
  getProfileDisplayContent,
  getProfileDisplayName,
  type ProfileRemarks,
} from '../../profiles/profileDisplayName';
import { Avatar } from '../../profiles/components/Avatar';

interface Props {
  visible: boolean;
  socket: Socket;
  roomId: string;
  serverURL: string;
  username: string;
  members: RoomMember[];
  profileRemarks: ProfileRemarks;
  ready: boolean;
  onClose: () => void;
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}
function messageDay(timestamp: number) {
  return new Date(timestamp).toLocaleDateString('zh-CN');
}
function mergeMessages(current: Message[], incoming: Message[]) {
  const merged = new Map(current.map((message) => [message.id, message]));
  incoming.forEach((message) => merged.set(message.id, message));
  return [...merged.values()].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
}

export function useComposerKeyboardInset(visible: boolean) {
  const container = useRef<View>(null);
  const frameRef = useRef<KeyboardMetrics | null>(null);
  const [inset, setInset] = useState(0);
  const updateInset = useCallback(() => {
    if (Platform.OS !== 'android') return;
    const frame = frameRef.current;
    if (!frame) {
      setInset(0);
      return;
    }
    const keyboardTop = Number.isFinite(frame.screenY)
      ? frame.screenY
      : Dimensions.get('screen').height - frame.height;
    container.current?.measureInWindow((_x, y, _width, height) => {
      if (frameRef.current !== frame) return;
      // Android may already resize the modal. Add only the remaining overlap.
      setInset(Math.max(0, y + height - keyboardTop));
    });
  }, []);
  useEffect(() => {
    if (Platform.OS !== 'android' || !visible) {
      setInset(0);
      return;
    }
    let active = true;
    let nativeFrameReceived = false;
    let revision = 0;
    const applyFrame = (frame: KeyboardMetrics | null) => {
      frameRef.current = frame;
      updateInset();
    };
    const subscriptions = [
      Keyboard.addListener('keyboardDidShow', (event) => {
        if (!nativeFrameReceived) applyFrame(event.endCoordinates);
      }),
      Keyboard.addListener('keyboardDidChangeFrame', (event) => {
        if (!nativeFrameReceived) applyFrame(event.endCoordinates);
      }),
      Keyboard.addListener('keyboardDidHide', () => {
        if (!nativeFrameReceived) applyFrame(null);
      }),
    ];
    const metricsNow = Keyboard.metrics();
    if (metricsNow?.height) applyFrame(metricsNow);
    const native = NativeModules.CoveKeyboard;
    if (native?.getKeyboardFrame) {
      const onNativeFrame = (
        frame: {
          visible: boolean;
          top: number;
          height: number;
          width: number;
        } | null,
      ) => {
        if (
          !active ||
          !frame ||
          !Number.isFinite(frame.top) ||
          !Number.isFinite(frame.height)
        )
          return;
        nativeFrameReceived = true;
        applyFrame(
          frame.visible && frame.height > 0
            ? {
                screenY: frame.top,
                screenX: 0,
                height: frame.height,
                width: frame.width,
              }
            : null,
        );
      };
      subscriptions.push(
        new NativeEventEmitter(native).addListener(
          'coveKeyboardFrame',
          (frame) => {
            revision += 1;
            onNativeFrame(frame);
          },
        ),
      );
      const requestedRevision = revision;
      void native
        .getKeyboardFrame()
        .then((frame: Parameters<typeof onNativeFrame>[0]) => {
          if (revision === requestedRevision) onNativeFrame(frame);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
      frameRef.current = null;
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, [visible, updateInset]);
  return { container, inset, updateInset };
}

function ChatImage({
  uri,
  maximumWidth,
  onOpen,
}: {
  uri: string;
  maximumWidth: number;
  onOpen: () => void;
}) {
  const { colors } = useCoveTheme();
  const [ratio, setRatio] = useState(4 / 3);
  const [failed, setFailed] = useState(false);
  const width = Math.min(maximumWidth, 260 * ratio);
  return failed ? (
    <Text style={{ color: colors.textMuted, fontSize: 13, padding: 12 }}>
      图片无法加载
    </Text>
  ) : (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="查看聊天图片"
      onPress={onOpen}
    >
      <Image
        source={{ uri }}
        style={{
          width,
          height: width / ratio,
          borderRadius: 10,
          backgroundColor: colors.surface,
        }}
        resizeMode="contain"
        onError={() => setFailed(true)}
        onLoad={(event) => {
          const source = event.nativeEvent.source;
          if (source?.width && source?.height)
            setRatio(source.width / source.height);
        }}
      />
    </TouchableOpacity>
  );
}

export function ChatPanel({
  visible,
  socket,
  roomId,
  serverURL,
  username,
  members,
  profileRemarks,
  ready,
  onClose,
}: Props) {
  const { colors } = useCoveTheme();
  const styles = useThemedStyles(createChatStyles);
  const { width } = useWindowDimensions();
  const keyboard = useComposerKeyboardInset(visible);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [unread, setUnread] = useState(0);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const inputRef = useRef('');
  const listRef = useRef<FlatList<Message>>(null);
  const needsInitialScrollRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const canSend = ready && socket.connected !== false;
  const currentMember = members.find((member) => member.socketId === socket.id);
  const maximumImageWidth = Math.min(
    280,
    Math.max(96, Math.min(width, 760) - 128),
  );

  useEffect(() => {
    setMessages([]);
    setInput('');
    inputRef.current = '';
    setLoadError(null);
    setUnread(0);
    setLightbox(null);
    stickToBottomRef.current = true;
    needsInitialScrollRef.current = true;
  }, [roomId]);

  useEffect(() => {
    if (!ready) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setLoadError(null);
    socket
      .timeout(6000)
      .emit(
        'room:history',
        { roomId },
        (
          timeoutError: Error | null,
          result?: { ok: boolean; messages?: Message[]; error?: string },
        ) => {
          if (!active) return;
          if (timeoutError || !result?.ok)
            setLoadError(`聊天记录加载失败：${result?.error ?? '请求超时'}`);
          else
            setMessages((current) =>
              mergeMessages(current, result.messages ?? []),
            );
          setLoading(false);
        },
      );
    return () => {
      active = false;
    };
  }, [ready, roomId, socket, historyAttempt]);

  useEffect(() => {
    const onNew = (message: Message) => {
      if (message.roomId !== roomId) return;
      setMessages((current) => mergeMessages(current, [message]));
      if (
        visibleRef.current &&
        !stickToBottomRef.current &&
        message.type !== 'system' &&
        message.type !== 'soundpack'
      )
        setUnread((current) => current + 1);
    };
    socket.on('message:new', onNew);
    return () => {
      socket.off('message:new', onNew);
    };
  }, [roomId, socket]);

  useEffect(() => {
    if (!visible) return;
    needsInitialScrollRef.current = true;
    stickToBottomRef.current = true;
    setUnread(0);
    const frame = requestAnimationFrame(() =>
      listRef.current?.scrollToEnd({ animated: false }),
    );
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  const send = useCallback(() => {
    const content = inputRef.current.trim();
    if (!content || !ready || socket.connected === false) return;
    // Clear synchronously before emit: two presses before React renders must send once.
    inputRef.current = '';
    setInput('');
    stickToBottomRef.current = true;
    setUnread(0);
    socket.emit('message:send', { roomId, content });
  }, [ready, roomId, socket]);
  const resolveImageURL = useCallback(
    (content: string) => {
      if (/^https?:\/\//i.test(content) || content.startsWith('data:'))
        return content;
      const target = `${serverURL.replace(/\/$/, '')}${
        content.startsWith('/') ? content : `/${content}`
      }`;
      return authorizedResourceURL(serverURL, target);
    },
    [serverURL],
  );
  const close = () => {
    setLightbox(null);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={close}
      supportedOrientations={['portrait', 'landscape']}
    >
      <SafeAreaView
        style={styles.safeArea}
        edges={['top', 'right', 'bottom', 'left']}
      >
        <View
          ref={keyboard.container}
          style={[styles.keyboard, { paddingBottom: keyboard.inset }]}
          onLayout={keyboard.updateInset}
        >
          <KeyboardAvoidingView
            style={styles.keyboard}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={styles.header}>
              <View style={styles.headerIcon}>
                <MessageCircle size={21} color={colors.blue} />
              </View>
              <View style={styles.headerCopy}>
                <Text style={styles.title}>聊天</Text>
                <Text style={styles.subtitle}>
                  {canSend ? '房间消息' : '正在重新连接，消息连接后可发送'}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={close}
                accessibilityRole="button"
                accessibilityLabel="关闭聊天"
              >
                <X size={20} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            {loadError ? (
              <View style={styles.errorBanner} accessibilityLiveRegion="polite">
                <Text style={styles.error}>{loadError}</Text>
                <TouchableOpacity
                  style={styles.retryButton}
                  onPress={() => setHistoryAttempt((current) => current + 1)}
                  disabled={!canSend || loading}
                  accessibilityLabel="重新加载聊天记录"
                >
                  <Text style={styles.retryText}>重试</Text>
                </TouchableOpacity>
              </View>
            ) : null}
            <FlatList
              ref={listRef}
              data={messages}
              style={styles.messageList}
              keyExtractor={(message) => message.id}
              contentContainerStyle={
                messages.length ? styles.list : styles.emptyList
              }
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              scrollEventThrottle={16}
              onScroll={(event) => {
                const { contentOffset, contentSize, layoutMeasurement } =
                  event.nativeEvent;
                const nearBottom =
                  contentSize.height -
                    contentOffset.y -
                    layoutMeasurement.height <=
                  48;
                stickToBottomRef.current = nearBottom;
                if (nearBottom) setUnread(0);
              }}
              onContentSizeChange={() => {
                if (
                  !visible ||
                  (!needsInitialScrollRef.current && !stickToBottomRef.current)
                )
                  return;
                const initial = needsInitialScrollRef.current;
                needsInitialScrollRef.current = false;
                listRef.current?.scrollToEnd({ animated: !initial });
              }}
              ListEmptyComponent={
                <View style={styles.empty}>
                  {loading ? (
                    <ActivityIndicator color={colors.blue} />
                  ) : (
                    <View style={styles.emptyIcon}>
                      <MessageCircle size={28} color={colors.textMuted} />
                    </View>
                  )}
                  <Text style={styles.emptyTitle}>
                    {loading ? '正在加载聊天记录' : '还没有消息'}
                  </Text>
                  {!loading && (
                    <Text style={styles.emptyText}>
                      {canSend ? '发一句话开始聊天吧' : '连接恢复后即可聊天'}
                    </Text>
                  )}
                </View>
              }
              renderItem={({ item, index }) => {
                const transient =
                  item.type === 'system' || item.type === 'soundpack';
                const content = getProfileDisplayContent(
                  item.content,
                  item.contentUsername,
                  item.contentUserId,
                  profileRemarks,
                );
                const own =
                  item.authorUserId && currentMember?.userId
                    ? item.authorUserId === currentMember.userId
                    : item.author === username;
                const authorName = getProfileDisplayName(
                  item.author,
                  item.authorUserId,
                  profileRemarks,
                );
                const authorMember = members.find((member) =>
                  item.authorUserId
                    ? member.userId === item.authorUserId
                    : member.username === item.author,
                );
                const firstOfDay =
                  index === 0 ||
                  messageDay(messages[index - 1].timestamp) !==
                    messageDay(item.timestamp);
                return (
                  <Fragment>
                    {firstOfDay && (
                      <View style={styles.dateDivider}>
                        <View style={styles.dateLine} />
                        <Text style={styles.date}>
                          {messageDay(item.timestamp)}
                        </Text>
                        <View style={styles.dateLine} />
                      </View>
                    )}
                    {transient ? (
                      <Text style={styles.systemMessage}>{content}</Text>
                    ) : (
                      <View
                        style={[styles.messageRow, own && styles.messageRowOwn]}
                      >
                        {!own && (
                          <Avatar
                            username={authorName}
                            avatarUrl={authorMember?.avatarUrl}
                            size={40}
                            borderRadius={20}
                          />
                        )}
                        <View
                          style={[
                            styles.messageCopy,
                            own && styles.messageCopyOwn,
                          ]}
                        >
                          <View
                            style={[
                              styles.messageMeta,
                              own && styles.messageMetaOwn,
                            ]}
                          >
                            <Text style={styles.author}>
                              {own ? '你' : authorName}
                            </Text>
                            <Text style={styles.time}>
                              {formatTime(item.timestamp)}
                            </Text>
                          </View>
                          <View
                            style={[
                              styles.bubble,
                              own && styles.bubbleOwn,
                              item.type === 'image' && styles.imageBubble,
                            ]}
                          >
                            {item.type === 'image' ? (
                              <ChatImage
                                key={item.content}
                                uri={resolveImageURL(item.content)}
                                maximumWidth={maximumImageWidth}
                                onOpen={() =>
                                  setLightbox(resolveImageURL(item.content))
                                }
                              />
                            ) : (
                              <Text style={styles.messageText} selectable>
                                {content}
                              </Text>
                            )}
                          </View>
                        </View>
                        {own && (
                          <Avatar
                            username={authorName}
                            avatarUrl={
                              authorMember?.avatarUrl ??
                              currentMember?.avatarUrl
                            }
                            size={40}
                            borderRadius={20}
                          />
                        )}
                      </View>
                    )}
                  </Fragment>
                );
              }}
            />
            {unread > 0 && (
              <TouchableOpacity
                style={styles.unread}
                accessibilityLabel="查看新消息"
                onPress={() => {
                  stickToBottomRef.current = true;
                  setUnread(0);
                  listRef.current?.scrollToEnd({ animated: true });
                }}
              >
                <Text style={styles.unreadText}>{unread} 条新消息</Text>
              </TouchableOpacity>
            )}
            <View style={styles.composerContainer}>
              <View style={styles.composer}>
                <TextInput
                  style={styles.input}
                  value={input}
                  onChangeText={(value) => {
                    inputRef.current = value;
                    setInput(value);
                  }}
                  placeholder="发送消息"
                  placeholderTextColor={colors.textFaint}
                  multiline
                  maxLength={2000}
                  editable={canSend}
                  accessibilityLabel="消息内容"
                  returnKeyType="default"
                  textAlignVertical="top"
                />
                <TouchableOpacity
                  style={[
                    styles.sendButton,
                    (!canSend || !input.trim()) && styles.sendButtonDisabled,
                  ]}
                  disabled={!canSend || !input.trim()}
                  onPress={send}
                  accessibilityRole="button"
                  accessibilityLabel="发送消息"
                  accessibilityState={{ disabled: !canSend || !input.trim() }}
                >
                  <Send size={21} color={colors.onPrimary} />
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </SafeAreaView>
      <Modal
        visible={visible && !!lightbox}
        transparent
        animationType="fade"
        onRequestClose={() => setLightbox(null)}
        supportedOrientations={['portrait', 'landscape']}
      >
        <SafeAreaView
          style={styles.lightbox}
          edges={['top', 'right', 'bottom', 'left']}
        >
          <View style={styles.lightboxHeader}>
            <TouchableOpacity
              style={styles.lightboxClose}
              accessibilityLabel="关闭聊天图片"
              onPress={() => setLightbox(null)}
            >
              <X size={22} color={colors.onVideo} />
            </TouchableOpacity>
          </View>
          {lightbox && (
            <Image
              source={{ uri: lightbox }}
              style={styles.lightboxImage}
              resizeMode="contain"
              accessibilityLabel="聊天图片"
            />
          )}
        </SafeAreaView>
      </Modal>
    </Modal>
  );
}

export const createChatStyles = (colors: CoveColors) =>
  StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: colors.background },
    keyboard: { flex: 1 },
    header: {
      minHeight: 72,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.navigation,
    },
    headerIcon: {
      width: 40,
      height: 40,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.blueSoft,
    },
    headerCopy: { flex: 1, minWidth: 0 },
    title: {
      color: colors.text,
      fontSize: 20,
      lineHeight: 27,
      fontWeight: '700',
    },
    subtitle: {
      marginTop: 3,
      color: colors.textMuted,
      fontSize: 12,
      lineHeight: 18,
    },
    closeButton: {
      width: metrics.touch,
      height: metrics.touch,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    errorBanner: {
      margin: 16,
      marginBottom: 0,
      padding: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderRadius: 14,
      backgroundColor: colors.redSoft,
    },
    error: { flex: 1, color: colors.red, fontSize: 13, lineHeight: 20 },
    retryButton: {
      minHeight: 44,
      minWidth: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    retryText: { color: colors.blue, fontSize: 13, fontWeight: '600' },
    messageList: { flex: 1 },
    list: {
      width: '100%',
      maxWidth: 760,
      alignSelf: 'center',
      paddingHorizontal: 16,
      paddingVertical: 20,
      gap: 20,
    },
    emptyList: { flexGrow: 1 },
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      padding: 24,
    },
    emptyIcon: {
      width: 64,
      height: 64,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 20,
      backgroundColor: colors.surface,
    },
    emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
    emptyText: {
      color: colors.textMuted,
      fontSize: 13,
      lineHeight: 20,
      textAlign: 'center',
    },
    dateDivider: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginBottom: 20,
    },
    dateLine: { flex: 1, height: 1, backgroundColor: colors.border },
    date: { color: colors.textMuted, fontSize: 12 },
    systemMessage: {
      alignSelf: 'center',
      color: colors.textMuted,
      fontSize: 12,
      lineHeight: 19,
      textAlign: 'center',
    },
    messageRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    messageRowOwn: { justifyContent: 'flex-end' },
    messageCopy: {
      maxWidth: '80%',
      flexShrink: 1,
      alignItems: 'flex-start',
      minWidth: 0,
    },
    messageCopyOwn: { alignItems: 'flex-end' },
    messageMeta: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'baseline',
      gap: 8,
      paddingHorizontal: 3,
      marginBottom: 4,
    },
    messageMetaOwn: { justifyContent: 'flex-end' },
    author: {
      flexShrink: 1,
      color: colors.text,
      fontSize: 13,
      lineHeight: 19,
      fontWeight: '700',
    },
    time: { color: colors.textMuted, fontSize: 11 },
    bubble: {
      paddingHorizontal: 11,
      paddingVertical: 8,
      borderRadius: 13,
      borderTopLeftRadius: 6,
      backgroundColor: colors.receivedMessage,
    },
    bubbleOwn: {
      borderTopLeftRadius: 13,
      borderTopRightRadius: 6,
      backgroundColor: colors.ownMessage,
    },
    messageText: { color: colors.text, fontSize: 16, lineHeight: 24 },
    imageBubble: { padding: 4 },
    composerContainer: { padding: 13, backgroundColor: colors.navigation },
    composer: {
      minHeight: 54,
      maxWidth: 760,
      width: '100%',
      alignSelf: 'center',
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 4,
      padding: 4,
      borderWidth: 1.5,
      borderColor: colors.borderStrong,
      borderRadius: 14,
      backgroundColor: colors.input,
    },
    input: {
      flex: 1,
      minWidth: 0,
      minHeight: 44,
      maxHeight: 120,
      paddingHorizontal: 10,
      paddingVertical: 11,
      color: colors.text,
      fontSize: 15,
      lineHeight: 22,
    },
    sendButton: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 11,
      backgroundColor: colors.blue,
    },
    sendButtonDisabled: { opacity: 0.35 },
    unread: {
      minHeight: 44,
      alignSelf: 'center',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
      borderRadius: 14,
      backgroundColor: colors.blueSoft,
    },
    unreadText: { color: colors.blue, fontSize: 13, fontWeight: '600' },
    lightbox: { flex: 1, backgroundColor: colors.video },
    lightboxHeader: { alignItems: 'flex-end', padding: 12 },
    lightboxClose: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    lightboxImage: { flex: 1, width: '100%' },
  });
