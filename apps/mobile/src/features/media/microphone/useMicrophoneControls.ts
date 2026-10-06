import { useCallback } from 'react';

import { MediaStream, mediaDevices } from 'react-native-webrtc';

import {
  applyNoiseMode,
  createMicrophoneConstraints,
  isMicrophoneNoiseMode,
  type MicrophoneNoiseMode,
} from './microphoneNoise';

import { Producer } from '../mobileMediaSupport';

export interface UseMicrophoneControlsDependencies {
  readonly audioProducer: import('react').RefObject<Producer | null>;
  readonly mediaGeneration: import('react').RefObject<number>;
  readonly noiseModeRef: import('react').RefObject<MicrophoneNoiseMode>;
  readonly microphoneStream: import('react').RefObject<MediaStream | null>;
  readonly selfMutedRef: import('react').RefObject<boolean>;
  readonly forceMutedRef: import('react').RefObject<boolean>;
  readonly setNoiseMode: import('react').Dispatch<
    import('react').SetStateAction<MicrophoneNoiseMode>
  >;
  readonly setNoiseError: import('react').Dispatch<
    import('react').SetStateAction<string | null>
  >;
  readonly noiseBusyRef: import('react').RefObject<boolean>;
  readonly joiningRef: import('react').RefObject<boolean>;
  readonly setNoiseSwitching: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
}

export function useMicrophoneControls(deps: UseMicrophoneControlsDependencies) {
  const {
    audioProducer,
    mediaGeneration,
    noiseModeRef,
    microphoneStream,
    selfMutedRef,
    forceMutedRef,
    setNoiseMode,
    setNoiseError,
    noiseBusyRef,
    joiningRef,
    setNoiseSwitching,
  } = deps;

  const replaceMicrophone = useCallback(
    async (mode: MicrophoneNoiseMode) => {
      const producer = audioProducer.current;
      if (!producer || producer.closed) return;
      const generation = mediaGeneration.current;
      const ensureCurrent = () => {
        if (
          generation !== mediaGeneration.current ||
          audioProducer.current !== producer ||
          producer.closed
        ) {
          throw new Error('麦克风切换已取消');
        }
      };

      const previousMode = noiseModeRef.current;
      const previous = microphoneStream.current;
      const previousTrack = previous?.getAudioTracks()[0];
      const stream = await mediaDevices.getUserMedia({
        audio: createMicrophoneConstraints(mode),
        video: false,
      } as never);
      let replaced = false;
      try {
        ensureCurrent();
        const track = stream.getAudioTracks()[0];
        if (!track) throw new Error('没有可用的麦克风音轨');
        track.enabled =
          !producer.paused && !selfMutedRef.current && !forceMutedRef.current;
        await producer.replaceTrack({ track: track as never });
        replaced = true;
        ensureCurrent();
        // Commit native processing only after the new source's WebRTC NS options
        // are installed. Keep the old track alive until this transaction succeeds.
        const status = await applyNoiseMode(mode);
        ensureCurrent();
        if (status.effectiveMode !== mode || status.error)
          throw new Error(status.error ?? '原生降噪模式未生效');
        microphoneStream.current = stream;
        previous?.release(true);
        noiseModeRef.current = status.effectiveMode;
        setNoiseMode(status.effectiveMode);
        setNoiseError(null);
      } catch (error) {
        try {
          if (
            generation === mediaGeneration.current &&
            audioProducer.current === producer &&
            !producer.closed
          ) {
            if (replaced && previousTrack) {
              try {
                await producer.replaceTrack({ track: previousTrack as never });
              } catch (rollbackError) {
                // Never release a track still attached to a live sender. Report
                // the failed rollback, keep voice alive, and own the new stream.
                microphoneStream.current = stream;
                previous?.release(true);
                throw new Error(
                  `原麦克风恢复失败，已保留当前音轨：${
                    rollbackError instanceof Error
                      ? rollbackError.message
                      : String(rollbackError)
                  }`,
                );
              }
            }
            await applyNoiseMode(previousMode);
          }
        } finally {
          if (microphoneStream.current !== stream) stream.release(true);
        }
        throw error;
      }
    },
    [
      audioProducer,
      forceMutedRef,
      mediaGeneration,
      microphoneStream,
      noiseModeRef,
      selfMutedRef,
      setNoiseError,
      setNoiseMode,
    ],
  );

  const selectNoiseMode = useCallback(
    async (mode: MicrophoneNoiseMode) => {
      if (
        !isMicrophoneNoiseMode(mode) ||
        noiseBusyRef.current ||
        joiningRef.current
      )
        return;
      if (mode === noiseModeRef.current) return;
      setNoiseError(null);
      if (!audioProducer.current) {
        noiseBusyRef.current = true;
        setNoiseSwitching(true);
        try {
          const status = await applyNoiseMode(mode);
          if (status.error) throw new Error(status.error);
          noiseModeRef.current = status.effectiveMode;
          setNoiseMode(status.effectiveMode);
        } catch (error) {
          setNoiseError(
            `降噪切换失败：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          noiseBusyRef.current = false;
          setNoiseSwitching(false);
        }
        return;
      }
      noiseBusyRef.current = true;
      setNoiseSwitching(true);
      try {
        await replaceMicrophone(mode);
      } catch (error) {
        setNoiseError(
          `降噪切换失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        noiseBusyRef.current = false;
        setNoiseSwitching(false);
      }
    },
    [
      audioProducer,
      joiningRef,
      noiseBusyRef,
      noiseModeRef,
      replaceMicrophone,
      setNoiseError,
      setNoiseMode,
      setNoiseSwitching,
    ],
  );
  return { replaceMicrophone, selectNoiseMode };
}
