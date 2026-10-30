import {useEffect, useRef, useState} from 'react';
import { NativeEventEmitter, StyleSheet} from 'react-native';
import Video from 'react-native-video';
import type {SoundboardController} from '../useSoundboard';
import {setAudioOutputDevice} from '../../media/audio/audioDevices';
import { preparedSoundpacks } from '../preparedSoundpacks';

// Remote fallback should begin after 50 ms of audio, rather than ExoPlayer's
// multi-second streaming/video default. Prepared native playback bypasses it.
export const SOUNDPACK_BUFFER = {
  minBufferMs: 250,
  maxBufferMs: 2000,
  bufferForPlaybackMs: 50,
  bufferForPlaybackAfterRebufferMs: 100,
  backBufferDurationMs: 0,
};

interface AudioPlayerProps {
  controller: SoundboardController;
  playerKey: string;
  source: {uri: string; headers?: Record<string, string>; cropStart?: number; cropEnd?: number};
  onEnd: () => void;
  onError: () => void;
  onProgress?: (event: {currentTime: number}) => void;
}
/** RN Video changes AudioManager during initialization. Restore the selected route before unpausing. */
export function SoundpackAudioPlayer({controller, playerKey, source, onEnd, onError, onProgress}: AudioPlayerProps) {
  const outputDeviceId = controller.outputDeviceId ?? 'out-speaker';
  const currentKey = `${controller.scope}:${playerKey}:${outputDeviceId}:${controller.inVoice}`;
  const activeKey = useRef<string | null>(currentKey);
  activeKey.current = currentKey;
  const [routeReadyKey, setRouteReadyKey] = useState<string | null>(null);
  useEffect(() => {
    activeKey.current = currentKey;
    return () => {if (activeKey.current === currentKey) activeKey.current = null;};
  }, [currentKey]);
  const restoreRoute = async () => {
    if (activeKey.current !== currentKey || !controller.ready) return;
    try {
      const selected = await setAudioOutputDevice(outputDeviceId);
      if (activeKey.current !== currentKey) return;
      if (selected !== outputDeviceId) throw new Error('所选音频输出设备当前不可用');
      setRouteReadyKey(currentKey);
    } catch (cause) {
      if (activeKey.current !== currentKey) return;
      onError();
      controller.setNotice(cause instanceof Error ? `语音包输出失败：${cause.message}` : '语音包输出失败，请在音频设置中重新选择设备。');
    }
  };
  return (
    <Video
      key={currentKey}
      source={{ ...source, bufferConfig: SOUNDPACK_BUFFER }}
      volume={controller.volume}
      paused={routeReadyKey !== currentKey}
      ignoreSilentSwitch="ignore"
      playInBackground={false}
      disableFocus={controller.inVoice}
      audioOutput={controller.inVoice || outputDeviceId !== 'out-speaker' ? 'earpiece' : 'speaker'}
      onLoad={restoreRoute}
      onEnd={() => {if (activeKey.current === currentKey) onEnd();}}
      onError={() => {if (activeKey.current === currentKey) onError();}}
      onProgress={event => {if (activeKey.current === currentKey) onProgress?.(event);}}
      style={styles.hiddenPlayer}
    />
  );
}

/** Keep this mounted outside the panel so all voice members hear authoritative playback. */
export function SoundpackPlayer({controller}: {controller: SoundboardController}) {
  const {playback, playbackEnded} = controller;
  const session = controller.playbackSession;
  const [fallbackKey, setFallbackKey] = useState<number | null>(null);
  const active = useRef(playback);
  active.current = playback;
  const ended = useRef(playbackEnded);
  ended.current = playbackEnded;
  useEffect(() => {
    if (!preparedSoundpacks) return;
    const events = new NativeEventEmitter(preparedSoundpacks);
    const listener = events.addListener('CoveSoundpackEnded', event => {
      if (event.session === session && active.current?.key === event.key)
        ended.current(event.key, event.error);
    });
    return () => listener.remove();
  }, [session]);
  useEffect(() => {
    if (!preparedSoundpacks) return;
    let current = true;
    preparedSoundpacks.stop(session);
    if (!playback) return;
    preparedSoundpacks
      .play(
        session,
        playback.soundId,
        playback.version ?? '',
        playback.key,
        controller.volume,
      )
      .then(handled => {
        if (current && !handled) setFallbackKey(playback.key);
      })
      .catch(() => {
        if (current) setFallbackKey(playback.key);
      });
    return () => {
      current = false;
    };
    // Volume changes update the running player without restarting the clip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, playback?.key]);
  useEffect(() => {
    preparedSoundpacks?.setVolume(session, controller.volume);
  }, [session, controller.volume]);
  if (!playback) return null;
  if (preparedSoundpacks && fallbackKey !== playback.key) return null;
  return (
    <SoundpackAudioPlayer controller={controller} playerKey={String(playback.key)} source={{uri: playback.uri, headers: playback.headers}}
    onEnd={() => playbackEnded(playback.key)} onError={() => playbackEnded(playback.key, true)}
    />
  );
}
const styles = StyleSheet.create({hiddenPlayer: {position: 'absolute', width: 1, height: 1, opacity: 0}});
