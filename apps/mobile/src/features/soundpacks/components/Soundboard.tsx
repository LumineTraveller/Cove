import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Play, Volume2 } from 'lucide-react-native';
import Video from 'react-native-video';
import type { Socket } from 'socket.io-client';
import { type CoveColors } from '../../settings/theme';
import { useCoveTheme, useThemedStyles } from '../../settings/ThemeProvider';
import type { Soundpack } from '../../../types';
import {
  authorizedResourceURL,
  serverFetch,
} from '../../connection/serverSecurity';
import {
  getProfileDisplayName,
  type ProfileRemarks,
} from '../../profiles/profileDisplayName';

interface Props {
  socket: Socket;
  roomId: string;
  serverURL: string;
  ready: boolean;
  inVoice: boolean;
  profileRemarks: ProfileRemarks;
  showHeading?: boolean;
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

export function Soundboard({
  socket,
  roomId,
  serverURL,
  ready,
  inVoice,
  profileRemarks,
  showHeading = true,
}: Props) {
  const { colors } = useCoveTheme();
  const styles = useThemedStyles(createStyles);
  const [packs, setPacks] = useState<Soundpack[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [playError, setPlayError] = useState(false);
  const packsRef = useRef<Soundpack[]>([]);
  const playSequence = useRef(0);

  useEffect(() => {
    packsRef.current = packs;
  }, [packs]);

  useEffect(() => {
    if (!ready || !socket.id) return;
    let active = true;
    setLoading(true);
    setLoadError(false);
    serverFetch(
      serverURL,
      `/api/soundpacks?socketId=${encodeURIComponent(
        socket.id,
      )}&roomId=${encodeURIComponent(roomId)}`,
    )
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<Soundpack[]>;
      })
      .then(list => active && setPacks(list))
      .catch(() => active && setLoadError(true))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [ready, roomId, serverURL, socket, retry]);

  const playSound = useCallback(
    (soundId: string, filename?: string) => {
      const sound = packsRef.current.find(item => item.id === soundId);
      if (!sound) return;
      playSequence.current += 1;
      setPlayError(false);
      setPlayback({
        key: playSequence.current,
        soundId,
        uri: authorizedResourceURL(
          serverURL,
          `/sounds/${encodeURIComponent(filename ?? sound.filename)}`,
        ),
      });
    },
    [serverURL],
  );

  useEffect(() => {
    const onAdded = (sound: Soundpack) => {
      setPacks(current => [
        sound,
        ...current.filter(item => item.id !== sound.id),
      ]);
    };
    const onDeleted = ({ soundId }: { soundId: string }) => {
      setPacks(current => current.filter(item => item.id !== soundId));
      setPlayback(current => (current?.soundId === soundId ? null : current));
    };
    const onPlay = ({
      soundId,
      filename,
    }: {
      soundId: string;
      filename?: string;
    }) => playSound(soundId, filename);
    const onNormalized = ({
      soundId,
      filename,
    }: {
      soundId: string;
      filename: string;
    }) => {
      setPacks(current =>
        current.map(sound =>
          sound.id === soundId ? { ...sound, filename } : sound,
        ),
      );
    };
    const onReordered = ({ orderedIds }: { orderedIds: string[] }) => {
      setPacks(current => applySoundpackOrder(current, orderedIds));
    };
    socket.on('soundpack:added', onAdded);
    socket.on('soundpack:deleted', onDeleted);
    socket.on('soundpack:play', onPlay);
    socket.on('soundpack:normalized', onNormalized);
    socket.on('soundpack:reordered', onReordered);
    return () => {
      socket.off('soundpack:added', onAdded);
      socket.off('soundpack:deleted', onDeleted);
      socket.off('soundpack:play', onPlay);
      socket.off('soundpack:normalized', onNormalized);
      socket.off('soundpack:reordered', onReordered);
    };
  }, [playSound, socket]);

  const triggerSound = (sound: Soundpack) => {
    if (!ready || !inVoice) return;
    socket.emit('soundpack:play', { soundId: sound.id, roomId });
  };

  return (
    <View style={styles.card}>
      {showHeading && (
        <View style={styles.heading}>
          <View style={styles.headingIcon}>
            <Volume2 size={18} color={colors.blue} />
          </View>
          <View>
            <Text style={styles.title}>语音包</Text>
            <Text style={styles.subtitle}>
              {inVoice
                ? '点按即可在当前语音频道播放'
                : '加入语音后才能播放语音包'}
            </Text>
          </View>
        </View>
      )}

      {playback && (
        <Video
          key={playback.key}
          source={{ uri: playback.uri }}
          paused={false}
          ignoreSilentSwitch="ignore"
          playInBackground={false}
          onEnd={() => setPlayback(null)}
          onError={() => {
            setPlayError(true);
            setPlayback(null);
          }}
          style={styles.hiddenPlayer}
        />
      )}

      {playError && (
        <Text style={styles.playError}>
          播放失败，请检查语音包文件和服务器连接
        </Text>
      )}
      {loading ? (
        <View style={styles.empty}>
          <ActivityIndicator color={colors.blue} />
          <Text style={styles.emptyText}>正在加载语音包</Text>
        </View>
      ) : loadError ? (
        <TouchableOpacity
          style={styles.empty}
          accessibilityRole="button"
          accessibilityLabel="重新加载语音包"
          onPress={() => setRetry(value => value + 1)}
        >
          <Text style={styles.playError}>语音包加载失败，点按重试</Text>
        </TouchableOpacity>
      ) : packs.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>当前还没有语音包</Text>
        </View>
      ) : (
        <View style={styles.grid}>
          {packs.map(sound => {
            const playing = playback?.soundId === sound.id;
            return (
              <View
                key={sound.id}
                style={[styles.tile, playing && styles.tilePlaying]}
              >
                <TouchableOpacity
                  style={styles.tileMain}
                  accessibilityRole="button"
                  accessibilityLabel={`播放语音包：${sound.name}`}
                  accessibilityState={{ disabled: !ready || !inVoice }}
                  disabled={!ready || !inVoice}
                  onPress={() => triggerSound(sound)}
                  activeOpacity={0.75}
                >
                  <View
                    style={[styles.playIcon, playing && styles.playIconActive]}
                  >
                    <Play
                      size={13}
                      color={playing ? colors.onPrimary : colors.textMuted}
                      fill={playing ? colors.onPrimary : 'transparent'}
                    />
                  </View>
                  <View style={styles.copy}>
                    <Text style={styles.soundName} numberOfLines={1}>
                      {sound.name}
                    </Text>
                    <Text style={styles.uploader} numberOfLines={1}>
                      {getProfileDisplayName(
                        sound.uploader,
                        sound.uploaderUserId,
                        profileRemarks,
                      )}
                    </Text>
                  </View>
                </TouchableOpacity>
                {playing && <View style={styles.playingLine} />}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const createStyles = (colors: CoveColors) =>
  StyleSheet.create({
    card: {
      marginHorizontal: 14,
      marginBottom: 12,
      padding: 15,
      borderRadius: 19,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    heading: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 11,
      marginBottom: 13,
    },
    headingIcon: {
      width: 38,
      height: 38,
      borderRadius: 13,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.blueSoft,
    },
    title: { color: colors.text, fontSize: 15, fontWeight: '700' },
    subtitle: { color: colors.textFaint, fontSize: 12, marginTop: 4 },
    hiddenPlayer: { position: 'absolute', width: 1, height: 1, opacity: 0 },
    playError: { color: colors.red, fontSize: 10, marginBottom: 10 },
    empty: {
      minHeight: 70,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    emptyText: { color: colors.textFaint, fontSize: 14 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    tile: {
      position: 'relative',
      width: '100%',
      minHeight: 65,
      flexDirection: 'row',
      alignItems: 'center',
      padding: 6,
      overflow: 'hidden',
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceRaised,
    },
    tilePlaying: {
      borderColor: colors.borderStrong,
      backgroundColor: colors.blueSoft,
    },
    tileMain: {
      flex: 1,
      minWidth: 0,
      minHeight: 51,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      padding: 4,
    },
    playIcon: {
      width: 29,
      height: 29,
      borderRadius: 10,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceRaised,
    },
    playIconActive: { backgroundColor: colors.blue },
    copy: { flex: 1, minWidth: 0 },
    soundName: {
      color: colors.text,
      fontSize: 11,
      fontWeight: '700',
    },
    uploader: { color: colors.textFaint, fontSize: 12, marginTop: 4 },
    playingLine: {
      position: 'absolute',
      right: 0,
      bottom: 0,
      left: 0,
      height: 2,
      backgroundColor: colors.blue,
    },
  });
