import { useCallback } from 'react';
import { Socket } from 'socket.io-client';

import {
  createProcessedMicrophone,
  setMicrophoneGain,
  syncMicrophoneMute,
  type ProcessedMicrophone,
} from './microphoneProcessing';
import { acquireMicrophoneCandidate, type MicrophoneNoiseMode } from './microphoneCandidate';
import { requestEchoCancelledMicrophone } from './microphoneEcho';

import {
  AUDIO_INPUT_DEVICE_KEY,
  normalizeMicrophoneDeviceId,
  saveAudioDeviceId,
} from '../audio/audioDevices';

import { Producer } from '../desktopMediaSupport';

export interface useMicrophoneControlsDependencies {
  readonly microphoneVolumeRef: import('react').MutableRefObject<number>;
  readonly micProcessingContext: import('react').MutableRefObject<AudioContext | null>;
  readonly rnnoiseFailureRef: import('react').MutableRefObject<() => void>;
  readonly microphoneNoiseModeRef: import('react').MutableRefObject<MicrophoneNoiseMode>;
  readonly audioProducer: import('react').MutableRefObject<Producer | null>;
  readonly mediaGeneration: import('react').MutableRefObject<number>;
  readonly selfMutedRef: import('react').MutableRefObject<boolean>;
  readonly forceMutedRef: import('react').MutableRefObject<boolean>;
  readonly rawAudioRef: import('react').MutableRefObject<MediaStream | null>;
  readonly localAudioRef: import('react').MutableRefObject<MediaStream | null>;
  readonly micProcessingGain: import('react').MutableRefObject<GainNode | null>;
  readonly setMicrophoneNoiseMode: import('react').Dispatch<
    import('react').SetStateAction<MicrophoneNoiseMode>
  >;
  readonly setMicrophoneNoiseError: import('react').Dispatch<
    import('react').SetStateAction<string | null>
  >;
  readonly detachAnalyser: (key: string) => void;
  readonly attachAnalyser: (
    key: string,
    stream: MediaStream,
    socketId: string,
    type?: 'voice' | 'application',
    playbackGain?: () => number,
  ) => void;
  readonly socket: Socket<
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap,
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap
  >;
  readonly refreshAudioDevices: (requestPermission?: boolean) => Promise<void>;
  readonly micProcessingRecoveryBusy: import('react').MutableRefObject<boolean>;
  readonly recoverMicrophoneProcessingRef: import('react').MutableRefObject<() => void>;
  readonly microphoneNoiseBusyRef: import('react').MutableRefObject<boolean>;
  readonly selectedAudioInputRef: import('react').MutableRefObject<string>;
  readonly setSelectedAudioInputId: import('react').Dispatch<
    import('react').SetStateAction<string>
  >;
  readonly setAudioDeviceError: import('react').Dispatch<
    import('react').SetStateAction<string | null>
  >;
  readonly inVoice: boolean;
  readonly setAudioInputSwitching: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly joiningRef: import('react').MutableRefObject<boolean>;
  readonly audioInputSwitching: boolean;
  readonly setMicrophoneNoiseSwitching: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
}

