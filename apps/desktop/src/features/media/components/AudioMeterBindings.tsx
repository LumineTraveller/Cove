import { type ComponentProps, useCallback, useSyncExternalStore } from 'react';
import type { AudioMeterChannel, AudioMeterStore } from '../audio/audioMeterLevels';
import { MemberAvatar } from '../../profiles/MemberAvatar';
import { VolumeControl, VerticalVolume } from './VolumeControl';

type MeterBinding = {
  meters: AudioMeterStore;
  socketId: string;
  fallbackSocketId?: string;
};

type ChannelMeterBinding = MeterBinding & { channel: AudioMeterChannel };
const getServerSnapshot = () => 0;

function useAudioMeterLevel({
  meters,
  channel,
  socketId,
  fallbackSocketId,
}: ChannelMeterBinding): number {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const unsubscribe = meters.subscribe(channel, socketId, onStoreChange);
      const unsubscribeFallback =
        fallbackSocketId !== undefined && fallbackSocketId !== socketId
          ? meters.subscribe(channel, fallbackSocketId, onStoreChange)
          : undefined;
      return () => {
        unsubscribe();
        unsubscribeFallback?.();
      };
    },
    [meters, channel, socketId, fallbackSocketId],
  );
  const getSnapshot = useCallback(
    () => meters.getLevel(channel, socketId, fallbackSocketId),
    [meters, channel, socketId, fallbackSocketId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function MeteredMemberAvatar({
  meters,
  socketId,
  fallbackSocketId,
  speakingEnabled,
  ...props
}: Omit<ComponentProps<typeof MemberAvatar>, 'speaking'> &
  MeterBinding & { speakingEnabled: boolean }) {
  const level = useAudioMeterLevel({ meters, channel: 'voice', socketId, fallbackSocketId });
  return <MemberAvatar {...props} speaking={speakingEnabled && level > 0.08} />;
}

export function MeteredVolumeControl({
  meters,
  channel,
  socketId,
  fallbackSocketId,
  ...props
}: Omit<ComponentProps<typeof VolumeControl>, 'level'> & ChannelMeterBinding) {
  const level = useAudioMeterLevel({ meters, channel, socketId, fallbackSocketId });
  return <VolumeControl {...props} level={level} />;
}

export function MeteredVerticalVolume({
  meters,
  channel,
  socketId,
  fallbackSocketId,
  ...props
}: Omit<ComponentProps<typeof VerticalVolume>, 'level'> & ChannelMeterBinding) {
  const level = useAudioMeterLevel({ meters, channel, socketId, fallbackSocketId });
  return <VerticalVolume {...props} level={level} />;
}
