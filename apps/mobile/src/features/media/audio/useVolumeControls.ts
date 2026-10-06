import { useCallback } from 'react';

import { MediaStream, MediaStreamTrack } from 'react-native-webrtc';

import { Consumer, ApplicationAudioShare } from '../mobileMediaSupport';

export interface UseVolumeControlsDependencies {
  readonly screenReceiveVolumeRef: import('react').RefObject<number>;
  readonly setScreenReceiveVolumeState: import('react').Dispatch<
    import('react').SetStateAction<number>
  >;
  readonly consumers: import('react').RefObject<
    Map<
      string,
      {
        consumer: Consumer;
        producerId: string;
        socketId: string;
        kind: string;
        stream: MediaStream;
        sourceType?: string;
      }
    >
  >;
  readonly consumerByProducer: import('react').RefObject<Map<string, string>>;
  readonly applicationAudioVolumes: import('react').RefObject<
    Map<string, number>
  >;
  readonly setApplicationAudioShares: import('react').Dispatch<
    import('react').SetStateAction<ApplicationAudioShare[]>
  >;
  readonly memberVolumesRef: import('react').RefObject<Map<string, number>>;
  readonly setMemberVolumes: import('react').Dispatch<
    import('react').SetStateAction<Record<string, number>>
  >;
}

export function useVolumeControls(deps: UseVolumeControlsDependencies) {
  const {
    screenReceiveVolumeRef,
    setScreenReceiveVolumeState,
    consumers,
    consumerByProducer,
    applicationAudioVolumes,
    setApplicationAudioShares,
    memberVolumesRef,
    setMemberVolumes,
  } = deps;

  const setScreenReceiveVolume = useCallback(
    (volume: number) => {
      const normalized = Math.max(0, Math.min(1, volume));
      screenReceiveVolumeRef.current = normalized;
      setScreenReceiveVolumeState(normalized);
      for (const entry of consumers.current.values()) {
        if (entry.sourceType !== 'screen-audio') continue;
        const track = entry.consumer.track as unknown as {
          _setVolume?: (value: number) => void;
        };
        track._setVolume?.(normalized);
      }
    },
    [consumers, screenReceiveVolumeRef, setScreenReceiveVolumeState],
  );

  const setApplicationAudioVolume = useCallback(
    (producerId: string, value: number) => {
      if (!Number.isFinite(value)) return;
      const consumerId = consumerByProducer.current.get(producerId);
      const entry = consumerId ? consumers.current.get(consumerId) : undefined;
      if (entry?.sourceType !== 'application-audio') return;
      const volume = Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
      (entry.consumer.track as unknown as MediaStreamTrack)._setVolume(volume);
      applicationAudioVolumes.current.set(producerId, volume);
      setApplicationAudioShares(current =>
        current.map(share =>
          share.producerId === producerId ? { ...share, volume } : share,
        ),
      );
    },
    [
      applicationAudioVolumes,
      consumerByProducer,
      consumers,
      setApplicationAudioShares,
    ],
  );

  const setMemberVolume = useCallback(
    (socketId: string, value: number) => {
      if (!socketId || !Number.isFinite(value)) return;
      const volume = Math.round(Math.max(0, Math.min(2, value)) * 100) / 100;
      memberVolumesRef.current.set(socketId, volume);
      setMemberVolumes(current => ({ ...current, [socketId]: volume }));
      for (const entry of consumers.current.values()) {
        const isMicrophone =
          entry.kind === 'audio' &&
          (entry.sourceType === 'mic' || entry.sourceType == null);
        if (entry.socketId !== socketId || !isMicrophone) continue;
        (entry.consumer.track as unknown as MediaStreamTrack)._setVolume(
          volume,
        );
      }
    },
    [consumers, memberVolumesRef, setMemberVolumes],
  );
  return { setScreenReceiveVolume, setApplicationAudioVolume, setMemberVolume };
}
