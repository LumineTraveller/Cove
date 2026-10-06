import { useCallback } from 'react';
import { Socket } from 'socket.io-client';

import { ApplicationAudioPipeline, type ApplicationAudioSource } from './applicationAudio';
import {
  Transport,
  Producer,
  waitForMediaTrackWarmup,
  produceWithSsrcRetry,
} from '../desktopMediaSupport';

export interface useApplicationAudioPublishingDependencies {
  readonly detachAnalyser: (key: string) => void;
  readonly applicationAudioProducer: import('react').MutableRefObject<Producer | null>;
  readonly socket: Socket<
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap,
    import('@socket.io/component-emitter/lib/cjs').DefaultEventsMap
  >;
  readonly applicationAudioUnsubscribe: import('react').MutableRefObject<(() => void) | null>;
  readonly applicationAudioPipeline: import('react').MutableRefObject<ApplicationAudioPipeline | null>;
  readonly applicationAudioStop: import('react').MutableRefObject<(() => Promise<boolean>) | null>;
  readonly setIsApplicationAudioSharing: import('react').Dispatch<
    import('react').SetStateAction<boolean>
  >;
  readonly setApplicationAudioLabel: import('react').Dispatch<
    import('react').SetStateAction<string | null>
  >;
  readonly inVoice: boolean;
  readonly applicationAudioShareVolumeRef: import('react').MutableRefObject<number>;
  readonly sendTransport: import('react').MutableRefObject<Transport | null>;
  readonly forceMutedRef: import('react').MutableRefObject<boolean>;
  readonly attachAnalyser: (
    key: string,
    stream: MediaStream,
    socketId: string,
    type?: 'voice' | 'application',
    playbackGain?: () => number,
  ) => void;
  readonly startMeters: () => void;
}

export function useApplicationAudioPublishing(deps: useApplicationAudioPublishingDependencies) {
  const stopApplicationAudioShare = useCallback(() => {
    deps.detachAnalyser('local-application');
    const producer = deps.applicationAudioProducer.current;
    if (producer) {
      deps.socket.emit('ms:close-producer', { producerId: producer.id });
      producer.close();
      deps.applicationAudioProducer.current = null;
    }
    deps.applicationAudioUnsubscribe.current?.();
    deps.applicationAudioUnsubscribe.current = null;
    deps.applicationAudioPipeline.current?.close();
    deps.applicationAudioPipeline.current = null;
    void deps.applicationAudioStop.current?.();
    deps.applicationAudioStop.current = null;
    void window.coveApplicationAudio?.stop();
    void window.coveSystemAudio?.stop();
    deps.setIsApplicationAudioSharing(false);
    deps.setApplicationAudioLabel(null);
  }, [deps.socket]);

  const startApplicationAudioShare = useCallback(
    async (source: ApplicationAudioSource) => {
      if (!deps.inVoice || deps.applicationAudioProducer.current) return;
      const bridge = window.coveApplicationAudio;
      if (!bridge) {
        window.alert('应用音频共享仅可在 Windows 桌面版中使用。');
        return;
      }
      let pipeline: ApplicationAudioPipeline | null = null;
      let unsubscribe: (() => void) | null = null;
      try {
        pipeline = new ApplicationAudioPipeline(deps.applicationAudioShareVolumeRef.current);
        await pipeline.resume();
        pipeline.prime();
        unsubscribe = bridge.onChunk((chunk) => pipeline?.pushPcm(chunk));
        const capture = await bridge.start(source.id);
        if (!capture.ok) throw new Error(capture.error ?? '无法开始应用音频捕获。');
        const track = pipeline.track;
        await waitForMediaTrackWarmup(track);
        const producer = await produceWithSsrcRetry(() =>
          deps.sendTransport.current!.produce({
            track,
            streamId: `application-audio-${deps.socket.id}`,
            codecOptions: { opusStereo: true, opusDtx: true, opusFec: true },
            appData: {
              type: 'application-audio',
              label: source.name,
              processId: source.processId,
            },
            stopTracks: false,
            disableTrackOnPause: true,
            zeroRtpOnPause: true,
          }),
        );
        deps.applicationAudioPipeline.current = pipeline;
        deps.applicationAudioUnsubscribe.current = unsubscribe;
        deps.applicationAudioStop.current = bridge.stop;
        deps.applicationAudioProducer.current = producer;
        if (deps.forceMutedRef.current) producer.pause();
        deps.attachAnalyser(
          'local-application',
          pipeline.destination.stream,
          deps.socket.id ?? 'local',
          'application',
          () =>
            deps.applicationAudioProducer.current?.paused === false &&
            deps.applicationAudioPipeline.current?.context.state === 'running'
              ? 1
              : 0,
        );
        deps.startMeters();
        deps.setApplicationAudioLabel(source.name);
        deps.setIsApplicationAudioSharing(true);
      } catch (error) {
        unsubscribe?.();
        pipeline?.close();
        await bridge.stop().catch(() => false);
        console.error('[application-audio] 分享失败', error);
        window.alert(`无法共享应用音频：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [deps.inVoice],
  );

  const startSystemAudioShare = useCallback(async () => {
    if (!deps.inVoice || deps.applicationAudioProducer.current) return;
    const bridge = window.coveSystemAudio;
    if (!bridge) {
      window.alert('全部系统音频共享仅可在 Windows 桌面版中使用。');
      return;
    }
    let pipeline: ApplicationAudioPipeline | null = null;
    let unsubscribe: (() => void) | null = null;
    try {
      pipeline = new ApplicationAudioPipeline(deps.applicationAudioShareVolumeRef.current);
      await pipeline.resume();
      pipeline.prime();
      unsubscribe = bridge.onChunk((chunk) => pipeline?.pushPcm(chunk));
      const capture = await bridge.start();
      if (!capture.ok) throw new Error(capture.error ?? '无法开始系统音频捕获。');
      const track = pipeline.track;
      await waitForMediaTrackWarmup(track);
      const producer = await produceWithSsrcRetry(() =>
        deps.sendTransport.current!.produce({
          track,
          streamId: `application-audio-${deps.socket.id}`,
          codecOptions: { opusStereo: true, opusDtx: true, opusFec: true },
          appData: {
            type: 'application-audio',
            label: '全部系统音频',
            processId: 0,
          },
          stopTracks: false,
          disableTrackOnPause: true,
          zeroRtpOnPause: true,
        }),
      );
      deps.applicationAudioPipeline.current = pipeline;
      deps.applicationAudioUnsubscribe.current = unsubscribe;
      deps.applicationAudioStop.current = bridge.stop;
      deps.applicationAudioProducer.current = producer;
      if (deps.forceMutedRef.current) producer.pause();
      deps.attachAnalyser(
        'local-application',
        pipeline.destination.stream,
        deps.socket.id ?? 'local',
        'application',
        () =>
          deps.applicationAudioProducer.current?.paused === false &&
          deps.applicationAudioPipeline.current?.context.state === 'running'
            ? 1
            : 0,
      );
      deps.startMeters();
      deps.setApplicationAudioLabel('全部系统音频');
      deps.setIsApplicationAudioSharing(true);
    } catch (error) {
      unsubscribe?.();
      pipeline?.close();
      await bridge.stop().catch(() => false);
      console.error('[system-audio] 分享失败', error);
      window.alert(`无法共享系统音频：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [deps.inVoice]);
  return { stopApplicationAudioShare, startApplicationAudioShare, startSystemAudioShare };
}
