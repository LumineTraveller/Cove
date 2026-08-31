import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MessageCircle, Send, X } from 'lucide-react-native';
import type { Socket } from 'socket.io-client';
import { colors } from '../theme';
import type { Message } from '../types';

interface Props {
  visible: boolean;
  socket: Socket;
  roomId: string;
  serverURL: string;
  username: string;
  ready: boolean;
  onClose: () => void;
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function mergeMessages(current: Message[], incoming: Message[]) {
  const merged = new Map(current.map(message => [message.id, message]));
  incoming.forEach(message => merged.set(message.id, message));
  return [...merged.values()].sort((left, right) => left.timestamp - right.timestamp);
}

export function ChatPanel({ visible, socket, roomId, serverURL, username, ready, onClose }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const listRef = useRef<FlatList<Message>>(null);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    setLoading(true);
    setLoadError(null);
    socket.timeout(6000).emit('room:history', { roomId }, (timeoutError: Error | null, result?: { ok: boolean; messages?: Message[]; error?: string }) => {
      if (!active) return;
      if (timeoutError || !result?.ok) setLoadError(`聊天记录加载失败：${result?.error ?? '请求超时'}`);
      else setMessages(current => mergeMessages(current, result.messages ?? []));
      setLoading(false);
    });
    return () => { active = false; };
  }, [ready, roomId, socket]);

  useEffect(() => {
    const onNew = (message: Message) => {
      if (message.roomId !== roomId) return;
      setMessages(current => mergeMessages(current, [message]));
    };
    socket.on('message:new', onNew);
    return () => { socket.off('message:new', onNew); };
  }, [roomId, socket]);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
  }, [visible]);

  const send = useCallback(() => {
    const content = input.trim();
    if (!content || !ready) return;
    socket.emit('message:send', { roomId, content });
    setInput('');
  }, [input, ready, roomId, socket]);

  const resolveImageURL = useCallback((content: string) => {
    if (/^https?:\/\//i.test(content) || content.startsWith('data:')) return content;
    return `${serverURL.replace(/\/$/, '')}${content.startsWith('/') ? content : `/${content}`}`;
  }, [serverURL]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
        <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.header}>
            <View style={styles.headerIcon}><MessageCircle size={19} color={colors.cyan} /></View>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>聊天</Text>
              <Text style={styles.subtitle}>{ready ? '消息会同步给房间内所有成员' : '正在等待房间连接'}</Text>
            </View>
            <TouchableOpacity style={styles.closeButton} onPress={onClose} accessibilityLabel="关闭聊天"><X size={20} color={colors.textMuted} /></TouchableOpacity>
          </View>

          {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={message => message.id}
            contentContainerStyle={messages.length ? styles.list : styles.emptyList}
            onContentSizeChange={() => visible && listRef.current?.scrollToEnd({ animated: true })}
            ListEmptyComponent={loading
              ? <View style={styles.empty}><ActivityIndicator color={colors.cyan} /><Text style={styles.emptyText}>正在加载聊天记录</Text></View>
              : <View style={styles.empty}><MessageCircle size={28} color={colors.textFaint} /><Text style={styles.emptyTitle}>还没有消息</Text><Text style={styles.emptyText}>发一句话开始聊天吧</Text></View>}
            renderItem={({ item }) => {
              const transient = item.type === 'system' || item.type === 'soundpack';
              if (transient) return <Text style={styles.systemMessage}>{item.content}</Text>;
              const own = item.author === username;
              return (
                <View style={[styles.messageRow, own && styles.messageRowOwn]}>
                  <View style={[styles.bubble, own && styles.bubbleOwn]}>
                    {!own && <Text style={styles.author}>{item.author}</Text>}
                    {item.type === 'image'
                      ? <Image source={{ uri: resolveImageURL(item.content) }} style={styles.image} resizeMode="contain" />
                      : <Text style={[styles.messageText, own && styles.messageTextOwn]}>{item.content}</Text>}
                    <Text style={[styles.time, own && styles.timeOwn]}>{formatTime(item.timestamp)}</Text>
                  </View>
                </View>
              );
            }}
          />

          <View style={styles.composer}>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder="发送消息"
              placeholderTextColor={colors.textFaint}
              multiline
              maxLength={2000}
              editable={ready}
              returnKeyType="send"
              blurOnSubmit={false}
            />
            <TouchableOpacity
              style={[styles.sendButton, (!ready || !input.trim()) && styles.sendButtonDisabled]}
              disabled={!ready || !input.trim()}
              onPress={send}
              accessibilityLabel="发送消息"
            ><Send size={18} color="#083344" /></TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  keyboard: { flex: 1 },
  header: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cyanSoft },
  headerCopy: { flex: 1 },
  title: { color: colors.text, fontSize: 17, fontWeight: '800' },
  subtitle: { marginTop: 3, color: colors.textFaint, fontSize: 10 },
  closeButton: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  error: { margin: 12, padding: 10, overflow: 'hidden', borderRadius: 12, color: colors.red, fontSize: 11, backgroundColor: colors.redSoft },
  list: { paddingHorizontal: 14, paddingVertical: 15, gap: 9 },
  emptyList: { flexGrow: 1 },
  empty: { flex: 1, minHeight: 240, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
  emptyTitle: { color: colors.textMuted, fontSize: 14, fontWeight: '700' },
  emptyText: { color: colors.textFaint, fontSize: 11 },
  systemMessage: { alignSelf: 'center', color: colors.textFaint, fontSize: 10, lineHeight: 15, paddingVertical: 4, textAlign: 'center' },
  messageRow: { alignItems: 'flex-start' },
  messageRowOwn: { alignItems: 'flex-end' },
  bubble: { maxWidth: '82%', paddingHorizontal: 12, paddingVertical: 9, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceRaised },
  bubbleOwn: { borderColor: 'rgba(103,232,249,0.2)', backgroundColor: '#cffafe' },
  author: { marginBottom: 4, color: colors.cyan, fontSize: 10, fontWeight: '700' },
  messageText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  messageTextOwn: { color: '#083344' },
  time: { marginTop: 5, color: colors.textFaint, fontSize: 8, textAlign: 'right' },
  timeOwn: { color: 'rgba(8,51,68,0.48)' },
  image: { width: 220, height: 160, borderRadius: 11, backgroundColor: 'rgba(0,0,0,0.16)' },
  composer: { minHeight: 70, flexDirection: 'row', alignItems: 'flex-end', gap: 9, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.borderStrong, backgroundColor: 'rgba(12,12,15,0.98)' },
  input: { flex: 1, minHeight: 46, maxHeight: 112, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 15, borderWidth: 1, borderColor: colors.border, color: colors.text, fontSize: 14, backgroundColor: colors.surface },
  sendButton: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 15, backgroundColor: '#a5f3fc' },
  sendButtonDisabled: { opacity: 0.3 },
});
