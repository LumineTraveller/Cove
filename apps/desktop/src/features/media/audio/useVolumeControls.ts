import { useCallback } from 'react';

import { setMicrophoneGain, syncMicrophoneMute } from '../microphone/microphoneProcessing';

import { createRemoteAudioOutput, isMemberVoiceAudio } from './audioDevices';

import { ApplicationAudioPipeline } from '../application-audio/applicationAudio';
import {
  Producer,
  Consumer,
  RemoteApplicationAudio,
  MEMBER_VOLUME_KEY,
  SCREEN_RECEIVE_VOLUME_KEY,
  SCREEN_SHARE_VOLUME_KEY,
  APPLICATION_AUDIO_SHARE_VOLUME_KEY,
  APPLICATION_AUDIO_RECEIVE_VOLUME_KEY,
  MICROPHONE_VOLUME_KEY,
  MASTER_OUTPUT_VOLUME_KEY,
} from '../desktopMediaSupport';

export interface useVolumeControlsDependencies {
  readonly memberVolumesRef: import('react').MutableRefObject<Record<string, number>>;
  readonly setMemberVolumes: import('react').Dispatch<
    import('react').SetStateAction<Record<string, number>>
  >;
  readonly rememberedMemberVolumes: import('react').MutableRefObject<Record<string, number>>;
  readonly consumers: import('react').MutableRefObject<
    Map<
      string,
      {
        consumer: Consumer;
        socketId: string;
        kind: string;
        producerId: string;
        sourceType?: string;
      }
    >
  >;
  readonly audioEls: import('react').MutableRefObject<Map<string, HTMLAudioElement>>;
  readonly remoteAudioOutputs: import('react').MutableRefObject<
    Map<
      string,
      {
        source: MediaStreamAudioSourceNode;
        gain: GainNode;
        setVolume(value: number): void;
        resume(): Promise<void>;
        close(): void;
      }
    >
  >;
  readonly memberMuteRestoreVolumes: import('react').MutableRefObject<Record<string, number>>;
  readonly ensureAudioCtx: () => AudioContext;
  readonly masterOutputGain: import('react').MutableRefObject<GainNode | null>;
  readonly screenReceiveVolumeRef: import('react').MutableRefObject<number>;
  readonly setScreenReceiveVolumeState: import('react').Dispatch<
    import('react').SetStateAction<number>
  >;
  readonly screenShareVolumeRef: import('react').MutableRefObject<number>;
  readonly setScreenShareVolumeState: import('react').Dispatch<
    import('react').SetStateAction<number>
  >;
  readonly screenAudioPipeline: import('react').MutableRefObject<ApplicationAudioPipeline | null>;
  readonly applicationAudioShareVolumeRef: import('react').MutableRefObject<number>;
  readonly setApplicationAudioShareVolumeState: import('react').Dispatch<
    import('react').SetStateAction<number>
  >;
  readonly applicationAudioPipeline: import('react').MutableRefObject<ApplicationAudioPipeline | null>;
  readonly applicationAudioReceiveVolumesRef: import('react').MutableRefObject<
    Record<string, number>
  >;
  readonly setApplicationAudioReceiveVolumes: import('react').Dispatch<
    import('react').SetStateAction<Record<string, number>>
  >;
  readonly microphoneVolumeRef: import('react').MutableRefObject<number>;
  readonly setMicrophoneVolumeState: import('react').Dispatch<
    import('react').SetStateAction<number>
  >;
  readonly micProcessingGain: import('react').MutableRefObject<GainNode | null>;
  readonly recoverMicrophoneProcessingRef: import('react').MutableRefObject<() => void>;
  readonly audioProducer: import('react').MutableRefObject<Producer | null>;
  readonly selfMutedRef: import('react').MutableRefObject<boolean>;
  readonly forceMutedRef: import('react').MutableRefObject<boolean>;
  readonly masterOutputVolumeRef: import('react').MutableRefObject<number>;
  readonly setMasterOutputVolumeState: import('react').Dispatch<
    import('react').SetStateAction<number>
  >;
  readonly remoteApplicationAudiosRef: import('react').MutableRefObject<RemoteApplicationAudio[]>;
  readonly setRemoteApplicationAudios: import('react').Dispatch<
    import('react').SetStateAction<RemoteApplicationAudio[]>
  >;
}