export function useMicrophoneControls(deps: useMicrophoneControlsDependencies) {
  const createProcessedMicStream = useCallback(
    async (
      rawStream: MediaStream,
      mode: MicrophoneNoiseMode = 'rnnoise',
    ): Promise<ProcessedMicrophone> => {
      if (mode === 'rnnoise') {
        const { createRnnoiseMicrophone } = await import('./rnnoiseMicrophone');
        const processed = await createRnnoiseMicrophone(
          rawStream,
          deps.microphoneVolumeRef.current,
        );
        processed.processor.onprocessorerror = () => {
          if (deps.micProcessingContext.current === processed.context)
            deps.rnnoiseFailureRef.current();
        };
        if (processed.gain) setMicrophoneGain(processed.gain, deps.microphoneVolumeRef.current);
        return processed;
      }
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const processed = await createProcessedMicrophone(
        rawStream,
        deps.microphoneVolumeRef.current,
        () => new Ctx({ sampleRate: 48_000, latencyHint: 'interactive' }),
      );
      // The volume slider may have changed while resume() was pending.
      if (processed.gain) setMicrophoneGain(processed.gain, deps.microphoneVolumeRef.current);
      return processed;
    },
    [],
  );

  const requestMicrophone = useCallback(
    (deviceId: string, mode: MicrophoneNoiseMode = 'rnnoise') =>
      requestEchoCancelledMicrophone(deviceId, mode),
    [],
  );

  const prepareMicrophone = useCallback(
    (deviceId: string, mode: MicrophoneNoiseMode) =>
      acquireMicrophoneCandidate(
        mode,
        (captureMode) => requestMicrophone(deviceId, captureMode),
        createProcessedMicStream,
      ),
    [requestMicrophone, createProcessedMicStream],
  );

  const replaceMicrophone = useCallback(
    async (deviceId: string, mode = deps.microphoneNoiseModeRef.current) => {
      const producer = deps.audioProducer.current;
      if (!producer) return;

      const generation = deps.mediaGeneration.current;
      const ensureCurrent = () => {
        if (
          generation !== deps.mediaGeneration.current ||
          deps.audioProducer.current !== producer ||
          producer.closed
        )
          throw new Error('麦克风切换已取消');
      };
      let nextRaw: MediaStream | null = null;
      let nextProcessed: ProcessedMicrophone | null = null;
      try {
        const candidate = await prepareMicrophone(deviceId, mode);
        nextRaw = candidate.raw;
        nextProcessed = candidate.processed;
        ensureCurrent();
        // A failed experiment has already reacquired system-processed input;
        // never publish an unprocessed raw RNNoise capture as the fallback.
        const rawTrack = nextRaw.getAudioTracks()[0];
        const processedTrack = nextProcessed.stream.getAudioTracks()[0];
        // The candidate already selected a safe fallback. If its output ends
        // now, do not replace it with an RNNoise capture whose native NS is off.
        const nextTrack = processedTrack;
        if (!nextTrack || nextTrack.readyState !== 'live')
          throw new Error('选择的设备没有提供可用的音频轨道');
        // replaceTrack() is async: preserve silence throughout negotiation,
        // not just after mediasoup has adopted the new track.
        nextTrack.enabled =
          !producer.paused &&
          !deps.selfMutedRef.current &&
          !deps.forceMutedRef.current &&
          deps.microphoneVolumeRef.current > 0;
        nextTrack.contentHint = 'speech';
        console.info('[mic] 切换上行轨道', {
          processed: nextTrack !== rawTrack,
          label: nextTrack.label,
          readyState: nextTrack.readyState,
        });
        await producer.replaceTrack({ track: nextTrack });
        ensureCurrent();
        syncMicrophoneMute(
          producer,
          deps.selfMutedRef.current,
          deps.forceMutedRef.current,
          deps.microphoneVolumeRef.current,
        );

        const previousRaw = deps.rawAudioRef.current;
        const previousProcessed = deps.localAudioRef.current;
        const previousContext = deps.micProcessingContext.current;
        deps.rawAudioRef.current = nextRaw;
        deps.localAudioRef.current = nextProcessed.stream;
        deps.micProcessingContext.current = nextProcessed.context;
        deps.micProcessingGain.current = nextProcessed.gain;
        deps.microphoneNoiseModeRef.current = candidate.mode;
        deps.setMicrophoneNoiseMode(candidate.mode);
        deps.setMicrophoneNoiseError(candidate.warning);

        previousProcessed?.getTracks().forEach((track) => track.stop());
        if (previousRaw && previousRaw !== previousProcessed)
          previousRaw.getTracks().forEach((track) => track.stop());
        previousContext?.close().catch(() => {});
        // Replacement is committed. A meter/UI error must not tear down the
        // new live track or claim that the previous mode is still sending.
        try {
          deps.detachAnalyser('local');
          deps.attachAnalyser('local', nextProcessed.stream, deps.socket.id ?? 'local');
        } catch (error) {
          console.warn('[mic] 音轨已切换，但电平显示未能刷新', error);
        }
        deps.refreshAudioDevices(false);
      } catch (error) {
        nextProcessed?.stream.getTracks().forEach((track) => track.stop());
        if (nextRaw && nextRaw !== nextProcessed?.stream)
          nextRaw.getTracks().forEach((track) => track.stop());
        nextProcessed?.context?.close().catch(() => {});
        throw error;
      }
    },
    [prepareMicrophone, deps.refreshAudioDevices, deps.socket.id],
  );

  const recoverMicrophoneProcessing = useCallback(async () => {
    const producer = deps.audioProducer.current;
    const rawStream = deps.rawAudioRef.current;
    if (
      deps.micProcessingRecoveryBusy.current ||
      !producer ||
      producer.closed ||
      !rawStream ||
      deps.micProcessingGain.current
    )
      return;

    const generation = deps.mediaGeneration.current;
    const ensureCurrent = () => {
      if (
        generation !== deps.mediaGeneration.current ||
        deps.audioProducer.current !== producer ||
        producer.closed ||
        deps.rawAudioRef.current !== rawStream
      )
        throw new Error('麦克风音量处理恢复已取消');
    };
    let processed: ProcessedMicrophone | null = null;
    let committed = false;
    deps.micProcessingRecoveryBusy.current = true;
    try {
      processed = await createProcessedMicStream(rawStream, deps.microphoneNoiseModeRef.current);
      ensureCurrent();
      const nextTrack = processed.stream.getAudioTracks()[0];
      if (
        !processed.gain ||
        processed.stream === rawStream ||
        !nextTrack ||
        nextTrack.readyState !== 'live'
      )
        throw new Error('发送音量处理链仍不可用');

      nextTrack.enabled =
        !producer.paused &&
        !deps.selfMutedRef.current &&
        !deps.forceMutedRef.current &&
        deps.microphoneVolumeRef.current > 0;
      nextTrack.contentHint = 'speech';
      await producer.replaceTrack({ track: nextTrack });
      ensureCurrent();
      syncMicrophoneMute(
        producer,
        deps.selfMutedRef.current,
        deps.forceMutedRef.current,
        deps.microphoneVolumeRef.current,
      );

      const previousStream = deps.localAudioRef.current;
      const previousContext = deps.micProcessingContext.current;
      deps.localAudioRef.current = processed.stream;
      deps.micProcessingContext.current = processed.context;
      deps.micProcessingGain.current = processed.gain;
      committed = true;

      if (previousStream && previousStream !== rawStream)
        previousStream.getTracks().forEach((track) => track.stop());
      if (previousContext && previousContext !== processed.context)
        previousContext.close().catch(() => {});
      try {
        deps.detachAnalyser('local');
        deps.attachAnalyser('local', processed.stream, deps.socket.id ?? 'local');
      } catch (error) {
        console.warn('[mic] 音量处理已恢复，但电平显示未能刷新', error);
      }
      console.info('[mic] 已将上行音轨恢复为可调音量处理链');
    } catch (error) {
      console.warn('[mic] 无法恢复发送音量处理链，继续使用当前音轨', error);
    } finally {
      if (!committed) {
        if (processed && processed.stream !== rawStream)
          processed.stream.getTracks().forEach((track) => track.stop());
        if (processed?.context) processed.context.close().catch(() => {});
      }
      deps.micProcessingRecoveryBusy.current = false;
    }
  }, [deps.attachAnalyser, createProcessedMicStream, deps.detachAnalyser, deps.socket.id]);

  deps.recoverMicrophoneProcessingRef.current = () => {
    void recoverMicrophoneProcessing();
  };

  const selectAudioInput = useCallback(
    async (deviceId: string) => {
      if (deps.microphoneNoiseBusyRef.current) return;
      const nextDeviceId = normalizeMicrophoneDeviceId(deviceId);
      const previousDeviceId = deps.selectedAudioInputRef.current;
      if (nextDeviceId === previousDeviceId) return;

      deps.selectedAudioInputRef.current = nextDeviceId;
      deps.setSelectedAudioInputId(nextDeviceId);
      saveAudioDeviceId(AUDIO_INPUT_DEVICE_KEY, nextDeviceId);
      deps.setAudioDeviceError(null);
      if (!deps.inVoice || !deps.audioProducer.current) return;

      deps.setAudioInputSwitching(true);
      try {
        await replaceMicrophone(nextDeviceId);
      } catch (error) {
        deps.selectedAudioInputRef.current = previousDeviceId;
        deps.setSelectedAudioInputId(previousDeviceId);
        saveAudioDeviceId(AUDIO_INPUT_DEVICE_KEY, previousDeviceId);
        deps.setAudioDeviceError(
          `切换麦克风失败：${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        deps.setAudioInputSwitching(false);
      }
    },
    [deps.inVoice, replaceMicrophone],
  );

  const selectMicrophoneNoiseMode = useCallback(
    async (mode: MicrophoneNoiseMode) => {
      if (
        !['system', 'rnnoise'].includes(mode) ||
        deps.microphoneNoiseBusyRef.current ||
        deps.joiningRef.current
      )
        return;
      if (mode === deps.microphoneNoiseModeRef.current) return;
      if (deps.audioInputSwitching) {
        deps.setMicrophoneNoiseError('请等待麦克风切换完成后再切换降噪模式。');
        return;
      }
      deps.setMicrophoneNoiseError(null);
      if (!deps.audioProducer.current) {
        deps.microphoneNoiseModeRef.current = mode;
        deps.setMicrophoneNoiseMode(mode);
        return;
      }
      deps.microphoneNoiseBusyRef.current = true;
      deps.setMicrophoneNoiseSwitching(true);
      try {
        await replaceMicrophone(deps.selectedAudioInputRef.current, mode);
      } catch (error) {
        // The previous stream is still owned by its producer; retain the
        // actual mode and permit another attempt instead of changing the label.
        deps.setMicrophoneNoiseError(
          `降噪切换失败，已保留原模式：${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        deps.microphoneNoiseBusyRef.current = false;
        deps.setMicrophoneNoiseSwitching(false);
      }
    },
    [deps.audioInputSwitching, replaceMicrophone],
  );
  return {
    createProcessedMicStream,
    requestMicrophone,
    prepareMicrophone,
    replaceMicrophone,
    recoverMicrophoneProcessing,
    selectAudioInput,
    selectMicrophoneNoiseMode,
  };
}
