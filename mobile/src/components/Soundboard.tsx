import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ChevronLeft, ChevronRight, Play, Volume2 } from 'lucide-react-native';
import Video from 'react-native-video';
import type { Socket } from 'socket.io-client';
import { colors } from '../theme';
import type { Soundpack } from '../types';

interface Props {
  socket: Socket;
  roomId: string;
  serverURL: string;
  ready: boolean;
}

interface Playback {
  key: number;
  soundId: string;
  uri: string;
}

function applySoundpackOrder(packs: Soundpack[], orderedIds: string[]) {
  const byId = new Map(packs.map(pack => [pack.id, pack]));
  const ordered = orderedIds.flatMap(id => {
    const pack = byId.get(id);
    if (!pack) return [];
    byId.delete(id);
    return [pack];
  });
  return [...ordered, ...byId.values()];
}

export function Soundboard({ socket, roomId, serverURL, ready }: Props) {
  const [packs, setPacks] = useState<Soundpack[]>([]);
  const [loading, setLoading] = useState(true);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [playError, setPlayError] = useState(false);
  const [reorderingId, setReorderingId] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState(false);
  const packsRef = useRef<Soundpack[]>([]);
  const playSequence = useRef(0);

  useEffect(() => { packsRef.current = packs; }, [packs]);

  useEffect(() => {
    if (!ready || !socket.id) return;
    let active = true;
    setLoading(true);
    fetch(`${serverURL}/api/soundpacks?socketId=${encodeURIComponent(socket.id)}&roomId=${encodeURIComponent(roomId)}`)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<Soundpack[]>;
      })
      .then(list => active && setPacks(list))
      .catch(() => undefined)
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [ready, roomId, serverURL, socket]);

  const playSound = useCallback((soundId: string) => {
    const sound = packsRef.current.find(item => item.id === soundId);
    if (!sound) return;
    playSequence.current += 1;
    setPlayError(false);
    setPlayback({
      key: playSequence.current,
      soundId,
      uri: `${serverURL}/sounds/${encodeURIComponent(sound.filename)}`,
    });
  }, [serverURL]);

  useEffect(() => {
    const onAdded = (sound: Soundpack) => {
      setPacks(current => [sound, ...current.filter(item => item.id !== sound.id)]);
    };
    const onDeleted = ({ soundId }: { soundId: string }) => {
      setPacks(current => current.filter(item => item.id !== soundId));
      setPlayback(current => current?.soundId === soundId ? null : current);
    };
    const onPlay = ({ soundId }: { soundId: string }) => playSound(soundId);
    const onReordered = ({ orderedIds }: { orderedIds: string[] }) => {
      setPacks(current => applySoundpackOrder(current, orderedIds));
    };
    socket.on('soundpack:added', onAdded);
    socket.on('soundpack:deleted', onDeleted);
    socket.on('soundpack:play', onPlay);
    socket.on('soundpack:reordered', onReordered);
    return () => {
      socket.off('soundpack:added', onAdded);
      socket.off('soundpack:deleted', onDeleted);
      socket.off('soundpack:play', onPlay);
      socket.off('soundpack:reordered', onReordered);
    };
  }, [playSound, socket]);

  const triggerSound = (sound: Soundpack) => {
    if (!ready) return;
    playSound(sound.id);
    socket.emit('soundpack:play', { soundId: sound.id, roomId });
  };

  const moveSound = async (soundId: string, offset: -1 | 1) => {
    if (!ready || reorderingId) return;
    const previous = packsRef.current;
    const sourceIndex = previous.findIndex(sound => sound.id === soundId);
    const targetIndex = sourceIndex + offset;
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= previous.length) return;

    const next = [...previous];
    [next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]];
    setPacks(next);
    setReorderError(false);
    setReorderingId(soundId);
    try {
      const result = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        socket.timeout(5_000).emit('soundpack:reorder', {
          roomId,
          orderedIds: next.map(sound => sound.id),
        }, (error: Error | null, response: { ok: boolean; error?: string }) => error ? reject(error) : resolve(response));
      });
      if (!result.ok) throw new Error(result.error ?? '调整顺序失败');
    } catch {
      setPacks(previous);
      setReorderError(true);
    } finally {
      setReorderingId(null);
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.heading}>
        <View style={styles.headingIcon}><Volume2 size={18} color={colors.cyan} /></View>
        <View>
          <Text style={styles.title}>语音包</Text>
          <Text style={styles.subtitle}>点按播放，箭头调整所有成员看到的顺序</Text>
        </View>
      </View>

      {playback && (
        <Video
          key={playback.key}
          source={{ uri: playback.uri }}
          paused={false}
          ignoreSilentSwitch="ignore"
          playInBackground={false}
          onEnd={() => setPlayback(null)}
          onError={() => { setPlayError(true); setPlayback(null); }}
          style={styles.hiddenPlayer}
        />
      )}

      {playError && <Text style={styles.playError}>播放失败，请检查语音包文件和服务器连接</Text>}
      {reorderError && <Text style={styles.playError}>顺序调整失败，请重试</Text>}
      {loading ? (
        <View style={styles.empty}><ActivityIndicator color={colors.cyan} /><Text style={styles.emptyText}>正在加载语音包</Text></View>
      ) : packs.length === 0 ? (
        <View style={styles.empty}><Text style={styles.emptyText}>当前还没有语音包</Text></View>
      ) : (
        <View style={styles.grid}>
          {packs.map((sound, index) => {
            const playing = playback?.soundId === sound.id;
            return (
              <View key={sound.id} style={[styles.tile, playing && styles.tilePlaying]}>
                <TouchableOpacity style={styles.tileMain} disabled={!ready} onPress={() => triggerSound(sound)} activeOpacity={0.75}>
                  <View style={[styles.playIcon, playing && styles.playIconActive]}>
                    <Play size={13} color={playing ? '#083344' : colors.textMuted} fill={playing ? '#083344' : 'transparent'} />
                  </View>
                  <View style={styles.copy}>
                    <Text style={styles.soundName} numberOfLines={1}>{sound.name}</Text>
                    <Text style={styles.uploader} numberOfLines={1}>{sound.uploader}</Text>
                  </View>
                </TouchableOpacity>
                {packs.length > 1 && (
                  <View style={styles.reorderControls}>
                    <TouchableOpacity disabled={!ready || index === 0 || reorderingId !== null} onPress={() => void moveSound(sound.id, -1)} style={[styles.reorderButton, (index === 0 || reorderingId !== null) && styles.reorderButtonDisabled]} accessibilityLabel={`将 ${sound.name} 前移`}><ChevronLeft size={13} color={colors.textMuted} /></TouchableOpacity>
                    <TouchableOpacity disabled={!ready || index === packs.length - 1 || reorderingId !== null} onPress={() => void moveSound(sound.id, 1)} style={[styles.reorderButton, (index === packs.length - 1 || reorderingId !== null) && styles.reorderButtonDisabled]} accessibilityLabel={`将 ${sound.name} 后移`}><ChevronRight size={13} color={colors.textMuted} /></TouchableOpacity>
                  </View>
                )}
                {playing && <View style={styles.playingLine} />}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 14, marginBottom: 12, padding: 15, borderRadius: 19, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 13 },
  headingIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cyanSoft },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  subtitle: { color: colors.textFaint, fontSize: 10, marginTop: 4 },
  hiddenPlayer: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  playError: { color: colors.red, fontSize: 10, marginBottom: 10 },
  empty: { minHeight: 70, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyText: { color: colors.textFaint, fontSize: 11 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { position: 'relative', width: '48.7%', minHeight: 65, flexDirection: 'row', alignItems: 'center', padding: 6, overflow: 'hidden', borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.04)' },
  tilePlaying: { borderColor: 'rgba(103,232,249,0.38)', backgroundColor: colors.cyanSoft },
  tileMain: { flex: 1, minWidth: 0, minHeight: 51, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 4 },
  playIcon: { width: 29, height: 29, borderRadius: 10, flexShrink: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.07)' },
  playIconActive: { backgroundColor: '#a5f3fc' },
  copy: { flex: 1, minWidth: 0 },
  soundName: { color: 'rgba(244,244,245,0.82)', fontSize: 11, fontWeight: '700' },
  uploader: { color: colors.textFaint, fontSize: 9, marginTop: 4 },
  reorderControls: { flexDirection: 'row', gap: 2, paddingLeft: 2 },
  reorderButton: { width: 23, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.07)' },
  reorderButtonDisabled: { opacity: 0.25 },
  playingLine: { position: 'absolute', right: 0, bottom: 0, left: 0, height: 2, backgroundColor: colors.cyan },
});