export function useVolumeControls(deps: useVolumeControlsDependencies) {
  const setMemberVolume = useCallback((socketId: string, userId: string, volume: number) => {
    // 1.0 = 100% 原始音量，2.0 = 200%（两倍增益）。
    const normalized = Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 1;
    deps.memberVolumesRef.current = {
      ...deps.memberVolumesRef.current,
      [socketId]: normalized,
    };
    deps.setMemberVolumes(deps.memberVolumesRef.current);
    if (userId) {
      deps.rememberedMemberVolumes.current = {
        ...deps.rememberedMemberVolumes.current,
        [userId]: normalized,
      };
      try {
        localStorage.setItem(
          MEMBER_VOLUME_KEY,
          JSON.stringify(deps.rememberedMemberVolumes.current),
        );
      } catch {
        /* 存储不可用不应阻断本次音量调整。 */
      }
    }
    for (const [consumerId, entry] of deps.consumers.current) {
      if (entry.socketId !== socketId || !isMemberVoiceAudio(entry.kind, entry.sourceType))
        continue;
      const element = deps.audioEls.current.get(consumerId);
      const output = deps.remoteAudioOutputs.current.get(consumerId);
      if (output) output.setVolume(normalized);
      else if (element) {
        element.volume = Math.min(1, normalized);
        element.muted = normalized === 0;
      }
    }
  }, []);

  const toggleMemberMute = useCallback(
    (socketId: string, userId: string) => {
      const current = deps.memberVolumesRef.current[socketId] ?? 1;
      if (current === 0) {
        const restored = deps.memberMuteRestoreVolumes.current[userId] ?? 1;
        delete deps.memberMuteRestoreVolumes.current[userId];
        setMemberVolume(socketId, userId, restored);
      } else {
        if (userId) deps.memberMuteRestoreVolumes.current[userId] = current;
        setMemberVolume(socketId, userId, 0);
      }
    },
    [setMemberVolume],
  );

  const promoteRemoteAudio = (
    consumerId: string,
    entry: { consumer: Consumer },
    volume: number,
  ) => {
    const activationElement = deps.audioEls.current.get(consumerId);
    if (!activationElement || deps.remoteAudioOutputs.current.has(consumerId)) return;
    try {
      const context = deps.ensureAudioCtx();
      const output = createRemoteAudioOutput(
        context,
        new MediaStream([entry.consumer.track]),
        volume,
        activationElement,
        deps.masterOutputGain.current ?? context.destination,
      );
      activationElement.muted = true;
      activationElement.volume = 0;
      deps.remoteAudioOutputs.current.set(consumerId, output);
      void output.resume().catch(() => {});
    } catch (error) {
      console.warn('[audio] 无法启用增强音量，继续使用标准音量', error);
    }
  };

  const setScreenReceiveVolume = useCallback((volume: number) => {
    const normalized = Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 1;
    deps.screenReceiveVolumeRef.current = normalized;
    deps.setScreenReceiveVolumeState(normalized);
    try {
      localStorage.setItem(SCREEN_RECEIVE_VOLUME_KEY, String(normalized));
    } catch {
      /* 无法保存偏好也必须应用本次音量。 */
    }
    // 共享音频走 Web Audio 增益：媒体元素的 volume 对 MediaStream 播放无效。
    for (const [consumerId, entry] of deps.consumers.current) {
      if (entry.sourceType !== 'screen-audio') continue;
      deps.remoteAudioOutputs.current.get(consumerId)?.setVolume(normalized);
    }
  }, []);

  const setScreenShareVolume = useCallback((volume: number) => {
    const normalized = Math.max(0, Math.min(2, volume));
    deps.screenShareVolumeRef.current = normalized;
    deps.setScreenShareVolumeState(normalized);
    localStorage.setItem(SCREEN_SHARE_VOLUME_KEY, String(normalized));
    deps.screenAudioPipeline.current?.setVolume(normalized);
  }, []);

  const setApplicationAudioShareVolume = useCallback((volume: number) => {
    const normalized = Math.max(0, Math.min(2, volume));
    deps.applicationAudioShareVolumeRef.current = normalized;
    deps.setApplicationAudioShareVolumeState(normalized);
    localStorage.setItem(APPLICATION_AUDIO_SHARE_VOLUME_KEY, String(normalized));
    deps.applicationAudioPipeline.current?.setVolume(normalized);
  }, []);

  const setApplicationAudioReceiveVolume = useCallback((socketId: string, volume: number) => {
    const normalized = Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 1;
    const nextVolumes = {
      ...deps.applicationAudioReceiveVolumesRef.current,
      [socketId]: normalized,
    };
    deps.applicationAudioReceiveVolumesRef.current = nextVolumes;
    deps.setApplicationAudioReceiveVolumes(nextVolumes);
    try {
      localStorage.setItem(APPLICATION_AUDIO_RECEIVE_VOLUME_KEY, JSON.stringify(nextVolumes));
    } catch {
      /* 无法保存偏好也必须应用本次音量。 */
    }
    for (const [consumerId, entry] of deps.consumers.current) {
      if (entry.socketId !== socketId || entry.sourceType !== 'application-audio') continue;
      const element = deps.audioEls.current.get(consumerId);
      const output = deps.remoteAudioOutputs.current.get(consumerId);
      if (normalized > 1 && element && !output) {
        promoteRemoteAudio(consumerId, entry, normalized);
        continue;
      }
      if (output) {
        output.setVolume(normalized);
      } else if (element) {
        element.volume = normalized;
        element.muted = normalized === 0;
      }
    }
  }, []);

  const setMicrophoneVolume = useCallback((volume: number) => {
    const normalized = Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 1;
    deps.microphoneVolumeRef.current = normalized;
    deps.setMicrophoneVolumeState(normalized);
    try {
      localStorage.setItem(MICROPHONE_VOLUME_KEY, String(normalized));
    } catch {
      /* 保留本次会话设置。 */
    }
    if (deps.micProcessingGain.current) {
      try {
        setMicrophoneGain(deps.micProcessingGain.current, normalized);
      } catch (error) {
        // A closed AudioContext or an older Web Audio implementation can make
        // the existing automation node unusable. Rebuild the send track from
        // the still-live raw capture instead of leaving the slider cosmetic.
        console.warn('[mic] 更新发送音量失败，尝试恢复音量处理链', error);
        deps.micProcessingGain.current = null;
        if (normalized > 0) deps.recoverMicrophoneProcessingRef.current();
      }
    } else if (normalized > 0) {
      // createProcessedMicrophone deliberately keeps voice usable by falling
      // back to the raw track. Promote that track back to a gain-controlled
      // one on the next user gesture, so volume still affects remote peers.
      deps.recoverMicrophoneProcessingRef.current();
    }
    if (deps.audioProducer.current)
      syncMicrophoneMute(
        deps.audioProducer.current,
        deps.selfMutedRef.current,
        deps.forceMutedRef.current,
        normalized,
      );
  }, []);

  const setMasterOutputVolume = useCallback((volume: number) => {
    const normalized = Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 1;
    deps.masterOutputVolumeRef.current = normalized;
    deps.setMasterOutputVolumeState(normalized);
    try {
      localStorage.setItem(MASTER_OUTPUT_VOLUME_KEY, String(normalized));
    } catch {
      /* 保留本次会话设置。 */
    }
    if (deps.masterOutputGain.current) deps.masterOutputGain.current.gain.value = normalized;
    deps.audioEls.current.forEach((element) => {
      element.volume = Math.min(1, normalized);
      element.muted = normalized === 0;
    });
  }, []);

  const publishRemoteApplicationAudios = useCallback((next: RemoteApplicationAudio[]) => {
    deps.remoteApplicationAudiosRef.current = next;
    deps.setRemoteApplicationAudios(next);
  }, []);

  const storeRemoteApplicationAudio = useCallback(
    (value: RemoteApplicationAudio) => {
      const next = [
        ...deps.remoteApplicationAudiosRef.current.filter(
          (item) => item.socketId !== value.socketId,
        ),
        value,
      ];
      publishRemoteApplicationAudios(next);
    },
    [publishRemoteApplicationAudios],
  );

  const removeRemoteApplicationAudio = useCallback(
    (socketId: string, producerId?: string) => {
      const next = deps.remoteApplicationAudiosRef.current.filter(
        (item) =>
          item.socketId !== socketId ||
          (producerId !== undefined && item.producerId !== producerId),
      );
      if (next.length !== deps.remoteApplicationAudiosRef.current.length)
        publishRemoteApplicationAudios(next);
    },
    [publishRemoteApplicationAudios],
  );

  const clearRemoteApplicationAudios = useCallback(() => {
    if (deps.remoteApplicationAudiosRef.current.length) publishRemoteApplicationAudios([]);
  }, [publishRemoteApplicationAudios]);
  return {
    setMemberVolume,
    toggleMemberMute,
    promoteRemoteAudio,
    setScreenReceiveVolume,
    setScreenShareVolume,
    setApplicationAudioShareVolume,
    setApplicationAudioReceiveVolume,
    setMicrophoneVolume,
    setMasterOutputVolume,
    publishRemoteApplicationAudios,
    storeRemoteApplicationAudio,
    removeRemoteApplicationAudio,
    clearRemoteApplicationAudios,
  };
}
